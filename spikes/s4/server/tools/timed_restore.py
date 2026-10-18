"""Time a plain ``litestream restore`` of the replica into a scratch path.

Runs in a fresh container from the server image (no server, no replication),
so the number is restore alone: listing, download and apply. Then checks the
result with dbcheck.
"""

from __future__ import annotations

import json
import os
import subprocess
import time

from dbcheck import check

OUT = "/tmp/restore/omnigent.db"


def main() -> None:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    t0 = time.monotonic()
    proc = subprocess.run(
        ["litestream", "restore", "-config", "/etc/litestream.yml", "-o", OUT,
         os.environ.get("S4_DB_PATH", "/data/db/omnigent.db")],
        capture_output=True, text=True, check=False,
    )
    restore_s = time.monotonic() - t0
    result = {"restore_s": round(restore_s, 3), "exit": proc.returncode,
              "stderr_tail": proc.stderr.strip().splitlines()[-3:]}
    if proc.returncode == 0:
        result["check"] = check(OUT)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
