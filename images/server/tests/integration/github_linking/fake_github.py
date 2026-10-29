"""A stand-in for github.com and api.github.com, for the GitHub-linking end-to-end test (WP5.9).

Run inside a container on the test's Docker network under the aliases ``github.com`` and
``api.github.com``, with a certificate for both from the test's own authority, so the server's
real Omnigent and a computer's real git and gh reach it by GitHub's own names:

    python -I fake_github.py /fake/config.json

What it serves, as GitHub does for a GitHub App:
- ``GET github.com/login/oauth/authorize``: checks the App's client ID and callback, and sends the
  browser back to the callback with a one-time code and the given state;
- ``POST github.com/login/oauth/access_token``: exchanges that code, once, for the user's token
  set, only with the App's client ID, client secret and callback;
- ``GET api.github.com/user`` and ``/user/repos``: only with the user's access token;
- one repository over git's dumb HTTP protocol, ``github.com/<login>/<repo>.git``, only with the
  user's access token as the password (git asks its credential helper after a 401).

Each request is printed as one JSON line: host, method, path (no query), status and whether it
carried the user's token (``ok``), another (``bad``) or none. Never a token, code or secret.
"""

from __future__ import annotations

import base64
import hmac
import json
import secrets
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

CONFIG = json.loads(Path(sys.argv[1]).read_text())
REPOS = Path(CONFIG["repos"])
LOCK = threading.Lock()
CODES: dict[str, str] = {}  # one-time code -> redirect URI it was issued for


def _same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:
        del format, args

    def _send(self, status: int, body: bytes, content_type: str, **headers: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers.items():
            self.send_header(name.replace("_", "-"), value)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: object) -> None:
        self._send(status, json.dumps(payload).encode(), "application/json")

    def _token(self) -> str:
        """``ok``, ``bad`` or ``none``: the request's GitHub credential, by kind."""
        header = self.headers.get("Authorization", "")
        scheme, _, value = header.partition(" ")
        if scheme.lower() in ("bearer", "token"):
            given = value.strip()
        elif scheme.lower() == "basic":
            try:
                given = base64.b64decode(value.strip()).decode().partition(":")[2]
            except ValueError:
                given = ""
        else:
            return "none"
        return "ok" if _same(given, CONFIG["access_token"]) else "bad"

    def _route(self, method: str) -> None:
        host = self.headers.get("Host", "").split(":")[0]
        url = urlsplit(self.path)
        token = self._token()
        status = self._serve(method, host, url.path, parse_qs(url.query), token)
        print(
            json.dumps(
                {"host": host, "method": method, "path": url.path, "status": status, "auth": token}
            ),
            flush=True,
        )

    def do_GET(self) -> None:
        self._route("GET")

    def do_POST(self) -> None:
        self._route("POST")

    def _serve(
        self, method: str, host: str, path: str, query: dict[str, list[str]], token: str
    ) -> int:
        one = lambda name: (query.get(name) or [""])[0]  # noqa: E731
        if host == "github.com" and path == "/login/oauth/authorize" and method == "GET":
            if (
                one("client_id") != CONFIG["client_id"]
                or one("redirect_uri") != CONFIG["redirect_uri"]
            ):
                self._send(400, b"wrong app", "text/plain")
                return 400
            code = secrets.token_hex(10)
            with LOCK:
                CODES[code] = one("redirect_uri")
            location = f"{one('redirect_uri')}?{urlencode({'code': code, 'state': one('state')})}"
            self._send(302, b"", "text/plain", Location=location)
            return 302
        if host == "github.com" and path == "/login/oauth/access_token" and method == "POST":
            length = int(self.headers.get("Content-Length", "0"))
            form = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}
            with LOCK:
                issued_for = CODES.pop(form.get("code", ""), None)
            if (
                issued_for is None
                or issued_for != form.get("redirect_uri")
                or form.get("client_id") != CONFIG["client_id"]
                or not _same(form.get("client_secret", ""), CONFIG["client_secret"])
            ):
                self._json(200, {"error": "bad_verification_code"})
                return 200
            self._json(
                200,
                {
                    "access_token": CONFIG["access_token"],
                    "token_type": "bearer",
                    "scope": "",
                    "expires_in": 28800,
                    "refresh_token": CONFIG["refresh_token"],
                    "refresh_token_expires_in": 15811200,
                },
            )
            return 200
        if host == "api.github.com" and method == "GET" and path in ("/user", "/user/repos"):
            if token != "ok":
                self._json(401, {"message": "Bad credentials"})
                return 401
            if path == "/user":
                self._json(200, {"login": CONFIG["login"], "id": CONFIG["user_id"]})
            else:
                self._json(200, [])
            return 200
        prefix = f"/{CONFIG['login']}/"
        if host == "github.com" and method == "GET" and path.startswith(prefix):
            if token != "ok":
                self._send(401, b"", "text/plain", WWW_Authenticate='Basic realm="GitHub"')
                return 401
            relative = path[len(prefix) :]
            target = (REPOS / relative).resolve()
            if REPOS.resolve() not in target.parents or not target.is_file():
                self._send(404, b"", "text/plain")
                return 404
            self._send(200, target.read_bytes(), "application/octet-stream")
            return 200
        self._send(404, b"", "text/plain")
        return 404


def main() -> None:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CONFIG["cert"], CONFIG["key"])
    server = ThreadingHTTPServer(("0.0.0.0", 443), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(json.dumps({"ready": True}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
