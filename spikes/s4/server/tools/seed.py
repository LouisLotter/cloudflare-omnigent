"""Grow the live server database to a target size with synthetic rows.

Runs inside the server container, beside the running server, with
Omnigent's own SQLite settings (WAL, synchronous=NORMAL, busy_timeout). Rows
go into a spike-only table, ``s4_filler``. Each row body is about 4 KiB:
half word-like text (compressible, like conversation text) and half random
base64 (incompressible, like compressed blobs). Prints a JSON fingerprint
that a restore check can compare.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import sqlite3
import time

DB = os.environ.get("S4_DB_PATH", "/data/db/omnigent.db")
WORDS = (
    "agent session tool result file workspace schedule host runner approval "
    "message prompt model output error retry commit branch review test build "
    "deploy container worker request response token grant user change data"
).split()


def body(rng: random.Random) -> str:
    text = " ".join(rng.choice(WORDS) for _ in range(330))[:2048]
    blob = base64.b64encode(rng.randbytes(1536)).decode()
    return text + blob


def fingerprint(conn: sqlite3.Connection) -> dict:
    n, total, max_id = conn.execute(
        "SELECT count(*), coalesce(sum(length(body)),0), coalesce(max(id),0) FROM s4_filler"
    ).fetchone()
    return {"rows": n, "body_bytes": total, "max_id": max_id}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-mb", type=float, required=True)
    ap.add_argument("--batch", type=int, default=250)
    ap.add_argument("--seed", type=int, default=4)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    conn = sqlite3.connect(DB, timeout=20)
    conn.execute("PRAGMA busy_timeout=20000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS s4_filler (id INTEGER PRIMARY KEY, created REAL, body TEXT)"
    )
    conn.commit()
    t0 = time.monotonic()
    target = args.target_mb * 1024 * 1024
    batches = 0
    page_size = conn.execute("PRAGMA page_size").fetchone()[0]
    while True:
        # Logical size, including pages still in the WAL (the file grows
        # only at checkpoints, which Litestream holds back).
        size = conn.execute("PRAGMA page_count").fetchone()[0] * page_size
        if size >= target:
            break
        now = time.time()
        conn.executemany(
            "INSERT INTO s4_filler (created, body) VALUES (?, ?)",
            [(now, body(rng)) for _ in range(args.batch)],
        )
        conn.commit()
        batches += 1
        if batches % 40 == 0:
            # Let Litestream keep up, as a live server would.
            time.sleep(0.2)
    fp = fingerprint(conn)
    fp.update(
        db_bytes=os.path.getsize(DB),
        wal_bytes=os.path.getsize(DB + "-wal") if os.path.exists(DB + "-wal") else 0,
        seconds=round(time.monotonic() - t0, 2),
        batches=batches,
    )
    print(json.dumps(fp))


if __name__ == "__main__":
    main()
