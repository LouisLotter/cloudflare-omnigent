"""Stand-in for the proxy-everything sidecar, run on the laptop (the laptop's firewall blocks the
real sidecar's connection from Docker's bridge to workerd). For each TCP connection on
127.0.0.1:<listen>, it opens an HTTP CONNECT to workerd's egress listener with the X-Hostname
hint, as proxy-everything does, and then pipes bytes both ways. So a client on the laptop reaches
the Worker exactly as the container's intercepted traffic does: through workerd's egress
listener, the egress mapping (interceptOutboundHttp), and the WorkerEntrypoint.

  python3 -I relay.py <listen port> <egress host:port> <hostname>
"""

import asyncio
import sys

LISTEN = int(sys.argv[1])
EGRESS_HOST, EGRESS_PORT = sys.argv[2].rsplit(":", 1)
HOSTNAME = sys.argv[3]


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.write_eof()
        except (OSError, RuntimeError):
            pass


async def handle(cr: asyncio.StreamReader, cw: asyncio.StreamWriter) -> None:
    ur, uw = await asyncio.open_connection(EGRESS_HOST, int(EGRESS_PORT))
    uw.write(
        f"CONNECT {HOSTNAME}:80 HTTP/1.1\r\nHost: {HOSTNAME}:80\r\nX-Hostname: {HOSTNAME}\r\n\r\n".encode()
    )
    await uw.drain()
    head = await ur.readuntil(b"\r\n\r\n")
    status = head.split(b"\r\n", 1)[0].decode()
    print("CONNECT ->", status, flush=True)
    if b" 200 " not in head.split(b"\r\n", 1)[0] + b" ":
        cw.close()
        uw.close()
        return
    await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
    cw.close()
    uw.close()


async def main() -> None:
    server = await asyncio.start_server(handle, "127.0.0.1", LISTEN)
    print(f"relay on 127.0.0.1:{LISTEN} -> CONNECT via {EGRESS_HOST}:{EGRESS_PORT} as {HOSTNAME}", flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
