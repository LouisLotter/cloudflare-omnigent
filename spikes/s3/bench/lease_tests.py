"""Criterion 2: the lease resumes the processes when its controller disappears.

Cases, each run several times with live conversations and the busy writer:
  release         normal capture; the guard resumes on release
  worker_killed   the capture worker (the lease's controller) is SIGKILLed
                  right after the pause; the guard sees its pipe close
  worker_wedged   the worker hangs after the pause and never releases; the
                  guard resumes at the lease deadline
  copy_overrun    the copy takes longer than the budget; the guard resumes at
                  the deadline and the copy is discarded (a fault-injected
                  slow worker, and a real copy with a 0.5 s budget)
  expire_during_freeze  a 2 ms budget: the lease expires while the worker is
                  still stopping processes (the race that left a whole
                  workload stopped in the first version of the guard)
  client_gone     the HTTP caller (WorkspaceDO's stand-in) disconnects right
                  after asking for the capture; the capture completes and
                  resumes on its own

For each run it records the writer's longest pause (an independent measure of
how long the workload was really stopped), whether any workload process is
still stopped afterwards, whether the host stayed online, whether a
conversation answers, and that nothing was left in the snapshot area.

  python3 spikes/s3/bench/lease_tests.py [--runs 3]
"""

from __future__ import annotations

import argparse
import json
import socket
import time
import uuid
from typing import Any

import omni
from capture_bench import PY, S3ENV, WRITER_LOG, HostPoller, genws, start_writer
from common import as_agent, save, stats, sup


def writer_gap(since: float) -> dict[str, Any]:
    r = as_agent([PY, "-m", "supervisor.checks", "gaps", WRITER_LOG, str(since)], env_extra=S3ENV)
    return json.loads(r["stdout"])


def stopped_workload() -> list[dict[str, Any]]:
    infra = {1}
    procs = sup("/procs")
    for p in procs:
        if "supervisor." in p["cmd"]:
            infra.add(p["pid"])
    return [p for p in procs if p["state"] in ("T", "t") and p["pid"] not in infra]


def snap_entries() -> list[str]:
    r = sup("/exec", {"argv": ["ls", "-A", "/snap"], "timeout": 10})
    return r["stdout"].split()


def client_gone_capture(budget: float) -> dict[str, Any]:
    cid = uuid.uuid4().hex[:12]
    body = json.dumps({"method": "rsync-2phase", "budget_s": budget, "capture_id": cid}).encode()
    s = socket.create_connection(("127.0.0.1", 17070))
    s.sendall(b"POST /capture HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
              + f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    time.sleep(0.05)
    s.close()  # the controller disappears before any answer
    deadline = time.monotonic() + budget + 60
    while time.monotonic() < deadline:
        try:
            return sup(f"/captures/{cid}")
        except RuntimeError:
            time.sleep(0.5)
    return {"outcome": "no_result"}


CASES = {
    "release": {"budget_s": 20, "fault": "", "method": "rsync-2phase"},
    "worker_killed": {"budget_s": 20, "fault": "die_after_freeze"},
    "worker_wedged": {"budget_s": 10, "fault": "hang_after_freeze"},
    "copy_overrun": {"budget_s": 5, "fault": "slow_copy:30"},
    "copy_overrun_real": {"budget_s": 0.5, "fault": ""},
    "expire_during_freeze": {"budget_s": 0.002, "fault": ""},
    "client_gone": {"budget_s": 20, "fault": ""},
}


def run_case(name: str, session: str) -> dict[str, Any]:
    cfg = CASES[name]
    since = time.time()
    t0 = time.monotonic()
    with HostPoller() as hp:
        if name == "client_gone":
            res = client_gone_capture(cfg["budget_s"])
        else:
            res = sup("/capture", {"method": "rsync", **cfg}, timeout=cfg["budget_s"] + 120)
    wall = time.monotonic() - t0
    time.sleep(0.5)
    gap = writer_gap(since)
    left = stopped_workload()
    row = {
        "case": name,
        "budget_s": cfg["budget_s"],
        "outcome": res.get("outcome"),
        "guard_outcome": (res.get("guard") or {}).get("outcome"),
        "guard_resume": [e for e in (res.get("guard") or {}).get("events", []) if e["event"] == "resumed"],
        "pause_s_reported": res.get("pause_s"),
        "writer_max_gap_s": gap["max_gap_s"],
        "stopped_after": [p["pid"] for p in left],
        "host_states": sorted(set(hp.states)),
        "turn_after": omni.turn(session, "after lease test"),
        "snap_left": snap_entries(),
        "wall_s": round(wall, 2),
    }
    print(json.dumps({k: row[k] for k in ("case", "outcome", "guard_outcome", "writer_max_gap_s", "stopped_after", "host_states", "snap_left")}
                     | {"turn": row["turn_after"]["ok"]}))
    for e in row["snap_left"]:
        sup("/rm", {"path": f"/snap/{e}"})
    return row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--profile", default="realistic")
    args = ap.parse_args()
    agent = omni.register_agent()
    sessions = [omni.new_session(agent) for _ in range(3)]
    for s in sessions:
        assert omni.turn(s["session_id"], "hello")["ok"]
    genws(args.profile)
    start_writer()
    time.sleep(1)
    rows = []
    for _ in range(args.runs):
        for name in CASES:
            rows.append(run_case(name, sessions[0]["session_id"]))
    as_agent(["pkill", "-f", "supervisor.writer"])
    summary = {}
    for name, cfg in CASES.items():
        sel = [r for r in rows if r["case"] == name]
        summary[name] = {
            "budget_s": cfg["budget_s"],
            "outcomes": sorted({str(r["outcome"]) for r in sel}),
            "guard_outcomes": sorted({str(r["guard_outcome"]) for r in sel}),
            "writer_max_gap_s": stats([r["writer_max_gap_s"] for r in sel]),
            "never_left_stopped": all(not r["stopped_after"] for r in sel),
            "host_always_online": all(r["host_states"] == ["online"] for r in sel),
            "turns_ok": all(r["turn_after"]["ok"] for r in sel),
            "snapshot_area_clean": all(not r["snap_left"] or name in ("release", "client_gone") for r in sel),
        }
    print(json.dumps(summary, indent=1))
    save("lease-tests", {"summary": summary, "rows": rows})


if __name__ == "__main__":
    main()
