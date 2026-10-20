"""The probe under Amendment 3 and the probe review (x1-probe r1): close timing (item 3),
retry after a failed open (item 4), the fixed clock mapping and the clock and skew records
(item 2), the batch back-off (finding 8) and a recorder conflict (finding 6)."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import re
import struct
import time

import probe
import pytest
from test_probe import FAST, Recorder, config, of, run, ws_server

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


async def read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    b0, b1 = await reader.readexactly(2)
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await reader.readexactly(8))[0]
    mask = await reader.readexactly(4) if b1 & 0x80 else b"\0\0\0\0"
    data = await reader.readexactly(length)
    return b0 & 0x0F, bytes(b ^ mask[i % 4] for i, b in enumerate(data))


def frame(opcode: int, payload: bytes) -> bytes:
    n = len(payload)
    head = bytes([0x80 | opcode]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack("!H", n))
    return head + payload


class WithholdingServer:
    """A WebSocket peer written on raw TCP: it answers echoes, then on its first connection sends
    a close frame and never closes TCP, as Codex's in-memory transport did. Later connections
    are answered normally."""

    def __init__(self, answer_first: int = 2) -> None:
        self.answer_first = answer_first
        self.connections = 0
        self.close_sent_mono: float | None = None
        self.release = asyncio.Event()

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections += 1
        first = self.connections == 1
        request = await reader.readuntil(b"\r\n\r\n")
        key = re.search(rb"(?i)sec-websocket-key:\s*(\S+)", request).group(1)
        accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
        writer.write(
            b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n"
        )
        answered = 0
        try:
            while not first or answered < self.answer_first:
                opcode, data = await read_frame(reader)
                if opcode == 1:
                    reply = {**json.loads(data), "id": {"by": "raw"}}
                    writer.write(frame(1, json.dumps(reply).encode()))
                    answered += 1
                elif opcode == 8:
                    return
            self.close_sent_mono = time.monotonic() * 1000
            writer.write(frame(8, struct.pack("!H", 1012) + b"restarting"))
            await writer.drain()
            await self.release.wait()  # TCP stays open: no FIN, no reset
        except (asyncio.IncompleteReadError, ConnectionError):
            return
        finally:
            writer.close()


def test_a_close_frame_is_a_drop_at_once_while_tcp_stays_open(tmp_path):
    """Codex measured about 1,001 ms between the close frame and the logged drop, with another
    send after the frame. The drop is now logged within ~50 ms of the frame, nothing more is sent
    on that connection, and the reconnect starts at once."""
    rec = Recorder()
    server = WithholdingServer()

    async def scenario():
        listener = await asyncio.start_server(server.handle, "127.0.0.1", 0)
        port = listener.sockets[0].getsockname()[1]
        try:
            cfg = config(tmp_path, rec, {"p2": f"ws://127.0.0.1:{port}/x1/echo"}, 4.0)
            await probe.run_probe(cfg, FAST, instance="g1-0a1b2c3d-00a1b2", idle=False)
        finally:
            server.release.set()
            listener.close()

    asyncio.run(scenario())
    rec.close()
    events = rec.events()
    close = [c for c in of(events, "close", "p2") if c["conn"] == 1][0]
    assert close["by"] == "peer" and close["code"] == 1012 and close["reason"] == "restarting"
    assert server.close_sent_mono is not None
    assert 0 <= close["mono"] - server.close_sent_mono <= 50
    sends = [s for s in of(events, "send", "p2") if s["conn"] == 1]
    assert all(s["mono"] < close["mono"] for s in sends)
    following = [a for a in of(events, "attempt", "p2") if a["mono"] > close["mono"]]
    assert following[0]["ok"] and following[0]["mono"] - following[0]["ms"] - close["mono"] < 100
    assert of(events, "reply", "p2")[-1]["conn"] == 2


def test_a_close_frame_with_the_handshake_is_a_failed_open_timed_at_the_frame(tmp_path):
    """The peer sends its close frame right behind the 101 and keeps TCP open: the frame is seen
    before hold() starts, timed when it arrived, and, with no echo answered, is a failed open
    followed by the 0.5 s retry delay."""
    rec = Recorder()
    server = WithholdingServer(answer_first=0)

    async def scenario():
        listener = await asyncio.start_server(server.handle, "127.0.0.1", 0)
        port = listener.sockets[0].getsockname()[1]
        try:
            cfg = config(tmp_path, rec, {"p6": f"ws://127.0.0.1:{port}/x1/echo"}, 2.0)
            await probe.run_probe(cfg, FAST, instance="g1-0a1b2c3d-00a1b2", idle=False)
        finally:
            server.release.set()
            listener.close()

    asyncio.run(scenario())
    rec.close()
    events = rec.events()
    close = [c for c in of(events, "close", "p6") if c["conn"] == 1][0]
    assert close["by"] == "peer" and close["code"] == 1012
    assert 0 <= close["mono"] - server.close_sent_mono <= 50
    # The frame arrived while connect() was finishing: before the first attempt was even logged,
    # but never before the open, which is timed when the handshake's response arrived.
    first, second = of(events, "attempt", "p6")[:2]
    opened = [o for o in of(events, "open", "p6") if o["conn"] == 1][0]
    assert opened["mono"] <= close["mono"] <= first["mono"]
    assert 480 <= second["mono"] - second["ms"] - first["mono"] <= 700


def test_failed_opens_wait_the_retry_delay(tmp_path):
    """Codex: a peer that upgraded and closed at once gave 10 attempts in under 1 ms. A failed
    open (no echo answered) now waits 0.5 s, like a failed attempt."""
    rec = Recorder()

    async def handler(ws):
        return  # upgrade, then close at once

    async def scenario():
        async with ws_server(handler) as url:
            cfg = config(tmp_path, rec, {"p4": url}, 2.3)
            await probe.run_probe(cfg, FAST, instance="g1-0a1b2c3d-00a1b2", idle=False)

    asyncio.run(scenario())
    rec.close()
    events = rec.events()
    attempts = of(events, "attempt", "p4")
    closes = of(events, "close", "p4")
    assert 3 <= len(attempts) <= 6
    assert all(a["ok"] for a in attempts)
    # Every connection ends on record, and the next attempt starts 0.5 s after it.
    assert len(closes) == len(attempts)
    starts = [a["mono"] - a["ms"] for a in attempts]
    for close, start in zip(closes, starts[1:], strict=False):
        assert 480 <= start - close["mono"] <= 700


def test_an_exception_while_holding_records_a_terminal_close(tmp_path, monkeypatch):
    """Codex: the catch in run() recorded only an error, which the analysis does not turn into
    a drop. Now hold() records the connection's close itself."""
    rec = Recorder()
    calls = {"n": 0}
    real = probe.RouteProbe.on_message

    def flaky(self, conn, message, state):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("probe bug")
        return real(self, conn, message, state)

    monkeypatch.setattr(probe.RouteProbe, "on_message", flaky)

    async def handler(ws):
        async for message in ws:
            await ws.send(json.dumps({**json.loads(message), "id": {"by": "t"}}))

    async def scenario():
        async with ws_server(handler) as url:
            cfg = config(tmp_path, rec, {"p1": url}, 3.0)
            await probe.run_probe(cfg, FAST, instance="g1-0a1b2c3d-00a1b2", idle=False)

    asyncio.run(scenario())
    rec.close()
    closes = of(rec.events(), "close", "p1")
    assert closes[0] == {
        **closes[0],
        "conn": 1,
        "by": "error",
        "code": 1006,
        "error": "RuntimeError",
    }
    # The first echo was answered, so it was an established connection: immediate reconnect.
    attempts = of(rec.events(), "attempt", "p1")
    assert attempts[1]["mono"] - attempts[1]["ms"] - closes[0]["mono"] < 100
    assert closes[-1]["by"] == "end"


