"""One HTTP attempt has one absolute deadline (AT3-009), against real loopback peers.

Each peer is a raw TCP server scripted byte by byte: partial status lines, partial header
lines, a delayed or trickled body, malformed replies, and a good reply just inside the
deadline. A trickling peer must not stretch an attempt past its deadline; the launcher then
repeats the same operation ID and body, and the adapter keeps the outcome unknown.
"""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager

import pytest
from conftest import FAST_BACKOFF

from cloudflare_omnigent.sandbox import client as client_module
from cloudflare_omnigent.sandbox import protocol
from cloudflare_omnigent.sandbox.client import (
    CallPolicy,
    LauncherClient,
    OutcomeUnknown,
    http_post,
)
from cloudflare_omnigent.sandbox.settings import LauncherSettings

CMP = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3"
#: Slack for thread scheduling on a busy machine; the unfixed client overran by 140 ms on a
#: 60 ms deadline, and each trickling peer below keeps going for a second or more.
SLACK_S = 0.3

Script = Callable[[socket.socket], None]


def _read_request(conn: socket.socket) -> bytes:
    """Read one request: headers, then the body its Content-Length names."""
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(65536)
        if not chunk:
            return data
        data += chunk
    head, _, body = data.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n")[1:]:
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-length":
            length = int(value)
    while len(body) < length:
        chunk = conn.recv(65536)
        if not chunk:
            break
        body += chunk
    return head + b"\r\n\r\n" + body


class Peer:
    """A loopback server that answers each connection with the next script."""

    def __init__(self, scripts: list[Script]) -> None:
        self.scripts = scripts
        self.requests: list[bytes] = []
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.listener.settimeout(0.1)
        self.port = self.listener.getsockname()[1]
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._accepter = threading.Thread(target=self._accept, daemon=True)
        self._accepter.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/launcher"

    def _accept(self) -> None:
        index = 0
        while not self._stop.is_set():
            try:
                conn, _ = self.listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            script = self.scripts[min(index, len(self.scripts) - 1)]
            index += 1
            thread = threading.Thread(target=self._serve, args=(conn, script), daemon=True)
            thread.start()
            self._threads.append(thread)

    def _serve(self, conn: socket.socket, script: Script) -> None:
        with conn:
            conn.settimeout(3)
            try:
                self.requests.append(_read_request(conn))
                script(conn)
            except OSError:
                pass  # the client gave up: that is the point of most scripts

    def close(self) -> None:
        self._stop.set()
        self.listener.close()
        for thread in self._threads:
            thread.join(timeout=3)
        self._accepter.join(timeout=3)


@contextmanager
def peer(*scripts: Script) -> Iterator[Peer]:
    server = Peer(list(scripts))
    try:
        yield server
    finally:
        server.close()


def trickle(prefix: bytes, piece: bytes, every_s: float = 0.025, for_s: float = 1.2) -> Script:
    def script(conn: socket.socket) -> None:
        conn.sendall(prefix)
        end = time.monotonic() + for_s
        while time.monotonic() < end:
            conn.sendall(piece)
            time.sleep(every_s)

    return script


def after(delay_s: float, data: bytes) -> Script:
    def script(conn: socket.socket) -> None:
        time.sleep(delay_s)
        conn.sendall(data)

    return script


def ok_reply(payload: bytes = b"{}") -> bytes:
    return (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
        + f"Content-Length: {len(payload)}\r\n\r\n".encode()
        + payload
    )


def _timed(url: str, timeout_s: float) -> tuple[float, BaseException | tuple[int, bytes]]:
    started = time.monotonic()
    try:
        outcome: BaseException | tuple[int, bytes] = http_post(
            f"{url}/status", {"Content-Type": "application/json"}, b"{}", timeout_s
        )
    except Exception as exc:  # noqa: BLE001 - the test inspects it
        outcome = exc
    return time.monotonic() - started, outcome


# ── The deadline holds whatever the peer does ───────────────────────────────────────────


