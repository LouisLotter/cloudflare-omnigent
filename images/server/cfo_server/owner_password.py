"""The owner's Omnigent password, set by the platform (WP3.34).

The owner chooses the password on the site's password page, behind Cloudflare Access and the
owner pin; the web Worker passes it to the OmnigentServer object, which calls this handler on the
server container's port 8000: ``POST /_cfo/owner-password``, body ``{"password": "…", "nonce":
"<32 hex digits>"}`` (a fresh nonce per call, so no two calls share a signature). The contract is
``contracts/src/owner-password.ts``.

Who can call it. Only the OmnigentServer object reaches the container's ports. It never forwards
a path under ``/_cfo/`` from a browser or a computer, and strips every ``x-cfo-`` header from what
it forwards. On top of that this handler needs a signature: HMAC-SHA256, under a key derived from
the installation's Omnigent cookie secret (only the platform Worker and this server hold it;
whoever does can already mint the owner's sessions), over the method, the path, a timestamp
within :data:`MAX_SKEW_S` of this clock, and the body's SHA-256. A signature is accepted once.

What it does is Omnigent's own password change, through its interfaces, on the account the
installation names in ``OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME`` (an admin, not deleted): the new
argon2id hash, the account's generation rotated (every session, CLI login, refresh and device
grant and magic link of the owner stops working; hosts and schedules move to the new
generation), and this process's cached identities dropped.

Durability. The write is a security write (the ``users`` table), and this middleware sits inside
the response barrier: its 200 is held until Litestream's replica covers it, else answered 424
``durability_unconfirmed`` (ADR 0003). The platform says "done" only for a 200 carrying
``x-cfo-durability: confirmed``.

It runs before Omnigent's own middleware and routes, so nothing of Omnigent's logs the request.
Its own lines name outcomes and reasons, never the body.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from collections.abc import Callable
from typing import Any

from cfo_server.events import log

PREFIX = "/_cfo"
PATH = "/_cfo/owner-password"
PROTOCOL = "cfo-platform-call/v1"
KEY_LABEL = b"cfo-platform-call-key/v1"
TIMESTAMP_HEADER = b"x-cfo-call-timestamp"
SIGNATURE_HEADER = b"x-cfo-call-signature"
MAX_SKEW_S = 60
MAX_BODY_BYTES = 4096
#: Omnigent's minimum (``accounts_auth._MIN_PASSWORD_LENGTH``) and the page's maximum, in
#: characters (code points), as the contract's ``ownerPasswordProblem``.
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128
_HEX = frozenset("0123456789abcdef")


def platform_call_key(cookie_secret: str) -> bytes:
    """The platform call's key: HMAC-SHA256 of the label under the cookie secret's bytes."""
    return hmac.new(cookie_secret.encode("utf-8"), KEY_LABEL, hashlib.sha256).digest()


def string_to_sign(method: str, path: str, timestamp: str, body_sha256: str) -> str:
    return "\n".join((PROTOCOL, method, path, timestamp, body_sha256))


def sign(key: bytes, method: str, path: str, timestamp: str, body: bytes) -> str:
    message = string_to_sign(method, path, timestamp, hashlib.sha256(body).hexdigest())
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).hexdigest()


def password_problem(password: str) -> str | None:
    """``too_short``, ``too_long`` or ``None``, never naming the password."""
    if len(password) < MIN_PASSWORD_LENGTH:
        return "too_short"
    if len(password) > MAX_PASSWORD_LENGTH:
        return "too_long"
    return None


class SeenSignatures:
    """Signatures accepted within the skew window: each is accepted once."""

    def __init__(self, limit: int = 4096) -> None:
        self._seen: dict[str, float] = {}
        self._limit = limit
        self._lock = threading.Lock()

    def first_use(self, signature: str, now: float) -> bool:
        with self._lock:
            for key in [k for k, until in self._seen.items() if until < now]:
                del self._seen[key]
            if signature in self._seen:
                return False
            if len(self._seen) >= self._limit:
                # Never forget one early: refuse until the window frees a place.
                return False
            self._seen[signature] = now + 2 * MAX_SKEW_S
            return True


def _header(scope: dict[str, Any], name: bytes) -> str | None:
    values = [v for k, v in scope.get("headers", []) if k.lower() == name]
    if len(values) != 1:
        return None
    try:
        return values[0].decode("ascii")
    except UnicodeDecodeError:
        return None


class OwnerPasswordMiddleware:
    """Answers ``/_cfo/…`` itself; passes every other request to the app unchanged.

    :param cookie_secret: Omnigent's cookie secret; without one every call is refused (503).
    :param username: The owner's username as Omnigent created it; without one, 503.
    :param account_store: Omnigent's ``SqlAlchemyAccountStore``.
    :param auth_provider: Omnigent's auth provider (``revoke_user_sessions``).
    :param hash_password: Omnigent's ``omnigent.server.passwords.hash_password``.
    """

    def __init__(
        self,
        app: Any,
        *,
        cookie_secret: str | None,
        username: str | None,
        account_store: Any,
        auth_provider: Any,
        hash_password: Callable[[str], str],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.app = app
        self._key = platform_call_key(cookie_secret) if cookie_secret else None
        self._username = username
        self._store = account_store
        self._auth = auth_provider
        self._hash = hash_password
        self._clock = clock
        self._seen = SeenSignatures()

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        path = scope.get("path", "")
        if scope.get("type") not in ("http", "websocket") or not (
            path == PREFIX or path.startswith(f"{PREFIX}/")
        ):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        status, body = await self._handle(scope, receive)
        payload = json.dumps(body).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode()),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload, "more_body": False})

    async def _handle(self, scope: dict[str, Any], receive: Any) -> tuple[int, dict[str, Any]]:
        if scope["path"] != PATH:
            return _error(404, "not_found", "Not found.")
        if scope.get("method") != "POST":
            return _error(405, "bad_request", "Method not allowed.")
        body = await _read_body(receive)
        if body is None:
            return self._refused(400, "bad_request", "too_large")
        if self._key is None or not self._username:
            log("owner_password.refused", reason="not_configured")
            return _error(503, "unavailable", "The owner's password cannot be set here.", True)
        reason = self._check_signature(scope, body)
        if reason is not None:
            return self._refused(401, "unauthorized", reason)
        password = _password_of(body)
        if password is None:
            return self._refused(400, "bad_request", "malformed")
        problem = password_problem(password)
        if problem is not None:
            return self._refused(400, "bad_request", problem)
        user = self._store.get_user(self._username)
        if user is None or not user.is_admin:
            return self._refused(404, "not_found", "no_owner")
        try:
            generation = self._store.update_password(
                user.id, self._hash(password), revoke_sessions=True
            )
        except Exception as exc:  # noqa: BLE001 - logged by type only; never the request
            log("owner_password.failed", error=type(exc).__name__)
            return _error(500, "internal", "The password could not be changed.")
        if generation is None:
            return self._refused(404, "not_found", "no_owner")
        self._auth.revoke_user_sessions(user.id)
        log("owner_password.set", sessions="revoked")
        return 200, {"ok": True}

    def _check_signature(self, scope: dict[str, Any], body: bytes) -> str | None:
        timestamp = _header(scope, TIMESTAMP_HEADER)
        signature = _header(scope, SIGNATURE_HEADER)
        if timestamp is None or signature is None:
            return "unsigned"
        if not (timestamp.isascii() and timestamp.isdigit() and len(timestamp) <= 16):
            return "bad_timestamp"
        if len(signature) != 64 or not set(signature) <= _HEX:
            return "bad_signature"
        assert self._key is not None
        expected = sign(self._key, scope["method"], scope["path"], timestamp, body)
        if not hmac.compare_digest(expected, signature):
            return "bad_signature"
        now = self._clock()
        if abs(now - int(timestamp)) > MAX_SKEW_S:
            return "stale"
        if not self._seen.first_use(signature, now):
            return "replayed"
        return None

    @staticmethod
    def _refused(status: int, code: str, reason: str) -> tuple[int, dict[str, Any]]:
        log("owner_password.refused", reason=reason, status=status)
        return _error(status, code, "The request was refused.")


def _error(
    status: int, code: str, message: str, retryable: bool = False
) -> tuple[int, dict[str, Any]]:
    return status, {"error": {"code": code, "message": message, "retryable": retryable}}


async def _read_body(receive: Any) -> bytes | None:
    """The request body, or ``None`` beyond :data:`MAX_BODY_BYTES`."""
    chunks: list[bytes] = []
    size = 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return None
        chunk = message.get("body", b"")
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            return None
        chunks.append(chunk)
        if not message.get("more_body", False):
            return b"".join(chunks)


def _password_of(body: bytes) -> str | None:
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict) or set(parsed) != {"password", "nonce"}:
        return None
    password, nonce = parsed["password"], parsed["nonce"]
    if not (isinstance(nonce, str) and len(nonce) == 32 and set(nonce) <= _HEX):
        return None
    return password if isinstance(password, str) else None


def owner_username() -> str | None:
    """The owner's username as Omnigent's bootstrap created it, or ``None`` when the installation
    names none (Omnigent would then fall back to the OS user, which this never targets)."""
    if not os.environ.get("OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME", "").strip():
        return None
    from omnigent.server.accounts_bootstrap import resolve_admin_username

    return resolve_admin_username()
