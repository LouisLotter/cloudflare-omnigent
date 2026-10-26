"""Shared fixtures for the server image's tests.

The unit and in-process tests run wherever the pinned Omnigent build is importable: inside
the image's ``test`` target (``docker build --target test``), or in a virtual environment
installed from the fork's lockfile with ``CFO_OMNIGENT_DOCKER_ENTRYPOINT`` pointing at the
fork's ``deploy/docker/entrypoint.py``. Every credential here is a synthetic test value.
"""

from __future__ import annotations

import contextlib
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

HERE = Path(__file__).resolve().parent
IMAGE_DIR = HERE.parent
sys.path.insert(0, str(IMAGE_DIR))
sys.path.insert(0, str(HERE))
# The Cloudflare launcher package: in the image it is on PYTHONPATH (/opt/cfo); in a checkout
# it is the repository's python/ directory.
_LAUNCHER_DIR = IMAGE_DIR.parent.parent / "python"
if (_LAUNCHER_DIR / "cloudflare_omnigent").is_dir():
    sys.path.insert(0, str(_LAUNCHER_DIR))

from fake_litestream import FakeLitestream  # noqa: E402

DOCKER_ENTRYPOINT = Path(os.environ.get("CFO_OMNIGENT_DOCKER_ENTRYPOINT", "/app/entrypoint.py"))
REPO_ROOT = Path(os.environ.get("CFO_REPO_ROOT", str(IMAGE_DIR.parent.parent)))

# Synthetic values only.
OWNER = "owner"
OWNER_PASSWORD = "cfo-test-owner-password-0001"
COOKIE_SECRET = "0123456789abcdef" * 4  # synthetic
BASE_URL = "http://testserver"


def base_env(tmp: Path, *, initialized: str = "false") -> dict[str, str]:
    """A complete, valid image environment for tests, rooted at ``tmp``: a file replica and the
    artifacts on local disk, both allowed for tests only."""
    return {
        "CFO_INSTALLATION_INITIALIZED": initialized,
        "CFO_REPLICA_URL": f"file://{tmp / 'replica'}",
        "CFO_ALLOW_FILE_REPLICA": "1",
        "CFO_ALLOW_LOCAL_ARTIFACTS": "1",
        "OMNIGENT_ACCOUNTS_BASE_URL": BASE_URL,
        "OMNIGENT_ACCOUNTS_COOKIE_SECRET": COOKIE_SECRET,
        "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME": OWNER,
        "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD": OWNER_PASSWORD,
    }


@pytest.fixture
def fake_litestream(tmp_path: Path) -> Iterator[FakeLitestream]:
    fake = FakeLitestream(tmp_path / "ls.sock").start()
    try:
        yield fake
    finally:
        fake.stop()


class AppHarness:
    """One Omnigent app built by the image's ``build_app``, on a fresh SQLite database."""

    def __init__(self, client: Any, fake: FakeLitestream, db_path: Path, app: Any) -> None:
        self.client = client
        self.fake = fake
        self.db_path = db_path
        self.app = app

    def login(self, *, refresh: bool = False) -> dict[str, Any]:
        response = self.client.post(
            "/auth/login",
            json={"username": OWNER, "password": OWNER_PASSWORD, "issue_refresh": refresh},
        )
        assert response.status_code == 200, response.text
        self.client.cookies.clear()
        return response.json()

    def bearer(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.login()['token']}"}


def omnigent_available() -> bool:
    try:
        import omnigent.server.app  # noqa: F401
    except ImportError:
        return False
    return DOCKER_ENTRYPOINT.exists()


requires_omnigent = pytest.mark.skipif(
    not omnigent_available(), reason="needs the pinned Omnigent build and its Docker entrypoint"
)


@pytest.fixture(scope="module")
def app_harness(tmp_path_factory: pytest.TempPathFactory) -> Iterator[AppHarness]:
    """The image's app, served in process by Starlette's test client (lifespan included)."""
    if not omnigent_available():
        pytest.skip("needs the pinned Omnigent build")
    with serve_app(tmp_path_factory.mktemp("app")) as harness:
        yield harness


@contextlib.contextmanager
def serve_app(tmp: Path, env_overrides: dict[str, str] | None = None) -> Iterator[AppHarness]:
    """One start of the image's app on the database in ``tmp``: served in process by
    Starlette's test client (lifespan included). A second call on the same ``tmp`` is a restart
    on the same database, with ``env_overrides`` as a release would change the environment."""
    from starlette.testclient import TestClient

    from cfo_server import app as image_app
    from cfo_server import config as image_config
    from cfo_server.barrier import install_sql_hooks
    from cfo_server.litestream import ReplicationWaiter

    db_path = tmp / "omnigent.db"
    data_dir = tmp / "data"
    data_dir.mkdir(exist_ok=True)
    config_path = data_dir / "config.yaml"
    config_path.write_text("{}\n")
    fake = FakeLitestream(tmp / "ls.sock", db_path=str(db_path)).start()
    env = base_env(tmp)
    env.update(
        {
            "CFO_RESPONSE_BARRIER_TIMEOUT_S": "1.5",
            "CFO_TRANSCRIPT_BARRIER_TIMEOUT_S": "1.0",
            **(env_overrides or {}),
        }
    )
    config = image_config.load(env)
    app_env = image_config.app_environment(config, {**os.environ, **env})
    app_env.update(
        {
            "DATABASE_URL": f"sqlite:///{db_path}",
            "ARTIFACT_DIR": str(tmp / "artifacts"),
            "OMNIGENT_CONFIG": str(config_path),
            "OMNIGENT_ADMIN_CREDENTIALS_PATH": str(data_dir / "admin-credentials"),
            "HOME": str(tmp / "home"),
        }
    )
    with pytest.MonkeyPatch.context() as mp:
        for key in list(os.environ):
            if key.startswith(("OMNIGENT_", "CFO_")):
                mp.delenv(key)
        for key, value in app_env.items():
            mp.setenv(key, value)
        install_sql_hooks()
        ep = image_app.load_docker_entrypoint(DOCKER_ENTRYPOINT)
        resolved = ep._resolve_config()
        ep.run_migrations(resolved.database_url)
        waiter = ReplicationWaiter(str(fake.socket_path), str(db_path), poll_s=0.02)
        app = image_app.build_app(config, resolved, waiter=waiter, docker_entrypoint=ep)
        try:
            with TestClient(app, base_url=BASE_URL) as client:
                yield AppHarness(client, fake, db_path, app)
        finally:
            fake.stop()
