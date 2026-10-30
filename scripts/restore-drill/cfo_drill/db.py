"""Snapshots of an Omnigent database, and the record checks between two of them.

A snapshot holds no row values, only digests, so it can be logged and stored without carrying
credentials (password hashes, grant hashes, token hashes stay inside the database):

- the schema version (``alembic_version``) and the set of tables;
- every table's row count and largest rowid;
- for the **security tables** (the response barrier's tables), a digest of every row, keyed by
  a digest of its primary key;
- for the **transcript items** of chosen conversations, the same per-row digests.

:func:`compare` checks a restored copy against the live snapshot it should equal. That is the
restore drill's answer to Litestream issue #1540, a restore that passes ``PRAGMA
integrity_check`` while rows are missing.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import sqlite3
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: The response barrier's tables (``cfo_server.barrier.SECURITY_TABLES``), with their primary
#: keys. A coupling test checks both against the image and Omnigent's schema.
SECURITY_TABLE_KEYS: dict[str, tuple[str, ...]] = {
    "users": ("workspace_id", "id"),
    "device_grants": ("workspace_id", "id"),
    "account_tokens": ("workspace_id", "id"),
    "hosts": ("workspace_id", "host_id"),
    "scheduled_tasks": ("workspace_id", "id"),
    # Omnigent's linked accounts (GitHub, WP5.9), sealed by the key service: digests only.
    "connections": ("workspace_id", "user_id", "provider", "account_id"),
}
ITEMS_TABLE = "conversation_items"
ITEM_KEY = ("workspace_id", "conversation_id", "id")
#: Litestream's own bookkeeping tables, and SQLite's: never compared.
IGNORED_TABLE_PREFIXES = ("sqlite_", "_litestream_")
DIGEST_CHARS = 32


def _canonical(value: Any) -> Any:
    if isinstance(value, bytes | bytearray | memoryview):
        return {"hex": bytes(value).hex()}
    if isinstance(value, float) and value.is_integer():
        return {"float": repr(value)}
    return value


def digest(values: Iterable[Any]) -> str:
    """A short, stable digest of a sequence of SQLite values."""
    encoded = json.dumps([_canonical(v) for v in values], separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode()).hexdigest()[:DIGEST_CHARS]


def key_digest(table: str, key: Sequence[Any]) -> str:
    return digest([table, *key])


def connect_readonly(path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    conn.row_factory = None
    return conn


@dataclass
class Snapshot:
    schema_version: list[str]
    tables: list[str]
    counts: dict[str, int]
    max_rowids: dict[str, int | None]
    #: table -> key digest -> row digest
    security: dict[str, dict[str, str]]
    items: dict[str, str]
    conversations: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "tables": self.tables,
            "counts": self.counts,
            "max_rowids": self.max_rowids,
            "security": self.security,
            "items": self.items,
            "conversations": self.conversations,
        }

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> Snapshot:
        return cls(
            schema_version=list(data["schema_version"]),
            tables=list(data["tables"]),
            counts={k: int(v) for k, v in data["counts"].items()},
            max_rowids=dict(data["max_rowids"]),
            security={t: dict(rows) for t, rows in data["security"].items()},
            items=dict(data["items"]),
            conversations=list(data.get("conversations", [])),
        )


def _tables(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    return [n for (n,) in rows if not n.startswith(IGNORED_TABLE_PREFIXES)]


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _rows_by_key(
    conn: sqlite3.Connection, table: str, key: Sequence[str], where: str = "", params: tuple = ()
) -> dict[str, str]:
    cursor = conn.execute(f"SELECT * FROM {_quote(table)} {where}", params)  # noqa: S608
    columns = [d[0] for d in cursor.description]
    index = [columns.index(k) for k in key]
    out: dict[str, str] = {}
    for row in cursor:
        out[key_digest(table, [row[i] for i in index])] = digest(
            [*columns, *row]  # column names too: a renamed column changes the digest
        )
    return out


def snapshot(conn: sqlite3.Connection, *, conversations: Sequence[str] = ()) -> Snapshot:
    """Snapshot one database inside a single read transaction.

    :param conversations: Conversation ids (hex) whose transcript items to digest.
    """
    conn.execute("BEGIN")
    try:
        tables = _tables(conn)
        counts: dict[str, int] = {}
        max_rowids: dict[str, int | None] = {}
        for table in tables:
            (count,) = conn.execute(f"SELECT COUNT(*) FROM {_quote(table)}").fetchone()  # noqa: S608
            counts[table] = int(count)
            try:
                (top,) = conn.execute(f"SELECT MAX(rowid) FROM {_quote(table)}").fetchone()  # noqa: S608
            except sqlite3.OperationalError:  # WITHOUT ROWID or a virtual table
                top = None
            max_rowids[table] = top
        version = (
            [v for (v,) in conn.execute("SELECT version_num FROM alembic_version ORDER BY 1")]
            if "alembic_version" in tables
            else []
        )
        security = {
            table: _rows_by_key(conn, table, key) if table in tables else {}
            for table, key in SECURITY_TABLE_KEYS.items()
        }
        items: dict[str, str] = {}
        if conversations and ITEMS_TABLE in tables:
            for conversation in conversations:
                items.update(
                    _rows_by_key(
                        conn,
                        ITEMS_TABLE,
                        ITEM_KEY,
                        "WHERE conversation_id = ?",
                        (bytes.fromhex(conversation),),
                    )
                )
        return Snapshot(
            schema_version=version,
            tables=tables,
            counts=counts,
            max_rowids=max_rowids,
            security=security,
            items=items,
            conversations=list(conversations),
        )
    finally:
        conn.execute("ROLLBACK")


def snapshot_file(path: Path | str, *, conversations: Sequence[str] = ()) -> Snapshot:
    conn = connect_readonly(path)
    try:
        return snapshot(conn, conversations=conversations)
    finally:
        conn.close()


def integrity(conn: sqlite3.Connection) -> str:
    rows = conn.execute("PRAGMA integrity_check").fetchall()
    return "ok" if rows == [("ok",)] else (str(rows[0][0]) if rows else "no answer")[:200]


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: Any = None

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "ok": self.ok, "detail": self.detail}


def _row_diff(expected: Mapping[str, str], actual: Mapping[str, str]) -> dict[str, int]:
    missing = sum(1 for k in expected if k not in actual)
    changed = sum(1 for k, v in expected.items() if k in actual and actual[k] != v)
    extra = sum(1 for k in actual if k not in expected)
    return {"rows": len(expected), "missing": missing, "changed": changed, "extra": extra}


def compare(expected: Snapshot, actual: Snapshot) -> list[Check]:
    """The record checks of a restored copy (``actual``) against the live snapshot."""
    checks = [
        Check(
            "schema_version",
            expected.schema_version == actual.schema_version and bool(actual.schema_version),
            {"expected": expected.schema_version, "restored": actual.schema_version},
        ),
        Check(
            "tables",
            expected.tables == actual.tables,
            {
                "missing": sorted(set(expected.tables) - set(actual.tables)),
                "extra": sorted(set(actual.tables) - set(expected.tables)),
            },
        ),
    ]
    count_diff = {
        t: {"expected": n, "restored": actual.counts.get(t)}
        for t, n in expected.counts.items()
        if actual.counts.get(t) != n or actual.max_rowids.get(t) != expected.max_rowids.get(t)
    }
    checks.append(
        Check("row_counts", not count_diff, {"tables": len(expected.counts), "differ": count_diff})
    )
    security = {
        t: _row_diff(rows, actual.security.get(t, {})) for t, rows in expected.security.items()
    }
    checks.append(
        Check(
            "security_tables",
            all(d["missing"] == d["changed"] == d["extra"] == 0 for d in security.values()),
            security,
        )
    )
    items = _row_diff(expected.items, actual.items)
    checks.append(
        Check(
            "transcript_items",
            items["missing"] == items["changed"] == items["extra"] == 0,
            {**items, "conversations": len(expected.conversations)},
        )
    )
    return checks


@dataclass(frozen=True)
class Canary:
    """One change the canary writer made, and whether the server acknowledged it as durable.

    ``table`` and ``key`` locate the row it made or changed; ``expect`` says whether the row
    must exist (``present``) or must be gone (``absent``) after a restore. An unacknowledged
    change (a 424 or a 503) may be lost; the drill reports it and never fails on it.
    """

    label: str
    table: str
    key: tuple[Any, ...]
    acknowledged: bool
    expect: str = "present"
    status: int | None = None
    #: The row's digest as the live server held it once acknowledged and replicated, for a
    #: check without the live database (a replacement): the row must come back exactly so.
    expected: str | None = None

    def key_digest(self) -> str:
        return key_digest(self.table, self.key)

    def with_expected(self, snap: Snapshot) -> Canary:
        """This canary, carrying its row's digest in ``snap`` (a confirmed live snapshot)."""
        digest_ = _rows_of(snap, self.table).get(self.key_digest())
        return dataclasses.replace(self, expected=digest_)

    def to_json(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "table": self.table,
            "key": [_canonical(k) for k in self.key],
            "acknowledged": self.acknowledged,
            "expect": self.expect,
            "status": self.status,
            "expected": self.expected,
        }

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> Canary:
        key = tuple(
            bytes.fromhex(k["hex"]) if isinstance(k, dict) and "hex" in k else k
            for k in data["key"]
        )
        return cls(
            label=str(data["label"]),
            table=str(data["table"]),
            key=key,
            acknowledged=bool(data["acknowledged"]),
            expect=str(data.get("expect", "present")),
            status=data.get("status"),
            expected=data.get("expected"),
        )


