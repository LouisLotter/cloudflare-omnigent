"""The supervisor's command port: ``POST /v1/commands`` on 8090, for WorkspaceDO only.

Reached over the container port (Cloudflare Containers expose no inbound route of their own).
Plain HTTP, one bounded request per command; bodies over the computer API's 512 KiB limit are
refused before they are read. Nothing is logged but the command type and status: a command can
carry a launch token or a credential bundle.
"""

from __future__ import annotations

import json
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .contract import MAX_BODY_BYTES, error_body
from .paths import SUPERVISOR_COMMANDS_PATH


class _Handler(BaseHTTPRequestHandler):
    server_version = "cfo-supervisor"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802 - the stdlib's name
        if self.path != SUPERVISOR_COMMANDS_PATH:
            self._send(404, error_body("not_found", "no such path"))
            return
        try:
            length = int(self.headers.get("content-length", ""))
        except ValueError:
            self._send(411, error_body("bad_request", "a content length is required"))
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self.close_connection = True
            self._send(413, error_body("bad_request", "the body is too large"))
            return
        body = self.rfile.read(length)
        status, reply = self.server.supervisor.handle(body)  # type: ignore[attr-defined]
        self._send(status, reply)

    def do_GET(self) -> None:  # noqa: N802
        self._send(405, error_body("bad_request", "commands are POST"))

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        return  # no request logging: bodies and paths are never written anywhere


class CommandServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], supervisor: Any) -> None:
        super().__init__(address, _Handler)
        self.supervisor = supervisor

    def server_bind(self) -> None:
        """Bind without ``HTTPServer.server_bind``'s ``socket.getfqdn()``: on a Cloudflare
        ``durable_object`` container the hostname is the Durable Object's 64-character ID,
        longer than a DNS label, and resolving it raises ``UnicodeError: label too long``. The
        name is only ever used for CGI's ``SERVER_NAME``; nothing here depends on the hostname.
        """
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)

    def start_in_thread(self) -> threading.Thread:
        thread = threading.Thread(target=self.serve_forever, name="commands", daemon=True)
        thread.start()
        return thread
