"""IR-014: the local owner session's cleanup must never report a verified sign-out, or remove the
recovery material, when it cannot tell whether a login remains.

The real `session_local.main(["--cleanup"])` runs against a fake Docker CLI (subprocess.run is
replaced), so every scenario exercises the actual cleanup code paths: a stopped store, a failing
Docker lookup, missing or unreadable store configuration after a sign-in attempt, a verified
sign-out, and a session that provably never reached sign-in.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

S6 = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(S6 / "owner"))

import session_local as sl  # noqa: E402


class FakeDocker:
    """Just enough of the docker CLI for cleanup: ps, inspect, rm, network, run, exec."""

    def __init__(self, *, minio: str = "running", broken_lookups: bool = False,
                 signed_out_after_restore: bool = True, computers: dict | None = None, capture_rc: int = 0):
        self.minio = minio  # "running" | "stopped" | "absent"
        self.broken_lookups = broken_lookups
        self.signed_out_after_restore = signed_out_after_restore
        self.computers = dict(computers or {})  # name -> running
        self.capture_rc = capture_rc
        self.network = True
        self.calls: list[list[str]] = []

    def __call__(self, args, capture_output=True, text=True, **kw):
        args = list(args)
        self.calls.append(args)
        out, rc = "", 0
        if args[:1] != ["docker"]:
            return subprocess.CompletedProcess(args, 0, "", "")
        cmd = args[1:]
        if self.broken_lookups and cmd[0] in ("ps", "inspect", "network"):
            return subprocess.CompletedProcess(args, 1, "", "Cannot connect to the Docker daemon")
        if cmd[0] == "ps":
            filt = cmd[cmd.index("--filter") + 1]
            if sl.MINIO in filt:
                show_all = "-aq" in cmd or "-a" in cmd
                if self.minio == "running" or (show_all and self.minio == "stopped"):
                    out = "f00d"
            else:
                out = "\n".join(self.computers)
        elif cmd[0] == "inspect":
            out = "true" if self.computers.get(cmd[-1]) else "false"
        elif cmd[:2] == ["rm", "-f"]:
            if cmd[2] == sl.MINIO:
                self.minio = "absent"
            self.computers.pop(cmd[2], None)
        elif cmd[:2] == ["network", "rm"]:
            self.network = False
        elif cmd[:2] == ["network", "ls"]:
            out = "n1" if self.network else ""
        elif cmd[0] == "run" and "-d" in cmd:
            self.computers[cmd[cmd.index("--name") + 1]] = True
        elif cmd[0] == "exec":
            action = cmd[4] if len(cmd) > 4 and cmd[2:4] == ["bash", "/opt/s6/owner/inner.sh"] else cmd[2]
            if action == "start-generation":
                out = "generation 7"
            elif action == "capture":
                rc = self.capture_rc
            elif action == "signed-out-check":
                rc = 0 if self.signed_out_after_restore else 1
                out = json.dumps({"claude_logged_in": "false" if rc == 0 else "true"})
        return subprocess.CompletedProcess(args, rc, out, "")

    def removed_store(self) -> bool:
        return any(c[1:3] == ["rm", "-f"] and c[3:4] == [sl.MINIO] for c in self.calls if len(c) > 3)


@pytest.fixture
def world(tmp_path: Path, monkeypatch):
    shm = tmp_path / "shm"
    out = tmp_path / "out"
    shm.mkdir()
    out.mkdir()
    monkeypatch.setattr(sl, "SHM", shm)
    monkeypatch.setattr(sl, "OUT", out)
    monkeypatch.setattr(sl.time, "sleep", lambda s: None)
    monkeypatch.setattr(sl.signal, "signal", lambda *a: None)

    def setup(docker: FakeDocker, *, s3: str | None = "ok", marker: str | None = "signin-attempted"):
        monkeypatch.setattr(sl.subprocess, "run", docker)
        if s3 == "ok":
            (shm / "s3.json").write_text(json.dumps({"user": "u", "password": "p"}))
        elif s3 == "corrupt":
            (shm / "s3.json").write_text("{not json")
        if marker is not None:
            (out / "session-state.json").write_text(json.dumps({"phase": marker}))
        return shm, out

    return setup


def run_cleanup(monkeypatch, capsys) -> tuple[int, str]:
    monkeypatch.setattr(sys, "argv", ["session_local.py", "--cleanup"])
    rc = sl.main()
    return rc, capsys.readouterr().out


UNKNOWN = "revoke"  # the owner is told to revoke the account sessions


@pytest.mark.parametrize(
    "case, docker, s3",
    [
        ("stopped store after a sign-in attempt", dict(minio="stopped"), "ok"),
        ("missing store after a sign-in attempt", dict(minio="absent"), "ok"),
        ("Docker lookup failing", dict(broken_lookups=True), "ok"),
        ("store configuration missing after a sign-in attempt", dict(minio="running"), None),
        ("store configuration unreadable after a sign-in attempt", dict(minio="running"), "corrupt"),
    ],
)
def test_unknown_state_is_never_reported_as_signed_out(world, monkeypatch, capsys, case, docker, s3):
    d = FakeDocker(**docker)
    shm, _ = world(d, s3=s3)
    rc, out = run_cleanup(monkeypatch, capsys)
    assert rc != 0, case
    assert shm.exists(), f"{case}: recovery state was removed"
    assert not d.removed_store(), f"{case}: the store was removed"
    assert UNKNOWN in out.lower(), f"{case}: the owner was not told to revoke the sessions"


def test_control_verified_sign_out_removes_everything(world, monkeypatch, capsys):
    d = FakeDocker(minio="running", signed_out_after_restore=True)
    shm, _ = world(d, s3="ok")
    rc, out = run_cleanup(monkeypatch, capsys)
    assert rc == 0
    assert not shm.exists() and d.removed_store()


def test_control_store_up_but_still_signed_in_keeps_everything(world, monkeypatch, capsys):
    d = FakeDocker(minio="running", signed_out_after_restore=False)
    shm, _ = world(d, s3="ok")
    rc, out = run_cleanup(monkeypatch, capsys)
    assert rc != 0 and shm.exists() and not d.removed_store()


def test_control_session_that_never_reached_sign_in(world, monkeypatch, capsys):
    """Positive evidence of no sign-in (the session's own marker), even with the store gone."""
    d = FakeDocker(minio="stopped")
    shm, out_dir = world(d, s3="ok", marker="started")
    rc, out = run_cleanup(monkeypatch, capsys)
    assert rc == 0
    assert not shm.exists()
    assert "never" in out.lower()


@pytest.mark.parametrize("capture_rc, verified", [(3, True), (1, False)])
def test_running_computer_whose_restore_never_finished(world, monkeypatch, capsys, capture_rc, verified):
    """Interrupted before its restore finished: the gate refuses its capture (exit 3) and the
    checkpoint stays current, so recovery goes on from it. Any other capture failure keeps all."""
    d = FakeDocker(minio="running", computers={f"{sl.PREFIX}-b": True}, capture_rc=capture_rc)
    shm, _ = world(d, s3="ok")
    rc, out = run_cleanup(monkeypatch, capsys)
    assert (rc == 0) is verified
    assert shm.exists() is not verified
