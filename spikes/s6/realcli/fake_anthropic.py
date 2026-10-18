"""A fake Anthropic OAuth and API endpoint for spike S6, served over TLS inside an isolated
Docker network, so the real Claude Code binary can refresh a synthetic login while we watch how
it rewrites ~/.claude/.credentials.json. Nothing reaches Anthropic: the network is internal and
only these names resolve, to this server, with a certificate from a throwaway local CA.

  python3 -I fake_anthropic.py --cert cert.pem --key key.pem --log /out/requests.jsonl

Tokens are synthetic and carry the repository's canary prefix. The log keeps methods, paths and
grant types only.
"""

from __future__ import annotations

import argparse
import json
import secrets
import ssl
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CANARY_PREFIX = "CFO_" + "CANARY_"


class Handler(BaseHTTPRequestHandler):
    log_path = "/tmp/anthropic.jsonl"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _log(self, **kw):
        with open(self.log_path, "a") as f:
            f.write(json.dumps({"at": time.time(), "method": self.command, "host": self.headers.get("Host"),
                                "path": self.path.split("?")[0], **kw}) + "\n")

    def _send(self, status: int, body: dict):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._body()
        if path == "/v1/oauth/token":
            self._log(grant_type=body.get("grant_type"))
            return self._send(200, {
                "access_token": f"{CANARY_PREFIX}S6access{secrets.token_hex(12)}",
                "refresh_token": f"{CANARY_PREFIX}S6refresh{secrets.token_hex(12)}",
                "expires_in": 28800,
                "token_type": "Bearer",
                "scope": "user:inference user:profile user:sessions:claude_code",
            })
        self._log()
        if path.startswith("/v1/messages"):
            return self._send(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "fake endpoint"}})
        return self._send(404, {"type": "error", "error": {"type": "not_found_error", "message": "fake endpoint"}})

    def do_GET(self):
        self._log()
        self._send(404, {"type": "error", "error": {"type": "not_found_error", "message": "fake endpoint"}})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--log", default="/tmp/anthropic.jsonl")
    a = ap.parse_args()
    Handler.log_path = a.log
    srv = ThreadingHTTPServer(("0.0.0.0", 443), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(a.cert, a.key)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
