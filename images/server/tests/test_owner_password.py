"""The owner's password handler (WP3.34): ``POST /_cfo/owner-password``.

Three layers:
- the signature against the cross-language vectors (``contracts/vectors/platform-call-v1.json``,
  which the Worker's signer reproduces too);
- the middleware's refusals and its calls into Omnigent, with fakes;
- the image's real app (``build_app``, the pinned Omnigent, the response barrier): the password
  changes, the owner's older sessions and bearer logins stop working, the barrier confirms it or
  answers 424 while the replica is blocked, and the password reaches no log line.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from cfo_server import owner_password as op

from conftest import COOKIE_SECRET, OWNER, OWNER_PASSWORD, REPO_ROOT, AppHarness, requires_omnigent

VECTORS = json.loads((REPO_ROOT / "contracts" / "vectors" / "platform-call-v1.json").read_text())


def signed(
    body: bytes,
    *,
    secret: str = COOKIE_SECRET,
    method: str = "POST",
    path: str = op.PATH,
    timestamp: int | None = None,
) -> dict[str, str]:
    stamp = str(int(time.time()) if timestamp is None else timestamp)
    key = op.platform_call_key(secret)
    return {
        "x-cfo-call-timestamp": stamp,
        "x-cfo-call-signature": op.sign(key, method, path, stamp, body),
    }


def body_of(password: str) -> bytes:
    nonce = secrets.token_hex(16)
    return json.dumps({"password": password, "nonce": nonce}, separators=(",", ":")).encode()


# ── The signature ──────────────────────────────────────────────────────────────────────


def test_the_key_and_signatures_match_the_vectors() -> None:
    key = op.platform_call_key(VECTORS["cookieSecret"])
    assert key.hex() == VECTORS["keyHex"]
    assert VECTORS["keyLabel"].encode() == op.KEY_LABEL
    for case in VECTORS["cases"]:
        body = case["body"].encode()
        assert (
            op.string_to_sign(
                case["method"],
                case["path"],
                str(case["timestamp"]),
                hashlib.sha256(body).hexdigest(),
            )
            == case["stringToSign"]
        )
        assert (
            op.sign(key, case["method"], case["path"], str(case["timestamp"]), body)
            == case["headers"]["x-cfo-call-signature"]
        )
    assert VECTORS["cases"][0]["path"] == op.PATH


def test_the_password_rule_counts_code_points() -> None:
    assert op.password_problem("\U0001f511" * 4) == "too_short"
    assert op.password_problem("\U0001f511" * 8) is None
    assert op.password_problem("a" * 7) == "too_short"
    assert op.password_problem("a" * 128) is None
    assert op.password_problem("a" * 129) == "too_long"


def test_a_signature_is_accepted_once_and_the_window_is_bounded() -> None:
    seen = op.SeenSignatures(limit=2)
    assert seen.first_use("a", 0.0)
    assert not seen.first_use("a", 1.0)
    assert seen.first_use("b", 1.0)
    assert not seen.first_use("c", 1.0)  # full: refused rather than forgetting one early
    assert seen.first_use("c", 1.0 + 2 * op.MAX_SKEW_S + 1)  # the window moved on


# ── The middleware, with fakes ─────────────────────────────────────────────────────────


class FakeUser:
    def __init__(self, user_id: str, is_admin: bool = True) -> None:
        self.id = user_id
        self.is_admin = is_admin


class FakeStore:
    def __init__(self, users: dict[str, FakeUser]) -> None:
        self.users = users
        self.updates: list[tuple[str, str, bool]] = []
        self.fail = False

    def get_user(self, user_id: str) -> FakeUser | None:
        return self.users.get(user_id)

    def update_password(self, user_id: str, password_hash: str, *, revoke_sessions: bool) -> Any:
        if self.fail:
            raise RuntimeError("database is locked")
        self.updates.append((user_id, password_hash, revoke_sessions))
        return "g2" if user_id in self.users else None


class FakeAuth:
    def __init__(self) -> None:
        self.revoked: list[str] = []

    def revoke_user_sessions(self, user_id: str) -> None:
        self.revoked.append(user_id)


class Passed(Exception):
    pass


async def _inner(scope: Any, receive: Any, send: Any) -> None:
    raise Passed(scope["path"])


def make(
    *,
    secret: str | None = COOKIE_SECRET,
    username: str | None = OWNER,
    users: dict[str, FakeUser] | None = None,
    clock: float | None = None,
) -> tuple[op.OwnerPasswordMiddleware, FakeStore, FakeAuth]:
    store = FakeStore({OWNER: FakeUser(OWNER)} if users is None else users)
    auth = FakeAuth()
    middleware = op.OwnerPasswordMiddleware(
        _inner,
        cookie_secret=secret,
        username=username,
        account_store=store,
        auth_provider=auth,
        hash_password=lambda password: f"hashed:{len(password)}",
        clock=(lambda: clock) if clock is not None else time.time,
    )
    return middleware, store, auth


def call(
    middleware: op.OwnerPasswordMiddleware,
    *,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
    method: str = "POST",
    path: str = op.PATH,
    chunks: int = 1,
) -> tuple[int, dict[str, Any]]:
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": [(k.encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    size = max(1, len(body) // chunks + 1)
    parts = [body[i : i + size] for i in range(0, len(body), size)] or [b""]
    messages = [
        {"type": "http.request", "body": part, "more_body": i < len(parts) - 1}
        for i, part in enumerate(parts)
    ]
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))
    start = sent[0]
    assert (b"cache-control", b"no-store") in start["headers"]
    return start["status"], json.loads(sent[1]["body"])


def test_other_paths_pass_through_untouched() -> None:
    middleware, _, _ = make()
    for path in ("/", "/auth/users/me/password", "/_cfox", "/v1/_cfo/owner-password"):
        with pytest.raises(Passed):
            call(middleware, path=path)


def test_a_websocket_under_the_prefix_is_closed() -> None:
    middleware, _, _ = make()
    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    asyncio.run(middleware({"type": "websocket", "path": op.PATH}, None, send))
    assert sent == [{"type": "websocket.close", "code": 1008}]


def test_the_password_is_set_with_sessions_revoked() -> None:
    middleware, store, auth = make()
    body = body_of("synthetic-new-owner-password")
    assert call(middleware, body=body, headers=signed(body), chunks=3) == (200, {"ok": True})
    assert store.updates == [(OWNER, "hashed:28", True)]
    assert auth.revoked == [OWNER]


@pytest.mark.parametrize(
    ("change", "status", "code"),
    [
        ({"path": "/_cfo/other"}, 404, "not_found"),
        ({"path": "/_cfo"}, 404, "not_found"),
        ({"method": "GET"}, 405, "bad_request"),
        ({"method": "PUT"}, 405, "bad_request"),
    ],
)
def test_only_post_to_the_one_path(change: dict[str, str], status: int, code: str) -> None:
    middleware, store, _ = make()
    body = body_of("synthetic-new-owner-password")
    answer = call(middleware, body=body, headers=signed(body), **change)
    assert answer[0] == status
    assert answer[1]["error"]["code"] == code
    assert store.updates == []


def _refusal(middleware: op.OwnerPasswordMiddleware, store: FakeStore, **kwargs: Any) -> int:
    status, answer = call(middleware, **kwargs)
    assert set(answer) == {"error"}
    assert store.updates == []
    return status


def test_unsigned_forged_stale_and_replayed_calls_are_refused() -> None:
    now = 1_800_000_000
    middleware, store, auth = make(clock=float(now))
    body = body_of("synthetic-new-owner-password")
    assert _refusal(middleware, store, body=body) == 401
    assert _refusal(middleware, store, body=body, headers={"x-cfo-call-timestamp": str(now)}) == 401
    forged = signed(body, secret="f" * 64, timestamp=now)
    assert _refusal(middleware, store, body=body, headers=forged) == 401
    other_body = signed(body_of("synthetic-new-owner-password"), timestamp=now)
    assert _refusal(middleware, store, body=body, headers=other_body) == 401
    other_path = signed(body, path="/_cfo/other", timestamp=now)
    assert _refusal(middleware, store, body=body, headers=other_path) == 401
    stale = signed(body, timestamp=now - op.MAX_SKEW_S - 1)
    assert _refusal(middleware, store, body=body, headers=stale) == 401
    future = signed(body, timestamp=now + op.MAX_SKEW_S + 1)
    assert _refusal(middleware, store, body=body, headers=future) == 401
    bad = {"x-cfo-call-timestamp": "12x", "x-cfo-call-signature": "0" * 64}
    assert _refusal(middleware, store, body=body, headers=bad) == 401
    short = {"x-cfo-call-timestamp": str(now), "x-cfo-call-signature": "0" * 63}
    assert _refusal(middleware, store, body=body, headers=short) == 401
    upper = signed(body, timestamp=now)
    upper["x-cfo-call-signature"] = upper["x-cfo-call-signature"].upper()
    assert _refusal(middleware, store, body=body, headers=upper) == 401
    good = signed(body, timestamp=now)
    assert call(middleware, body=body, headers=good)[0] == 200
    assert call(middleware, body=body, headers=good)[0] == 401  # the same signature again
    assert len(store.updates) == 1 and auth.revoked == [OWNER]


def test_a_repeated_header_is_refused() -> None:
    middleware, store, _ = make()
    body = body_of("synthetic-new-owner-password")
    headers = signed(body)
    scope_headers = [(k.encode(), v.encode()) for k, v in headers.items()]
    scope_headers.append((b"x-cfo-call-signature", headers["x-cfo-call-signature"].encode()))
    sent: list[dict[str, Any]] = []
    messages = [{"type": "http.request", "body": body, "more_body": False}]

    async def receive() -> dict[str, Any]:
        return messages.pop(0)

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": op.PATH, "headers": scope_headers}
    asyncio.run(middleware(scope, receive, send))
    assert sent[0]["status"] == 401
    assert store.updates == []


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"\xff\xfe",
        b"[]",
        b'{"password": 12345678, "nonce": "00000000000000000000000000000000"}',
        b'{"password": "synthetic-new-owner-password", "nonce": "00000000000000000000000000000000",'
        b' "user": "root"}',
        b'{"password": "synthetic-new-owner-password"}',
        b'{"password": "synthetic-new-owner-password", "nonce": "XYZ"}',
        b'{"password": "synthetic-new-owner-password", "nonce": 7}',
        b"{}",
    ],
)
def test_malformed_bodies_are_refused(body: bytes) -> None:
    middleware, store, _ = make()
    assert _refusal(middleware, store, body=body, headers=signed(body)) == 400


@pytest.mark.parametrize("password", ["short", "\U0001f511" * 4, "a" * 129])
def test_passwords_outside_the_rule_are_refused(password: str) -> None:
    middleware, store, _ = make()
    body = body_of(password)
    assert _refusal(middleware, store, body=body, headers=signed(body)) == 400


def test_a_body_over_the_bound_is_refused_unread() -> None:
    middleware, store, _ = make()
    body = b"x" * (op.MAX_BODY_BYTES + 1)
    assert _refusal(middleware, store, body=body, headers=signed(body), chunks=5) == 400


def test_a_disconnect_is_refused() -> None:
    middleware, store, _ = make()
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": op.PATH, "headers": []}
    asyncio.run(middleware(scope, receive, send))
    assert sent[0]["status"] == 400
    assert store.updates == []


@pytest.mark.parametrize("missing", ["secret", "username"])
def test_without_a_cookie_secret_or_an_owner_nothing_is_set(missing: str) -> None:
    kwargs: dict[str, Any] = {"secret": None} if missing == "secret" else {"username": None}
    middleware, store, _ = make(**kwargs)
    body = body_of("synthetic-new-owner-password")
    status, answer = call(middleware, body=body, headers=signed(body))
    assert status == 503
    assert answer["error"]["retryable"] is True
    assert store.updates == []


@pytest.mark.parametrize(
    "users", [{}, {OWNER: FakeUser(OWNER, is_admin=False)}, {"someone-else": FakeUser("x")}]
)
def test_only_the_named_admin_owner_is_changed(users: dict[str, FakeUser]) -> None:
    middleware, store, auth = make(users=users)
    body = body_of("synthetic-new-owner-password")
    assert call(middleware, body=body, headers=signed(body))[0] == 404
    assert store.updates == [] and auth.revoked == []


def test_a_store_failure_is_a_500_and_revokes_nothing() -> None:
    middleware, store, auth = make()
    store.fail = True
    body = body_of("synthetic-new-owner-password")
    status, answer = call(middleware, body=body, headers=signed(body))
    assert status == 500 and answer["error"]["code"] == "internal"
    assert auth.revoked == []


def test_an_owner_deleted_meanwhile_is_a_404() -> None:
    middleware, store, auth = make()
    store.users = {OWNER: FakeUser(OWNER)}
    body = body_of("synthetic-new-owner-password")

    def gone(user_id: str, password_hash: str, *, revoke_sessions: bool) -> None:
        return None

    store.update_password = gone  # type: ignore[method-assign]
    assert call(middleware, body=body, headers=signed(body))[0] == 404
    assert auth.revoked == []


def test_no_log_line_carries_the_password(capsys: pytest.CaptureFixture[str]) -> None:
    canary = "CFO_CANARY_" + "OWNERPASSWORD" + "0001"
    middleware, _, _ = make()
    body = body_of(canary)
    call(middleware, body=body, headers=signed(body))
    call(middleware, body=body, headers=signed(body, secret="e" * 64))
    call(middleware, body=body_of(canary + "x" * 200), headers=signed(body))
    out = capsys.readouterr()
    assert canary not in out.err and canary not in out.out
    assert '"cfo.owner_password.set"' in out.err
    assert '"cfo.owner_password.refused"' in out.err


def test_the_username_comes_from_the_installation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME", raising=False)
    assert op.owner_username() is None
    monkeypatch.setenv("OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME", "   ")
    assert op.owner_username() is None


# ── The image's real app ───────────────────────────────────────────────────────────────


def _login(h: AppHarness, password: str) -> Any:
    response = h.client.post("/auth/login", json={"username": OWNER, "password": password})
    h.client.cookies.clear()
    return response


def _me(h: AppHarness, *, cookies: dict[str, str] | None = None, bearer: str | None = None) -> int:
    h.client.cookies.clear()
    for name, value in (cookies or {}).items():
        h.client.cookies.set(name, value)
    headers = {} if bearer is None else {"Authorization": f"Bearer {bearer}"}
    try:
        return h.client.get("/auth/me", headers=headers).status_code
    finally:
        h.client.cookies.clear()


def _set(h: AppHarness, password: str) -> Any:
    body = body_of(password)
    return h.client.post(
        op.PATH, content=body, headers={**signed(body), "content-type": "application/json"}
    )


@pytest.fixture
def owner(app_harness: AppHarness) -> Iterator[AppHarness]:
    """The real app, with the owner's original password put back afterwards."""
    app_harness.fake.mode = "healthy"
    app_harness.fake.lag_syncs = 1
    yield app_harness
    app_harness.fake.mode = "healthy"
    assert _set(app_harness, OWNER_PASSWORD).status_code == 200


