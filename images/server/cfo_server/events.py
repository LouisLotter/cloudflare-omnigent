"""Structured log lines: one JSON object per line on stderr, ``{"event": "cfo.<name>", ...}``.

Workers Logs collects the container's output. Request paths are logged without query
strings, and no line carries a credential: callers pass positions, reasons and table names.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any


def log(event: str, **fields: Any) -> None:
    fields["event"] = f"cfo.{event}"
    fields["t"] = round(time.time(), 3)
    sys.stderr.write(json.dumps(fields, sort_keys=True, default=str) + "\n")
    sys.stderr.flush()
