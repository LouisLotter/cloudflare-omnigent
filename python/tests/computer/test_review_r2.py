"""Regression tests for the lead's scoped Codex verification of WP3.4 (r2): the stop journal's
ownership and timing (findings 3 and 5) and credential aliases across layers (finding 2). The
RC-53 findings (1, 4 and 6) are tested in ``test_rc53.py``.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
from cfo_computer import capture as CAP
from cfo_computer.tree import tree_digest
from harness import Rig, Uploads, canary, new_id

SPIN = "import time\nwhile True: time.sleep(0.01)"


def _state(pid: int) -> str:
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]


def _start(pid: int) -> int:
    return int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19])


@pytest.fixture
def procs():
    started: list[subprocess.Popen[bytes]] = []

    def spawn() -> subprocess.Popen[bytes]:
        proc = subprocess.Popen([sys.executable, "-c", SPIN])
        started.append(proc)
        return proc

    yield spawn
    for proc in started:
        proc.kill()
        proc.wait()


def _journal(path: Path, lines: list[str]) -> Path:
    path.write_text("".join(f"{line}\n" for line in lines))
    return path


# -- 5. replay resumes only what the capture asked for and has not seen refused or released --


def test_replay_never_touches_a_refused_stop_or_a_cgroup_already_frozen(tmp_path, procs) -> None:
    mine, theirs = procs(), procs()
    os.kill(mine.pid, signal.SIGSTOP)
    os.kill(theirs.pid, signal.SIGSTOP)  # someone else's stop: the guard refused it
    cgroup = tmp_path / "cg"
    cgroup.mkdir()
    (cgroup / "cgroup.freeze").write_text("1")  # frozen before the capture: refused
    journal = _journal(
        tmp_path / "j",
        [
            "deadline 0",
            f"req {mine.pid} {_start(mine.pid)}",
            f"req {theirs.pid} {_start(theirs.pid)}",
            f"refused {theirs.pid} {_start(theirs.pid)}",
            f"req cgroup {cgroup}",
            f"refused cgroup {cgroup}",
        ],
    )
    time.sleep(0.05)
    assert CAP.resume_journal(journal) == 1
    time.sleep(0.05)
    assert _state(mine.pid) != "T"
    assert _state(theirs.pid) == "T", "another actor's stop is not ours to undo"
    assert (cgroup / "cgroup.freeze").read_text() == "1"
    os.kill(theirs.pid, signal.SIGCONT)


def test_replay_after_a_conclusive_release_leaves_a_later_stop_alone(tmp_path, procs) -> None:
    proc = procs()
    journal = _journal(
        tmp_path / "j",
        [f"req {proc.pid} {_start(proc.pid)}", f"ok {proc.pid} {_start(proc.pid)}", "released"],
    )
    os.kill(proc.pid, signal.SIGSTOP)  # job control, after the capture let it go
    time.sleep(0.05)
    assert CAP.resume_journal(journal) == 0
    assert _state(proc.pid) == "T"
    os.kill(proc.pid, signal.SIGCONT)


def test_replay_resumes_an_unanswered_stop_whatever_its_state_and_retires_it(
    tmp_path, procs, monkeypatch
) -> None:
    """A stop the guard sent but never acknowledged is resumed by PID and start time, whatever
    the process's state: a SIGCONT also cancels a SIGSTOP still pending on a process in
    uninterruptible sleep (``D``), which a state check would skip (Codex r2, finding 3)."""
    stopped, running, reused = procs(), procs(), procs()
    os.kill(stopped.pid, signal.SIGSTOP)
    journal = _journal(
        tmp_path / "j",
        [
            f"req {stopped.pid} {_start(stopped.pid)}",
            f"req {running.pid} {_start(running.pid)}",  # as if its stop were still pending
            f"req {reused.pid} {_start(reused.pid) + 1}",  # the PID now names another process
        ],
    )
    time.sleep(0.05)
    sent = []
    real = os.kill

    def recording(pid, sig):
        sent.append((pid, sig))
        return real(pid, sig)

    monkeypatch.setattr(os, "kill", recording)
    assert CAP.resume_journal(journal) == 2
    monkeypatch.undo()
    assert (stopped.pid, signal.SIGCONT) in sent and (running.pid, signal.SIGCONT) in sent
    assert all(pid != reused.pid for pid, _ in sent), "never a reused PID"
    assert _state(stopped.pid) != "T"
    assert journal.read_text().splitlines()[-1] == "released"
    assert CAP.resume_journal(journal) == 0, "replayed once"


def test_unresolved_follows_the_journal() -> None:
    lines = ["deadline 5", "req 10 1", "ok 10 1", "req 11 2", "refused 11 2", "req cgroup /c"]
    assert sorted(CAP.unresolved(lines)) == [("10", "1"), ("cgroup", "/c")]
    assert CAP.unresolved([*lines, "released"]) == []
    assert CAP.unresolved([*lines, "released", "req 12 3"]) == [("12", "3")]


# -- 3. independent recovery within the pause's own bound -------------------------------------


def test_a_dead_guard_and_a_stuck_worker_are_recovered_by_the_pause_deadline(tmp_path) -> None:
    proc = subprocess.Popen([sys.executable, "-c", SPIN])
    rig = Rig(tmp_path / "a", scope_pids=[proc.pid])
    try:
        rig.boot()
        rig.sup.capture_fault = "guard_dies_after_stop_worker_hangs"
        rig.sup.capture_grace_s = 120.0  # the worker's own limit is far away
        op = new_id("op")
        status, reply = rig.send(
            "capture",
            op=op,
            layerId=new_id("lyr"),
            kind="base",
            parent=None,
            policyVersion=1,
            lease={"targetMs": 1000, "hardMs": 2000},
        )
        assert status == 200, reply
        journal = rig.layout.log / f"capture-{op}.stops"
        end = time.monotonic() + 10
        while time.monotonic() < end and _state(proc.pid) != "T":
            time.sleep(0.01)
        assert _state(proc.pid) == "T", "the guard stopped it, then died unanswered"
        stopped_at = time.monotonic()
        while time.monotonic() < stopped_at + 10 and _state(proc.pid) == "T":
            time.sleep(0.05)
        assert _state(proc.pid) != "T", "resumed within the pause's bound"
        assert time.monotonic() - stopped_at < 2.0 + 1.0 + 1.5
        assert rig.ok("job_status", jobOperationId=op)["job"]["state"] == "running"
        assert journal.read_text().splitlines()[-1] == "released"
    finally:
        proc.kill()
        for child in Path("/proc").iterdir():  # the stuck worker
            if child.name.isdigit():
                try:
                    cmd = (child / "cmdline").read_bytes()
                except OSError:
                    continue
                if b"cfo_computer.capture" in cmd and str(rig.root).encode() in cmd:
                    os.kill(int(child.name), signal.SIGKILL)
        rig.close()


# -- 2. a credential in one layer, its hard link in another ----------------------------------


def test_restore_strips_an_alias_of_a_credential_in_another_layer(tmp_path: Path) -> None:
    uploads = Uploads(tmp_path / "r2")
    a = Rig(tmp_path / "a")
    try:
        a.boot()
        (a.home / "work" / "f.txt").write_text("content")
        op, base = a.capture()
        uploads.upload(base)
        a.finish(op)
        (a.home / "work" / "g.txt").write_text("more")
        op, delta = a.capture(
            "delta", {"checkpointId": new_id("ckp"), "treeDigest": base["treeDigest"]}
        )
        uploads.upload(delta)
        a.finish(op)
    finally:
        a.close()
    secret = canary("crosslayer")
    (job0, idx0), (job1, idx1) = uploads.jobs
    base_dir, delta_dir = uploads.root / idx0["layerId"], uploads.root / idx1["layerId"]
    (base_dir / ".codex").mkdir()
    (base_dir / ".codex" / "auth.json").write_text(secret)
    os.link(base_dir / ".codex" / "auth.json", delta_dir / "work" / "alias")
    st = os.lstat(delta_dir / "work" / "alias")
    digest = hashlib.sha256(secret.encode()).hexdigest()
    entry = {
        "type": "file",
        "mode": st.st_mode & 0o7777,
        "uid": st.st_uid,
        "gid": st.st_gid,
        "size": len(secret),
        "sha256": digest,
    }
    idx0["entries"] += [
        {"path": ".codex", "type": "dir", "mode": 0o700, "uid": st.st_uid, "gid": st.st_gid},
        {"path": ".codex/auth.json", **entry},
    ]
    idx1["entries"] += [{"path": "work/alias", **entry}]
    for job, idx, layer_dir, parent in (
        (job0, idx0, base_dir, None),
        (job1, idx1, delta_dir, idx0),
    ):
        idx["entries"].sort(key=lambda e: e["path"].encode())
        whole = {e["path"]: e for e in (parent["entries"] if parent else [])}
        whole.update({e["path"]: e for e in idx["entries"]})
        idx["treeDigest"] = tree_digest(whole.values())
        if parent is not None:
            idx["parentTreeDigest"] = parent["treeDigest"]
        data = json.dumps(idx).encode()
        (layer_dir / ".cfo-layer" / "index.json").write_bytes(data)
        job.update(indexSha256=hashlib.sha256(data).hexdigest(), treeDigest=idx["treeDigest"])
    b = Rig(tmp_path / "b", computer_id=a.computer_id, generation=4)
    try:
        dirs = []
        for _job, idx in uploads.jobs:  # keep the cross-layer link: move, do not copy
            dst = b.layout.restore / idx["layerId"]
            os.rename(uploads.root / idx["layerId"], dst)
            dirs.append(str(dst))
        assert os.lstat(Path(dirs[1]) / "work" / "alias").st_nlink == 2
        job = b.restore(uploads.manifest(a.computer_id, 3), dirs)
        assert job["state"] == "done" and job["stripped"] == 2, job
        assert not (b.home / "work" / "alias").exists()
        assert (b.home / "work" / "g.txt").read_text() == "more"
        for dirpath, _dirs, files in os.walk(b.home):
            for name in files:
                assert secret.encode() not in (Path(dirpath) / name).read_bytes()
    finally:
        b.close()
