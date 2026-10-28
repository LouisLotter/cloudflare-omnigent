"""The supervisor: the computer's side of the computer API, and its one authority.

``Supervisor.handle`` is the receiver for WorkspaceDO's commands (``WorkspaceCommand``), served
on port 8090 by ``server.py``; the background loops send the supervisor's messages
(``SupervisorMessage``): ``hello`` once per generation, a ``report`` periodically and on every
change, ``credential_checkpoint`` from the credential watcher, ``save_request`` on SIGTERM.

Command rules (contracts/src/computer-protocol.ts, ``COMPUTER_API_MESSAGES``):
- every command is parsed with the contract (schema and refinements) before anything else;
  an unsupported protocol version, another computer or another generation is refused before
  any effect;
- a mutating command is idempotent by its operation ID: a repeat returns the recorded answer
  (for a job, its current state), and the same ID with another body is a ``conflict``. Only
  answers are recorded, never failures, so a failed command can be repeated;
- ``start_host`` is idempotent by attempt (``host.py``); ``status`` and ``job_status`` read.
- the sign-in commands (WP3.23, ``signin.py``) are fenced by attempt: ``sign_in_start`` and
  ``sign_in_cancel`` are idempotent by attempt and never journaled; ``sign_in_input`` is journaled
  by operation ID without its code; ``sign_in_status`` and ``computer_status`` read.
- the setup terminal's sessions (WP3.28, ``terminals.py``): ``terminal_end`` ends a window's
  sessions; a sign-out, a stop's final capture (``endTerminals``), the credential barrier and a
  page sign-in's spawn end every session first; a reaper ends the idle and the old ones.
Ordering the design requires and the receiver enforces: the workspace restore, then the
credential install, then the host. No capture before the restore is confirmed.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import traceback
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import (
    SUPERVISOR_FEATURES,
    SUPERVISOR_PROTOCOL_VERSION,
    SUPERVISOR_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    rc53_collect,
)
from . import logins as L
from . import runners as R
from . import status as S
from .api import ComputerApi, Refused, Unanswered
from .capture import journal_deadline, resume_journal
from .contract import Contract, ContractError, error_body
from .credentials import (
    CredentialAlert,
    Credentials,
    UnstableRead,
    install_bundle,
    verify_signed_out,
)
from .host import HostManager, StartParams, host_argv, host_config_command, host_env
from .ids import new_operation_id
from .paths import OMNIGENT_INTERNAL_URL, Account, Layout
from .policy import Policy
from .procutil import module_argv, run_workload, spawn_workload, workload_argv, workload_env
from .restore import RestoreFailed, restore_workspace
from .signin import SignInConflict, SignIns, SignInUnsettled, SpawnCancelled, spawn_login
from .terminals import REAP_INTERVAL_S, NotAnswering, TerminalSessions
from .tree import tree_digest

REPORT_INTERVAL_S = 30.0
#: How long a repeat of a command still being handled waits for the first delivery's answer.
REPEAT_WAIT_S = 120.0
#: How long a capture waits for a workload command (a CLI check, a sign-out) to finish.
GATE_WAIT_S = 150.0
#: The supervisor's own recovery runs this long after a pause's deadline (the guard's is first).
PAUSE_RECOVERY_MARGIN_S = 1.0


class _CaptureRefused(Exception):
    """A capture refused before its worker started (its result is already set)."""


LOGIN_INTERVAL_S = 300.0
#: The CLIs' versions are read again after this.
VERSIONS_INTERVAL_S = 3600.0
#: Captures whose RC-53 counts the status keeps.
KEEP_CAPTURE_COUNTS = 5
#: Commands that are never journaled by operation ID: reads, and the sign-in commands fenced by
#: attempt (signin.py).
UNJOURNALED = frozenset(
    {"status", "job_status", "sign_in_status", "computer_status", "sign_in_start", "sign_in_cancel"}
)
#: The capture worker is given this long after its lease before it is killed as wedged.
CAPTURE_WORKER_GRACE_S = 900.0

HTTP_STATUS = {
    "bad_request": 400,
    "unsupported_version": 400,
    "forbidden": 403,
    "not_found": 404,
    "conflict": 409,
    "stale_generation": 409,
    "unavailable": 503,
    "internal": 500,
}


class CommandError(Exception):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass
class Tools:
    """Programs the supervisor runs; production uses the image's, tests pass fakes."""

    omnigent: str = "/opt/venv/bin/omnigent"
    venv_python: str = "/opt/venv/bin/python"
    claude: str = "claude"
    codex: str = "codex"
    #: gh itself, for its version (the venv's gh is the credential broker's wrapper).
    gh: str = "/usr/local/bin/gh"
    terminal: list[str] | None = None
    server_url: str = OMNIGENT_INTERNAL_URL


def _fingerprint(command: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(command, sort_keys=True).encode()).hexdigest()


def _journaled(reply: dict[str, Any]) -> dict[str, Any]:
    """What the journal keeps of a reply: a sign-in's view without its link or code, which
    must not outlive the attempt (a repeat is answered without them)."""
    view = reply.get("view")
    if not isinstance(view, dict):
        return reply
    return {**reply, "view": {k: v for k, v in view.items() if k not in ("url", "userCode")}}


