"""Test setup: the spike's scripts, probe and echo server are plain files, not a package."""

import sys
from pathlib import Path

X1 = Path(__file__).resolve().parents[1]
for sub in ("scripts", "computer", "server"):
    path = str(X1 / sub)
    if path not in sys.path:
        sys.path.insert(0, path)
