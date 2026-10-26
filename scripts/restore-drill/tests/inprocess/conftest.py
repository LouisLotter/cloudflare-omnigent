"""In-process world for the launcher fence: Omnigent's app, real Litestream, a faulty "R2".

Runs inside the server image's test target (Omnigent, Litestream 0.5.17 and pytest are there),
on the durability suite's Docker network, started by ``tests/test_fence_suite.py``. The app is
the image's own ``build_app`` with :class:`cfo_drill.fence.RecordingStubLauncher` registered
through ``sandbox_config``; Litestream replicates the app's database to the S3 stand-in through
Toxiproxy, so the tests can blackhole replication while Omnigent runs its real routes and
lifecycle code. Every credential is synthetic or generated for the run.
"""

from __future__ import annotations

import dataclasses
import json
import os
import sqlite3
import subprocess
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest

OWNER = "owner"
OWNER_PASSWORD = "cfo-fence-owner-password-0001"  # synthetic
COOKIE_SECRET = "fedcba9876543210" * 4  # synthetic
BASE_URL = "http://testserver"
FENCE_TIMEOUT_S = 3.0
BARRIER_TIMEOUT_S = 3.0
ONLINE_TIMEOUT_S = 12.0

REQUIRED = ("CFO_FENCE_S3_USER", "CFO_FENCE_S3_PASSWORD", "CFO_FENCE_TOXI", "CFO_FENCE_ENDPOINT")


@dataclass
class World:
    client: Any
    db_path: Path
    run_dir: Path
    env: dict[str, str]
    fence: Any
    effects: Any
    gate: threading.Event
    toxi: str
    litestream: subprocess.Popen[bytes]
    workdir: Path
    _bearer: dict[str, str] = field(default_factory=dict)

    # Omnigent, as the web UI calls it --------------------------------------------------------
    def bearer(self) -> dict[str, str]:
        response = self.client.post(
            "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
        )
        assert response.status_code == 200, response.text
        self.client.cookies.clear()
        return {"Authorization": f"Bearer {response.json()['token']}"}

    # The "R2" link ---------------------------------------------------------------------------
    # Blocked means refused here: Toxiproxy closes the open connections and refuses new ones,
    # R2's "errors" failure. The Docker-level tests cover the other one, a blackhole (accepted,
    # never answered). After a refusal Litestream catches up only after its retry backoff
    # (about 11-14 s in a local probe; about 2 s after a blackhole), so tests wait for it.
    def block(self) -> None:
        httpx.post(
            f"{self.toxi}/proxies/r2", json={"enabled": False}, timeout=30
        ).raise_for_status()

    def unblock(self) -> None:
        httpx.post(f"{self.toxi}/proxies/r2", json={"enabled": True}, timeout=30).raise_for_status()
        for toxic in httpx.get(f"{self.toxi}/proxies/r2/toxics", timeout=30).json():
            httpx.delete(f"{self.toxi}/proxies/r2/toxics/{toxic['name']}", timeout=30)

    def wait_caught_up(self, timeout: float = 60) -> None:
        from cfo_server.litestream import wait_replicated_blocking

        outcome = wait_replicated_blocking(
            str(self.run_dir / "litestream.sock"), str(self.db_path), timeout
        )
        assert outcome.ok, outcome.log_fields()

    # The database ---------------------------------------------------------------------------
    def host_row(self, host_id: str, db: Path | None = None) -> dict[str, Any] | None:
        conn = sqlite3.connect(f"file:{db or self.db_path}?mode=ro", uri=True, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                "SELECT * FROM hosts WHERE lower(hex(host_id)) = ?", (host_id.replace("-", ""),)
            ).fetchone()
        finally:
            conn.close()
        return dict(row) if row is not None else None

    def restore_at(self, txid: int) -> Path:
        """The replica's state at ``txid``, restored beside the running app."""
        from cfo_drill.drill import side_restore

        out = self.workdir / f"restored-{uuid.uuid4().hex[:6]}.db"
        result = side_restore(
            out,
            deadline_s=60,
            txid=txid,
            env=self.env,
            config=self.run_dir / "litestream.yml",
            db_path=self.db_path,
        )
        assert result.ok, result.output_tail
        return out

    def wait_for(self, predicate: Any, timeout: float, what: str) -> Any:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.1)
        raise AssertionError(f"timed out waiting for {what}")


def _wait_litestream(socket: Path, db: Path, proc: subprocess.Popen[bytes]) -> None:
    from cfo_server.litestream import BlockingClient

    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        assert proc.poll() is None, "litestream exited"
        if socket.exists():
            try:
                with BlockingClient(str(socket), str(db)) as client:
                    if any(d.get("path") == str(db) for d in client.databases()):
                        return
            except Exception:  # noqa: BLE001 - not ready yet
                pass
        time.sleep(0.2)
    raise AssertionError("litestream never listed the database")


