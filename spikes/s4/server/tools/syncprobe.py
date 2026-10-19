"""Call Litestream's ``POST /sync`` (no wait) every ``--interval`` seconds and
report how long each call takes, to find stalls in the control socket."""

from __future__ import annotations

import argparse
import json
import os
import threading
import time

import httpx

SOCKET = os.environ.get("S4_LITESTREAM_SOCKET", "/run/litestream/litestream.sock")
DB = os.environ.get("S4_DB_PATH", "/data/db/omnigent.db")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--interval", type=float, default=0.1)
    ap.add_argument("--slow-ms", type=float, default=300)
    ap.add_argument("--status-only", action="store_true",
                    help="only watch /debug/sync-status; do not call /sync (no extra LTX files)")
    args = ap.parse_args()
    lat, slow = [], []
    end = time.monotonic() + args.seconds
    phases: dict[str, float] = {}

    def watch() -> None:
        # Longest time each Litestream operation phase was seen active.
        with httpx.Client(transport=httpx.HTTPTransport(uds=SOCKET), timeout=60) as c:
            while time.monotonic() < end:
                try:
                    d = c.get("http://ls/debug/sync-status").json()["databases"][0]
                    if d.get("active"):
                        k = f"{d.get('operation')}/{d.get('phase')}"
                        phases[k] = max(phases.get(k, 0.0), float(d.get("elapsed_seconds") or 0))
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.05)

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    with httpx.Client(transport=httpx.HTTPTransport(uds=SOCKET), timeout=60) as c:
        while time.monotonic() < end:
            if args.status_only:
                time.sleep(0.5)
                continue
            t0 = time.monotonic()
            wall = time.time()
            try:
                r = c.post("http://ls/sync", json={"path": DB}).json()
                err = None
            except Exception as exc:  # noqa: BLE001
                r, err = {}, f"{type(exc).__name__}"
            d = (time.monotonic() - t0) * 1000
            lat.append(d)
            if d > args.slow_ms or err:
                slow.append({"t": round(wall, 3), "ms": round(d, 1), "err": err,
                             "txid": r.get("txid"), "replicated": r.get("replicated_txid")})
            time.sleep(args.interval)
    watcher.join(timeout=5)
    lat.sort()
    stats = {"n": len(lat), "p50_ms": round(lat[len(lat) // 2], 1),
             "p99_ms": round(lat[int(len(lat) * 0.99)], 1), "max_ms": round(lat[-1], 1)} if lat else {}
    print(json.dumps({**stats, "slow": slow[:50],
                      "phase_max_elapsed_s": {k: round(v, 3) for k, v in sorted(phases.items())}}))


if __name__ == "__main__":
    main()
