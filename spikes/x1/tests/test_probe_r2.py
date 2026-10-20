"""The probe under Codex's final review (x1-probe r2): an echo that arrives in the same read as
the close frame (finding 1), and recorder conflicts during the final flush (finding 3)."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import struct

import analyze
import probe
from test_probe import FAST, Recorder, config, of
from test_probe_amendment3 import GUID, frame, read_frame


class AnswerThenClose:
    """A WebSocket peer on raw TCP. On its first connection it answers the first echo and, in
    the same write (so the probe reads both at once), sends a close frame; then it leaves TCP
    open. Later connections are answered normally. This is Codex's case."""

    def __init__(self) -> None:
        self.connections = 0
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
        try:
            while True:
                opcode, data = await read_frame(reader)
                if opcode == 8:
                    return
                if opcode != 1:
                    continue
                reply = frame(1, json.dumps({**json.loads(data), "id": {"by": "raw"}}).encode())
                if first:
                    writer.write(reply + frame(8, struct.pack("!H", 1001) + b"going away"))
                    await writer.drain()
                    await self.release.wait()
                    return
                writer.write(reply)
        except (asyncio.IncompleteReadError, ConnectionError):
            return
        finally:
            writer.close()


def test_an_echo_read_with_the_close_frame_counts(tmp_path):
    """Codex, with the pinned websockets 15.0.1: the peer answered the first echo, then closed,
    in one read; the probe recorded send → close → miss, no reply, and a failed open. Now:
    send → reply → close, an established connection, an immediate reconnect, and a drop."""
    rec = Recorder()
    server = AnswerThenClose()

    async def scenario():
        listener = await asyncio.start_server(server.handle, "127.0.0.1", 0)
        port = listener.sockets[0].getsockname()[1]
        try:
            cfg = config(tmp_path, rec, {"p2": f"ws://127.0.0.1:{port}/x1/echo"}, 3.0)
            await probe.run_probe(cfg, FAST, instance="g1-0a1b2c3d-00a1b2", idle=False)
        finally:
            server.release.set()
            listener.close()

    asyncio.run(scenario())
    rec.close()
    events = rec.events()
    first = [e for e in events if e.get("route") == "p2" and e.get("conn") == 1]
    kinds = [e["ev"] for e in first if e["ev"] in ("send", "reply", "miss", "close")]
    assert kinds == ["send", "reply", "close"]
    reply, close = first[[e["ev"] for e in first].index("reply")], first[-1]
    assert reply["rtt"] < 1000 and not reply["late"]
    assert close["by"] == "peer" and close["code"] == 1001 and reply["mono"] <= close["mono"]
    # Established: the reconnect is immediate, not after the 0.5 s failed-open delay.
    second = of(events, "attempt", "p2")[1]
    assert second["mono"] - second["ms"] - close["mono"] < 100
    # And the analysis counts the drop.
    line = analyze.timeline({"g1-0a1b2c3d-00a1b2": [e for e in events if "ev" in e]})
    drops = analyze.find_drops(analyze.route_records(line, "p2"))
    assert [(d.conn, d.by, d.code) for d in drops] == [(1, "peer", 1001)]


def conflicting(paths: set[str]):
    """A recorder whose answer is 409 for the given names: they hold another body."""

    def post(url: str, body: bytes, timeout: float) -> tuple[bool, str]:
        if any(url.endswith(p) for p in paths):
            return False, "409"
        return probe.http_post(url, body, timeout)

    return post


def test_a_conflicting_final_batch_is_named_in_the_manifest(tmp_path):
    """Codex: a 409 on the final batch was recorded only locally, counted as stored, and the
    manifest looked normal. Now the manifest names it, and it is not counted as stored."""
    rec = Recorder()

    async def scenario():
        cfg = config(tmp_path, rec, {}, 1.5)
        post = conflicting({"/g1-0a1b2c3d-00a1b2/2"})
        return await probe.run_probe(
            cfg,
            probe.Params(batch_interval=1.0),
            post=post,
            instance="g1-0a1b2c3d-00a1b2",
            idle=False,
        )

    result = asyncio.run(scenario())
    rec.close()
    manifest = rec.manifest()
    assert manifest["batches"] == 2 and manifest["conflicts"] == [2]
    assert manifest["runId"] == "run-20270115T080000Z"
    assert result["conflicts"] == [2] and result["manifestStored"] is True
    assert "/x1/batch/run-20270115T080000Z/g1-0a1b2c3d-00a1b2/2" not in rec.stored


def test_a_conflicting_manifest_leaves_a_failure_record(tmp_path):
    rec = Recorder()

    async def scenario():
        cfg = config(tmp_path, rec, {}, 0.5)
        post = conflicting({"/manifest/run-20270115T080000Z/g1-0a1b2c3d-00a1b2"})
        return await probe.run_probe(
            cfg, FAST, post=post, instance="g1-0a1b2c3d-00a1b2", idle=False
        )

    result = asyncio.run(scenario())
    rec.close()
    assert result["manifestStored"] is False
    assert rec.manifest() is None
    failure = json.loads(rec.stored["/x1/failure/run-20270115T080000Z/g1-0a1b2c3d-00a1b2"])
    assert failure["failure"] == "manifest conflict" and failure["batches"] == 1
