"""The entrypoint: restore, recovery mode, settings files, supervision and the final sync.

These run the real Litestream 0.5.17 binary with a file replica, and a stand-in app
(``fake_app.py``). The image tests (``integration/``) repeat the decisive cases with the real
Omnigent app, an S3 replica and a blackholed link.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from conftest import HERE, IMAGE_DIR, base_env

sys.path.insert(0, str(IMAGE_DIR))

from cfo_server import config as image_config  # noqa: E402
from cfo_server import entrypoint  # noqa: E402
from cfo_server.entrypoint import Layout, Ready, Recovery, prepare_database  # noqa: E402
from cfo_server.litestream import BlockingClient  # noqa: E402

LITESTREAM = Path(os.environ.get("CFO_TEST_LITESTREAM_BIN", "/usr/local/bin/litestream"))
requires_litestream = pytest.mark.skipif(
    not LITESTREAM.exists(), reason="needs the pinned Litestream binary (CFO_TEST_LITESTREAM_BIN)"
)
SYNTHETIC_KEY = "cfo-test-replica-secret-0001"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Rig:
    """Paths, environment and processes for one entrypoint under test."""

    def __init__(self, root: Path, *, litestream_bin: Path = LITESTREAM) -> None:
        self.root = root
        self.db = root / "data" / "omnigent.db"
        self.replica = root / "replica"
        self.run_dir = root / "run"
        self.marker = root / "app-start.json"
        self.app_port = free_port()
        self.status_port = free_port()
        self.litestream_bin = litestream_bin
        self.proc: subprocess.Popen[str] | None = None
        self.output = ""
        self.log_path = root / "entrypoint.log"

    def layout(self, **overrides: Any) -> Layout:
        return Layout(
            db_path=self.db,
            omnigent_data_dir=self.root / "data" / "omnigent",
            config_path=self.root / "data" / "omnigent" / "config.yaml",
            artifact_dir=self.root / "data" / "artifacts",
            run_dir=self.run_dir,
            litestream_socket=self.run_dir / "ls.sock",
            litestream_config=self.run_dir / "litestream.yml",
            litestream_bin=self.litestream_bin,
            app_command=(sys.executable, str(HERE / "fake_app.py")),
            app_port=self.app_port,
            control_port=self.status_port,
            bind_host="127.0.0.1",
            **overrides,
        )

    def env(self, *, initialized: str = "false", **extra: str) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not k.startswith(("CFO_", "OMNIGENT_"))}
        env.update(base_env(self.root, initialized=initialized))
        env.update(
            {
                "CFO_FINAL_SYNC_TIMEOUT_S": "20",
                "CFO_RESTORE_DEADLINE_S": "30",
                "LITESTREAM_SECRET_ACCESS_KEY": SYNTHETIC_KEY,
            }
        )
        env.update(extra)
        return env

    def config(self, env: dict[str, str]) -> image_config.ServerImageConfig:
        return image_config.load(env)

    # replica seeding ----------------------------------------------------------------------
    def seed(self, *, with_owner: bool, rows: int = 3) -> None:
        """Replicate a database into the replica, then lose the local copy."""
        env = self.env()
        layout = self.layout()
        config = self.config(env)
        self.run_dir.mkdir(parents=True, exist_ok=True)
        layout.litestream_config.write_text(
            json.dumps(entrypoint.litestream_config(config, layout))
        )
        self.db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE users (workspace_id INTEGER, id TEXT, is_admin INTEGER, "
            "deleted_at INTEGER, password_hash TEXT, last_login_at INTEGER)"
        )
        conn.execute("INSERT INTO users VALUES (0, 'local', 0, NULL, NULL, NULL)")
        if with_owner:
            conn.execute("INSERT INTO users VALUES (0, 'owner', 1, NULL, 'synthetic-hash', NULL)")
        conn.execute("CREATE TABLE t (value TEXT)")
        for i in range(rows):
            conn.execute("INSERT INTO t VALUES (?)", (f"seed-{i}",))
        proc = subprocess.Popen(
            [str(self.litestream_bin), "replicate", *entrypoint.litestream_base_args(layout)],
            env=image_config.litestream_environment(env),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 20
            while not layout.litestream_socket.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            with BlockingClient(str(layout.litestream_socket), str(self.db)) as client:
                outcome = client.wait_replicated(15)
            assert outcome.ok, outcome
        finally:
            proc.terminate()
            proc.wait(timeout=30)
            conn.close()
        entrypoint.remove_local_database_state(layout)
        self.db.unlink()

    # processes ----------------------------------------------------------------------------
    def start(self, env: dict[str, str], **layout_extra: Any) -> None:
        spec = {
            "db_path": str(self.db),
            "omnigent_data_dir": str(self.root / "data" / "omnigent"),
            "config_path": str(self.root / "data" / "omnigent" / "config.yaml"),
            "artifact_dir": str(self.root / "data" / "artifacts"),
            "run_dir": str(self.run_dir),
            "litestream_socket": str(self.run_dir / "ls.sock"),
            "litestream_config": str(self.run_dir / "litestream.yml"),
            "litestream_bin": str(self.litestream_bin),
            "app_command": [sys.executable, str(HERE / "fake_app.py")],
            "app_port": self.app_port,
            "control_port": self.status_port,
            "app_env_overrides": {
                "PORT": str(self.app_port),
                "FAKE_APP_MARKER": str(self.marker),
                **layout_extra.pop("app_env", {}),
            },
            **layout_extra,
        }
        spec_path = self.root / "layout.json"
        spec_path.write_text(json.dumps(spec))
        self.log_path = self.root / "entrypoint.log"
        with self.log_path.open("w") as log_file:
            self.proc = subprocess.Popen(
                [sys.executable, str(HERE / "run_entrypoint.py"), str(spec_path)],
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                text=True,
            )

    def status(self) -> dict[str, Any]:
        return httpx.get(f"http://127.0.0.1:{self.status_port}/status", timeout=5).json()

    def wait_phase(self, phase: str, timeout: float = 30) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        last: dict[str, Any] = {}
        while time.monotonic() < deadline:
            assert self.proc is not None
            if self.proc.poll() is not None:
                raise AssertionError(f"entrypoint exited {self.proc.returncode}: {self.finish()}")
            try:
                last = self.status()
            except httpx.HTTPError:
                last = {}
            if last.get("phase") == phase:
                return last
            time.sleep(0.1)
        raise AssertionError(f"phase {phase!r} not reached; last status {last}")

    def wait_app(self, timeout: float = 30) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if (
                    httpx.get(f"http://127.0.0.1:{self.app_port}/health", timeout=2).status_code
                    == 200
                ):
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
        raise AssertionError("app never answered")

    def write(self, value: str) -> None:
        response = httpx.post(f"http://127.0.0.1:{self.app_port}/write?value={value}", timeout=5)
        assert response.status_code == 200

    def stop(self, sig: int = signal.SIGTERM, timeout: float = 120) -> int:
        assert self.proc is not None
        self.proc.send_signal(sig)
        return self.wait(timeout)

    def wait(self, timeout: float = 120) -> int:
        assert self.proc is not None
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            raise
        self.finish()
        return self.proc.returncode

    def finish(self) -> str:
        self.output = self.log_path.read_text() if self.log_path.exists() else ""
        return self.output

    def events(self, name: str) -> list[dict[str, Any]]:
        found = []
        for line in self.output.splitlines():
            if line.startswith("{") and f'"cfo.{name}"' in line:
                found.append(json.loads(line))
        return found

    def kill_all(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()


@pytest.fixture
def rig(tmp_path: Path):  # noqa: ANN201
    r = Rig(tmp_path)
    yield r
    r.kill_all()


def fake_litestream_bin(root: Path, script: str) -> Path:
    path = root / "fake-litestream"
    path.write_text("#!/bin/sh\n" + script + "\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def table_values(db: Path) -> list[str]:
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        return [row[0] for row in conn.execute("SELECT value FROM t")]


# ── Restore and the recovery decision ─────────────────────────────────────────────────


@requires_litestream
def test_new_installation_with_an_empty_replica_starts_fresh(rig: Rig) -> None:
    env = rig.env(initialized="false")
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert isinstance(decision, Ready) and decision.source == "fresh"
    assert not rig.db.exists()


@requires_litestream
def test_initialized_installation_with_an_empty_replica_is_recovery(rig: Rig) -> None:
    env = rig.env(initialized="true")
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert decision == Recovery(
        "replica_empty",
        "the installation is initialized but its replica holds no backup",
        transient=False,
    )
    assert not rig.db.exists()


@requires_litestream
def test_initialized_installation_restores_its_owner(rig: Rig) -> None:
    rig.seed(with_owner=True)
    env = rig.env(initialized="true")
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert isinstance(decision, Ready) and decision.source == "restored"
    assert table_values(rig.db) == ["seed-0", "seed-1", "seed-2"]


@requires_litestream
def test_replica_from_before_the_owner_is_recovery_never_setup(rig: Rig) -> None:
    rig.seed(with_owner=False)
    env = rig.env(initialized="true")
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert isinstance(decision, Recovery) and decision.reason == "not_initialized"
    assert not decision.transient


@requires_litestream
def test_replica_without_owner_is_fine_before_initialization(rig: Rig) -> None:
    rig.seed(with_owner=False)
    env = rig.env(initialized="false")
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert isinstance(decision, Ready) and decision.source == "restored"


def _without_bootstrap(env: dict[str, str]) -> dict[str, str]:
    env.pop("OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME")
    env.pop("OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD")
    return env


@requires_litestream
def test_new_installation_without_bootstrap_credentials_is_recovery_never_setup(
    rig: Rig,
) -> None:
    env = _without_bootstrap(rig.env(initialized="false"))
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert isinstance(decision, Recovery) and decision.reason == "owner_missing"
    assert not decision.transient


@requires_litestream
def test_restored_owner_needs_no_bootstrap_credentials(rig: Rig) -> None:
    rig.seed(with_owner=True)
    env = _without_bootstrap(rig.env(initialized="true"))
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert isinstance(decision, Ready) and decision.owner


@requires_litestream
def test_restored_database_without_owner_or_credentials_is_recovery(rig: Rig) -> None:
    rig.seed(with_owner=False)
    env = _without_bootstrap(rig.env(initialized="false"))
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert isinstance(decision, Recovery) and decision.reason == "owner_missing"


def test_corrupt_local_database_is_recovery(rig: Rig) -> None:
    rig.db.parent.mkdir(parents=True)
    rig.db.write_bytes(b"SQLite format 3\x00" + os.urandom(8192))
    env = rig.env(initialized="true")
    decision = prepare_database(rig.config(env), rig.layout(), env)
    assert isinstance(decision, Recovery) and decision.reason == "database_corrupt"


def test_local_database_missing_its_owner_is_recovery(rig: Rig) -> None:
    rig.db.parent.mkdir(parents=True)
    with sqlite3.connect(rig.db) as conn:
        conn.execute("CREATE TABLE users (workspace_id, id, deleted_at, password_hash)")
        conn.execute("INSERT INTO users VALUES (0, 'owner', 1, 'deleted-owner-hash')")
    env = rig.env(initialized="true")
    decision = prepare_database(rig.config(env), rig.layout(), env)
    assert isinstance(decision, Recovery) and decision.reason == "not_initialized"


def test_restore_that_misses_its_deadline_is_transient_recovery(rig: Rig) -> None:
    binary = fake_litestream_bin(rig.root, "sleep 60")
    env = rig.env(initialized="true", CFO_RESTORE_DEADLINE_S="1.5")
    layout = Rig(rig.root, litestream_bin=binary).layout()
    started = time.monotonic()
    decision = prepare_database(rig.config(env), layout, env)
    elapsed = time.monotonic() - started
    assert isinstance(decision, Recovery) and decision.reason == "restore_deadline"
    assert decision.transient
    assert elapsed < 10
    assert not rig.db.exists()


def test_failed_restore_is_transient_recovery_and_its_output_is_redacted(rig: Rig) -> None:
    binary = fake_litestream_bin(
        rig.root, f'echo "restore failed: access denied for {SYNTHETIC_KEY}" >&2; exit 1'
    )
    env = rig.env(initialized="false")
    layout = Rig(rig.root, litestream_bin=binary).layout()
    decision = prepare_database(rig.config(env), layout, env)
    assert isinstance(decision, Recovery) and decision.reason == "restore_failed"
    assert decision.transient
    assert SYNTHETIC_KEY not in decision.detail
    assert "[redacted]" in decision.detail


def test_restore_removes_stale_local_state_first(rig: Rig) -> None:
    rig.db.parent.mkdir(parents=True)
    stale = [rig.db.parent / "omnigent.db-wal", rig.db.parent / "omnigent.db.tmp"]
    for path in stale:
        path.write_bytes(b"stale")
    meta = rig.db.parent / ".omnigent.db-litestream"
    meta.mkdir()
    binary = fake_litestream_bin(rig.root, "exit 0")
    env = rig.env(initialized="false")
    decision = prepare_database(rig.config(env), Rig(rig.root, litestream_bin=binary).layout(), env)
    assert isinstance(decision, Ready)
    assert not any(path.exists() for path in stale)
    assert not meta.exists()


def _with_config(rig: Rig, env: dict[str, str]) -> Layout:
    layout = rig.layout()
    layout.run_dir.mkdir(parents=True, exist_ok=True)
    layout.litestream_config.write_text(
        json.dumps(entrypoint.litestream_config(rig.config(env), layout))
    )
    return layout


# ── Settings files ────────────────────────────────────────────────────────────────────


def test_settings_files_are_written_from_the_environment(rig: Rig) -> None:
    layout = rig.layout()
    data = layout.omnigent_data_dir
    data.mkdir(parents=True)
    for name in entrypoint.SHARING_OVERRIDE_FILES:
        (data / name).write_text("on")
    (data / "admins").write_text("someone-else\n")
    env = rig.env(CFO_OMNIGENT_ADMINS="owner, Second ", CFO_OMNIGENT_ALLOWED_DOMAINS="example.test")
    entrypoint.write_settings_files(rig.config(env), layout)
    admins = [
        line for line in (data / "admins").read_text().splitlines() if not line.startswith("#")
    ]
    assert admins == ["owner", "second"]
    domains = (data / "allowed_domains").read_text().splitlines()
    assert domains[-1] == "example.test"
    assert not any((data / name).exists() for name in entrypoint.SHARING_OVERRIDE_FILES)
    import yaml

    assert yaml.safe_load(layout.config_path.read_text()) == {}


def test_settings_default_to_empty_lists(rig: Rig) -> None:
    layout = rig.layout()
    entrypoint.write_settings_files(rig.config(rig.env()), layout)
    for name in ("admins", "allowed_domains"):
        lines = (layout.omnigent_data_dir / name).read_text().splitlines()
        assert all(line.startswith("#") for line in lines)


# ── The whole process ─────────────────────────────────────────────────────────────────


@requires_litestream
def test_start_order_then_clean_stop_confirms_the_final_sync(rig: Rig) -> None:
    rig.start(rig.env())
    status = rig.wait_phase("running")
    assert status["recovery"] is None
    rig.wait_app()
    start = json.loads(rig.marker.read_text())
    assert start["litestream_ready_at_start"] is True  # Litestream first, then the app
    env_seen = start["env"]
    assert env_seen["OMNIGENT_FEATURES"] == ""
    assert env_seen["OMNIGENT_AUTH_PROVIDER"] == "accounts"
    assert env_seen["LITESTREAM_SECRET_ACCESS_KEY"] is None  # replica credentials stay out
    assert env_seen["OMNIGENT_WS_ALLOWED_ORIGINS"] == "http://testserver"
    for i in range(5):
        rig.write(f"acked-{i}")
    position = rig.status()["replication"]
    assert position["txid"] >= 1
    assert rig.stop() == entrypoint.EXIT_OK
    final = rig.events("final_sync")
    assert final and final[-1]["confirmed"] is True and final[-1]["why"] == "signal"
    # Every acknowledged write is in the replica: restore it elsewhere and look.
    entrypoint.remove_local_database_state(rig.layout())
    rig.db.unlink()
    env = rig.env(initialized="false")
    decision = prepare_database(rig.config(env), _with_config(rig, env), env)
    assert isinstance(decision, Ready) and decision.source == "restored"
    assert table_values(rig.db) == [f"acked-{i}" for i in range(5)]


@requires_litestream
def test_status_and_boot_line_report_the_image_build(rig: Rig) -> None:
    record = {
        "omnigentRepo": "https://example.test/fork.git",
        "omnigentCommit": "35ac1ebd2405264de7c0456084f45c4af1e657ca",
        "litestream": "0.5.17",
    }
    (rig.root / "build.json").write_text(json.dumps(record))
    rig.start(rig.env(), build_info_path=str(rig.root / "build.json"))
    assert rig.wait_phase("running")["build"] == record
    assert rig.stop() == entrypoint.EXIT_OK
    (boot,) = rig.events("boot")
    assert boot["omnigent_commit"] == record["omnigentCommit"]


@requires_litestream
def test_status_says_initializing_until_the_app_answers_its_health_check(rig: Rig) -> None:
    rig.start(rig.env(), app_env={"FAKE_APP_START_DELAY_S": "4"})
    status = rig.wait_phase("initializing")
    assert status["app"]["startedAt"] and status["app"]["readyAt"] is None
    # Litestream already runs: the position answers while the app initializes.
    assert _position(rig).status_code == 200
    with pytest.raises(httpx.HTTPError):
        httpx.get(f"http://127.0.0.1:{rig.app_port}/health", timeout=2)
    status = rig.wait_phase("running")
    assert status["app"]["readyAt"] >= status["app"]["startedAt"]
    rig.wait_app()
    assert rig.stop() == entrypoint.EXIT_OK
    (ready,) = rig.events("app.ready")
    assert ready["seconds"] >= 4


@requires_litestream
def test_hung_initialization_stays_initializing_and_stops_cleanly(rig: Rig) -> None:
    rig.start(rig.env(), app_env={"FAKE_APP_HANG": "1"})
    rig.wait_phase("initializing")
    time.sleep(3)
    assert rig.status()["phase"] == "initializing"  # never "running": the watchdog's budget ends it
    assert rig.stop() == entrypoint.EXIT_OK
    final = rig.events("final_sync")[-1]
    assert final["why"] == "signal" and final["confirmed"] is True
    assert not rig.events("app.ready")


@requires_litestream
def test_unconfirmed_final_sync_is_reported_by_exit_code_and_log(rig: Rig) -> None:
    rig.start(rig.env(CFO_FINAL_SYNC_TIMEOUT_S="2"))
    rig.wait_phase("running")
    rig.wait_app()
    rig.write("before-block")
    _wait_replicated(rig)
    # Block the replica: a regular file where its directory was, so every upload fails
    # (a read-only directory, as WP3.9's lab used, does not stop root inside the image).
    moved = rig.replica.with_name("replica.moved")
    rig.replica.rename(moved)
    rig.replica.write_text("blocked")
    try:
        rig.write("during-block")
        code = rig.stop()
    finally:
        rig.replica.unlink()
        moved.rename(rig.replica)
    assert code == entrypoint.EXIT_FINAL_SYNC_UNCONFIRMED
    final = rig.events("final_sync")[-1]
    assert final["confirmed"] is False
    assert final["reason"] == "timeout"


@requires_litestream
def test_litestream_dying_stops_the_app(rig: Rig) -> None:
    rig.start(rig.env())
    rig.wait_phase("running")
    rig.wait_app()
    started = json.loads(rig.marker.read_text())
    assert started
    pids = [e for e in rig_events_live(rig) if e.get("event") == "cfo.started"]
    litestream_pid = pids[-1]["litestream_pid"]
    app_pid = pids[-1]["app_pid"]
    os.kill(litestream_pid, signal.SIGKILL)
    code = rig.wait(60)
    assert code == entrypoint.EXIT_FINAL_SYNC_UNCONFIRMED
    with pytest.raises(ProcessLookupError):
        os.kill(app_pid, 0)
    assert rig.events("final_sync")[-1]["why"] == "litestream_exited"


@requires_litestream
def test_app_exiting_on_its_own_stops_after_a_confirmed_final_sync(rig: Rig) -> None:
    rig.start(rig.env(), app_env={"FAKE_APP_EXIT_CODE": "3"})
    code = rig.wait(60)
    assert code == 3
    final = rig.events("final_sync")[-1]
    assert final["why"] == "app_exited" and final["confirmed"] is True


@requires_litestream
def test_recovery_mode_serves_503_and_never_starts_replication(rig: Rig) -> None:
    rig.start(rig.env(initialized="true"))
    status = rig.wait_phase("recovery")
    assert status["recovery"]["reason"] == "replica_empty"
    assert status["replication"] is None
    for method in ("GET", "POST", "PUT"):
        for path in ("/", "/auth/setup", "/v1/info", "/health"):
            response = httpx.request(method, f"http://127.0.0.1:{rig.app_port}{path}", timeout=5)
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "recovery_mode"
    assert not rig.marker.exists()  # the app never started
    assert not (rig.run_dir / "ls.sock").exists()  # neither did replication
    assert not any(rig.replica.rglob("*.ltx"))
    assert rig.stop() == entrypoint.EXIT_OK


@requires_litestream
def test_transient_recovery_retries_the_restore(rig: Rig) -> None:
    gate = rig.root / "allow-restore"
    real = LITESTREAM
    binary = fake_litestream_bin(
        rig.root,
        f'if [ "$1" = restore ] && [ ! -e {gate} ]; then echo unreachable >&2; exit 1; fi\n'
        f'exec {real} "$@"',
    )
    rig.litestream_bin = binary
    rig.start(rig.env(), recovery_retry_s=1.0)
    status = rig.wait_phase("recovery")
    assert status["recovery"]["reason"] == "restore_failed"
    assert status["recovery"]["transient"] is True
    gate.write_text("ok")
    rig.wait_phase("running", timeout=30)
    assert rig.stop() == entrypoint.EXIT_OK


def test_bad_configuration_exits_78_before_starting_anything(rig: Rig) -> None:
    env = rig.env(OMNIGENT_SHARING_MODE="everyone")
    rig.start(env)
    assert rig.wait(30) == entrypoint.EXIT_CONFIG
    error = rig.events("config.error")
    assert error and "OMNIGENT_SHARING_MODE" in error[-1]["message"]
    assert not rig.db.exists()


def rig_events_live(rig: Rig) -> list[dict[str, Any]]:
    """Events printed so far by a running entrypoint."""
    rig.finish()
    return [json.loads(line) for line in rig.output.splitlines() if line.startswith('{"')]


@requires_litestream
def test_stop_signal_during_a_hanging_restore_exits_promptly(rig: Rig) -> None:
    rig.litestream_bin = fake_litestream_bin(rig.root, "sleep 120")
    rig.start(rig.env(initialized="true", CFO_RESTORE_DEADLINE_S="100"))
    rig.wait_phase("restoring")
    started = time.monotonic()
    assert rig.stop(timeout=30) == entrypoint.EXIT_OK
    assert time.monotonic() - started < 15


# ── The replication position (contract ReplicationPosition, port 8001) ───────────────


def _position_schema() -> dict[str, Any]:
    from conftest import REPO_ROOT

    return json.loads((REPO_ROOT / "contracts/schema/ReplicationPosition.schema.json").read_text())


def _error_schema() -> dict[str, Any]:
    from conftest import REPO_ROOT

    return json.loads((REPO_ROOT / "contracts/schema/ErrorBody.schema.json").read_text())


def _validate(payload: Any, schema: dict[str, Any]) -> None:
    from jsonschema import Draft202012Validator

    errors = [e.message for e in Draft202012Validator(schema).iter_errors(payload)]
    assert not errors, (payload, errors)


def _position(rig: Rig) -> httpx.Response:
    return httpx.get(f"http://127.0.0.1:{rig.status_port}/position", timeout=5)


@requires_litestream
def test_position_follows_the_contract_and_reaches_the_owners_commit(rig: Rig) -> None:
    rig.start(rig.env())
    status = rig.wait_phase("running")
    rig.wait_app()
    rig.write("owner-like")
    first = _position(rig)
    assert first.status_code == 200
    body = first.json()
    _validate(body, _position_schema())
    assert body["bootId"] == status["bootId"]
    # The watchdog's check: a later replicatedTxid of the same boot reaches this txid.
    target = body["txid"]
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        later = _position(rig).json()
        if later["replicatedTxid"] >= target:
            break
        time.sleep(0.2)
    assert later["bootId"] == body["bootId"] and later["replicatedTxid"] >= target
    assert rig.stop() == entrypoint.EXIT_OK


@requires_litestream
def test_position_is_503_while_litestream_cannot_say(rig: Rig) -> None:
    rig.start(rig.env(initialized="true"))
    status = rig.wait_phase("recovery")
    response = _position(rig)
    assert response.status_code == 503
    _validate(response.json(), _error_schema())
    assert status["bootId"] and len(status["bootId"]) == 32
    assert rig.stop() == entrypoint.EXIT_OK


@requires_litestream
def test_every_entrypoint_start_has_a_new_boot_id(rig: Rig) -> None:
    boots = []
    for _ in range(2):
        rig.start(rig.env())
        boots.append(rig.wait_phase("running")["bootId"])
        assert rig.stop() == entrypoint.EXIT_OK
    assert boots[0] != boots[1]


def _wait_replicated(rig: Rig, timeout: float = 20) -> None:
    """Wait until the replica covers every commit made so far (the watchdog's check)."""
    target = _position(rig).json()["txid"]
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _position(rig).json()["replicatedTxid"] >= target:
            return
        time.sleep(0.1)
    raise AssertionError("never replicated")
