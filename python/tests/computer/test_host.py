"""Start attempts, host restarts with the same token, and parking on "token refused" (ST-01).

Through the supervisor's real receiver, with a stand-in for ``omnigent host`` that records the
identity it was started with (the token only as a hash) and exits with the code a test asks
for. Covers G1BR-005's attempt rules, FH-30 (77 parks the host), FH-33 (any other exit restarts
it with the same token) and "never restarted while live".
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import time
from pathlib import Path

import pytest
from cfo_computer.supervisor import Tools
from harness import FAKES, Rig, canary, scan_for

FAKE_HOST = r"""#!/usr/bin/env python3
import hashlib, json, os, sys, time
home = os.environ["HOME"]
with open(os.path.join(home, "host-runs.jsonl"), "a") as fh:
    fh.write(json.dumps({
        "pid": os.getpid(),
        "argv": sys.argv[1:],
        "host_id": os.environ.get("OMNIGENT_HOST_ID"),
        "host_name": os.environ.get("OMNIGENT_HOST_NAME"),
        "token_sha256": hashlib.sha256(
            os.environ.get("OMNIGENT_HOST_TOKEN", "").encode()
        ).hexdigest(),
        "env_keys": sorted(os.environ),
    }) + "\n")
control = os.path.join(home, "host-exit")
while True:
    try:
        code = int(open(control).read())
    except (OSError, ValueError):
        time.sleep(0.02)
        continue
    os.unlink(control)
    sys.exit(code)
"""

FAKE_PYTHON = r"""#!/usr/bin/env python3
# Stands in for Omnigent's interpreter running render_host_config_write_command.
import os, sys
data = sys.stdin.read()
os.makedirs(os.path.join(os.environ["HOME"], ".omnigent"), exist_ok=True)
open(os.path.join(os.environ["HOME"], ".omnigent", "host-config.json"), "w").write(data)
"""


def _script(path: Path, text: str) -> str:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


@pytest.fixture
def rig(tmp_path: Path):
    tools = Tools(
        omnigent=_script(tmp_path / "fake-omnigent", FAKE_HOST),
        venv_python=_script(tmp_path / "fake-python", FAKE_PYTHON),
        claude=str(FAKES / "claude"),
        codex=str(FAKES / "codex"),
    )
    rig = Rig(tmp_path / "a", tools=tools, host_backoff=lambda n: 0.05)
    rig.sup.runner_processes = lambda: 0  # never classify this machine's own processes
    yield rig
    rig.close()


def _runs(rig: Rig) -> list[dict]:
    path = rig.home / "host-runs.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def _until(predicate, timeout: float = 10.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("timed out")


def _start(rig: Rig, attempt: int, token: str, op: str | None = None) -> str:
    reply = rig.ok(
        "start_host",
        op=op,
        startAttempt=attempt,
        hostId="7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f",
        hostName="Work computer",
        token=token,
        hostConfig={"runner": {"idle_timeout_s": 600}},
    )
    return reply["outcome"]


def _exit(rig: Rig, code: int) -> None:
    (rig.home / "host-exit").write_text(str(code))


def test_attempt_rules_and_the_host_started_once_after_both_restores(rig: Rig) -> None:
    token = canary("launch").replace("-", "_")
    assert _start(rig, 1, token) == "declined"  # before the restores
    assert rig.restore()["state"] == "done"
    assert _start(rig, 1, token) == "declined"  # declined for good, in any delivery
    rig.install()
    assert _start(rig, 2, token) == "taken"
    _until(lambda: len(_runs(rig)) == 1)
    run = _runs(rig)[0]
    assert (
        run["host_id"] == "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f" and run["host_name"] == "Work computer"
    )
    assert run["token_sha256"] == hashlib.sha256(token.encode()).hexdigest()
    assert run["argv"] == [
        "host",
        "--server",
        "http://omnigent.internal",
        "--no-open",
        "--non-interactive",
    ]
    assert token not in json.dumps(run["argv"])
    # The workload's environment is an allowlist: nothing of the supervisor's leaks in.
    assert not any(
        k.startswith(("OMNIGENT_GITHUB_APP", "OMNIGENT_DATABRICKS", "OMNIGENT_CREDENTIAL", "CFO_"))
        for k in run["env_keys"]
    )
    assert json.loads((rig.home / ".omnigent" / "host-config.json").read_text()) == {
        "runner": {"idle_timeout_s": 600}
    }
    assert _start(rig, 2, token) == "taken"  # a repeat of the taken attempt
    assert _start(rig, 1, token) == "superseded"  # an older one
    assert _start(rig, 3, canary("other")) == "refused_live_host"  # a newer one while live
    time.sleep(0.3)
    assert len(_runs(rig)) == 1, "never restarted while live, never a second host"
    assert rig.ok("status")["report"]["host"] == {
        "state": "running",
        "startAttempt": 2,
        "restarts": 0,
    }
    # The token is never written anywhere by the supervisor.
    assert scan_for([token], rig.root) == []


@pytest.mark.parametrize("code", [0, 1, 78, 143, 137])
def test_a_host_that_exits_is_restarted_with_the_same_token(rig: Rig, code: int) -> None:
    rig.boot()
    token = canary("launch")
    assert _start(rig, 1, token) == "taken"
    _until(lambda: len(_runs(rig)) == 1)
    if code == 137:
        os.kill(_runs(rig)[0]["pid"], 9)
    else:
        _exit(rig, code)
    _until(lambda: len(_runs(rig)) == 2)
    first, second = _runs(rig)
    assert second["token_sha256"] == first["token_sha256"] and second["pid"] != first["pid"]
    _until(lambda: rig.ok("status")["report"]["host"]["restarts"] == 1)
    assert rig.ok("status")["report"]["host"]["state"] == "running"


def test_token_refused_parks_the_host_and_only_a_newer_attempt_starts_it(rig: Rig) -> None:
    rig.boot()
    assert _start(rig, 1, canary("old")) == "taken"
    _until(lambda: len(_runs(rig)) == 1)
    _exit(rig, 77)
    _until(lambda: rig.ok("status")["report"]["host"]["state"] == "refused")
    time.sleep(0.3)
    assert len(_runs(rig)) == 1, "a refused host is never restarted by the supervisor"
    assert _start(rig, 1, canary("old")) == "taken"  # the old attempt: recorded answer, no start
    new = canary("new")
    assert _start(rig, 2, new) == "taken"
    _until(lambda: len(_runs(rig)) == 2)
    assert _runs(rig)[1]["token_sha256"] == hashlib.sha256(new.encode()).hexdigest()
    assert rig.ok("status")["report"]["host"] == {
        "state": "running",
        "startAttempt": 2,
        "restarts": 0,
    }
