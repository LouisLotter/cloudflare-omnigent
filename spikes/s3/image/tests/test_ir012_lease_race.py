"""IR-012: a target the guard already resumed must never be left stopped.

Reviewer's scenario, forced deterministically: the controller announces a
target, stalls until the lease has expired and the guard has resumed, then
stops the target late and dies before its own fallback resume. The capture
worker runs as a real process with the "stall_before_stop_then_die" fault, and
the target is a real process tree. Also: a live but delayed controller, a
process that was already stopped before the capture, a reused PID, and the
cgroup freezer's equivalent ordering.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest
from conftest import Target, base_spec, items_for, build_home, proc_state, wait_state

from supervisor import capture as C


def run_worker(tmp_path: Path, spec: dict) -> tuple[int, dict | None]:
    spec_path = tmp_path / f"spec-{uuid.uuid4().hex[:6]}.json"
    result_path = tmp_path / "result.json"
    spec_path.write_text(json.dumps(spec))
    p = subprocess.run([sys.executable, "-m", "supervisor.capture", str(spec_path), str(result_path)],
                       timeout=60, env={**os.environ, "PYTHONPATH": "/opt/s3"})
    res = json.loads(result_path.read_text()) if result_path.exists() else None
    return p.returncode, res


def small_items(tmp_path: Path) -> list[dict]:
    home = tmp_path / "home"
    build_home(home, plant_credentials=False)
    return items_for(home)


def assert_all_running(target: Target, within: float = 3.0) -> None:
    for pid in target.pids():
        st = wait_state(pid, {"S", "R", "D"}, within)
        assert st not in ("T", "t"), f"pid {pid} left stopped ({st})"


def test_late_stop_then_controller_death_pid_path(tmp_path: Path, target: Target) -> None:
    """notify -> expiry and resume -> late stop -> controller death."""
    spec = base_spec(tmp_path, small_items(tmp_path), tmp_path / "snap", target, budget_s=0.3,
                     fault="stall_before_stop_then_die", stall_extra_s=0.5, supervisor_pid=os.getpid())
    rc, _res = run_worker(tmp_path, spec)
    assert rc == -signal.SIGKILL, "the fault kills the controller right after its late stop"
    assert_all_running(target)
    # Only an unpublished partial copy can remain; the supervisor removes it.
    assert all(p.name.endswith(".partial") for p in (tmp_path / "snap").iterdir())


def test_delayed_live_controller_publishes_nothing(tmp_path: Path, target: Target) -> None:
    spec = base_spec(tmp_path, small_items(tmp_path), tmp_path / "snap", target, budget_s=0.3,
                     fault="stall_before_stop", stall_extra_s=0.5)
    rc, res = run_worker(tmp_path, spec)
    assert rc == 0 and res is not None
    assert res["outcome"] != "snapshot_ready", res
    assert_all_running(target)
    assert not [p for p in (tmp_path / "snap").iterdir() if not p.name.endswith(".partial")]


def test_prestopped_process_stays_stopped(tmp_path: Path, target: Target) -> None:
    """Something else stopped this process before the capture: never resume it."""
    child = target.children()[0]
    os.kill(child, signal.SIGSTOP)
    assert wait_state(child, {"T", "t"}, 2.0) in ("T", "t")
    res = C.capture(base_spec(tmp_path, small_items(tmp_path), tmp_path / "snap", target))
    assert res["outcome"] == "snapshot_ready", res
    assert proc_state(child) in ("T", "t"), "a pre-stopped process must stay stopped"
    assert proc_state(target.pid) not in ("T", "t")


def spawn_with_pid(pid: int, tries: int = 50) -> subprocess.Popen | None:
    """Start `sleep` with exactly this PID (privileged container: ns_last_pid)."""
    for _ in range(tries):
        try:
            Path("/proc/sys/kernel/ns_last_pid").write_text(str(pid - 1))
        except OSError:
            return None
        p = subprocess.Popen(["sleep", "1000"])
        if p.pid == pid:
            return p
        p.kill()
        p.wait()
    return None


class Single:
    """One sleeping process, our own child, so this test can reap it."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(["sleep", "1000"])
        self.pid = self.proc.pid


def test_reused_pid_is_never_resumed(tmp_path: Path) -> None:
    """Pid X is stopped for the capture; X dies and a new process gets pid X; something
    else stops the new one. The resume must not touch it (start-time identity check)."""
    a = Single()
    reused: dict = {}

    def after_stop(pid: int) -> None:
        if reused or pid != a.pid:
            return
        os.kill(pid, signal.SIGKILL)
        a.proc.wait(timeout=5)  # reap: pid X is free now
        p = spawn_with_pid(pid)
        if p is None:
            reused["skip"] = True
            return
        os.kill(p.pid, signal.SIGSTOP)
        wait_state(p.pid, {"T", "t"}, 2.0)
        reused["proc"] = p

    class Scope:
        pid = a.pid

    res = C.capture(base_spec(tmp_path, small_items(tmp_path), tmp_path / "snap", Scope,
                              hooks={"after_stop": after_stop}))
    if reused.get("skip"):
        pytest.skip("cannot choose the next PID in this container")
    p = reused["proc"]
    try:
        assert p.pid == a.pid
        time.sleep(0.5)
        assert proc_state(p.pid) in ("T", "t"), "the reused PID belongs to someone else and must stay stopped"
        assert res["outcome"] in ("snapshot_ready", "failed_freeze"), res
    finally:
        os.kill(p.pid, signal.SIGKILL)
        p.wait()


