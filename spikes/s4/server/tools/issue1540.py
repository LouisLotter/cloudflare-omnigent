"""Litestream issue #1540 (and #1552) against the pinned Litestream binary.

Runs inside a container from the S4 server image, with its own Litestream
process and a file replica, so nothing else touches the database.

Modes
-----
repro      The issue's sequence, black-box: 80 rows, sync to the WAL end,
           121 unsynced rows, an application ``wal_checkpoint(TRUNCATE)``,
           a heartbeat write, sync, restore, count. ``--guard dropped`` first
           calls ``POST /sync {"wait": true}`` before the first monitor tick,
           which issue #1552 says disarms Litestream's checkpoint guard;
           ``--guard held`` lets the monitor initialise normally.
soak       Omnigent-like writes (WAL, synchronous=NORMAL, the default
           auto-checkpoint) for ``--seconds``, with an acknowledgement barrier
           (``--barrier nowait`` polls ``replicated_txid``; ``--barrier wait``
           uses ``wait: true``). Then SIGKILL Litestream, restore from the
           replica alone, and check that every acknowledged row is present.
           ``--app-checkpoint`` adds an application TRUNCATE checkpoint every
           few seconds, a stand-in for any other checkpointer.

Prints one JSON object.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import threading
import time

import httpx

WORK = "/tmp/i1540"
DB = f"{WORK}/db.sqlite"
REPLICA = f"{WORK}/replica"
SOCK = f"{WORK}/ls.sock"
RESTORED = f"{WORK}/restored.sqlite"


def config(monitor_interval: str) -> str:
    path = f"{WORK}/litestream.yml"
    with open(path, "w") as f:
        f.write(
            f"""socket:
  enabled: true
  path: {SOCK}
logging:
  level: info
dbs:
  - path: {DB}
    monitor-interval: {monitor_interval}
    replica:
      type: file
      path: {REPLICA}
      sync-interval: 1s
