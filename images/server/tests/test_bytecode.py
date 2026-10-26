"""The image ships compiled bytecode for everything the server imports (WP2.6).

Without it, and with ``PYTHONDONTWRITEBYTECODE``, Python compiled Omnigent's sources at every
start: most of a minute of a 1 GB start on ``basic`` (WP2.5). These run inside the image's
``test`` target, which is the runtime stage plus the tests.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOTS = (
    Path("/opt/venv"),
    Path("/build/omnigent"),
    Path("/opt/cfo/cfo_server"),
    Path("/opt/cfo/cloudflare_omnigent"),
    Path("/app"),
)
in_image = pytest.mark.skipif(
    not all(root.exists() for root in ROOTS), reason="runs inside the server image"
)
#: py_compile's flags for a hash-based .pyc whose source is checked at import (PEP 552).
CHECKED_HASH = 0b11


#: The runtime stage's sources, listed by the test stage before it installs the test tools.
LISTED = Path("/opt/runtime-python-sources.txt")


def _sources() -> list[Path]:
    if LISTED.exists():
        return [Path(line) for line in LISTED.read_text().splitlines() if line]
    return sorted(p for root in ROOTS for p in root.rglob("*.py") if "__pycache__" not in p.parts)


@in_image
def test_every_module_has_a_current_hash_checked_pyc() -> None:
    sources = _sources()
    assert len(sources) > 3000  # Omnigent and its dependencies, not an empty tree
    missing, stale = [], []
    for source in sources:
        pyc = Path(importlib.util.cache_from_source(str(source)))
        if not pyc.exists():
            missing.append(source)
            continue
        header = pyc.read_bytes()[:16]
        flags = int.from_bytes(header[4:8], "little")
        if (
            header[:4] != importlib.util.MAGIC_NUMBER
            or flags != CHECKED_HASH
            or header[8:16] != importlib.util.source_hash(source.read_bytes())
        ):
            stale.append(source)
    assert not missing, missing[:10]
    assert not stale, stale[:10]


@in_image
def test_the_server_imports_from_bytecode_and_writes_none() -> None:
    import omnigent.server.app

    import cfo_server.app

    assert sys.flags.dont_write_bytecode  # nothing is written at run time
    for module in (cfo_server.app, omnigent.server.app):
        assert module.__cached__ and Path(module.__cached__).exists()
