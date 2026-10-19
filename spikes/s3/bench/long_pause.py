"""Calibration: how long a pause Omnigent's tunnels tolerate.

Pauses the whole workload for exactly B seconds (the capture worker wedges
after the pause and the lease guard resumes at the deadline) and records the
host state seen by the server once a second, whether a conversation answers
afterwards, and what the host daemon logged (tunnel reconnects, suspend
detection). The design's budget rests on Omnigent's 90 s ping deadline
(server/routes/host_tunnel.py: 30 s interval x 3 misses).

  python3 spikes/s3/bench/long_pause.py [--budgets 30,60,100]
"""

from __future__ import annotations

import argparse
import json
import time

import omni
from capture_bench import HostPoller
from common import as_agent, save, sup
from lease_tests import stopped_workload

MARKERS = ("Resumed from suspend", "reconnect", "Reconnect", "ping timeout", "disconnected", "Disconnected")


def daemon_log_lines() -> list[str]:
    r = as_agent(["bash", "-c", "cat ~/.omnigent/host-daemon.log 2>/dev/null | wc -l"])
    return [r["stdout"].strip()]


def new_log_lines(since_line: int) -> list[str]:
    r = as_agent(["bash", "-c", f"tail -n +{since_line + 1} ~/.omnigent/host-daemon.log 2>/dev/null"])
    return [ln[:220] for ln in r["stdout"].splitlines() if any(m in ln for m in MARKERS)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--budgets", default="30,60,100")
    args = ap.parse_args()
    agent = omni.register_agent()
    sessions = [omni.new_session(agent)["session_id"] for _ in range(2)]
    for s in sessions:
        assert omni.turn(s, "hello")["ok"]
    rows = []
    for b in [float(x) for x in args.budgets.split(",")]:
        start_line = int(daemon_log_lines()[0])
        t0 = time.time()
        with HostPoller() as hp:
            res = sup("/capture", {"method": "rsync", "budget_s": b, "fault": "hang_after_freeze"}, timeout=b + 200)
            # Keep watching for a while after the resume.
            time.sleep(15)
        states = hp.states
        offline_s = sum(1 for s in states if s != "online")
        turn_runner_ok = [omni.turn(s, f"after {b:.0f} s pause", timeout=120) for s in sessions]
        rows.append({
            "pause_budget_s": b,
            "outcome": res.get("outcome"),
            "guard": (res.get("guard") or {}).get("outcome"),
            "host_states_seen": sorted(set(states)),
            "seconds_not_online": offline_s,
            "turns_after": turn_runner_ok,
            "stopped_after": [p["pid"] for p in stopped_workload()],
            "daemon_log": new_log_lines(start_line)[-12:],
            "runner_count_after": sup("/runners")["runner_count"],
            "wall_s": round(time.time() - t0, 1),
        })
        print(json.dumps(rows[-1])[:1500])
        time.sleep(5)
    save("long-pause", {"rows": rows})


if __name__ == "__main__":
    main()
