"""Check a database file: integrity, Omnigent record counts, filler fingerprint."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time


def check(path: str) -> dict:
    t0 = time.monotonic()
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    out: dict = {"path": path, "db_bytes": os.path.getsize(path)}
    out["integrity"] = conn.execute("PRAGMA integrity_check").fetchone()[0]
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    counts = {}
    for t in ("users", "device_grants", "scheduled_tasks", "hosts", "conversations", "s4_filler"):
        if t in tables:
            counts[t] = conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]  # noqa: S608
    out["counts"] = counts
    if "s4_filler" in tables:
        n, total, max_id = conn.execute(
            "SELECT count(*), coalesce(sum(length(body)),0), coalesce(max(id),0) FROM s4_filler"
        ).fetchone()
        out["filler"] = {"rows": n, "body_bytes": total, "max_id": max_id}
    out["check_s"] = round(time.monotonic() - t0, 3)
    # Local disk used beside the database: WAL, SHM and Litestream's own
    # LTX directory (a basic instance has 4 GB of disk in all).
    usage = {}
    d = os.path.dirname(path)
    for name in os.listdir(d):
        p = os.path.join(d, name)
        if os.path.isdir(p):
            usage[name] = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs)
        else:
            usage[name] = os.path.getsize(p)
    out["dir_bytes"] = usage
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default=os.environ.get("S4_DB_PATH", "/data/db/omnigent.db"))
    print(json.dumps(check(ap.parse_args().path)))


if __name__ == "__main__":
    main()
