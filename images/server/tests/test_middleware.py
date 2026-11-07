"""The response barrier middleware on a minimal ASGI app, with a scripted durability wait."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from cfo_server import barrier
from cfo_server.barrier import ResponseBarrierMiddleware, record_commit
from cfo_server.litestream import WaitOutcome

OK = WaitOutcome(True, 5, 5, 2, 0.01)
TIMEOUT = WaitOutcome(False, 5, 3, 9, 1.0, "timeout")


class ScriptedWait:
    def __init__(self, outcome: WaitOutcome) -> None:
        self.outcome = outcome
        self.calls = 0

    async def __call__(self, timeout_s: float) -> WaitOutcome:
        self.calls += 1
        await asyncio.sleep(0)
        return self.outcome


def make_app(
    *,
    commit: set[str] | None = None,
    status: int = 200,
    cookie: bool = False,
    orphan: bool = False,
    late: bool = False,
):  # noqa: ANN202
    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] == "websocket":
            record_commit({"hosts"})
            return
        if commit:
            record_commit(commit)
        if orphan:
            # A commit from work that did not inherit the request's context.
            await asyncio.get_running_loop().run_in_executor(None, _orphan_commit)
        headers = [(b"content-type", b"application/json"), (b"content-length", b"13")]
        if cookie:
            headers.append((b"set-cookie", b"session=rotated; HttpOnly"))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        if late:
            record_commit({"hosts"})
        await send({"type": "http.response.body", "body": b'{"done": true}'[:13]})

    return app


def _orphan_commit() -> None:
    barrier._current.set(None)
    record_commit({"users"})


async def call(app: Any, method: str = "POST", path: str = "/v1/x", kind: str = "http") -> dict:
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await app({"type": kind, "method": method, "path": path, "headers": []}, receive, send)
    if kind != "http":
        return {}
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return {
        "status": start["status"],
        "headers": {k.decode().lower(): v.decode() for k, v in start["headers"]},
        "set_cookie": [v.decode() for k, v in start["headers"] if k.lower() == b"set-cookie"],
        "body": body,
        "messages": sent,
    }


def run(coro):  # noqa: ANN001, ANN201
    return asyncio.run(coro)


def test_a_request_without_security_commits_is_never_held() -> None:
    wait = ScriptedWait(TIMEOUT)
    result = run(call(ResponseBarrierMiddleware(make_app(), wait=wait, timeout_s=1)))
    assert result["status"] == 200 and "x-cfo-durability" not in result["headers"]
    assert wait.calls == 0


def test_a_confirmed_security_commit_keeps_its_response() -> None:
    wait = ScriptedWait(OK)
    app = ResponseBarrierMiddleware(make_app(commit={"users"}), wait=wait, timeout_s=1)
    result = run(call(app))
    assert result["status"] == 200
    assert result["headers"]["x-cfo-durability"] == "confirmed"
    assert result["body"] == b'{"done": true}'[:13]
    assert wait.calls == 1


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        (
            "/v1/scheduled-tasks",
            {
                "error": {"code": "durability_unconfirmed", "message": barrier.UNCONFIRMED_MESSAGE},
                "applied": True,
            },
        ),
        (
            "/auth/users/me/password",
            {
                "error": barrier.UNCONFIRMED_MESSAGE,
                "code": "durability_unconfirmed",
                "applied": True,
            },
        ),
        (
            "/oauth/revoke",
            {
                "error": barrier.UNCONFIRMED_MESSAGE,
                "code": "durability_unconfirmed",
                "applied": True,
            },
        ),
    ],
)
def test_an_unconfirmed_commit_becomes_424_in_the_route_familys_shape(
    path: str, expected: dict
) -> None:
    app = ResponseBarrierMiddleware(
        make_app(commit={"users"}, cookie=True), wait=ScriptedWait(TIMEOUT), timeout_s=1
    )
    result = run(call(app, path=path))
    assert result["status"] == 424
    assert json.loads(result["body"]) == expected
    assert result["headers"]["x-cfo-durability"] == "unconfirmed"
    assert result["headers"]["content-length"] == str(len(result["body"]))
    assert result["headers"]["cache-control"] == "no-store"
    assert result["set_cookie"] == ["session=rotated; HttpOnly"]
    # Exactly one start and one body: the original body never leaks after the replacement.
    assert [m["type"] for m in result["messages"]] == ["http.response.start", "http.response.body"]


@pytest.mark.parametrize("status", [301, 302, 303, 307])
def test_an_unconfirmed_redirect_is_replaced_too(status: int) -> None:
    """A redirect is a success: a magic-link redemption answers 302 with a session cookie."""
    app = ResponseBarrierMiddleware(
        make_app(commit={"account_tokens"}, status=status, cookie=True),
        wait=ScriptedWait(TIMEOUT),
        timeout_s=1,
    )
    result = run(call(app, method="GET", path="/auth/magic/redeem"))
    assert result["status"] == 424
    assert json.loads(result["body"])["code"] == "durability_unconfirmed"
    assert "location" not in result["headers"]
    assert result["set_cookie"] == ["session=rotated; HttpOnly"]


def test_an_unconfirmed_error_response_is_passed_through() -> None:
    app = ResponseBarrierMiddleware(
        make_app(commit={"hosts"}, status=409), wait=ScriptedWait(TIMEOUT), timeout_s=1
    )
    result = run(call(app))
    assert result["status"] == 409
    assert result["headers"]["x-cfo-durability"] == "unconfirmed"


def test_an_orphan_commit_holds_a_concurrent_write_but_not_a_read() -> None:
    wait = ScriptedWait(TIMEOUT)
    write = run(call(ResponseBarrierMiddleware(make_app(orphan=True), wait=wait, timeout_s=1)))
    assert write["status"] == 424
    read = run(
        call(ResponseBarrierMiddleware(make_app(orphan=True), wait=wait, timeout_s=1), method="GET")
    )
    assert read["status"] == 200


def test_websocket_commits_are_not_orphans() -> None:
    app = ResponseBarrierMiddleware(make_app(), wait=ScriptedWait(TIMEOUT), timeout_s=1)
    before = barrier.orphan_commits()
    run(call(app, kind="websocket"))
    assert barrier.orphan_commits() == before


def test_a_commit_after_the_response_started_is_logged_as_late(
    capsys: pytest.CaptureFixture[str],
) -> None:
    app = ResponseBarrierMiddleware(make_app(late=True), wait=ScriptedWait(OK), timeout_s=1)
    result = run(call(app))
    assert result["status"] == 200
    assert '"cfo.barrier.late_commit"' in capsys.readouterr().err


def test_lifespan_and_other_scopes_pass_through() -> None:
    seen: list[str] = []

    async def inner(scope: dict[str, Any], receive: Any, send: Any) -> None:
        seen.append(scope["type"])

    app = ResponseBarrierMiddleware(inner, wait=ScriptedWait(OK), timeout_s=1)
    run(app({"type": "lifespan"}, None, None))
    assert seen == ["lifespan"]


# ── Held routes: the body as the app reads it, and the routed path ─────────────────────


def reading_app(*, commit: set[str] | None = None, read: bool = True):  # noqa: ANN202
    """An app that reads the whole body through ``receive``, keeps what it got, answers 200."""
    seen: list[bytes] = []

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        while read:
            message = await receive()
            seen.append(message.get("body", b""))
            if not message.get("more_body", False):
                break
        if commit:
            record_commit(commit)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    app.seen = seen  # type: ignore[attr-defined]
    return app


async def call_with_body(
    app: Any, method: str, path: str, chunks: list[bytes], root_path: str = ""
) -> dict:
    sent: list[dict[str, Any]] = []
    pending = list(chunks)

    async def receive() -> dict[str, Any]:
        body = pending.pop(0) if pending else b""
        return {"type": "http.request", "body": body, "more_body": bool(pending)}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {"type": "http", "method": method, "path": path, "root_path": root_path, "headers": []}
    await app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return {"status": start["status"], "body": body}


def _held(inner: Any, method: str, path: str, chunks: list[bytes], **kw: Any) -> tuple[int, int]:
    """``(status, waits)`` of one request through the barrier, the replica blocked."""
    wait = ScriptedWait(TIMEOUT)
    base_path = kw.pop("base_path", "")
    app = ResponseBarrierMiddleware(inner, wait=wait, timeout_s=1, base_path=base_path)
    result = run(call_with_body(app, method, path, chunks, **kw))
    return result["status"], wait.calls


def test_turning_off_workspace_sharing_is_held_and_the_app_reads_the_body_unchanged() -> None:
    chunks = [b'{"share_workspace_', b'files": false}']
    inner = reading_app()
    assert _held(inner, "PATCH", "/v1/sessions/s1", chunks) == (424, 1)
    assert inner.seen == chunks  # every chunk reached the app as sent, once


def test_an_ordinary_thread_setting_is_not_held() -> None:
    inner = reading_app()
    chunks = [b'{"title": "renamed", "archived": true}']
    assert _held(inner, "PATCH", "/v1/sessions/s1", chunks) == (200, 0)
    assert inner.seen == chunks


@pytest.mark.parametrize(
    "chunks",
    [
        [b"x" * (barrier.HELD_BODY_LIMIT + 1)],
        [b'{"title": "t"', b"x" * barrier.HELD_BODY_LIMIT, b"}"],
        [b"not json"],
        [b'["share_workspace_files"]'],
    ],
    ids=["too-large", "too-large-in-chunks", "not-json", "not-an-object"],
)
def test_a_body_it_cannot_read_as_a_json_object_is_held(chunks: list[bytes]) -> None:
    assert _held(reading_app(), "PATCH", "/v1/sessions/s1", chunks)[1] == 1


def test_a_body_the_app_never_read_is_held() -> None:
    assert _held(reading_app(read=False), "PATCH", "/v1/sessions/s1", [b'{"title": "t"}']) == (
        424,
        1,
    )


def test_other_requests_keep_the_receive_they_were_given() -> None:
    inner = reading_app()
    assert _held(inner, "POST", "/v1/sessions/s1/events", [b'{"share_workspace_files": 1}']) == (
        200,
        0,
    )


@pytest.mark.parametrize(
    ("path", "kw"),
    [
        ("/omnigent/v1/sessions/s1", {"base_path": "/omnigent"}),
        ("/v1/sessions/s1", {"base_path": "/omnigent"}),
        ("/mount/v1/sessions/s1", {"root_path": "/mount"}),
    ],
)
def test_a_base_path_or_root_path_does_not_skip_a_held_route(path: str, kw: dict) -> None:
    body = [b'{"share_workspace_files": false}']
    assert _held(reading_app(), "PATCH", path, body, **kw) == (424, 1)
    assert _held(reading_app(), "PUT", f"{path}/permissions", [b"{}"], **kw) == (424, 1)


def test_a_prefixed_auth_route_gets_the_auth_routes_424_shape() -> None:
    wait = ScriptedWait(TIMEOUT)
    app = ResponseBarrierMiddleware(
        reading_app(commit={"device_grants"}), wait=wait, timeout_s=1, base_path="/omnigent"
    )
    result = run(call_with_body(app, "POST", "/omnigent/auth/login", [b"{}"]))
    assert result["status"] == 424
    assert json.loads(result["body"])["code"] == "durability_unconfirmed"
