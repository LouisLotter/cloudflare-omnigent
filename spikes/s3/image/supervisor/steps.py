"""The staging campaign's container-side steps (run as supervisor jobs).

* ``setup``: the Omnigent conversations that stay live through the benches.
* ``bench``: captures of one workspace profile per method, warm and cold, while
  Omnigent's host, its runners, a busy writer and 50 idle processes run. Each
  capture pauses all of them (AR-09); each row records the pause, what was
  stopped and what kept running, the host's state every second, its tunnel
  redials, the writer's consistency, and a conversation turn afterwards.
* ``calibrate``: deliberate pauses of a fixed length (40 s, the hard budget,
  and 60 s) to watch Omnigent's tunnels across them (core change 12).
* ``load``: conversation turns every few seconds and one capture, while the
  Durable Object's upload is held at the gateway (R2 blocked over 90 s).

The bench budget defaults to 60 s, above the design's 40 s hard budget, so a
pause past the budget is measured instead of cut off; the summary flags it.
"""

from __future__ import annotations

import json
import os
import signal
import statistics
import subprocess
import threading
import time
from collections.abc import Callable
from typing import Any

from . import aio, omni
from . import procs as P

PY = "/opt/venv/bin/python"
WRITER_LOG = "/home/agent/work/writer.log"
AGENT_ENV = {"PYTHONPATH": "/opt/s3", "HOME": "/home/agent"}

RunCapture = Callable[[dict[str, Any]], dict[str, Any]]
AsAgent = Callable[[list[str]], list[str]]

SESSIONS: dict[str, Any] = {}
# The workspace profile last generated in ~/work, for the campaign's checks (GET /boot).
PROFILE: dict[str, str | None] = {"current": None}


def stats(xs: list[float]) -> dict[str, float]:
    xs = [x for x in xs if x is not None]
    if not xs:
        return {}
    return {"n": len(xs), "median": round(statistics.median(xs), 3), "worst": round(max(xs), 3),
            "best": round(min(xs), 3)}


