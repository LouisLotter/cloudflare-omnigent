"""A stand-in for the Omnigent app, for the entrypoint's process tests.

Serves ``GET /health`` and ``POST /write?value=<v>`` (one committed row each) on ``PORT``,
writing the database at ``CFO_DB_PATH`` in WAL mode, as Omnigent does. At start it records
whether Litestream's control socket already answered, to pin the start order. Exits 0 on
SIGTERM, or at once with ``FAKE_APP_EXIT_CODE`` when that is set. ``FAKE_APP_START_DELAY_S``
delays its listening, as Omnigent's imports and migrations do; ``FAKE_APP_HANG`` keeps it from
ever listening, as a hung initialization would (it still exits on SIGTERM).
"""

from __future__ import annotations

import json
import os
import signal
import socket
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def litestream_answers(path: str) -> bool:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            sock.connect(path)
            sock.sendall(b"GET /list HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            return sock.recv(64).startswith(b"HTTP/1.1 200")
    except OSError:
        return False


def main() -> None:
    db_path = os.environ["CFO_DB_PATH"]
    marker = Path(os.environ["FAKE_APP_MARKER"])
    marker.write_text(
        json.dumps(
            {
                "litestream_ready_at_start": litestream_answers(
                    os.environ["CFO_LITESTREAM_SOCKET"]
                ),
                "env": {
                    k: os.environ.get(k)
                    for k in (
                        "OMNIGENT_FEATURES",
                        "OMNIGENT_AUTH_PROVIDER",
                        "DATABASE_URL",
                        "LITESTREAM_ACCESS_KEY_ID",
                        "LITESTREAM_SECRET_ACCESS_KEY",
                        "OMNIGENT_DATABRICKS_CLIENT_ID",
                        "OMNIGENT_CREDENTIAL_CIPHER",
                        "OMNIGENT_WS_ALLOWED_ORIGINS",
                    )
                },
            }
        )
    )
    code = os.environ.get("FAKE_APP_EXIT_CODE")
    if code is not None:
        sys.exit(int(code))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if os.environ.get("FAKE_APP_HANG"):
        while True:
            time.sleep(1)
    time.sleep(float(os.environ.get("FAKE_APP_START_DELAY_S", "0")))
    conn = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE IF NOT EXISTS t (value TEXT)")
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def _send(self, status: int, payload: object) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            self._send(200, {"status": "ok"})

        def do_POST(self) -> None:  # noqa: N802
            value = parse_qs(urlsplit(self.path).query).get("value", ["x"])[0]
            with lock:
                conn.execute("INSERT INTO t (value) VALUES (?)", (value,))
            self._send(200, {"written": value})

    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    server.serve_forever()
    conn.close()


if __name__ == "__main__":
    main()
