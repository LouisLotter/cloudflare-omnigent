"""Spike S6 tests: credential checkpoints, latest-wins restore and tombstones, with fake CLIs.

Run:  uv run --no-project --with pytest==8.4.2 python -I -m pytest spikes/s6/tests -q
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

S6 = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(S6 / "credsync"))

from controller import Controller, StaleGeneration  # noqa: E402
from core import (  # noqa: E402
    CRED_KIND,
    DECLARED_FILES,
    WORKSPACE_KIND,
    is_credential_or_sibling,
    pack_tar,
    stage_and_install_credentials,
    take_credential_snapshot,
    take_workspace_snapshot,
)
from objstore import LocalStore  # noqa: E402
from ops import (  # noqa: E402
    Computer,
    CredentialWatcher,
    RestoreNotDone,
    capture_credentials,
    capture_workspace,
    publish_credential_snapshot,
    restore,
)

CANARY = re.compile(rb"CFO_CANARY_[A-Za-z0-9_]{8,}")
FAKES = S6 / "fakes" / "fake_cli.py"


class Box:
    """One computer: a controller and a store that outlive containers, and a current home."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.store = LocalStore(tmp / "store")
        self.controller = Controller(tmp / "controller.sqlite")
        self.provider = tmp / "provider.json"
        self.n = 0
        self.home: Path
        self.comp: Computer
        self.new_container()
        restore(self.comp, self.home, tmp / "staging0")  # nothing to restore yet; opens the gate

    def new_container(self) -> None:
        """A fresh container: empty home, new generation."""
        self.n += 1
        self.home = self.tmp / f"home{self.n}"
        self.home.mkdir()
        gen = self.controller.start_generation("pc1")
        self.comp = Computer("pc1", gen, self.store, self.controller)

    def cli(self, prog: str, *args: str, env: dict | None = None) -> tuple[int, str]:
        e = {"HOME": str(self.home), "S6_FAKE_PROVIDER": str(self.provider), "PATH": os.environ["PATH"], **(env or {})}
        r = subprocess.run([sys.executable, "-I", str(FAKES), prog, *args], env=e, capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout + r.stderr

    def ok(self, prog: str, *args: str, **kw) -> str:
        rc, out = self.cli(prog, *args, **kw)
        assert rc == 0, f"{prog} {args}: rc={rc} {out}"
        return out

    def sign_in_all(self) -> None:
        self.ok("claude", "auth", "login", "--claudeai")
        self.ok("codex", "login", "--device-auth")
        self.ok("omnigent", "login", "http://omnigent.internal")

    def cred(self) -> int:
        seq, ok, _ = capture_credentials(self.comp, self.home)
        assert ok
        return seq

    def ws(self) -> int:
        seq, ok, _ = capture_workspace(self.comp, self.home)
        assert ok
        return seq

    def restart_and_restore(self) -> dict:
        self.new_container()
        return restore(self.comp, self.home, self.tmp / f"staging{self.n}")

    def logged_in(self) -> dict[str, bool]:
        return {
            "claude": self.cli("claude", "auth", "status")[0] == 0,
            "codex": self.cli("codex", "login", "status")[0] == 0,
            "omnigent": self.cli("omnigent", "status", "http://omnigent.internal")[0] == 0,
        }

    def can_use(self) -> dict[str, int]:
        return {
            "claude": self.cli("claude", "use")[0],
            "codex": self.cli("codex", "use")[0],
            "omnigent": self.cli("omnigent", "use", "http://omnigent.internal")[0],
        }


@pytest.fixture
def box(tmp_path: Path, monkeypatch) -> Box:
    monkeypatch.setenv("S6_STATE_DIR", str(tmp_path / "state"))  # snapshot order and restore gate
    return Box(tmp_path)


def sessions(home: Path) -> list[str]:
    return sorted(str(p.relative_to(home)) for p in home.rglob("*.jsonl") if "history" not in p.name)


ALL_IN = {"claude": True, "codex": True, "omnigent": True}
ALL_OUT = {"claude": False, "codex": False, "omnigent": False}


# -- Declared list and workspace exclusion ------------------------------------------------------


def test_declared_files_and_siblings_are_excluded_from_workspace(box: Box):
    assert [d.path for d in DECLARED_FILES] == [
        ".claude/.credentials.json",
        ".claude/.device-keys.json",  # provisional, until the owner session
        ".codex/auth.json",
        ".omnigent/auth_tokens.json",
    ]
    for name in [".claude/.credentials.json.tmp.0a1b2c3d", ".claude/.credentials.json.tmp.123.0a1b2c3d4e5f",
                 ".omnigent/.auth_tokens.json.k2j3h4.tmp", ".omnigent/auth_tokens.lock"]:
        assert is_credential_or_sibling(name), name
    for name in [".claude/settings.json", ".claude.json", ".codex/config.toml", ".omnigent/config.yaml", "work/auth.json"]:
        assert not is_credential_or_sibling(name), name
    box.sign_in_all()
    # A crash can leave a credential-bearing temporary file behind; plant one of each kind.
    (box.home / ".claude/.credentials.json.tmp.deadbeef").write_text("x")
    (box.home / ".omnigent/.auth_tokens.json.abc123.tmp").write_text("x")
    box.ok("claude", "session", "s1")
    entries = take_workspace_snapshot(box.home)
    assert not [p for p in entries if is_credential_or_sibling(p)]
    assert ".claude.json" in entries and ".omnigent/config.yaml" in entries
    blob = pack_tar(entries)
    assert not CANARY.search(blob), "a login token reached the workspace checkpoint"


# -- Pass criterion 2: latest of each ------------------------------------------------------------


def test_old_credentials_with_newer_workspace(box: Box):
    box.sign_in_all()
    c1 = box.cred()
    box.ok("claude", "session", "early")
    box.ws()
    box.ok("claude", "session", "late")
    box.ok("codex", "session", "late")
    w2 = box.ws()  # newer than the credential checkpoint
    report = box.restart_and_restore()
    assert report["workspace"]["seq"] == w2 and report["credentials"]["seq"] == c1
    assert ".claude/projects/-work/late.jsonl" in sessions(box.home)
    assert box.logged_in() == ALL_IN
    assert box.can_use() == {"claude": 0, "codex": 0, "omnigent": 0}


def test_newer_credentials_with_older_workspace(box: Box):
    box.sign_in_all()
    box.cred()
    box.ok("claude", "session", "only")
    w1 = box.ws()
    # Logins rotate after the last workspace checkpoint.
    box.ok("claude", "refresh")
    box.ok("codex", "refresh")
    box.ok("omnigent", "refresh", "http://omnigent.internal")
    c2 = box.cred()
    report = box.restart_and_restore()
    assert report["workspace"]["seq"] == w1 and report["credentials"]["seq"] == c2
    assert sessions(box.home) == [".claude/projects/-work/only.jsonl"]
    # The rotated refresh tokens are the ones restored: another refresh succeeds. The previous
    # tokens would be refused as reused.
    assert box.cli("claude", "refresh")[0] == 0
    assert box.cli("codex", "refresh")[0] == 0
    assert box.can_use() == {"claude": 0, "codex": 0, "omnigent": 0}


def test_workspace_checkpoint_never_brings_a_login_back(box: Box):
    box.sign_in_all()
    box.cred()
    box.ok("codex", "session", "s")
    box.ws()  # taken while signed in
    for prog, args in [("claude", ["auth", "logout"]), ("codex", ["logout"]), ("omnigent", ["signout-delete"])]:
        box.ok(prog, *args)
    box.cred()  # all three tombstoned
    report = box.restart_and_restore()
    assert [f["action"] for f in report["credentials"]["files"]] == ["tombstone-absent"] * len(DECLARED_FILES)
    assert box.logged_in() == ALL_OUT
    for d in DECLARED_FILES:
        assert not (box.home / d.path).exists()
    assert sessions(box.home) == [".codex/sessions/2026/10/18/rollout-s.jsonl"]


# -- Pass criterion 3: logout tombstones hold -----------------------------------------------------


def test_tombstones_hold_against_older_checkpoints_and_newer_workspaces(box: Box):
    box.sign_in_all()
    box.cred()
    box.ws()
    box.ok("codex", "logout")
    c2 = box.cred()
    # Later activity: a newer workspace checkpoint, no credential change.
    box.ok("claude", "session", "after-logout")
    box.ws()
    box.restart_and_restore()
    assert box.logged_in() == {"claude": True, "codex": False, "omnigent": True}
    # The tombstone also deletes a stale file if one is present at install time.
    (box.home / ".codex").mkdir(exist_ok=True)
    (box.home / ".codex/auth.json").write_text("{}")
    m = json.loads(box.store.get(box.controller.current("pc1", CRED_KIND)[1]))
    assert m["seq"] == c2
    rep = stage_and_install_credentials(box.home, box.tmp / "st", m, box.store.get(m["archive"]["key"]))
    assert {r["path"]: r["action"] for r in rep}[".codex/auth.json"] == "tombstone-deleted"
    assert not (box.home / ".codex/auth.json").exists()


def test_sign_in_again_after_tombstone_wins(box: Box):
    box.sign_in_all()
    box.cred()
    box.ok("claude", "auth", "logout")
    box.cred()
    box.ok("claude", "auth", "login")
    box.cred()
    box.restart_and_restore()
    assert box.logged_in() == ALL_IN


def test_claude_logout_with_mcp_tokens_rewrites_instead_of_deleting(box: Box):
    box.ok("claude", "auth", "login")
    box.ok("claude", "add-mcp-oauth")
    box.ok("claude", "auth", "logout")
    snap = take_credential_snapshot(box.home)
    assert {r.path: r.state for r in snap.records}[".claude/.credentials.json"] == "present"
    box.cred()
    box.restart_and_restore()
    assert box.logged_in()["claude"] is False  # the rewritten file holds no Claude login


def test_omnigent_clear_token_leaves_an_empty_file_that_is_restored_as_content(box: Box):
    box.ok("omnigent", "login", "http://omnigent.internal")
    box.cred()
    box.ok("omnigent", "logout", "http://omnigent.internal")
    snap = take_credential_snapshot(box.home)
    rec = {r.path: r for r in snap.records}[".omnigent/auth_tokens.json"]
    assert rec.state == "present" and rec.size == 2  # "{}"
    box.cred()
    box.restart_and_restore()
    assert (box.home / ".omnigent/auth_tokens.json").read_text() == "{}"
    assert box.logged_in()["omnigent"] is False


# -- Fencing, interruption, ordering ---------------------------------------------------------------


def test_late_publish_of_an_older_capture_is_refused(box: Box):
    """Overlapping captures through the real capture path: the copy taken first uploads last."""
    box.ok("codex", "login")
    old = take_credential_snapshot(box.home)
    box.ok("codex", "refresh")
    new = take_credential_snapshot(box.home)
    assert new.order > old.order and old.digest() != new.digest()
    seq_new, ok_new = publish_credential_snapshot(box.comp, new)
    assert ok_new
    # The older copy gets the higher sequence number, because it publishes second; it is refused
    # all the same, because it was taken first.
    seq_old, ok_old = publish_credential_snapshot(box.comp, old)
    assert seq_old > seq_new and not ok_old
    assert box.controller.current("pc1", CRED_KIND)[0] == seq_new
    assert ("credential", seq_old, box.comp.generation, "not-newer") in [tuple(r) for r in box.controller.refusals("pc1")]
    # And a tombstone taken after a login is not undone by the login's late upload.
    box.ok("codex", "logout")
    tomb = take_credential_snapshot(box.home)
    box.ok("codex", "login")
    relogin = take_credential_snapshot(box.home)
    box.ok("codex", "logout")
    last = take_credential_snapshot(box.home)
    assert publish_credential_snapshot(box.comp, last)[1]
    assert not publish_credential_snapshot(box.comp, relogin)[1]
    assert not publish_credential_snapshot(box.comp, tomb)[1]
    m = json.loads(box.store.get(box.controller.current("pc1", CRED_KIND)[1]))
    assert {f["path"]: f["state"] for f in m["files"]}[".codex/auth.json"] == "absent"


def test_a_file_deleted_mid_read_is_an_unstable_read_not_a_crash(box: Box, monkeypatch):
    import core

    box.ok("codex", "login")
    target = box.home / ".codex/auth.json"
    real_open = core.os.open

    def racing_open(path, *a, **kw):
        if Path(path) == target:
            target.unlink()  # a logout lands between the stat and the open
        return real_open(path, *a, **kw)

    monkeypatch.setattr(core.os, "open", racing_open)
    with pytest.raises(core.UnstableRead):
        core.read_stable(target)
    monkeypatch.setattr(core.os, "open", real_open)
    # The watcher survives it, settles, and publishes the logout as a tombstone.
    box.ok("codex", "login")
    box.cred()
    calls = {"n": 0}

    def flaky_open(path, *a, **kw):
        if Path(path) == target and calls["n"] == 0:
            calls["n"] += 1
            raise FileNotFoundError(path)
        return real_open(path, *a, **kw)

    monkeypatch.setattr(core.os, "open", flaky_open)
    events = run_watcher(box, 0.3, lambda: box.ok("codex", "refresh"), wait_s=2.0)
    published = [e for e in events if e["event"] == "published"]
    assert published and calls["n"] == 1


def test_watcher_keeps_running_after_an_unexpected_error(box: Box, monkeypatch):
    import ops

    box.ok("codex", "login")
    box.cred()
    real = ops.publish_credential_snapshot
    calls = {"n": 0}

    def failing_once(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("store unavailable")
        return real(*a, **kw)

    monkeypatch.setattr(ops, "publish_credential_snapshot", failing_once)
    events = run_watcher(box, 0.3, lambda: box.ok("codex", "refresh"), wait_s=3.0)
    assert [e for e in events if e["event"] == "watcher-error"]
    assert [e for e in events if e["event"] == "published"]


def test_old_generation_cannot_publish_after_replacement(box: Box):
    box.ok("claude", "auth", "login")
    old_comp = box.comp
    seq = box.controller.next_seq("pc1", CRED_KIND, old_comp.generation)  # allocated before replacement
    box.new_container()
    with pytest.raises(StaleGeneration):
        publish_credential_snapshot(old_comp, take_credential_snapshot(box.tmp / "home1"))
    assert not box.controller.publish("pc1", CRED_KIND, old_comp.generation, seq, "computers/pc1/cred/x.json")
    assert ("credential", seq, old_comp.generation, "stale-generation") in [tuple(r) for r in box.controller.refusals("pc1")]
    assert box.controller.current("pc1", CRED_KIND) is None


def test_interrupted_capture_never_moves_the_pointer(box: Box):
    box.sign_in_all()
    c1 = box.cred()
    box.ok("claude", "refresh")

    def crash():
        raise RuntimeError("container lost before publish")

    with pytest.raises(RuntimeError):
        publish_credential_snapshot(box.comp, take_credential_snapshot(box.home), before_publish=crash)
    assert box.controller.current("pc1", CRED_KIND)[0] == c1
    report = box.restart_and_restore()
    assert report["credentials"]["seq"] == c1


def test_capture_before_restore_is_refused(box: Box):
    box.sign_in_all()
    box.cred()
    box.new_container()
    with pytest.raises(RestoreNotDone):
        capture_credentials(box.comp, box.home)  # the gate holds: no copy of the empty home
    restore(box.comp, box.home, box.tmp / "st")
    assert box.logged_in() == ALL_IN
    box.cred()  # after the restore, captures are allowed


def test_a_copy_taken_before_the_restore_is_refused_even_if_published_after(box: Box):
    """Restore finishes between the copy and its publication: the copy is still refused."""
    box.sign_in_all()
    box.cred()
    box.new_container()
    early = take_credential_snapshot(box.home)  # the empty, not yet restored home
    restore(box.comp, box.home, box.tmp / "st")
    with pytest.raises(RestoreNotDone):
        publish_credential_snapshot(box.comp, early)
    assert box.logged_in() == ALL_IN
    later = take_credential_snapshot(box.home)
    assert publish_credential_snapshot(box.comp, later)[1]


def test_without_the_restore_gate_the_logins_are_lost(box: Box):
    """Negative control: why the gate is needed."""
    box.sign_in_all()
    box.cred()
    box.new_container()
    seq, ok, snap = capture_credentials(box.comp, box.home, require_restore=False)  # wrong order
    assert ok and all(r.state == "absent" for r in snap.records)
    restore(box.comp, box.home, box.tmp / "st")
    assert box.logged_in() == ALL_OUT


# -- RC-13: computer lost just before or after a credential checkpoint ------------------------------


def test_lost_before_publish_asks_only_rotating_providers_to_sign_in_again(box: Box):
    box.sign_in_all()
    box.cred()
    box.ws()
    for prog, args in [("claude", ["refresh"]), ("codex", ["refresh"]), ("omnigent", ["refresh", "http://omnigent.internal"])]:
        box.ok(prog, *args)
    # Lost before the credential checkpoint: restore brings back the previous tokens.
    box.restart_and_restore()
    assert box.cli("claude", "refresh")[0] == 3  # reused refresh token: sign in again
    assert box.cli("codex", "refresh")[0] == 3
    assert box.cli("omnigent", "refresh", "http://omnigent.internal")[0] == 0  # non-rotating grant


def test_lost_after_publish_restores_a_working_login(box: Box):
    box.sign_in_all()
    box.cred()
    for prog, args in [("claude", ["refresh"]), ("codex", ["refresh"])]:
        box.ok(prog, *args)
    box.cred()
    box.restart_and_restore()
    assert box.cli("claude", "refresh")[0] == 0
    assert box.cli("codex", "refresh")[0] == 0


# -- Staged install ---------------------------------------------------------------------------


def test_install_touches_only_declared_files_with_private_modes(box: Box):
    box.sign_in_all()
    box.cred()
    box.new_container()
    for rel in [".claude/settings.json", ".codex/config.toml", ".omnigent/config.yaml"]:
        (box.home / rel).parent.mkdir(parents=True, exist_ok=True)
        (box.home / rel).write_text("keep")
    before = {p: p.stat().st_ino for p in box.home.rglob("*") if p.is_file()}
    restore(box.comp, box.home, box.tmp / "st")
    for p, ino in before.items():
        assert p.read_text() == "keep" and p.stat().st_ino == ino
    installed = [d for d in DECLARED_FILES if d.path != ".claude/.device-keys.json"]  # never created
    for d in installed:
        assert oct((box.home / d.path).stat().st_mode & 0o777) == "0o600"
    assert not list((box.tmp / "st").rglob("*.json")), "staging copy left behind"


def test_install_refuses_undeclared_or_unsafe_archive_members(box: Box):
    box.ok("claude", "auth", "login")
    box.cred()
    m = json.loads(box.store.get(box.controller.current("pc1", CRED_KIND)[1]))
    import hashlib

    for bad in [{".bashrc": (b"x", 0o644)}, {"../escape": (b"x", 0o600)}]:
        blob = pack_tar(bad)
        m2 = dict(m, archive={"key": "k", "sha256": hashlib.sha256(blob).hexdigest()})
        with pytest.raises(ValueError):
            stage_and_install_credentials(box.home, box.tmp / "st", m2, blob)


# -- Watcher: settle, then copy -----------------------------------------------------------------


def run_watcher(box: Box, settle_s: float, action, wait_s: float = 3.0) -> list[dict]:
    events: list[dict] = []
    w = CredentialWatcher(box.comp, box.home, settle_s=settle_s, poll_s=0.02, log=events.append)
    t = threading.Thread(target=w.run, daemon=True)
    t.start()
    action()
    time.sleep(wait_s)
    w.stopped = True
    t.join(5)
    return events


def test_watcher_waits_for_an_in_place_write_to_settle(box: Box):
    box.ok("codex", "login")
    box.cred()
    events = run_watcher(box, 0.5, lambda: box.ok("codex", "refresh", env={"S6_FAKE_SLOW_WRITE_MS": "300"}))
    published = [e for e in events if e["event"] == "published"]
    assert len(published) == 1, events
    m = json.loads(box.store.get(box.controller.current("pc1", CRED_KIND)[1]))
    rec = {f["path"]: f for f in m["files"]}[".codex/auth.json"]
    import hashlib

    assert rec["sha256"] == hashlib.sha256((box.home / ".codex/auth.json").read_bytes()).hexdigest()
    json.loads((box.home / ".codex/auth.json").read_text())


def test_without_settling_a_torn_in_place_write_gets_published(box: Box):
    """Negative control: with no settle window, a half-written auth.json becomes a checkpoint."""
    box.ok("codex", "login")
    box.cred()
    events = run_watcher(box, 0.0, lambda: box.ok("codex", "refresh", env={"S6_FAKE_SLOW_WRITE_MS": "300"}))
    published = [e for e in events if e["event"] == "published"]
    torn = 0
    for key in box.store.list("computers/pc1/cred/"):
        if not key.endswith(".json"):
            continue
        m = json.loads(box.store.get(key))
        from core import unpack_tar_regular_files

        members = unpack_tar_regular_files(box.store.get(m["archive"]["key"]))
        data = members.get(".codex/auth.json", (b"{}", 0))[0]
        try:
            json.loads(data)  # test-only check on synthetic content
        except ValueError:
            torn += 1
    assert len(published) >= 2 and torn >= 1, (len(published), torn)


def test_watcher_publishes_logout_as_tombstone_and_ignores_no_op_touches(box: Box):
    box.sign_in_all()
    box.cred()

    def act():
        os.utime(box.home / ".claude/.credentials.json")  # metadata only: same bytes
        time.sleep(0.8)
        box.ok("codex", "logout")

    events = run_watcher(box, 0.3, act, wait_s=2.0)
    published = [e for e in events if e["event"] == "published"]
    assert len(published) == 1, events
    assert {f["path"]: f["state"] for f in published[0]["files"]}[".codex/auth.json"] == "absent"


def test_codex_login_gap_does_not_publish_a_transient_tombstone(box: Box):
    box.ok("codex", "login")
    box.cred()
    # Codex logs out (unlinks auth.json) and then writes the new login: one settled change.
    events = run_watcher(box, 0.3, lambda: box.ok("codex", "login"), wait_s=1.5)
    published = [e for e in events if e["event"] == "published"]
    assert len(published) == 1
    assert {f["path"]: f["state"] for f in published[0]["files"]}[".codex/auth.json"] == "present"


# -- No login material outside the checkpoints ---------------------------------------------------


def test_reports_manifests_and_logs_hold_no_tokens(box: Box):
    box.sign_in_all()
    box.cred()
    box.ws()
    events = run_watcher(box, 0.2, lambda: box.ok("codex", "refresh"), wait_s=1.0)
    report = box.restart_and_restore()
    texts = [json.dumps(events).encode(), json.dumps(report).encode()]
    texts += [box.store.get(k) for k in box.store.list() if k.endswith(".json")]
    for t in texts:
        assert not CANARY.search(t)
    # The credential archives, and only they, hold the tokens.
    cred_archives = [k for k in box.store.list() if "/cred/" in k and k.endswith(".tar")]
    assert cred_archives and all(CANARY.search(box.store.get(k)) for k in cred_archives)
    ws_archives = [k for k in box.store.list() if "/ws/" in k and k.endswith(".tar")]
    assert ws_archives and not any(CANARY.search(box.store.get(k)) for k in ws_archives)
    assert WORKSPACE_KIND == "workspace"