def run_agent(as_agent: AsAgent, argv: list[str], timeout: float = 3600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(as_agent(argv), env={**os.environ, **AGENT_ENV}, capture_output=True, text=True,
                          timeout=timeout)


def setup(_body: dict[str, Any] | None = None, sessions: int = 3) -> dict[str, Any]:
    """Register the agent and open conversations on this container's host."""
    t0 = time.monotonic()
    if not omni.wait_host_online(180):
        raise RuntimeError(f"host not online: {omni.host_status()}")
    agent = omni.register_agent()
    made = [omni.new_session(agent) for _ in range(sessions)]
    turns = [omni.turn(s["session_id"], "hello") for s in made]
    SESSIONS.update(agent=agent, sessions=made)
    return {"host": omni.host_status(), "sessions": len(made), "launch_s": [s["launch_s"] for s in made],
            "first_turns_ok": all(t["ok"] for t in turns), "setup_s": round(time.monotonic() - t0, 1)}


def main_session() -> str:
    if not SESSIONS.get("sessions"):
        setup()
    return str(SESSIONS["sessions"][0]["session_id"])


class HostPoller:
    """Polls the server's view of the host once a second."""

    def __init__(self) -> None:
        self.states: list[str] = []
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.states.append(omni.host_status())
            self._stop.wait(1.0)

    def __enter__(self) -> HostPoller:
        self._t.start()
        return self

    def __exit__(self, *a: object) -> None:
        self._stop.set()
        self._t.join()

    def summary(self) -> dict[str, Any]:
        """States seen; seconds the server reported the host not online; polls the server did
        not answer in 5 s (it shares the container's one vCPU with the capture's copy)."""
        errors = sum(1 for s in self.states if s.startswith(("error:", "http-")))
        return {"states": sorted(set(self.states)), "polls": len(self.states),
                "not_online_s": sum(1 for s in self.states if s != "online" and not s.startswith(("error:", "http-"))),
                "poll_errors": errors}


def start_load(as_agent: AsAgent) -> None:
    """The busy writer and 50 idle processes, orphaned so they are workload, not infra."""
    run_agent(as_agent, ["bash", "-c",
                         f"nohup {PY} -m supervisor.writer {WRITER_LOG} >/dev/null 2>&1 & "
                         "for i in $(seq 50); do nohup sleep 100000 >/dev/null 2>&1 & done"], timeout=60)


def stop_load() -> int:
    procs = P.scan()
    n = 0
    for p in procs.values():
        if P.kind(p, procs) in ("writer", "idle-sleep") and p.uid == 1000:
            try:
                os.kill(p.pid, signal.SIGKILL)
                n += 1
            except ProcessLookupError:
                pass
    return n


def genws(as_agent: AsAgent, profile: str) -> dict[str, Any]:
    PROFILE["current"] = None
    r = run_agent(as_agent, [PY, "-m", "supervisor.genws", profile])
    if r.returncode != 0:
        raise RuntimeError(f"genws {profile} failed: {r.stderr[-500:]}")
    PROFILE["current"] = profile
    return json.loads(r.stdout.strip().splitlines()[-1])


def evict(as_agent: AsAgent) -> dict[str, Any]:
    r = run_agent(as_agent, [PY, "-m", "supervisor.genws", "evict"], timeout=900)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return {"error": r.stderr[-200:]}


def consistency(as_agent: AsAgent, snap: str | None) -> dict[str, Any]:
    if not snap or not os.path.exists(os.path.join(snap, "work", "writer.log")):
        return {}
    r = run_agent(as_agent, [PY, "-m", "supervisor.checks", WRITER_LOG, f"{snap}/work/writer.log"], timeout=120)
    return json.loads(r.stdout) if r.returncode == 0 else {"error": r.stderr[-200:]}


def capture_row(res: dict[str, Any]) -> dict[str, Any]:
    fr = res.get("freeze") or {}
    row = {k: res.get(k) for k in (
        "method", "outcome", "pause_s", "pause_s_by_guard", "freeze_s", "copy_s", "release_s", "precopy_s",
        "size_bytes", "files", "snapshot_bytes", "budget_check_s", "free_bytes", "reused_snapshot",
        "stopped_by_kind", "running_by_kind", "running_after_freeze", "total_s", "worker_wall_s")}
    row["stopped"] = fr.get("stopped_count")
    row["freeze_passes"] = fr.get("passes")
    if res.get("copy_s") and res.get("size_bytes"):
        row["copy_mb_s"] = round(res["size_bytes"] / 1e6 / res["copy_s"], 1)
    return row


def bench(body: dict[str, Any], run_capture: RunCapture, as_agent: AsAgent) -> dict[str, Any]:
    profile = body.get("profile", "realistic")
    plan = body.get("plan") or [{"method": "rsync-2phase", "runs": 5}, {"method": "reflink", "runs": 3}]
    temps = body.get("temps") or ["warm", "cold"]
    budget = float(body.get("budget_s", 60))
    session = main_session()
    t0 = time.monotonic()
    gen = genws(as_agent, profile)
    start_load(as_agent)
    time.sleep(1)
    rows: list[dict[str, Any]] = []
    try:
        for step in plan:
            for temp in temps:
                for _ in range(int(step.get("runs", 3))):
                    ev = evict(as_agent) if temp == "cold" else None
                    connects = aio.host_connects()
                    with HostPoller() as hp:
                        res = run_capture({"method": step["method"], "budget_s": budget, "record_kinds": True})
                    row = {"temp": temp, **capture_row(res), "host": hp.summary(), "evict": ev}
                    row["consistency"] = consistency(as_agent, res.get("snapshot_dir"))
                    row["turn_after"] = omni.turn(session, "still there?")
                    row["host_connects"] = aio.host_connects() - connects
                    if res.get("snapshot_dir"):
                        subprocess.run(["rm", "-rf", res["snapshot_dir"]], check=False)
                    rows.append(row)
    finally:
        stop_load()
    summary: dict[str, Any] = {"profile": profile, "generation": gen, "size_bytes": rows[0]["size_bytes"] if rows
                               else None, "files": rows[0]["files"] if rows else None, "budget_s": budget}
    for step in plan:
        for temp in temps:
            sel = [r for r in rows if r["method"] == step["method"] and r["temp"] == temp]
            ok = [r for r in sel if r["outcome"] == "snapshot_ready"]
            summary[f"{step['method']}-{temp}"] = {
                "runs": len(sel),
                "outcomes": sorted({str(r["outcome"]) for r in sel}),
                "pause_s": stats([r["pause_s"] for r in ok]),
                "copy_s": stats([r["copy_s"] for r in ok]),
                "precopy_s": stats([r["precopy_s"] for r in ok]),
                "over_20s": sum(1 for r in ok if (r["pause_s"] or 0) > 20),
                "over_40s": sum(1 for r in ok if (r["pause_s"] or 0) > 40),
                "host_always_online": all(r["host"]["not_online_s"] == 0 for r in sel),
                "server_poll_errors": sum(r["host"]["poll_errors"] for r in sel),
                "host_redials": sum(r["host_connects"] for r in sel),
                "turns_ok": sum(1 for r in sel if r["turn_after"].get("ok")),
                "writer_prefix_consistent": sum(1 for r in ok if r["consistency"].get("prefix")),
                "stopped_by_kind": ok[0]["stopped_by_kind"] if ok else None,
                "running_by_kind": ok[0]["running_by_kind"] if ok else None,
            }
    summary["bench_s"] = round(time.monotonic() - t0, 1)
    return {"summary": summary, "rows": rows}


def calibrate(body: dict[str, Any], run_capture: RunCapture, items: list[dict[str, Any]]) -> dict[str, Any]:
    """Pauses of a fixed length with Omnigent's processes stopped, then 30 s of watching."""
    holds = body.get("holds") or [40, 60]
    session = main_session()
    small = [it for it in items if it["name"] == "omnigent"]  # the copy itself takes no time
    rows = []
    for hold in holds:
        connects = aio.host_connects()
        before = omni.turn(session, "before the pause")
        with HostPoller() as hp:
            res = run_capture({"method": "rsync-2phase", "budget_s": float(hold) + 20, "items": small,
                               "fault": f"slow_copy:{hold}", "record_kinds": True})
            time.sleep(30)
        row = {"hold_s": hold, **capture_row(res), "host": hp.summary(), "turn_before": before,
               "turn_after": omni.turn(session, "after the pause"), "host_connects": aio.host_connects() - connects,
               "session_status": omni.snapshot(session).get("status")}
        if res.get("snapshot_dir"):
            subprocess.run(["rm", "-rf", res["snapshot_dir"]], check=False)
        rows.append(row)
    return {"rows": rows}


def load(body: dict[str, Any], run_capture: RunCapture) -> dict[str, Any]:
    """Turns every few seconds and one capture, for ``duration_s``; runs beside a held upload."""
    duration = float(body.get("duration_s", 150))
    every = float(body.get("turn_every_s", 5))
    capture_at = float(body.get("capture_at_s", 30))
    session = main_session()
    t0 = time.monotonic()
    turns: list[dict[str, Any]] = []
    cap: dict[str, Any] = {}

    def capture_later() -> None:
        time.sleep(capture_at)
        res = run_capture({"method": "rsync-2phase", "budget_s": 40.0, "record_kinds": True})
        cap.update(capture_row(res), at_s=round(time.monotonic() - t0, 1))
        if res.get("snapshot_dir"):
            subprocess.run(["rm", "-rf", res["snapshot_dir"]], check=False)

    th = threading.Thread(target=capture_later, daemon=True)
    with HostPoller() as hp:
        th.start()
        while time.monotonic() - t0 < duration:
            t = time.monotonic()
            r = omni.turn(session, f"turn at {round(t - t0)} s", timeout=90)
            turns.append({"at_s": round(t - t0, 1), "ok": r["ok"], "s": r["s"]})
            time.sleep(max(0.0, every - (time.monotonic() - t)))
        th.join(timeout=120)
    return {"turns": len(turns), "turns_ok": sum(1 for t in turns if t["ok"]),
            "turn_s": stats([t["s"] for t in turns]), "capture": cap, "host": hp.summary(),
            "rows": turns}