@requires_omnigent
def test_the_real_app_sets_the_password_and_signs_the_owner_out_everywhere(
    owner: AppHarness,
) -> None:
    signed_in = owner.client.post(
        "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
    )
    assert signed_in.status_code == 200
    cookies = dict(owner.client.cookies)
    bearer = signed_in.json()["token"]
    owner.client.cookies.clear()
    assert _me(owner, cookies=cookies) == 200
    assert _me(owner, bearer=bearer) == 200

    new = "synthetic-chosen-on-the-page-01"
    response = _set(owner, new)
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True}
    assert response.headers["x-cfo-durability"] == "confirmed"
    assert "set-cookie" not in response.headers

    assert _me(owner, cookies=cookies) == 401
    assert _me(owner, bearer=bearer) == 401
    assert _login(owner, OWNER_PASSWORD).status_code == 401
    assert _login(owner, new).status_code == 200


@requires_omnigent
def test_the_real_app_answers_424_while_the_replica_is_blocked_and_applies_it(
    owner: AppHarness,
) -> None:
    owner.fake.lag_syncs = 0
    new = "synthetic-chosen-while-blocked-02"
    owner.fake.mode = "blocked"
    response = _set(owner, new)
    assert response.status_code == 424, response.text
    assert response.headers["x-cfo-durability"] == "unconfirmed"
    assert response.json()["applied"] is True
    owner.fake.mode = "healthy"
    assert _login(owner, new).status_code == 200


