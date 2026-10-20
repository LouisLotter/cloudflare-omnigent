"""The server container's echo, log and cloudflared supervision, in process."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import urllib.error
import urllib.request

import echo_server
import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve


def test_echo_reply_keeps_only_the_probe_fields():
    identity = {"by": "server", "boot": "b"}
    message = json.dumps(
        {"t": "echo", "route": "p1", "conn": 2, "seq": 7, "sent": 1.5, "extra": "x"}
    )
    reply = json.loads(echo_server.echo_reply(message, identity, 9.0))
    assert reply == {
        "t": "echo",
        "route": "p1",
        "conn": 2,
        "seq": 7,
        "sent": 1.5,
        "id": identity,
        "at": 9.0,
    }


@pytest.mark.parametrize(
    "message",
    [
        b"bytes",
        "x" * 5000,
        "not json",
        json.dumps([1]),
        json.dumps({"t": "other"}),
        json.dumps({"t": "echo", "route": "p9", "conn": 1, "seq": 1, "sent": 1}),
        json.dumps({"t": "echo", "route": "p1", "conn": 1.0, "seq": 1, "sent": 1}),
        json.dumps({"t": "echo", "route": "p1", "conn": 1, "seq": True, "sent": 1}),
        json.dumps({"t": "echo", "route": "p1", "conn": 1, "seq": 1, "sent": "1"}),
    ],
)
def test_echo_reply_refuses_anything_else(message):
    assert echo_server.echo_reply(message, {}, 0.0) is None


def test_log_removes_the_token_and_token_shaped_values(tmp_path):
    token = "eyJ" + "a1B2" * 20
    log = echo_server.EventLog(str(tmp_path / "log"), [token, ""])
    log.write(
        "cloudflared",
        "line",
        line=f"Settings: map[token:{token}] other eyJzZWNyZXQiOiJjYW5hcnkifQ==",
    )
    log.write("echo", "open", n=1)
    text = log.read(0).decode()
    assert token not in text and "eyJzZWNyZXQ" not in text
    assert text.count("<redacted>") == 2
    first = text.splitlines()[0]
    assert log.read(len(first) + 1).decode().startswith('{"src":"echo"')
    assert log.read(10**9) == b""


def test_log_server_serves_offsets_with_the_log_id(tmp_path):
    log = echo_server.EventLog(str(tmp_path / "log"), [])
    log.write("echo", "open", n=1)
    server = echo_server.log_server(log, "abcd1234-1", 0)
    port = server.server_address[1]
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/log?offset=0") as res:
            assert res.headers["x-x1-log-id"] == "abcd1234-1"
            body = res.read()
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/log?offset={len(body)}") as res:
            assert res.read() == b""
        for path, code in (("/other", 404), ("/log?offset=x", 400)):
            with pytest.raises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(f"http://127.0.0.1:{port}{path}")
            assert caught.value.code == code
    finally:
        server.shutdown()
    assert json.loads(body.splitlines()[0])["ev"] == "open"


def test_echo_handler_reports_hops_and_close(tmp_path):
    log = echo_server.EventLog(str(tmp_path / "log"), [])
    echo = echo_server.EchoServer(log)

    async def scenario():
        async with serve(
            echo.handler, "127.0.0.1", 0, process_request=echo.process_request
        ) as server:
            port = server.sockets[0].getsockname()[1]
            headers = {
                "x-x1-route": "p2",
                "x-x1-serverdo": "s" * 60,
                "x-cfo-generation": "4",
                "x-other": "no",
            }
            async with connect(f"ws://127.0.0.1:{port}/x1/echo", additional_headers=headers) as ws:
                await ws.send(
                    json.dumps({"t": "echo", "route": "p2", "conn": 1, "seq": 1, "sent": 0})
                )
                reply = json.loads(await ws.recv())
                await ws.send("junk")
                await ws.close(4000, "silence")
            for path, status in (("/health", 200), ("/x1/blocked", 404)):
                res = await asyncio.to_thread(fetch, f"http://127.0.0.1:{port}{path}")
                assert res == status
            return reply

    reply = asyncio.run(scenario())
    assert reply["id"]["serverdo"] == "s" * 40 and reply["id"]["route"] == "p2"
    assert "generation" not in reply["id"]
    events = [json.loads(line) for line in log.read(0).decode().splitlines()]
    opened, closed = events[0], events[1]
    assert (
        opened["ev"] == "open" and opened["generation"] == "4" and "other" not in json.dumps(opened)
    )
    assert closed["ev"] == "close" and closed["code"] == 4000 and closed["replies"] == 1


def fetch(url: str) -> int:
    try:
        with urllib.request.urlopen(url) as res:
            return res.status
    except urllib.error.HTTPError as error:
        return error.code


def test_cloudflared_is_restarted_and_its_output_redacted(tmp_path, monkeypatch):
    token = "eyJ" + "t0k3n" * 10
    fake = tmp_path / "cloudflared"
    fake.write_text('#!/bin/sh\necho "starting with $*"\nexit 3\n')
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(echo_server, "CLOUDFLARED", str(fake))
    log = echo_server.EventLog(str(tmp_path / "log"), [token])

    async def scenario():
        stop = asyncio.Event()
        task = asyncio.create_task(echo_server.run_cloudflared(log, token, stop))
        await asyncio.sleep(2.5)
        stop.set()
        await asyncio.wait_for(task, timeout=5)

    asyncio.run(scenario())
    text = log.read(0).decode()
    assert token not in text
    events = [json.loads(line) for line in text.splitlines()]
    assert [e["ev"] for e in events][:4] == ["start", "line", "exit", "start"]
    assert (
        events[1]["line"]
        == "starting with tunnel --no-autoupdate --loglevel info run --token <redacted>"
    )
    assert events[2]["code"] == 3


@pytest.mark.parametrize(
    ("line", "event"),
    [
        (
            "2026-10-20T12:00:00Z INF Registered tunnel connection connIndex=0 connection=0f0f0f0f-0000-4000-8000-000000000000 event=0 ip=198.51.100.7 location=ams01 protocol=quic",
            {
                "kind": "registered",
                "level": "INF",
                "connIndex": "0",
                "event": "0",
                "ip": "198.51.100.7",
                "location": "ams01",
                "protocol": "quic",
            },
        ),
        (
            '2026-10-20T12:00:00Z ERR Failed to dial a quic connection error="timeout: no recent network activity" connIndex=1 event=0 ip=198.51.100.8',
            {
                "kind": "dial-failed",
                "level": "ERR",
                "connIndex": "1",
                "event": "0",
                "ip": "198.51.100.8",
            },
        ),
        (
            "2026-10-20T12:00:01Z INF Switching to fallback protocol http2 connIndex=1",
            {"kind": "fallback", "level": "INF", "connIndex": "1"},
        ),
        (
            '2026-10-20T12:00:02Z WRN Connection terminated error="x" connIndex=2',
            {"kind": "terminated", "level": "WRN", "connIndex": "2"},
        ),
        (
            "2026-10-20T12:00:03Z INF Using fallback protocol=http2",
            {"kind": "fallback", "level": "INF", "protocol": "http2"},
        ),
        ("short", None),
        ("2026-10-20T12:00:00Z INF Starting tunnel", None),
    ],
)
def test_cloudflared_connection_events_are_extracted(line, event):
    assert echo_server.cloudflared_event(line) == event


def test_cloudflared_gets_no_tunnel_variable_and_initial_protocol_is_parsed():
    env = {"PATH": "/bin", "X1_TUNNEL_TOKEN": "t", "tunnel_x": "y", "HOME": "/root"}
    assert echo_server.cloudflared_env(env) == {"PATH": "/bin", "HOME": "/root"}
    line = "2026-10-20T11:16:52Z INF Initial protocol quic"
    assert echo_server.cloudflared_event(line) == {
        "kind": "initial-protocol",
        "level": "INF",
        "protocol": "quic",
    }
    error = '2026-10-20T11:16:52Z ERR Register tunnel error from server side error="x" connIndex=0'
    assert echo_server.cloudflared_event(error)["kind"] == "register-error"


def test_cloudflared_event_lines_are_logged_structured(tmp_path, monkeypatch):
    fake = tmp_path / "cloudflared"
    fake.write_text(
        "#!/bin/sh\necho '2026-10-20T12:00:00Z INF Registered tunnel connection connIndex=0 protocol=quic'\nsleep 5\n"
    )
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(echo_server, "CLOUDFLARED", str(fake))
    log = echo_server.EventLog(str(tmp_path / "log"), [])

    async def scenario():
        stop = asyncio.Event()
        task = asyncio.create_task(echo_server.run_cloudflared(log, "t", stop))
        await asyncio.sleep(1.0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
    events = [json.loads(line) for line in log.read(0).decode().splitlines()]
    conn = [e for e in events if e["ev"] == "conn"]
    assert conn == [
        {**conn[0], "kind": "registered", "connIndex": "0", "protocol": "quic", "level": "INF"}
    ]


def test_main_serves_until_stopped(tmp_path, monkeypatch):
    import socket

    def free() -> int:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    echo_port, log_port = free(), free()
    monkeypatch.setattr(echo_server, "ECHO_PORT", echo_port)
    monkeypatch.setattr(echo_server, "LOG_PORT", log_port)
    monkeypatch.setattr(echo_server, "LOG_PATH", str(tmp_path / "log"))
    monkeypatch.delenv("X1_TUNNEL_TOKEN", raising=False)

    async def scenario():
        task = asyncio.create_task(echo_server.main())
        for _ in range(100):
            await asyncio.sleep(0.05)
            if await asyncio.to_thread(lambda: _healthy(echo_port)):
                break
        os.kill(os.getpid(), 15)
        await asyncio.wait_for(task, timeout=5)

    asyncio.run(scenario())
    events = [json.loads(line) for line in (tmp_path / "log").read_text().splitlines()]
    assert events[0]["ev"] == "start" and events[0]["tunnel"] is False
    assert events[-1]["ev"] == "stop"


def _healthy(port: int) -> bool:
    try:
        return fetch(f"http://127.0.0.1:{port}/health") == 200
    except OSError:
        return False


def test_boot_id_fallback(monkeypatch):
    assert len(echo_server.boot_id()) == 8

    def broken(*args, **kwargs):
        raise OSError

    monkeypatch.setattr("builtins.open", broken)
    assert echo_server.boot_id() == "00000000"
