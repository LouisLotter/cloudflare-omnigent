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

    def setup(docker, *, s3: str | None = "ok", marker: str | None = "signin-attempted",
              session: str | None = "sess-1"):
        """The session's marker and its /dev/shm material carry the same session id, as the
        session writes them; session=None writes neither."""
        monkeypatch.setattr(sl.subprocess, "run", docker)
        if s3 == "ok":
            (shm / "s3.json").write_text(json.dumps({"user": "u", "password": "p"}))
        elif s3 == "corrupt":
            (shm / "s3.json").write_text("{not json")
        if session is not None:
            (shm / "session-id").write_text(session)
        if marker is not None:
            (out / "session-state.json").write_text(json.dumps({"phase": marker, "session": session}))
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


# ------------------------------------------------------------------ review s6-r3, findings 2 and 3
class LoginDocker:
    """A fake docker CLI with synthetic logins, for s6-r3 findings 2 and 3.

    - `homes`: each computer's login ids, kept while the container exists, running or stopped;
    - `checkpoint`: the login ids in the store's latest credential checkpoint;
    - `active`: the logins the provider still honours. Only a logout inside a computer revokes the
      logins in its home.
    A new computer (`docker run -d`) restores the checkpoint; `docker start` brings a stopped one
    back with its files; `docker exec` in a stopped computer fails, and a name in use makes
    `docker run` fail, as in Docker.
    """

    def __init__(self, *, store: str = "running", computers: dict | None = None, checkpoint=(),
                 active=(), start_fails: bool = False):
        self.store = store  # "running" | "stopped" | "absent"
        self.computers: dict[str, bool] = {}
        self.homes: dict[str, set] = {}
        for name, (running, logins) in (computers or {}).items():
            self.computers[name] = running
            self.homes[name] = set(logins)
        self.checkpoint = set(checkpoint)
        self.active = set(active)
        self.start_fails = start_fails
        self.calls: list[list[str]] = []

    def __call__(self, args, capture_output=True, text=True, **kw):
        args = list(args)
        self.calls.append(args)

        def ok(out=""):
            return subprocess.CompletedProcess(args, 0, out, "")

        def fail(rc=1, err="failed"):
            return subprocess.CompletedProcess(args, rc, "", err)

        if args[:1] != ["docker"]:
            return ok()
        cmd = args[1:]
        show_all = "-a" in cmd or "-aq" in cmd
        if cmd[0] == "ps":
            if sl.MINIO in cmd[cmd.index("--filter") + 1]:
                listed = self.store == "running" or (show_all and self.store == "stopped")
                return ok("f00d" if listed else "")
            return ok("\n".join(n for n, up in self.computers.items() if up or show_all))
        if cmd[0] == "inspect":
            if cmd[-1] not in self.computers:
                return fail(1, "No such object")
            return ok("true" if self.computers[cmd[-1]] else "false")
        if cmd[0] == "start":
            if cmd[-1] not in self.computers or self.start_fails:
                return fail(1, "cannot start")
            self.computers[cmd[-1]] = True
            return ok(cmd[-1])
        if cmd[:2] == ["rm", "-f"]:
            if cmd[2] == sl.MINIO:
                self.store, self.checkpoint = "absent", set()
            self.computers.pop(cmd[2], None)
            self.homes.pop(cmd[2], None)
            return ok()
        if cmd[0] == "run" and "-d" in cmd:
            name = cmd[cmd.index("--name") + 1]
            if name in self.computers or (name == sl.MINIO and self.store != "absent"):
                return fail(125, "Conflict. The container name is already in use")
            if name == sl.MINIO:
                self.store = "running"
            else:
                self.computers[name] = True
                self.homes[name] = set(self.checkpoint)
            return ok("id")
        if cmd[0] == "exec":
            name = cmd[2] if cmd[1] == "-it" else cmd[1]
            if not self.computers.get(name):
                return fail(1, f"container {name} is not running")
            rest = cmd[3:] if cmd[1] == "-it" else cmd[2:]
            action = rest[2] if rest[:2] == ["bash", "/opt/s6/owner/inner.sh"] else rest[0]
            home = self.homes.setdefault(name, set())
            if action in ("claude-logout", "codex-logout"):
                gone = {x for x in home if x.startswith(action.split("-")[0])}
                self.active -= gone
                home -= gone
                return ok()
            if action == "signed-out-check":
                return ok() if not home else fail(1)
            if action == "capture":
                self.checkpoint = set(home)
                return ok()
            if action == "start-generation":
                return ok("generation 7")
            if action == "watch-stop":
                return fail(1)  # a stopped computer's watcher is gone
            return ok()
        return ok()  # network, one-off `docker run --rm`, image inspect


B = f"{sl.PREFIX}-b"
NEWER = {"claude-2", "codex-2"}


