"""WP2.2 staging: a stand-in for the Omnigent server container (not Omnigent, never shipped).

It answers what the server controller and the forwarding path use, so WP2.2's staging cases can
run before the server image (WP2.3) exists:

- Port 8000, as Omnigent would: GET /health; GET /v1/info (the owner initialized); GET / (a page
  for the owner's browser that holds a WebSocket and reconnects); WebSocket /ws, an echo that
  computers' probe and the browser page hold open.
- Port 8001: GET /position, the entrypoint's replication position (contracts' ReplicationPosition),
  always caught up; GET /status, the entrypoint's phase, always "running" (WP2.3's shape).
- Port 8002: GET /log?offset=N, this container's event log from byte N, which the staging run
  pulls into its results bucket.

The log holds connection events only: client label, open, close, close code, message counts,
and the container's boot. No headers other than the hop marker, no message bodies.
"""

from __future__ import annotations

import asyncio
import http
import itertools
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response

LOG_PATH = os.environ.get("WP22_LOG_PATH", "/tmp/wp22-server.log")
LOG_CHUNK = 1 << 20
BOOT_ID = secrets.token_hex(16)
CLIENT_OK = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-")

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>WP2.2 browser stream</title></head>
<body>
<h1>WP2.2: browser stream</h1>
<p>Keep this tab open until the run ends. It holds one WebSocket through the web Worker and
reconnects by itself after every drop.</p>
<p id="state">connecting</p>
<script>
const client = "browser-" + Math.random().toString(36).slice(2, 10);
let drops = 0, seq = 0, socket = null, lastClose = null;
function show(text) { document.getElementById("state").textContent = text; }
function connect() {
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?client=" + client;
  socket = new WebSocket(url);
  socket.onopen = () => {
    const gap = lastClose === null ? "" : ", back after " + (Date.now() - lastClose) + " ms";
    show("open (" + client + "), drops so far: " + drops + gap);
  };
  socket.onclose = () => { drops += 1; lastClose = Date.now(); show("dropped, reconnecting"); setTimeout(connect, 500); };
  socket.onerror = () => {};
}
setInterval(() => { if (socket && socket.readyState === 1) socket.send("ping " + (++seq)); }, 1000);
connect();
</script>
</body></html>
"""


def wall_ms() -> float:
    return round(time.time() * 1000, 3)


class EventLog:
    def __init__(self, path: str) -> None:
        self.path = path
        self.lock = threading.Lock()
        with open(path, "wb"):
            pass

    def write(self, ev: str, **fields: object) -> None:
        record = {"ev": ev, "wall": wall_ms(), "boot": BOOT_ID, **fields}
        line = json.dumps(record, separators=(",", ":"), default=str) + "\n"
        with self.lock, open(self.path, "ab") as fh:
            fh.write(line.encode())

    def read(self, offset: int) -> bytes:
        with open(self.path, "rb") as fh:
            fh.seek(max(0, offset))
            return fh.read(LOG_CHUNK)


LOG = EventLog(LOG_PATH)
COUNTER = itertools.count(1)


def client_label(path: str) -> str:
    raw = parse_qs(urlsplit(path).query).get("client", ["unnamed"])[0][:40].lower()
    return raw if raw and set(raw) <= CLIENT_OK else "invalid"


def reply(status: http.HTTPStatus, body: bytes, content_type: str) -> Response:
    headers = Headers([("Content-Type", content_type), ("Content-Length", str(len(body)))])
    return Response(status.value, status.phrase, headers, body)


def process_request(connection: ServerConnection, request):  # noqa: ANN201
    path = urlsplit(request.path).path
    if path == "/ws" and request.headers.get("Upgrade", "").lower() == "websocket":
        return None
    LOG.write("http", path=path[:80])
    if path == "/health":
        return reply(http.HTTPStatus.OK, b'{"status":"ok"}', "application/json")
    if path == "/v1/info":
        info = {"accounts_enabled": True, "needs_setup": False, "server_version": "wp22-stub"}
        return reply(http.HTTPStatus.OK, json.dumps(info).encode(), "application/json")
    if path == "/":
        return reply(http.HTTPStatus.OK, PAGE.encode(), "text/html; charset=utf-8")
    return reply(http.HTTPStatus.NOT_FOUND, b"not found\n", "text/plain")


async def handler(ws: ServerConnection) -> None:
    n = next(COUNTER)
    client = client_label(ws.request.path)
    hop = (ws.request.headers.get("x-wp22-hop") or "")[:20]
    LOG.write("open", n=n, client=client, hop=hop)
    messages = 0
    try:
        async for message in ws:
            messages += 1
            await ws.send(message)
    except ConnectionClosed:
        pass
    finally:
        LOG.write("close", n=n, client=client, code=ws.close_code, messages=messages)


class SideHandler(BaseHTTPRequestHandler):
    """Ports 8001 (position) and 8002 (log)."""

    def do_GET(self) -> None:  # noqa: N802
        parts = urlsplit(self.path)
        port = self.server.server_address[1]
        if port == 8001 and parts.path == "/status":
            body = json.dumps({"protocolVersion": 1, "bootId": BOOT_ID, "phase": "running", "recovery": None}).encode()
            content_type = "application/json"
        elif port == 8001 and parts.path == "/position":
            body = json.dumps(
                {"protocolVersion": 1, "bootId": BOOT_ID, "txid": 1, "replicatedTxid": 1}
            ).encode()
            content_type = "application/json"
        elif port == 8002 and parts.path == "/log":
            try:
                offset = int(parse_qs(parts.query).get("offset", ["0"])[0])
            except ValueError:
                self.send_error(400)
                return
            body = LOG.read(offset)
            content_type = "application/x-ndjson"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.send_header("x-wp22-boot", BOOT_ID)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


def side_servers() -> None:
    for port in (8001, 8002):
        server = ThreadingHTTPServer(("0.0.0.0", port), SideHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()


async def main() -> None:
    LOG.write("boot", pid=os.getpid())
    side_servers()
    async with serve(handler, "0.0.0.0", 8000, process_request=process_request, ping_interval=30):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
