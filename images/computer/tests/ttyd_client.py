"""A minimal WebSocket client for ttyd 1.7.7, standard library only (the image tests, WP3.28).

It speaks to ttyd as WorkspaceDO's bridge does: the ``tty`` subprotocol, the URL arguments
WorkspaceDO puts in its dial, ttyd's first message (its auth token and the terminal's size), then
input frames prefixed ``0``. Output frames from ttyd carry ``0`` first as well. ``drop()`` cuts
the TCP connection with no close frame, as a Durable Object reset does.
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import socket
import struct
import time
import urllib.parse


class Closed(Exception):
    def __init__(self, code: int | None) -> None:
        super().__init__(f"closed ({code})")
        self.code = code


class TtydClient:
    def __init__(
        self,
        port: int,
        args: list[str],
        *,
        host: str = "127.0.0.1",
        cols: int = 100,
        rows: int = 30,
        timeout: float = 10.0,
    ) -> None:
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        # Encoded as WorkspaceDO's URLSearchParams encodes them: ttyd (libwebsockets) splits the
        # query at a raw `&` or `;` and decodes `%XX` and `+` in each part.
        query = "&".join(f"arg={urllib.parse.quote(a, safe='')}" for a in args)
        request = (
            f"GET /ws{'?' + query if query else ''} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
            "Sec-WebSocket-Protocol: tty\r\n\r\n"
        )
        self.sock.sendall(request.encode())
        self._buf = b""
        while b"\r\n\r\n" not in self._buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise Closed(None)
            self._buf += chunk
        head, self._buf = self._buf.split(b"\r\n\r\n", 1)
        self.status = int(head.split(b" ", 2)[1])
        if self.status != 101:
            raise Closed(None)
        self.output = b""
        self.close_code: int | None = None
        self._send(json.dumps({"AuthToken": "", "columns": cols, "rows": rows}).encode())

    # -- frames ------------------------------------------------------------------------------

    def _send(self, payload: bytes, opcode: int = 0x2) -> None:
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 1 << 16:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def _read(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise Closed(self.close_code)
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _frame(self) -> tuple[int, bytes]:
        b0, b1 = self._read(2)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack("!H", self._read(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", self._read(8))[0]
        return b0 & 0x0F, self._read(n)

    def pump(self, until: float) -> None:
        """Reads frames until ``until`` (monotonic); raises Closed when ttyd closes."""
        while time.monotonic() < until:
            self.sock.settimeout(max(0.01, until - time.monotonic()))
            try:
                opcode, payload = self._frame()
            except TimeoutError:
                return
            if opcode == 0x8:
                self.close_code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
                raise Closed(self.close_code)
            if opcode == 0x9:  # ttyd pings every 5 s and drops a client that never answers
                self._send(payload, opcode=0xA)
                continue
            if payload[:1] == b"0":
                self.output += payload[1:]

    def wait_for(self, needle: bytes, timeout: float = 10.0) -> bytes:
        """The output once it holds ``needle``."""
        end = time.monotonic() + timeout
        while needle not in self.output:
            if time.monotonic() > end:
                raise AssertionError(f"no {needle!r} in {self.output[-400:]!r}")
            self.pump(min(end, time.monotonic() + 0.2))
        return self.output

    def wait_closed(self, timeout: float = 10.0) -> int | None:
        end = time.monotonic() + timeout
        try:
            while time.monotonic() < end:
                self.pump(min(end, time.monotonic() + 0.2))
        except Closed as exc:
            return exc.code
        raise AssertionError("ttyd did not close the stream")

    def type(self, text: str) -> None:
        self._send(b"0" + text.encode())

    def drop(self) -> None:
        """Cuts the connection with no close frame (a reset)."""
        with contextlib.suppress(OSError):
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        self.sock.close()

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self._send(struct.pack("!H", 1000), opcode=0x8)
        self.sock.close()


def shell_pid(client: TtydClient, marker: str, timeout: float = 15.0) -> int:
    """The shell's ``$$``, printed between two markers so the echo of the typed line never
    matches."""
    client.type(f"echo {marker}-$((1+0))-$$-end\r")
    end = time.monotonic() + timeout
    needle = f"{marker}-1-".encode()
    while True:
        out = client.output
        at = out.find(needle)
        if at >= 0:
            tail = out[at + len(needle) :]
            stop = tail.find(b"-end")
            if stop > 0 and tail[:stop].isdigit():
                return int(tail[:stop])
        if time.monotonic() > end:
            raise AssertionError(f"no $$ in {out[-400:]!r}")
        client.pump(min(end, time.monotonic() + 0.2))
