"""A fake Anthropic OAuth and API endpoint for spike S6, served over TLS inside an isolated
Docker network, so the real Claude Code binary can refresh a synthetic login while we watch how
it rewrites ~/.claude/.credentials.json. Nothing reaches Anthropic: the network is internal and
only these names resolve, to this server, with a certificate from a throwaway local CA.

  python3 -I fake_anthropic.py --cert cert.pem --key key.pem --log /out/requests.jsonl

Tokens are synthetic and carry the repository's canary prefix. The log keeps methods, paths and
grant types only.

With --answer-messages (S6 follow-up, DC-45), it also plays the rest of a sign-in and a request:
the token response carries a synthetic account and organization, /api/oauth/profile and
/api/oauth/claude_cli/roles answer with synthetic profile values, and /v1/messages answers "OK"
(streamed or not). Every synthetic identity value is distinct, so the key report can tell which
one went where.
"""

from __future__ import annotations

import argparse
import json
import secrets
import ssl
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CANARY_PREFIX = "CFO_" + "CANARY_"
ACCOUNT = {"uuid": "5a5a5a5a-0000-4000-8000-000000000001", "email": "s6-synthetic@example.invalid",
           "email_address": "s6-synthetic@example.invalid", "full_name": "S6 Synthetic Person",
           "display_name": "S6 Synthetic", "has_claude_max": True, "has_claude_pro": False,
           "created_at": "2026-01-01T00:00:00Z"}
ORGANIZATION = {"uuid": "5a5a5a5a-0000-4000-8000-000000000002", "name": "S6 Synthetic Organization",
                "organization_type": "claude_max", "rate_limit_tier": "default_claude_max_20x",
                "billing_type": "stripe_subscription", "has_extra_usage_enabled": False,
                "subscription_created_at": "2026-01-01T00:00:00Z", "plan_display_name": "Max"}
SCOPE = "user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload"


class Handler(BaseHTTPRequestHandler):
    log_path = "/tmp/anthropic.jsonl"
    answer_messages = False
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
            body = {
                "access_token": f"{CANARY_PREFIX}S6access{secrets.token_hex(12)}",
                "refresh_token": f"{CANARY_PREFIX}S6refresh{secrets.token_hex(12)}",
                "expires_in": 28800,
                "token_type": "Bearer",
                "scope": "user:inference user:profile user:sessions:claude_code",
            }
            if self.answer_messages:
                body.update(scope=SCOPE, account={"uuid": ACCOUNT["uuid"], "email_address": ACCOUNT["email"]},
                            organization={"uuid": ORGANIZATION["uuid"], "name": ORGANIZATION["name"]})
            return self._send(200, body)
        self._log()
        if path.startswith("/v1/messages") and self.answer_messages:
            return self._message(body)
        if path.startswith("/v1/messages"):
            return self._send(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "fake endpoint"}})
        return self._send(404, {"type": "error", "error": {"type": "not_found_error", "message": "fake endpoint"}})

    def do_GET(self):
        self._log()
        path = self.path.split("?")[0]
        if self.answer_messages and path == "/api/oauth/profile":
            return self._send(200, {"account": ACCOUNT, "organization": ORGANIZATION})
        if self.answer_messages and path == "/api/oauth/claude_cli/roles":
            return self._send(200, {"organization_role": "admin", "workspace_role": None,
                                    "organization_name": ORGANIZATION["name"]})
        self._send(404, {"type": "error", "error": {"type": "not_found_error", "message": "fake endpoint"}})

    def _message(self, body: dict):
        msg = {"id": "msg_s6", "type": "message", "role": "assistant", "model": body.get("model", "claude"),
               "content": [{"type": "text", "text": "OK"}], "stop_reason": "end_turn", "stop_sequence": None,
               "usage": {"input_tokens": 1, "output_tokens": 1}}
        if not body.get("stream"):
            return self._send(200, msg)
        events = [
            ("message_start", {"type": "message_start", "message": {**msg, "content": [], "stop_reason": None}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "OK"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                               "usage": {"output_tokens": 1}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        raw = "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--log", default="/tmp/anthropic.jsonl")
    ap.add_argument("--answer-messages", action="store_true")
    a = ap.parse_args()
    Handler.log_path = a.log
    Handler.answer_messages = a.answer_messages
    srv = ThreadingHTTPServer(("0.0.0.0", 443), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(a.cert, a.key)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
