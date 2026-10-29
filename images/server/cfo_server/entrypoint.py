"""The server container's main process.

In order (code-structure plan, ``images/server``):

1. **Configuration.** Parse every setting strictly (:mod:`cfo_server.config`); a bad one
   exits 78 before anything starts. Start the control port (8001: ``/position``, ``/status``).
2. **Restore** if no database exists: ``litestream restore -if-replica-exists`` under a
   deadline, because a blackholed link hangs it (spike S4).
3. **Recovery mode** if the installation is marked initialized but the replica holds no
   backup, or the database is missing an owner or fails its integrity check; also when the
   restore fails or misses its deadline. Recovery mode never starts Omnigent or replication:
   port 8000 answers 503 ``recovery_mode``, ``/status`` says why, and a transient cause
   (a failed or timed-out restore) is retried.
4. **Deployment-managed settings files** from the environment: the admin list, the allowed
   domains, an empty server config; stale sharing override files are removed. Omnigent's
   artifacts go to their own S3 bucket (``OMNIGENT_ARTIFACT_URI``, checked in step 1): the
   local artifact directory holds only Omnigent's cache.
5. **Litestream, then Omnigent.** ``litestream replicate`` starts first; once its control
   socket lists the database, the app starts (:mod:`cfo_server.app`). Both are supervised: if
   either exits, the other is stopped. ``/status`` says ``initializing`` while the app starts
   (Python's imports, Omnigent's migrations, ``create_app``, the owner check) and ``running``
   once it answers ``GET /health``, so the watchdog can give each its own budget (AIR2-010).
6. **Final sync.** On SIGTERM: stop the app, then wait until Litestream's replica covers every
   commit (``replicated_txid >= txid``, the same check the barriers use), then stop
   Litestream, whose own shutdown sync is the backstop. A final sync that is not confirmed
   is reported in a log line and by exit code 75, because Litestream itself exits 0 even
   when its final sync fails.

Exit codes: 0 stopped cleanly; 75 the final sync was not confirmed; 70 Litestream failed or
never became ready; 71 the app exited on its own; 78 a setting is missing or malformed.
"""

from __future__ import annotations

import contextlib
import http.client
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from cfo_server import buildinfo
from cfo_server import config as image_config
from cfo_server.dbcheck import check_database
from cfo_server.events import log
from cfo_server.httpd import (
    REPLICATION_POSITION_PORT,
    StatusBoard,
    now_iso,
    start_control_server,
    start_recovery_responder,
)
from cfo_server.litestream import BlockingClient, LitestreamError

EXIT_OK = 0
EXIT_LITESTREAM_FAILED = 70
EXIT_APP_EXITED = 71
EXIT_FINAL_SYNC_UNCONFIRMED = 75
EXIT_CONFIG = 78

#: Sharing override files Omnigent's own ``PUT /v1/sharing`` would write. Authoritative mode
#: never reads them; any found at start are removed so nothing stale lingers.
SHARING_OVERRIDE_FILES = (
    "sharing_mode",
    "public_sharing",
    "public_sharing_max_level",
    "default_public_sessions",
)


@dataclass(frozen=True)
class Layout:
    """Where everything lives. Production paths, or a test root."""

    db_path: Path
    omnigent_data_dir: Path
    config_path: Path
    artifact_dir: Path
    run_dir: Path
    litestream_socket: Path
    litestream_config: Path
    litestream_bin: Path
    app_command: tuple[str, ...]
    app_port: int
    #: The control port: ``GET /position`` (the ``ReplicationPosition`` contract) and
    #: ``GET /status``. Only the OmnigentServer Durable Object reaches it.
    control_port: int = REPLICATION_POSITION_PORT
    bind_host: str = "0.0.0.0"
    #: Omnigent's graceful shutdown is 5 s; this is the most the entrypoint waits for it.
    app_stop_timeout_s: float = 30.0
    #: How long one look at the starting app's ``GET /health`` may take.
    app_probe_timeout_s: float = 1.0
    recovery_retry_s: float = 60.0
    #: Overrides applied to the app's environment after the pinned values (tests only).
    app_env_overrides: tuple[tuple[str, str], ...] = ()
    #: The image's build record (``cfo_server.buildinfo``), reported in ``/status``.
    build_info_path: Path = buildinfo.BUILD_INFO_PATH

    @classmethod
    def production(cls) -> Layout:
        return cls(
            db_path=image_config.DB_PATH,
            omnigent_data_dir=image_config.OMNIGENT_DATA_DIR,
            config_path=image_config.OMNIGENT_CONFIG_PATH,
            artifact_dir=image_config.ARTIFACT_DIR,
            run_dir=image_config.RUN_DIR,
            litestream_socket=image_config.LITESTREAM_SOCKET,
            litestream_config=image_config.LITESTREAM_CONFIG,
            litestream_bin=image_config.LITESTREAM_BIN,
            app_command=(sys.executable, "-m", "cfo_server.app"),
            app_port=image_config.APP_PORT,
        )


