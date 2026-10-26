"""Regression tests for Codex's review r1 of WP3.4 (findings 1 to 11), and the lead's sign-out
check for WP3.1: a stored bundle of tombstones, installed through the supervisor's real install
path, leaves no login file.

Each test drives the actual code: the receiver over HTTP where the finding is at the receiver,
the real worker and guard processes for the pause, the real restore and install functions.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from cfo_computer import credentials as C
from cfo_computer import restore as R
from cfo_computer.backoff import capped_backoff
from cfo_computer.supervisor import Tools
from cfo_computer.tree import tree_digest
from harness import FAKES, FakeWorkspace, Rig, Uploads, canary, new_id, tree_files

DECLARED = (
    ".claude/.credentials.json",
    ".claude/.device-keys.json",
    ".codex/auth.json",
    ".codex/.credentials.json",
)


def _until(predicate, timeout: float = 20.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("timed out")


def _state(pid: int) -> str:
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]


# -- 1. a failed rename while moving roots into place never loses an original --------------


@pytest.mark.parametrize("fail_at", [1, 2, 3, 4])
def test_move_into_place_puts_every_original_back(
    tmp_path: Path, monkeypatch, fail_at: int
) -> None:
    home, merge, aside = tmp_path / "home", tmp_path / "merge", tmp_path / "aside"
    for root in ("work", ".claude"):
        (home / root).mkdir(parents=True)
        (home / root / "old").write_text(f"original {root}")
        (merge / root).mkdir(parents=True)
        (merge / root / "new").write_text(f"restored {root}")
    aside.mkdir()
    before = tree_files(home)
    real = os.replace
    calls = {"n": 0}

    def failing(src, dst, *a, **k):
        calls["n"] += 1
        if calls["n"] == fail_at:
            raise OSError(28, "injected")
        return real(src, dst, *a, **k)

    monkeypatch.setattr(R.os, "replace", failing)
    with pytest.raises(R.RestoreFailed) as exc:
        R._move_into_place(str(merge), home, ["work", ".claude"], aside, "job")
    assert exc.value.reason == "move_failed"
    assert tree_files(home) == before, f"failure at rename {fail_at} lost an original"


# -- 2. a workload process started just before a capture is in its pause ---------------------


def test_a_spawn_in_progress_finishes_before_the_capture_lists_the_workload(tmp_path: Path) -> None:
    rig = Rig(tmp_path / "a")
    late = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        rig.boot()
        held = threading.Event()

        def spawn() -> None:  # as a host restart does: under the spawn gate
            with rig.sup._spawn_gate():
                held.set()
                time.sleep(0.5)
                with rig.sup._lock:
                    rig.sup._workload_pids.add(late.pid)

        thread = threading.Thread(target=spawn)
        thread.start()
        held.wait()
        op, job = rig.capture()
        thread.join()
        spec = json.loads((rig.layout.log / f"capture-{op}.spec.json").read_text())
        assert late.pid in spec["workload_pids"], "the restarted process would escape the pause"
        assert job["state"] == "staged"
    finally:
        late.kill()
        rig.close()


# -- 3 and 4. restore never follows a layer's links, and strips a credential's aliases --------


def _base(tmp_path: Path) -> tuple[Rig, Uploads]:
    uploads = Uploads(tmp_path / "r2")
    a = Rig(tmp_path / "a")
    a.boot()
    (a.home / "work" / "f.txt").write_text("content")
    op, base = a.capture()
    uploads.upload(base)
    a.finish(op)
    a.close()
    return a, uploads


def test_restore_refuses_a_layer_directory_that_is_a_link(tmp_path: Path) -> None:
    a, uploads = _base(tmp_path)
    _job, index = uploads.jobs[0]
    outside = tmp_path / "outside"
    layer = uploads.root / index["layerId"]
    (layer / "work").rename(outside)  # same files, now reached through a link
    os.symlink(outside, layer / "work")
    modes = {p.name: p.stat().st_mode for p in outside.iterdir()}
    b = Rig(tmp_path / "b", computer_id=a.computer_id, generation=4)
    try:
        dirs = uploads.restore_into(b)
        job = b.restore(uploads.manifest(a.computer_id, 3), dirs)
        assert job["state"] == "failed" and job["reason"] == "layer_corrupt", job
        assert {p.name: p.stat().st_mode for p in outside.iterdir()} == modes
        assert not (b.home / "work" / "f.txt").exists()
    finally:
        b.close()


def test_restore_strips_a_hard_link_to_a_stripped_credential(tmp_path: Path) -> None:
    a, uploads = _base(tmp_path)
    job, index = uploads.jobs[0]
    layer = uploads.root / index["layerId"]
    secret = canary("aliased")
    (layer / ".codex").mkdir()
    (layer / ".codex" / "auth.json").write_text(secret)
    os.link(layer / ".codex" / "auth.json", layer / "work" / "alias")
    st = os.lstat(layer / "work" / "alias")
    digest = hashlib.sha256(secret.encode()).hexdigest()
    for path in (".codex/auth.json", "work/alias"):
        index["entries"].append(
            {
                "path": path,
                "type": "file",
                "mode": st.st_mode & 0o7777,
                "uid": st.st_uid,
                "gid": st.st_gid,
                "size": len(secret),
                "sha256": digest,
            }
        )
    index["entries"].append(
        {"path": ".codex", "type": "dir", "mode": 0o700, "uid": st.st_uid, "gid": st.st_gid}
    )
    index["entries"].sort(key=lambda e: e["path"].encode())
    index["treeDigest"] = tree_digest(index["entries"])
    data = json.dumps(index).encode()
    (layer / ".cfo-layer" / "index.json").write_bytes(data)
    job.update(indexSha256=hashlib.sha256(data).hexdigest(), treeDigest=index["treeDigest"])
    b = Rig(tmp_path / "b", computer_id=a.computer_id, generation=4)
    try:
        restored = b.restore(uploads.manifest(a.computer_id, 3), uploads.restore_into(b))
        assert restored["state"] == "done" and restored["stripped"] == 2, restored
        assert not (b.home / "work" / "alias").exists()
        assert (b.home / "work" / "f.txt").read_text() == "content"
        for dirpath, _dirs, files in os.walk(b.home):
            for name in files:
                assert secret.encode() not in (Path(dirpath) / name).read_bytes()
    finally:
        b.close()


# -- 5. credentials never follow a symlinked CLI home ----------------------------------------


def _bundle(computer_id: str, files: dict[str, bytes | None]) -> dict:
    out = {}
    for rel in DECLARED:
        data = files.get(rel)
        if data is None:
            out[rel] = {"state": "tombstone", "copyOrder": 1}
        else:
            out[rel] = {
                "state": "present",
                "mode": 0o600,
                "copyOrder": 2,
                "contentBase64": base64.b64encode(data).decode(),
            }
    return {
        "formatVersion": 1,
        "computerId": computer_id,
        "generation": 1,
        "order": max(f["copyOrder"] for f in out.values()),
        "files": out,
    }


def test_install_and_copies_refuse_a_symlinked_cli_home(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "auth.json").write_text("not the computer's")
    rig = Rig(tmp_path / "a")
    try:
        assert rig.restore()["state"] == "done"
        os.symlink(outside, rig.home / ".codex")
        status, reply = rig.send("install_credentials", bundle=_bundle(rig.computer_id, {}))
        assert status == 400 and reply["error"]["code"] == "bad_request", reply
        assert (outside / "auth.json").exists(), "a tombstone must not delete through a link"
        status, reply = rig.send(
            "install_credentials", bundle=_bundle(rig.computer_id, {".codex/auth.json": b"x"})
        )
        assert status == 400
        assert (outside / "auth.json").read_text() == "not the computer's"
        with pytest.raises(C.CredentialAlert):
            C.read_stably(rig.home / ".codex" / "auth.json", rig.home)
    finally:
        rig.close()


# -- 6. one operation ID, concurrent deliveries: one effect --------------------------------


def test_concurrent_repeats_of_one_operation_run_it_once(tmp_path: Path) -> None:
    rig = Rig(tmp_path / "a")
    try:
        rig.boot()
        (rig.home / ".claude").mkdir(exist_ok=True)
        (rig.home / ".claude" / ".credentials.json").write_text(canary("c"))
        calls = []
        original = rig.sup._cmd_credential_snapshot

        def slow(command):
            calls.append(1)
            time.sleep(0.5)
            return original(command)

        rig.sup._cmd_credential_snapshot = slow
        command = rig.command("credential_snapshot")
        replies: list = []
        threads = [
            threading.Thread(target=lambda: replies.append(rig.post(command))) for _ in range(3)
        ]
        for t in threads:
            t.start()
        time.sleep(0.1)
        other = dict(command, protocolVersion=1)
        other["generation"] = rig.generation
        status, reply = rig.post(rig.command("sign_out", op=command["operationId"]))
        for t in threads:
            t.join()
        assert len(calls) == 1
        assert len({json.dumps(r, sort_keys=True) for r in replies}) == 1 and replies[0][0] == 200
        assert status == 409 and reply["error"]["code"] == "conflict"
    finally:
        rig.close()


# -- 7. an unreadable descriptor is never "no writer" ----------------------------------------


def test_an_unreadable_descriptor_is_looked_at_again(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "auth.json"
    target.write_text("x")
    st = os.lstat(target)
    real_stat = os.stat

    def denied(path, *a, **k):
        if isinstance(path, str) and path.startswith(f"/proc/{os.getpid()}/fd/"):
            raise PermissionError(13, "denied")
        return real_stat(path, *a, **k)

    monkeypatch.setattr(C.os, "stat", denied)
    found, unreadable = C._writers_among([str(os.getpid())], st)
    assert not found and unreadable == [str(os.getpid())]


# -- 8. a guard that dies between its stop and its answer leaves nothing stopped -------------


@pytest.mark.parametrize("fault", ["guard_dies_after_stop", "guard_dies_after_stop_worker_too"])
def test_a_guard_dying_after_a_stop_leaves_nothing_stopped(tmp_path: Path, fault: str) -> None:
    proc = subprocess.Popen([sys.executable, "-c", "import time\nwhile True: time.sleep(0.01)"])
    rig = Rig(tmp_path / "a", scope_pids=[proc.pid])
    try:
        rig.boot()
        rig.sup.capture_fault = fault
        op, job = rig.capture()
        assert job["state"] == "failed", job
        time.sleep(0.1)
        assert _state(proc.pid) not in ("T", "t"), "a stopped process was left behind"
        lines = (rig.layout.log / f"capture-{op}.stops").read_text().splitlines()
        assert any(x.split()[:2] == ["req", str(proc.pid)] for x in lines), lines
        assert lines[-1] == "released", "the replay retired what it resumed"
        # And the next capture works.
        rig.sup.capture_fault = ""
        assert rig.capture()[1]["state"] == "staged"
    finally:
        proc.kill()
        rig.close()


# -- 9. a capture that fails before its worker starts ends, and the next one runs ------------


def test_a_capture_that_cannot_start_ends_and_frees_the_next(tmp_path: Path) -> None:
    rig = Rig(tmp_path / "a")
    try:
        rig.boot()
        os.chmod(rig.layout.log, 0o500)  # the spec cannot be written
        try:
            if os.access(rig.layout.log, os.W_OK):
                pytest.skip("running as root: permissions do not stop the write")
            op, job = rig.capture()
            assert job["state"] == "failed", job
            assert rig.sup.capture_running is False
        finally:
            os.chmod(rig.layout.log, 0o700)
        assert rig.capture()[1]["state"] == "staged"
    finally:
        rig.close()


# -- 10. the host never starts without its configuration ------------------------------------

FAKE_HOST = r"""#!/usr/bin/env python3
import json, os
home = os.environ["HOME"]
with open(os.path.join(home, "host-runs.jsonl"), "a") as fh:
    config = os.path.join(home, ".omnigent", "host-config.json")
    fh.write(json.dumps({"config": os.path.exists(config)}) + "\n")
