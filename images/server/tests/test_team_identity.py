"""Teams behind Access in the server image (WP8.3).

- the external-identity settings: off by default, a malformed mode refuses to start, the
  envelope key derived from the cookie secret as the platform Worker derives it, and never taken
  from the environment;
- the admission adapter: the exact body and signature the platform route checks, success only
  for ``applied`` or ``stale``;
- ``/_cfo/page-person``: signed like the owner's password call, answering the bound member or
  ``none``, 501 for an Omnigent without the team model;
- the adapter reaches ``create_app`` only when it is on and the pinned Omnigent takes it.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from cfo_server import admission
from cfo_server import app as image_app
from cfo_server import config as image_config
from cfo_server import owner_password as op

from conftest import COOKIE_SECRET, DOCKER_ENTRYPOINT, requires_omnigent

BASE = {
    "OMNIGENT_ACCOUNTS_BASE_URL": "https://omnigent.example.test",
    "OMNIGENT_ACCOUNTS_COOKIE_SECRET": COOKIE_SECRET,
    "CFO_INSTALLATION_INITIALIZED": "true",
    "CFO_ALLOW_LOCAL_ARTIFACTS": "true",
}


def _load(**env: str) -> image_config.ServerImageConfig:
    return image_config.load({**BASE, **env}, for_app=True)


# ── Settings ───────────────────────────────────────────────────────────────────────────


def test_external_identity_is_off_by_default_and_passes_no_key() -> None:
    config = _load()
    assert (config.external_identity_mode, config.access_admission) == ("off", False)
    app_env = image_config.app_environment(config, BASE)
    assert app_env["OMNIGENT_EXTERNAL_IDENTITY_MODE"] == "off"
    assert "OMNIGENT_EXTERNAL_IDENTITY_KEY" not in app_env


def test_a_mode_gets_the_key_derived_from_the_cookie_secret_never_the_environments() -> None:
    env = {
        **BASE,
        "OMNIGENT_EXTERNAL_IDENTITY_MODE": "Required",
        "OMNIGENT_EXTERNAL_IDENTITY_KEY": "x" * 64,
    }
    config = image_config.load(env, for_app=True)
    assert config.external_identity_mode == "required"
    assert any("OMNIGENT_EXTERNAL_IDENTITY_KEY removed" in w for w in config.warnings)
    app_env = image_config.app_environment(config, env)
    expected = hmac.new(
        COOKIE_SECRET.encode(), b"cfo/omnigent-external-identity/v1", hashlib.sha256
    ).hexdigest()
    assert app_env["OMNIGENT_EXTERNAL_IDENTITY_KEY"] == expected


def test_the_envelope_key_matches_the_workers_derivation() -> None:
    # worker/test/unit/identity-envelope.test.ts derives the same value.
    assert image_config.envelope_key("ab" * 32) == (
        "f9cc3e22721562f8fa6d7bec59e3fc79dfcc1b209f3192d12436e5563a28face"
    )


@pytest.mark.parametrize(
    "env",
    [
        {"OMNIGENT_EXTERNAL_IDENTITY_MODE": "sometimes"},
        {"CFO_ACCESS_ADMISSION": "true"},
        {"CFO_ACCESS_ADMISSION": "maybe", "OMNIGENT_EXTERNAL_IDENTITY_MODE": "bind"},
    ],
)
def test_a_malformed_or_inconsistent_setting_refuses_to_start(env: dict[str, str]) -> None:
    with pytest.raises(image_config.ConfigError):
        _load(**env)


def test_admission_needs_a_mode() -> None:
    config = _load(OMNIGENT_EXTERNAL_IDENTITY_MODE="bind", CFO_ACCESS_ADMISSION="true")
    assert config.access_admission is True


# ── The admission adapter ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Snapshot:
    revision: int
    emails: tuple[str, ...]
    owners: tuple[str, ...] = ()


@dataclass(frozen=True)
class SnapshotWithoutOwners:
    revision: int
    emails: tuple[str, ...]


KEY = b"k" * 32


def _adapter(status: int, answer: dict[str, Any]) -> tuple[admission.PlatformAdmission, list]:
    sent: list[tuple[str, bytes, dict[str, str]]] = []

    def post(url: str, body: bytes, headers: Any) -> tuple[int, bytes]:
        sent.append((url, body, dict(headers)))
        return status, json.dumps(answer).encode()

    adapter = admission.PlatformAdmission(
        key=KEY, key_id="key-1", post=post, clock=lambda: 1_800_000_000
    )
    return adapter, sent


def test_the_adapter_signs_the_exact_body_for_the_admission_route() -> None:
    adapter, sent = _adapter(200, {"outcome": "applied", "revision": 4})
    adapter.apply(
        Snapshot(4, ("alice@example.test", "owner@example.test"), ("owner@example.test",))
    )
    url, body, headers = sent[0]
    assert url == "http://platform.internal/access/v1/admission"
    assert body == (
        b'{"emails":["alice@example.test","owner@example.test"],'
        b'"owners":["owner@example.test"],"revision":4}'
    )
    message = "\n".join(
        ("cfo-access-admission/v1", "key-1", "1800000000", hashlib.sha256(body).hexdigest())
    )
    assert headers["X-Omnigent-Signature"] == hmac.new(KEY, message.encode(), "sha256").hexdigest()
    assert headers["X-Omnigent-Signing-Key-Id"] == "key-1"
    assert headers["X-Omnigent-Timestamp"] == "1800000000"


def test_a_snapshot_without_owners_is_sent_with_none() -> None:
    adapter, sent = _adapter(409, {"outcome": "refused", "reason": "owner_missing"})
    with pytest.raises(admission.AdmissionNotApplied):
        adapter.apply(SnapshotWithoutOwners(4, ("owner@example.test",)))
    assert json.loads(sent[0][1])["owners"] == []


def test_the_adapter_succeeds_on_applied_or_stale_and_raises_otherwise() -> None:
    _adapter(200, {"outcome": "stale", "appliedRevision": 9})[0].apply(Snapshot(4, ()))
    for status, answer in (
        (409, {"outcome": "refused", "reason": "owner_missing"}),
        (503, {"error": {"code": "unavailable"}}),
        (200, {"outcome": "something else"}),
    ):
        with pytest.raises(admission.AdmissionNotApplied):
            _adapter(status, answer)[0].apply(Snapshot(4, ()))


def test_the_adapter_posts_to_platform_internal_whatever_the_environment_says() -> None:
    env = {"CFO_LAUNCHER_SIGNING_KEY": "k" * 32, "CFO_LAUNCHER_SIGNING_KEY_ID": "key-1"}
    assert admission.from_env(env)._url == "http://platform.internal/access/v1/admission"  # type: ignore[union-attr]
    # No setting redirects it: a local test reaches its stand-in by the container's own hosts.
    for name in ("CFO_PLATFORM_INTERNAL_URL_LOCAL_ONLY", "CFO_PLATFORM_INTERNAL_URL"):
        other = {**env, name: "http://host.docker.internal:9123"}
        assert admission.from_env(other)._url == admission.URL  # type: ignore[union-attr]


def test_the_adapter_needs_the_launchers_key() -> None:
    assert admission.from_env({}) is None
    assert admission.from_env({"CFO_LAUNCHER_SIGNING_KEY": "k" * 32}) is None
    assert admission.from_env(
        {"CFO_LAUNCHER_SIGNING_KEY": "k" * 32, "CFO_LAUNCHER_SIGNING_KEY_ID": "key-1"}
    )


# ── /_cfo/page-person ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FakeMember:
    id: str
    user_id: str
    role: str
    state: str


class FakeTeamStore:
    def __init__(self, bound: dict[tuple[str, str, str], FakeMember]) -> None:
        self.bound = bound

    def member_for_external_identity(self, issuer: str, subject: str, *, audience: str) -> Any:
        return self.bound.get((issuer, subject, audience))


async def _inner(scope: Any, receive: Any, send: Any) -> None:
    raise AssertionError("passed through")


def _call(
    middleware: op.OwnerPasswordMiddleware,
    body: bytes,
    headers: dict[str, str],
    path: str = op.PAGE_PERSON_PATH,
):
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": [(k.encode(), v.encode()) for k, v in headers.items()],
    }
    messages = [{"type": "http.request", "body": body, "more_body": False}]
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return messages.pop(0) if messages else {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))
    return sent[0]["status"], json.loads(sent[1]["body"])


def _signed(body: bytes, path: str = op.PAGE_PERSON_PATH) -> dict[str, str]:
    stamp = str(int(time.time()))
    key = op.platform_call_key(COOKIE_SECRET)
    return {
        "x-cfo-call-timestamp": stamp,
        "x-cfo-call-signature": op.sign(key, "POST", path, stamp, body),
    }


def _middleware(team_store: Any, team_status: Any = None) -> op.OwnerPasswordMiddleware:
    return op.OwnerPasswordMiddleware(
        _inner,
        cookie_secret=COOKIE_SECRET,
        username="owner",
        account_store=None,
        auth_provider=None,
        hash_password=lambda password: password,
        team_store=team_store,
        team_status=team_status,
    )


def _body(subject: str) -> bytes:
    return json.dumps(
        {
            "issuer": "https://team.example",
            "subject": subject,
            "audience": "aud",
            "nonce": secrets.token_hex(16),
        }
    ).encode()


ALICE = FakeMember("0123456789abcdef0123456789abcdef", "alice", "member", "active")


def test_page_person_answers_the_bound_member_and_none_for_anyone_else() -> None:
    middleware = _middleware(FakeTeamStore({("https://team.example", "alice-sub", "aud"): ALICE}))
    body = _body("alice-sub")
    assert _call(middleware, body, _signed(body)) == (
        200,
        {
            "action": "member",
            "memberId": ALICE.id,
            "userId": "alice",
            "role": "member",
            "state": "active",
        },
    )
    body = _body("bob-sub")
    assert _call(middleware, body, _signed(body)) == (200, {"action": "none"})


@requires_omnigent
def test_page_person_gets_no_member_for_a_removed_members_still_valid_sign_in(
    tmp_path: Path,
) -> None:
    """A removed member's Access sign-in is bound to nobody, so it gets no page (WP8.9)."""
    from omnigent.server.accounts_store import SqlAlchemyAccountStore
    from omnigent.stores.team_store import SqlAlchemyTeamStore

    url = f"sqlite:///{tmp_path / 'omnigent.db'}"
    image_app.load_docker_entrypoint(DOCKER_ENTRYPOINT).run_migrations(url)
    accounts, teams = SqlAlchemyAccountStore(url), SqlAlchemyTeamStore(url)
    accounts.create_user_with_password("owner", "hash", is_admin=True, team_owner=True)
    accounts.create_user_with_password("alice", "hash")
    owner = teams.get_member_for_account("owner")
    assert owner is not None
    alice = teams.add_member("alice", role="member", state="active")
    teams.bind_external_identity(
        alice.id,
        issuer="https://team.example",
        subject="alice-sub",
        audience="aud",
        provenance="invitation",
        email="alice@example.test",
    )
    middleware = _middleware(teams)
    body = _body("alice-sub")
    assert _call(middleware, body, _signed(body))[1]["memberId"] == alice.id

    accounts.remove_member(alice.id, actor_member_id=owner.id)

    body = _body("alice-sub")
    assert _call(middleware, body, _signed(body)) == (200, {"action": "none"})


