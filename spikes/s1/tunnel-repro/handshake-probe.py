"""Handshake probe for the host tunnel, run inside the S1 computer image (websockets 14.2, the
host's own library) with --network host. See run.sh.

  python3 -I /probe.py ws://127.0.0.1:18787/v1/hosts/<id>/tunnel

1. A raw handshake that offers permessage-deflate as websockets does: prints the status line and
   the response headers exactly as received.
2. websockets.asyncio.client.connect with its default compression, then with compression=None:
   prints whether the handshake is accepted, and if so what the first second brings.
"""

import asyncio
import base64
import os
import socket
import sys
import traceback
from urllib.parse import urlparse

import websockets
import websockets.asyncio.client

URL = sys.argv[1]
ORIGIN = "omnigent://internal"


def raw_handshake() -> None:
    u = urlparse(URL)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET {u.path} HTTP/1.1\r\nHost: {u.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n"
        f"Origin: {ORIGIN}\r\nUser-Agent: s1-probe\r\n\r\n"
    )
    s = socket.create_connection((u.hostname, u.port or 80), timeout=10)
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    head = buf.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    print("RAW response head:")
    for line in head.split("\r\n"):
        print("   ", line)
    expected = base64.b64encode(
        __import__("hashlib").sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
    ).decode()
    print("    (expected Sec-WebSocket-Accept:", expected + ")")
    s.close()


async def lib_connect(compression) -> None:
    label = f"websockets {websockets.__version__} compression={compression!r}"
    try:
        async with websockets.asyncio.client.connect(
            URL,
            additional_headers={"Origin": ORIGIN},
            compression=compression,
            open_timeout=10,
        ) as ws:
            print(f"{label}: handshake ACCEPTED; response headers:")
            for k, v in ws.response.headers.raw_items():
                print("   ", f"{k}: {v}")
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=1.5)
                print("    first message:", str(msg)[:200])
            except asyncio.TimeoutError:
                print("    no message within 1.5 s (connection still open)")
            except websockets.exceptions.ConnectionClosed as exc:
                print("    closed:", exc.rcvd, exc.sent)
    except Exception as exc:  # noqa: BLE001
        print(f"{label}: handshake FAILED: {type(exc).__module__}.{type(exc).__name__}: {exc}")
        cause = exc.__cause__ or exc.__context__
        if cause:
            print(f"    cause: {type(cause).__name__}: {cause}")
        resp = getattr(exc, "response", None)
        if resp is not None:
            print("    response status:", resp.status_code)
            for k, v in resp.headers.raw_items():
                print("   ", f"{k}: {v}")


raw_handshake()
asyncio.run(lib_connect("deflate"))
asyncio.run(lib_connect(None))
