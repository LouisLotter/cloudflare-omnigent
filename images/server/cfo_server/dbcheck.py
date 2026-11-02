"""Checks on a database file before Omnigent opens it: intact, and initialized.

**Intact:** ``PRAGMA integrity_check`` answers ``ok``. That alone is not enough to trust a
restore (Litestream issue #1540 reports structurally valid restores with missing rows), so the
restore drill (WP2.5) checks records; at start the image checks what it can. The full check,
not ``quick_check``: it also cross-checks every index against its table, which is where a
restore that mixed pages of different transactions would show, and it reads the file once per
start, in the entrypoint only (WP2.6 measured both; ``has_owner`` is the app's own check).

**Initialized:** the same signal Omnigent's bootstrap uses ("is there any password-having user
yet?", ``accounts_bootstrap.bootstrap_admin``): at least one user in the default workspace,
not the ``local`` or ``__public__`` sentinel, not deleted, with a password hash. It is read
with plain SQL, read-only, so it works on a database from an older Omnigent schema before
migrations run. ``tests/test_coupling.py`` pins it against Omnigent's own check.

**The page's MCP services** (WP8.14): which services administrators added on Omnigent's MCP
page the database holds, by ID, read the same way before the app starts. An update's restore
point records them when it is taken, so that every start in the update's window can tell
whether the server still serves them all (``GET /status``, ``mcpAdminServices``).
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path

#: Omnigent's sentinel rows, hidden from ``SqlAlchemyAccountStore.list_users``.
SENTINEL_USERS = ("__public__", "local")
DEFAULT_WORKSPACE_ID = 0

INITIALIZED_SQL = (
    "SELECT COUNT(*) FROM users WHERE workspace_id = ? AND id NOT IN (?, ?) "
    "AND deleted_at IS NULL AND password_hash IS NOT NULL"
)


#: The live run-time MCP services of the default workspace (Omnigent's ``McpServiceStore``: a
#: removed one keeps its row with ``deleted_at`` until its logins are gone), drafts included, as
#: its admin list shows them. Pinned against Omnigent's schema by ``tests/test_coupling.py``.
ADMIN_SERVICES_TABLE = "mcp_registry_services"
ADMIN_SERVICES_SQL = (
    f"SELECT service_id FROM {ADMIN_SERVICES_TABLE} WHERE workspace_id = ? AND deleted_at IS NULL"
)


@dataclass(frozen=True)
class DatabaseCheck:
    intact: bool
    initialized: bool
    detail: str


def check_database(path: Path) -> DatabaseCheck:
    """Check one database file, read-only. Never raises for a bad file."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    except sqlite3.Error as exc:
        return DatabaseCheck(False, False, f"open failed: {type(exc).__name__}")
    try:
        try:
            rows = conn.execute("PRAGMA integrity_check").fetchall()
        except sqlite3.DatabaseError as exc:
            return DatabaseCheck(False, False, f"integrity_check failed: {exc}"[:200])
        if rows != [("ok",)]:
            first = rows[0][0] if rows else "no answer"
            return DatabaseCheck(False, False, f"integrity_check: {first}"[:200])
        try:
            (count,) = conn.execute(
                INITIALIZED_SQL, (DEFAULT_WORKSPACE_ID, *SENTINEL_USERS)
            ).fetchone()
        except sqlite3.DatabaseError as exc:
            # No users table yet (an empty or foreign database): intact, not initialized.
            return DatabaseCheck(True, False, f"no owner record: {exc}"[:200])
        return DatabaseCheck(True, count > 0, f"{count} password user(s)")
    finally:
        conn.close()


def has_owner(path: Path) -> bool:
    """Whether the database has an owner: only the initialized query, read-only.

    The app's check after Omnigent's bootstrap. The entrypoint already ran the full
    :func:`check_database` on this file before the app started; reading the whole file again
    took 275 s of a 1 GB start on ``basic`` (WP2.5). Never raises for a bad file.
    """
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    except sqlite3.Error:
        return False
    try:
        (count,) = conn.execute(INITIALIZED_SQL, (DEFAULT_WORKSPACE_ID, *SENTINEL_USERS)).fetchone()
        return count > 0
    except sqlite3.DatabaseError:
        return False
    finally:
        conn.close()


def admin_service_ids(path: Path) -> list[str] | None:
    """The IDs of the services administrators added on Omnigent's MCP page that the database
    holds, sorted: none before the table exists (a database from before Omnigent's migration
    ``mr1a2b3c4d5e``), ``None`` when the file cannot say. Read-only; never raises for a bad
    file."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    except sqlite3.Error:
        return None
    try:
        (tables,) = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            (ADMIN_SERVICES_TABLE,),
        ).fetchone()
        if tables == 0:
            return []
        rows = conn.execute(ADMIN_SERVICES_SQL, (DEFAULT_WORKSPACE_ID,)).fetchall()
        return sorted(str(service_id) for (service_id,) in rows)
    except sqlite3.DatabaseError:
        return None
    finally:
        conn.close()


def count_admin_services(path: Path) -> int | None:
    """How many such services the database holds (:func:`admin_service_ids`)."""
    ids = admin_service_ids(path)
    return None if ids is None else len(ids)
