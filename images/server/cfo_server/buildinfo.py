"""What this image was built from (AIR2-007 at artifact scope).

The Dockerfile writes ``/opt/cfo/build.json`` in its runtime stage: the fork repository and the
full commit ID its Omnigent was built from (BuildKit fetched exactly that commit), and the
Litestream binary's own version. The entrypoint reports it in ``GET /status`` (``build``) and in
its boot log line; the image labels carry the same commit. ``python -m cfo_server.buildinfo``
checks the file at build time.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BUILD_INFO_PATH = Path("/opt/cfo/build.json")
_COMMIT = re.compile(r"[0-9a-f]{40}")
_FIELDS = ("omnigentRepo", "omnigentCommit", "litestream")


def load(path: Path = BUILD_INFO_PATH) -> dict[str, str] | None:
    """The build's record, or ``None`` when there is none or it is not well formed."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not all(isinstance(data.get(f), str) for f in _FIELDS):
        return None
    if not _COMMIT.fullmatch(data["omnigentCommit"]):
        return None
    return {field: data[field] for field in _FIELDS}


def main() -> int:
    info = load()
    if info is None:
        print(f"no well-formed build record at {BUILD_INFO_PATH}", file=sys.stderr)
        return 1
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
