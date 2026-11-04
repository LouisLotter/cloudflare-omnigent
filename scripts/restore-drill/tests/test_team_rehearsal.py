"""The team-of-one rehearsal (WP8.11) on a database at the previous release's schema.

The database is made at Omnigent's head and taken back to ``mr1a2b3c4d5e`` (the release before the
team model), then given what today's installation has: the owner's account, a personal host and a
cloud computer, each with a thread bound to a runner. The rehearsal must migrate it and pass every
check; a second owner makes it fail. Skipped where Omnigent has no team model (an older pin).
"""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import pytest

team_store = pytest.importorskip("omnigent.stores.team_store")

from cfo_drill import team  # noqa: E402

PREVIOUS = "mr1a2b3c4d5e"
OWNER = "owner-canary-account"


def _previous_release_db(path: Path) -> None:
    from alembic import command
    from omnigent.db.utils import _build_alembic_config, get_or_create_engine

    uri = f"sqlite:///{path}"
    team.migrate(path)
    engine = get_or_create_engine(uri)
    config = _build_alembic_config(uri)
    with engine.connect() as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, PREVIOUS)
        connection.commit()
    engine.dispose()


def _seed(path: Path, *, admins: tuple[str, ...] = (OWNER,)) -> None:
    conn = sqlite3.connect(path)
    try:
        for name in admins:
            conn.execute(
                "INSERT INTO users (workspace_id, id, is_admin, password_hash, account_generation)"
                " VALUES (0, ?, 1, 'hash', ?)",
                (name, uuid.uuid4().hex),
            )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(hosts)")}
        for host, sandbox in ((uuid.uuid4().bytes, None), (uuid.uuid4().bytes, "sandbox-1")):
            values = {
                "workspace_id": 0,
                "host_id": host,
                "user_id": OWNER,
                "name": "cloud-computer" if sandbox else "laptop",
                "status": 1,
                "sandbox_id": sandbox,
                "created_at": 1,
                "updated_at": 1,
            }
            if "sandbox_provider" in columns and sandbox is not None:
                values["sandbox_provider"] = "test"
            names = [k for k in values if k in columns]
            conn.execute(
                f"INSERT INTO hosts ({', '.join(names)}) VALUES ({', '.join('?' * len(names))})",
                [values[k] for k in names],
            )
            conversation = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO omnigent_conversation_metadata"
                " (workspace_id, id, host_id, workspace, runner_id) VALUES (0, ?, ?, '/w', ?)",
                (conversation, host, f"runner-{conversation[:8]}"),
            )
        conn.commit()
    finally:
        conn.close()


def test_the_rehearsal_migrates_a_previous_release_and_passes(tmp_path: Path) -> None:
    db = tmp_path / "omnigent.db"
    _previous_release_db(db)
    _seed(db)
    report = team.rehearse(db, OWNER)
    failed = [c for c in report["checks"] if not c["ok"]]
    assert report["ok"], failed
    assert {c["check"] for c in report["checks"]} >= {
        "every table keeps its rows",
        "exactly one active owner",
        "the owner is the founding member",
        "runner bindings on cloud computers are retired",
        "runner bindings on personal hosts are kept",
        "the founding binding works once",
    }
    assert OWNER not in str(report)


def test_the_rehearsal_fails_without_a_single_owner(tmp_path: Path) -> None:
    db = tmp_path / "omnigent.db"
    _previous_release_db(db)
    _seed(db, admins=(OWNER, "second-admin-canary"))
    report = team.rehearse(db, OWNER)
    assert not report["ok"]
    assert {c["check"] for c in report["checks"] if not c["ok"]} >= {"exactly one active owner"}
