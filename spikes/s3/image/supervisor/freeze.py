"""Pause and resume every process except the supervisor's own.

Two mechanisms:

* SignalFreezer: SIGSTOP each target, repeating the /proc scan until a pass
  finds no new process (a process forked between scans is caught by the next
  pass; a stopped process cannot fork). Works in any container where the
  supervisor runs as root. Processes that were already stopped are recorded
  and left stopped on resume.
* CgroupFreezer: cgroup v2 ``cgroup.freeze`` on a cgroup holding the whole
  workload. Atomic, includes forks, but needs a writable cgroupfs.

Both report every target to ``notify`` BEFORE stopping it, so the lease guard
always knows what to resume even if the caller dies mid-freeze.
"""

from __future__ import annotations

import os
import signal
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from . import procs as P

Notify = Callable[[str], None]


class FreezeError(RuntimeError):
    pass


@dataclass
class FreezeResult:
    mechanism: str
    stopped: list[tuple[int, int]] = field(default_factory=list)  # (pid, starttime)
    prestopped: list[int] = field(default_factory=list)
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
        notify: Notify,
        may_stop: Callable[[], bool] = lambda: True,
    ) -> None:
        self._infra_roots = infra_roots
        self._workload_roots = workload_roots
        self._notify = notify
        self._may_stop = may_stop
        self.result = FreezeResult(self.mechanism)
        self._stopped: dict[int, int] = {}  # pid -> starttime (ours to resume)
        self._seen: set[tuple[int, int]] = set()

    def freeze(self, settle_timeout_s: float = 2.0) -> FreezeResult:
        t0 = time.monotonic()
        res = self.result
        while True:
            res.passes += 1
            procs = P.scan(with_cmdline=False)
            keep = infra_pids(procs, self._infra_roots(), self._workload_roots())
            new = [p for p in procs.values() if p.pid not in keep and p.key not in self._seen]
            if not new:
                break
            for p in new:
                self._seen.add(p.key)
                if p.state == "Z" or p.state == "X":
                    continue
                if p.state in ("T", "t"):
                    # Stopped by someone else (job control, debugger): never resume it.
                    res.prestopped.append(p.pid)
                    continue
                if not self._may_stop():
                    raise FreezeError("lease deadline reached while pausing")
                # Write-ahead: the guard learns the pid before it is stopped.
                self._notify(f"pid {p.pid} {p.starttime}")
                try:
                    os.kill(p.pid, signal.SIGSTOP)
                except ProcessLookupError:
                    continue
                self._stopped[p.pid] = p.starttime
                res.stopped.append(p.key)
        t1 = time.monotonic()
        res.signal_s = t1 - t0
        # Signal delivery is asynchronous; wait until every target reports 'T'.
        deadline = t1 + settle_timeout_s
        pending = set(self._stopped)
        while pending and time.monotonic() < deadline:
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
        prestopped = set(self.result.prestopped)
        return sorted(
            p.pid
            for p in procs.values()
            if p.pid not in keep and p.state not in ("T", "t", "Z", "X") and p.pid not in prestopped
        )

    def thaw(self) -> int:
        n = 0
        for pid, start in list(self._stopped.items()):
            st = P.read_stat(pid)
            if st is None or st[3] != start:
                continue  # gone, or pid reused: never signal a stranger
            try:
                os.kill(pid, signal.SIGCONT)
                n += 1
            except ProcessLookupError:
                pass
        self._stopped.clear()
        return n


def thaw_pids(entries: list[tuple[int, int]]) -> int:
    """Resume (pid, starttime) entries; used by the lease guard."""
    n = 0
    for pid, start in entries:
        st = P.read_stat(pid)
        if st is None or st[3] != start:
            continue
        try:
            os.kill(pid, signal.SIGCONT)
            n += 1
        except ProcessLookupError:
            pass
    return n


class CgroupFreezer:
    mechanism = "cgroup"

    def __init__(self, cgroup_dir: str, notify: Notify) -> None:
        self._dir = cgroup_dir
        self._notify = notify
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
        self._notify(f"cgroup {self._dir}")
        with open(os.path.join(self._dir, "cgroup.freeze"), "w") as fh:
            fh.write("1")
        t1 = time.monotonic()
        self.result.signal_s = t1 - t0
        self.result.passes = 1
        deadline = t1 + settle_timeout_s
        while not self._frozen():
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
        thaw_cgroup(self._dir)
        return len(self.result.stopped)


def thaw_cgroup(cgroup_dir: str) -> None:
    with open(os.path.join(cgroup_dir, "cgroup.freeze"), "w") as fh:
        fh.write("0")
