"""Build the spike image and run the capture tests inside it.

The tests pause and resume real processes, mount nothing on the host and
signal nothing outside their own container. The container is privileged for
the cgroup-freezer case and for choosing the next PID (the PID-reuse control).

  python3 spikes/s3/bench/run_tests.py [--label before|after] [pytest args...]

Writes spikes/s3/results/tests-<label>.txt when --label is given.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time

from common import RESULTS, ROOT, SPIKE
from prepare_staging import prepare

IMAGE = "cfo-s3-computer:spike"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label")
    args, rest = ap.parse_known_args()
    digest = prepare()["s6_policy_sha256"]
    b = subprocess.run(["docker", "build", "-q", "-t", IMAGE, str(SPIKE / "image")], capture_output=True, text=True)
    if b.returncode != 0:
        print(b.stderr[-3000:])
        return b.returncode
    cmd = [
        "docker", "run", "--rm", "--privileged", "--init",
        "--tmpfs", "/mnt/tmpfs:size=64m", "--tmpfs", "/mnt/small:size=8m",
        "-e", "PYTHONPATH=/opt/s3", "-e", f"S3_S6_SHA256={digest}",
        "--entrypoint", "/opt/s3venv/bin/python", IMAGE,
        "-m", "pytest", "-p", "no:cacheprovider", "-rA", "--tb=short", "/opt/s3/tests", *rest,
    ]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    out = p.stdout + p.stderr
    print(out[-12000:])
    if args.label:
        RESULTS.mkdir(parents=True, exist_ok=True)
        head = (f"# spike S3 tests, label {args.label}\n# {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t0))}"
                f"\n# image {b.stdout.strip()}\n# S6 policy sha256 {digest}\n# exit {p.returncode}\n")
        path = RESULTS / f"tests-{args.label}.txt"
        path.write_text(head + out)
        print(f"wrote {path.relative_to(ROOT)}")
    return p.returncode


if __name__ == "__main__":
    sys.exit(main())
