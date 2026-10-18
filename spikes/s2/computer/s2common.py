"""Shared helpers for the S2 computer scripts: timestamps and the report channel.

Every measurement is one JSON object. It is printed to stdout (container logs, which reach
Workers Logs) and queued for POST to http://omnigent.internal/_s2/report, which the
PrivateRoute logs. A report that cannot be delivered (the route is down during a redeploy)
stays queued with its original timestamp and is sent when the route is back.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from collections import deque

SERVER_URL = os.environ.get("S2_SERVER_URL", "http://omnigent.internal")
GENERATION = os.environ.get("S2_GENERATION", "0")
BOOT_ID = open("/proc/sys/kernel/random/boot_id").read().strip()[:8]  # noqa: SIM115
STARTED = time.time()

_queue: deque[str] = deque(maxlen=20000)
_lock = threading.Lock()


def now_ms() -> int:
    return int(time.time() * 1000)


def report(kind: str, **fields: object) -> None:
    record = {"k": kind, "ct": now_ms(), "boot": BOOT_ID, "gen": GENERATION, **fields}
    line = json.dumps(record, separators=(",", ":"), default=str)
    print(f"S2 {line}", flush=True)
    with _lock:
        _queue.append(line)


def _flush_once() -> bool:
    with _lock:
        batch = list(_queue)[:200]
    if not batch:
        return True
    body = "\n".join(batch).encode()
    req = urllib.request.Request(f"{SERVER_URL}/_s2/report", data=body, method="POST")
    req.add_header("content-type", "application/x-ndjson")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            if res.status != 200:
                return False
    except Exception:  # noqa: BLE001 - delivery is retried; the record stays queued
        return False
    with _lock:
        for _ in batch:
            _queue.popleft()
    return True


def start_reporter(interval: float = 2.0) -> None:
    def loop() -> None:
        while True:
            ok = _flush_once()
            time.sleep(interval if ok else 1.0)

    threading.Thread(target=loop, name="s2-reporter", daemon=True).start()
