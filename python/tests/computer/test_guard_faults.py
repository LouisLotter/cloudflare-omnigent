"""Fault injection supplements real process tests; no signals/cgroup writes here."""

import os
from io import StringIO
from unittest.mock import Mock

import pytest
from cfo_computer import lease_guard as guard


def test_resume_failure_does_not_skip_other_targets_and_is_retried(monkeypatch):
    lease = guard.LeaseGuard(1, lambda _: None)
    lease.stopped = {10001: 1, 10002: 2}
    lease.frozen = {"fake-a", "fake-b"}
    resumed, thawed = [], []

    def thaw_pids(entries):
        if entries == [(10001, 1)]:
            raise PermissionError("synthetic")
        resumed.extend(entries)
        return 1

    def thaw_cgroup(cg):
        if cg == "fake-a":
            raise PermissionError("synthetic")
        thawed.append(cg)

    monkeypatch.setattr(guard, "thaw_pids", thaw_pids)
    monkeypatch.setattr(guard, "thaw_cgroup", thaw_cgroup)
    lease.end("released")
    assert resumed == [(10002, 2)] and thawed == ["fake-b"]
    assert lease.stopped == {10001: 1} and lease.frozen == {"fake-a"}
    assert lease.state == "ended"
    monkeypatch.setattr(guard, "thaw_pids", lambda entries: resumed.extend(entries) or 1)
    monkeypatch.setattr(guard, "thaw_cgroup", thawed.append)
    lease.resume("retry")
    assert resumed == [(10002, 2), (10001, 1)]
    assert thawed == ["fake-b", "fake-a"]
    assert not lease.stopped and not lease.frozen


@pytest.mark.parametrize("failure", ["read", "reply"])
def test_unexpected_io_failure_runs_final_cleanup(monkeypatch, failure):
    say = Mock(side_effect=OSError("synthetic")) if failure == "reply" else Mock()
    lease = guard.LeaseGuard(1, say)
    lease.stopped = {10001: 1}
    thaw = Mock(return_value=1)
    monkeypatch.setattr(guard, "thaw_pids", thaw)
    monkeypatch.setattr(guard.select, "select", Mock(side_effect=OSError("synthetic")))
    assert lease.run(-1) == 2
    thaw.assert_called_once_with([(10001, 1)])
    assert lease.outcome == "guard_error"


def test_deadline_checked_again_after_process_inspection(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(guard.time, "monotonic", lambda: clock[0])
    lease = guard.LeaseGuard(1, Mock())
    lease.command(b"arm")

    def late_stat(_):
        clock[0] = 2.0
        return ("S", 1, "test", 1)

    kill = Mock()
    monkeypatch.setattr(guard.P, "read_stat", late_stat)
    monkeypatch.setattr(guard.os, "kill", kill)
    lease.stop(10001, 1)
    kill.assert_not_called()
    assert lease.outcome == "expired"


def test_cleanup_failure_is_reported_after_best_effort_final_sweep(monkeypatch):
    lease = guard.LeaseGuard(1, lambda _: None)
    lease.stopped = {10001: 1}
    thaw = Mock(side_effect=PermissionError("synthetic"))
    monkeypatch.setattr(guard, "thaw_pids", thaw)
    r, w = os.pipe()
    os.close(w)
    try:
        assert lease.run(r) == 2
    finally:
        os.close(r)
    assert thaw.call_count == 2
    assert lease.stopped == {10001: 1}
    assert any(e["event"] == "process_thaw_failed" for e in lease.events)


def test_cgroup_write_failure_after_effect_keeps_cleanup_ownership(monkeypatch):
    frozen = [False]

    class FailedWrite(StringIO):
        def write(self, value):
            frozen[0] = True
            raise OSError("synthetic write failed after effect")

    def fake_open(path, mode="r"):
        return FailedWrite() if mode == "w" else StringIO("0")

    monkeypatch.setattr(guard, "open", fake_open, raising=False)
    monkeypatch.setattr(guard, "thaw_cgroup", lambda _: frozen.__setitem__(0, False))
    lease = guard.LeaseGuard(1, lambda _: None)
    r, w = os.pipe()
    os.write(w, b"arm\nfreeze fake\n")
    os.close(w)
    try:
        assert lease.run(r) == 2
    finally:
        os.close(r)
    assert not frozen[0] and not lease.frozen
    assert lease.outcome == "guard_error"