"""
        )
    return path


def reset() -> None:
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)


def connect() -> sqlite3.Connection:
    c = sqlite3.connect(DB, timeout=20, isolation_level=None)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.execute("PRAGMA busy_timeout=20000")
    return c


def start_litestream(cfg: str) -> subprocess.Popen:
    p = subprocess.Popen(["litestream", "replicate", "-config", cfg],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.monotonic() + 10
    while not os.path.exists(SOCK):
        if time.monotonic() > deadline:
            raise RuntimeError("litestream socket did not appear")
        time.sleep(0.01)
    return p


def client() -> httpx.Client:
    return httpx.Client(transport=httpx.HTTPTransport(uds=SOCK), timeout=60)


def sync(c: httpx.Client, wait: bool = False) -> dict:
    body: dict = {"path": DB}
    if wait:
        body["wait"] = True
    r = c.post("http://ls/sync", json=body)
    r.raise_for_status()
    return r.json()


def wait_replicated(c: httpx.Client, timeout: float = 30) -> dict:
    first = sync(c)
    target = first["txid"]
    t0 = time.monotonic()
    cur = first
    while cur["replicated_txid"] < target and time.monotonic() - t0 < timeout:
        time.sleep(0.05)
        cur = sync(c)
    cur["target"] = target
    return cur


def restore() -> dict:
    if os.path.exists(RESTORED):
        os.remove(RESTORED)
    t0 = time.monotonic()
    p = subprocess.run(["litestream", "restore", "-o", RESTORED, f"file://{REPLICA}"],
                       capture_output=True, text=True, check=False)
    out = {"exit": p.returncode, "restore_s": round(time.monotonic() - t0, 3)}
    if p.returncode != 0:
        out["stderr"] = p.stderr.strip().splitlines()[-3:]
        return out
    r = sqlite3.connect(RESTORED)
    try:
        lines = [row[0] for row in r.execute("PRAGMA integrity_check(100)")]
        out["integrity"] = "ok" if lines == ["ok"] else "corrupt"
        if lines != ["ok"]:
            out["integrity_errors_first"] = lines[:3]
            out["integrity_errors_shown"] = len(lines)
        out["data_rows"] = r.execute("SELECT count(*) FROM data").fetchone()[0]
        out["max_id"] = r.execute("SELECT coalesce(max(id),0) FROM data").fetchone()[0]
    except sqlite3.DatabaseError as exc:
        out["integrity"] = out.get("integrity", "corrupt")
        out["read_error"] = str(exc)
    finally:
        r.close()
    return out


def stop(p: subprocess.Popen, sig: int = signal.SIGTERM) -> list[str]:
    p.send_signal(sig)
    try:
        out, _ = p.communicate(timeout=60)
    except subprocess.TimeoutExpired:
        p.kill()
        out, _ = p.communicate()
    keep = ("checkpoint", "snapshot", "salt", "truncat", "reset", "error", "ERROR", "WARN")
    return [ln[:300] for ln in out.splitlines() if any(k in ln for k in keep)][-20:]


def repro(args: argparse.Namespace) -> dict:
    reset()
    cfg = config(args.monitor_interval)
    c = connect()
    c.execute("CREATE TABLE data (id INTEGER PRIMARY KEY, body TEXT)")
    c.execute("CREATE TABLE heartbeat (id INTEGER PRIMARY KEY, t REAL)")
    ls = start_litestream(cfg)
    res: dict = {"mode": "repro", "guard": args.guard, "monitor_interval": args.monitor_interval}
    with client() as h:
        if args.guard == "dropped":
            res["init_sync_wait"] = sync(h, wait=True)["status"]
        else:
            time.sleep(1.5)  # let the monitor initialise and take the guard
        body = "x" * 3500
        c.execute("BEGIN")
        for _ in range(80):
            c.execute("INSERT INTO data (body) VALUES (?)", (body,))
        c.execute("COMMIT")
        res["after_80"] = wait_replicated(h)
        # From here, everything must happen inside one monitor interval.
        t0 = time.monotonic()
        c.execute("BEGIN")
        for _ in range(121):
            c.execute("INSERT INTO data (body) VALUES (?)", (body,))
        c.execute("COMMIT")
        res["checkpoint_truncate"] = list(c.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone())
        c.execute("INSERT INTO heartbeat (t) VALUES (?)", (time.time(),))
        res["window_ms"] = round((time.monotonic() - t0) * 1000, 1)
        res["local_rows"] = c.execute("SELECT count(*) FROM data").fetchone()[0]
        time.sleep(2.5)
        res["final_pos"] = wait_replicated(h)
    res["litestream_log"] = stop(ls)
    res["restore"] = restore()
    res["lost_rows"] = res["local_rows"] - res["restore"].get("data_rows", 0)
    return res


def soak(args: argparse.Namespace) -> dict:
    reset()
    cfg = config(args.monitor_interval)
    c = connect()
    c.execute("CREATE TABLE data (id INTEGER PRIMARY KEY, t REAL, body TEXT)")
    ls = start_litestream(cfg)
    stop_ev = threading.Event()
    state = {"committed": 0, "acked": 0, "acks": 0, "ack_fail": 0, "app_ckpt": [], "errors": 0}
    lock = threading.Lock()

    def writer() -> None:
        w = connect()
        rnd = os.urandom
        while not stop_ev.is_set():
            w.execute("BEGIN")
            for _ in range(args.batch):
                w.execute("INSERT INTO data (t, body) VALUES (?, ?)", (time.time(), rnd(1200).hex()))
            w.execute("COMMIT")
            last = w.execute("SELECT max(id) FROM data").fetchone()[0]
            with lock:
                state["committed"] = last
            time.sleep(args.pause)

    def acker() -> None:
        with client() as h:
            while not stop_ev.is_set():
                with lock:
                    candidate = state["committed"]
                try:
                    if args.barrier == "wait":
                        r = sync(h, wait=True)
                        ok = r["replicated_txid"] >= r["txid"]
                    else:
                        r = wait_replicated(h, timeout=5)
                        ok = r["replicated_txid"] >= r["target"]
                except Exception:  # noqa: BLE001
                    ok = False
                with lock:
                    if ok:
                        state["acked"] = max(state["acked"], candidate)
                        state["acks"] += 1
                    else:
                        state["ack_fail"] += 1
                time.sleep(0.2)

    def checkpointer() -> None:
        k = connect()
        while not stop_ev.is_set():
            time.sleep(args.app_checkpoint)
            try:
                state["app_ckpt"].append(list(k.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()))
            except sqlite3.OperationalError:
                state["errors"] += 1

    threads = [threading.Thread(target=writer), threading.Thread(target=acker)]
    if args.app_checkpoint > 0:
        threads.append(threading.Thread(target=checkpointer))
    for t in threads:
        t.start()
    time.sleep(args.seconds)
    stop_ev.set()
    for t in threads:
        t.join()
    # Abrupt loss: no final sync. Only what is already in the replica counts.
    log = stop(ls, signal.SIGKILL)
    res = {"mode": "soak", "barrier": args.barrier, "seconds": args.seconds,
           "monitor_interval": args.monitor_interval, "app_checkpoint_every_s": args.app_checkpoint,
           "committed_max_id": state["committed"], "acked_max_id": state["acked"],
           "acks": state["acks"], "ack_failures": state["ack_fail"],
           "app_checkpoints": len(state["app_ckpt"]),
           "app_checkpoints_not_busy": sum(1 for x in state["app_ckpt"] if x[0] == 0),
           "litestream_log": log}
    res["restore"] = restore()
    rr = res["restore"]
    if rr.get("exit") == 0 and rr.get("integrity") == "ok":
        r = sqlite3.connect(RESTORED)
        present = r.execute("SELECT count(*) FROM data WHERE id <= ?", (state["acked"],)).fetchone()[0]
        r.close()
        res["acked_rows_present"] = present
        res["acked_rows_missing"] = state["acked"] - present
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    p = sub.add_parser("repro")
    p.add_argument("--guard", choices=["dropped", "held"], default="dropped")
    p.add_argument("--monitor-interval", default="5s")
    p = sub.add_parser("soak")
    p.add_argument("--barrier", choices=["nowait", "wait"], default="nowait")
    p.add_argument("--seconds", type=float, default=60)
    p.add_argument("--monitor-interval", default="1s")
    p.add_argument("--batch", type=int, default=20)
    p.add_argument("--pause", type=float, default=0.01)
    p.add_argument("--app-checkpoint", type=float, default=0.0)
    args = ap.parse_args()
    res = repro(args) if args.mode == "repro" else soak(args)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
