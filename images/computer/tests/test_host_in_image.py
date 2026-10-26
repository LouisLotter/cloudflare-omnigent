"""The real Omnigent host under the supervisor, inside the image.

- ``start_host`` writes the host configuration through Omnigent's own server-managed merge
  (``render_host_config_write_command``), so ``runner.idle_timeout_s`` 600 is what Omnigent's
  runner reads (implementation plan, 3.4);
- the real ``omnigent host`` starts as the person's account with the identity and launch token
  in its environment only, never in its argv, and keeps running while its server is unreachable;
- a capture pauses it and everything it started, then resumes it.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest
from harness import FAKES, Rig, canary

from cfo_computer.paths import Account
from cfo_computer.supervisor import Tools


@pytest.fixture
def rig(tmp_path: Path):
    home = tmp_path / "a" / "home"
    home.mkdir(parents=True)
    os.chown(home, 1000, 1000)
    for parent in home.parents:  # pytest makes its directories 0700; the account must reach home
        if parent == Path("/"):
            break
        parent.chmod(parent.stat().st_mode | 0o011)
    tools = Tools(
        server_url="http://127.0.0.1:9", claude=str(FAKES / "claude"), codex=str(FAKES / "codex")
    )
    rig = Rig(tmp_path / "a", tools=tools)
    rig.sup.account = Account("omnigent", 1000, 1000, home)
    yield rig
    rig.close()


def _state(pid: int) -> str:
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]


def test_real_host_starts_with_its_identity_and_is_paused_by_a_capture(rig: Rig) -> None:
    rig.boot()
    token = canary("launch")
    reply = rig.ok(
        "start_host",
        startAttempt=1,
        hostId="0123456789abcdef0123456789abcdef",
        hostName="Image test computer",
        token=token,
        hostConfig={"runner": {"idle_timeout_s": 600}},
    )
    assert reply["outcome"] == "taken"
    end = time.monotonic() + 30
    while rig.sup.host.pid() is None and time.monotonic() < end:
        time.sleep(0.05)
    pid = rig.sup.host.pid()
    assert pid is not None
    time.sleep(3)
    assert rig.sup.host.pid() == pid, "the host keeps running while its server is unreachable"
    # Its configuration, through Omnigent's merge and Omnigent's own reader.
    idle = subprocess.run(
        [
            "/opt/venv/bin/python",
            "-I",
            "-c",
            "from omnigent.runner._entry import _load_runner_idle_timeout_s_from_config as f;"
            " print(f())",
        ],
        env={"HOME": str(rig.home), "PATH": "/opt/venv/bin:/usr/bin:/bin"},
        capture_output=True,
        text=True,
        check=True,
    )
    assert float(idle.stdout.strip()) == 600.0
    # Docker withholds CAP_SYS_PTRACE: read the host's environment as its own account.
    environ = subprocess.run(
        [
            "setpriv",
            "--reuid=1000",
            "--regid=1000",
            "--clear-groups",
            "cat",
            f"/proc/{pid}/environ",
        ],
        capture_output=True,
        check=True,
    ).stdout.split(b"\0")
    env = dict(item.decode().split("=", 1) for item in environ if b"=" in item)
    assert env["OMNIGENT_HOST_ID"] == "0123456789abcdef0123456789abcdef"
    assert (
        env["OMNIGENT_HOST_TOKEN"] == token
        and env["IS_SANDBOX"] == "1"
        and env["HOME"] == str(rig.home)
    )
    assert token.encode() not in Path(f"/proc/{pid}/cmdline").read_bytes()
    assert os.stat(f"/proc/{pid}").st_uid == 1000
    # A capture pauses the host's whole tree, then resumes it.
    rig.sup.scope_pids = [pid]
    op, job = rig.capture()
    assert job["state"] == "staged", job
    result = rig.result(op)
    assert (
        result["stopped"] >= 1 and result.get("stoppedByKind", {}).get("omnigent-host", 0) >= 1
    ), result
    assert _state(pid) != "T"
    assert rig.sup.host.pid() == pid, "never restarted while live"