@requires_omnigent
def test_the_real_app_refuses_an_unsigned_call_and_omnigent_routes_still_work(
    owner: AppHarness,
) -> None:
    body = body_of("synthetic-never-set-03")
    refused = owner.client.post(op.PATH, content=body)
    assert refused.status_code == 401
    assert "x-cfo-durability" not in refused.headers
    assert _login(owner, "synthetic-never-set-03").status_code == 401
    assert owner.client.get("/v1/info").status_code == 200
    assert owner.client.get("/_cfo/anything").status_code == 404


@requires_omnigent
def test_the_real_app_never_logs_the_password(
    owner: AppHarness, capfd: pytest.CaptureFixture[str]
) -> None:
    canary = "CFO_CANARY_" + "REALAPPPASSWORD" + "04"
    capfd.readouterr()
    assert _set(owner, canary).status_code == 200
    assert _set(owner, canary + "!").status_code == 200
    out = capfd.readouterr()
    assert canary not in out.out and canary not in out.err


def test_the_middleware_signature_check_is_constant_time_compare() -> None:
    # The comparison is hmac.compare_digest over the full hex string (a review aid).
    source = Path(op.__file__).read_text()
    assert "hmac.compare_digest(expected, signature)" in source
    assert hmac.compare_digest("a", "a")
