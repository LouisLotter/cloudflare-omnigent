"""Exit 0 once a record of the given kind appears in the spike's Workers Logs.

    python3 -I spikes/s2/scripts/wait_for.py <kind> <since-ms> <timeout-s>
"""

from __future__ import annotations

import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from collect import extract, query  # noqa: E402


def main() -> None:
    kind, since, timeout = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
    deadline = time.time() + timeout
    while time.time() < deadline:
        now = int(time.time() * 1000)
        try:
            for event in query(max(since, now - 600_000), now, None):
                record = extract(event) or {}
                inner = record.get("r") if isinstance(record.get("r"), dict) else record
                if kind in (inner.get("k"), inner.get("s2")):
                    print(f"found {kind} at {inner.get('ct') or inner.get('t')}")
                    return
        except Exception as error:  # noqa: BLE001 - keep waiting
            print(f"query failed: {error}", file=sys.stderr)
        time.sleep(20)
    print(f"no {kind} within {timeout:.0f} s")
    sys.exit(1)


if __name__ == "__main__":
    main()
