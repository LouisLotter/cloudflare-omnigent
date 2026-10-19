"""Fake egress, to tell apart what the host's client can have seen on Cloudflare. The host's
plain HTTP requests are piped to the real server (through wrangler dev on 127.0.0.1:18787); each
WebSocket upgrade to /v1/hosts/<id>/tunnel is answered according to SCENARIO:

  bad-accept      101 with Upgrade and Connection, but a Sec-WebSocket-Accept for another key,
                  as a relay that writes the Worker's Response headers verbatim would send (the
                  upstream 101 is for workerd's own key), and the request's extension offer
                  echoed, as workerd adds it when the Response has none
  bad-extension   101 with the right Accept, but the extension offer echoed verbatim
  drop-after-101  a correct 101, then the connection is closed
  close-at-once   the connection is closed with no response

For each upgrade it prints the time since the previous one and how long the client kept the
connection after the answer.

  python3 -I fake-egress.py <listen port> <scenario>
"""

import asyncio
import base64
import hashlib
import sys
import time

LISTEN = int(sys.argv[1])
SCENARIO = sys.argv[2]
UPSTREAM = ("127.0.0.1", 18787)
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
last = [None]


def accept_for(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


async def pipe(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    try:
        while data := await r.read(65536):
            w.write(data)
            await w.drain()
    except ConnectionError:
        pass
    finally:
        try:
            w.write_eof()
        except (OSError, RuntimeError):
            pass


async def handle(cr: asyncio.StreamReader, cw: asyncio.StreamWriter) -> None:
    head = await cr.readuntil(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    headers = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:] if l)}
    if headers.get("upgrade", "").lower() != "websocket":
        ur, uw = await asyncio.open_connection(*UPSTREAM)
        uw.write(head)
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
        cw.close()
        return
    now = time.monotonic()
    gap = None if last[0] is None else now - last[0]
    last[0] = now
    key = headers.get("sec-websocket-key", "")
    offer = headers.get("sec-websocket-extensions", "")
    if SCENARIO == "close-at-once":
        cw.close()
        print(f"upgrade gap={gap and round(gap, 2)}s answered=close", flush=True)
        return
    accept = accept_for("not-the-host-key==") if SCENARIO == "bad-accept" else accept_for(key)
    extra = f"Sec-WebSocket-Extensions: {offer}\r\n" if SCENARIO in ("bad-accept", "bad-extension") and offer else ""
    cw.write(
        (
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n{extra}\r\n"
        ).encode()
    )
    await cw.drain()
    t = time.monotonic()
    if SCENARIO == "drop-after-101":
        cw.close()
        print(f"upgrade gap={gap and round(gap, 2)}s answered=101-then-close", flush=True)
        return
    data = await cr.read(1)  # b"" when the client closes
    print(
        f"upgrade gap={gap and round(gap, 2)}s answered=101({SCENARIO}) "
        f"client {'closed' if not data else 'sent a frame'} after {round((time.monotonic() - t) * 1000)} ms",
        flush=True,
    )
    cw.close()


async def main() -> None:
    server = await asyncio.start_server(handle, "127.0.0.1", LISTEN)
    print(f"fake egress on 127.0.0.1:{LISTEN}, scenario {SCENARIO}", flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
