"""Follow the spike's Workers Logs while it runs: one compact line per notable record.

    python3 -I spikes/s2/scripts/watch.py [kinds,comma,separated]

Polls the read-only telemetry API every 30 s over the last 3 minutes and prints records not
seen before. Routine records (pings, per-request route lines) are left out unless named.
"""

from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from collect import extract, query, secrets  # noqa: E402

QUIET = {"route", "server-wake", "computer-wake", "echo-minute", "dns", "route-http"}


def main() -> None:
    extra = set(sys.argv[1].split(",")) if len(sys.argv) > 1 else set()
    pairs = secrets()
    seen: set[str] = set()
    while True:
        now = int(time.time() * 1000)
        try:
            events = query(now - 180_000, now, None)
        except Exception as error:  # noqa: BLE001 - keep watching
            print(f"watch: query failed: {error}", flush=True)
            time.sleep(30)
            continue
        fresh = []
        for event in events:
            key = (event.get("$metadata") or {}).get("id") or json.dumps(event, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            record = extract(event)
            if record is None:
                continue
            inner = record.get("r") if isinstance(record.get("r"), dict) else record
            kind = inner.get("k") or inner.get("s2")
            if kind in QUIET and kind not in extra:
                continue
            if record.get("s2") is None and "k" in record:
                continue  # stdout copy of a report; the route copy is printed instead
            fresh.append((inner.get("ct") or inner.get("t") or 0, kind, inner))
        for when, kind, inner in sorted(fresh, key=lambda x: x[0]):
            body = {k: v for k, v in inner.items() if k not in ("k", "s2", "ct", "t", "boot")}
            line = f"{time.strftime('%H:%M:%S', time.gmtime(when / 1000))} {kind} {json.dumps(body)[:220]}"
            for value, mask in pairs:
                line = line.replace(value, mask)
            print(line, flush=True)
        time.sleep(30)


if __name__ == "__main__":
    main()