def test_clock_mapping_and_minute_records(tmp_path, monkeypatch):
    """Events are stamped from one fixed mapping; the clock records show the live wall clock's
    drift from it; a step of the live clock neither stops the probe early nor moves its events;
    the skew record is the median of the Worker's time minus the send/receive midpoint."""
    rec = Recorder()
    real_time = time.time

    async def handler(ws):
        async for message in ws:
            reply = {
                **json.loads(message),
                "id": {"by": "p3-handler"},
                "at": real_time() * 1000 + 700,
            }
            await ws.send(json.dumps(reply))

    async def scenario():
        async with ws_server(handler) as url:
            cfg = config(tmp_path, rec, {"p3": url}, 3.5)
            params = probe.Params(batch_interval=1.0, clock_interval=1.0)
            task = asyncio.create_task(
                probe.run_probe(cfg, params, instance="g1-0a1b2c3d-00a1b2", idle=False)
            )
            await asyncio.sleep(1.6)
            monkeypatch.setattr(probe.time, "time", lambda: real_time() - 15.0)
            return await task

    started = time.monotonic() * 1000
    asyncio.run(scenario())
    monkeypatch.undo()
    rec.close()
    events = rec.events()
    offsets = {round(e["wall"] - e["mono"], 1) for e in events}
    assert len(offsets) == 1  # one fixed mapping for every record
    clocks = of(events, "clock")
    assert abs(clocks[0]["driftMs"]) < 50
    assert any(-15_050 < c["driftMs"] < -14_950 for c in clocks[2:])
    end = of(events, "end")[0]
    assert end["mono"] - started >= 3400  # the step did not end the run early (or late)
    skews = [s for s in of(events, "skew") if s["n"] > 0]
    assert skews and all(650 < s["medianMs"] < 750 for s in skews)
    assert all(s["route"] == "p3" for s in of(events, "skew"))


