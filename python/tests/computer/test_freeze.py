"""Frozen verification must examine current state, not trust old bare PIDs."""

from unittest.mock import Mock

import pytest
from cfo_computer import freeze, procs


@pytest.mark.parametrize(
    ("state", "start", "expected"),
    [("S", 2, [10001]), ("S", 1, [10001]), ("T", 1, []), ("Z", 2, [])],
)
def test_prestopped_process_is_verified_again(monkeypatch, state, start, expected):
    old = procs.Proc(10001, 1, "T", "test", 1, 1000)
    stop = Mock()
    freezer = freeze.SignalFreezer(lambda: set(), lambda: set(), stop, scope=lambda: {old.pid})
    monkeypatch.setattr(procs, "scan", lambda **_: {old.pid: old})
    freezer.freeze()
    stop.assert_not_called()
    new = procs.Proc(old.pid, 1, state, "test", start, 1000)
    monkeypatch.setattr(procs, "scan", lambda **_: {new.pid: new})
    assert freezer.verify_frozen() == expected
    assert freezer.thaw() == 0  # never own/resume the pre-stopped target
    monkeypatch.setattr(procs, "scan", lambda **_: {})
    assert freezer.verify_frozen() == []


def test_thaw_never_signals_reused_pid(monkeypatch):
    monkeypatch.setattr(procs, "read_stat", lambda _: ("S", 1, "replacement", 99))
    kill = Mock()
    monkeypatch.setattr(freeze.os, "kill", kill)
    assert freeze.thaw_pids([(10001, 98)]) == 0
    kill.assert_not_called()
