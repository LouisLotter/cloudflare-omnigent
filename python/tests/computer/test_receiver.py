"""The command port's refusals and the contract's fixtures, at the actual receiver (ST-01).

Every golden ``WorkspaceCommand`` fixture is posted to the real HTTP receiver: the valid ones
are never refused as malformed, the invalid and refined ones always are. Malformed bodies,
another computer, another generation, a newer protocol and a reused operation ID are refused
before any effect.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import urllib.request
from pathlib import Path

import pytest
from cfo_computer.api import ComputerApi, Refused, Unanswered
from cfo_computer.contract import Contract
from cfo_computer.schema import ValidationError
from harness import REPO, FakeWorkspace, Rig

FIXTURES = REPO / "contracts" / "fixtures" / "WorkspaceCommand"
FIXTURE_COMPUTER = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3"


@pytest.fixture
def rig(tmp_path: Path):
    rig = Rig(tmp_path / "a", computer_id=FIXTURE_COMPUTER, generation=7)
    rig.sup.runner_processes = lambda: 0
    yield rig
    rig.close()


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.json")), ids=lambda p: p.stem)
def test_valid_fixtures_are_accepted_by_the_receiver(tmp_path: Path, path: Path) -> None:
    command = json.loads(path.read_text())
    rig = Rig(tmp_path / "a", computer_id=command["computerId"], generation=command["generation"])
    rig.sup.runner_processes = lambda: 0
    try:
        status, reply = rig.post(path.read_bytes())
        assert status != 400, reply
        if status != 200:  # refused for the computer's state, never as malformed
            assert reply["error"]["code"] in ("conflict", "not_found"), reply
    finally:
        rig.close()


@pytest.mark.parametrize(
    "path",
    sorted([*FIXTURES.glob("invalid/*.json"), *FIXTURES.glob("refined/*.json")]),
    ids=lambda p: f"{p.parent.name}/{p.stem}",
)
def test_invalid_and_refined_fixtures_are_refused(rig: Rig, path: Path) -> None:
    status, reply = rig.post(path.read_bytes())
    assert status == 400 and reply["error"]["code"] == "bad_request", reply


def test_refusals_before_any_effect(rig: Rig) -> None:
    good = rig.command("restore_workspace", manifest=None, layerDirs=[])
    for body, status, code in [
        (b"not json", 400, "bad_request"),
        (b"[]", 400, "bad_request"),
        (json.dumps({**good, "protocolVersion": 2}).encode(), 400, "unsupported_version"),
        (json.dumps({**good, "computerId": "cmp_" + "1" * 26}).encode(), 403, "forbidden"),
        (json.dumps({**good, "generation": 6}).encode(), 409, "stale_generation"),
        (json.dumps({**good, "extra": 1}).encode(), 400, "bad_request"),
    ]:
        got_status, reply = rig.post(body)
        assert (got_status, reply["error"]["code"]) == (status, code), body
    assert rig.sup.restore_state == "pending"
    # The operation ID binds the whole command.
    assert rig.post(good)[0] == 200
    status, reply = rig.post(rig.command("sign_out", op=good["operationId"]))
    assert status == 409 and reply["error"]["code"] == "conflict"
    status, reply = rig.send("job_status", jobOperationId="op_" + "0" * 26)
    assert status == 404 and reply["error"]["code"] == "not_found"


def test_http_edges(rig: Rig) -> None:
    def raw(method: str, path: str, data: bytes | None, headers: dict) -> int:
        request = urllib.request.Request(
            rig.url.replace("/v1/commands", path), data=data, method=method, headers=headers
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status
        except urllib.error.HTTPError as exc:
            return exc.code

    assert raw("GET", "/v1/commands", None, {}) == 405
    assert raw("POST", "/other", b"{}", {}) == 404
    assert raw("POST", "/v1/commands", b"x" * 10, {"content-length": str(600 * 1024)}) == 413


def test_api_client_refusals_and_unusable_replies(tmp_path: Path) -> None:
    contract = Contract(REPO / "contracts" / "schema")
    ws = FakeWorkspace()
    try:
        api = ComputerApi(ws.url, contract, timeout=5)
        hello = {
            "type": "hello",
            "protocolVersion": 1,
            "computerId": FIXTURE_COMPUTER,
            "generation": 7,
            "operationId": "op_01hzy4a7b8c9d0e1f2g3h4j5k6",
            "supervisorVersion": "0.1.0",
        }
        assert api.send(hello) == {"type": "hello", "protocolVersion": 1}
        ws.refuse = "stale_generation"
        with pytest.raises(Refused):
            api.send(hello, attempts=3, sleep=lambda s: None)
        ws.refuse = "unavailable"
        with pytest.raises(Unanswered):
            api.send(hello, attempts=3, sleep=lambda s: None)
        ws.refuse = None
        ws.drop = {"hello": 2}
        assert api.send(hello, attempts=5, sleep=lambda s: None)["type"] == "hello"
        assert [m["operationId"] for m in ws.of("hello")][-3:] == [hello["operationId"]] * 3
        with pytest.raises(ValidationError):  # our own malformed message never leaves
            api.send_once({**hello, "generation": -1})
    finally:
        ws.close()


def test_the_command_port_binds_whatever_the_hostname(tmp_path: Path, monkeypatch) -> None:
    """A Cloudflare ``durable_object`` container's hostname is its Durable Object's 64-character
    ID, and ``socket.getfqdn()`` raises on it, which stops a stock ``http.server`` from binding
    (found by WP3.3's staging). The command port never resolves the hostname; the container
    tests run every computer under such a hostname."""
    import socket
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from cfo_computer.server import CommandServer

    def label_too_long(name: str = "") -> str:
        raise UnicodeError("encoding with 'idna' codec failed (UnicodeError: label too long)")

    monkeypatch.setattr(socket, "getfqdn", label_too_long)
    with pytest.raises(UnicodeError):
        ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler).server_close()
    rig = Rig(tmp_path / "a")  # the harness's CommandServer, bound with getfqdn raising
    try:
        assert isinstance(rig.server, CommandServer)
        assert rig.server.server_name == "127.0.0.1"
        rig.boot()  # a restore and an install, answered through that port
    finally:
        rig.close()


def test_an_accept_with_nothing_waiting_never_blocks_the_command_server(tmp_path: Path) -> None:
    """WP3.26. ``serve_forever`` accepts only after a poll says a connection waits. If it is gone
    by then (another acceptor of the socket, or its descriptor number reused under the server),
    the accept fails and the loop goes on: a blocking accept would wait for the next connection,
    and ``shutdown`` for ever (CI's hang, in the test workspace's server). Accepted connections
    still block normally."""
    rig = Rig(tmp_path / "a")
    try:
        assert rig.server.socket.getblocking() is False
        handled = threading.Event()

        def accept_once() -> None:
            rig.server._handle_request_noblock()  # what serve_forever calls after its poll
            handled.set()

        threading.Thread(target=accept_once, daemon=True).start()
        assert handled.wait(5), "an accept with no connection waiting blocked"
        assert rig.ok("computer_status")["type"] == "computer_status"
    finally:
        rig.close()


def test_a_listener_moved_under_the_test_workspace_fails_fast_and_closes_nothing_else() -> None:
    """The harness's own guard (WP3.26): when a server's descriptor number has come to hold
    another owner's socket, closing the server names that at once, without a shutdown that could
    block or a close that would hit the other owner's descriptor."""
    workspace = FakeWorkspace()
    other = socket.socket()
    other.bind(("127.0.0.1", 0))
    other.listen(1)  # blocking, as another owner's listener may be
    number = workspace.server.fileno()
    os.dup2(other.fileno(), number)  # what a stale close and a reuse would leave behind
    try:
        started = time.monotonic()
        with pytest.raises(AssertionError, match="now holds another file"):
            workspace.close()
        assert time.monotonic() - started < 5
        os.fstat(number)  # the other owner's descriptor is still open
    finally:
        os.close(number)
        other.close()
