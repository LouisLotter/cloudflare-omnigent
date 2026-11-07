"""Per-route classification of the response barrier, on Omnigent's real HTTP routes.

Each security route is exercised twice against the image's app: with the replica keeping up
(answered normally, ``x-cfo-durability: confirmed``) and with it blocked (424
``durability_unconfirmed``, ``"applied": true``, while the change is applied). Routes that
change nothing security-relevant are never held, even while the replica is blocked. The 424
bodies are validated against the exported wire contract. Litestream is a stand-in here; the
image tests repeat the blocked case against real Litestream.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from conftest import (
    COOKIE_SECRET,
    OWNER,
    OWNER_PASSWORD,
    REPO_ROOT,
    AppHarness,
    requires_omnigent,
    serve_app,
)

pytestmark = requires_omnigent

SCHEMA_DIR = REPO_ROOT / "contracts" / "schema"


def _schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text())


def assert_unconfirmed(response, path: str) -> None:  # noqa: ANN001
    from jsonschema import Draft202012Validator

    assert response.status_code == 424, response.text
    assert response.headers["x-cfo-durability"] == "unconfirmed"
    assert response.headers["cache-control"] == "no-store"
    name = (
        "DurabilityUnconfirmedAuth"
        if path.startswith(("/auth/", "/oauth/"))
        else ("DurabilityUnconfirmed")
    )
    errors = list(Draft202012Validator(_schema(name)).iter_errors(response.json()))
    assert not errors, [e.message for e in errors]


def assert_confirmed(response) -> None:  # noqa: ANN001
    assert 200 <= response.status_code < 300, response.text
    assert response.headers["x-cfo-durability"] == "confirmed"


def assert_not_held(response) -> None:  # noqa: ANN001
    assert 200 <= response.status_code < 300, response.text
    assert "x-cfo-durability" not in response.headers


def rows(db: Path, sql: str, *args: object) -> list[tuple]:
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        return conn.execute(sql, args).fetchall()


@pytest.fixture
def healthy(app_harness: AppHarness) -> Iterator[AppHarness]:
    app_harness.fake.mode = "healthy"
    app_harness.fake.lag_syncs = 1
    yield app_harness
    app_harness.fake.mode = "healthy"


@pytest.fixture
def blocked(app_harness: AppHarness) -> Iterator[AppHarness]:
    # Log in first: a healthy replica, so the bearer works for the blocked request.
    app_harness.fake.mode = "healthy"
    app_harness.fake.lag_syncs = 0
    yield app_harness
    app_harness.fake.mode = "healthy"


def _block(h: AppHarness) -> None:
    h.fake.mode = "blocked"


# ── Accounts and login grants ──────────────────────────────────────────────────────────


def test_login_issuing_a_refresh_grant_is_held(healthy: AppHarness) -> None:
    response = healthy.client.post(
        "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD, "issue_refresh": True}
    )
    assert_confirmed(response)
    assert response.json().get("refresh_token")
    healthy.client.cookies.clear()


def test_login_issuing_a_refresh_grant_answers_424_while_blocked(blocked: AppHarness) -> None:
    before = rows(blocked.db_path, "SELECT COUNT(*) FROM device_grants")[0][0]
    _block(blocked)
    response = blocked.client.post(
        "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD, "issue_refresh": True}
    )
    blocked.client.cookies.clear()
    assert_unconfirmed(response, "/auth/login")
    assert "refresh_token" not in response.text
    assert rows(blocked.db_path, "SELECT COUNT(*) FROM device_grants")[0][0] == before + 1


def test_browser_login_is_not_held_while_blocked(blocked: AppHarness) -> None:
    _block(blocked)
    response = blocked.client.post(
        "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
    )
    blocked.client.cookies.clear()
    assert_not_held(response)


def test_grant_revocation_is_held_and_applied_while_blocked(blocked: AppHarness) -> None:
    grant = blocked.login(refresh=True)
    _block(blocked)
    response = blocked.client.post("/oauth/revoke", data={"refresh_token": grant["refresh_token"]})
    assert_unconfirmed(response, "/oauth/revoke")
    blocked.fake.mode = "healthy"
    refreshed = blocked.client.post(
        "/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": grant["refresh_token"]},
    )
    assert refreshed.status_code != 200  # applied: the revoked grant no longer refreshes


def test_grant_revocation_is_confirmed_when_healthy(healthy: AppHarness) -> None:
    grant = healthy.login(refresh=True)
    response = healthy.client.post("/oauth/revoke", data={"refresh_token": grant["refresh_token"]})
    assert_confirmed(response)


def test_password_change_is_held_and_keeps_its_cookie_while_blocked(blocked: AppHarness) -> None:
    bearer = blocked.bearer()
    new_password = "cfo-test-owner-password-0002"
    _block(blocked)
    response = blocked.client.post(
        "/auth/users/me/password",
        json={"old_password": OWNER_PASSWORD, "new_password": new_password},
        headers=bearer,
    )
    assert_unconfirmed(response, "/auth/users/me/password")
    assert "set-cookie" in response.headers
    blocked.client.cookies.clear()
    blocked.fake.mode = "healthy"
    # Applied: the new password works. Then put the original back, confirmed.
    login = blocked.client.post("/auth/login", json={"username": OWNER, "password": new_password})
    assert login.status_code == 200
    token = login.json()["token"]
    blocked.client.cookies.clear()
    back = blocked.client.post(
        "/auth/users/me/password",
        json={"old_password": new_password, "new_password": OWNER_PASSWORD},
        headers={"Authorization": f"Bearer {token}"},
    )
    blocked.client.cookies.clear()
    assert_confirmed(back)


def test_magic_link_redemption_answers_424_not_its_redirect_while_blocked(
    blocked: AppHarness,
) -> None:
    bearer = blocked.bearer()
    minted = blocked.client.post("/auth/magic", headers=bearer)
    assert_confirmed(minted)
    token = minted.json()["redeem_url"].split("t=", 1)[1]
    _block(blocked)
    redeemed = blocked.client.get("/auth/magic/redeem", params={"t": token}, follow_redirects=False)
    blocked.client.cookies.clear()
    assert_unconfirmed(redeemed, "/auth/magic/redeem")
    assert "location" not in redeemed.headers
    assert "set-cookie" in redeemed.headers  # applied: the sign-in happened


def test_admin_invite_is_held_while_blocked(blocked: AppHarness) -> None:
    # Inviting needs a browser's sign-in (Omnigent refuses a CLI's or a host's): the cookie.
    signed_in = blocked.client.post(
        "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
    )
    assert signed_in.status_code == 200, signed_in.text
    _block(blocked)
    response = blocked.client.post("/auth/invite", json={"is_admin": False})
    blocked.client.cookies.clear()
    assert_unconfirmed(response, "/auth/invite")


# ── Schedules ──────────────────────────────────────────────────────────────────────────


def _agent_id(h: AppHarness, bearer: dict[str, str]) -> str:
    response = h.client.get("/v1/agents", headers=bearer)
    assert response.status_code == 200, response.text
    body = response.json()
    items = body.get("data") or body.get("agents") or body
    return items[0]["id"]


def _schedule_body(agent_id: str, name: str) -> dict[str, str]:
    return {
        "name": name,
        "prompt": "synthetic task",
        "rrule": "FREQ=DAILY;BYHOUR=3",
        "agent_id": agent_id,
        "timezone": "UTC",
    }


def test_schedule_create_edit_delete_are_held_while_blocked(blocked: AppHarness) -> None:
    bearer = blocked.bearer()
    agent_id = _agent_id(blocked, bearer)
    _block(blocked)
    created = blocked.client.post(
        "/v1/scheduled-tasks", json=_schedule_body(agent_id, "blocked-create"), headers=bearer
    )
    assert_unconfirmed(created, "/v1/scheduled-tasks")
    found = rows(blocked.db_path, "SELECT id FROM scheduled_tasks WHERE name = ?", "blocked-create")
    assert len(found) == 1  # applied
    task_id = found[0][0].hex() if isinstance(found[0][0], bytes) else str(found[0][0])
    edited = blocked.client.patch(
        f"/v1/scheduled-tasks/{task_id}", json={"name": "blocked-edit"}, headers=bearer
    )
    assert_unconfirmed(edited, "/v1/scheduled-tasks/x")
    assert (
        rows(
            blocked.db_path, "SELECT COUNT(*) FROM scheduled_tasks WHERE name = ?", "blocked-edit"
        )[0][0]
        == 1
    )
    deleted = blocked.client.delete(f"/v1/scheduled-tasks/{task_id}", headers=bearer)
    assert_unconfirmed(deleted, "/v1/scheduled-tasks/x")


def test_schedule_create_is_confirmed_when_healthy(healthy: AppHarness) -> None:
    bearer = healthy.bearer()
    agent_id = _agent_id(healthy, bearer)
    created = healthy.client.post(
        "/v1/scheduled-tasks", json=_schedule_body(agent_id, "healthy-create"), headers=bearer
    )
    assert_confirmed(created)


# ── Hosts (persistent computers) ────────────────────────────────────────────────────────


def test_host_creation_and_removal_are_held_while_blocked(blocked: AppHarness) -> None:
    bearer = blocked.bearer()
    _block(blocked)
    created = blocked.client.post("/v1/hosts", json={"name": "Blocked computer"}, headers=bearer)
    assert_unconfirmed(created, "/v1/hosts")
    host_rows = rows(
        blocked.db_path, "SELECT host_id FROM hosts WHERE name = ?", "Blocked computer"
    )
    assert len(host_rows) == 1  # applied: the pending host row exists
    host_id = host_rows[0][0]
    host_id = host_id.hex() if isinstance(host_id, bytes) else str(host_id)
    blocked.fake.mode = "healthy"
    listed = blocked.client.get("/v1/hosts", headers=bearer).json()
    hosts = listed.get("data") or listed.get("hosts") or listed
    api_id = next(h["host_id"] for h in hosts if h.get("name") == "Blocked computer")
    _block(blocked)
    removed = blocked.client.delete(f"/v1/hosts/{api_id}", headers=bearer)
    assert_unconfirmed(removed, "/v1/hosts/x")
    assert rows(
        blocked.db_path,
        "SELECT deleted_at IS NOT NULL FROM hosts WHERE name = ?",
        "Blocked computer",
    ) in ([(1,)], [])


def test_host_creation_is_confirmed_when_healthy(healthy: AppHarness) -> None:
    bearer = healthy.bearer()
    created = healthy.client.post("/v1/hosts", json={"name": "Healthy computer"}, headers=bearer)
    assert_confirmed(created)


def test_launch_token_rearm_and_revocation_are_security_writes(app_harness: AppHarness) -> None:
    """The re-arm path's real SQL, through Omnigent's own host store, is marked.

    A wake re-arms the launch token in a launcher thread that inherits the request's
    context; the launcher's own durability wait before ``start_host`` is WP3.6's test. Here:
    the re-arm and the token's revocation are classified as security writes and attributed
    to the scope they run in. Ordinary heartbeats are not.
    """
    import time as _time
    import uuid

    from omnigent.stores.host_store import HostStore

    from cfo_server import barrier

    store = HostStore(f"sqlite:///{app_harness.db_path}")
    host_id = uuid.uuid4().hex
    store.create_persistent_host(
        host_id=host_id, name=f"rearm-{host_id[:6]}", user_id=OWNER, provider="cloudflare"
    )
    attached = store.attach_persistent_sandbox(
        host_id, provider="cloudflare", sandbox_id="sb-synthetic"
    )
    assert attached is not None

    def in_scope(action):  # noqa: ANN001, ANN202
        record = barrier.ScopeDurability("http")
        token = barrier._current.set(record)
        try:
            action()
        finally:
            barrier._current.reset(token)
        return record

    current = store.get_host(host_id)
    assert current is not None
    rearm = in_scope(
        lambda: store.rearm_managed_host(
            host_id,
            sandbox_id="sb-synthetic",
            expected_updated_at=current.updated_at,
            token="synthetic-launch-token-0001",
            token_expires_at=int(_time.time()) + 3600,
        )
    )
    assert rearm.commits == 1 and rearm.tables == {"hosts"}
    revoke = in_scope(lambda: store.revoke_launch_token(host_id))
    assert revoke.commits == 1 and revoke.tables == {"hosts"}


# ── Not held ───────────────────────────────────────────────────────────────────────────


# ── What a team takes away (WP3.56) ────────────────────────────────────────────────────

CEL = "omnigent.policies.builtins.cel.cel_policy"


def _browser(h: AppHarness) -> dict[str, str]:
    """A browser's sign-in: team and approval changes refuse a bearer credential."""
    response = h.client.post("/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD})
    assert response.status_code == 200, response.text
    h.client.cookies.clear()
    return {"Cookie": "; ".join(f"{k}={v}" for k, v in response.cookies.items())}


def _invite(h: AppHarness, browser: dict[str, str], name: str):  # noqa: ANN202
    body = {"email": f"{name}@example.test", "role": "member"}
    return h.client.post("/v1/team/invitations", json=body, headers=browser)


def _member(h: AppHarness, browser: dict[str, str]) -> tuple[str, str]:
    """A second member, through a real invitation, as ``(member id, username)``."""
    name = f"member-{uuid.uuid4().hex[:8]}"
    made = _invite(h, browser, name)
    assert made.status_code == 200, made.text
    token = parse_qs(urlsplit(made.json()["invite_url"]).query)["invite"][0]
    joined = h.client.post(
        "/auth/register",
        json={"invite": token, "username": name, "password": "member-password-0001"},
    )
    assert joined.status_code == 200, joined.text
    h.client.cookies.clear()
    members = h.client.get("/v1/team", headers=browser).json()["members"]
    (member,) = [m for m in members if m["user_id"] == name]
    return member["member_id"], name


def _invitation_state(h: AppHarness, invitation: str) -> list[tuple]:
    sql = "SELECT state, closed_at IS NOT NULL FROM team_invitations WHERE lower(hex(id)) = ?"
    return rows(h.db_path, sql, invitation.replace("-", "").lower())


def test_a_revoked_invitation_is_held_and_applied_while_blocked(blocked: AppHarness) -> None:
    browser = _browser(blocked)
    made = _invite(blocked, browser, f"revoked-{uuid.uuid4().hex[:8]}")
    assert_confirmed(made)
    invitation = made.json()["invitation"]["invitation_id"]
    assert _invitation_state(blocked, invitation) == [(1, 0)]
    _block(blocked)
    path = f"/v1/team/invitations/{invitation}"
    assert_unconfirmed(blocked.client.delete(path, headers=browser), path)
    assert _invitation_state(blocked, invitation) == [(3, 1)]


def test_a_revoked_invitation_is_confirmed_when_healthy(healthy: AppHarness) -> None:
    browser = _browser(healthy)
    made = _invite(healthy, browser, f"revoked-{uuid.uuid4().hex[:8]}")
    invitation = made.json()["invitation"]["invitation_id"]
    assert_confirmed(healthy.client.delete(f"/v1/team/invitations/{invitation}", headers=browser))


def test_a_new_invitation_is_held_while_blocked(blocked: AppHarness) -> None:
    browser = _browser(blocked)
    _block(blocked)
    assert_unconfirmed(
        _invite(blocked, browser, f"new-{uuid.uuid4().hex[:8]}"), "/v1/team/invitations"
    )


def test_a_lowered_role_a_suspension_and_a_removal_are_held_while_blocked(
    blocked: AppHarness,
) -> None:
    browser = _browser(blocked)
    member, _ = _member(blocked, browser)
    role = f"/v1/team/members/{member}/role"
    assert_confirmed(blocked.client.put(role, json={"role": "admin"}, headers=browser))
    _block(blocked)
    assert_unconfirmed(blocked.client.put(role, json={"role": "member"}, headers=browser), role)
    for action in ("suspend", "remove"):
        path = f"/v1/team/members/{member}/{action}"
        assert_unconfirmed(blocked.client.post(path, headers=browser), path)


def test_removing_an_approver_and_turning_off_self_approval_are_held_while_blocked(
    blocked: AppHarness,
) -> None:
    browser = _browser(blocked)
    _, name = _member(blocked, browser)
    named = blocked.client.post(
        "/v1/approvers", json={"kind": "team", "user_id": name}, headers=browser
    )
    assert_confirmed(named)
    _block(blocked)
    path = "/v1/approvers"
    gone = blocked.client.delete(path, params={"kind": "team", "user_id": name}, headers=browser)
    assert_unconfirmed(gone, path)
    sql = "SELECT 1 FROM approver_grants WHERE approver_user_id = ?"
    assert rows(blocked.db_path, sql, name) == []
    settings = "/v1/approval-settings"
    off = {"kind": "team", "allow_initiator": False}
    assert_unconfirmed(blocked.client.put(settings, json=off, headers=browser), settings)


def test_a_new_or_changed_policy_is_held_while_blocked(blocked: AppHarness) -> None:
    browser = _browser(blocked)
    rule = {"handler": CEL, "factory_params": {"expression": '{"result": "ALLOW"}'}}
    name = f"rule-{uuid.uuid4().hex[:8]}"
    made = blocked.client.post(
        "/v1/protected-policies",
        json={"domain": "team", "name": name, **rule},
        headers=browser,
    )
    assert_confirmed(made)
    _block(blocked)
    path = f"/v1/protected-policies/{made.json()['id']}"
    assert_unconfirmed(blocked.client.patch(path, json={"enabled": False}, headers=browser), path)
    path = "/v1/protected-policies"
    tightened = {"domain": "team", "name": f"{name}-2", **rule}
    assert_unconfirmed(blocked.client.post(path, json=tightened, headers=browser), path)
    path = "/v1/policies"
    default = {"name": f"{name}-default", "type": "python", **rule}
    assert_unconfirmed(blocked.client.post(path, json=default, headers=browser), path)


def test_a_share_revoked_or_lowered_is_held_while_blocked(blocked: AppHarness) -> None:
    bearer = blocked.bearer()
    browser = _browser(blocked)
    _, name = _member(blocked, browser)
    agent_id = _agent_id(blocked, bearer)
    session = blocked.client.post("/v1/sessions", json={"agent_id": agent_id}, headers=bearer)
    path = f"/v1/sessions/{session.json()['id']}/permissions"
    assert_confirmed(blocked.client.put(path, json={"user_id": name, "level": 3}, headers=bearer))
    _block(blocked)
    lowered = blocked.client.put(path, json={"user_id": name, "level": 1}, headers=bearer)
    assert_unconfirmed(lowered, path)
    assert_unconfirmed(blocked.client.delete(f"{path}/{name}", headers=bearer), path)


def test_deleting_a_thread_removes_its_grants_so_it_is_held_while_blocked(
    blocked: AppHarness,
) -> None:
    bearer = blocked.bearer()
    agent_id = _agent_id(blocked, bearer)
    session = blocked.client.post("/v1/sessions", json={"agent_id": agent_id}, headers=bearer)
    path = f"/v1/sessions/{session.json()['id']}"
    _block(blocked)
    assert_unconfirmed(blocked.client.delete(path, headers=bearer), path)


def _overrides(h: AppHarness, session_id: str) -> str:
    sql = "SELECT session_overrides FROM conversations WHERE lower(hex(id)) = ?"
    return rows(h.db_path, sql, session_id.replace("-", "").lower())[0][0] or ""


def test_turning_off_workspace_sharing_is_held_and_a_title_change_is_not(
    blocked: AppHarness,
) -> None:
    """View-level collaborators browse the workspace while the flag is on: a lost "off" would
    give that back. The flag lives in ``conversations`` with ordinary settings, so the request
    is held when its body sets it."""
    bearer = blocked.bearer()
    agent_id = _agent_id(blocked, bearer)
    session = blocked.client.post("/v1/sessions", json={"agent_id": agent_id}, headers=bearer)
    session_id = session.json()["id"]
    path = f"/v1/sessions/{session_id}"
    on = blocked.client.patch(path, json={"share_workspace_files": True}, headers=bearer)
    assert_confirmed(on)
    assert "share_workspace_files" in _overrides(blocked, session_id)
    _block(blocked)
    off = blocked.client.patch(path, json={"share_workspace_files": False}, headers=bearer)
    assert_unconfirmed(off, path)
    assert "share_workspace_files" not in _overrides(blocked, session_id)  # applied
    assert_not_held(blocked.client.patch(path, json={"title": "renamed"}, headers=bearer))


def test_a_base_path_does_not_skip_the_held_routes(tmp_path: Path) -> None:
    """The barrier sees the path before Omnigent strips ``OMNIGENT_WEB_BASE_PATH``: prefixed and
    unprefixed requests are held alike, and an auth route keeps its own 424 shape."""
    with serve_app(tmp_path, {"OMNIGENT_WEB_BASE_PATH": "/omnigent"}) as h:
        bearer = h.bearer()
        _, name = _member(h, _browser(h))
        agent_id = _agent_id(h, bearer)
        made = h.client.post("/omnigent/v1/sessions", json={"agent_id": agent_id}, headers=bearer)
        session_id = made.json()["id"]
        for prefix in ("/omnigent", ""):
            h.fake.mode = "healthy"
            share = f"{prefix}/v1/sessions/{session_id}/permissions"
            grant = {"user_id": name, "level": 3}
            assert_confirmed(h.client.put(share, json=grant, headers=bearer))
            _block(h)
            lowered = h.client.put(share, json={"user_id": name, "level": 1}, headers=bearer)
            assert_unconfirmed(lowered, share)
            settings = f"{prefix}/v1/sessions/{session_id}"
            off = h.client.patch(settings, json={"share_workspace_files": False}, headers=bearer)
            assert_unconfirmed(off, settings)
        login = h.client.post(
            "/omnigent/auth/login",
            json={"username": OWNER, "password": OWNER_PASSWORD, "issue_refresh": True},
        )
        assert_unconfirmed(login, "/auth/login")


def test_signing_in_under_required_identity_is_not_held_while_blocked(tmp_path: Path) -> None:
    """Live runs in ``required`` mode: a first sign-in binds the identity, a later one only
    stamps the login. Neither may wait for the replica."""
    from omnigent.server.external_identity import (
        ENVELOPE_HEADER,
        ExternalIdentity,
        sign_envelope,
    )

    from cfo_server.config import envelope_key

    def sign_in(h: AppHarness):  # noqa: ANN202
        now = int(time.time())
        identity = ExternalIdentity(
            issuer="https://issuer.example.test",
            subject="owner-subject",
            audience="barrier-test",
            email="owner@example.test",
            installation_owner=True,
            issued_at=now,
            expires_at=now + 50,
        )
        envelope = sign_envelope(identity, envelope_key(COOKIE_SECRET).encode())
        response = h.client.post(
            "/auth/login",
            json={"username": OWNER, "password": OWNER_PASSWORD},
            headers={ENVELOPE_HEADER: envelope},
        )
        h.client.cookies.clear()
        return response

    with serve_app(tmp_path, {"OMNIGENT_EXTERNAL_IDENTITY_MODE": "required"}) as harness:
        harness.fake.mode = "blocked"
        assert_not_held(sign_in(harness))
        assert rows(harness.db_path, "SELECT COUNT(*) FROM team_identity_bindings") == [(1,)]
        assert_not_held(sign_in(harness))


def test_ordinary_writes_and_reads_are_not_held_while_blocked(blocked: AppHarness) -> None:
    bearer = blocked.bearer()
    browser = _browser(blocked)
    agent_id = _agent_id(blocked, bearer)
    _block(blocked)
    session = blocked.client.post("/v1/sessions", json={"agent_id": agent_id}, headers=bearer)
    assert_not_held(session)
    assert_not_held(blocked.client.get("/v1/scheduled-tasks", headers=bearer))
    assert_not_held(blocked.client.get("/health"))
    assert_not_held(blocked.client.get("/v1/team", headers=browser))
    assert_not_held(
        blocked.client.post(
            f"/v1/sessions/{session.json()['id']}/events",
            json={"type": "external_session_status", "data": {"status": "running"}},
            headers=bearer,
        )
    )


def test_a_held_request_never_blocks_the_event_loop(blocked: AppHarness) -> None:
    bearer = blocked.bearer()
    agent_id = _agent_id(blocked, bearer)
    _block(blocked)
    results: dict[str, object] = {}

    def held() -> None:
        results["held"] = blocked.client.post(
            "/v1/scheduled-tasks", json=_schedule_body(agent_id, "loop-check"), headers=bearer
        )

    thread = threading.Thread(target=held)
    thread.start()
    time.sleep(0.3)
    latencies = []
    while thread.is_alive():
        started = time.monotonic()
        assert blocked.client.get("/health").status_code == 200
        latencies.append(time.monotonic() - started)
        time.sleep(0.05)
    thread.join()
    assert_unconfirmed(results["held"], "/v1/scheduled-tasks")
    assert latencies and max(latencies) < 0.5


def test_no_sync_request_ever_asks_litestream_to_wait(app_harness: AppHarness) -> None:
    bodies = app_harness.fake.sync_bodies
    assert bodies, "the barrier never asked Litestream"
    assert all(set(body) == {"path"} for body in bodies), bodies
