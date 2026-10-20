"""The probe against local sockets: the echo server as a separate process (so it can be
stopped with SIGSTOP), small websockets servers that misbehave on purpose, and a recorder that
fails before it succeeds. Timings are section 4's, so these tests take some seconds each."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import probe
import pytest
from websockets.asyncio.server import serve

SERVER = Path(__file__).resolve().parents[1] / "server" / "echo_server.py"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Recorder:
    """A local stand-in for rec.x1.internal: stores each path once, fails the first N posts."""

    def __init__(self, fail_first: int = 0) -> None:
        self.fail_left = fail_first
        self.posts: list[str] = []
        self.stored: dict[str, bytes] = {}
        self.lock = threading.Lock()
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = self.rfile.read(int(self.headers.get("content-length", "0")))
                with recorder.lock:
                    recorder.posts.append(self.path)
                    if recorder.fail_left > 0:
                        recorder.fail_left -= 1
                        self.send_response(503)
                        self.end_headers()
                        return
                    recorder.stored.setdefault(self.path, body)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"stored":true}')

            def log_message(self, *args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()

    def events(self) -> list[dict]:
        out = []
        batches = [p for p in self.stored if "/batch/" in p]
        for path in sorted(batches, key=lambda p: int(p.rsplit("/", 1)[1])):
            lines = self.stored[path].decode().splitlines()
            out.extend(json.loads(line) for line in lines[1:])
        return out

    def headers(self) -> list[dict]:
        batches = [p for p in self.stored if "/batch/" in p]
        ordered = sorted(batches, key=lambda p: int(p.rsplit("/", 1)[1]))
        return [json.loads(self.stored[p].decode().splitlines()[0]) for p in ordered]

    def manifest(self) -> dict | None:
        for path, body in self.stored.items():
            if "/manifest/" in path:
                return json.loads(body)
        return None


@contextlib.contextmanager
def echo_process(tmp_path: Path):
    port, log_port = free_port(), free_port()
    env = {
        **os.environ,
        "X1_ECHO_PORT": str(port),
        "X1_LOG_PORT": str(log_port),
        "X1_LOG_PATH": str(tmp_path / "server.log"),
        "PYTHONPATH": os.pathsep.join(sys.path),
    }
    proc = subprocess.Popen([sys.executable, str(SERVER)], env=env)
    deadline = time.time() + 10
    while time.time() < deadline:
        with (
            contextlib.suppress(OSError),
            socket.create_connection(("127.0.0.1", port), timeout=0.2),
        ):
            break
        time.sleep(0.05)
    try:
        yield port, log_port, proc
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.kill(proc.pid, signal.SIGCONT)
        proc.terminate()
        proc.wait(timeout=10)


def config(
    tmp_path: Path, recorder: Recorder, urls: dict[str, str], seconds: float
) -> probe.Config:
    return probe.Config(
        run_id="run-20270115T080000Z",
        mode="run",
        generation=1,
        end_wall=time.time() * 1000 + seconds * 1000,
        routes=list(urls),
        urls=urls,
        headers={r: {} for r in urls},
        recorder=recorder.url,
        log_dir=str(tmp_path / "probe"),
    )


FAST = probe.Params(batch_interval=1.0)


def run(cfg: probe.Config, params: probe.Params = FAST) -> dict:
    return asyncio.run(probe.run_probe(cfg, params, instance="g1-0a1b2c3d-00a1b2", idle=False))


def of(events: list[dict], ev: str, route: str | None = None) -> list[dict]:
    return [e for e in events if e["ev"] == ev and (route is None or e.get("route") == route)]


def test_happy_path_batches_and_manifest(tmp_path):
    rec = Recorder()
    with echo_process(tmp_path) as (port, log_port, _):
        url = f"ws://127.0.0.1:{port}/x1/echo"
        manifest = run(config(tmp_path, rec, {"p1": url, "p6": url}, 4.0))
        # The server's log, as ServerDO reads it, holds the connection events.
        with socket.create_connection(("127.0.0.1", log_port)) as s:
            s.sendall(b"GET /log?offset=0 HTTP/1.0\r\n\r\n")
            raw = b""
            while chunk := s.recv(65536):
                raw += chunk
    rec.close()
    head, _, body = raw.partition(b"\r\n\r\n")
    assert b"x-x1-log-id" in head.lower()
    server_events = [json.loads(line) for line in body.decode().splitlines()]
    assert [e["ev"] for e in server_events if e["src"] == "echo"].count("open") == 2
    events = rec.events()
    assert (
        rec.manifest()["batches"]
        == manifest["batches"]
        == len([p for p in rec.stored if "/batch/" in p])
    )
    assert rec.manifest()["events"] == len(events)
    # Each batch names the span it accounts for: contiguous, from the probe's start to its cut,
    # and every event it holds lies in it.
    headers = rec.headers()
    assert headers[0]["fromMono"] == of(events, "probe-start")[0]["mono"]
    for before, after in zip(headers, headers[1:], strict=False):
        assert after["fromMono"] == before["cutMono"] and after["fromWall"] == before["cutWall"]
    for path, header in zip(
        sorted((p for p in rec.stored if "/batch/" in p), key=lambda p: int(p.rsplit("/", 1)[1])),
        headers,
        strict=True,
    ):
        lines = [json.loads(line) for line in rec.stored[path].decode().splitlines()[1:]]
        assert all(
            header["fromMono"] <= e.get("loggedMono", e["mono"]) <= header["cutMono"] for e in lines
        )
    for route in ("p1", "p6"):
        sends, replies = of(events, "send", route), of(events, "reply", route)
        assert len(sends) >= 3 and len(replies) == len(sends)
        assert all(r["rtt"] < 1000 and not r["late"] for r in replies)
        ident = of(events, "ident", route)
        assert len(ident) == 1 and ident[0]["id"]["by"] == "server"
        closes = of(events, "close", route)
        assert [c["by"] for c in closes] == ["end"]
    assert of(events, "probe-start")[0]["instance"] == "g1-0a1b2c3d-00a1b2"
    assert of(events, "end")
    # Echo every 1.0 s on each route.
    p1 = [e["mono"] for e in of(events, "send", "p1")]
    assert all(950 <= b - a <= 1100 for a, b in zip(p1, p1[1:], strict=False))
    # The local log has every event too.
    local = (tmp_path / "probe" / "probe-g1-0a1b2c3d-00a1b2.jsonl").read_text().splitlines()
    assert len(local) >= len(events)


def test_silence_close_after_sigstop_then_reconnect(tmp_path):
    rec = Recorder()
    with echo_process(tmp_path) as (port, _, proc):
        url = f"ws://127.0.0.1:{port}/x1/echo"

        async def scenario() -> dict:
            cfg = config(tmp_path, rec, {"p2": url}, 16.0)
            task = asyncio.create_task(
                probe.run_probe(cfg, FAST, instance="g1-0a1b2c3d-00a1b2", idle=False)
            )
            await asyncio.sleep(2.5)
            os.kill(proc.pid, signal.SIGSTOP)
            await asyncio.sleep(9.0)
            os.kill(proc.pid, signal.SIGCONT)
            return await task

        asyncio.run(scenario())
    rec.close()
    events = rec.events()
    silence = of(events, "silence", "p2")
    assert len(silence) == 1
    close = of(events, "close", "p2")[0]
    assert close["by"] == "silence" and close["code"] == 4000
    quiet = silence[0]["quietMs"]
    assert 3000 <= quiet < 3300
    # Misses were recorded before the close, for echoes past their deadline.
    misses = [m for m in of(events, "miss", "p2") if m["mono"] <= close["mono"]]
    assert misses and not any(m.get("afterClose") for m in misses)
    attempts = of(events, "attempt", "p2")
    assert attempts[0]["ok"] and any(not a["ok"] for a in attempts) and attempts[-1]["ok"]
    # The first reconnect attempt starts immediately after the drop; a failed one (the server
    # is stopped, so the handshake times out) is followed 0.5 s later by the next.
    starts = [a["mono"] - a["ms"] for a in attempts if a["mono"] >= close["mono"]]
    assert starts[0] - close["mono"] < 100
    failed = [a for a in attempts if not a["ok"]]
    assert failed[0]["error"] == "TimeoutError" and 4900 <= failed[0]["ms"] <= 5300
    assert 450 <= starts[1] - (starts[0] + failed[0]["ms"]) <= 700
    assert len(of(events, "open", "p2")) == 2
    replies_after = [r for r in of(events, "reply", "p2") if r["conn"] == 2]
    assert replies_after


@contextlib.asynccontextmanager
async def ws_server(handler):
    async with serve(handler, "127.0.0.1", 0, compression=None) as server:
        port = server.sockets[0].getsockname()[1]
        yield f"ws://127.0.0.1:{port}/x1/echo"


def test_close_code_drop_and_immediate_reconnect(tmp_path):
    rec = Recorder()

    async def handler(ws):
        replies = 0
        async for message in ws:
            data = json.loads(message)
            if replies == 2:
                await ws.close(1012, "restarting")
                return
            await ws.send(json.dumps({**data, "id": {"by": "test"}, "at": 0}))
            replies += 1

    async def scenario():
        async with ws_server(handler) as url:
            return await probe.run_probe(
                config(tmp_path, rec, {"p3": url}, 5.5),
                FAST,
                instance="g1-0a1b2c3d-00a1b2",
                idle=False,
            )

    asyncio.run(scenario())
    rec.close()
    events = rec.events()
    closes = of(events, "close", "p3")
    peer = [c for c in closes if c["by"] == "peer"]
    assert peer and peer[0]["code"] == 1012 and peer[0]["reason"] == "restarting"
    attempts = of(events, "attempt", "p3")
    following = [a for a in attempts if a["mono"] >= peer[0]["mono"]]
    assert following[0]["ok"] and following[0]["mono"] - following[0]["ms"] - peer[0]["mono"] < 100
    assert {e["conn"] for e in of(events, "open", "p3")} >= {1, 2}
    # The unanswered echo at the close is recorded as missed.
    assert any(m.get("afterClose") for m in of(events, "miss", "p3"))


def test_end_drain_waits_one_deadline_for_outstanding_replies(tmp_path):
    rec = Recorder()

    async def handler(ws):
        async for message in ws:
            await asyncio.sleep(0.6)
            await ws.send(json.dumps({**json.loads(message), "id": {"by": "slow"}}))

    async def scenario():
        async with ws_server(handler) as url:
            cfg = config(tmp_path, rec, {"p2": url}, 2.3)
            return await probe.run_probe(cfg, FAST, instance="g1-0a1b2c3d-00a1b2", idle=False)

    asyncio.run(scenario())
    rec.close()
    events = rec.events()
    sends, replies = of(events, "send", "p2"), of(events, "reply", "p2")
    assert len(sends) == 3 and len(replies) == 3
    end = of(events, "close", "p2")[-1]
    assert end["by"] == "end" and replies[-1]["mono"] <= end["mono"]
    assert not of(events, "miss", "p2")


def test_transport_error_is_a_drop(tmp_path):
    rec = Recorder()
    calls = {"n": 0}

    async def handler(ws):
        calls["n"] += 1
        async for message in ws:
            await ws.send(json.dumps({**json.loads(message), "id": {"by": "t"}}))
            if calls["n"] == 1:
                ws.transport.abort()  # no close frame: a transport error for the probe
                return

    async def scenario():
        async with ws_server(handler) as url:
            cfg = config(tmp_path, rec, {"p1": url}, 2.0)
            return await probe.run_probe(cfg, FAST, instance="g1-0a1b2c3d-00a1b2", idle=False)

    asyncio.run(scenario())
    rec.close()
    closes = of(rec.events(), "close", "p1")
    assert closes[0]["by"] == "error" and closes[0]["code"] == 1006
    assert closes[0]["error"] == "ConnectionClosedError"
    assert closes[-1]["by"] == "end"


def test_failed_attempts_retry_every_half_second(tmp_path):
    rec = Recorder()
    url = f"ws://127.0.0.1:{free_port()}/x1/echo"  # nothing listens there
    run(config(tmp_path, rec, {"p6": url}, 2.6))
    rec.close()
    attempts = of(rec.events(), "attempt", "p6")
    assert len(attempts) >= 4 and not any(a["ok"] for a in attempts)
    assert all(a["error"] == "ConnectionRefusedError" for a in attempts)
    gaps = [b["mono"] - a["mono"] for a, b in zip(attempts, attempts[1:], strict=False)]
    assert all(480 <= g <= 700 for g in gaps)


def test_refused_upgrade_records_the_status(tmp_path):
    rec = Recorder()
    with echo_process(tmp_path) as (port, _, _):
        run(config(tmp_path, rec, {"p5": f"ws://127.0.0.1:{port}/elsewhere"}, 1.2))
    rec.close()
    attempt = of(rec.events(), "attempt", "p5")[0]
    assert attempt["status"] == 404 and attempt["error"] == "InvalidStatus"


def test_late_duplicate_and_foreign_replies(tmp_path):
    rec = Recorder()

    async def handler(ws):
        n = 0
        async for message in ws:
            data = json.loads(message)
            n += 1
            if n == 2:
                await asyncio.sleep(1.4)  # late: after the 1.0 s deadline
            await ws.send(
                json.dumps({**data, "id": {"by": "slow", "isolate": "x" * 80, "nested": {"a": 1}}})
            )
            if n == 3:
                await ws.send(json.dumps({**data, "id": {"by": "slow"}}))  # a duplicate
                await ws.send(json.dumps({**data, "seq": 10_000}))  # never sent
                await ws.send(json.dumps({**data, "route": "p1"}))  # another route
                await ws.send("not json")

    async def scenario():
        async with ws_server(handler) as url:
            return await probe.run_probe(
                config(tmp_path, rec, {"p4": url}, 5.0),
                FAST,
                instance="g1-0a1b2c3d-00a1b2",
                idle=False,
            )

    asyncio.run(scenario())
    rec.close()
    events = rec.events()
    late = [r for r in of(events, "reply", "p4") if r["late"]]
    assert len(late) == 1 and late[0]["rtt"] > 1000
    assert [m["seq"] for m in of(events, "miss", "p4")][:1] == [late[0]["seq"]]
    assert len(of(events, "duplicate", "p4")) == 1
    whys = sorted(e["why"] for e in of(events, "unexpected", "p4"))
    assert whys == ["another route or connection", "not an echo", "unknown sequence number"]
    # The identity is recorded once (the duplicate's differs, but a duplicate is no reply), cut
    # to known keys and 40 characters.
    ident = of(events, "ident", "p4")
    assert [i["id"] for i in ident] == [{"by": "slow", "isolate": "x" * 40}]


def test_batches_are_retried_until_stored_and_sent_once_in_order(tmp_path):
    rec = Recorder(fail_first=3)
    with echo_process(tmp_path) as (port, _, _):
        params = probe.Params(batch_interval=0.5, retry=0.1, retry_max=0.2)
        run(config(tmp_path, rec, {"p1": f"ws://127.0.0.1:{port}/x1/echo"}, 3.0), params)
    rec.close()
    batch_posts = [p for p in rec.posts if "/batch/" in p]
    numbers = [int(p.rsplit("/", 1)[1]) for p in batch_posts]
    # Batch 1 was posted four times (three failures), then each later batch once, in order.
    assert numbers[:4] == [1, 1, 1, 1]
    assert numbers[3:] == sorted(set(numbers))
    manifest = rec.manifest()
    stored = sorted(int(p.rsplit("/", 1)[1]) for p in rec.stored if "/batch/" in p)
    assert stored == list(range(1, manifest["batches"] + 1))
    retries = of(rec.events(), "batch-retry")
    assert [r["detail"] for r in retries] == ["503", "503", "503"]


def test_pings_and_pongs_are_recorded_apart_from_echoes(tmp_path):
    rec = Recorder()
    with echo_process(tmp_path) as (port, _, _):
        params = probe.Params(batch_interval=1.0, ping_interval=1.0)
        run(config(tmp_path, rec, {"p2": f"ws://127.0.0.1:{port}/x1/echo"}, 3.5), params)
    rec.close()
    events = rec.events()
    pings, pongs = of(events, "ping", "p2"), of(events, "pong", "p2")
    assert len(pings) >= 2 and len(pongs) == len(pings)
    assert all(p["rtt"] < 1000 for p in pongs)


def test_pong_missing_is_recorded():
    log_events = []

    class FakeLog:
        def event(self, ev, at_mono=None, **fields):
            log_events.append({"ev": ev, **fields})

    async def scenario():
        rp = probe.RouteProbe(
            "p1", "ws://x", {}, FakeLog(), asyncio.Event(), probe.Params(ping_interval=0.05)
        )
        never = asyncio.get_running_loop().create_future()
        await rp.pong(never, 1, 1, time.monotonic())
        failed = asyncio.get_running_loop().create_future()
        failed.set_exception(RuntimeError("closed"))
        await rp.pong(failed, 1, 2, time.monotonic())

    asyncio.run(scenario())
    assert log_events == [{"ev": "pong-missing", "route": "p1", "conn": 1, "n": 1}]


def test_late_start_writes_only_the_manifest(tmp_path):
    rec = Recorder()
    cfg = config(tmp_path, rec, {"p1": "ws://127.0.0.1:1/x1/echo"}, -1.0)
    manifest = run(cfg)
    rec.close()
    events = [e["ev"] for e in rec.events()]
    assert [e for e in events if e not in ("clock", "skew")] == ["probe-start", "late-start", "end"]
    assert events.count("clock") >= 1 and events.count("skew") >= 1
    assert manifest["batches"] == 1


def test_blocked_checks_retry_network_errors():
    calls = []

    def get(url, headers, timeout):
        calls.append(url)
        if len(calls) < 3:
            return None, None, "URLError"
        return 403, "p2-handler", None

    class FakeLog:
        events: list[dict] = []

        def event(self, ev, **fields):
            self.events.append({"ev": ev, **fields})

    cfg = probe.config_from_env({"X1_ROUTES": "p2"})
    log = FakeLog()
    asyncio.run(probe.blocked_checks(cfg, log, get=get, pause=0.0))
    assert log.events == [
        {
            "ev": "blocked-check",
            "target": "p2",
            "status": 403,
            "refusedBy": "p2-handler",
            "error": None,
            "tries": 3,
        }
    ]
    calls.clear()
    FakeLog.events = []

    def down(url, headers, timeout):
        return None, None, "TimeoutError"

    log = FakeLog()
    asyncio.run(probe.blocked_checks(cfg, log, get=down, tries=2, pause=0.0))
    assert log.events[0]["status"] is None and log.events[0]["error"] == "TimeoutError"


def test_http_helpers_against_the_recorder_and_the_echo_server(tmp_path):
    rec = Recorder(fail_first=1)
    assert probe.http_post(f"{rec.url}/x", b"{}", 2.0) == (False, "503")
    assert probe.http_post(f"{rec.url}/x", b"{}", 2.0) == (True, "200")
    assert probe.http_post("http://127.0.0.1:1/x", b"{}", 2.0) == (False, "URLError")
    rec.close()
    with echo_process(tmp_path) as (port, _, _):
        assert probe.http_get(f"http://127.0.0.1:{port}/health", {}, 2.0) == (200, None, None)
        assert probe.http_get(f"http://127.0.0.1:{port}/x1/blocked", {}, 2.0) == (404, None, None)
    assert probe.http_get("http://127.0.0.1:1/", {}, 1.0) == (None, None, "URLError")


def test_config_from_the_environment():
    env = {
        "X1_RUN_ID": "run-20270115T080000Z",
        "X1_MODE": "run",
        "X1_GENERATION": "3",
        "X1_END": "1800007500000",
        "X1_T0": "1800000000000",
        "X1_ROUTES": "p1,p2,p3,p4,p5,p6,bogus",
        "X1_P4_URL": "wss://worker.example.test/x1/echo",
        "X1_P5_URL": "wss://tunnel.example.test/x1/echo",
        "X1_ACCESS_CLIENT_ID": "id-canary",
        "X1_ACCESS_CLIENT_SECRET": "secret-canary",
        "X1_ROUTE_CREDENTIAL": "c1.3." + "a" * 64,
    }
    cfg = probe.config_from_env(env)
    assert cfg.routes == ["p1", "p2", "p3", "p4", "p5", "p6"]
    assert cfg.urls["p1"] == "ws://p1.x1.internal/x1/echo"
    assert cfg.headers["p4"] == {
        "CF-Access-Client-Id": "id-canary",
        "CF-Access-Client-Secret": "secret-canary",
    }
    assert cfg.headers["p5"]["x-x1-route-credential"] == "c1.3." + "a" * 64
    assert cfg.headers["p1"] == {}
    targets = [(t, u) for t, u, _ in cfg.blocked]
    assert targets == [
        ("p1", "http://p1.x1.internal/x1/blocked"),
        ("p2", "http://p2.x1.internal/x1/blocked"),
        ("p6", "http://p6.x1.internal/x1/blocked"),
        ("p5", "https://tunnel.example.test/x1/blocked"),
        ("p5-badcred", "https://tunnel.example.test/x1/echo"),
    ]
    assert cfg.blocked[4][2]["x-x1-route-credential"] != env["X1_ROUTE_CREDENTIAL"]
    assert (
        cfg.generation == 3
        and cfg.end_wall == 1800007500000.0
        and cfg.extra["t0"] == "1800000000000"
    )
    private = probe.config_from_env({"X1_ROUTES": "p1,p2,p3,p6"})
    assert "p4" not in private.urls and [t for t, _, _ in private.blocked] == ["p1", "p2", "p6"]


def test_no_secret_reaches_the_records(tmp_path):
    """The service token and route credential are in headers only, never in an event."""
    rec = Recorder()
    canary = "x1-canary-" + os.urandom(6).hex()

    async def handler(ws):
        async for message in ws:
            await ws.send(json.dumps({**json.loads(message), "id": {"by": "t"}}))

    async def scenario():
        async with ws_server(handler) as url:
            cfg = config(tmp_path, rec, {"p5": url}, 2.0)
            cfg.headers["p5"] = {"CF-Access-Client-Secret": canary, "x-x1-route-credential": canary}
            await probe.run_probe(cfg, FAST, instance="g1-0a1b2c3d-00a1b2", idle=False)

    asyncio.run(scenario())
    rec.close()
    everything = (
        b"".join(rec.stored.values())
        + (tmp_path / "probe" / "probe-g1-0a1b2c3d-00a1b2.jsonl").read_bytes()
    )
    assert canary.encode() not in everything
    assert of(rec.events(), "reply", "p5")


def test_boot_id_and_identity_helpers(monkeypatch):
    assert len(probe.boot_id()) == 8
    assert probe.sanitize_identity("x") is None
    assert probe.sanitize_identity({"by": "s", "pid": 7, "start": True, "other": 1}) == {
        "by": "s",
        "pid": 7,
    }

    def broken(*args, **kwargs):
        raise OSError("no proc")

    monkeypatch.setattr("builtins.open", broken)
    assert probe.boot_id() == "00000000"


@pytest.mark.parametrize("seconds", [1.5])
def test_route_task_survives_a_probe_bug(tmp_path, monkeypatch, seconds):
    rec = Recorder()

    async def boom(self):
        raise RuntimeError("bug")

    monkeypatch.setattr(probe.RouteProbe, "attempt", boom)
    run(config(tmp_path, rec, {"p1": "ws://127.0.0.1:1/x1/echo"}, seconds))
    rec.close()
    errors = of(rec.events(), "error", "p1")
    assert len(errors) >= 2 and errors[0]["error"] == "RuntimeError"
