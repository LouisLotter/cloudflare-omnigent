"""A stand-in for Litestream's control socket, for tests that need no real Litestream.

It answers ``POST /sync`` and ``GET /list`` on a Unix socket, the way Litestream 0.5.17 does
(``server.go``), and records every request body so tests can assert that no ``wait`` sync is
ever sent. Its replica either keeps up (``healthy``), never advances (``blocked``), fails
(``error``) or never answers (``hang``).
"""

from __future__ import annotations

import json
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


class FakeLitestream:
    def __init__(self, socket_path: Path, db_path: str = "/data/omnigent.db") -> None:
        self.socket_path = socket_path
        self.db_path = db_path
        self.mode = "healthy"
        #: In ``healthy`` mode the replica catches up only after this many further syncs.
        self.lag_syncs = 0
        self.hang_s = 30.0
        self.txid = 1
        self.replicated = 1
        self._pending: list[tuple[int, int]] = []  # (txid, syncs left before replicated)
        self.sync_bodies: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self._server: _Server | None = None
        self._thread: threading.Thread | None = None

    # behaviour -------------------------------------------------------------------------
    def _sync(self) -> tuple[int, dict[str, Any]]:
        with self.lock:
            mode = self.mode
        if mode == "hang":
            time.sleep(self.hang_s)
        if mode == "error":
            return 500, {"error": "sync database: injected failure"}
        with self.lock:
            # Every sync turns "new commits" into an LTX file: the local position advances.
            self.txid += 1
            if mode == "healthy":
                self._pending.append((self.txid, self.lag_syncs))
                still: list[tuple[int, int]] = []
                for txid, left in self._pending:
                    if left <= 0:
                        self.replicated = max(self.replicated, txid)
                    else:
                        still.append((txid, left - 1))
                self._pending = still
            return 200, {
                "status": "synced_local",
                "path": self.db_path,
                "txid": self.txid,
                "replicated_txid": self.replicated,
            }

    def catch_up(self) -> None:
        with self.lock:
            self.replicated = self.txid
            self._pending.clear()

    # server ----------------------------------------------------------------------------
    def start(self) -> FakeLitestream:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def _reply(self, status: int, payload: Any) -> None:
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw or b"{}")
                except ValueError:
                    self._reply(400, {"error": "invalid request body"})
                    return
                with fake.lock:
                    fake.sync_bodies.append(body)
                if self.path != "/sync":
                    self._reply(404, {"error": "not found"})
                    return
                if body.get("path") != fake.db_path:
                    self._reply(404, {"error": "database not found"})
                    return
                self._reply(*fake._sync())

            def do_GET(self) -> None:  # noqa: N802
                if self.path.startswith("/list"):
                    self._reply(
                        200, {"databases": [{"path": fake.db_path, "status": "replicating"}]}
                    )
                else:
                    self._reply(404, {"error": "not found"})

        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        if self.socket_path.exists():
            self.socket_path.unlink()
        self._server = _Server(str(self.socket_path), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self.socket_path.exists():
            self.socket_path.unlink()
