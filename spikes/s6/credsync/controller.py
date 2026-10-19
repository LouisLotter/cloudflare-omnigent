"""A stand-in for WorkspaceDO's checkpoint pointers (throwaway spike code).

Holds, per computer: the current generation, a sequence counter per checkpoint kind, and the
published manifest pointer per kind. Publishing is atomic and fenced:

- a call from an older generation is refused (a replaced container cannot publish);
- a checkpoint is refused unless it is newer than the published one: by the order in which the
  copies were taken (snapshot order, within one generation) when the caller supplies it, and by
  sequence number otherwise. A copy that finishes uploading late can never replace a newer one.

SQLite with BEGIN IMMEDIATE makes each operation atomic across processes.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path


class StaleGeneration(Exception):
    pass


class Controller:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._tx() as c:
            c.execute(
                "CREATE TABLE IF NOT EXISTS computers (computer_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS counters (computer_id TEXT, kind TEXT, next_seq INTEGER NOT NULL,"
                " PRIMARY KEY (computer_id, kind))"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS pointers (computer_id TEXT, kind TEXT, seq INTEGER NOT NULL,"
                " generation INTEGER NOT NULL, manifest_key TEXT NOT NULL, published_at REAL NOT NULL,"
                " snap_order INTEGER, PRIMARY KEY (computer_id, kind))"
            )
            c.execute(
                "CREATE TABLE IF NOT EXISTS refusals (computer_id TEXT, kind TEXT, seq INTEGER, generation INTEGER,"
                " reason TEXT, at REAL)"
            )

    def _tx(self):
        conn = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)

        class _Tx:
            def __enter__(self_inner):
                conn.execute("BEGIN IMMEDIATE")
                return conn

            def __exit__(self_inner, et, ev, tb):
                if et is None:
                    conn.execute("COMMIT")
                else:
                    conn.execute("ROLLBACK")
                conn.close()
                return False

        return _Tx()

    def start_generation(self, computer_id: str) -> int:
        """A new container start: persist the next generation before the container runs."""
        with self._tx() as c:
            row = c.execute("SELECT generation FROM computers WHERE computer_id=?", (computer_id,)).fetchone()
            gen = (row[0] if row else 0) + 1
            c.execute(
                "INSERT INTO computers(computer_id, generation) VALUES(?,?)"
                " ON CONFLICT(computer_id) DO UPDATE SET generation=excluded.generation",
                (computer_id, gen),
            )
            return gen

    def current_generation(self, computer_id: str) -> int:
        with self._tx() as c:
            row = c.execute("SELECT generation FROM computers WHERE computer_id=?", (computer_id,)).fetchone()
            return row[0] if row else 0

    def _check_gen(self, c, computer_id: str, generation: int) -> None:
        row = c.execute("SELECT generation FROM computers WHERE computer_id=?", (computer_id,)).fetchone()
        if not row or row[0] != generation:
            raise StaleGeneration(f"generation {generation} is not current")

    def next_seq(self, computer_id: str, kind: str, generation: int) -> int:
        with self._tx() as c:
            self._check_gen(c, computer_id, generation)
            row = c.execute(
                "SELECT next_seq FROM counters WHERE computer_id=? AND kind=?", (computer_id, kind)
            ).fetchone()
            seq = row[0] if row else 1
            c.execute(
                "INSERT INTO counters(computer_id, kind, next_seq) VALUES(?,?,?)"
                " ON CONFLICT(computer_id, kind) DO UPDATE SET next_seq=excluded.next_seq",
                (computer_id, kind, seq + 1),
            )
            return seq

    def publish(self, computer_id: str, kind: str, generation: int, seq: int, manifest_key: str,
                order: int | None = None) -> bool:
        """Switch the pointer if this checkpoint is newer. Returns False when fenced out."""
        with self._tx() as c:
            try:
                self._check_gen(c, computer_id, generation)
            except StaleGeneration:
                c.execute(
                    "INSERT INTO refusals VALUES(?,?,?,?,?,?)",
                    (computer_id, kind, seq, generation, "stale-generation", time.time()),
                )
                return False
            row = c.execute(
                "SELECT seq, generation, snap_order FROM pointers WHERE computer_id=? AND kind=?",
                (computer_id, kind),
            ).fetchone()
            if order is not None and row and row[1] == generation and row[2] is not None:
                not_newer = row[2] >= order  # same container: compare when the copies were taken
            elif order is not None and row and row[1] != generation:
                not_newer = False  # the current generation is newer than the pointer's (checked above)
            else:
                not_newer = bool(row) and row[0] >= seq
            if not_newer:
                c.execute(
                    "INSERT INTO refusals VALUES(?,?,?,?,?,?)",
                    (computer_id, kind, seq, generation, "not-newer", time.time()),
                )
                return False
            c.execute(
                "INSERT INTO pointers(computer_id, kind, seq, generation, manifest_key, published_at, snap_order)"
                " VALUES(?,?,?,?,?,?,?) ON CONFLICT(computer_id, kind) DO UPDATE SET seq=excluded.seq,"
                " generation=excluded.generation, manifest_key=excluded.manifest_key,"
                " published_at=excluded.published_at, snap_order=excluded.snap_order",
                (computer_id, kind, seq, generation, manifest_key, time.time(), order),
            )
            return True

    def current(self, computer_id: str, kind: str) -> tuple[int, str] | None:
        with self._tx() as c:
            row = c.execute(
                "SELECT seq, manifest_key FROM pointers WHERE computer_id=? AND kind=?", (computer_id, kind)
            ).fetchone()
            return (row[0], row[1]) if row else None

    def refusals(self, computer_id: str) -> list[tuple]:
        with self._tx() as c:
            return c.execute(
                "SELECT kind, seq, generation, reason FROM refusals WHERE computer_id=?", (computer_id,)
            ).fetchall()
