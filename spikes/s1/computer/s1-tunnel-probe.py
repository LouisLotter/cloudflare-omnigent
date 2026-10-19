#!/usr/bin/env python3
"""S1 tunnel probe, run inside the computer container by the tunnel-check phase (exec), before
the real host is released. For one response mode it opens the host's tunnel URL through the
omnigent.internal intercept and prints one JSON line describing what the container received.

  s1-tunnel-probe.py <ws url> <mode>

1. raw: the upgrade request as the host's client (websockets 14.2) sends it: a key, version 13,
   the permessage-deflate offer and Omnigent's internal Origin, plus X-S1-WS-Mode. It records the
   status line and the response headers exactly as received, and whether Sec-WebSocket-Accept
   matches the key.
2. lib: websockets.asyncio.client.connect, called as the host calls it. It records whether the
   handshake is accepted, or the exception. It then sends one frame that is not a host.hello and
   records the server's answer, a frame or a close code. Only the Omnigent server answers that
   frame, so an answer shows the whole path works in both directions.

ok is true when the handshake is accepted and the server answers. The probe uses a random host
ID that never registers, and sends no credentials (Omnigent's login is off on the S1 server).
"""

import asyncio
import base64
import hashlib
import json
import os
import socket
import sys
import time
from urllib.parse import urlparse

import websockets
import websockets.asyncio.client
from websockets.exceptions import ConnectionClosed

URL, MODE = sys.argv[1], sys.argv[2]
ORIGIN = "omnigent://internal"
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
SKIP = ("authorization", "cookie", "set-cookie", "token")


def keep(name: str) -> bool:
    return not any(word in name.lower() for word in SKIP)


def raw_handshake() -> dict:
    u = urlparse(URL)
    key = base64.b64encode(os.urandom(16)).decode()
    expected = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    request = (
        f"GET {u.path} HTTP/1.1\r\nHost: {u.netloc}\r\nUpgrade: websocket\r\n"
        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n"
        f"Origin: {ORIGIN}\r\nX-S1-WS-Mode: {MODE}\r\nUser-Agent: s1-tunnel-probe\r\n\r\n"
    )
    t0 = time.monotonic()
    out: dict = {"status": None, "headers": [], "acceptOk": False, "error": None}
    try:
        with socket.create_connection((u.hostname, u.port or 80), timeout=10) as s:
            s.sendall(request.encode())
            buf = b""
            while b"\r\n\r\n" not in buf and len(buf) < 16384:
                chunk = s.recv(4096)
                if not chunk:
                    out["error"] = "connection closed before the end of the response head"
                    break
                buf += chunk
        head = buf.split(b"\r\n\r\n", 1)[0].decode("latin-1")
        lines = head.split("\r\n") if head else []
        out["status"] = lines[0] if lines else None
        for line in lines[1:]:
            name, _, value = line.partition(":")
            if keep(name):
                out["headers"].append([name.strip(), value.strip()])
        accepts = [v for n, v in out["headers"] if n.lower() == "sec-websocket-accept"]
        out["acceptOk"] = accepts == [expected]
        out["acceptCount"] = len(accepts)
    except Exception as exc:  # noqa: BLE001 - the probe reports, never raises
        out["error"] = f"{type(exc).__name__}: {exc}"
    out["ms"] = round((time.monotonic() - t0) * 1000)
    return out


async def lib_connect() -> dict:
    t0 = time.monotonic()
    out: dict = {"accepted": False, "error": None, "headers": [], "reply": {"kind": "none"}}
    try:
        async with websockets.asyncio.client.connect(
            URL,
            additional_headers={"Origin": ORIGIN, "X-S1-WS-Mode": MODE},
            open_timeout=10,
            max_size=100 * 1024 * 1024,
        ) as ws:
            out["accepted"] = True
            out["headers"] = [[n, v] for n, v in ws.response.headers.raw_items() if keep(n)]
            await ws.send(json.dumps({"type": "s1.tunnel-probe"}))
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=10)
                out["reply"] = {"kind": "frame", "data": str(message)[:200]}
            except ConnectionClosed as exc:
                rcvd = exc.rcvd
                out["reply"] = {
                    "kind": "close",
                    "code": rcvd.code if rcvd else None,
                    "reason": rcvd.reason if rcvd else None,
                }
            except asyncio.TimeoutError:
                out["reply"] = {"kind": "none", "error": "no answer within 10 s"}
    except Exception as exc:  # noqa: BLE001 - the probe reports, never raises
        out["error"] = f"{type(exc).__module__}.{type(exc).__name__}: {exc}"
    out["ms"] = round((time.monotonic() - t0) * 1000)
    # A close frame with a code shows the server answered; an abrupt drop (no code) does not.
    reply = out["reply"]
    out["answered"] = reply["kind"] == "frame" or (reply["kind"] == "close" and reply.get("code") is not None)
    return out


raw = raw_handshake()
lib = asyncio.run(lib_connect())
print(
    json.dumps(
        {
            "mode": MODE,
            "ok": lib["accepted"] and lib["answered"],
            "websockets": websockets.__version__,
            "raw": raw,
            "lib": lib,
        }
    )
)
