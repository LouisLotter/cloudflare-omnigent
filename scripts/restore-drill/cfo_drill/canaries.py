"""Acknowledged changes through Omnigent's real HTTP routes, and their check after a restore.

:func:`write_canaries` makes one of each security change RC-03 names, plus transcript items:

- a password change (it rotates the account generation, so it comes first: grants issued
  before it stop refreshing);
- a login that issues a refresh grant, and a second one whose grant is then revoked;
- an admin invite;
- schedules: one created, one created then edited, one created then deleted;
- transcript items in a new conversation (core change 14's acknowledged items).

Each change's answer says whether the server acknowledged it as durable: ``x-cfo-durability:
confirmed`` on a security route (a 424 is "applied, durability not confirmed"), and any 2xx on
the transcript route (the transcript barrier answers 503 otherwise). :func:`verify_http`
checks the acknowledged ones through the same routes on a replaced server, as spike S4 did.

The refresh tokens and passwords live only in this process's memory (:class:`Secrets`); the
canary list (:class:`cfo_drill.db.Canary`) and every report hold identifiers and verdicts only.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from cfo_drill import db

#: Never fires in practice: once a year, at 03:00 on 1 January.
RRULE = "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;BYHOUR=3"
RRULE_EDITED = "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=2;BYHOUR=3"
OWNER = "owner"

LiveQuery = Callable[[str, Sequence[Any]], list[tuple[Any, ...]]]


@dataclass
class Secrets:
    """Credentials the run needs to verify itself; never serialized."""

    password: str
    refresh_kept: str | None = None
    refresh_revoked: str | None = None
    original_password: str | None = None

    def values(self) -> list[str]:
        return [
            v
            for v in (
                self.password,
                self.refresh_kept,
                self.refresh_revoked,
                self.original_password,
            )
            if v
        ]


@dataclass
class Ack:
    label: str
    status: int
    durability: str | None
    seconds: float

    @property
    def acknowledged(self) -> bool:
        return 200 <= self.status < 300 and self.durability in ("confirmed", None)

    def to_json(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "status": self.status,
            "durability": self.durability,
            "ms": round(self.seconds * 1000, 1),
        }


@dataclass
class CanaryRun:
    run_id: str
    secrets: Secrets
    canaries: list[db.Canary] = field(default_factory=list)
    acks: list[Ack] = field(default_factory=list)
    conversation: str | None = None
    schedules: dict[str, str] = field(default_factory=dict)  # role -> schedule id (hex)
    items: list[tuple[str, str]] = field(default_factory=list)  # (source_id, item_id)
    last_ack_at: float | None = None

    def summary(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "conversation": self.conversation,
            "acknowledged": sum(1 for c in self.canaries if c.acknowledged),
            "unacknowledged": sum(1 for c in self.canaries if not c.acknowledged),
            "acks": [a.to_json() for a in self.acks],
        }


class Omnigent:
    """A small client for the routes the drill uses, as the web UI and CLIs call them."""

    def __init__(self, base_url: str, *, timeout: float = 60.0) -> None:
        self.http = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers={"user-agent": "cfo-restore-drill/1"},
            limits=httpx.Limits(max_keepalive_connections=0),
        )

    def close(self) -> None:
        self.http.close()

    def __enter__(self) -> Omnigent:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def login(self, password: str, *, refresh: bool = False) -> httpx.Response:
        response = self.http.post(
            "/auth/login",
            json={"username": OWNER, "password": password, "issue_refresh": refresh},
        )
        self.http.cookies.clear()
        return response

    def bearer(self, password: str) -> dict[str, str]:
        response = self.login(password)
        if response.status_code != 200:
            raise RuntimeError(f"login failed with {response.status_code}")
        return {"Authorization": f"Bearer {response.json()['token']}"}

    def agent_id(self, bearer: dict[str, str]) -> str:
        body = self.http.get("/v1/agents", headers=bearer).json()
        return (body.get("data") or body.get("agents") or body)[0]["id"]

    def refresh(self, token: str) -> httpx.Response:
        return self.http.post(
            "/oauth/token", data={"grant_type": "refresh_token", "refresh_token": token}
        )


def item_event(source_id: str) -> dict[str, Any]:
    """A transcript item as a native forwarder posts it (core change 14)."""
    return {
        "type": "external_conversation_item",
        "data": {
            "item_type": "message",
            "response_id": "resp_drill",
            "source_id": source_id,
            "item_data": {
                "role": "assistant",
                "agent": "codex-native-ui",
                "content": [{"type": "output_text", "text": f"drill item {source_id}"}],
            },
        },
    }


def _timed(label: str, call: Callable[[], httpx.Response], run: CanaryRun) -> httpx.Response:
    started = time.monotonic()
    response = call()
    ack = Ack(
        label,
        response.status_code,
        response.headers.get("x-cfo-durability"),
        time.monotonic() - started,
    )
    run.acks.append(ack)
    run.last_ack_at = time.monotonic()
    return response


def _new_ids(live: LiveQuery | None, sql: str, before: set[Any]) -> list[Any]:
    if live is None:
        return []
    return [row[0] for row in live(sql, ()) if row[0] not in before]


def _ids(live: LiveQuery | None, sql: str) -> set[Any]:
    return {row[0] for row in live(sql, ())} if live is not None else set()


def write_canaries(
    client: Omnigent,
    password: str,
    *,
    run_id: str | None = None,
    items: int = 5,
    change_password: bool = True,
    live: LiveQuery | None = None,
) -> CanaryRun:
    """Make the canary changes. ``live`` reads the live database, to find the rows of grants
    and invites, whose ids no answer carries; without it those are checked over HTTP only."""
    run_id = run_id or uuid.uuid4().hex[:8]
    secrets = Secrets(password=password, original_password=password)
    run = CanaryRun(run_id=run_id, secrets=secrets)
    grants_sql = "SELECT id FROM device_grants WHERE workspace_id = 0"
    tokens_sql = "SELECT id FROM account_tokens WHERE workspace_id = 0"

    if change_password:
        new_password = f"drill-{uuid.uuid4().hex}"
        bearer = client.bearer(secrets.password)
        response = _timed(
            "password_change",
            lambda: client.http.post(
                "/auth/users/me/password",
                json={"old_password": secrets.password, "new_password": new_password},
                headers=bearer,
            ),
            run,
        )
        client.http.cookies.clear()
        if response.status_code in (200, 204, 424):
            secrets.password = new_password  # applied even when unconfirmed (424)
        run.canaries.append(
            db.Canary(
                "password_change",
                "users",
                (0, OWNER),
                run.acks[-1].acknowledged,
                status=response.status_code,
            )
        )

    before = _ids(live, grants_sql)
    response = _timed("grant_issued", lambda: client.login(secrets.password, refresh=True), run)
    if response.status_code == 200:
        secrets.refresh_kept = response.json().get("refresh_token")
    for grant in _new_ids(live, grants_sql, before):
        run.canaries.append(
            db.Canary(
                "grant_issued",
                "device_grants",
                (0, grant),
                run.acks[-1].acknowledged,
                status=response.status_code,
            )
        )

    before = _ids(live, grants_sql)
    issued = client.login(secrets.password, refresh=True)
    revoked_ids = _new_ids(live, grants_sql, before)
    if issued.status_code == 200:
        secrets.refresh_revoked = issued.json().get("refresh_token")
        response = _timed(
            "grant_revoked",
            lambda: client.http.post(
                "/oauth/revoke", data={"refresh_token": secrets.refresh_revoked}
            ),
            run,
        )
        for grant in revoked_ids:
            run.canaries.append(
                db.Canary(
                    "grant_revoked",
                    "device_grants",
                    (0, grant),
                    run.acks[-1].acknowledged,
                    status=response.status_code,
                )
            )

    bearer = client.bearer(secrets.password)
    before = _ids(live, tokens_sql)
    response = _timed(
        "admin_invite",
        lambda: client.http.post("/auth/invite", json={"is_admin": False}, headers=bearer),
        run,
    )
    for token_id in _new_ids(live, tokens_sql, before):
        run.canaries.append(
            db.Canary(
                "admin_invite",
                "account_tokens",
                (0, token_id),
                run.acks[-1].acknowledged,
                status=response.status_code,
            )
        )

    agent = client.agent_id(bearer)

    def schedule(role: str, name: str) -> str | None:
        response = _timed(
            f"schedule_{role}",
            lambda: client.http.post(
                "/v1/scheduled-tasks",
                headers=bearer,
                json={
                    "name": name,
                    "prompt": "restore drill canary",
                    "rrule": RRULE,
                    "agent_id": agent,
                    "timezone": "UTC",
                },
            ),
            run,
        )
        if response.status_code in (200, 201, 424):
            task_id = response.json().get("id") if response.status_code != 424 else None
            if task_id is None and live is not None:
                rows = live("SELECT hex(id) FROM scheduled_tasks WHERE name = ?", (name,))
                task_id = rows[0][0].lower() if rows else None
            if task_id:
                run.schedules[role] = task_id
                return task_id
        return None

    created = schedule("created", f"drill-{run_id}-created")
    if created:
        run.canaries.append(
            db.Canary(
                "schedule_created",
                "scheduled_tasks",
                (0, bytes.fromhex(created)),
                run.acks[-1].acknowledged,
                status=run.acks[-1].status,
            )
        )
    edited = schedule("edited", f"drill-{run_id}-edited")
    if edited:
        response = _timed(
            "schedule_edit",
            lambda: client.http.patch(
                f"/v1/scheduled-tasks/{edited}",
                json={"name": f"drill-{run_id}-edited-2", "rrule": RRULE_EDITED},
                headers=bearer,
            ),
            run,
        )
        run.canaries.append(
            db.Canary(
                "schedule_edit",
                "scheduled_tasks",
                (0, bytes.fromhex(edited)),
                run.acks[-1].acknowledged and run.acks[-2].acknowledged,
                status=response.status_code,
            )
        )
    deleted = schedule("deleted", f"drill-{run_id}-deleted")
    if deleted:
        response = _timed(
            "schedule_delete",
            lambda: client.http.delete(f"/v1/scheduled-tasks/{deleted}", headers=bearer),
            run,
        )
        run.canaries.append(
            db.Canary(
                "schedule_delete",
                "scheduled_tasks",
                (0, bytes.fromhex(deleted)),
                run.acks[-1].acknowledged,
                expect="absent",
                status=response.status_code,
            )
        )

    if items > 0:
        session = client.http.post("/v1/sessions", json={"agent_id": agent}, headers=bearer)
        session.raise_for_status()
        run.conversation = session.json()["id"]
        for index in range(items):
            source = f"drill-{run_id}-{index}"
            response = _timed(
                f"item_{index}",
                lambda source=source: client.http.post(
                    f"/v1/sessions/{run.conversation}/events",
                    json=item_event(source),
                    headers=bearer,
                ),
                run,
            )
            item_id = response.json().get("item_id") if response.status_code < 300 else None
            if item_id:
                run.items.append((source, item_id))
                run.canaries.append(
                    db.Canary(
                        f"item_{index}",
                        db.ITEMS_TABLE,
                        (0, bytes.fromhex(run.conversation), bytes.fromhex(item_id)),
                        run.acks[-1].acknowledged,
                        status=response.status_code,
                    )
                )
            else:
                run.items.append((source, ""))
    return run


def _schedules(client: Omnigent, bearer: dict[str, str]) -> dict[str, dict[str, Any]]:
    body = client.http.get("/v1/scheduled-tasks", headers=bearer).json()
    tasks = body.get("data") or body.get("scheduled_tasks") or []
    return {str(t["id"]).replace("-", "").lower(): t for t in tasks}


def _item_texts(client: Omnigent, bearer: dict[str, str], conversation: str) -> list[str]:
    body = client.http.get(f"/v1/sessions/{conversation}/items", headers=bearer).json()
    return [
        block.get("text", "")
        for item in body.get("data", [])
        for block in item.get("content", [])
        if isinstance(block, dict)
    ]


def verify_http(client: Omnigent, run: CanaryRun) -> list[db.Check]:
    """Check the acknowledged changes through Omnigent's routes on a (replaced) server.

    An unacknowledged change may be lost; it is reported, never failed on.
    """
    acked = {a.label: a.acknowledged for a in run.acks}
    checks: list[db.Check] = []
    secrets = run.secrets
    if "password_change" in acked:
        new_ok = client.login(secrets.password).status_code == 200
        old_refused = (
            secrets.original_password is None
            or client.login(secrets.original_password).status_code != 200
        )
        checks.append(
            db.Check(
                "http.password_change",
                (new_ok and old_refused) or not acked["password_change"],
                {
                    "new_password_works": new_ok,
                    "old_password_refused": old_refused,
                    "acknowledged": acked["password_change"],
                },
            )
        )
    password = secrets.password
    if client.login(password).status_code != 200 and secrets.original_password:
        password = secrets.original_password  # an unacknowledged password change was lost
    bearer = client.bearer(password)
    if secrets.refresh_kept:
        works = client.refresh(secrets.refresh_kept).status_code == 200
        checks.append(
            db.Check(
                "http.grant_issued",
                works or not acked.get("grant_issued", False),
                {"refreshes": works, "acknowledged": acked.get("grant_issued")},
            )
        )
    if secrets.refresh_revoked:
        refused = client.refresh(secrets.refresh_revoked).status_code != 200
        checks.append(
            db.Check(
                "http.grant_revoked",
                refused or not acked.get("grant_revoked", False),
                {"refused": refused, "acknowledged": acked.get("grant_revoked")},
            )
        )
    tasks = _schedules(client, bearer)
    expectations = {
        "created": (acked.get("schedule_created"), lambda t: t is not None),
        "edited": (
            acked.get("schedule_edit"),
            lambda t: (
                t is not None
                and t.get("name") == f"drill-{run.run_id}-edited-2"
                and t.get("rrule") == RRULE_EDITED
            ),
        ),
        "deleted": (acked.get("schedule_delete"), lambda t: t is None),
    }
    for role, (was_acked, test) in expectations.items():
        task_id = run.schedules.get(role)
        if task_id is None or was_acked is None:
            continue
        holds = bool(test(tasks.get(task_id.replace("-", "").lower())))
        checks.append(
            db.Check(
                f"http.schedule_{role}",
                holds or not was_acked,
                {"holds": holds, "acknowledged": was_acked},
            )
        )
    if run.conversation is not None:
        texts = _item_texts(client, bearer, run.conversation)
        present = [s for s, _ in run.items if texts.count(f"drill item {s}") == 1]
        acked_items = [s for i, (s, _) in enumerate(run.items) if acked.get(f"item_{i}")]
        lost = [s for s in acked_items if s not in present]
        checks.append(
            db.Check(
                "http.transcript_items",
                not lost,
                {"acknowledged": len(acked_items), "present": len(present), "lost": lost},
            )
        )
    sharing = client.http.get("/v1/sharing", headers=bearer)
    editable = {
        k: v
        for k, v in (sharing.json() if sharing.status_code == 200 else {}).items()
        if k == "editable" or k.endswith("_editable")
    }
    checks.append(
        db.Check(
            "http.sharing_managed",
            sharing.status_code == 200 and bool(editable) and not any(editable.values()),
            {"status": sharing.status_code, "editable": editable},
        )
    )
    return checks
