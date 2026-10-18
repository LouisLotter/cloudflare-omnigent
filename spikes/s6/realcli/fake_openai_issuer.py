"""A fake OpenAI auth issuer on loopback, so the real Codex binary can run its device-code
login, token refresh and logout against synthetic tokens with no network access (spike S6).

Codex 0.162.1 takes the issuer from the hidden `--experimental_issuer` flag and the refresh and
revoke endpoints from CODEX_REFRESH_TOKEN_URL_OVERRIDE and CODEX_REVOKE_TOKEN_URL_OVERRIDE.
Tokens are synthetic and carry the repository's canary prefix (in a JWT's signature segment,
where it stays readable), so any leak into the results is detectable. The request log records
methods, paths and grant types only.

  python3 -I fake_openai_issuer.py --port 8765 --log /tmp/issuer.jsonl [--access-ttl 60]
"""

from __future__ import annotations

import argparse
import base64
import json
import secrets
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CANARY_PREFIX = "CFO_" + "CANARY_"
STATE = {"refresh": None, "retired": set(), "polls": 0}


def b64(obj: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")


def jwt(claims: dict) -> str:
    return f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64(claims)}.{CANARY_PREFIX}S6sig{secrets.token_hex(8)}"


def tokens(access_ttl: int) -> dict:
    now = int(time.time())
    auth = {"chatgpt_plan_type": "plus", "chatgpt_user_id": "user-synthetic", "chatgpt_account_id": "acct-synthetic"}
    refresh = f"{CANARY_PREFIX}S6refresh{secrets.token_hex(12)}"
    if STATE["refresh"]:
        STATE["retired"].add(STATE["refresh"])
    STATE["refresh"] = refresh
    return {
        "id_token": jwt({"email": "synthetic@example.invalid", "https://api.openai.com/auth": auth, "iat": now, "exp": now + 3600}),
        "access_token": jwt({"https://api.openai.com/auth": auth, "iat": now, "exp": now + access_ttl}),
        "refresh_token": refresh,
        "token_type": "Bearer",
        "expires_in": access_ttl,
    }


class Handler(BaseHTTPRequestHandler):
    access_ttl = 3600
    log_path = "/tmp/issuer.jsonl"

    def log_message(self, *args):  # silence the default stderr log
        pass

    def _log(self, **kw):
        with open(self.log_path, "a") as f:
            f.write(json.dumps({"at": time.time(), "method": self.command, "path": self.path.split("?")[0], **kw}) + "\n")

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
        ctype = self.headers.get("Content-Type", "")
        if "json" in ctype:
            return json.loads(raw or b"{}")
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode()).items()}

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._body()
        if path.endswith("/deviceauth/usercode"):
            self._log(step="usercode")
            return self._send(200, {"device_auth_id": "dev-synthetic", "user_code": "S6TEST-0000", "interval": "1"})
        if path.endswith("/deviceauth/token"):
            STATE["polls"] += 1
            self._log(step="poll", n=STATE["polls"])
            if STATE["polls"] < 2:
                return self._send(403, {"error": "authorization_pending"})
            return self._send(200, {"authorization_code": "code-synthetic", "code_challenge": "c", "code_verifier": "v"})
        if path == "/oauth/token":
            grant = body.get("grant_type")
            self._log(step="token", grant_type=grant)
            if grant == "refresh_token":
                presented = body.get("refresh_token")
                if presented in STATE["retired"]:
                    return self._send(401, {"error": {"code": "refresh_token_reused", "message": "reused"}})
                if presented != STATE["refresh"]:
                    return self._send(401, {"error": {"code": "refresh_token_invalidated", "message": "invalid"}})
            # Only the first login gets the short lifetime, so exactly one refresh follows.
            return self._send(200, tokens(self.access_ttl if grant != "refresh_token" else 3600))
        if path == "/oauth/revoke":
            self._log(step="revoke", token_type_hint=body.get("token_type_hint"))
            return self._send(200, {})
        self._log(step="other")
        return self._send(503, {"error": "fake issuer: not implemented"})

    def do_GET(self):
        self._log(step="other")
        self._send(503, {"error": "fake issuer: not implemented"})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--log", default="/tmp/issuer.jsonl")
    ap.add_argument("--access-ttl", type=int, default=3600)
    a = ap.parse_args()
    Handler.access_ttl = a.access_ttl
    Handler.log_path = a.log
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
