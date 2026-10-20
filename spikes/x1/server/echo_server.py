"""X1 server container: the echo server, its log and cloudflared.

- Port 8081: WebSocket echo at /x1/echo and GET /health. P1 and P2 reach it through ServerDO's
  container port, P5 and P6 through cloudflared (the Tunnel's ingress points at
  localhost:8081). Each reply carries the probe's sequence number and this instance's identity:
  the container's boot ID and the echo process's start time, plus the identities of the hops
  that forwarded the connection (ServerDO, the handler, the policy hop), read from the upgrade
  request's x-x1-* headers when the connection opens.
- Port 8082: GET /log?offset=N returns this container's log from byte N (at most 1 MiB), with
  its ID in x-x1-log-id. ServerDO pulls it every 30 s into the results bucket. It binds every
  interface because the Durable Object reaches container ports through the container's network
  interface; the Tunnel's ingress names only 8081.
- cloudflared runs with the Tunnel token from X1_TUNNEL_TOKEN, if set, and is restarted if it
  exits. Its output lines go to the log, with the token and anything token-shaped removed.

The log holds connection events only: route, hop identities, close codes. Never other headers
or message bodies.
"""

from __future__ import annotations

import asyncio
import contextlib
import http
import itertools
import json
import os
import re
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

ECHO_PORT = int(os.environ.get("X1_ECHO_PORT", "8081"))
LOG_PORT = int(os.environ.get("X1_LOG_PORT", "8082"))
LOG_PATH = os.environ.get("X1_LOG_PATH", "/tmp/x1-server.log")
CLOUDFLARED = os.environ.get("X1_CLOUDFLARED", "/usr/local/bin/cloudflared")
LOG_CHUNK = 1 << 20
ROUTE = re.compile(r"^p[1-6]$")
HOP_HEADERS = {
    "x-x1-route": "route",
    "x-x1-serverdo": "serverdo",
    "x-x1-handler": "handler",
    "x-x1-policy": "policy",
    "x-cfo-generation": "generation",
}
# A Tunnel token is base64 JSON ("eyJ…"); remove anything shaped like one, as well as the value.
TOKEN_SHAPED = re.compile(r"eyJ[A-Za-z0-9+/=_-]{16,}")


def boot_id() -> str:
    try:
        with open("/proc/sys/kernel/random/boot_id") as fh:
            return fh.read().strip().replace("-", "")[:8]
    except OSError:
        return "00000000"


def wall_ms() -> float:
    return time.time() * 1000


def mono_ms() -> float:
    return time.monotonic() * 1000


class EventLog:
    """Append-only JSON Lines log, with secret values removed from every line."""

    def __init__(self, path: str, secrets: list[str]) -> None:
        self.path = path
        self.secrets = [s for s in secrets if s]
        self.lock = threading.Lock()
        with open(path, "wb"):
            pass

    def redact(self, text: str) -> str:
        for secret in self.secrets:
            text = text.replace(secret, "<redacted>")
        return TOKEN_SHAPED.sub("<redacted>", text)

    def write(self, src: str, ev: str, **fields: object) -> None:
        record = {"src": src, "ev": ev, "wall": round(wall_ms(), 3), "mono": round(mono_ms(), 3)}
        record.update(fields)
        line = self.redact(json.dumps(record, separators=(",", ":"), default=str)) + "\n"
        with self.lock, open(self.path, "ab") as fh:
            fh.write(line.encode())

    def read(self, offset: int) -> bytes:
        with open(self.path, "rb") as fh:
            fh.seek(max(0, offset))
            return fh.read(LOG_CHUNK)


def echo_reply(data: object, identity: dict, now: float) -> str | None:
    """The reply to one probe message, or None if it is not a valid echo. Mirrors echoReply in
    transport/src/lib.js: only the probe's own fields are echoed."""
    if not isinstance(data, str) or len(data) > 4096:
        return None
    try:
        message = json.loads(data)
    except ValueError:
        return None
    if not isinstance(message, dict) or message.get("t") != "echo":
        return None
    route, conn, seq, sent = (message.get(k) for k in ("route", "conn", "seq", "sent"))
    if not isinstance(route, str) or not ROUTE.match(route):
        return None
    if type(conn) is not int or type(seq) is not int:
        return None
    if type(sent) not in (int, float):
        return None
    return json.dumps(
        {
            "t": "echo",
            "route": route,
            "conn": conn,
            "seq": seq,
            "sent": sent,
            "id": identity,
            "at": now,
        },
        separators=(",", ":"),
    )