def test_page_person_refuses_an_unsigned_or_replayed_call() -> None:
    middleware = _middleware(FakeTeamStore({}))
    body = _body("alice-sub")
    assert _call(middleware, body, {})[0] == 401
    headers = _signed(body)
    assert _call(middleware, body, headers)[0] == 200
    assert _call(middleware, body, headers)[0] == 401


def test_page_person_is_unsupported_without_the_team_model() -> None:
    body = _body("alice-sub")
    assert _call(_middleware(None), body, _signed(body))[0] == 501


# ── /_cfo/team-status ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FakeHost:
    host_id: str
    owner: str | None
    launch_token: bool
    identity: str


@dataclass(frozen=True)
class FakeStatus:
    owners: int
    owners_bound: int
    revision: int
    hosts: tuple[FakeHost, ...]


def _status_body(**extra: Any) -> bytes:
    return json.dumps({"nonce": secrets.token_hex(16), **extra}).encode()


def test_team_status_reports_owners_and_hosts_by_id_only() -> None:
    status = FakeStatus(
        owners=1,
        owners_bound=1,
        revision=4,
        hosts=(
            FakeHost("a" * 32, "owner", False, "owner"),
            FakeHost("b" * 32, "owner", True, "none"),
            FakeHost("c" * 32, "alice", False, "unbound"),
        ),
    )
    middleware = _middleware(None, lambda: status)
    body = _status_body()
    code, answer = _call(middleware, body, _signed(body, op.TEAM_STATUS_PATH), op.TEAM_STATUS_PATH)
    assert code == 200
    assert answer == {
        "owners": 1,
        "ownersBound": 1,
        "revision": 4,
        "hosts": [
            {
                "hostId": "a" * 32,
                "launchToken": False,
                "installationOwner": True,
                "identity": "owner",
            },
            {
                "hostId": "b" * 32,
                "launchToken": True,
                "installationOwner": True,
                "identity": "none",
            },
            {
                "hostId": "c" * 32,
                "launchToken": False,
                "installationOwner": False,
                "identity": "unbound",
            },
        ],
    }
    # No account name or address leaves the server.
    assert "alice" not in json.dumps(answer)


