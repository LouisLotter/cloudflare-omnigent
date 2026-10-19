"""Host tunnel diagnosis from S1's staging logs (fetch-logs.mjs output).

1. Cadence: for each run, the gaps between the tunnel upgrades seen at HostRoute, and the median
   gap by position. The host (Omnigent v0.17.0, websockets 14.2) reconnects every 0.5 s after a
   tunnel that opened and then dropped (a "recycle", for a non-loopback server URL), but backs
   off 0.5 s, about 1-1.5 s, then 3 s when the handshake itself fails.
2. Closes: the ws-close lines (who closed the bridge, the code and the reason) by kind, and the
   time from the bridge's creation to the host side's close.

  python3 -I spikes/s1/scripts/tunnel-gaps.py spikes/s1/results/staging-s1-*.jsonl
"""

import json
import statistics
import sys
from collections import Counter, defaultdict

for path in sys.argv[1:]:
    runs = defaultdict(list)
    closes = Counter()
    host_close_ms = []
    for line in open(path):
        d = json.loads(line)
        if d["s1"] == "ws-upgrade":
            runs[d.get("run")].append(d["wt"])
        elif d["s1"] == "ws-close":
            closes[(d.get("side"), d.get("code"), d.get("reason"))] += 1
            if d.get("side") == "host":
                host_close_ms.append(d["ms"])
    by_position = defaultdict(list)
    used = 0
    for stamps in runs.values():
        stamps.sort()
        if len(stamps) < 6:
            continue
        used += 1
        for i in range(1, min(len(stamps), 12)):
            by_position[i].append((stamps[i] - stamps[i - 1]) / 1000)
    print(path.rsplit("/", 1)[-1])
    print(f"  upgrades: {sum(len(v) for v in runs.values())} in {len(runs)} runs ({used} with 6 or more)")
    print("  median gap by position, s:", [round(statistics.median(by_position[i]), 2) for i in sorted(by_position)])
    if closes:
        for (side, code, reason), n in closes.most_common():
            print(f"  ws-close side={side} code={code} reason={reason!r}: {n}")
        host_close_ms.sort()
        n = len(host_close_ms)
        print(
            f"  host-side close after the bridge opened, ms: min {host_close_ms[0]}, "
            f"p50 {host_close_ms[n // 2]}, p95 {host_close_ms[int(n * 0.95)]}, max {host_close_ms[-1]}"
        )
