"""The restore drill: restore the replica beside the running server, and check records.

Run inside the server container (``python -m cfo_drill drill``), where the entrypoint's
Litestream configuration, the control socket and the replica credentials are. It never stops
or changes the server, never sends Litestream a ``wait`` sync and never checkpoints:

1. **A confirmed position.** It snapshots the live database (:mod:`cfo_drill.db`), asks
   Litestream for the current position ``T`` with one sync without ``wait``, and snapshots
   again: equal snapshots mean the first one is the state at ``T``. Then it waits until the
   replica holds ``T`` (the barriers' own wait).
2. **A restore to ``T``** into a scratch directory, with ``litestream restore -txid``, under a
   deadline (a blackholed link hangs a restore, spike S4).
3. **Checks:** ``PRAGMA integrity_check``; an owner exists; the schema version and the tables;
   every table's row count and largest rowid; every security-table row; the transcript items
   of the canary conversations; and each acknowledged canary change, by its row.

With ``--txid`` it restores an earlier position instead and skips step 1's wait, which is how
the durability suite shows that a structurally valid restore with missing rows fails the drill.
The report holds digests and counts only, never row values or credentials.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
import tempfile
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cfo_drill import db

#: The entrypoint's paths (``cfo_server.config``), repeated so the pure parts import nothing.
DB_PATH = Path("/data/omnigent.db")
LITESTREAM_CONFIG = Path("/run/cfo/litestream.yml")
LITESTREAM_SOCKET = Path("/run/cfo/litestream.sock")
LITESTREAM_BIN = Path("/usr/local/bin/litestream")
SCRATCH = Path(os.environ.get("CFO_DRILL_SCRATCH", "/tmp/cfo-drill"))  # noqa: S108
#: The image's restore deadline default (``CFO_RESTORE_DEADLINE_S``).
DEFAULT_DEADLINE_S = 300.0
DEFAULT_CONFIRM_TIMEOUT_S = 120.0
SNAPSHOT_ATTEMPTS = 5


class DrillError(RuntimeError):
    """The drill could not run (as opposed to a check that failed)."""


@dataclass(frozen=True)
class RestoreResult:
    ok: bool
    seconds: float
    timed_out: bool
    returncode: int | None
    output_tail: str
    path: Path


def txid_hex(txid: int) -> str:
    """Litestream's hex form of a transaction ID, as ``restore -txid`` takes it."""
    if txid < 0:
        raise ValueError("negative txid")
    return f"{txid:016x}"


def _litestream_env(env: Mapping[str, str]) -> dict[str, str]:
    try:
        from cfo_server.config import litestream_environment
    except ImportError:  # outside the image: the drill passes the environment as it is
        return dict(env)
    return litestream_environment(env)


def _redact(text: str, env: Mapping[str, str]) -> str:
    try:
        from cfo_server.entrypoint import redact
    except ImportError:
        return text
    return redact(text, env)