@pytest.mark.parametrize("checkpoint, why", [
    ((), "a sign-in that was never checkpointed"),
    (("claude-1", "codex-1"), "a refresh newer than the checkpoint (the checkpoint's tokens were rotated away)"),
])
def test_stopped_computer_with_credentials_newer_than_its_checkpoint_is_signed_out_first(
        world, monkeypatch, capsys, checkpoint, why):
    """Finding 2: a stopped computer keeps its files. Cleanup must sign out in it before removing
    it, and may report a verified sign-out only if no login is left active."""
    d = LoginDocker(computers={B: (False, NEWER)}, checkpoint=checkpoint, active=NEWER)
    shm, _ = world(d, s3="ok", marker="signin-attempted")
    rc, out = run_cleanup(monkeypatch, capsys)
    assert not d.active, f"{why}: the logins {sorted(d.active)} are still active at the provider"
    assert rc == 0, f"{why}: the stopped computer could be started and signed out; cleanup should verify"
    assert B not in d.computers and not shm.exists()


def test_stopped_computer_that_cannot_start_is_kept_and_unresolved(world, monkeypatch, capsys):
    """Finding 2: if the stopped computer cannot be brought back, nothing is removed, the exit
    status is non-zero and the owner is told to revoke the sessions."""
    d = LoginDocker(computers={B: (False, NEWER)}, checkpoint=(), active=NEWER, start_fails=True)
    shm, _ = world(d, s3="ok", marker="signin-attempted")
    rc, out = run_cleanup(monkeypatch, capsys)
    assert rc != 0
    assert B in d.computers, "the stopped computer, which holds the only copy of the login, was removed"
    assert shm.exists() and d.store == "running"
    assert UNKNOWN in out.lower()


def run_startup(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["session_local.py"])
    try:
        result = sl.main()
    except BaseException as e:  # SystemExit (a refusal), or a collision with the old material
        result = e
    return result, capsys.readouterr().out


@pytest.mark.parametrize("leftover", [
    "store configuration", "controller state only", "stopped store", "running store", "stopped computer",
])
def test_startup_then_cleanup_never_overwrites_an_unknown_earlier_session(world, monkeypatch, capsys, leftover):
    """Finding 3: the review's isolated probe. No marker, but an earlier session's recovery
    material is there. Starting must refuse before writing a marker, and the following cleanup
    must keep the material and report the state as unknown."""
    d = LoginDocker(store="absent", checkpoint={"claude-1", "codex-1"}, active={"claude-1", "codex-1"})
    shm, out_dir = world(d, s3=None, marker=None, session=None)
    if leftover == "store configuration":
        (shm / "s3.json").write_text(json.dumps({"user": "earlier", "password": "earlier-session"}))
    elif leftover == "controller state only":
        (shm / "controller.sqlite").write_bytes(b"earlier session")
    else:
        shm.rmdir()
        if leftover == "stopped store":
            d.store = "stopped"
        elif leftover == "running store":
            d.store = "running"
        else:
            d.computers[B], d.homes[B] = False, set(NEWER)
            d.active |= NEWER
    before = (sorted(p.name for p in shm.iterdir()) if shm.exists() else None, d.store, dict(d.computers))
    result, _ = run_startup(monkeypatch, capsys)
    assert isinstance(result, SystemExit) and result.code not in (0, None), \
        f"{leftover}: startup did not refuse ({result!r})"
    assert sl.read_state() is None, f"{leftover}: startup wrote a session marker over unknown material"
    rc, out = run_cleanup(monkeypatch, capsys)
    after = (sorted(p.name for p in shm.iterdir()) if shm.exists() else None, d.store, dict(d.computers))
    assert after == before, f"{leftover}: the earlier session's material changed: {before} -> {after}"
    if leftover == "store configuration":
        assert json.loads((shm / "s3.json").read_text())["user"] == "earlier"
    assert rc != 0 and UNKNOWN in out.lower(), f"{leftover}: cleanup did not report the state as unknown"


@pytest.mark.parametrize("marker, marker_session", [
    ("signed-out-verified", None),  # as the committed dry-run marker: no session id
    ("signed-out-verified", "sess-other"),
    ("closed-never-signed-in", "sess-other"),
    ("started", "sess-other"),
])
def test_a_marker_from_another_session_does_not_account_for_recovery_material(
        world, monkeypatch, capsys, marker, marker_session):
    """Finding 3: a marker is evidence about its own session only. The real and dry-run sessions
    keep separate markers but share the store, /dev/shm and computer names; another session's
    closed or never-signed-in marker must not let cleanup remove this material unverified."""
    d = LoginDocker(store="running", checkpoint={"claude-1", "codex-1"}, active={"claude-1", "codex-1"})
    shm, out_dir = world(d, s3="ok", marker=None, session="sess-1")
    (out_dir / "session-state.json").write_text(json.dumps({"phase": marker, "session": marker_session}))
    rc, out = run_cleanup(monkeypatch, capsys)
    assert rc != 0, f"{marker}: reported closed"
    assert shm.exists() and d.store == "running", f"{marker}: another session's material was removed"
    assert UNKNOWN in out.lower()


def test_control_own_never_signed_in_session_is_closed(world, monkeypatch, capsys):
    d = LoginDocker(store="running", computers={f"{sl.PREFIX}-a": (True, set())})
    shm, _ = world(d, s3="ok", marker="started", session="sess-1")
    rc, out = run_cleanup(monkeypatch, capsys)
    assert rc == 0 and not shm.exists() and d.store == "absent" and not d.computers
