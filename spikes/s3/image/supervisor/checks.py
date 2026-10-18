"""Consistency check for a capture of the writer's log.

  python -m supervisor.checks <live writer.log> <snapshot writer.log>

Prints JSON: whether the snapshot is a prefix of the live file ending on a
complete record, and the longest gap between records in the live file around
the snapshot's last record (the writer's observed pause).
"""

from __future__ import annotations

import json
import sys


def gaps(path: str, since: float) -> None:
    """Longest pause of the writer after wall time `since`."""
    best = (0.0, 0.0)
    prev = None
    for ln in open(path, "rb").read().decode().splitlines():
        parts = ln.split()
        if len(parts) != 2:
            continue
        t = float(parts[1])
        if prev is not None and t >= since and t - prev > best[0]:
            best = (t - prev, prev)
        prev = t
    print(json.dumps({"max_gap_s": round(best[0], 3), "gap_start": best[1], "last_record": prev}))


def main() -> None:
    if sys.argv[1] == "gaps":
        gaps(sys.argv[2], float(sys.argv[3]))
        return
    live = open(sys.argv[1], "rb").read()
    snap = open(sys.argv[2], "rb").read()
    prefix = live.startswith(snap)
    complete = snap.endswith(b"\n")
    lines = snap.decode().splitlines()
    last_seq = int(lines[-1].split()[0]) if lines else -1
    # Gap in the live file right after the snapshot's last record.
    recs = [ln.split() for ln in live.decode().splitlines() if len(ln.split()) == 2]
    times = {int(s): float(t) for s, t in recs}
    gap = None
    if last_seq in times and last_seq + 1 in times:
        gap = round(times[last_seq + 1] - times[last_seq], 3)
    seqs = [int(s) for s, _ in recs]
    contiguous = seqs == list(range(seqs[0], seqs[0] + len(seqs))) if seqs else True
    print(json.dumps({"prefix": prefix, "complete_last_record": complete, "last_seq": last_seq,
                      "gap_after_snapshot_s": gap, "live_contiguous": contiguous}))


if __name__ == "__main__":
    main()
