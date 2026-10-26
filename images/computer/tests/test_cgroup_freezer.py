"""The cgroup v2 freezer, where the cgroup filesystem is writable (Cloudflare: yes, S3).

Needs ``docker run --privileged`` locally; skipped otherwise. A workload process and a child it
forks after joining are in a test cgroup; the capture freezes it through the guard, copies, and
thaws it.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from harness import Rig

ROOT = Path("/sys/fs/cgroup")


def _writable() -> bool:
    try:
        probe = ROOT / f"cfo-probe-{os.getpid()}"
        probe.mkdir()
        probe.rmdir()
        return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not _writable(), reason="cgroupfs is not writable here")


def test_capture_freezes_the_workload_cgroup(tmp_path: Path) -> None:
    group = ROOT / f"cfo-test-{os.getpid()}"
    group.mkdir()
    try:
        proc = subprocess.Popen(
            [
                "/bin/sh",
                "-c",
                f'echo $$ > "{group}/cgroup.procs" && exec {sys.executable} '
                '-c "import time\nwhile True: time.sleep(0.01)"',
            ],
        )
        time.sleep(0.3)
        rig = Rig(tmp_path / "a", cgroup_dir=str(group))
        try:
            rig.boot()
            op, job = rig.capture()
            assert job["state"] == "staged", job
            result = rig.result(op)
            assert result["mechanism"] == "cgroup" and result["guard"] == "released"
            assert (group / "cgroup.freeze").read_text().strip() == "0"
            assert "frozen 0" in (group / "cgroup.events").read_text()
        finally:
            rig.close()
            proc.kill()
            proc.wait()
    finally:
        time.sleep(0.1)
        group.rmdir()


def test_the_supervisor_uses_the_cgroup_only_when_a_process_can_join_it() -> None:
    from cfo_computer import main

    group = Path(main.WORKLOAD_CGROUP)
    existed = group.exists()
    try:
        assert main.workload_cgroup() == str(group)
        assert (group / "cgroup.procs").read_text().strip() == ""  # the probe has exited
    finally:
        if not existed:
            group.rmdir()
