"""WP3.3 staging: the start bench's container. It only answers GET /health on port 8090 (the
supervisor's port), with its boot ID and how long since the process started, so the bench can
tell when a started container first answers."""

from __future__ import annotations

import json
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BOOT = secrets.token_hex(8)
STARTED = time.time()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_error(404)
            return
        body = json.dumps({"boot": BOOT, "upMs": round((time.time() - STARTED) * 1000)}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
