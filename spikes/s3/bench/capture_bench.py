"""Criterion 1: a realistic workspace copies within the pause budget.

For each workspace profile and copy method, runs captures while live
conversations (runners, harnesses, terminals) and a busy writer process run,
and records the pause (first SIGSTOP to last SIGCONT), its phases, the copy
throughput, whether the host stayed online, whether a conversation still
answers afterwards, and whether the snapshot is consistent.

  python3 spikes/s3/bench/capture_bench.py --profiles small,realistic,large,many-small --runs 5
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from typing import Any

import omni
from common import as_agent, save, stats, sup

PY = "/opt/venv/bin/python"
S3ENV = {"PYTHONPATH": "/opt/s3"}
WRITER_LOG = "/home/agent/work/writer.log"


def genws(profile: str) -> dict[str, Any]:
    r = as_agent([PY, "-m", "supervisor.genws", profile], timeout=1800, env_extra=S3ENV)
    assert r["rc"] == 0, r
    return json.loads(r["stdout"].strip().splitlines()[-1])


def evict() -> None:
    as_agent([PY, "-m", "supervisor.genws", "evict"], timeout=600, env_extra=S3ENV)


def start_writer() -> None:
    as_agent(["bash", "-c", f"nohup {PY} -m supervisor.writer {WRITER_LOG} >/dev/null 2>&1 &"], env_extra=S3ENV)


class HostPoller:
    """Polls the server once a second during a capture; records any non-online state."""

    def __init__(self) -> None:
        self.states: list[str] = []
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.states.append(omni.host_status())
            except Exception as exc:  # noqa: BLE001
                self.states.append(f"error:{type(exc).__name__}")
            self._stop.wait(1.0)

    def __enter__(self) -> HostPoller:
        self._t.start()
        return self

    def __exit__(self, *a: object) -> None:
        self._stop.set()
        self._t.join()


def check_snapshot(res: dict[str, Any]) -> dict[str, Any]:
    snap = res.get("snapshot_dir")
    if not snap or res.get("method") == "tar-zstd":
        return {"note": "not checked (archive)"} if snap else {}
    r = as_agent([PY, "-m", "supervisor.checks", WRITER_LOG, f"{snap}/work/writer.log"], env_extra=S3ENV)
    return json.loads(r["stdout"]) if r["rc"] == 0 else {"error": r["stderr"][-300:]}


def mutate() -> None:
    """A small change between incremental captures: 50 edited files and one new 10 MB file."""
    script = (
        "import os,random,glob;fs=sorted(glob.glob('/home/agent/work/**/*.py',recursive=True))[:2000];"
        "random.seed(len(fs));[open(f,'a').write('# edit\\n') for f in random.sample(fs,min(50,len(fs)))];"
        "open('/home/agent/work/new-%d.bin'%random.randint(0,10**9),'wb').write(os.urandom(10<<20))"
    )
    as_agent([PY, "-c", script])


def capture_once(method: str, budget: float, cold: bool, session: str) -> dict[str, Any]:
    if cold:
        evict()
    with HostPoller() as hp:
        res = sup("/capture", {"method": method, "budget_s": budget}, timeout=budget + 120)
    row = {
        "method": method,
        "cold_cache": cold,
        "outcome": res["outcome"],
        "pause_s": res.get("pause_s"),
        "freeze_s": res.get("freeze_s"),
        "copy_s": res.get("copy_s"),
        "release_s": res.get("release_s"),
        "stopped": (res.get("freeze") or {}).get("stopped_count"),
        "freeze_passes": (res.get("freeze") or {}).get("passes"),
        "running_after_freeze": res.get("running_after_freeze"),
        "size_bytes": res.get("size_bytes"),
        "files": res.get("files"),
        "snapshot_bytes": res.get("snapshot_bytes"),
        "budget_check_s": res.get("budget_check_s"),
        "precopy_s": res.get("precopy_s"),
        "pause_s_by_guard": res.get("pause_s_by_guard"),
        "host_states": sorted(set(hp.states)),
    }
    if res.get("copy_s"):
        row["copy_mb_s"] = round((res.get("size_bytes") or 0) / 1e6 / res["copy_s"], 1)
    row["consistency"] = check_snapshot(res)
    row["turn_after"] = omni.turn(session, "still there?")
    if res.get("snapshot_dir") and method != "rsync-incremental":
        sup("/rm", {"path": res["snapshot_dir"]})
    print(json.dumps({k: row[k] for k in ("method", "cold_cache", "outcome", "pause_s", "copy_s", "stopped")}
                     | {"host": row["host_states"], "turn": row["turn_after"]["ok"]}))
    return row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profiles", default="small,realistic,large,many-small")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--budget", type=float, default=85.0)
    ap.add_argument("--sessions", type=int, default=4)
    ap.add_argument("--plan", choices=["standard", "2phase", "reflink", "corrected"], default="standard")
    args = ap.parse_args()

    agent = omni.register_agent()
    sessions = [omni.new_session(agent) for _ in range(args.sessions)]
    for s in sessions:
        assert omni.turn(s["session_id"], "hello")["ok"]
    main_session = sessions[0]["session_id"]
    out: dict[str, Any] = {"profiles": {}}
    for profile in args.profiles.split(","):
        gen = genws(profile)
        start_writer()
        time.sleep(1)
        rows: list[dict[str, Any]] = []
        if args.plan == "reflink":
            plan = [("reflink", False), ("reflink", True)]
        elif args.plan == "2phase":
            plan = [("rsync-2phase", False), ("rsync-2phase", True)]
        elif args.plan == "corrected":
            # After IR-008/011/012/015/016: content-correct final pass, guard-owned
            # stops, credential policy and checked copy steps.
            plan = [("rsync-2phase", False), ("rsync-2phase", True), ("reflink", False), ("reflink", True)]
        else:
            plan = [("rsync", False), ("rsync", True)]
        for method, cold in plan:
            for _ in range(args.runs if method.startswith("rsync") else max(3, args.runs // 2)):
                rows.append(capture_once(method, args.budget, cold, main_session))
        if args.plan in ("standard", "corrected"):
            # Incremental: one full base, then small changes captured incrementally.
            sup("/rm", {"path": "/snap", "all": True, "forget_base": True})
            rows.append(capture_once("rsync-incremental", args.budget, True, main_session) | {"incremental_base": True})
            for _ in range(args.runs):
                mutate()
                rows.append(capture_once("rsync-incremental", args.budget, True, main_session))
            plan = [*plan, ("rsync-incremental", True)]
        as_agent(["pkill", "-f", "supervisor.writer"])
        summary: dict[str, Any] = {"generation": gen, "size_bytes": rows[0]["size_bytes"], "files": rows[0]["files"]}
        for method, cold in plan:
            sel = [r for r in rows if r["method"] == method and r["cold_cache"] == cold and not r.get("incremental_base")]
            ok = [r for r in sel if r["outcome"] == "snapshot_ready"]
            summary[f"{method}{'-cold' if cold else '-warm'}"] = {
                "pause_s": stats([r["pause_s"] for r in ok]),
                "copy_s": stats([r["copy_s"] for r in ok]),
                "freeze_s": stats([r["freeze_s"] for r in ok]),
                "outcomes": sorted({r["outcome"] for r in sel}),
                "runs": len(sel),
                "expired_runs": sum(1 for r in sel if r["outcome"] == "discarded_lease_expired"),
                "precopy_s": stats([r["precopy_s"] for r in ok if r.get("precopy_s") is not None]),
                "host_always_online": all(r["host_states"] == ["online"] for r in sel),
                "turns_ok": all(r["turn_after"]["ok"] for r in sel),
                "snapshots_prefix_consistent": all(r["consistency"].get("prefix") for r in ok if "note" not in r["consistency"]),
            }
        out["profiles"][profile] = {"summary": summary, "rows": rows}
        print(json.dumps({profile: summary}, indent=1))
        save(f"capture-{profile}" + ("" if args.plan == "standard" else f"-{args.plan}"), out["profiles"][profile])
        sup("/rm", {"path": "/snap", "all": True, "forget_base": True})
        as_agent(["bash", "-c", "rm -rf /home/agent/work/new-*.bin"])
        clear = as_agent(["bash", "-c", "true"])
        assert clear["rc"] == 0


if __name__ == "__main__":
    main()