def side_restore(
    out: Path,
    *,
    deadline_s: float,
    txid: int | None = None,
    env: Mapping[str, str] | None = None,
    config: Path = LITESTREAM_CONFIG,
    db_path: Path = DB_PATH,
    litestream: Path = LITESTREAM_BIN,
) -> RestoreResult:
    """``litestream restore`` of the server's replica into ``out``, killed at the deadline."""
    env = dict(os.environ if env is None else env)
    out.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        with contextlib.suppress(FileNotFoundError):
            Path(f"{out}{suffix}").unlink()
    command = [str(litestream), "restore", "-config", str(config), "-no-expand-env"]
    if txid is not None:
        command += ["-txid", txid_hex(txid)]
    command += ["-o", str(out), str(db_path)]
    started = time.monotonic()
    proc = subprocess.Popen(  # noqa: S603
        command,
        env=_litestream_env(env),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    timed_out = False
    try:
        output, _ = proc.communicate(timeout=deadline_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, 9)
        output, _ = proc.communicate()
    seconds = time.monotonic() - started
    lines = [line for line in (output or "").splitlines() if line.strip()]
    tail = _redact(" | ".join(lines[-3:]), env)[-400:]
    ok = not timed_out and proc.returncode == 0 and out.exists()
    return RestoreResult(ok, seconds, timed_out, None if timed_out else proc.returncode, tail, out)


def confirmed_snapshot(
    *,
    socket: Path = LITESTREAM_SOCKET,
    db_path: Path = DB_PATH,
    conversations: Sequence[str] = (),
    confirm_timeout_s: float = DEFAULT_CONFIRM_TIMEOUT_S,
) -> tuple[db.Snapshot, int, dict[str, Any]]:
    """The live state at a Litestream position ``T``, and ``T``, once the replica holds it."""
    from cfo_server.litestream import BlockingClient

    attempts = 0
    with BlockingClient(str(socket), str(db_path)) as client:
        while True:
            attempts += 1
            before = db.snapshot_file(db_path, conversations=conversations)
            target = client.sync().txid
            after = db.snapshot_file(db_path, conversations=conversations)
            if before.to_json() == after.to_json():
                break
            if attempts >= SNAPSHOT_ATTEMPTS:
                raise DrillError("the database kept changing; no quiet moment for a snapshot")
            time.sleep(0.5)
        started = time.monotonic()
        outcome = client.wait_replicated(confirm_timeout_s)
    if not outcome.ok:
        raise DrillError(f"the replica did not confirm position {target}: {outcome.reason}")
    return (
        before,
        target,
        {
            "attempts": attempts,
            "txid": target,
            "confirm_seconds": round(time.monotonic() - started, 3),
        },
    )


def run_drill(
    *,
    canaries: Sequence[db.Canary] = (),
    conversations: Sequence[str] = (),
    txid: int | None = None,
    deadline_s: float = DEFAULT_DEADLINE_S,
    scratch: Path = SCRATCH,
    env: Mapping[str, str] | None = None,
    keep: bool = False,
) -> dict[str, Any]:
    """The whole drill. Returns the report; ``report["ok"]`` is the verdict."""
    report: dict[str, Any] = {"kind": "restore-drill", "started_at": time.time()}
    expected: db.Snapshot | None = None
    if txid is None:
        expected, txid, report["confirmed"] = confirmed_snapshot(conversations=conversations)
    else:
        report["confirmed"] = None
    scratch.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix="drill-", dir=scratch))
    out = workdir / "restored.db"
    try:
        result = side_restore(out, deadline_s=deadline_s, txid=txid, env=env)
        report["restore"] = {
            "ok": result.ok,
            "seconds": round(result.seconds, 3),
            "timed_out": result.timed_out,
            "returncode": result.returncode,
            "txid": txid_hex(txid),
            "bytes": out.stat().st_size if out.exists() else None,
            "output": result.output_tail,
        }
        checks: list[db.Check] = []
        if not result.ok:
            checks.append(db.Check("restore", False, "the restore failed or missed its deadline"))
        else:
            checks.extend(_restored_checks(out, expected, canaries, conversations))
        report["checks"] = [c.to_json() for c in checks]
        report["ok"] = bool(checks) and all(c.ok for c in checks)
    finally:
        if not keep:
            shutil.rmtree(workdir, ignore_errors=True)
    report["finished_at"] = time.time()
    return report


def _restored_checks(
    path: Path,
    expected: db.Snapshot | None,
    canaries: Sequence[db.Canary],
    conversations: Sequence[str],
) -> list[db.Check]:
    started = time.monotonic()
    conn = db.connect_readonly(path)
    try:
        verdict = db.integrity(conn)
        checks = [
            db.Check("integrity", verdict == "ok", {"answer": verdict, "seconds": _since(started)})
        ]
        if verdict != "ok":
            return checks
        restored = db.snapshot(conn, conversations=conversations)
        (owners,) = conn.execute(
            "SELECT COUNT(*) FROM users WHERE workspace_id = 0 AND id NOT IN ('__public__', "
            "'local') AND deleted_at IS NULL AND password_hash IS NOT NULL AND is_admin = 1"
        ).fetchone()
    finally:
        conn.close()
    checks.append(db.Check("owner", owners > 0, {"password_admins": owners}))
    if expected is not None:
        checks.extend(db.compare(expected, restored))
    if canaries:
        checks.append(db.check_canaries(canaries, expected, restored))
    return checks


def _since(started: float) -> float:
    return round(time.monotonic() - started, 3)


def dumps(report: Mapping[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True)
