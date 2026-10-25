"""Real guard/child traces; never signal an existing process or a shared cgroup."""

import json
import os
import select
import signal
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path

import pytest
from cfo_computer import procs

COMPUTER = Path(__file__).resolve().parents[3] / "images/computer"


def command(log, budget="0.4"):
    return [
        sys.executable,
        "-m",
        "cfo_computer.lease_guard",
        "--lease-id",
        "test-lease",
        "--budget-s",
        budget,
        "--log",
        str(log),
    ]


def env():
    return {**os.environ, "PYTHONPATH": str(COMPUTER)}


class Trace:
    def __init__(self, tmp):
        self.log = tmp / "guard.json"
        self.buffer = b""
        self.target = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        self.start = procs.read_stat(self.target.pid)[3]
        self.guard = subprocess.Popen(
            command(self.log),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env(),
        )

    def send(self, data):
        self.guard.stdin.write(data if isinstance(data, bytes) else (data + "\n").encode())
        self.guard.stdin.flush()

    def line(self, timeout=2):
        until = time.monotonic() + timeout
        while b"\n" not in self.buffer:
            left = until - time.monotonic()
            assert left > 0 and select.select([self.guard.stdout], [], [], left)[0], "reply timeout"
            chunk = os.read(self.guard.stdout.fileno(), 4096)
            assert chunk, "guard exited without reply"
            self.buffer += chunk
        line, _, self.buffer = self.buffer.partition(b"\n")
        return line.decode()

    def state(self, stopped):
        until = time.monotonic() + 1
        while time.monotonic() < until:
            if (procs.read_stat(self.target.pid)[0] in ("T", "t")) == stopped:
                return
            time.sleep(0.005)
        pytest.fail(f"owned child did not reach stopped={stopped}")

    def stop(self):
        self.send(f"stop {self.target.pid} {self.start}")
        assert self.line() == f"ok stop {self.target.pid}"
        self.state(True)

    def close(self):
        if not self.guard.stdin.closed:
            self.guard.stdin.close()
        try:
            self.guard.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.guard.kill()
            self.guard.wait(timeout=2)
        finally:
            self.guard.stdout.close()
            self.guard.stderr.close()
            if self.target.poll() is None:
                # Exact, unreaped child owned by this fixture, even on an assertion failure.
                self.target.send_signal(signal.SIGCONT)
                self.target.kill()
                self.target.wait(timeout=2)


@pytest.fixture
def trace(tmp_path):
    t = Trace(tmp_path)
    try:
        assert t.line() == "ready"
        yield t
    finally:
        t.close()


def test_unarmed_stop_and_freeze_have_no_effect(trace, tmp_path):
    cg = tmp_path / "fake-cgroup"
    cg.mkdir()
    (cg / "cgroup.freeze").write_text("0")
    trace.send(f"stop {trace.target.pid} {trace.start}")
    assert trace.line().endswith(" unarmed")
    trace.state(False)
    trace.send(f"freeze {cg}")
    assert trace.line() == "refused freeze unarmed"
    assert (cg / "cgroup.freeze").read_text() == "0"


@pytest.mark.parametrize("budget", ["nan", "inf", "-inf", "0", "-1", "40.001", "1e100"])
def test_invalid_budget_rejected_before_ready(tmp_path, budget):
    result = subprocess.run(
        command(tmp_path / "log", budget), env=env(), input=b"", capture_output=True, timeout=2
    )
    assert result.returncode != 0
    assert b"ready" not in result.stdout


@pytest.mark.parametrize("end", ["release", "expire", "eof", "sigterm"])
def test_normal_recovery_and_no_late_stop(trace, end):
    trace.send("arm")
    trace.stop()
    if end == "eof":
        trace.guard.stdin.close()
        assert trace.guard.wait(timeout=2) == 0
    else:
        if end == "release":
            trace.send("release")
        if end == "sigterm":
            trace.guard.send_signal(signal.SIGTERM)
        assert trace.line() == ("released" if end == "release" else "expired")
        trace.send("arm")  # must never resurrect an ended lease
        assert trace.line() == "refused arm ended"
        trace.send(f"stop {trace.target.pid} {trace.start}")
        assert trace.line().endswith(" expired")
    trace.state(False)


