"""Capture and restore through the supervisor's actual receiver (ST-01).

Each test drives the real ``Supervisor`` over its real HTTP command port with contract JSON,
as WorkspaceDO would; captures run the real worker and lease-guard processes and pause a real
workload process; layers are copied out as DirectoryBackup uploads them, and restored into a
fresh computer through ``restore_workspace``.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from harness import LEASE, Rig, Uploads, canary, new_id, scan_for, tree_files

WRITER = r"""
import os, sys, time
path = sys.argv[1]
n = 0
with open(path, "a", buffering=1) as fh:
    while True:
        fh.write(f"{n:08d} {time.time():.4f}\n")
        n += 1
        time.sleep(0.002)
"""


@pytest.fixture
def writer(tmp_path: Path):
    home = tmp_path / "a" / "home"
    (home / "work").mkdir(parents=True)
    log = home / "work" / "writer.log"
    proc = subprocess.Popen([sys.executable, "-c", WRITER, str(log)])
    time.sleep(0.2)
    yield proc, log
    proc.kill()
    proc.wait()


def _state(pid: int) -> str:
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]


def test_capture_pauses_the_workload_and_copies_a_consistent_cut(tmp_path: Path, writer) -> None:
    proc, log = writer
    rig = Rig(tmp_path / "a", scope_pids=[proc.pid])
    try:
        rig.boot()
        (rig.home / "work" / "notes.txt").write_text("notes\n")
        op, job = rig.capture()
        assert job["state"] == "staged", job
        result = rig.result(op)
        assert result["stopped"] >= 1 and result["mechanism"] == "sigstop"
        assert result["guard"] == "released" and job["pausedMs"] < LEASE["hardMs"]
        assert _state(proc.pid) != "T"  # resumed
        staged = (Path(job["layerDir"]) / "work" / "writer.log").read_bytes()
        live = log.read_bytes()
        assert live.startswith(staged), "the cut is a prefix of the live file"
        index = json.loads((Path(job["layerDir"]) / ".cfo-layer" / "index.json").read_text())
        assert index["kind"] == "base" and index["parentTreeDigest"] is None
        assert index["treeDigest"] == job["treeDigest"]
        assert {e["path"] for e in index["entries"]} >= {"work", "work/notes.txt", "work/writer.log"}
    finally:
        rig.close()


def _populate(home: Path, secrets: dict[str, str]) -> None:
    (home / "work" / "proj" / "src").mkdir(parents=True, exist_ok=True)
    (home / "work" / "proj" / "src" / "main.py").write_text("print('hi')\n")
    exe = home / "work" / "proj" / "run.sh"
    exe.write_text("#!/bin/sh\necho run\n")
    exe.chmod(0o750)
    (home / "work" / "proj" / "link").symlink_to("src/main.py")
    (home / "work" / "proj" / "dangling").symlink_to("/nonexistent/target")
    (home / "work" / "node_modules" / "dep").mkdir(parents=True)
    (home / "work" / "node_modules" / "dep" / "index.js").write_text("cache\n")
    (home / ".claude" / "projects" / "-work").mkdir(parents=True, exist_ok=True)
    (home / ".claude" / "projects" / "-work" / "s1.jsonl").write_text('{"type":"user"}\n')
    (home / ".claude.json").write_text('{"numStartups": 1}\n')
    (home / ".codex" / "sessions").mkdir(parents=True, exist_ok=True)
    (home / ".codex" / "sessions" / "rollout-1.jsonl").write_text('{"type":"session_meta"}\n')
    # The declared credential files and members of their families: never in a layer.
    for rel in (
        ".claude/.credentials.json",
        ".claude/.credentials.json.tmp.1a2b3c4d",
        ".codex/auth.json",
        ".codex/.credentials.json",
        ".omnigent/codex-native/abc/policy_hook.json",
        ".omnigent/codex-native/abc/policy_hook.json.x1y2z3w4",
        ".omnigent/codex-native/abc/provider_key",
    ):
        value = canary("secret")
        secrets[rel] = value
        path = home / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"token": value}))
    # Continuation state the policy saves: the undelivered-event queue.
    (home / ".omnigent" / "codex-native" / "abc" / "dead_letter.jsonl").write_text('{"event_type":"x"}\n')


def test_base_and_deltas_restore_exactly_into_a_fresh_computer(tmp_path: Path) -> None:
    uploads = Uploads(tmp_path / "r2")
    a = Rig(tmp_path / "a")
    secrets: dict[str, str] = {}
    try:
        a.boot()
        _populate(a.home, secrets)
        op, base = a.capture()
        assert base["state"] == "staged"
        uploads.upload(base)
        a.finish(op)
        # A delta: a change, a mode change, a deletion, a type change, a new link.
        (a.home / "work" / "proj" / "src" / "main.py").write_text("print('changed')\n")
        (a.home / "work" / "proj" / "run.sh").chmod(0o700)
        (a.home / "work" / "proj" / "link").unlink()
        (a.home / "work" / "proj" / "link").mkdir()
        (a.home / "work" / "proj" / "link" / "inside.txt").write_text("x")
        (a.home / ".codex" / "sessions" / "rollout-1.jsonl").unlink()
        (a.home / "work" / "proj" / "new-link").symlink_to("../proj")
        op2, delta = a.capture("delta", {"checkpointId": new_id("ckp"), "treeDigest": base["treeDigest"]})
        assert delta["state"] == "staged" and delta["deleted"] >= 1
        index2 = uploads.upload(delta)
        assert index2["kind"] == "delta" and index2["parentTreeDigest"] == base["treeDigest"]
        a.finish(op2)
        # Nothing changed: a verified-unchanged capture, no layer.
        _op3, same = a.capture("delta", {"checkpointId": new_id("ckp"), "treeDigest": delta["treeDigest"]})
        assert same["state"] == "unchanged"
        expected = {
            k: v
            for k, v in tree_files(a.home).items()
            if not k.startswith(("work/node_modules", ".claude/.credentials", ".codex/auth", ".codex/.credentials"))
            and k not in secrets
        }
        # RC-53-style: no planted secret in any uploaded layer.
        assert scan_for(list(secrets.values()), uploads.root) == []
    finally:
        a.close()

    b = Rig(tmp_path / "b", computer_id=a.computer_id, generation=4)
    try:
        manifest = uploads.manifest(a.computer_id, 3)
        job = b.restore(manifest, uploads.restore_into(b))
        assert job["state"] == "done" and job["stripped"] == 0, job
        assert job["treeDigest"] == delta["treeDigest"]
        assert tree_files(b.home) == expected
        assert not (b.home / ".claude" / ".credentials.json").exists()
        # The restored tree is the published one: the next save is a delta against it.
        b.install()
        _op, again = b.capture("delta", {"checkpointId": new_id("ckp"), "treeDigest": delta["treeDigest"]})
        assert again["state"] == "unchanged", again
    finally:
        b.close()


def test_a_corrupt_or_missing_layer_leaves_the_home_as_it_was(tmp_path: Path) -> None:
    uploads = Uploads(tmp_path / "r2")
    a = Rig(tmp_path / "a")
    try:
        a.boot()
        (a.home / "work" / "f.txt").write_text("one")
        op, base = a.capture()
        uploads.upload(base)
        a.finish(op)
    finally:
        a.close()
    cases = {
        "layer_missing": lambda dirs: [d + "-gone" for d in dirs],
        "layer_corrupt": lambda dirs: (Path(dirs[0], ".cfo-layer", "index.json").write_text("{}"), dirs)[1],
        "index_mismatch": lambda dirs: (Path(dirs[0], "work", "f.txt").write_text("two"), dirs)[1],
        "path_refused": lambda dirs: ["/etc"],
    }
    for reason, damage in cases.items():
        b = Rig(tmp_path / f"b-{reason}", computer_id=a.computer_id, generation=4)
        try:
            (b.home / "work").mkdir()
            (b.home / "work" / "before.txt").write_text("untouched")
            before = tree_files(b.home)
            dirs = damage(uploads.restore_into(b))
            job = b.restore(uploads.manifest(a.computer_id, 3), dirs)
            assert job == {**job, "state": "failed", "reason": reason}, (reason, job)
            assert tree_files(b.home) == before, reason
            # No capture, no install, no host before a confirmed restore.
            status, reply = b.send("install_credentials", bundle=None)
            assert status == 409 and reply["error"]["code"] == "conflict"
        finally:
            b.close()


def test_restore_strips_a_credential_member_found_in_a_layer(tmp_path: Path) -> None:
    uploads = Uploads(tmp_path / "r2")
    a = Rig(tmp_path / "a")
    try:
        a.boot()
        (a.home / "work" / "keep.txt").write_text("kept")
        op, base = a.capture()
        uploads.upload(base)
        a.finish(op)
    finally:
        a.close()
    # A layer written by an older, looser policy: it holds a login. Re-sign its index.
    job, index = uploads.jobs[0]
    layer = uploads.root / index["layerId"]
    secret = canary("oldpolicy")
    (layer / ".claude").mkdir()
    (layer / ".claude" / ".credentials.json").write_text(secret)
    st = os.lstat(layer / ".claude" / ".credentials.json")
    import hashlib

    from cfo_computer.tree import tree_digest

    index["entries"] += [
        {"path": ".claude", "type": "dir", "mode": 0o700, "uid": st.st_uid, "gid": st.st_gid},
        {
            "path": ".claude/.credentials.json",
            "type": "file",
            "mode": st.st_mode & 0o7777,
            "uid": st.st_uid,
            "gid": st.st_gid,
            "size": len(secret),
            "sha256": hashlib.sha256(secret.encode()).hexdigest(),
        },
    ]
    index["entries"].sort(key=lambda e: e["path"].encode())
    index["treeDigest"] = tree_digest(index["entries"])
    data = json.dumps(index).encode()
    (layer / ".cfo-layer" / "index.json").write_bytes(data)
    job.update(indexSha256=hashlib.sha256(data).hexdigest(), treeDigest=index["treeDigest"])
    b = Rig(tmp_path / "b", computer_id=a.computer_id, generation=4)
    try:
        restored = b.restore(uploads.manifest(a.computer_id, 3), uploads.restore_into(b))
        assert restored["state"] == "done" and restored["stripped"] == 1, restored
        assert (b.home / "work" / "keep.txt").read_text() == "kept"
        assert not (b.home / ".claude" / ".credentials.json").exists()
        assert any("policy does not save" in a for a in b.sup.alerts)
    finally:
        b.close()


def test_capture_failures_stage_nothing_and_resume_the_workload(tmp_path: Path, writer) -> None:
    proc, _log = writer
    rig = Rig(tmp_path / "a", scope_pids=[proc.pid])
    try:
        rig.boot()
        # The worker wedges while everything is paused: the guard resumes at the deadline.
        rig.sup.capture_fault = "hang_paused"
        rig.sup.capture_grace_s = 2.0
        op, job = rig.capture(lease={"targetMs": 1000, "hardMs": 1500})
        assert job["state"] == "failed" and job["reason"] == "copy_failed"
        assert _state(proc.pid) != "T"
        assert not any(rig.layout.staged.iterdir())
        # The worker dies while everything is paused: the guard sees EOF and resumes.
        rig.sup.capture_fault = "die_paused"
        op, job = rig.capture()
        assert job["state"] == "failed"
        time.sleep(0.2)
        assert _state(proc.pid) != "T"
        # Not enough disk: refused before anything is paused.
        rig.sup.capture_fault = ""
        rig.sup.capture_margin_bytes = 1 << 62
        op, job = rig.capture()
        assert job == {**job, "state": "failed", "reason": "disk_budget", "pausedMs": 0}
        rig.sup.capture_margin_bytes = 1 << 20
        # A delta against a parent that is not the published index.
        op, job = rig.capture("delta", {"checkpointId": new_id("ckp"), "treeDigest": "0" * 64})
        assert job == {**job, "state": "failed", "reason": "parent_mismatch"}
        # A repeated operation ID returns the job; reused for another body, a conflict.
        status, reply = rig.post(
            rig.command("capture", op=op, layerId=new_id("lyr"), kind="base", parent=None, policyVersion=1, lease=LEASE)
        )
        assert status == 409 and reply["error"]["code"] == "conflict"
    finally:
        rig.close()


def test_a_lease_that_expires_during_the_paused_copy_discards_the_capture(tmp_path: Path, writer) -> None:
    proc, _log = writer
    rig = Rig(tmp_path / "a", scope_pids=[proc.pid])
    try:
        rig.boot()
        big = rig.home / "work" / "big.bin"
        with open(big, "wb") as fh:
            fh.write(os.urandom(1 << 20) * 300)  # 300 MiB, compared byte for byte while paused
        op, first = rig.capture()
        assert first["state"] == "staged"
        rig.finish(op)
        with open(big, "r+b") as fh:  # same size, same mtime: only the content changed
            st = os.fstat(fh.fileno())
            fh.seek(150 << 20)
            fh.write(b"X" * 16)
        os.utime(big, ns=(st.st_atime_ns, st.st_mtime_ns))
        op, job = rig.capture(
            "delta",
            {"checkpointId": new_id("ckp"), "treeDigest": first["treeDigest"]},
            lease={"targetMs": 1000, "hardMs": 1000},
        )
        if job["state"] == "staged":  # a fast disk compared it all within a second
            pytest.skip("the paused copy finished within the 1 s lease on this machine")
        assert job["state"] == "failed" and job["reason"] == "lease_expired", job
        assert _state(proc.pid) != "T"
        # The next capture, with time, catches the same-size same-mtime rewrite (IR-011).
        op, job = rig.capture("delta", {"checkpointId": new_id("ckp"), "treeDigest": first["treeDigest"]})
        assert job["state"] == "staged"
        index = json.loads((Path(job["layerDir"]) / ".cfo-layer" / "index.json").read_text())
        changed = {e["path"]: e for e in index["entries"]}
        import hashlib

        assert changed["work/big.bin"]["sha256"] == hashlib.sha256(big.read_bytes()).hexdigest()
    finally:
        rig.close()
