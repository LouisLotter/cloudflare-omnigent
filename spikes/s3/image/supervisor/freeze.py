"""Pause every process except the supervisor's own, through the lease guard.

Two mechanisms:

* SignalFreezer: find each target in /proc and ask the guard to SIGSTOP it,
  repeating the scan until a pass finds no new process (a process forked
  between scans is caught by the next pass; a stopped process cannot fork).
  Works in any container where the supervisor runs as root. Processes that
  were already stopped are left alone.
* CgroupFreezer: ask the guard to set cgroup v2 ``cgroup.freeze`` on the
  cgroup holding the whole workload. Atomic, includes forks, but needs a
  writable cgroupfs.

The guard (lease_guard.py) performs every stop and every resume (IR-012), so
the controller here only discovers targets and waits for them to settle.
``thaw`` is the controller's fallback for a guard that died.
"""

from __future__ import annotations

import os
import signal
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import procs as P

# request_stop(pid, starttime) -> "ok" or the guard's reason for refusing.
RequestStop = Callable[[int, int], str]
RequestFreeze = Callable[[str], str]


class FreezeError(RuntimeError):
    pass


@dataclass
class FreezeResult:
    mechanism: str
    stopped: list[tuple[int, int]] = field(default_factory=list)  # (pid, starttime)
    prestopped: list[int] = field(default_factory=list)
    refused: list[tuple[int, str]] = field(default_factory=list)
    passes: int = 0
    signal_s: float = 0.0
    settle_s: float = 0.0
    not_settled: list[int] = field(default_factory=list)


def infra_pids(procs: dict[int, P.Proc], infra_roots: set[int], workload_roots: set[int]) -> set[int]:
    """Processes that must never be paused.

    PID 1 (tini), the infra roots (supervisor main, capture worker, lease guard,
    upload shim) and all their descendants, EXCEPT the workload subtrees that the
    supervisor itself launched (the host daemon and everything below it).
    """
    keep = {1} | P.descendants(procs, infra_roots)
    return keep - P.descendants(procs, workload_roots)


class SignalFreezer:
    mechanism = "sigstop"

    def __init__(
        self,
        infra_roots: Callable[[], set[int]],
        workload_roots: Callable[[], set[int]],
        request_stop: RequestStop,
        lease_alive: Callable[[], bool] = lambda: True,
        scope: Callable[[], set[int]] | None = None,
        before_stop: Callable[[int], None] | None = None,
        after_stop: Callable[[int], None] | None = None,
    ) -> None:
        self._infra_roots = infra_roots
        self._workload_roots = workload_roots
        self._request_stop = request_stop
        self._lease_alive = lease_alive
        # Test seams. scope: only these roots' trees are candidates (tests must
        # never pause the rest of the machine). before/after_stop: fault hooks.
        self._scope = scope
        self._before_stop = before_stop
        self._after_stop = after_stop
        self.result = FreezeResult(self.mechanism)
        self._stopped: dict[int, int] = {}  # pid -> starttime, confirmed stopped by the guard
        self._seen: set[tuple[int, int]] = set()

    def _candidates(self, procs: dict[int, P.Proc]) -> set[int]:
        if self._scope is None:
            return set(procs)
        return P.descendants(procs, self._scope())

    def freeze(self, settle_timeout_s: float = 2.0) -> FreezeResult:
        t0 = time.monotonic()
        res = self.result
        while True:
            res.passes += 1
            procs = P.scan(with_cmdline=False)
            keep = infra_pids(procs, self._infra_roots(), self._workload_roots())
            cand = self._candidates(procs)
            new = [p for p in procs.values() if p.pid in cand and p.pid not in keep and p.key not in self._seen]
            if not new:
                break
            for p in new:
                self._seen.add(p.key)
                if p.state in ("Z", "X"):
                    continue
                if p.state in ("T", "t"):
                    # Stopped by someone else (job control, debugger): never resume it.
                    res.prestopped.append(p.pid)
                    continue
                if self._before_stop:
                    self._before_stop(p.pid)
                answer = self._request_stop(p.pid, p.starttime)
                if self._after_stop:
                    self._after_stop(p.pid)
                if answer == "ok":
                    self._stopped[p.pid] = p.starttime
                    res.stopped.append(p.key)
                elif answer == "expired":
                    raise FreezeError("lease expired while pausing; the guard refused the stop")
                elif answer == "prestopped":
                    res.prestopped.append(p.pid)
                else:
                    res.refused.append((p.pid, answer))  # gone, or the PID was reused
        t1 = time.monotonic()
        res.signal_s = t1 - t0
        # Signal delivery is asynchronous; wait until every target reports 'T'.
        deadline = t1 + settle_timeout_s
        pending = set(self._stopped)
        while pending and time.monotonic() < deadline:
            if not self._lease_alive():
                raise FreezeError("lease expired while waiting for targets to stop")
            for pid in list(pending):
                st = P.read_stat(pid)
                if st is None or st[0] in ("T", "t", "Z", "X") or st[3] != self._stopped[pid]:
                    pending.discard(pid)
            if pending:
                time.sleep(0.002)
        res.settle_s = time.monotonic() - t1
        res.not_settled = sorted(pending)
        if pending:
            raise FreezeError(f"processes did not stop within {settle_timeout_s}s: {sorted(pending)}")
        return res

    def verify_frozen(self) -> list[int]:
        """Pids outside the infra set that are running now (should be empty)."""
        procs = P.scan(with_cmdline=False)
        keep = infra_pids(procs, self._infra_roots(), self._workload_roots())
        cand = self._candidates(procs)
        prestopped = set(self.result.prestopped)
        return sorted(
            p.pid
            for p in procs.values()
            if p.pid in cand and p.pid not in keep and p.state not in ("T", "t", "Z", "X") and p.pid not in prestopped
        )

    def thaw(self) -> int:
        """Fallback only, for a guard that died: resume what the guard confirmed stopping."""
        n = thaw_pids(list(self._stopped.items()))
        self._stopped.clear()
        return n


