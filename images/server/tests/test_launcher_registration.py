"""The Cloudflare launcher as this image registers it: settings from the environment, and its
durability fence through Litestream's control socket (the fake one here).

Blocked replication makes each lifecycle effect fail before any request reaches the launcher
API, so no computer is created or removed and no launch token is published on a write that
could still be lost (FH-25, FH-29, R-23). The launcher API is a small recording server.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from conftest import base_env, requires_omnigent

pytestmark = requires_omnigent

CMP = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3"
HOST_ID = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f"
REPLIES = {
    "provision": {"operation": "provision", "computerId": CMP},
    "start_host": {"operation": "start_host", "workspacePath": "/home/omnigent/work"},
    "terminate": {"operation": "terminate", "removal": "pending"},
    "suspend": {"operation": "suspend", "outcome": "stopped"},
}


class Recorder:
    """A launcher API stand-in that records what reaches it and answers each effect."""

    def __init__(self) -> None:
        self.bodies: list[dict[str, Any]] = []
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def do_POST(self) -> None:  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                body = json.loads(raw)
                recorder.bodies.append(body)
                data = json.dumps(REPLIES[body["operation"]]).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://{host}:{port}/launcher"


@pytest.fixture
def recorder() -> Iterator[Recorder]:
    server = Recorder()
    try:
        yield server
    finally:
        server.server.shutdown()
        server.server.server_close()


def _deployment(tmp_path: Path, fake: Any, recorder: Recorder, **extra: str) -> Any:
    from cfo_server import config as image_config
    from cfo_server.launcher import litestream_durability_wait, sandbox_deployment

    config = image_config.load(base_env(tmp_path))
    env = {
        "CFO_LAUNCHER_SIGNING_KEY": "k" * 40,  # synthetic
        "CFO_LAUNCHER_SIGNING_KEY_ID": "k-test",
        "CFO_LAUNCHER_URL": recorder.url,
        "CFO_LAUNCHER_DURABILITY_TIMEOUT_S": "0.5",
        **extra,
    }
    wait = litestream_durability_wait(str(fake.socket_path), fake.db_path)
    return sandbox_deployment(config, durability_wait=wait, env=env)


def _effects(launcher: Any) -> dict[str, Any]:
    return {
        "provision": lambda: launcher.provision("managed-0123abcd"),
        "start_host": lambda: launcher.start_host(
            CMP,
            token="t" * 43,
            host_id=HOST_ID,
            host_name="Work computer",
            server_url="http://omnigent.internal",
            start_attempt=1,
        ),
        "terminate": lambda: launcher.terminate(CMP),
    }


@pytest.mark.parametrize("operation", ["provision", "start_host", "terminate"])
def test_blocked_replication_stops_each_effect_before_any_request(
    tmp_path: Path, fake_litestream: Any, recorder: Recorder, operation: str
) -> None:
    import click

    fake_litestream.mode = "blocked"
    fake_litestream.txid = 10  # a commit the replica never confirms
    launcher = _deployment(tmp_path, fake_litestream, recorder).default.launcher_factory()
    with pytest.raises(click.ClickException, match="not yet replicated"):
        _effects(launcher)[operation]()
    assert recorder.bodies == []
    assert fake_litestream.sync_bodies  # the fence asked Litestream
    assert all(body == {"path": fake_litestream.db_path} for body in fake_litestream.sync_bodies)


def test_a_blocked_sleep_is_unknown_and_sends_nothing(
    tmp_path: Path, fake_litestream: Any, recorder: Recorder
) -> None:
    fake_litestream.mode = "blocked"
    fake_litestream.txid = 10
    launcher = _deployment(tmp_path, fake_litestream, recorder).default.launcher_factory()
    result = launcher.suspend(CMP, operation_id="5f0c6e2a9b4d4c1e8a7f3b2d1c0e9f8a")
    assert result.outcome == "unknown" and recorder.bodies == []


@pytest.mark.parametrize("operation", ["provision", "start_host", "terminate"])
def test_with_replication_healthy_each_effect_is_sent_after_the_fence(
    tmp_path: Path, fake_litestream: Any, recorder: Recorder, operation: str
) -> None:
    launcher = _deployment(tmp_path, fake_litestream, recorder).default.launcher_factory()
    _effects(launcher)[operation]()
    assert [body["operation"] for body in recorder.bodies] == [operation]
    assert fake_litestream.sync_bodies


def test_without_a_key_the_launcher_is_registered_and_refuses_readably(
    tmp_path: Path, fake_litestream: Any, recorder: Recorder
) -> None:
    import click

    from cfo_server import config as image_config
    from cfo_server.launcher import sandbox_deployment

    config = image_config.load(base_env(tmp_path))
    deployment = sandbox_deployment(config, durability_wait=lambda _t: True, env={})
    launcher = deployment.default.launcher_factory()
    with pytest.raises(click.ClickException, match="not configured"):
        launcher.provision("managed-0123abcd")
    assert recorder.bodies == []


@pytest.mark.parametrize(
    "extra",
    [
        {"CFO_LAUNCHER_SIGNING_KEY": "short"},
        {"CFO_LAUNCHER_SIGNING_KEY_ID": ""},
        {"CFO_LAUNCHER_URL": "https://platform.internal/launcher"},
        {"CFO_LAUNCHER_DURABILITY_TIMEOUT_S": "120"},
    ],
)
def test_a_malformed_launcher_setting_stops_the_app(
    tmp_path: Path, fake_litestream: Any, recorder: Recorder, extra: dict[str, str]
) -> None:
    from cloudflare_omnigent.sandbox.settings import LauncherConfigError

    with pytest.raises(LauncherConfigError):
        _deployment(tmp_path, fake_litestream, recorder, **extra)


def test_computers_must_reach_this_server_on_omnigent_internal(tmp_path: Path) -> None:
    from cfo_server import config as image_config
    from cfo_server.launcher import sandbox_deployment

    env = {**base_env(tmp_path), "CFO_SANDBOX_SERVER_URL": "https://omnigent.example.test"}
    config = image_config.load(env)
    with pytest.raises(ValueError, match="omnigent.internal"):
        sandbox_deployment(config, durability_wait=lambda _t: True, env={})
