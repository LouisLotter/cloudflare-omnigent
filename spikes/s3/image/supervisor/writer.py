"""A busy workload process for the capture tests: writes a record every 10 ms.

Each record is "<seq> <wall time>\\n" appended to <path>. A consistent capture
holds a prefix of the live file that ends on a complete record; the largest gap
between consecutive wall times shows how long the writer was paused.
"""

from __future__ import annotations

import sys
import time


def main() -> None:
    path = sys.argv[1]
    seq = 0
    with open(path, "a", buffering=1) as fh:
        while True:
            # Two writes per record, so a capture that is not paused could
            # catch a torn record.
            fh.write(f"{seq} ")
            fh.flush()
            fh.write(f"{time.time():.6f}\n")
            seq += 1
            time.sleep(0.01)


if __name__ == "__main__":
    main()