import time
time.sleep(60)
"""

FLAKY_PYTHON = r"""#!/usr/bin/env python3
import os, sys
home = os.environ["HOME"]
count = os.path.join(home, "prepare-count")
n = int(open(count).read()) if os.path.exists(count) else 0
open(count, "w").write(str(n + 1))
if n < 2:
    sys.exit(1)  # the first two writes fail
data = sys.stdin.read()
os.makedirs(os.path.join(home, ".omnigent"), exist_ok=True)
open(os.path.join(home, ".omnigent", "host-config.json"), "w").write(data)
"""


def _script(path: Path, text: str) -> str:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


def test_a_failed_configuration_write_is_retried_before_the_host_starts(tmp_path: Path) -> None:
    tools = Tools(
        omnigent=_script(tmp_path / "fake-omnigent", FAKE_HOST),
        venv_python=_script(tmp_path / "flaky-python", FLAKY_PYTHON),
        claude=str(FAKES / "claude"),
        codex=str(FAKES / "codex"),
    )
    rig = Rig(tmp_path / "a", tools=tools, host_backoff=lambda n: 0.05)
    rig.sup.runner_processes = lambda: 0
    try:
        rig.boot()
        reply = rig.ok(
            "start_host",
            startAttempt=1,
            hostId="7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f",
            hostName="c",
            token=canary("launch"),
            hostConfig={"runner": {"idle_timeout_s": 600}},
        )
        assert reply["outcome"] == "taken"
        runs = rig.home / "host-runs.jsonl"
        _until(lambda: runs.exists())
        lines = [json.loads(x) for x in runs.read_text().splitlines()]
        assert lines == [{"config": True}], lines
        assert (rig.home / "prepare-count").read_text() == "3"
    finally:
        rig.close()


# -- 11. backoffs never overflow -----------------------------------------------------------


def test_backoffs_stay_bounded_after_a_long_outage() -> None:
    assert capped_backoff(1, 0.5, 30.0) == 0.5
    assert capped_backoff(3, 1.0, 30.0) == 4.0
    for n in (1025, 10**6):
        assert capped_backoff(n, 0.5, 30.0) == 30.0


# -- WP3.1's sign-out verification: tombstones installed leave no login ----------------------


def test_a_stored_bundle_of_tombstones_installs_no_login(tmp_path: Path) -> None:
    """WorkspaceDO reads the stored credential bundle back and requires tombstones (the lead's
    decision for WP3.1). Here the bundle a real sign-out published is installed through the
    supervisor's real install path, on a fresh computer and in a scratch directory."""
    ws = FakeWorkspace()
    provider = tmp_path / "provider" / "state.json"
    a = Rig(tmp_path / "a", workspace=ws)
    a.sup.extra_env = {"CFO_FAKE_PROVIDER": str(provider)}
    a.sup.start_loops()
    env = {"HOME": str(a.home), "PATH": os.environ["PATH"], "CFO_FAKE_PROVIDER": str(provider)}
    try:
        a.boot()
        for argv in (["claude", "auth", "login"], ["codex", "login"]):
            subprocess.run(
                [str(FAKES / argv[0]), *argv[1:]], env=env, check=True, capture_output=True
            )
        _until(lambda: ws.pointer and ws.pointer["files"][".codex/auth.json"]["state"] == "present")
        signed_in = ws.pointer
        assert a.ok("sign_out") == {"type": "sign_out", "claude": "ok", "codex": "ok"}
        _until(lambda: all(ws.pointer["files"][p]["state"] == "tombstone" for p in DECLARED))
        stored = json.loads(json.dumps(ws.pointer))  # as WorkspaceDO stores and reads it back
    finally:
        a.close()
        ws.close()
    assert all(f["state"] == "tombstone" for f in stored["files"].values())
    b = Rig(tmp_path / "b", computer_id=a.computer_id, generation=a.generation + 1)
    try:
        assert b.restore()["state"] == "done"
        # A login left over on the disk is removed by the tombstones, never kept.
        (b.home / ".codex").mkdir()
        (b.home / ".codex" / "auth.json").write_text("stale login")
        reply = b.install(stored)
        assert reply["installed"] == [] and reply["removed"] == [".codex/auth.json"]
        assert [p for p in DECLARED if os.path.lexists(b.home / p)] == []
        b.sup.refresh_logins()
        assert b.sup.logins == {"claude": "signed_out", "codex": "signed_out"}
        assert b.sup.verify_signed_out(stored) == []
        # Control: the signed-in bundle installs its logins.
        assert b.sup.verify_signed_out(signed_in) == [
            ".claude/.credentials.json",
            ".codex/auth.json",
        ]
    finally:
        b.close()


_ = new_id