def thaw_pids(entries: list[tuple[int, int]]) -> int:
    """Resume (pid, starttime) entries whose process still has that start time."""
    n = 0
    for pid, start in entries:
        st = P.read_stat(pid)
        if st is None or st[3] != start:
            continue  # gone, or pid reused: never signal a stranger
        try:
            os.kill(pid, signal.SIGCONT)
            n += 1
        except ProcessLookupError:
            pass
    return n


class CgroupFreezer:
    mechanism = "cgroup"

    def __init__(
        self,
        cgroup_dir: str,
        request_freeze: RequestFreeze,
        lease_alive: Callable[[], bool] = lambda: True,
        before_stop: Callable[[int], None] | None = None,
        after_stop: Callable[[int], None] | None = None,
    ) -> None:
        self._dir = cgroup_dir
        self._request_freeze = request_freeze
        self._lease_alive = lease_alive
        self._before_stop = before_stop
        self._after_stop = after_stop
        self._frozen_by_guard = False
        self.result = FreezeResult(self.mechanism)

    def _frozen(self) -> bool:
        with open(os.path.join(self._dir, "cgroup.events")) as fh:
            for line in fh:
                k, _, v = line.partition(" ")
                if k == "frozen":
                    return v.strip() == "1"
        return False

    def freeze(self, settle_timeout_s: float = 2.0) -> FreezeResult:
        t0 = time.monotonic()
        if self._before_stop:
            self._before_stop(0)
        answer = self._request_freeze(self._dir)
        if self._after_stop:
            self._after_stop(0)
        if answer != "ok":
            raise FreezeError(f"the guard refused to freeze the cgroup: {answer}")
        self._frozen_by_guard = True
        t1 = time.monotonic()
        self.result.signal_s = t1 - t0
        self.result.passes = 1
        deadline = t1 + settle_timeout_s
        while not self._frozen():
            if not self._lease_alive():
                raise FreezeError("lease expired while waiting for the cgroup to freeze")
            if time.monotonic() > deadline:
                raise FreezeError("cgroup did not report frozen")
            time.sleep(0.001)
        self.result.settle_s = time.monotonic() - t1
        with open(os.path.join(self._dir, "cgroup.procs")) as fh:
            self.result.stopped = [(int(x), 0) for x in fh.read().split()]
        return self.result

    def verify_frozen(self) -> list[int]:
        return [] if self._frozen() else [-1]

    def thaw(self) -> int:
        """Fallback only, for a guard that died."""
        if self._frozen_by_guard:
            thaw_cgroup(self._dir)
            self._frozen_by_guard = False
        return len(self.result.stopped)


def thaw_cgroup(cgroup_dir: str) -> None:
    with open(os.path.join(cgroup_dir, "cgroup.freeze"), "w") as fh:
        fh.write("0")
