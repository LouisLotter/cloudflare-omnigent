"""Smoke test: one conversation, one turn, a two-phase capture, an overrun
capture and a small upload, then the process tree and counts."""

from __future__ import annotations

import json

import omni
from capture_bench import genws
from common import sup
from upload_tests import job, job_result


def main() -> None:
    agent = omni.register_agent()
    s = omni.new_session(agent)
    print("session", s)
    print("turn", omni.turn(s["session_id"], "hello"))
    genws("small")
    two = sup("/capture", {"method": "rsync-2phase", "budget_s": 20})
    print("2phase", {k: two.get(k) for k in ("outcome", "precopy_s", "pause_s", "pause_s_by_guard")})
    for budget in (0.05, 0.002, 0.0005):
        over = sup("/capture", {"method": "rsync", "budget_s": budget})
        print("overrun", budget, {k: over.get(k) for k in ("outcome", "pause_s", "pause_s_by_guard", "guard_reply", "freeze_error")})
        stopped = [p["pid"] for p in sup("/procs") if p["state"] in ("T", "t")]
        print("  left stopped:", stopped)
    up = job_result(job({"snapshot_dir": two["snapshot_dir"], "capture_id": two["capture_id"]}), 300)["result"]
    print("upload", {k: up.get(k) for k in ("outcome", "published", "size", "total_s")})
    print("pointer", sup("/pointer"))
    print("runners", json.dumps(sup("/runners")))
    print("turn", omni.turn(s["session_id"], "again"))


if __name__ == "__main__":
    main()
