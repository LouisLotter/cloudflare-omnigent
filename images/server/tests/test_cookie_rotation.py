"""A cookie-key rotation, as the platform applies it (G2-SEC-001).

A container gets its environment only when it starts, so the platform applies a secret release
with one controlled restart of the server. These tests start the image's app on a database,
sign in with a session cookie, then start it again on the same database with a rotated
``OMNIGENT_ACCOUNTS_COOKIE_SECRET``, as the restart after the release does: the old cookie is
refused and a new sign-in works. Restarting with the same key keeps the session. In process,
with the pinned Omnigent build; the platform's restart itself is tested in the Workers runtime
(``worker/test/workers/omnigent-server.test.ts``).
"""

from __future__ import annotations

from pathlib import Path

from conftest import OWNER, OWNER_PASSWORD, requires_omnigent, serve_app

ROTATED_COOKIE_SECRET = "fedcba9876543210" * 4  # synthetic


def _sign_in(client) -> dict[str, str]:  # noqa: ANN001
    response = client.post("/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD})
    assert response.status_code == 200, response.text
    cookies = dict(client.cookies)
    assert cookies, "the sign-in set no session cookie"
    return cookies


def _me(client, cookies: dict[str, str]) -> int:  # noqa: ANN001
    client.cookies.clear()
    for name, value in cookies.items():
        client.cookies.set(name, value)
    try:
        return client.get("/auth/me").status_code
    finally:
        client.cookies.clear()


@requires_omnigent
def test_a_restart_with_the_same_cookie_secret_keeps_the_session(tmp_path: Path) -> None:
    with serve_app(tmp_path) as first:
        cookies = _sign_in(first.client)
        assert _me(first.client, cookies) == 200
    with serve_app(tmp_path) as restarted:
        assert _me(restarted.client, cookies) == 200


@requires_omnigent
def test_a_rotated_cookie_secret_refuses_the_old_cookie_after_the_restart(tmp_path: Path) -> None:
    with serve_app(tmp_path) as before:
        cookies = _sign_in(before.client)
        assert _me(before.client, cookies) == 200
        assert _me(before.client, {}) == 401
    rotated = {"OMNIGENT_ACCOUNTS_COOKIE_SECRET": ROTATED_COOKIE_SECRET}
    with serve_app(tmp_path, rotated) as after:
        assert _me(after.client, cookies) == 401
        fresh = _sign_in(after.client)
        assert fresh != cookies
        assert _me(after.client, fresh) == 200