def test_batch_back_off_starts_at_half_a_second():
    """Codex: the back-off began at 1.0 s. It is 0.5 s, doubling to 10 s."""
    params = probe.Params()
    assert [probe.backoff_s(n, params) for n in range(1, 9)] == [0.5, 1, 2, 4, 8, 10, 10, 10]


def test_a_recorder_conflict_is_recorded_not_retried(tmp_path):
    rec = Recorder()
    statuses = iter([(False, "409")])

    def post(url, body, timeout):
        with contextlib.suppress(StopIteration):
            if "/batch/" in url and url.endswith("/1"):
                return next(statuses)
        return probe.http_post(url, body, timeout)

    async def scenario():
        cfg = config(tmp_path, rec, {}, 1.5)
        return await probe.run_probe(
            cfg, FAST, post=post, instance="g1-0a1b2c3d-00a1b2", idle=False
        )

    manifest = asyncio.run(scenario())
    rec.close()
    assert "/x1/batch/run-20270115T080000Z/g1-0a1b2c3d-00a1b2/1" not in rec.stored
    assert of(rec.events(), "batch-conflict")[0]["what"] == "batch 1"
    assert rec.manifest()["batches"] == manifest["batches"]


@pytest.mark.parametrize("payload", [b"", b"\x03"])
def test_odd_close_frames_still_end_the_connection(payload):
    """An empty or malformed close frame still marks the moment, with no code."""
    seen = []

    class Conn(probe.ProbeConnection):
        def __init__(self):  # no network: only process_event is exercised
            self.response = object()
            self.close_frame_seen = None
            self.on_close_frame = lambda code, reason, at: seen.append((code, reason))
            self.recv_messages = type("R", (), {"put": lambda self, e: None})()

    conn = Conn()
    conn.process_event(probe.Frame(probe.Opcode.CLOSE, payload))
    conn.process_event(probe.Frame(probe.Opcode.CLOSE, payload))  # only the first counts
    assert len(seen) == 1
    assert seen[0][0] in (1005, None)
    assert run  # the shared helpers stay importable
