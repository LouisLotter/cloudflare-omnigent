"""The control port's handlers, against a stand-in for Litestream's control socket."""

from __future__ import annotations

import json
import re
import socket
from pathlib import Path

import httpx
import pytest
from jsonschema import Draft202012Validator

from cfo_server.httpd import StatusBoard, start_control_server
from cfo_server.litestream import BlockingClient

from conftest import REPO_ROOT
from fake_litestream import FakeLitestream

DB = "/data/omnigent.db"


def _schema(name: str) -> dict:
    return json.loads((REPO_ROOT / f"contracts/schema/{name}.schema.json").read_text())


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def control(fake_litestream: FakeLitestream):  # noqa: ANN201
    board = StatusBoard(initialized_expected=True, installation_id=None)
    port = _free_port()
    server = start_control_server(board, port, "127.0.0.1")
    try:
        yield board, f"http://127.0.0.1:{port}", fake_litestream
    finally:
        server.shutdown()
        server.server_close()


def test_boot_id_is_128_random_bits_in_lowercase_hex() -> None:
    ids = {StatusBoard(initialized_expected=None).boot_id for _ in range(50)}
    assert len(ids) == 50
    assert all(re.fullmatch(r"[0-9a-f]{32}", i) for i in ids)


def test_position_is_503_before_litestream_runs(control) -> None:  # noqa: ANN001
    _, url, _ = control
    response = httpx.get(f"{url}/position")
    assert response.status_code == 503
    errors = list(Draft202012Validator(_schema("ErrorBody")).iter_errors(response.json()))
    assert not errors


def test_position_answers_one_sync_in_the_contract_shape(control) -> None:  # noqa: ANN001
    board, url, fake = control
    board.litestream = lambda: BlockingClient(str(fake.socket_path), DB)
    fake.lag_syncs = 5
    before = len(fake.sync_bodies)
    response = httpx.get(f"{url}/position")
    assert response.status_code == 200
    body = response.json()
    assert not list(Draft202012Validator(_schema("ReplicationPosition")).iter_errors(body))
    assert body["bootId"] == board.boot_id
    assert body["txid"] == fake.txid and body["replicatedTxid"] == fake.replicated
    assert len(fake.sync_bodies) == before + 1
    assert fake.sync_bodies[-1] == {"path": DB}  # never a wait sync


@pytest.mark.parametrize("mode", ["error", "hang"])
def test_position_is_503_when_litestream_fails(control, mode: str) -> None:  # noqa: ANN001
    board, url, fake = control
    board.litestream = lambda: BlockingClient(str(fake.socket_path), DB, timeout_s=0.5)
    fake.mode = mode
    fake.hang_s = 2
    assert httpx.get(f"{url}/position", timeout=10).status_code == 503


def test_status_reports_phase_boot_and_lag(control) -> None:  # noqa: ANN001
    board, url, fake = control
    board.update(phase="running")
    board.litestream = lambda: BlockingClient(str(fake.socket_path), DB)
    fake.mode = "blocked"
    status = httpx.get(f"{url}/status").json()
    assert status["phase"] == "running" and status["bootId"] == board.boot_id
    assert status["replication"]["caughtUp"] is False


def test_unknown_paths_are_404(control, tmp_path: Path) -> None:  # noqa: ANN001
    _, url, _ = control
    assert httpx.get(f"{url}/v1/info").status_code == 404


@pytest.mark.parametrize("host", ["0.0.0.0", "127.0.0.1"])
def test_both_servers_bind_whatever_the_hostname(host: str, monkeypatch) -> None:  # noqa: ANN001
    """Under the ``durable_object`` policy the container's hostname is its Durable Object's
    64-character ID, and ``socket.getfqdn()`` raises on it (UC-93), which stops a stock
    ``http.server`` from binding. The control port and the recovery responder never resolve the
    hostname; the image's own suites also run under such a hostname (docs/testing.md)."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from cfo_server.httpd import start_recovery_responder

    def label_too_long(name: str = "") -> str:
        raise UnicodeError("encoding with 'idna' codec failed (UnicodeError: label too long)")

    monkeypatch.setattr(socket, "getfqdn", label_too_long)
    with pytest.raises(UnicodeError):
        ThreadingHTTPServer((host, 0), BaseHTTPRequestHandler).server_close()
    board = StatusBoard(initialized_expected=True, installation_id=None)
    for server in (
        start_control_server(board, _free_port(), host),
        start_recovery_responder("restore_failed", _free_port(), host),
    ):
        try:
            assert server.server_name == host
            port = server.server_address[1]
            assert server.server_port == port
            answer = httpx.get(f"http://127.0.0.1:{port}/status")
            assert answer.status_code in (200, 503)
        finally:
            server.shutdown()
            server.server_close()