@pytest.mark.parametrize(
    "script",
    [
        # Codex's reproduction: a status line, then one header trickled byte by byte.
        trickle(b"HTTP/1.1 200 OK\r\nX-Synthetic: ", b"x"),
        # A status line that never ends.
        trickle(b"HTT", b"P"),
        # Header after header, never the blank line that ends them.
        trickle(b"HTTP/1.1 200 OK\r\n", b"X-A: b\r\n", every_s=0.02),
        # Complete headers, then a body trickled a byte at a time.
        trickle(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n", b"{"),
        # Complete headers, then nothing.
        trickle(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n", b"", for_s=2.0),
        # A chunked body whose chunks keep coming.
        trickle(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", b"1\r\nx\r\n"),
        # Silence: the request is read and never answered.
        after(2.0, ok_reply()),
    ],
    ids=[
        "partial-header-line",
        "partial-status-line",
        "endless-headers",
        "trickled-body",
        "headers-then-silence",
        "endless-chunks",
        "no-reply",
    ],
)
@pytest.mark.parametrize("timeout_s", [0.06, 0.3])
def test_a_trickling_or_silent_peer_never_stretches_an_attempt(
    script: Script, timeout_s: float
) -> None:
    with peer(script) as server:
        elapsed, outcome = _timed(server.url, timeout_s)
    assert isinstance(outcome, TimeoutError), outcome
    assert elapsed < timeout_s + SLACK_S, f"{timeout_s}s attempt took {elapsed:.3f}s"


def test_a_reply_just_inside_the_deadline_is_kept() -> None:
    with peer(after(0.15, ok_reply(b'{"ok":true}'))) as server:
        elapsed, outcome = _timed(server.url, 0.4)
    assert outcome == (200, b'{"ok":true}')
    assert 0.15 <= elapsed < 0.4


def test_a_reply_split_into_slow_pieces_inside_the_deadline_is_kept() -> None:
    reply = ok_reply(b'{"operation":"status"}')

    def script(conn: socket.socket) -> None:
        for i in range(0, len(reply), 10):
            conn.sendall(reply[i : i + 10])
            time.sleep(0.01)

    with peer(script) as server:
        elapsed, outcome = _timed(server.url, 1.0)
    assert outcome == (200, b'{"operation":"status"}')
    assert elapsed < 1.0


@pytest.mark.parametrize(
    ("reply", "kind"),
    [
        (b"NOT HTTP AT ALL\r\n\r\n", "BadStatusLine"),
        (b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}", "IncompleteRead"),
        (b"HTTP/1.1 200 OK\r\n" + b"X-Long: " + b"a" * 70000 + b"\r\n\r\n", "LineTooLong"),
        (b"", "RemoteDisconnected"),
    ],
    ids=["bad-status-line", "short-body", "header-too-long", "closed-without-reply"],
)
def test_malformed_replies_fail_quickly_as_no_reply(reply: bytes, kind: str) -> None:
    with peer(after(0.0, reply)) as server:
        elapsed, outcome = _timed(server.url, 2.0)
    assert type(outcome).__name__ == kind, outcome
    assert elapsed < 1.0


def test_an_oversized_reply_is_cut_off_and_reads_as_too_large() -> None:
    payload = b"x" * (protocol.MAX_BODY_BYTES + 50_000)
    with peer(after(0.0, ok_reply(payload))) as server:
        _, outcome = _timed(server.url, 2.0)
    assert isinstance(outcome, tuple)
    assert protocol.MAX_BODY_BYTES < len(outcome[1]) < len(payload)


def test_a_hanging_name_lookup_is_bounded_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """No socket timeout covers name resolution; the waiting thread still returns on time."""
    released = threading.Event()
    original = socket.create_connection

    def slow_connection(address: tuple[str, int], *args: object, **kwargs: object) -> socket.socket:
        released.wait(2.0)
        return original(address, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(client_module.socket, "create_connection", slow_connection)
    with peer(after(0.0, ok_reply())) as server:
        elapsed, outcome = _timed(server.url, 0.1)
        released.set()
        time.sleep(0.05)
    assert isinstance(outcome, TimeoutError)
    assert elapsed < 0.1 + SLACK_S


def test_no_socket_is_left_open_after_a_cancelled_attempt() -> None:
    """The worker closes the connection it opened once the caller has given up."""
    with peer(trickle(b"HTTP/1.1 200 OK\r\nX-A: ", b"a", for_s=0.6)) as server:
        before = threading.active_count()
        _, outcome = _timed(server.url, 0.08)
        assert isinstance(outcome, TimeoutError)
        deadline = time.monotonic() + 2
        while threading.active_count() > before and time.monotonic() < deadline:
            time.sleep(0.01)
        assert threading.active_count() <= before


# ── The client repeats the same operation; the outcome stays unknown ──────────────────


def _client(url: str) -> LauncherClient:
    settings = LauncherSettings(signing_key=b"k" * 32, signing_key_id="kid", base_url=url)
    return LauncherClient(settings, backoff_s=FAST_BACKOFF)


def test_a_trickled_reply_is_repeated_with_the_same_operation_and_body() -> None:
    good = ok_reply(b'{"operation":"status","running":true,"status":"host_running","generation":3}')
    with peer(trickle(b"HTTP/1.1 200 OK\r\nX-A: ", b"a"), after(0.0, good)) as server:
        reply = _client(server.url).call(
            protocol.status_request("0" * 31 + "1", CMP),
            CallPolicy(attempt_timeout_s=0.15, budget_s=2.0),
        )
        requests = list(server.requests)
    assert reply.result == protocol.StatusResult(running=True, status="host_running", generation=3)
    assert reply.attempts == 2
    bodies = [r.partition(b"\r\n\r\n")[2] for r in requests]
    assert len(bodies) == 2 and bodies[0] == bodies[1]
    assert b'"operationId":"00000000000000000000000000000001"' in bodies[0]


def test_a_peer_that_always_trickles_ends_in_an_unknown_outcome_within_the_budget() -> None:
    with peer(trickle(b"HTTP/1.1 200 OK\r\nX-A: ", b"a", for_s=3.0)) as server:
        started = time.monotonic()
        with pytest.raises(OutcomeUnknown):
            _client(server.url).call(
                protocol.status_request("0" * 31 + "1", CMP),
                CallPolicy(attempt_timeout_s=0.1, budget_s=0.5),
            )
        elapsed = time.monotonic() - started
        attempts = len(server.requests)
    assert attempts >= 2
    assert elapsed < 0.5 + 0.1 + SLACK_S


# ── Framing: a reply counts only when its framing proves it whole (Codex r1, finding 3) ─

_JSON = b'{"operation":"suspend","outcome":"stopped"}'
_CHUNKED_HEAD = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"


def _chunk(data: bytes) -> bytes:
    return f"{len(data):x}\r\n".encode() + data + b"\r\n"


@pytest.mark.parametrize(
    ("reply", "accepted"),
    [
        (_CHUNKED_HEAD + _chunk(_JSON) + b"0\r\n\r\n", True),
        (_CHUNKED_HEAD + _chunk(_JSON[:10]) + _chunk(_JSON[10:]) + b"0\r\nX-T: 1\r\n\r\n", True),
        (_CHUNKED_HEAD + _chunk(_JSON) + b"0\r\n", False),  # no end of the trailer
        (_CHUNKED_HEAD + _chunk(_JSON), False),  # no last chunk
        (_CHUNKED_HEAD + f"{len(_JSON):x}\r\n".encode() + _JSON + b"XX0\r\n\r\n", False),
        (_CHUNKED_HEAD + b"zz\r\n" + _JSON + b"\r\n0\r\n\r\n", False),
        (b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + _JSON, False),  # unframed
        (b"HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\n" + _JSON, False),  # too large
    ],
    ids=[
        "chunked",
        "chunked-split-with-trailer",
        "missing-final-crlf",
        "missing-last-chunk",
        "damaged-chunk-end",
        "bad-chunk-size",
        "close-delimited",
        "length-over-the-limit",
    ],
)
def test_only_completely_framed_replies_are_read(reply: bytes, accepted: bool) -> None:
    with peer(after(0.0, reply)) as server:
        _, outcome = _timed(server.url, 2.0)
    if accepted:
        assert outcome == (200, _JSON)
    elif isinstance(outcome, tuple):
        assert len(outcome[1]) > protocol.MAX_BODY_BYTES  # reads as too large: unknown
    else:
        assert isinstance(outcome, (OSError, client_module.http.client.HTTPException)), outcome


def test_a_badly_framed_reply_is_repeated_and_never_taken_as_stopped() -> None:
    bad = _CHUNKED_HEAD + _chunk(_JSON) + b"0\r\n"
    good = ok_reply(_JSON)
    with peer(after(0.0, bad), after(0.0, good)) as server:
        reply = _client(server.url).call(
            protocol.suspend_request("0" * 31 + "2", CMP),
            CallPolicy(attempt_timeout_s=0.5, budget_s=2.0),
        )
    assert reply.attempts == 2
    assert reply.result == protocol.SuspendResult("stopped")
