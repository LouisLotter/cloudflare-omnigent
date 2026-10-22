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
