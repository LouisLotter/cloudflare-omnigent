"""The image's own tests: run inside the image's test variant, as root.

    docker build -f images/computer/Dockerfile --target test -t cfo-computer:test .
    docker run --rm cfo-computer:test                     (everything but the cgroup case)
    docker run --rm --privileged cfo-computer:test        (also the cgroup freezer)

They reuse the supervisor harness from python/tests/computer, and need what only the image
has: Omnigent's interpreter at /opt/venv, the pinned CLIs, tini, and the test variant's fakes.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "images" / "computer"))
sys.path.insert(0, str(REPO / "python" / "tests" / "computer"))

IN_IMAGE = Path("/opt/venv/bin/omnigent").exists() and Path("/opt/cfo/contracts").exists()


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if IN_IMAGE and os.geteuid() == 0:
        return
    skip = pytest.mark.skip(reason="runs inside the computer image's test variant, as root")
    here = Path(__file__).resolve().parent
    for item in items:
        if Path(str(item.fspath)).resolve().is_relative_to(here):
            item.add_marker(skip)
