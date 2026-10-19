"""Read the process table from /proc, as the supervisor sees it."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class Proc:
    pid: int
    ppid: int
    state: str
    comm: str
    starttime: int
    uid: int
    cmdline: list[str] = field(default_factory=list)

    @property
    def key(self) -> tuple[int, int]:
        """(pid, starttime): stable identity that survives pid reuse."""
        return (self.pid, self.starttime)

    def cmd(self) -> str:
        return " ".join(self.cmdline) if self.cmdline else f"[{self.comm}]"


def read_stat(pid: int) -> tuple[str, int, str, int] | None:
    """Return (state, ppid, comm, starttime) or None if the process is gone."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as fh:
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return None
    # comm is in parentheses and may contain spaces or parentheses.
    lpar = raw.index("(")
    rpar = raw.rindex(")")
    comm = raw[lpar + 1 : rpar]
    rest = raw[rpar + 2 :].split()
    state = rest[0]
    ppid = int(rest[1])
    starttime = int(rest[19])
    return state, ppid, comm, starttime


def read_proc(pid: int, *, with_cmdline: bool = True) -> Proc | None:
    st = read_stat(pid)
    if st is None:
        return None
    state, ppid, comm, starttime = st
    try:
        uid = os.stat(f"/proc/{pid}").st_uid
    except OSError:
        return None
    cmdline: list[str] = []
    if with_cmdline:
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                cmdline = [a.decode("utf-8", "replace") for a in fh.read().split(b"\0") if a]
        except OSError:
            pass
    return Proc(pid, ppid, state, comm, starttime, uid, cmdline)


def scan(*, with_cmdline: bool = True) -> dict[int, Proc]:
    """All processes visible in this PID namespace."""
    out: dict[int, Proc] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        p = read_proc(int(entry), with_cmdline=with_cmdline)
        if p is not None:
            out[p.pid] = p
    return out


def children_map(procs: dict[int, Proc]) -> dict[int, list[int]]:
    kids: dict[int, list[int]] = {}
    for p in procs.values():
        kids.setdefault(p.ppid, []).append(p.pid)
    return kids


def descendants(procs: dict[int, Proc], roots: set[int]) -> set[int]:
    """roots plus every process below them."""
    kids = children_map(procs)
    out: set[int] = set()
    stack = [r for r in roots if r in procs]
    while stack:
        pid = stack.pop()
        if pid in out:
            continue
        out.add(pid)
        stack.extend(kids.get(pid, []))
    return out


def fd_target(pid: int, fd: int) -> str | None:
    try:
        return os.readlink(f"/proc/{pid}/fd/{fd}")
    except OSError:
        return None
