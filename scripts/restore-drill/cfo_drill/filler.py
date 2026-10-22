"""Filler rows that grow a database to a test size, written beside the running server.

As in spike S4: about 4 KiB per row, half word-like text and half random base64, so the data
compresses about as application data does. The rows go into a table of their own,
``cfo_drill_filler``, which Omnigent never reads; Litestream replicates it like any other.
Used by the durability suite and the staging measurements only, never on a real installation.
"""

from __future__ import annotations

import base64
import os
import random
import sqlite3
import time
from pathlib import Path

TABLE = "cfo_drill_filler"
ROW_BYTES = 4096
BATCH_ROWS = 256
_WORDS = (
    "agent", "conversation", "computer", "schedule", "replica", "restore", "barrier",
    "durable", "window", "host", "runner", "token", "grant", "session", "item", "turn",
    "wake", "sleep", "checkpoint", "server", "worker", "container", "bucket", "stream",
    "drill", "canary", "owner", "invite", "password", "sharing", "settings", "launcher",
)  # fmt: skip


def _row(rng: random.Random) -> str:
    words = []
    size = 0
    while size < ROW_BYTES // 2:
        word = rng.choice(_WORDS)
        words.append(word)
        size += len(word) + 1
    noise = base64.b64encode(os.urandom(ROW_BYTES * 3 // 8)).decode()
    return " ".join(words)[: ROW_BYTES // 2] + noise[: ROW_BYTES // 2]


def seed(
    db_path: Path | str,
    megabytes: float,
    *,
    seed_value: int = 25,
    pause_s: float = 0.0,
    busy_timeout_s: float = 60.0,
) -> dict[str, float | int]:
    """Add filler rows until the table holds about ``megabytes`` of row data.

    Each batch is one short transaction, so Omnigent and Litestream keep running meanwhile.
    Returns the rows added, the table's total rows and the seconds taken.
    """
    rng = random.Random(seed_value)
    conn = sqlite3.connect(str(db_path), timeout=busy_timeout_s, isolation_level=None)
    try:
        conn.execute(f"CREATE TABLE IF NOT EXISTS {TABLE} (id INTEGER PRIMARY KEY, body TEXT)")
        (existing,) = conn.execute(f"SELECT COUNT(*) FROM {TABLE}").fetchone()  # noqa: S608
        target = int(megabytes * 1024 * 1024 / ROW_BYTES)
        started = time.monotonic()
        added = 0
        while existing + added < target:
            batch = min(BATCH_ROWS, target - existing - added)
            conn.execute("BEGIN IMMEDIATE")
            conn.executemany(
                f"INSERT INTO {TABLE} (body) VALUES (?)",  # noqa: S608
                [(_row(rng),) for _ in range(batch)],
            )
            conn.execute("COMMIT")
            added += batch
            if pause_s:
                time.sleep(pause_s)
        return {
            "rows_added": added,
            "rows": existing + added,
            "seconds": round(time.monotonic() - started, 2),
        }
    finally:
        conn.close()
