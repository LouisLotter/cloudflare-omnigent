"""Omnigent's host process: start attempts, restarts with the same token, and parking.

The rules (design, "One controller per computer"; G1BR-005; FH-30, FH-33; core change 13):
- ``start_host`` parameters belong to one start attempt. They are taken only after both
  restores, once per attempt; a repeat of the taken attempt answers ``taken``; an older
  attempt (than one taken or declined) answers ``superseded``; a newer one while the host of an
  earlier attempt is starting, live or being restarted answers ``refused_live_host``. Before
  the restores are done the attempt is ``declined``, and it (and anything older) is never
  taken later, in any delivery.
- The supervisor alone restarts a host that exits, with the same token, kept in memory only,
  whatever the exit code, except core change 13's "token refused" code (77): that host is
  parked as ``refused`` and reported, never restarted. Only then is a newer attempt taken.
- A live host is never restarted. Restarts back off (1 s doubling to 30 s) and wait while a
  capture is pausing the workload, so no new process starts during a copy.
- The token is never logged, never written to disk by the supervisor, and reaches the host
  only through its environment.
"""

from __future__ import annotations

import subprocess
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .backoff import capped_backoff

HOST_TOKEN_REFUSED_EXIT_CODE = 77
RESTART_MAX_DELAY_S = 30.0


@dataclass(frozen=True)
class StartParams:
    attempt: int
    host_id: str
    host_name: str
    token: str
    host_config: dict[str, Any]

    def __repr__(self) -> str:  # never print the token
        return f"StartParams(attempt={self.attempt}, host_id={self.host_id!r})"


class HostManager:
    """Takes start attempts and keeps one host process running for the taken attempt."""

    def __init__(
        self,
        *,
        spawn: Callable[[StartParams], subprocess.Popen[bytes]],
        prepare: Callable[[StartParams], None],
        spawn_gate: Callable[[], Any],
        on_change: Callable[[], None] = lambda: None,
        backoff: Callable[[int], float] = lambda n: capped_backoff(n, 1.0, RESTART_MAX_DELAY_S),
    ) -> None:
        self._spawn = spawn
        self._prepare = prepare
        self._spawn_gate = spawn_gate
        self._on_change = on_change
        self._backoff = backoff
        self._lock = threading.RLock()
        self.state = "not_started"
        self.params: StartParams | None = None
        self.declined_up_to = 0
        self.restarts = 0
        self.last_exit: int | None = None
        self.proc: subprocess.Popen[bytes] | None = None
        self._stopping = False
        self._thread: threading.Thread | None = None

    @property
    def attempt(self) -> int | None:
        return self.params.attempt if self.params else None

    def pid(self) -> int | None:
        with self._lock:
            return self.proc.pid if self.proc is not None and self.proc.poll() is None else None

    def start(self, params: StartParams, *, restores_done: bool) -> str:
        """Answer one ``start_host``; ``taken`` starts the host (once)."""
        with self._lock:
            taken = self.attempt or 0
            if params.attempt == taken:
                return "taken"
            if params.attempt < max(taken, self.declined_up_to):
                return "superseded"
            if params.attempt == self.declined_up_to:
                return "declined"
            if self.state in ("starting", "running", "restarting"):
                return "refused_live_host"
            if not restores_done:
                self.declined_up_to = params.attempt
                return "declined"
            self.params = params
            self.restarts = 0
            self.state = "starting"
            self._thread = threading.Thread(target=self._run, args=(params,), daemon=True)
            self._thread.start()
        self._on_change()
        return "taken"

    def _run(self, params: StartParams) -> None:
        failures = 0
        first = True
        prepared = False  # the attempt's configuration is written (Codex r1, finding 10)
        while True:
            with self._lock:
                if self._stopping or self.params is not params:
                    return
            if not first:
                with self._lock:
                    self.state = "restarting"
                self._on_change()
                time.sleep(self._backoff(failures))
            # Never while a capture pauses the workload.
            with self._spawn_gate(), self._lock:
                if self._stopping or self.params is not params:
                    return
                try:
                    if not prepared:
                        # Never start the host without its configuration: retried until
                        # written, like a crash.
                        self._prepare(params)
                        prepared = True
                    proc = self._spawn(params)
                except Exception:  # noqa: BLE001 - a failed spawn is retried like a crash
                    proc = None
                self.proc = proc
                if proc is not None:
                    self.state = "running"
            self._on_change()
            first = False
            if proc is None:
                failures += 1
                continue
            code = proc.wait()
            with self._lock:
                self.last_exit = code
                if self._stopping:
                    return
                if code == HOST_TOKEN_REFUSED_EXIT_CODE:
                    self.state = "refused"
                    self.proc = None
                    self._on_change()
                    return
                self.restarts += 1
            failures += 1
            self._on_change()

    def report(self) -> dict[str, Any]:
        with self._lock:
            return {"state": self.state, "startAttempt": self.attempt, "restarts": self.restarts}

    def stop(self) -> None:
        """For tests and shutdown: stop restarting, and end the host."""
        with self._lock:
            self._stopping = True
            proc = self.proc
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


def host_env(base: Mapping[str, str], params: StartParams) -> dict[str, str]:
    """The host's environment: the workload's, plus the identity and the token."""
    return {
        **base,
        "OMNIGENT_HOST_ID": params.host_id,
        "OMNIGENT_HOST_NAME": params.host_name,
        "OMNIGENT_HOST_TOKEN": params.token,
    }


def host_argv(omnigent: str, server_url: str) -> list[str]:
    """``omnigent host`` runs the host daemon in the foreground: its exit is the host's."""
    return [omnigent, "host", "--server", server_url, "--no-open", "--non-interactive"]


def host_config_command(python: str, host_config: dict[str, Any]) -> list[str]:
    """Omnigent's own server-managed merge of a host configuration into ``config.yaml``.

    ``render_host_config_write_command`` is the fork's provider-neutral seam that every
    exec-model launcher uses (``omnigent/onboarding/sandboxes/base.py``); running it here keeps
    the merge rules (server-owned names replaced, the person's own entries kept) identical.
    """
    script = (
        "import json, subprocess, sys\n"
        "from omnigent.onboarding.sandboxes.base import render_host_config_write_command\n"
        "command = render_host_config_write_command(json.loads(sys.stdin.read()))\n"
        "sys.exit(subprocess.run(['sh', '-c', command]).returncode)\n"
    )
    return [python, "-I", "-c", script]


def write_host_config(
    run: Callable[[list[str], bytes], int], python: str, host_config: dict[str, Any], home: Path
) -> None:
    import json

    code = run(host_config_command(python, host_config), json.dumps(host_config).encode())
    if code != 0:
        raise RuntimeError(f"writing the host configuration failed ({code})")