class Supervisor:
    def __init__(
        self,
        *,
        computer_id: str,
        generation: int,
        layout: Layout,
        account: Account,
        contract: Contract,
        policy: Policy,
        api: ComputerApi | None,
        tools: Tools | None = None,
        cgroup_dir: str | None = None,
        scope_pids: list[int] | None = None,
        host_backoff: Callable[[int], float] | None = None,
        whole_container: bool = False,
        terminal_socket: Path | None = None,
    ) -> None:
        self.computer_id = computer_id
        self.generation = generation
        self.layout = layout
        self.account = account
        self.contract = contract
        self.policy = policy
        self.api = api
        self.tools = tools or Tools()
        self.cgroup_dir = cgroup_dir
        # The pause scope: every workload process in the container (production, set by main),
        # or only these process trees (tests). Never the whole machine by default.
        self.whole_container = whole_container
        self.scope_pids = scope_pids
        self._lock = threading.RLock()
        self._journal: dict[str, tuple[str, dict[str, Any]]] = {}
        self._running: dict[str, tuple[str, threading.Event]] = {}
        self._jobs: dict[str, dict[str, Any]] = {}
        self.restore_state = "pending"
        self.published_digest: str | None = None
        self.published_checkpoint: str | None = None
        self.credentials_installed = False
        self.capture_running = False
        self._capture_gate = threading.Lock()  # held while a capture runs: no workload spawns
        self._workload_pids: set[int] = set()
        self.logins = {"claude": "unknown", "codex": "unknown"}
        self._report_seq = 0
        self._stop = threading.Event()
        self._changed = threading.Event()
        self._login_wake = threading.Event()
        self.alerts: list[str] = []
        #: The alerts by fixed kind, for the status; their text never leaves the computer.
        self.alert_counts: dict[str, int] = {}
        #: The latest captures' RC-53 counts, by capture operation (oldest first).
        self._capture_rc53: dict[str, dict[str, int]] = {}
        #: The CLIs' normalized versions, read in the background (None until read).
        self.cli_versions: dict[str, str | None] = {"claude": None, "codex": None, "gh": None}
        self._versions_at: float | None = None
        # Capture settings; tests narrow them (and inject faults into the worker).
        self.capture_margin_bytes = 64 << 20
        self.capture_grace_s = CAPTURE_WORKER_GRACE_S
        self.capture_fault = ""
        # RC-53's live values, kept in this process's memory only (Codex r2, finding 1).
        self._rc53_values: set[str] = set()
        self.rc53_tmp_roots: list[Path] | None = None  # where bridges under $TMPDIR live
        self.rc53_broker_root: Path | None = None  # the broker sockets' root outside a container
        #: Variables added to every workload environment (the image's test variant points the
        #: fake CLIs at their fake provider; production adds nothing).
        self.extra_env: dict[str, str] = {}
        self._outbox_message: dict[str, Any] | None = None
        self.terminal: subprocess.Popen[bytes] | None = None
        #: The setup terminal's sessions (WP3.28); tests point it at a socket of their own.
        self.terminals = TerminalSessions(uid=account.uid, gid=account.gid, socket=terminal_socket)
        self.sigterm = False
        layout.ensure()
        self.creds = Credentials(
            home=account.home,
            computer_id=computer_id,
            generation=generation,
            publish=self._publish_bundle,
            alert=lambda message: self._alert(message, credential=True),
        )
        self.signins = SignIns(
            self._spawn_login,
            ready=lambda: self.credentials_installed,
            alert=self._alert,
            on_change=self.changed,
        )
        self.creds.on_change = self.changed
        kwargs = {"backoff": host_backoff} if host_backoff else {}
        self.host = HostManager(
            spawn=self._spawn_host,
            prepare=self._prepare_host,
            spawn_gate=self._spawn_gate,
            on_change=self.changed,
            **kwargs,
        )

    # -- small helpers ---------------------------------------------------------------------

    def _alert(self, message: str, *, credential: bool = False) -> None:
        kind = S.alert_kind(message, credential=credential)
        with self._lock:
            self.alerts = [*self.alerts[-19:], message]
            self.alert_counts[kind] = self.alert_counts.get(kind, 0) + 1

    def changed(self) -> None:
        self._changed.set()

    @contextlib.contextmanager
    def _spawn_gate(self) -> Iterator[None]:
        with self._capture_gate:
            yield

    def _env(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        return workload_env(
            self.account.home, self.account.name, {**self.extra_env, **(extra or {})}
        )

    def _run(
        self, argv: list[str], timeout: float, stdin: bytes | None = None
    ) -> tuple[int | None, bytes]:
        """A short workload command, never during a capture (it would escape the pause)."""
        with self._spawn_gate():
            if stdin is None:
                return run_workload(
                    argv,
                    env=self._env(),
                    cwd=self.account.home,
                    uid=self.account.uid,
                    gid=self.account.gid,
                    cgroup_dir=self.cgroup_dir,
                    timeout=timeout,
                )
            from .procutil import workload_argv

            proc = subprocess.run(
                workload_argv(
                    argv, uid=self.account.uid, gid=self.account.gid, cgroup_dir=self.cgroup_dir
                ),
                env=self._env(),
                cwd=str(self.account.home),
                input=stdin,
                capture_output=True,
                timeout=timeout,
                start_new_session=True,
            )
            return proc.returncode, proc.stdout

    @property
    def restores_done(self) -> bool:
        return self.restore_state == "confirmed" and self.credentials_installed

    # -- the host ----------------------------------------------------------------------------

    def _ensure_workspace_root(self) -> None:
        """``~/work``, the host's working directory (3.C's ``workspacePath``)."""
        work = self.account.home / "work"
        if not os.path.lexists(work):
            work.mkdir(mode=0o755)
            if os.geteuid() == 0:
                os.chown(work, self.account.uid, self.account.gid)

    def _prepare_host(self, params: StartParams) -> None:
        self._ensure_workspace_root()
        code, _ = self._run_unlocked(
            host_config_command(self.tools.venv_python, params.host_config),
            stdin=json.dumps(params.host_config).encode(),
            timeout=60,
        )
        if code != 0:
            raise RuntimeError("the host configuration could not be written")

    def _run_unlocked(
        self, argv: list[str], *, stdin: bytes, timeout: float
    ) -> tuple[int | None, bytes]:
        # Called with the spawn gate already held (from the host manager).
        from .procutil import workload_argv

        proc = subprocess.run(
            workload_argv(
                argv, uid=self.account.uid, gid=self.account.gid, cgroup_dir=self.cgroup_dir
            ),
            env=self._env(),
            cwd=str(self.account.home),
            input=stdin,
            capture_output=True,
            timeout=timeout,
            start_new_session=True,
        )
        return proc.returncode, proc.stdout

    def _spawn_host(self, params: StartParams) -> subprocess.Popen[bytes]:
        log = open(self.layout.log / "host.log", "ab")  # noqa: SIM115 - handed to the child
        try:
            proc = spawn_workload(
                host_argv(self.tools.omnigent, self.tools.server_url),
                env=host_env(self._env(), params),
                cwd=self.account.home / "work",
                uid=self.account.uid,
                gid=self.account.gid,
                cgroup_dir=self.cgroup_dir,
                stdout=log,
            )
        finally:
            log.close()
        with self._lock:
            self._workload_pids.add(proc.pid)
        return proc

    def start_terminal(self) -> None:
        """The setup terminal, as workload, once both restores are done."""
        if not self.tools.terminal or self.terminal is not None:
            return
        with self._spawn_gate():
            self.terminal = spawn_workload(
                self.tools.terminal,
                env=self._env(),
                cwd=self.account.home,
                uid=self.account.uid,
                gid=self.account.gid,
                cgroup_dir=self.cgroup_dir,
            )
            with self._lock:
                self._workload_pids.add(self.terminal.pid)

    def _spawn_login(
        self, service: str, cancelled: Callable[[], bool]
    ) -> tuple[subprocess.Popen[bytes], int]:
        """A sign-in's CLI login (signin.py), as workload: the terminal's environment, the
        person's account, the workload cgroup, and never while a capture runs. Waiting for a
        capture's gate gives up as soon as the attempt ends."""
        cli = self.tools.claude if service == "claude" else self.tools.codex
        while not self._capture_gate.acquire(timeout=0.2):
            if cancelled():
                raise SpawnCancelled
        try:
            if cancelled():
                raise SpawnCancelled
            # A sign-in from the page ends the setup terminal's sessions first (WP3.28).
            self._end_terminals()
            proc, fd = spawn_login(
                service,
                cli=cli,
                env=self._env({"TERM": "xterm-256color"}),
                cwd=str(self.account.home),
                argv_wrapper=lambda argv: workload_argv(
                    argv, uid=self.account.uid, gid=self.account.gid, cgroup_dir=self.cgroup_dir
                ),
            )
            with self._lock:
                self._workload_pids.add(proc.pid)
        finally:
            self._capture_gate.release()
        return proc, fd

    # -- commands ----------------------------------------------------------------------------

    def handle(self, body: bytes) -> tuple[int, dict[str, Any]]:
        """One command body in, (HTTP status, reply or ErrorBody) out."""
        try:
            try:
                raw = json.loads(body)
            except (ValueError, RecursionError) as exc:
                raise CommandError("bad_request", "the body is not JSON") from exc
            # Refused before the schema, so a newer protocol's command is named as such.
            version = raw.get("protocolVersion") if isinstance(raw, dict) else None
            if (
                isinstance(version, (int, float))
                and not isinstance(version, bool)
                and version not in SUPPORTED_PROTOCOL_VERSIONS
            ):
                raise CommandError("unsupported_version", "unsupported protocol version")
            try:
                command = self.contract.parse_command(raw)
            except ContractError as exc:
                raise CommandError(exc.code, str(exc)) from exc
            if command["computerId"] != self.computer_id:
                raise CommandError("forbidden", "a command for another computer")
            if command["generation"] != self.generation:
                raise CommandError("stale_generation", "a command for another generation")
            reply = self._dispatch(command)
            try:
                self.contract.check_outbound("WorkspaceCommandReply", reply)
            except Exception as exc:  # noqa: BLE001 - a supervisor bug, never sent
                raise CommandError("internal", "the reply failed its own contract check") from exc
            return 200, reply
        except CommandError as exc:
            return HTTP_STATUS.get(exc.code, 500), error_body(
                exc.code, str(exc), retryable=exc.retryable
            )
        except Exception as exc:  # noqa: BLE001 - an unexpected failure is retryable, unrecorded
            self._alert(f"command failed: {type(exc).__name__}")
            return 500, error_body("internal", type(exc).__name__, retryable=True)

    def _dispatch(self, command: dict[str, Any]) -> dict[str, Any]:
        kind = command["type"]
        if kind == "status":
            return {"type": "status", "report": self.report()}
        if kind == "job_status":
            return {"type": "job_status", "job": self._job_view(command["jobOperationId"])}
        if kind in UNJOURNALED:
            return getattr(self, f"_cmd_{kind}")(command)
        op = command["operationId"]
        # Never the pasted code, not even hashed: the journal outlives the attempt.
        fingerprint = _fingerprint({k: v for k, v in command.items() if k != "code"})
        # Reserve the operation ID before any effect (Codex r1, finding 6): a concurrent repeat
        # waits for the first one's answer instead of running the command again, and the same
        # ID with another body is refused. A failure releases the reservation unrecorded.
        with self._lock:
            known = self._journal.get(op)
            if known is None:
                pending = self._running.get(op)
                if pending is not None:
                    if pending[0] != fingerprint:
                        raise CommandError(
                            "conflict", "this operation ID was used for another command"
                        )
                    wait = pending[1]
                else:
                    wait = None
                    self._running[op] = (fingerprint, threading.Event())
            elif known[0] != fingerprint:
                raise CommandError("conflict", "this operation ID was used for another command")
        if known is not None:
            return self._recorded(kind, op, known[1])
        if wait is not None:
            wait.wait(REPEAT_WAIT_S)
            with self._lock:
                known = self._journal.get(op)
            if known is None:
                raise CommandError(
                    "unavailable", "the first delivery has not finished", retryable=True
                )
            return self._recorded(kind, op, known[1])
        try:
            reply = getattr(self, f"_cmd_{kind}")(command)
            with self._lock:
                self._journal[op] = (fingerprint, _journaled(reply))
        finally:
            with self._lock:
                _fp, event = self._running.pop(op)
            event.set()
        return reply

    def _recorded(self, kind: str, op: str, reply: dict[str, Any]) -> dict[str, Any]:
        if kind in ("restore_workspace", "capture"):
            return {"type": kind, "job": self._job_view(op)}
        return reply

    # restore_workspace ----------------------------------------------------------------------

    def _cmd_restore_workspace(self, command: dict[str, Any]) -> dict[str, Any]:
        op = command["operationId"]
        with self._lock:
            if self.restore_state in ("running", "confirmed"):
                raise CommandError("conflict", f"a restore is already {self.restore_state}")
            self.restore_state = "running"
            self._jobs[op] = {"kind": "restore", "jobOperationId": op, "state": "running"}
        threading.Thread(target=self._restore_job, args=(command,), daemon=True).start()
        self.changed()
        return {"type": "restore_workspace", "job": self._job_view(op)}

    def _restore_job(self, command: dict[str, Any]) -> None:
        op = command["operationId"]
        job: dict[str, Any]
        try:
            result = restore_workspace(
                command["manifest"],
                command["layerDirs"],
                home=self.account.home,
                restore_root=self.layout.restore,
                merge_root=self.layout.merge,
                replaced_root=self.layout.replaced,
                policy=self.policy,
                contract=self.contract,
                job_id=op,
            )
            self._write_published(
                result.index, command["manifest"]["checkpointId"] if command["manifest"] else None
            )
            for _path in result.stripped:
                self._alert("a restored layer held a member the policy does not save")
            for raw in command["layerDirs"]:
                shutil.rmtree(raw, ignore_errors=True)
            self._ensure_workspace_root()
            job = {
                "kind": "restore",
                "jobOperationId": op,
                "state": "done",
                "treeDigest": result.tree_digest,
                "entries": result.entries,
                "stripped": len(result.stripped),
            }
            state = "confirmed"
        except RestoreFailed as exc:
            job = {"kind": "restore", "jobOperationId": op, "state": "failed", "reason": exc.reason}
            state = "failed"
        except Exception:  # noqa: BLE001
            self._alert("restore failed unexpectedly")
            job = {
                "kind": "restore",
                "jobOperationId": op,
                "state": "failed",
                "reason": "move_failed",
            }
            state = "failed"
        with self._lock:
            self._jobs[op] = job
            self.restore_state = state
        self.changed()

    def _write_published(self, index: list[dict[str, Any]], checkpoint_id: str | None) -> None:
        data = self.layout.data
        tmp = data / "published-index.json.tmp"
        tmp.write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False))
        os.replace(tmp, data / "published-index.json")
        with self._lock:
            self.published_digest = tree_digest(index)
            self.published_checkpoint = checkpoint_id

    # install_credentials --------------------------------------------------------------------

    def _cmd_install_credentials(self, command: dict[str, Any]) -> dict[str, Any]:
        if self.restore_state != "confirmed":
            raise CommandError("conflict", "the workspace restore is not confirmed")
        with self._capture_gate:
            floor = self.creds.order
            try:
                result = install_bundle(
                    command["bundle"],
                    home=self.account.home,
                    staging=self.layout.credentials_staging,
                    uid=self.account.uid,
                    gid=self.account.gid,
                )
            except CredentialAlert as exc:
                raise CommandError("bad_request", str(exc)) from exc
            self.creds.baseline()
            with self._lock:
                self.credentials_installed = True
        self._login_wake.set()
        self.changed()
        threading.Thread(target=self.start_terminal, daemon=True).start()
        return {
            "type": "install_credentials",
            "installed": result.installed,
            "removed": result.removed,
            "orderFloor": floor,
        }

    # start_host -----------------------------------------------------------------------------

    def _cmd_start_host(self, command: dict[str, Any]) -> dict[str, Any]:
        params = StartParams(
            attempt=int(command["startAttempt"]),
            host_id=command["hostId"],
            host_name=command["hostName"],
            token=command["token"],
            host_config=command["hostConfig"],
        )
        outcome = self.host.start(params, restores_done=self.restores_done)
        self.changed()
        return {"type": "start_host", "outcome": outcome}

    # capture --------------------------------------------------------------------------------

    def _cmd_capture(self, command: dict[str, Any]) -> dict[str, Any]:
        op = command["operationId"]
        if self.restore_state != "confirmed":
            raise CommandError("conflict", "the workspace restore is not confirmed")
        if command["policyVersion"] != self.policy.version:
            raise CommandError("unsupported_version", "unsupported checkpoint policy version")
        with self._lock:
            if self.capture_running:
                return {"type": "capture", "job": self._failed_capture(op, "busy")}
        # The spawn gate is taken BEFORE the workload's processes are listed and held until the
        # worker has exited, so no host restart, terminal or CLI can start in between and
        # escape the pause (Codex r1, finding 2). A spawn in progress finishes first.
        if not self._capture_gate.acquire(timeout=GATE_WAIT_S):
            raise CommandError("unavailable", "a workload command is still running", retryable=True)
        try:
            with self._lock:
                if self.capture_running:
                    self._capture_gate.release()
                    return {"type": "capture", "job": self._failed_capture(op, "busy")}
            # A stop's final capture ends the setup terminal's sessions first (WP3.28), before
            # the workload is listed: no capture runs, so the tmux server is not paused.
            if command.get("endTerminals"):
                self._end_terminals()
            with self._lock:
                parent_path = None
                if command["kind"] == "delta":
                    want = command["parent"]["treeDigest"]
                    self._settle_pending(want)
                    if self.published_digest != want:
                        self._capture_gate.release()
                        return {
                            "type": "capture",
                            "job": self._failed_capture(op, "parent_mismatch"),
                        }
                    parent_path = str(self.layout.data / "published-index.json")
                else:
                    self._settle_pending(None)
                self.capture_running = True
                self._jobs[op] = {"kind": "capture", "jobOperationId": op, "state": "running"}
            spec = {
                "home": str(self.account.home),
                "snapshot": str(self.layout.snapshot),
                "staged_root": str(self.layout.staged),
                "data_dir": str(self.layout.data),
                "log_dir": str(self.layout.log),
                "policy_file": str(self.layout.policy_file),
                "schema_dir": str(self.layout.schema_dir),
                "layer_id": command["layerId"],
                "kind": command["kind"],
                "parent": command["parent"],
                "parent_index": parent_path,
                "lease": command["lease"],
                "computer_id": self.computer_id,
                "generation": self.generation,
                "supervisor_pid": os.getpid(),
                "workload_pids": sorted(self._live_workload() | set(self.scope_pids or ())),
                "cgroup_dir": self.cgroup_dir,
                "scope_pids": self.scope_pids,
                "whole_container": self.whole_container,
                "margin_bytes": self.capture_margin_bytes,
                "fault": self.capture_fault,
                "record_kinds": True,
                "stop_journal": str(self.layout.log / f"capture-{op}.stops"),
                "rc53": self._rc53_enabled(),
            }
            threading.Thread(target=self._capture_job, args=(op, spec), daemon=True).start()
        except BaseException:
            # Nothing started: give the gate back and end the job.
            with self._lock:
                if self._jobs.get(op, {}).get("state") == "running":
                    self._jobs[op] = self._failed_capture(op, "copy_failed", record=False)
                    self.capture_running = False
            self._capture_gate.release()
            raise
        self.changed()
        return {"type": "capture", "job": self._job_view(op)}

    def _rc53_enabled(self) -> bool:
        """RC-53's opt-in staging check: on while ``<state>/rc53/enabled`` exists."""
        return (self.layout.state / "rc53" / "enabled").exists()

    def _rc53_descriptor(self) -> int:
        """Collect the live token values now, add them to those kept in memory, and hand all
        of them over on an anonymous memory descriptor: no value ever touches disk, argv or a
        log (Codex r2, finding 1). Raises on a collection failure, which fails the capture."""
        whole = self.whole_container
        found = rc53_collect.collect(
            self.account.home,
            tmp_roots=self.rc53_tmp_roots,
            process_scope=None if whole else set(self.scope_pids or ()) | self._live_workload(),
            broker_root=Path("/tmp") if whole else self.rc53_broker_root,
        )
        self._rc53_values |= found
        fd = os.memfd_create("cfo-rc53", os.MFD_CLOEXEC)
        try:
            data = memoryview("\0".join(sorted(self._rc53_values)).encode())
            while data:
                data = data[os.write(fd, data) :]
            os.lseek(fd, 0, os.SEEK_SET)
        except BaseException:
            os.close(fd)
            raise
        return fd

    def _failed_capture(self, op: str, reason: str, *, record: bool = True) -> dict[str, Any]:
        job = {
            "kind": "capture",
            "jobOperationId": op,
            "state": "failed",
            "reason": reason,
            "pausedMs": 0,
        }
        if record:
            self._jobs[op] = job
        return job

    def _settle_pending(self, parent_digest: str | None) -> None:
        """Resolve a staged layer whose finish_capture never came: if WorkspaceDO now names
        it as the parent, it was published; otherwise it is discarded."""
        for _op, job in list(self._jobs.items()):
            if job.get("kind") != "capture" or job.get("state") != "staged" or job.get("finished"):
                continue
            if parent_digest is not None and job["treeDigest"] == parent_digest:
                self._promote(job)
            else:
                self._discard(job)

    def _promote(self, job: dict[str, Any]) -> None:
        pending = self.layout.data / f"pending-{job['layerId']}.json"
        os.replace(pending, self.layout.data / "published-index.json")
        self.published_digest = job["treeDigest"]
        shutil.rmtree(job["layerDir"], ignore_errors=True)
        job["finished"] = "published"

    def _discard(self, job: dict[str, Any]) -> None:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.layout.data / f"pending-{job['layerId']}.json")
        shutil.rmtree(job["layerDir"], ignore_errors=True)
        job["finished"] = "discarded"

    def _live_workload(self) -> set[int]:
        with self._lock:
            alive = set()
            for pid in self._workload_pids:
                try:
                    os.kill(pid, 0)
                    alive.add(pid)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    alive.add(pid)
            self._workload_pids = alive
            return alive

    def _capture_job(self, op: str, spec: dict[str, Any]) -> None:
        """Run the worker; whatever happens, end the job, clear the flag, resume anything the
        worker or its guard left stopped, and give the spawn gate back (findings 8 and 9)."""
        spec_path = self.layout.log / f"capture-{op}.spec.json"
        result_path = self.layout.log / f"capture-{op}.result.json"
        result: dict[str, Any] = {"state": "failed", "reason": "copy_failed", "pausedMs": 0}
        journal = Path(spec["stop_journal"])
        values_fd: int | None = None
        try:
            if spec.pop("rc53", False):
                try:
                    values_fd = self._rc53_descriptor()
                except Exception:  # noqa: BLE001 - never staged with unknown values
                    self._alert("RC-53: the live values could not be collected")
                    result = {"state": "failed", "reason": "policy_violation", "pausedMs": 0}
                    raise _CaptureRefused from None
                spec["rc53_fd"] = values_fd
            spec_path.write_text(json.dumps(spec))
            with contextlib.suppress(FileNotFoundError):
                result_path.unlink()
            worker = subprocess.Popen(
                module_argv("cfo_computer.capture", str(spec_path), str(result_path)),
                start_new_session=True,
                stdin=subprocess.DEVNULL,
                pass_fds=(values_fd,) if values_fd is not None else (),
            )
            if values_fd is not None:
                os.close(values_fd)
                values_fd = None
            watchdog = threading.Thread(
                target=self._pause_watchdog, args=(worker, journal), daemon=True
            )
            watchdog.start()
            limit = spec["lease"]["hardMs"] / 1000.0 + self.capture_grace_s
            try:
                worker.wait(timeout=limit)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()
            result = json.loads(result_path.read_text())
        except _CaptureRefused:
            pass
        except Exception:  # noqa: BLE001 - a setup failure or a dead worker: a failed capture
            self._alert("a capture failed before it produced a result")
        finally:
            if values_fd is not None:
                os.close(values_fd)
            try:
                resumed = resume_journal(journal)
                if resumed:
                    self._alert(f"resumed {resumed} processes a capture left stopped")
            except Exception:  # noqa: BLE001
                self._alert("the capture's stop journal could not be replayed")
            try:
                job = self._capture_job_view(op, result)
            except Exception:  # noqa: BLE001
                job = {
                    "kind": "capture",
                    "jobOperationId": op,
                    "state": "failed",
                    "reason": "copy_failed",
                    "pausedMs": 0,
                }
            with self._lock:
                self._jobs[op] = job
                self.capture_running = False
            self._capture_gate.release()
            self.changed()
        counts = S.rc53_counts(result)
        if counts is not None:
            with self._lock:
                self._capture_rc53[op] = counts
                while len(self._capture_rc53) > KEEP_CAPTURE_COUNTS:
                    del self._capture_rc53[next(iter(self._capture_rc53))]
        if result.get("rc53", {}).get("status", 0) != 0:
            self._alert("RC-53: a staged layer holds a live token value or could not be scanned")
        if result.get("skipped"):
            self._alert("the capture left paths out: " + ", ".join(sorted(result["skipped"])))

    def _pause_watchdog(self, worker: subprocess.Popen[bytes], journal: Path) -> None:
        """Independent recovery within the pause's own bound (Codex r2, finding 3): once the
        lease is armed, if the worker is still running a moment after the lease's deadline,
        resume whatever the capture asked to stop and has not seen released, whatever the
        worker and its guard are doing."""
        deadline = None
        while worker.poll() is None and deadline is None:
            deadline = journal_deadline(journal)
            if deadline is None:
                time.sleep(0.1)
        if deadline is None:
            return
        wait = deadline + PAUSE_RECOVERY_MARGIN_S - time.monotonic()
        try:
            worker.wait(timeout=max(0.0, wait))
            return  # the worker ended in time; the job's own replay follows
        except subprocess.TimeoutExpired:
            pass
        try:
            resumed = resume_journal(journal)
        except Exception:  # noqa: BLE001
            self._alert("the capture's stop journal could not be replayed at its deadline")
            return
        if resumed:
            self._alert(f"resumed {resumed} processes at the pause deadline")

    def _capture_job_view(self, op: str, result: dict[str, Any]) -> dict[str, Any]:
        base = {"kind": "capture", "jobOperationId": op}
        if result.get("state") == "staged":
            return {
                **base,
                "state": "staged",
                "layerDir": result["layerDir"],
                "indexSha256": result["indexSha256"],
                "treeDigest": result["treeDigest"],
                "entries": result["entries"],
                "deleted": result["deleted"],
                "bytes": result["bytes"],
                "cutAt": result["cutAt"],
                "pausedMs": int(result["pausedMs"]),
                "layerId": result["layerId"],
            }
        if result.get("state") == "unchanged":
            return {
                **base,
                "state": "unchanged",
                "cutAt": result["cutAt"],
                "pausedMs": int(result["pausedMs"]),
            }
        return {
            **base,
            "state": "failed",
            "reason": result.get("reason", "copy_failed"),
            "pausedMs": int(result.get("pausedMs", 0)),
        }

    def _cmd_finish_capture(self, command: dict[str, Any]) -> dict[str, Any]:
        capture_op = command["captureOperationId"]
        with self._lock:
            job = self._jobs.get(capture_op)
            if job is None or job.get("kind") != "capture":
                raise CommandError("not_found", "no such capture")
            if job["state"] == "running":
                raise CommandError("conflict", "the capture is still running", retryable=True)
            if job["state"] == "staged" and not job.get("finished"):
                if command["outcome"] == "published":
                    self._promote(job)
                else:
                    self._discard(job)
        self.changed()
        return {"type": "finish_capture", "done": True}

    def _job_view(self, op: str) -> dict[str, Any]:
        with self._lock:
            job = self._jobs.get(op)
            if job is None:
                raise CommandError("not_found", "no such job")
            return {k: v for k, v in job.items() if k not in ("finished", "layerId")}

    # credentials ----------------------------------------------------------------------------

    def _cmd_credential_snapshot(self, command: dict[str, Any]) -> dict[str, Any]:
        # The final barrier of a stop or a sign-out: the terminal's sessions end first (WP3.28).
        self._end_terminals()
        if not self.credentials_installed:
            raise CommandError("conflict", "the credentials are not installed")
        deadline = time.monotonic() + 5.0
        while True:
            try:
                bundle = self.creds.snapshot(force=True)
                break
            except UnstableRead as exc:
                if time.monotonic() > deadline:
                    raise CommandError(
                        "unavailable", "a credential file keeps changing", retryable=True
                    ) from exc
                time.sleep(0.2)
            except CredentialAlert as exc:
                raise CommandError("internal", str(exc)) from exc
        assert bundle is not None
        self.creds.enqueue(bundle)
        return {"type": "credential_snapshot", "order": bundle["order"]}

    def _cmd_sign_out(self, command: dict[str, Any]) -> dict[str, Any]:
        # The setup terminal's sessions end first (WP3.28): no shell outlives a sign-out.
        self._end_terminals()
        # A sign-in still running could finish after the logouts: it is ended first, its process
        # reaped; if that cannot be confirmed, nothing runs and WorkspaceDO asks again.
        if not self.signins.cancel_all():
            raise CommandError("unavailable", "a sign-in is still being stopped", retryable=True)
        result = L.sign_out(
            lambda argv, timeout: self._run(list(argv), timeout),
            self.tools.claude,
            self.tools.codex,
        )
        self.creds.tick()
        self._login_wake.set()
        return {"type": "sign_out", "claude": result["claude"], "codex": result["codex"]}

    # sign-in, status and the staging check (WP3.23) ------------------------------------------

    def _cmd_sign_in_start(self, command: dict[str, Any]) -> dict[str, Any]:
        view = self.signins.start(command["service"], int(command["attempt"]))
        return {"type": "sign_in_start", "view": view}

    def _cmd_sign_in_input(self, command: dict[str, Any]) -> dict[str, Any]:
        try:
            view = self.signins.write(command["service"], int(command["attempt"]), command["code"])
        except SignInConflict as exc:
            raise CommandError("conflict", str(exc)) from None
        return {"type": "sign_in_input", "view": view}

    def _cmd_sign_in_cancel(self, command: dict[str, Any]) -> dict[str, Any]:
        try:
            view = self.signins.cancel(command["service"], int(command["attempt"]))
        except SignInUnsettled as exc:
            raise CommandError("unavailable", str(exc), retryable=True) from None
        return {"type": "sign_in_cancel", "view": view}

    def _cmd_sign_in_status(self, command: dict[str, Any]) -> dict[str, Any]:
        view = self.signins.status(command["service"], int(command["attempt"]))
        return {"type": "sign_in_status", "view": view}

    def _cmd_computer_status(self, command: dict[str, Any]) -> dict[str, Any]:
        return {"type": "computer_status", "status": self.computer_status()}

    # the setup terminal's sessions (WP3.28) --------------------------------------------------

    def _cmd_terminal_end(self, command: dict[str, Any]) -> dict[str, Any]:
        # A capture may have paused the tmux server: WorkspaceDO asks again afterwards.
        if self.capture_running:
            raise CommandError("unavailable", "a capture is running", retryable=True)
        try:
            remaining = self.terminals.end(int(command["window"]))
        except NotAnswering:
            raise CommandError(
                "unavailable", "the terminal sessions did not answer", retryable=True
            ) from None
        self.changed()
        return {"type": "terminal_end", "remaining": remaining}

    def _end_terminals(self) -> None:
        """Every setup-terminal session, and every process in one, ends now, answering or not,
        and is confirmed gone (``end_all``). Otherwise the credential-sensitive step it guards
        does not run: a retryable refusal, before any effect (Codex WP3.28 r1-3)."""
        try:
            self.terminals.end_all()
        except Exception:  # noqa: BLE001 - never the exception's text
            self._alert("the terminal sessions could not be ended")
            raise CommandError(
                "unavailable", "the terminal sessions could not be ended", retryable=True
            ) from None

    def _terminal_loop(self) -> None:
        """The reaper: a session with no stream for 45 s, or older than 30 minutes, ends."""
        while not self._stop.wait(REAP_INTERVAL_S):
            # A capture (or a workload spawn) holds the gate: the server may be paused.
            if not self._capture_gate.acquire(blocking=False):
                continue
            try:
                ended = self.terminals.reap()
            except NotAnswering:
                ended = []
            except Exception:  # noqa: BLE001 - the reaper must never stop
                self._alert("the terminal reaper failed")
                ended = []
            finally:
                self._capture_gate.release()
            if ended:
                self.changed()

    def _cmd_staging_check(self, command: dict[str, Any]) -> dict[str, Any]:
        """RC-53's save check on or off: ``<state>/rc53/enabled``. WorkspaceDO sends it only on
        a staging installation."""
        flag = self.layout.state / "rc53" / "enabled"
        if command["rc53"]:
            flag.parent.mkdir(mode=0o700, exist_ok=True)
            flag.touch(mode=0o600, exist_ok=True)
        else:
            with contextlib.suppress(FileNotFoundError):
                flag.unlink()
        self.changed()
        return {"type": "staging_check", "rc53": self._rc53_enabled()}

    def computer_status(self) -> dict[str, Any]:
        """The supervisor's metrics (status.py): names, versions, states and counts only."""
        with self._lock:
            alerts = [
                {"kind": kind, "count": count}
                for kind, count in sorted(self.alert_counts.items())
                if kind in S.ALERT_KINDS
            ][:32]
            captures = [
                {"jobOperationId": op, "rc53": counts}
                for op, counts in list(self._capture_rc53.items())[-KEEP_CAPTURE_COUNTS:]
            ]
            logins = dict(self.logins)
            versions = dict(self.cli_versions)
            capture_running = self.capture_running
        # Not while a capture pauses the tmux server: the count is left out then.
        terminals = None if capture_running else self.terminals.count()
        return {
            "supervisorVersion": SUPERVISOR_VERSION,
            "versions": versions,
            "logins": logins,
            "signIn": self.signins.states(),
            "rc53": self._rc53_enabled(),
            "hostname": S.hostname_mapped(),
            "disk": S.disk(self.account.home),
            "alerts": alerts,
            "captures": captures,
            **({"terminals": terminals} if terminals is not None else {}),
        }

    def refresh_versions(self, now: float | None = None) -> None:
        """Reads the CLIs' versions, as workload, at most every ``VERSIONS_INTERVAL_S``."""
        now = time.monotonic() if now is None else now
        if self._versions_at is not None and now - self._versions_at < VERSIONS_INTERVAL_S:
            return
        found = S.versions(
            lambda argv, timeout: self._run(list(argv), timeout),
            {"claude": self.tools.claude, "codex": self.tools.codex, "gh": self.tools.gh},
        )
        with self._lock:
            self.cli_versions = found
            self._versions_at = now

    def verify_signed_out(self, bundle: dict[str, Any] | None) -> list[str]:
        """Q6: the published bundle, installed into a scratch home, leaves no declared file.

        Not on the wire yet: the computer API has no command for it (a contract addition for
        the lead). The install path is the one ``install_credentials`` uses.
        """
        return verify_signed_out(
            bundle,
            scratch=self.layout.scratch / new_operation_id(),
            uid=self.account.uid,
            gid=self.account.gid,
        )

    def _publish_bundle(self, bundle: dict[str, Any]) -> str:
        if self.api is None:
            raise Unanswered("no computer API")
        # Repeated unchanged, with the same operation ID, until answered.
        message = self._outbox_message
        if message is None or message["bundle"] is not bundle:
            message = self._envelope("credential_checkpoint")
            message["bundle"] = bundle
            self._outbox_message = message
        try:
            reply = self.api.send_once(message)
        except Refused as exc:
            self._alert(f"credential checkpoint refused: {exc.code}")
            raise Unanswered(exc.code) from exc
        return reply["outcome"]

    # reports and messages -------------------------------------------------------------------

    def _envelope(self, kind: str) -> dict[str, Any]:
        return {
            "type": kind,
            "protocolVersion": SUPERVISOR_PROTOCOL_VERSION,
            "computerId": self.computer_id,
            "generation": self.generation,
            "operationId": new_operation_id(),
        }

    def runner_processes(self) -> int:
        try:
            return int(R.classify()["runner_count"])
        except Exception:  # noqa: BLE001 - unknown counts as live (AT3-002)
            return 1

    def report(self) -> dict[str, Any]:
        with self._lock:
            self._report_seq += 1
            seq = self._report_seq
            capture = "running" if self.capture_running else "idle"
            restore = self.restore_state
        host = self.host.report()
        runners = self.runner_processes() if host["state"] != "not_started" else 0
        return {
            "seq": seq,
            "host": host,
            "runnerProcesses": runners,
            "restore": restore,
            "capture": capture,
            "credentialsPending": self.creds.pending(),
            "logins": dict(self.logins),
        }

    def refresh_logins(self) -> None:
        if not self.credentials_installed:
            return
        run = lambda argv, timeout: self._run(list(argv), timeout)  # noqa: E731
        status = {
            "claude": L.claude_status(run, self.tools.claude),
            "codex": L.codex_status(run, self.tools.codex),
        }
        with self._lock:
            changed = status != self.logins
            self.logins = status
        if changed:
            self.changed()

    def hello(self) -> None:
        assert self.api is not None
        message = self._envelope("hello")
        message["supervisorVersion"] = SUPERVISOR_VERSION
        message["features"] = list(SUPERVISOR_FEATURES)
        self.api.send(message, stop=self._stop.is_set)

    def send_report(self) -> None:
        if self.api is None:
            return
        message = self._envelope("report")
        message["report"] = self.report()
        with contextlib.suppress(Unanswered, Refused):  # the next report replaces this one
            self.api.send(message, attempts=3, stop=self._stop.is_set)

    def request_save(self) -> None:
        """SIGTERM: a best-effort workspace save (design, capture "at sleep; best-effort on
        SIGTERM"). WorkspaceDO decides; the supervisor keeps serving until it is killed."""
        self.sigterm = True
        if self.api is None:
            return
        message = self._envelope("save_request")
        message["reason"] = "sigterm"
        with contextlib.suppress(Unanswered, Refused):
            self.api.send(message, attempts=5, stop=lambda: False)

    # loops ----------------------------------------------------------------------------------

    def start_loops(self) -> None:
        threading.Thread(target=self._report_loop, name="reports", daemon=True).start()
        threading.Thread(target=self.creds.run, name="credentials", daemon=True).start()
        threading.Thread(target=self._login_loop, name="logins", daemon=True).start()
        threading.Thread(target=self._terminal_loop, name="terminals", daemon=True).start()

    def _report_loop(self) -> None:
        if self.api is not None:
            try:
                self.hello()
            except (Unanswered, Refused) as exc:
                self._alert(f"hello not answered: {exc}")
        while not self._stop.is_set():
            self._changed.wait(REPORT_INTERVAL_S)
            if self._stop.is_set():
                return
            time.sleep(0.2)  # fold a burst of changes into one report
            self._changed.clear()
            try:
                self.send_report()
            except Exception:  # noqa: BLE001 - reporting must never stop
                self._alert("report failed: " + traceback.format_exc(limit=1)[-200:])

    def _login_loop(self) -> None:
        while not self._stop.is_set():
            self._login_wake.wait(LOGIN_INTERVAL_S)
            self._login_wake.clear()
            if self._stop.is_set():
                return
            with contextlib.suppress(Exception):
                self.refresh_logins()
            if self.credentials_installed:
                with contextlib.suppress(Exception):
                    self.refresh_versions()

    def stop(self) -> None:
        self._stop.set()
        self._changed.set()
        self._login_wake.set()
        self.creds.stop()
        self.signins.cancel_all()
        self.host.stop()
        if self.terminal is not None and self.terminal.poll() is None:
            self.terminal.terminate()
        with contextlib.suppress(CommandError):
            self._end_terminals()