@dataclass(frozen=True)
class Ready:
    """The database is ready (or absent on a new installation); start replication."""

    source: str  # "local", "restored" or "fresh"
    detail: str
    #: Whether the database already has an owner (a password user).
    owner: bool = False


@dataclass(frozen=True)
class Recovery:
    """Do not start. ``transient`` causes are retried."""

    reason: str
    detail: str
    transient: bool


# ── Litestream configuration ──────────────────────────────────────────────────────────


def litestream_config(config: image_config.ServerImageConfig, layout: Layout) -> dict[str, Any]:
    """Litestream's configuration, as JSON (a YAML subset). Credentials stay in the
    environment (``LITESTREAM_ACCESS_KEY_ID``, ``LITESTREAM_SECRET_ACCESS_KEY``)."""
    replica_settings = config.replica
    if replica_settings is None:
        raise ValueError("the entrypoint needs the replica settings")
    parts = urlsplit(replica_settings.url)
    if parts.scheme == "s3":
        replica: dict[str, Any] = {
            "type": "s3",
            "bucket": parts.netloc,
            "path": parts.path.strip("/"),
            "region": replica_settings.region,
            "force-path-style": replica_settings.force_path_style,
        }
        if replica_settings.endpoint:
            replica["endpoint"] = replica_settings.endpoint
    else:
        replica = {"type": "file", "path": parts.path}
    replica["sync-interval"] = replica_settings.sync_interval
    return {
        "socket": {"enabled": True, "path": str(layout.litestream_socket), "permissions": 0o600},
        "logging": {"level": "info"},
        # Raised well above Litestream's 30 s default (design, "Application data"). The
        # entrypoint's own confirmed final sync runs first; this is Litestream's backstop.
        "shutdown-sync-timeout": f"{int(config.final_sync_timeout_s)}s",
        "dbs": [{"path": str(layout.db_path), "replica": replica}],
    }


def litestream_base_args(layout: Layout) -> list[str]:
    return ["-config", str(layout.litestream_config), "-no-expand-env"]


# ── Restore and recovery decision ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class RestoreOutcome:
    returncode: int | None
    timed_out: bool
    stderr_tail: str
    seconds: float


def redact(text: str, env: Mapping[str, str]) -> str:
    """Remove credential values from text before it is logged or reported."""
    for name in (
        "LITESTREAM_ACCESS_KEY_ID",
        "LITESTREAM_SECRET_ACCESS_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
    ):
        value = env.get(name)
        if value and len(value) >= 4:
            text = text.replace(value, "[redacted]")
    return text


def app_answers(port: int, timeout_s: float) -> bool:
    """Whether the app answers ``GET /health`` on the loopback interface with a 2xx."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout_s)
    try:
        conn.request("GET", "/health")
        response = conn.getresponse()
        response.read()
        return 200 <= response.status < 300
    except (OSError, http.client.HTTPException):
        return False
    finally:
        conn.close()


def _signal_group(proc: subprocess.Popen[Any], sig: int) -> None:
    """Signal a child started with ``start_new_session`` and everything it started."""
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, sig)


def _stop_process(proc: subprocess.Popen[Any], grace_s: float) -> None:
    """SIGTERM the child's process group, then SIGKILL it after ``grace_s``."""
    if proc.poll() is None:
        _signal_group(proc, signal.SIGTERM)
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(timeout=grace_s)
    # Whatever the leader did, nothing it started may outlive it.
    _signal_group(proc, signal.SIGKILL)
    proc.wait()


