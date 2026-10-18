"""Find other files that hold a login file's secret values; print file names only (spike S6).

Reads the JSON login files given, collects every string value of 16 characters or more (tokens,
keys; timestamp fields excepted), and searches every regular file under the home directory, outside the given files, for any
of them, as raw bytes. Prints a JSON list of matching paths relative to home. Never prints a value,
a hash of a value, or a match position.

  python3 -I find_copies.py --home ~ ~/.claude/.credentials.json ~/.codex/auth.json ...
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

SKIP_DIRS = {".cache", "node_modules", ".npm", "proc"}
# Timestamps are not secrets, and the audits report them on purpose.
TIMESTAMP_KEYS = {"expiresAt", "refreshTokenExpiresAt", "last_refresh", "expires_at"}


def strings(value) -> list[str]:
    if isinstance(value, dict):
        return [s for k, v in value.items() if k not in TIMESTAMP_KEYS for s in strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in strings(v)]
    if isinstance(value, str) and len(value) >= 16:
        return [value]
    return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--max-bytes", type=int, default=64 << 20)
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    home = Path(a.home).resolve()
    sources = {Path(f).resolve() for f in a.files}
    needles: set[bytes] = set()
    for f in sources:
        try:
            needles.update(s.encode() for s in strings(json.loads(f.read_bytes())))
        except (FileNotFoundError, ValueError):
            continue
    hits: list[str] = []
    scanned = 0
    if needles:
        for dirpath, dirnames, filenames in os.walk(home):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                p = Path(dirpath) / name
                if p.resolve() in sources or p.is_symlink() or not p.is_file():
                    continue
                try:
                    if p.stat().st_size > a.max_bytes:
                        continue
                    data = p.read_bytes()
                except OSError:
                    continue
                scanned += 1
                if any(n in data for n in needles):
                    hits.append(str(p.relative_to(home)))
    print(json.dumps({"secret_values_checked": len(needles), "files_scanned": scanned, "files_holding_a_copy": sorted(hits)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
