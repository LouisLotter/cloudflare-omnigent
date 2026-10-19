"""Copy S6's audited credential policy into the S3 image build context.

S6's ``spikes/s6/credsync/core.py`` is the single source of the credential
filename families (declared files, temporary siblings, provisional device keys,
lock files). Docker can only copy files from inside its build context, so this
copies it to ``spikes/s3/image/s6credsync/core.py`` (gitignored) before every
build. A test in the image checks that the copy matches the repository file.

  python3 spikes/s3/bench/sync_policy.py
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "spikes" / "s6" / "credsync" / "core.py"
DST = ROOT / "spikes" / "s3" / "image" / "s6credsync" / "core.py"


def sync() -> str:
    DST.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SRC, DST)
    digest = hashlib.sha256(SRC.read_bytes()).hexdigest()
    (DST.parent / "SOURCE_SHA256").write_text(digest + "\n")
    return digest


if __name__ == "__main__":
    print(f"synced {SRC.relative_to(ROOT)} -> {DST.relative_to(ROOT)} sha256 {sync()}")