@pytest.fixture(scope="module")
def world(tmp_path_factory: pytest.TempPathFactory) -> Iterator[World]:
    missing = [name for name in REQUIRED if not os.environ.get(name)]
    if missing:
        pytest.skip(f"run by tests/test_fence_suite.py; missing {missing}")
    from cloudflare_omnigent.sandbox import registration
    from starlette.testclient import TestClient

    from cfo_drill.fence import EffectLog, RecordingStubLauncher, ReplicationFence
    from cfo_server import app as image_app
    from cfo_server import config as image_config
    from cfo_server import entrypoint
    from cfo_server.barrier import install_sql_hooks
    from cfo_server.litestream import ReplicationWaiter

    tmp = tmp_path_factory.mktemp("fence")
    db_path = tmp / "omnigent.db"
    data_dir = tmp / "data"
    run_dir = tmp / "run"
    for d in (data_dir, run_dir, tmp / "artifacts", tmp / "home"):
        d.mkdir()
    (data_dir / "config.yaml").write_text("{}\n")
    bucket = os.environ.get("CFO_FENCE_BUCKET", "cfo-wp25-replica")
    env = {
        "CFO_INSTALLATION_INITIALIZED": "false",
        "CFO_REPLICA_URL": f"s3://{bucket}/fence-{uuid.uuid4().hex[:8]}",
        "CFO_REPLICA_ENDPOINT": os.environ["CFO_FENCE_ENDPOINT"],
        "CFO_REPLICA_REGION": "us-east-1",
        "LITESTREAM_ACCESS_KEY_ID": os.environ["CFO_FENCE_S3_USER"],
        "LITESTREAM_SECRET_ACCESS_KEY": os.environ["CFO_FENCE_S3_PASSWORD"],
        "OMNIGENT_ACCOUNTS_BASE_URL": BASE_URL,
        "OMNIGENT_ACCOUNTS_COOKIE_SECRET": COOKIE_SECRET,
        "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME": OWNER,
        "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD": OWNER_PASSWORD,
        "CFO_RESPONSE_BARRIER_TIMEOUT_S": str(BARRIER_TIMEOUT_S),
        "CFO_TRANSCRIPT_BARRIER_TIMEOUT_S": "2",
    }
    config = image_config.load(env)
    layout = dataclasses.replace(
        entrypoint.Layout.production(),
        db_path=db_path,
        omnigent_data_dir=data_dir,
        config_path=data_dir / "config.yaml",
        artifact_dir=tmp / "artifacts",
        run_dir=run_dir,
        litestream_socket=run_dir / "litestream.sock",
        litestream_config=run_dir / "litestream.yml",
    )
    layout.litestream_config.write_text(json.dumps(entrypoint.litestream_config(config, layout)))
    app_env = image_config.app_environment(config, {**os.environ, **env})
    app_env.update(
        {
            "DATABASE_URL": f"sqlite:///{db_path}",
            "ARTIFACT_DIR": str(tmp / "artifacts"),
            "OMNIGENT_CONFIG": str(data_dir / "config.yaml"),
            "OMNIGENT_ADMIN_CREDENTIALS_PATH": str(data_dir / "admin-credentials"),
            "HOME": str(tmp / "home"),
        }
    )
    proc: subprocess.Popen[bytes] | None = None
    with pytest.MonkeyPatch.context() as mp:
        for key in list(os.environ):
            if key.startswith(("OMNIGENT_", "CFO_", "LITESTREAM_")):
                mp.delenv(key)
        for key, value in app_env.items():
            mp.setenv(key, value)
        # A short online wait, so a wake whose host never dials back (there is no computer)
        # gives up in seconds instead of the image's 240 s. The provider entry reads it from
        # the Cloudflare launcher's registration since WP3.6 (it was cfo_server.launcher's).
        mp.setattr(registration, "ONLINE_TIMEOUT_S", ONLINE_TIMEOUT_S)
        install_sql_hooks()
        ep = image_app.load_docker_entrypoint()
        resolved = ep._resolve_config()
        ep.run_migrations(resolved.database_url)
        proc = subprocess.Popen(  # noqa: S603
            [str(layout.litestream_bin), "replicate", *entrypoint.litestream_base_args(layout)],
            env=image_config.litestream_environment({**os.environ, **env}),
            stdout=subprocess.DEVNULL,
            stderr=(tmp / "litestream.log").open("wb"),
            start_new_session=True,
        )
        try:
            _wait_litestream(layout.litestream_socket, db_path, proc)
            fence = ReplicationFence(str(layout.litestream_socket), str(db_path), FENCE_TIMEOUT_S)
            effects = EffectLog()
            gate = threading.Event()
            gate.set()
            waiter = ReplicationWaiter(str(layout.litestream_socket), str(db_path), poll_s=0.02)
            app = image_app.build_app(
                config,
                resolved,
                waiter=waiter,
                launcher_factory=RecordingStubLauncher.factory(fence, effects, status_gate=gate),
                docker_entrypoint=ep,
            )
            with TestClient(app, base_url=BASE_URL) as client:
                yield World(
                    client=client,
                    db_path=db_path,
                    run_dir=run_dir,
                    env={**os.environ, **env},
                    fence=fence,
                    effects=effects,
                    gate=gate,
                    toxi=os.environ["CFO_FENCE_TOXI"],
                    litestream=proc,
                    workdir=tmp,
                )
        finally:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=60)
