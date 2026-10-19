"""Run the S3 measurements in order, each on a freshly started testbed.

  python3 spikes/s3/bench/run_all.py [step ...]

Steps (default: all, in this order): capture, capture2phase, lease, upload,
longpause, restore, runners, freeze-sigstop, freeze-cgroup. Logs go to
/tmp/cfo-s3-<step>.log; raw results to spikes/s3/results/.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

STEPS: dict[str, list[list[str]]] = {
    "capture": [["up.py"], ["capture_bench.py", "--profiles", "small,realistic,large,many-small", "--runs", "5"]],
    "capture2phase": [["up.py"], ["capture_bench.py", "--plan", "2phase", "--profiles", "realistic,large,many-small", "--runs", "5"]],
    "capture-corrected": [["up.py"], ["capture_bench.py", "--plan", "corrected", "--profiles", "realistic,large,many-small", "--runs", "5"]],
    "capture-reflink": [["up.py"], ["capture_bench.py", "--plan", "reflink", "--profiles", "realistic,large", "--runs", "5"]],
    "lease": [["up.py"], ["lease_tests.py", "--runs", "3"]],
    "upload": [["up.py"], ["upload_tests.py", "--block", "120", "--runs", "2"]],
    "longpause": [["up.py"], ["long_pause.py", "--budgets", "30,60,100"]],
    "restore": [["up.py"], ["restore_sessions.py", "--runs", "3"]],
    "runners": [["up.py", "--idle", "60"], ["runner_count.py", "--sessions", "6", "--runs", "3"]],
    "freeze-sigstop": [["up.py"], ["freeze_compare.py", "sigstop", "5"]],
    "freeze-cgroup": [["up.py", "--freezer", "cgroup"], ["freeze_compare.py", "cgroup", "5"]],
}


def main() -> None:
    steps = sys.argv[1:] or list(STEPS)
    for step in steps:
        log = Path(f"/tmp/cfo-s3-{step}.log")
        t0 = time.monotonic()
        rc = 0
        with log.open("w") as fh:
            for argv in STEPS[step]:
                rc = subprocess.run([sys.executable, "-u", str(HERE / argv[0]), *argv[1:]], stdout=fh,
                                    stderr=subprocess.STDOUT).returncode
                if rc != 0:
                    break
        print(f"{step}: exit {rc} in {time.monotonic() - t0:.0f} s (log {log})", flush=True)


if __name__ == "__main__":
    main()
