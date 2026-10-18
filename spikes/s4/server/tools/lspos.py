"""Print Litestream's local and replicated TXID for the server database.

Runs inside the server container. Uses ``POST /sync`` without ``wait`` (the
only call that reports ``replicated_txid``), so it also converts any pending
WAL to LTX. Optional ``--wait-caught-up SECONDS`` polls until the replica
covers the local position.
"""

from __future__ import annotations

import argparse
import json
import os
import time

import httpx

SOCKET = os.environ.get("S4_LITESTREAM_SOCKET", "/run/litestream/litestream.sock")
DB = os.environ.get("S4_DB_PATH", "/data/db/omnigent.db")


def pos(client: httpx.Client) -> dict:
    r = client.post("http://litestream/sync", json={"path": DB})
    r.raise_for_status()
    return r.json()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait-caught-up", type=float, default=0.0)
    args = ap.parse_args()
    t0 = time.monotonic()
    with httpx.Client(transport=httpx.HTTPTransport(uds=SOCKET), timeout=30) as c:
        p = pos(c)
        target = p["txid"]
        while args.wait_caught_up and p["replicated_txid"] < target:
            if time.monotonic() - t0 > args.wait_caught_up:
                break
            time.sleep(0.2)
            p = pos(c)
    p["target_txid"] = target
    p["caught_up"] = p["replicated_txid"] >= target
    p["elapsed_s"] = round(time.monotonic() - t0, 3)
    print(json.dumps(p))


if __name__ == "__main__":
    main()
