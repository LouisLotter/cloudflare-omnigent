"""SIGSTOP versus the cgroup v2 freezer, under load.

Load: live conversations, the busy writer, 200 idle processes, and a fork
storm (4 loops that start a short-lived process every few milliseconds). The
SIGSTOP freezer must chase new processes until a scan finds none; the cgroup
freezer stops the whole cgroup at once.

Runs the given mechanism against the running testbed:
  python3 spikes/s3/bench/up.py --freezer sigstop && python3 spikes/s3/bench/freeze_compare.py sigstop
  (compose with compose.cgroup.yaml)              && python3 spikes/s3/bench/freeze_compare.py cgroup
"""

from __future__ import annotations

import json
import sys
import time

import omni
from capture_bench import genws, start_writer
from common import as_agent, save, stats, sup
from lease_tests import stopped_workload, writer_gap


def main() -> None:
    mech = sys.argv[1]
    runs = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    health = sup("/health")
    if mech == "cgroup":
        assert health["cgroup"], "cgroup freezer not available in this container"
    agent = omni.register_agent()
    sessions = [omni.new_session(agent)["session_id"] for _ in range(3)]
    for s in sessions:
        assert omni.turn(s, "hello")["ok"]
    genws("small")
    start_writer()
    rows = []
    for load in ("idle", "200-procs", "fork-storm"):
        if load == "200-procs":
            as_agent(["bash", "-c", "for i in $(seq 200); do nohup sleep 100000 >/dev/null 2>&1 & done"])
        if load == "fork-storm":
            as_agent(["bash", "-c", "for i in 1 2 3 4; do nohup bash -c 'while true; do /bin/true; done' >/dev/null 2>&1 & done"])
        time.sleep(1)
        for _ in range(runs):
            since = time.time()
            res = sup("/capture", {"method": "rsync", "budget_s": 20, "mechanism": mech})
            # Let the writer run again before reading its log: with 200+ processes
            # resuming on one vCPU it may not have written yet.
            time.sleep(1.0)
            gap = writer_gap(since)
            left = stopped_workload()
            fr = res.get("freeze") or {}
            rows.append({
                "mechanism": res.get("mechanism"),
                "load": load,
                "outcome": res.get("outcome"),
                "freeze_s": res.get("freeze_s"),
                "signal_s": fr.get("signal_s"),
                "settle_s": fr.get("settle_s"),
                "passes": fr.get("passes"),
                "stopped": fr.get("stopped_count"),
                "running_after_freeze": res.get("running_after_freeze"),
                "pause_s": res.get("pause_s"),
                "writer_gap_s": gap["max_gap_s"],
                "left_stopped": len(left),
            })
            print(json.dumps(rows[-1]))
            if res.get("snapshot_dir"):
                sup("/rm", {"path": res["snapshot_dir"]})
    as_agent(["bash", "-c", "pkill -f 'while true' ; pkill -f 'sleep 100000'; pkill -f supervisor.writer; true"])
    summary = {}
    for load in ("idle", "200-procs", "fork-storm"):
        sel = [r for r in rows if r["load"] == load]
        summary[load] = {
            "freeze_s": stats([r["freeze_s"] for r in sel if r["freeze_s"] is not None]),
            "passes": stats([r["passes"] for r in sel if r["passes"] is not None]),
            "stopped": stats([r["stopped"] for r in sel if r["stopped"] is not None]),
            "outcomes": sorted({str(r["outcome"]) for r in sel}),
            "all_frozen": all(not r["running_after_freeze"] for r in sel),
            "never_left_stopped": all(r["left_stopped"] == 0 for r in sel),
        }
    print(json.dumps(summary, indent=1))
    save(f"freeze-{mech}", {"summary": summary, "rows": rows})


if __name__ == "__main__":
    main()