class EchoServer:
    def __init__(self, log: EventLog) -> None:
        self.log = log
        self.identity = {
            "by": "server",
            "boot": boot_id(),
            "start": int(wall_ms()),
            "pid": os.getpid(),
        }
        self.counter = itertools.count(1)

    def process_request(self, connection: ServerConnection, request):  # noqa: ANN201
        path = urlsplit(request.path).path
        if path == "/health":
            return connection.respond(http.HTTPStatus.OK, "ok\n")
        if path != "/x1/echo":
            return connection.respond(http.HTTPStatus.NOT_FOUND, "not found\n")
        return None

    async def handler(self, ws: ServerConnection) -> None:
        n = next(self.counter)
        hops = {}
        for header, key in HOP_HEADERS.items():
            value = ws.request.headers.get(header)
            if value is not None:
                hops[key] = value[:40]
        identity = {**self.identity, **{k: v for k, v in hops.items() if k != "generation"}}
        self.log.write("echo", "open", n=n, **hops)
        replies = 0
        try:
            async for message in ws:
                reply = echo_reply(message, identity, round(wall_ms(), 3))
                if reply is not None:
                    await ws.send(reply)
                    replies += 1
        except ConnectionClosed:
            pass
        finally:
            self.log.write(
                "echo",
                "close",
                n=n,
                route=hops.get("route"),
                code=ws.close_code,
                reason=(ws.close_reason or "")[:120],
                replies=replies,
            )


def log_server(log: EventLog, log_id: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
            parts = urlsplit(self.path)
            if parts.path != "/log":
                self.send_error(404)
                return
            try:
                offset = int(parse_qs(parts.query).get("offset", ["0"])[0])
            except ValueError:
                self.send_error(400)
                return
            body = log.read(offset)
            self.send_response(200)
            self.send_header("content-type", "application/x-ndjson")
            self.send_header("content-length", str(len(body)))
            self.send_header("x-x1-log-id", log_id)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:  # silence the stdlib's access log
            return

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)  # noqa: S104 - see the module doc
    threading.Thread(target=server.serve_forever, name="x1-log", daemon=True).start()
    return server


# cloudflared's connection events, by the start of their message. Workers VPC needs QUIC
# (outbound UDP 7844); a fallback to HTTP/2 shows here as "fallback" and in the protocol field.
CLOUDFLARED_EVENTS = (
    ("Registered tunnel connection", "registered"),
    ("Unregistered tunnel connection", "unregistered"),
    ("Connection terminated", "terminated"),
    ("Switching to fallback protocol", "fallback"),
    ("Failed to dial", "dial-failed"),
    ("Retrying connection", "retrying"),
    ("Serve tunnel error", "serve-error"),
    ("Lost connection", "lost"),
)
CLOUDFLARED_FIELDS = ("connIndex", "protocol", "location", "event", "ip")
KEY_VALUE = re.compile(r'(\w+)=("[^"]*"|\S+)')


def cloudflared_event(line: str) -> dict | None:
    """A connection event in one cloudflared log line: its kind and the protocol, connection
    index, edge location and address it names. None for any other line."""
    kind = next((k for marker, k in CLOUDFLARED_EVENTS if marker in line), None)
    if kind is None and "fallback" not in line.lower():
        return None
    fields = {k: v.strip('"') for k, v in KEY_VALUE.findall(line) if k in CLOUDFLARED_FIELDS}
    level = (
        line.split()[1]
        if len(line.split()) > 1 and line.split()[1] in ("INF", "WRN", "ERR", "DBG")
        else None
    )
    return {"kind": kind or "fallback", "level": level, **fields}


async def run_cloudflared(log: EventLog, token: str, stop: asyncio.Event) -> None:
    """cloudflared with the Tunnel token, restarted if it exits, its output into the log."""
    restarts = 0
    while not stop.is_set():
        log.write("cloudflared", "start", restarts=restarts)
        process = await asyncio.create_subprocess_exec(
            CLOUDFLARED,
            "tunnel",
            "--no-autoupdate",
            "--loglevel",
            "info",
            "run",
            "--token",
            token,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        assert process.stdout is not None
        try:
            while True:
                line = await process.stdout.readline()
                if not line:
                    break
                text = line.decode(errors="replace").rstrip()[:500]
                log.write("cloudflared", "line", line=text)
                event = cloudflared_event(text)
                if event is not None:
                    log.write("cloudflared", "conn", **event)
            code = await process.wait()
        finally:
            if process.returncode is None:  # cancelled: the server is stopping
                process.kill()
                await process.wait()
        log.write("cloudflared", "exit", code=code)
        restarts += 1
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=2.0)


async def main() -> None:
    token = os.environ.get("X1_TUNNEL_TOKEN", "")
    log = EventLog(LOG_PATH, [token])
    echo = EchoServer(log)
    log_id = f"{echo.identity['boot']}-{echo.identity['start']}"
    log.write("server", "start", identity=echo.identity, tunnel=bool(token))
    log_server(log, log_id, LOG_PORT)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    tasks = []
    if token:
        tasks.append(asyncio.create_task(run_cloudflared(log, token, stop)))
    async with serve(
        echo.handler,
        "0.0.0.0",  # noqa: S104 - the container port and cloudflared both need it
        ECHO_PORT,
        process_request=echo.process_request,
        ping_interval=None,
        compression=None,
        max_size=1 << 16,
        server_header=None,
    ):
        await stop.wait()
    log.write("server", "stop")
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
