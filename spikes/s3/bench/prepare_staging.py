"""Prepare the S3 image's build context: the parts Docker cannot fetch itself.

1. S6's audited credential policy (``sync_policy.sync``).
2. Omnigent's own mock LLM server, from the fork at ``OMNIGENT_COMMIT``, into
   ``spikes/s3/image/mockllm/`` (gitignored). The staging container runs it
   beside the server, so the CLIs and Omnigent's runners need no internet.
3. The Omnigent base image, built from the fork at ``OMNIGENT_COMMIT`` with the
   fork's own Dockerfile (target ``runtime``) and tagged
   ``cfo-s3/omnigent-server:<short commit>``, unless that tag exists. S4 built
   its base the same way. The published images predate the core changes
   (12 to 19), so the spike image builds on this one.

The fork checkout is only read: ``git archive`` and ``git show``.

  python3 spikes/s3/bench/prepare_staging.py [--fork <checkout>] [--rebuild]
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

from sync_policy import sync

ROOT = Path(__file__).resolve().parents[3]
IMAGE_DIR = ROOT / "spikes" / "s3" / "image"
# cfo/integration of LouisLotter/omnigent, the build the work packages use.
OMNIGENT_COMMIT = "af3e49de2b169a8593e2d91e7ab98e2581f9f90a"
BASE_TAG = f"cfo-s3/omnigent-server:{OMNIGENT_COMMIT[:9]}"
MOCK_PATH = "tests/server/integration/mock_llm_server.py"
MOCK_SHA256 = "5dfa10f751cc30ca66094eb27da298ae609cc8d08132f3d77516cefd92c41fd2"
DEFAULT_FORK = Path(os.environ.get("S3_OMNIGENT_FORK", "/home/decay/Lervent/omnigent-wt/integration"))
BUILD_DIR = Path(os.environ.get("S3_BUILD_DIR", Path.home() / ".cache" / "cfo-s3-build"))


def git(fork: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(fork), *args], check=True, capture_output=True).stdout


def sync_mock(fork: Path) -> str:
    data = git(fork, "show", f"{OMNIGENT_COMMIT}:{MOCK_PATH}")
    digest = hashlib.sha256(data).hexdigest()
    if digest != MOCK_SHA256:
        raise SystemExit(f"{MOCK_PATH} at {OMNIGENT_COMMIT[:9]} has sha256 {digest}, expected {MOCK_SHA256}")
    dst = IMAGE_DIR / "mockllm"
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "mock_llm_server.py").write_bytes(data)
    (dst / "SOURCE").write_text(f"{OMNIGENT_COMMIT} {MOCK_PATH} sha256 {digest}\n")
    return digest


def image_id(tag: str) -> str | None:
    p = subprocess.run(["docker", "image", "inspect", tag, "--format", "{{.Id}}"], capture_output=True, text=True)
    return p.stdout.strip() if p.returncode == 0 else None


def build_base(fork: Path, rebuild: bool) -> str:
    existing = image_id(BASE_TAG)
    if existing and not rebuild:
        return existing
    ctx = BUILD_DIR / f"omnigent-{OMNIGENT_COMMIT[:9]}"
    if ctx.exists():
        shutil.rmtree(ctx)
    ctx.mkdir(parents=True)
    archive = subprocess.Popen(["git", "-C", str(fork), "archive", "--format=tar", OMNIGENT_COMMIT],
                               stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", str(ctx)], stdin=archive.stdout, check=True)
    if archive.wait() != 0:
        raise SystemExit("git archive failed")
    subprocess.run(["docker", "build", "-f", str(ctx / "deploy" / "docker" / "Dockerfile"), "--target", "runtime",
                    "-t", BASE_TAG, str(ctx)], check=True)
    shutil.rmtree(ctx)
    built = image_id(BASE_TAG)
    assert built
    return built


def prepare(fork: Path = DEFAULT_FORK, rebuild: bool = False) -> dict[str, str]:
    """Everything the image build needs; returns the digests and the base image ID."""
    git(fork, "cat-file", "-e", f"{OMNIGENT_COMMIT}^{{commit}}")
    return {"s6_policy_sha256": sync(), "mock_sha256": sync_mock(fork), "base_image": build_base(fork, rebuild)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fork", type=Path, default=DEFAULT_FORK)
    ap.add_argument("--rebuild", action="store_true", help="rebuild the Omnigent base image")
    args = ap.parse_args()
    out = prepare(args.fork, args.rebuild)
    print(f"S6 policy sha256 {out['s6_policy_sha256']}")
    print(f"mock LLM {MOCK_PATH} sha256 {out['mock_sha256']}")
    print(f"base image {BASE_TAG} {out['base_image']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