def remove_local_database_state(layout: Layout) -> None:
    """Remove leftovers that must never meet a freshly restored database."""
    db = layout.db_path
    for suffix in ("-wal", "-shm", ".tmp", ".tmp-wal", ".tmp-shm"):
        with contextlib.suppress(FileNotFoundError):
            (db.parent / f"{db.name}{suffix}").unlink()
    shutil.rmtree(db.parent / f".{db.name}-litestream", ignore_errors=True)


def restore(
    layout: Layout,
    env: Mapping[str, str],
    deadline_s: float,
    should_stop: Callable[[], bool] = lambda: False,
) -> RestoreOutcome:
    """``litestream restore -if-replica-exists`` under a deadline.

    With ``-if-replica-exists`` an empty replica exits 0 without creating the database, and a
    restore writes a temporary file and renames it into place, so the database file exists
    afterwards only if a backup was restored completely. A stop signal ends it early: a restore
    only reads the replica, so stopping it loses nothing.
    """
    command = [
        str(layout.litestream_bin),
        "restore",
        *litestream_base_args(layout),
        "-if-replica-exists",
        "-o",
        str(layout.db_path),
        str(layout.db_path),
    ]
    started = time.monotonic()
    deadline = started + deadline_s
    proc = subprocess.Popen(
        command,
        env=image_config.litestream_environment(env),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    timed_out = False
    output = ""
    while True:
        try:
            output, _ = proc.communicate(timeout=max(0.0, min(0.5, deadline - time.monotonic())))
            break
        except subprocess.TimeoutExpired:
            if time.monotonic() < deadline and not should_stop():
                continue
        timed_out = True
        _stop_process(proc, 5.0)
        try:
            output, _ = proc.communicate(timeout=5.0)
        except subprocess.TimeoutExpired:
            output = ""
        break
    lines = [line for line in (output or "").splitlines() if line.strip()]
    tail = redact(" | ".join(lines[-3:]), env)[-400:]
    return RestoreOutcome(
        None if timed_out else proc.returncode, timed_out, tail, time.monotonic() - started
    )


def prepare_database(
    config: image_config.ServerImageConfig,
    layout: Layout,
    env: Mapping[str, str],
    should_stop: Callable[[], bool] = lambda: False,
) -> Ready | Recovery:
    """Restore if needed, then decide: start, or recovery mode.

    Omnigent never starts without an owner or the means to create one: a database with no
    owner and no bootstrap credentials would offer first-visitor setup.
    """
    decision = _prepare_database(config, layout, env, should_stop)
    if isinstance(decision, Ready) and not decision.owner and not config.bootstrap_credentials:
        return Recovery(
            "owner_missing",
            "the database has no owner and no bootstrap credentials are set "
            "(OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME and _PASSWORD)",
            transient=False,
        )
    return decision


def _prepare_database(
    config: image_config.ServerImageConfig,
    layout: Layout,
    env: Mapping[str, str],
    should_stop: Callable[[], bool],
) -> Ready | Recovery:
    initialized = config.installation_initialized
    db = layout.db_path
    db.parent.mkdir(parents=True, exist_ok=True)
    if db.exists():
        check = check_database(db)
        if not check.intact:
            return Recovery("database_corrupt", check.detail, transient=False)
        if initialized and not check.initialized:
            return Recovery("not_initialized", check.detail, transient=False)
        return Ready("local", check.detail, owner=check.initialized)

    remove_local_database_state(layout)
    outcome = restore(layout, env, config.restore_deadline_s, should_stop)
    log(
        "restore",
        returncode=outcome.returncode,
        timed_out=outcome.timed_out,
        seconds=round(outcome.seconds, 2),
        restored=db.exists(),
        output=outcome.stderr_tail,
    )
    if outcome.timed_out:
        remove_local_database_state(layout)
        with contextlib.suppress(FileNotFoundError):
            db.unlink()
        return Recovery(
            "restore_deadline",
            f"the restore did not finish within {config.restore_deadline_s:g} s",
            transient=True,
        )
    if outcome.returncode != 0:
        remove_local_database_state(layout)
        with contextlib.suppress(FileNotFoundError):
            db.unlink()
        return Recovery("restore_failed", outcome.stderr_tail or "restore failed", transient=True)
    if not db.exists():
        if initialized:
            # Litestream would start a new, empty installation here (S4).
            return Recovery(
                "replica_empty",
                "the installation is initialized but its replica holds no backup",
                transient=False,
            )
        return Ready("fresh", "no backup in the replica; a new installation starts")
    check = check_database(db)
    if not check.intact:
        return Recovery("database_corrupt", check.detail, transient=False)
    if initialized and not check.initialized:
        # A valid replica from before the owner's creation: never public setup.
        return Recovery("not_initialized", check.detail, transient=False)
    return Ready("restored", check.detail, owner=check.initialized)


# ── Settings files ────────────────────────────────────────────────────────────────────


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_settings_files(config: image_config.ServerImageConfig, layout: Layout) -> None:
    """Write the deployment-managed files Omnigent reads, from the environment's values."""
    header = "# Managed by the server image from the deployment's settings; edits are lost.\n"
    data_dir = layout.omnigent_data_dir
    data_dir.mkdir(parents=True, exist_ok=True)
    layout.artifact_dir.mkdir(parents=True, exist_ok=True)
    _write_atomic(data_dir / "admins", header + "".join(f"{a}\n" for a in config.admins))
    _write_atomic(
        data_dir / "allowed_domains", header + "".join(f"{d}\n" for d in config.allowed_domains)
    )
    _write_atomic(layout.config_path, header + "{}\n")
    for name in SHARING_OVERRIDE_FILES:
        with contextlib.suppress(FileNotFoundError):
            (data_dir / name).unlink()


# ── Supervision ───────────────────────────────────────────────────────────────────────


class Supervisor:
    """Runs Litestream and the app, and stops them in order."""

    def __init__(
        self,
        config: image_config.ServerImageConfig,
        layout: Layout,
        env: Mapping[str, str],
        board: StatusBoard,
    ) -> None:
        self.config = config
        self.layout = layout
        self.env = env
        self.board = board
        self._event = threading.Event()
        self._stop_requested = False
        self._known: set[int] = set()

    # signals ----------------------------------------------------------------------------
    def install_signal_handlers(self) -> None:
        def on_stop(signum: int, _frame: Any) -> None:
            if not self._stop_requested:
                log("signal", signal=signal.Signals(signum).name)
            self._stop_requested = True
            self._event.set()

        def on_child(_signum: int, _frame: Any) -> None:
            self._event.set()

        signal.signal(signal.SIGTERM, on_stop)
        signal.signal(signal.SIGINT, on_stop)
        signal.signal(signal.SIGCHLD, on_child)

    @property
    def stop_requested(self) -> bool:
        return self._stop_requested

    def wait_for_stop(self, timeout_s: float | None = None) -> bool:
        """Wait for SIGTERM or SIGINT; ``True`` once one arrived."""
        deadline = None if timeout_s is None else time.monotonic() + timeout_s
        while not self._stop_requested:
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return False
            self._event.wait(1.0 if remaining is None else min(1.0, remaining))
            self._event.clear()
            self.reap_orphans()
        return True

    def reap_orphans(self) -> None:
        """Reap exited processes that are not ours, without stealing our children's status.

        As PID 1, the entrypoint inherits any process whose parent exits.
        """
        while True:
            try:
                info = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            except ChildProcessError:
                return
            if info is None or info.si_pid in self._known:
                return
            with contextlib.suppress(ChildProcessError):
                os.waitpid(info.si_pid, 0)

    def _spawn(self, command: Sequence[str], env: Mapping[str, str]) -> subprocess.Popen[bytes]:
        # A new session each: a signal to the entrypoint's process group never reaches them,
        # so only the entrypoint decides the order in which they stop.
        proc = subprocess.Popen(list(command), env=dict(env), start_new_session=True)
        self._known.add(proc.pid)
        return proc

    # run ---------------------------------------------------------------------------------
    def run(self) -> int:
        layout = self.layout
        litestream = self._spawn(
            [str(layout.litestream_bin), "replicate", *litestream_base_args(layout)],
            image_config.litestream_environment(self.env),
        )
        if not self._wait_litestream_ready(litestream):
            _stop_process(litestream, 10.0)
            self.board.update(phase="stopped")
            if self._stop_requested:
                return EXIT_OK  # stopped before anything was written
            log("litestream.not_ready", returncode=litestream.returncode)
            return EXIT_LITESTREAM_FAILED
        self.board.litestream = lambda: BlockingClient(
            str(layout.litestream_socket), str(layout.db_path), timeout_s=2.0
        )

        app_env = image_config.app_environment(self.config, self.env)
        app_env["CFO_DB_PATH"] = str(layout.db_path)
        app_env["CFO_LITESTREAM_SOCKET"] = str(layout.litestream_socket)
        app_env.update(dict(layout.app_env_overrides))
        # Until the app answers its health check it is initializing: imports, migrations,
        # create_app and the owner check, which take minutes on a large database (AIR2-010).
        self.board.update(phase="initializing", app={"startedAt": now_iso(), "readyAt": None})
        app = self._spawn(layout.app_command, app_env)
        log("started", litestream_pid=litestream.pid, app_pid=app.pid)

        why = self._wait_for_exit(litestream, app)
        return self._shutdown(why, litestream, app)

    def _wait_litestream_ready(self, litestream: subprocess.Popen[bytes]) -> bool:
        deadline = time.monotonic() + self.config.litestream_ready_timeout_s
        with BlockingClient(str(self.layout.litestream_socket), str(self.layout.db_path)) as client:
            while time.monotonic() < deadline:
                if litestream.poll() is not None or self._stop_requested:
                    return False
                try:
                    paths = {d.get("path") for d in client.databases(timeout_s=1.0)}
                except LitestreamError:
                    paths = set()
                if str(self.layout.db_path) in paths:
                    return True
                self._event.wait(0.1)
                self._event.clear()
        return False

    def _wait_for_exit(
        self, litestream: subprocess.Popen[bytes], app: subprocess.Popen[bytes]
    ) -> str:
        spawned = time.monotonic()
        ready = False
        while True:
            self._event.wait(1.0)
            self._event.clear()
            self.reap_orphans()
            if self._stop_requested:
                return "signal"
            if app.poll() is not None:
                log("app.exited", returncode=app.returncode)
                return "app_exited"
            if litestream.poll() is not None:
                log("litestream.exited", returncode=litestream.returncode)
                return "litestream_exited"
            if not ready and app_answers(self.layout.app_port, self.layout.app_probe_timeout_s):
                # The app serves: from here a silent app is a hung one, not a starting one.
                ready = True
                app_state = dict(self.board.get("app") or {})
                app_state["readyAt"] = now_iso()
                self.board.update(phase="running", app=app_state)
                log("app.ready", seconds=round(time.monotonic() - spawned, 2))

    def _shutdown(
        self, why: str, litestream: subprocess.Popen[bytes], app: subprocess.Popen[bytes]
    ) -> int:
        self.board.update(phase="stopping")
        if app.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                app.send_signal(signal.SIGTERM)
            try:
                app.wait(timeout=self.layout.app_stop_timeout_s)
            except subprocess.TimeoutExpired:
                log("app.kill", after_s=self.layout.app_stop_timeout_s)
        # Nothing the app started may keep writing after it.
        _stop_process(app, 0.0)
        # Nothing writes the database any more. Confirm the replica covers every commit.
        final: dict[str, Any]
        if litestream.poll() is None:
            with BlockingClient(str(self.layout.litestream_socket), str(self.layout.db_path)) as c:
                outcome = c.wait_replicated(self.config.final_sync_timeout_s)
            final = {"confirmed": outcome.ok, **outcome.log_fields()}
            # One SIGTERM only: a second one would interrupt Litestream's own final sync.
            with contextlib.suppress(ProcessLookupError):
                litestream.send_signal(signal.SIGTERM)
            try:
                litestream.wait(timeout=self.config.final_sync_timeout_s + 30.0)
            except subprocess.TimeoutExpired:
                log("litestream.kill", after_s=self.config.final_sync_timeout_s + 30.0)
            _stop_process(litestream, 0.0)
        else:
            final = {"confirmed": False, "reason": "litestream exited before the final sync"}
        self.board.litestream = None
        self.board.update(phase="stopped", finalSync=final)
        log(
            "final_sync",
            why=why,
            app_returncode=app.returncode,
            litestream_returncode=litestream.returncode,
            **final,
        )
        if not final["confirmed"]:
            return EXIT_FINAL_SYNC_UNCONFIRMED
        if why == "litestream_exited":
            return EXIT_LITESTREAM_FAILED
        if why == "app_exited":
            return app.returncode or EXIT_APP_EXITED
        return EXIT_OK


# ── Main ──────────────────────────────────────────────────────────────────────────────


def run(config: image_config.ServerImageConfig, layout: Layout, env: Mapping[str, str]) -> int:
    """Everything after configuration. Returns the process's exit code."""
    for warning in config.warnings:
        log("config.warning", message=warning)
    build = buildinfo.load(layout.build_info_path)
    board = StatusBoard(
        initialized_expected=config.installation_initialized,
        installation_id=config.installation_id,
        build=build,
    )
    log(
        "boot",
        boot_id=board.boot_id,
        installation_id=config.installation_id,
        omnigent_commit=None if build is None else build["omnigentCommit"],
        artifacts="local" if config.artifacts.uri is None else "s3",
        # Omnigent's GitHub linking (D22): on, or why not. Names only, never a value.
        github_linking="on" if config.github.enabled else f"off: {config.github.off_reason}",
    )
    supervisor = Supervisor(config, layout, env, board)
    supervisor.install_signal_handlers()
    status = start_control_server(board, layout.control_port, layout.bind_host)
    try:
        layout.run_dir.mkdir(parents=True, exist_ok=True)
        layout.db_path.parent.mkdir(parents=True, exist_ok=True)
        layout.litestream_config.write_text(json.dumps(litestream_config(config, layout), indent=2))

        while True:
            board.update(phase="restoring")
            decision = prepare_database(config, layout, env, lambda: supervisor.stop_requested)
            if supervisor.stop_requested:
                board.update(phase="stopped")
                return EXIT_OK
            if isinstance(decision, Ready):
                log("database.ready", source=decision.source, detail=decision.detail)
                break
            log(
                "recovery",
                reason=decision.reason,
                detail=decision.detail,
                transient=decision.transient,
            )
            board.update(
                phase="recovery",
                recovery={
                    "reason": decision.reason,
                    "detail": decision.detail,
                    "transient": decision.transient,
                    "since": time.time(),
                },
            )
            responder = start_recovery_responder(decision.reason, layout.app_port, layout.bind_host)
            try:
                stopped = supervisor.wait_for_stop(
                    layout.recovery_retry_s if decision.transient else None
                )
            finally:
                responder.shutdown()
                responder.server_close()
            if stopped:
                board.update(phase="stopped")
                return EXIT_OK
            board.update(recovery=None)

        if supervisor.stop_requested:
            return EXIT_OK
        write_settings_files(config, layout)
        return supervisor.run()
    finally:
        status.shutdown()
        status.server_close()


def main() -> int:
    try:
        config = image_config.load()
    except image_config.ConfigError as exc:
        log("config.error", message=str(exc))
        return EXIT_CONFIG
    return run(config, Layout.production(), os.environ)


if __name__ == "__main__":
    sys.exit(main())
