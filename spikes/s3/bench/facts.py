"""Aggregate facts across all capture results files, for the evidence entry.

  python3 spikes/s3/bench/facts.py
"""

from __future__ import annotations

import json
from pathlib import Path

RESULTS = Path(__file__).resolve().parents[1] / "results"


def main() -> None:
    checked = prefix_ok = torn = captures = 0
    freeze = []
    stopped = []
    mbs = []
    files_s = []
    offline = 0
    turns_bad = 0
    for f in sorted(RESULTS.glob("capture-*.json")):
        rows = json.loads(f.read_text())["data"]["rows"]
        for r in rows:
            captures += 1
            c = r.get("consistency") or {}
            if "prefix" in c:
                checked += 1
                prefix_ok += bool(c["prefix"])
                torn += c.get("complete_last_record") is False
            if r.get("freeze_s") is not None:
                freeze.append(r["freeze_s"])
            if r.get("stopped") is not None:
                stopped.append(r["stopped"])
            if r["method"] in ("rsync", "tar") and r.get("copy_s") and "run1" not in f.name:
                mbs.append(r["size_bytes"] / 1e6 / r["copy_s"])
                files_s.append(r["files"] / r["copy_s"])
            if r.get("host_states") != ["online"]:
                offline += 1
            if not (r.get("turn_after") or {}).get("ok"):
                turns_bad += 1
    print(json.dumps({
        "captures": captures,
        "snapshots_checked": checked,
        "prefix_ok": prefix_ok,
        "torn_last_record": torn,
        "freeze_s_min_max": [min(freeze), max(freeze)],
        "stopped_min_max": [min(stopped), max(stopped)],
        "full_copy_mb_s_min_max": [round(min(mbs), 1), round(max(mbs), 1)],
        "full_copy_files_s_min_max": [round(min(files_s)), round(max(files_s))],
        "captures_with_host_not_online": offline,
        "captures_with_failed_turn_after": turns_bad,
    }, indent=1))


if __name__ == "__main__":
    main()