def cgroup_root() -> Path | None:
    root = Path("/sys/fs/cgroup")
    probe = root / f"s3test-{uuid.uuid4().hex[:6]}"
    try:
        probe.mkdir()
    except OSError:
        return None
    if not (probe / "cgroup.freeze").exists():
        probe.rmdir()
        return None
    return probe


def test_late_freeze_then_controller_death_cgroup_path(tmp_path: Path) -> None:
    cg = cgroup_root()
    if cg is None:
        pytest.skip("no writable cgroup v2 freezer in this container")
    t = Target()
    try:
        for pid in t.pids():
            (cg / "cgroup.procs").write_text(str(pid))
        spec = base_spec(tmp_path, small_items(tmp_path), tmp_path / "snap", None, budget_s=0.3,
                         mechanism="cgroup", cgroup_dir=str(cg),
                         fault="stall_before_stop_then_die", stall_extra_s=0.5)
        rc, _res = run_worker(tmp_path, spec)
        assert rc == -signal.SIGKILL
        time.sleep(1.0)
        events = (cg / "cgroup.events").read_text()
        assert "frozen 0" in events, events
    finally:
        (cg / "cgroup.freeze").write_text("0")
        t.kill()
        time.sleep(0.2)
        try:
            cg.rmdir()
        except OSError:
            pass


# The guard's own protocol: it is the only process that stops or resumes.


class Guard:
    def __init__(self, tmp_path: Path, budget: float) -> None:
        self.p = subprocess.Popen(
            [sys.executable, "-m", "supervisor.lease_guard", "--lease-id", "t", "--budget-s", str(budget),
             "--log", str(tmp_path / f"guard-{uuid.uuid4().hex[:6]}.json")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={**os.environ, "PYTHONPATH": "/opt/s3"})
        assert self.readline() == "ready"

    def send(self, line: str) -> None:
        assert self.p.stdin is not None
        self.p.stdin.write((line + "\n").encode())
        self.p.stdin.flush()

    def readline(self) -> str:
        assert self.p.stdout is not None
        return self.p.stdout.readline().decode().strip()

    def close(self) -> int:
        assert self.p.stdin is not None
        self.p.stdin.close()
        return self.p.wait(timeout=10)


def start_of(pid: int) -> int:
    raw = Path(f"/proc/{pid}/stat").read_text()
    return int(raw[raw.rindex(")") + 2 :].split()[19])


def test_guard_refuses_a_stop_after_expiry(tmp_path: Path, target: Target) -> None:
    g = Guard(tmp_path, 0.2)
    g.send("arm")
    time.sleep(0.4)
    assert g.readline() == "expired"
    pid = target.children()[0]
    g.send(f"stop {pid} {start_of(pid)}")
    assert g.readline() == f"refused stop {pid} expired"
    assert proc_state(pid) not in ("T", "t")
    g.close()


def test_guard_resumes_on_controller_loss(tmp_path: Path, target: Target) -> None:
    g = Guard(tmp_path, 30)
    g.send("arm")
    pid = target.children()[0]
    g.send(f"stop {pid} {start_of(pid)}")
    assert g.readline() == f"ok stop {pid}"
    assert wait_state(pid, {"T", "t"}, 2.0) in ("T", "t")
    assert g.close() == 0  # EOF: the controller is gone
    assert wait_state(pid, {"S", "R"}, 2.0) in ("S", "R")


def test_guard_refuses_a_reused_pid(tmp_path: Path, target: Target) -> None:
    g = Guard(tmp_path, 30)
    g.send("arm")
    pid = target.children()[0]
    g.send(f"stop {pid} {start_of(pid) + 1}")  # the start time the controller saw no longer matches
    assert g.readline() == f"refused stop {pid} identity"
    assert proc_state(pid) not in ("T", "t")
    g.close()


def test_guard_leaves_a_prestopped_process_alone(tmp_path: Path, target: Target) -> None:
    pid = target.children()[0]
    os.kill(pid, signal.SIGSTOP)
    wait_state(pid, {"T", "t"}, 2.0)
    g = Guard(tmp_path, 30)
    g.send("arm")
    g.send(f"stop {pid} {start_of(pid)}")
    assert g.readline() == f"refused stop {pid} prestopped"
    g.send("release")
    assert g.readline() == "released"
    g.close()
    assert proc_state(pid) in ("T", "t")
