"""The team-of-one rehearsal (WP8.11): the new server image's migrations on a copy of the database.

Before ``bootstrap.ts update --team-admission members`` touches the installation, its database
(restored from the replica into a local file, then copied) goes through what the new server does
at its start: Omnigent's migrations, ``tm1`` (the team, its owner), ``ri1`` (runner bindings on
cloud computers retired), ``ap1`` (approvals), the members' successors (WP8.8's ``at1``, ``ti1``:
invitations, the founding owner). Then the checks the move relies on:

- every table that existed keeps its rows: accounts, threads and their items, hosts, schedules,
  grants, connections, policies;
- the team exists with exactly one active owner, the installation's named owner, designated the
  founding member;
- runner bindings on cloud computers (hosts with a sandbox) are retired, each thread re-binding at
  its next launch, and bindings on personal hosts are untouched;
- a synthetic Access identity binds as the founding owner once, and a second one cannot.

Run inside the server image (``scripts/restore-drill/team-rehearsal.sh`` does it with
``--network none`` against a throwaway copy). The report names no person: counts, the checks'
names and whether each passed. The copy is changed (migrated, the synthetic binding written) and
is never written back anywhere.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any

#: Tables whose rows the migrations must keep, when the database has them.
PRESERVED = (
    "users",
    "agents",
    "files",
    "conversations",
    "conversation_items",
    "omnigent_conversation_metadata",
    "session_permissions",
    "hosts",
    "scheduled_tasks",
    "connections",
    "policies",
    "device_grants",
    "account_tokens",
    "projects",
    "comments",
)

_SANDBOX_BOUND = """
SELECT COUNT(*) FROM omnigent_conversation_metadata m
JOIN hosts h ON h.workspace_id = m.workspace_id AND h.host_id = m.host_id
WHERE m.runner_id IS NOT NULL AND h.sandbox_id IS NOT NULL
"""
_PERSONAL_BOUND = """
SELECT COUNT(*) FROM omnigent_conversation_metadata m
JOIN hosts h ON h.workspace_id = m.workspace_id AND h.host_id = m.host_id
WHERE m.runner_id IS NOT NULL AND h.sandbox_id IS NULL
"""


def _tables(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {str(row[0]) for row in rows}


def _scalar(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> Any:
    row = conn.execute(sql, params).fetchone()
    return None if row is None else row[0]


def counts(path: Path) -> dict[str, Any]:
    """Row counts of the preserved tables, and the runner bindings by kind of host."""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        present = _tables(conn)
        rows = {
            table: int(_scalar(conn, f'SELECT COUNT(*) FROM "{table}"'))
            for table in PRESERVED
            if table in present
        }
        bound = {"sandbox": 0, "personal": 0}
        if {"omnigent_conversation_metadata", "hosts"} <= present:
            bound = {
                "sandbox": int(_scalar(conn, _SANDBOX_BOUND)),
                "personal": int(_scalar(conn, _PERSONAL_BOUND)),
            }
        return {"rows": rows, "bound": bound, "tables": sorted(present)}
    finally:
        conn.close()


def migrate(path: Path) -> None:
    """Omnigent's own start-up schema step, as the server runs it on its database."""
    from omnigent.db.utils import _initialize_or_verify_schema, get_or_create_engine

    uri = f"sqlite:///{path}"
    engine = get_or_create_engine(uri)
    try:
        _initialize_or_verify_schema(engine, uri)
    finally:
        engine.dispose()


def rehearse(path: Path, owner: str) -> dict[str, Any]:
    """Migrate the copy at *path* and check it; *owner* is the installation's named owner."""
    from omnigent.db.enum_codecs import encode_team_member_role, encode_team_member_state
    from omnigent.server.external_identity import ExternalIdentity
    from omnigent.stores.host_store import RETIRED_RUNNER_INCARNATION
    from omnigent.stores.team_store import SqlAlchemyTeamStore

    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: Any = None) -> None:
        checks.append(
            {"check": name, "ok": bool(ok), **({} if detail is None else {"detail": detail})}
        )

    before = counts(path)
    migrate(path)
    after = counts(path)
    changed = {
        table: {"before": n, "after": after["rows"].get(table)}
        for table, n in before["rows"].items()
        if after["rows"].get(table) != n
    }
    check("every table keeps its rows", not changed, changed or {"tables": len(before["rows"])})
    new = sorted(set(after["tables"]) - set(before["tables"]))
    check(
        "the team's tables exist",
        {"teams", "team_members", "team_invitations"} <= set(new) | set(before["tables"]),
        {"added": new},
    )

    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        teams = conn.execute("SELECT id, founding_member_id FROM teams").fetchall()
        check("one team", len(teams) == 1, {"teams": len(teams)})
        members = conn.execute("SELECT id, user_id, role, state FROM team_members").fetchall()
        owners = [
            m
            for m in members
            if m[2] == encode_team_member_role("owner")
            and m[3] == encode_team_member_state("active")
        ]
        check(
            "exactly one active owner",
            len(owners) == 1,
            {"members": len(members), "owners": len(owners)},
        )
        named = [m for m in owners if m[1] == owner]
        check("the owner is the installation's named owner", len(named) == 1)
        founding = teams[0][1] if len(teams) == 1 else None
        check("the owner is the founding member", named != [] and founding == named[0][0])
        retired = int(
            _scalar(
                conn,
                _SANDBOX_BOUND + " AND m.runner_host_incarnation = ?",
                (RETIRED_RUNNER_INCARNATION,),
            )
        )
        check(
            "runner bindings on cloud computers are retired",
            retired == before["bound"]["sandbox"],
            {"bound": before["bound"]["sandbox"], "retired": retired},
        )
        personal = int(_scalar(conn, _PERSONAL_BOUND + " AND m.runner_host_incarnation IS NULL"))
        check(
            "runner bindings on personal hosts are kept",
            personal == before["bound"]["personal"],
            {"bound": before["bound"]["personal"], "kept": personal},
        )
    finally:
        conn.close()

    store = SqlAlchemyTeamStore(f"sqlite:///{path}")
    now = int(time.time())

    def identity(subject: str) -> ExternalIdentity:
        return ExternalIdentity(
            issuer="https://rehearsal.invalid",
            subject=subject,
            audience="rehearsal",
            email=None,
            installation_owner=True,
            issued_at=now,
            expires_at=now + 60,
        )

    first = store.bind_installation_owner(owner, identity("rehearsal-owner-browser"))
    check("a first Access identity binds as the founding owner", first is not None)
    second = store.bind_installation_owner(owner, identity("rehearsal-other-identity"))
    check("the founding binding works once", second is None)
    return {"kind": "team-rehearsal", "ok": all(c["ok"] for c in checks), "checks": checks}
