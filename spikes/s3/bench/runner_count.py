"""Criterion 6: the supervisor's runner count matches Omnigent's own runners.

Compares, at each step, three views:
  supervisor   /proc + sock_diag rule (supervisor/runners.py)
  host CLI     `omnigent host status --json --sessions`: sessions the host
               lists as connected with runner_online = true (Omnigent's view)
  naive        every child of the zygote (what a plain process count gives)

Steps: start N conversations, run turns (spawns harness children), pause and
resume everything, stop two conversations, SIGKILL one runner, then wait for
the runner idle timeout (60 s in compose.yaml) so the rest exit on their own.

  python3 spikes/s3/bench/runner_count.py [--sessions 6] [--runs 3]
"""

from __future__ import annotations

import argparse
import json
import time
from typing import Any

import omni
from common import SRV, as_agent, http, save, sup, wait_for


def omnigent_view() -> dict[str, Any]:
    r = as_agent(["omnigent", "host", "status", "--json", "--sessions"], timeout=60)
    data = json.loads(r["stdout"])
    sessions = data["daemons"][0].get("sessions") or []
    online = sorted(s["id"] for s in sessions if s.get("runner_online"))
    return {"runner_online": len(online), "sessions": online}


def sample(step: str, settle_s: float = 0.0) -> dict[str, Any]:
    if settle_s:
        time.sleep(settle_s)
    sv = sup("/runners")
    ov = omnigent_view()
    row = {
        "step": step,
        "supervisor": sv["runner_count"],
        "omnigent": ov["runner_online"],
        "naive_zygote_children": sv["zygote_children"],
        "harnesses": len(sv["harnesses"]),
        "match": sv["runner_count"] == ov["runner_online"],
    }
    print(json.dumps(row))
    return row


def converge(step: str, timeout: float = 30) -> dict[str, Any]:
    """Runner exits take a moment to reach the server; sample until both agree."""
    deadline = time.monotonic() + timeout
    row = sample(step)
    while not row["match"] and time.monotonic() < deadline:
        time.sleep(1)
        row = sample(step)
    row["converge_s"] = round(timeout - max(0.0, deadline - time.monotonic()), 1)
    return row


def stop_session(sid: str) -> None:
    code, out = http("POST", SRV + f"/v1/sessions/{sid}/events", {"type": "stop_session", "data": {}})
    assert code in (200, 201, 202), (code, out)


def one_run(n: int, run: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    agent = omni.register_agent()
    rows.append(converge(f"run{run}: baseline"))
    sessions = []
    for i in range(n):
        sessions.append(omni.new_session(agent))
        rows.append(sample(f"run{run}: {i + 1} sessions started"))
    for s in sessions[:3]:
        t = omni.turn(s["session_id"], "hello")
        assert t["ok"], t
    rows.append(sample(f"run{run}: turns done in 3 sessions"))
    cap = sup("/capture", {"method": "rsync", "budget_s": 20})
    rows.append(sample(f"run{run}: after pause/resume ({cap['outcome']}, pause {cap.get('pause_s')} s)"))
    for s in sessions[:2]:
        stop_session(s["session_id"])
    rows.append(converge(f"run{run}: 2 sessions stopped"))
    victim = sup("/runners")["runners"][0]
    as_agent(["kill", "-9", str(victim)])
    rows.append(converge(f"run{run}: 1 runner SIGKILLed", timeout=120))
    t0 = time.monotonic()
    wait_for(lambda: sup("/runners")["runner_count"] == 0, 240, 2, "idle exit")
    idle_s = time.monotonic() - t0
    rows.append(converge(f"run{run}: idle timeout ({idle_s:.0f} s after kill)"))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sessions", type=int, default=6)
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()
    rows: list[dict[str, Any]] = []
    for run in range(1, args.runs + 1):
        rows += one_run(args.sessions, run)
    mism = [r for r in rows if not r["match"]]
    naive_wrong = [r for r in rows if r["naive_zygote_children"] != r["omnigent"]]
    summary = {
        "samples": len(rows),
        "mismatches": len(mism),
        "naive_count_wrong_samples": len(naive_wrong),
        "max_runners": max(r["omnigent"] for r in rows),
    }
    print(json.dumps(summary))
    save("runner-count", {"summary": summary, "rows": rows})


if __name__ == "__main__":
    main()
