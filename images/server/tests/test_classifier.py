"""The response barrier's write classifier: which committed statements are security changes."""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from cfo_server.barrier import IGNORED_UPDATE_COLUMNS, SECURITY_TABLES, classify

OTHER_TABLES = ["conversations", "conversation_items", "agents", "files", "preferences", "projects"]


@pytest.mark.parametrize(
    ("statement", "rowcount", "expected"),
    [
        # Statements Omnigent's stores send (seen in the per-route test's debug log).
        (
            "INSERT INTO device_grants (account_generation, workspace_id, id) VALUES (?, ?, ?)",
            1,
            "device_grants",
        ),
        (
            "UPDATE device_grants SET status=?, refresh_token_hash=? WHERE device_grants.id = ?",
            1,
            "device_grants",
        ),
        ("UPDATE users SET account_generation=?, password_hash=? WHERE users.id = ?", 1, "users"),
        ("INSERT INTO account_tokens (id, kind, user_id) VALUES (?, ?, ?)", 1, "account_tokens"),
        ("INSERT INTO scheduled_tasks (id, name) VALUES (?, ?)", 1, "scheduled_tasks"),
        (
            "UPDATE scheduled_tasks SET name=?, updated_at=? WHERE scheduled_tasks.id = ?",
            1,
            "scheduled_tasks",
        ),
        ("DELETE FROM scheduled_tasks WHERE scheduled_tasks.id = ?", 1, "scheduled_tasks"),
        (
            "INSERT INTO hosts (workspace_id, host_id, user_id, name) VALUES (?, ?, ?, ?)",
            1,
            "hosts",
        ),
        # Launch-token re-arm and revocation.
        (
            "UPDATE hosts SET status=?, updated_at=?, token_hash=?, token_expires_at=?, "
            "launch_token_only=? WHERE hosts.host_id = ?",
            1,
            "hosts",
        ),
        ("UPDATE hosts SET token_hash=?, token_expires_at=? WHERE hosts.host_id = ?", 1, "hosts"),
        ("DELETE FROM hosts WHERE hosts.workspace_id = ? AND hosts.host_id = ?", 1, "hosts"),
        # The credential store's connections (WP5.9): linking, relinking, a token refresh (the
        # same columns as a relink, Codex WP5.9 r1-1) and unlinking are all marked.
        (
            "INSERT INTO connections (workspace_id, user_id, provider, account_id, secret_enc, "
            "metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            1,
            "connections",
        ),
        (
            "DELETE FROM connections WHERE connections.workspace_id = ? AND "
            "connections.user_id = ? AND connections.provider = ?",
            1,
            "connections",
        ),
        (
            "UPDATE connections SET secret_enc=?, metadata_json=?, updated_at=? WHERE "
            "connections.workspace_id = ? AND connections.user_id = ?",
            1,
            "connections",
        ),
        ("UPDATE connections SET user_id=? WHERE connections.user_id = ?", 1, "connections"),
        # Bookkeeping only.
        ("UPDATE users SET last_login_at=? WHERE users.id = ?", 1, None),
        ("UPDATE hosts SET updated_at=? WHERE hosts.host_id = ?", 1, None),
        ('UPDATE "hosts" SET "updated_at"=? WHERE hosts.host_id = ?', 1, None),
        # Nothing changed.
        ("UPDATE users SET password_hash=? WHERE users.id = ?", 0, None),
        ("DELETE FROM device_grants WHERE id = ?", 0, None),
        ("INSERT INTO users (id, is_admin) VALUES (?, ?) ON CONFLICT DO NOTHING", 0, None),
        # Unknown row count counts as a change.
        ("UPDATE users SET password_hash=? WHERE users.id = ?", -1, "users"),
        # Other tables and statements.
        ("INSERT INTO conversation_items (id) VALUES (?)", 1, None),
        ("SELECT * FROM users", 5, None),
        ("PRAGMA wal_checkpoint", 0, None),
        # Spellings.
        ("insert or replace into users (id) values (?)", 1, "users"),
        ("REPLACE INTO hosts (host_id) VALUES (?)", 1, "hosts"),
        ('  UPDATE "users" SET "is_admin"=? WHERE id=?', 1, "users"),
        ("UPDATE OR IGNORE users SET is_admin=? WHERE id=?", 1, "users"),
        ("UPDATE users SET last_login_at=?, is_admin=? WHERE id=?", 1, "users"),
        ("UPDATE users SET last_login_at=coalesce(?, last_login_at) WHERE id=?", 1, None),
    ],
)
def test_classify(statement: str, rowcount: int, expected: str | None) -> None:
    assert classify(statement, rowcount) == expected


@settings(deadline=None)
@given(
    table=st.sampled_from(sorted(SECURITY_TABLES)),
    verb=st.sampled_from(["INSERT INTO", "DELETE FROM", "insert into", "delete from"]),
    rowcount=st.integers(min_value=1, max_value=50) | st.just(-1),
)
def test_every_effective_insert_or_delete_on_a_security_table_is_marked(
    table: str, verb: str, rowcount: int
) -> None:
    statement = f"{verb} {table} (x) VALUES (?)" if "insert" in verb.lower() else f"{verb} {table}"
    assert classify(statement, rowcount) == table


@settings(deadline=None)
@given(
    table=st.sampled_from(sorted(SECURITY_TABLES)),
    columns=st.lists(
        st.sampled_from(
            [
                "password_hash",
                "token_hash",
                "status",
                "is_admin",
                "name",
                "rrule",
                "deleted_at",
                "last_login_at",
                "updated_at",
                "account_generation",
            ]
        ),
        min_size=1,
        max_size=5,
        unique=True,
    ),
    rowcount=st.integers(min_value=1, max_value=5),
)
def test_an_update_is_ignored_only_when_every_column_is_bookkeeping(
    table: str, columns: list[str], rowcount: int
) -> None:
    statement = f"UPDATE {table} SET " + ", ".join(f"{c}=?" for c in columns) + " WHERE id = ?"
    ignored = set(columns) <= IGNORED_UPDATE_COLUMNS.get(table, frozenset())
    assert classify(statement, rowcount) == (None if ignored else table)


@settings(deadline=None)
@given(
    table=st.sampled_from(OTHER_TABLES),
    verb=st.sampled_from(["INSERT INTO", "UPDATE", "DELETE FROM"]),
    rowcount=st.integers(min_value=-1, max_value=9),
)
def test_other_tables_are_never_marked(table: str, verb: str, rowcount: int) -> None:
    suffix = " SET a=?" if verb == "UPDATE" else ""
    assert classify(f"{verb} {table}{suffix}", rowcount) is None
