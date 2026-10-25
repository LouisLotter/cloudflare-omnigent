"""Unavailable process/socket evidence must never be reported as confirmed idle."""

import os
import subprocess
from unittest.mock import Mock

import pytest
from cfo_computer import procs, runners


@pytest.fixture
def observed(monkeypatch):
    z = procs.Proc(10001, 1, "S", "python", 1, os.getuid(), [runners.ZYGOTE_MARK])
    r = procs.Proc(10002, z.pid, "S", "python", 2, os.getuid(), z.cmdline)
    fds = {
        z.pid: {"socks": [10], "stdout": "", "complete": True},
        r.pid: {"socks": [20], "stdout": "", "complete": True},
    }
    monkeypatch.setattr(runners, "fd_info", lambda _: fds)
    monkeypatch.setattr(
        runners.subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess(a, 0, "u_str ESTAB 0 0 * 20 * 10\n", ""),
    )
    return {z.pid: z, r.pid: r}, fds


def test_valid_runner_and_harness_observations(observed):
    table, fds = observed
    assert runners.classify(table)["runner_count"] == 1
    fds[10002]["socks"] = []
    assert runners.classify(table)["runner_count"] == 0


@pytest.mark.parametrize("failure", ["exit", "missing", "timeout", "malformed"])
def test_failed_socket_diagnostic_is_unknown(observed, monkeypatch, failure):
    table, _ = observed

    def run(*a, **k):
        if failure == "missing":
            raise FileNotFoundError("synthetic")
        if failure == "timeout":
            raise subprocess.TimeoutExpired("ss", 2)
        return subprocess.CompletedProcess(
            a,
            1 if failure == "exit" else 0,
            "u_str incomplete\n" if failure == "malformed" else "",
            "",
        )

    monkeypatch.setattr(runners.subprocess, "run", run)
    result = runners.classify(table)
    assert result["runner_count"] > 0
    assert result["unknown"]
    assert result["harnesses"] == []


@pytest.mark.parametrize("failure", ["absent", "incomplete", "child", "peer-missing"])
def test_partial_fd_observation_is_unknown(observed, monkeypatch, failure):
    table, fds = observed
    if failure == "absent":
        del fds[10002]
    elif failure == "incomplete":
        fds[10002]["complete"] = False
    elif failure == "peer-missing":
        monkeypatch.setattr(runners, "unix_peers", lambda: {})
    else:

        def failed(_):
            raise ChildProcessError("synthetic inspection failure")

        monkeypatch.setattr(runners, "fd_info", failed)
    result = runners.classify(table)
    assert result["runner_count"] > 0 and result["unknown"]


@pytest.mark.parametrize("failure", ["list", "link"])
def test_unreadable_fd_observation_is_marked_partial(monkeypatch, failure):
    def denied(*_):
        raise PermissionError("synthetic")

    monkeypatch.setattr(runners.os, "listdir", denied if failure == "list" else lambda _: ["1"])
    monkeypatch.setattr(runners.os, "readlink", denied)
    assert runners._read_fds([10001])[10001]["complete"] is False


@pytest.mark.parametrize("status", [0, 256, 9])
def test_inspection_child_failure_or_empty_response_is_not_empty_success(monkeypatch, status):
    # Exercise the real parent pipe/reap path without forking or changing credentials.
    monkeypatch.setattr(runners.os, "getuid", lambda: 0)
    monkeypatch.setattr(runners.os, "fork", lambda: 12345)
    wait = Mock(return_value=(12345, status))
    monkeypatch.setattr(runners.os, "waitpid", wait)
    with pytest.raises(ChildProcessError):
        runners.fd_info({1000: [10001]})
    wait.assert_called_once_with(12345, 0)