def test_duplicate_arm_cannot_extend_deadline(trace):
    trace.send("arm")
    trace.stop()
    time.sleep(0.2)
    trace.send("arm")
    assert trace.line() == "refused arm active"
    assert trace.line(timeout=0.35) == "expired"
    trace.state(False)


def test_release_before_arm_is_terminal(trace):
    trace.send("release")
    assert trace.line() == "released"
    trace.send("arm")
    assert trace.line() == "refused arm ended"
    trace.send(f"stop {trace.target.pid} {trace.start}")
    assert trace.line().endswith(" expired")
    trace.state(False)


@pytest.mark.parametrize(
    "malformed",
    [
        b"stop not-a-pid 1\n",
        b"stop\n",
        b"stop 1\n",
        b"stop -1 1\n",
        b"stop 0 1\n",
        b"stop 123 -1\n",
        b"release extra\n",
        b"freeze\n",
        b"\xff\n",
        b"unknown\n",
        b"arm extra\n",
        b"x" * 4097,
    ],
)
def test_malformed_input_ends_lease_and_resumes(trace, malformed):
    trace.send("arm")
    trace.stop()
    trace.send(malformed)
    assert trace.guard.wait(timeout=2) != 0
    trace.state(False)
    assert json.loads(trace.log.read_text())["outcome"] == "protocol_error"


def test_partial_command_eof_resumes(trace):
    trace.send("arm")
    trace.stop()
    trace.send(b"stop 123")
    trace.guard.stdin.close()
    trace.guard.wait(timeout=2)
    trace.state(False)


def test_malformed_input_thaws_fake_cgroup(trace, tmp_path):
    cg = tmp_path / "fake-cgroup"
    cg.mkdir()
    control = cg / "cgroup.freeze"
    control.write_text("0")
    trace.send("arm")
    trace.send(f"freeze {cg}")
    assert trace.line() == "ok freeze"
    assert control.read_text() == "1"
    trace.send(b"\xff\n")
    trace.guard.wait(timeout=2)
    assert control.read_text() == "0"


def test_wrong_identity_and_pre_stopped_target_are_not_owned(trace):
    trace.send("arm")
    trace.send(f"stop {trace.target.pid} {trace.start + 1}")
    assert trace.line().endswith(" identity")
    trace.state(False)
    trace.target.send_signal(signal.SIGSTOP)
    trace.state(True)
    trace.send(f"stop {trace.target.pid} {trace.start}")
    assert trace.line().endswith(" prestopped")
    trace.send("release")
    assert trace.line() == "released"
    trace.state(True)


def test_unread_stdout_cannot_hold_lease_open(trace):
    trace.send("arm")
    trace.stop()
    # Keep the controller pipe open and stop consuming guard replies. A nonblocking writer
    # bounds this probe even against the vulnerable implementation's full output pipe.
    fd = trace.guard.stdin.fileno()
    os.set_blocking(fd, False)
    request = f"stop {trace.target.pid} {trace.start}\n".encode()
    until = time.monotonic() + 0.8
    while time.monotonic() < until:
        with suppress(BlockingIOError):
            os.write(fd, request * 100)
        time.sleep(0.002)
    trace.state(False)


def test_failed_log_write_cannot_prevent_thaw(trace):
    trace.send("arm")
    trace.stop()
    Path(str(trace.log) + ".tmp").mkdir()  # force diagnostic write failure
    trace.send("release")
    assert trace.line() == "released"
    trace.guard.stdin.close()
    assert trace.guard.wait(timeout=2) != 0
    trace.state(False)


def test_cgroup_already_frozen_is_not_owned(trace, tmp_path):
    cg = tmp_path / "fake-cgroup"
    cg.mkdir()
    control = cg / "cgroup.freeze"
    control.write_text("1")
    trace.send("arm")
    trace.send(f"freeze {cg}")
    assert trace.line() == "refused freeze prestopped"
    trace.send("release")
    assert trace.line() == "released"
    assert control.read_text() == "1"


def test_stop_guard_itself_is_refused(trace):
    trace.send("arm")
    trace.stop()
    trace.send(f"stop {trace.guard.pid} {procs.read_stat(trace.guard.pid)[3]}")
    assert trace.guard.wait(timeout=2) != 0
    trace.state(False)