def test_team_status_refuses_unsigned_malformed_or_unsupported_calls() -> None:
    middleware = _middleware(None, lambda: FakeStatus(0, 0, 0, ()))
    body = _status_body()
    assert _call(middleware, body, {}, op.TEAM_STATUS_PATH)[0] == 401
    # A signature over another path is not valid here.
    assert _call(middleware, body, _signed(body), op.TEAM_STATUS_PATH)[0] == 401
    extra = _status_body(hostId="x")
    assert (
        _call(middleware, extra, _signed(extra, op.TEAM_STATUS_PATH), op.TEAM_STATUS_PATH)[0] == 400
    )
    body = _status_body()
    unsupported = _middleware(None, None)
    assert (
        _call(unsupported, body, _signed(body, op.TEAM_STATUS_PATH), op.TEAM_STATUS_PATH)[0] == 501
    )


# ── create_app's admission keyword ─────────────────────────────────────────────────────


def test_the_adapter_reaches_create_app_only_when_on_and_taken(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CFO_LAUNCHER_SIGNING_KEY", "k" * 32)
    monkeypatch.setenv("CFO_LAUNCHER_SIGNING_KEY_ID", "key-1")

    def with_team(*, team_admission: Any = None) -> None: ...

    def without_team(**_kwargs: Any) -> None: ...

    on = _load(OMNIGENT_EXTERNAL_IDENTITY_MODE="required", CFO_ACCESS_ADMISSION="true")
    off = _load(OMNIGENT_EXTERNAL_IDENTITY_MODE="required")
    assert set(image_app.team_admission_kwargs(with_team, on)) == {"team_admission"}
    assert image_app.team_admission_kwargs(with_team, off) == {}

    def older(*, sharing_mode: Any = None) -> None: ...

    assert image_app.team_admission_kwargs(older, on) == {}
    assert without_team is not None
