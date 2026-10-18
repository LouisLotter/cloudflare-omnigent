"""Print the summaries of every results file, for the evidence entry.

  python3 spikes/s3/bench/report.py
"""

from __future__ import annotations

import json
from pathlib import Path

RESULTS = Path(__file__).resolve().parents[1] / "results"


def capture(name: str) -> None:
    d = json.loads((RESULTS / name).read_text())["data"]
    s = d["summary"]
    print(f"## {name}: {s['size_bytes'] / 1e6:.0f} MB, {s['files']} files (generated in {s['generation']['gen_s']} s)")
    for k, v in s.items():
        if not isinstance(v, dict) or "pause_s" not in v:
            continue
        p = v["pause_s"]
        extra = ""
        if v.get("precopy_s"):
            extra = f" precopy median {v['precopy_s']['median']} worst {v['precopy_s']['worst']}"
        print(f"  {k:24s} pause median {p.get('median')} worst {p.get('worst')} best {p.get('best')} n={p.get('n')}"
              f" outcomes={v['outcomes']} expired={v.get('expired_runs')} online={v['host_always_online']}"
              f" turns={v['turns_ok']} consistent={v['snapshots_prefix_consistent']}{extra}")
    rows = d["rows"]
    mbs = [r.get("copy_mb_s") for r in rows if r.get("copy_mb_s") and r["method"] in ("rsync", "tar")]
    if mbs:
        print(f"  full-copy throughput MB/s: min {min(mbs)} max {max(mbs)}")
    gaps = [r["consistency"].get("gap_after_snapshot_s") for r in rows if r.get("consistency", {}).get("gap_after_snapshot_s")]
    torn = [r for r in rows if r.get("consistency", {}).get("complete_last_record") is False]
    print(f"  writer gap checked in {len(gaps)} snapshots; torn last record in {len(torn)}")


def main() -> None:
    for f in sorted(RESULTS.glob("capture-*.json")):
        capture(f.name)
    for name in ("lease-tests", "upload-and-disk", "restore-sessions", "runner-count", "freeze-sigstop", "freeze-cgroup"):
        p = RESULTS / f"{name}.json"
        if p.exists():
            print(f"## {name}")
            print(json.dumps(json.loads(p.read_text())["data"].get("summary"), indent=1))
    p = RESULTS / "long-pause.json"
    if p.exists():
        print("## long-pause")
        for r in json.loads(p.read_text())["data"]["rows"]:
            print(json.dumps({k: r[k] for k in ("pause_budget_s", "outcome", "guard", "host_states_seen", "seconds_not_online", "stopped_after", "runner_count_after")}
                             | {"turns": [t["ok"] for t in r["turns_after"]], "log": r["daemon_log"][-4:]}))


if __name__ == "__main__":
    main()