def _rows_of(snap: Snapshot, table: str) -> Mapping[str, str]:
    return snap.items if table == ITEMS_TABLE else snap.security.get(table, {})


def check_canaries(
    canaries: Sequence[Canary], expected: Snapshot | None, actual: Snapshot
) -> Check:
    """Every acknowledged canary is in the restore as the live server held it.

    The expected row comes from the live snapshot, or else from the digest the canary carries
    (:meth:`Canary.with_expected`); a canary with neither is checked for presence only.
    """
    missing: list[str] = []
    differ: list[str] = []
    unacknowledged: dict[str, str] = {}
    for canary in canaries:
        digest_ = canary.key_digest()
        restored = _rows_of(actual, canary.table).get(digest_)
        found = restored is not None
        if not canary.acknowledged:
            unacknowledged[canary.label] = "present" if found else "absent"
            continue
        if canary.expect == "absent":
            if found:
                missing.append(canary.label)
            continue
        if not found:
            missing.append(canary.label)
            continue
        live = (
            _rows_of(expected, canary.table).get(digest_)
            if expected is not None
            else canary.expected
        )
        if live is not None and live != restored:
            differ.append(canary.label)
    acknowledged = sum(1 for c in canaries if c.acknowledged)
    return Check(
        "acknowledged_changes",
        not missing and not differ,
        {
            "acknowledged": acknowledged,
            "present": acknowledged - len(missing) - len(differ),
            "missing": missing,
            "differ": differ,
            "unacknowledged": unacknowledged,
        },
    )
