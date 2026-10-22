"""Start (or restart) the S3 testbed and wait until the host is online.

  python3 spikes/s3/bench/up.py [--freezer sigstop|cgroup] [--down]
"""

from __future__ import annotations

import argparse
import json

from common import SPIKE, SRV, compose, http, sup, wait_for
from prepare_staging import prepare

HOST_ID = "6d2f6c1e-3b1a-4c55-9a51-5f3e0a000001"


def host_online() -> bool:
    code, out = http("GET", SRV + "/v1/hosts", timeout=5)
    if code != 200:
        return False
    for h in out.get("hosts", []):
        if h.get("host_id", "").replace("-", "") == HOST_ID.replace("-", "") and h.get("status") == "online":
            return True
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--freezer", default="sigstop")
    ap.add_argument("--down", action="store_true")
    ap.add_argument("--idle", default="900", help="runner.idle_timeout_s for the host's runners")
    args = ap.parse_args()
    if args.down:
        compose("--profile", "restore", "down", "-v", "--remove-orphans")
        print("down")
        return
    prepare()  # S6's credential policy, the mock LLM and the Omnigent base image
    variant = ["-f", str(SPIKE / "compose.cgroup.yaml")] if args.freezer == "cgroup" else []
    compose(*variant, "up", "-d", "--build", "--force-recreate",
            extra_env={"S3_FREEZER": args.freezer, "S3_RUNNER_IDLE_TIMEOUT_S": args.idle})
    wait_for(lambda: sup("/health", timeout=3), 120, what="supervisor")
    wait_for(host_online, 120, what="host online")
    print(json.dumps(sup("/health")))
    print("host online")


if __name__ == "__main__":
    main()
