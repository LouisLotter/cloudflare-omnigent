"""Count Omnigent runners from the supervisor's point of view.

How Omnigent starts runners (fork at /home/decay/Lervent/omnigent, branch
``cloudflare``, commit 90a9bed9a):

* The host daemon (``python -m omnigent.host._daemon_entry``) starts one zygote,
  ``python -P -m omnigent.runner._zygote`` (omnigent/host/runner_zygote.py).
* The zygote ``os.fork()``s one child per session: the runner. Each runner
  gets its own socketpair back to the zygote (``_handle_fork``: the zygote
  keeps ``z_end``, the runner keeps ``r_end``) and uses it to ask the zygote
  to fork its harness processes, which are ALSO the zygote's children
  (``_handle_fork_harness``). Harness children close every zygote socket.
* Every fork keeps the zygote's cmdline and initial environment, and in
  practice both runner and harness write to the runner's log, so neither
  ``/proc/<pid>/cmdline``, ``environ`` nor the stdout target can tell them
  apart (measured; see results/runner-count-*.json).
* If the zygote is unavailable the daemon falls back to a direct
  ``python -m omnigent.runner._entry`` child.

Rule used here: a runner is a zygote child that holds a unix socket whose peer
socket is held by the zygote. Peers come from sock_diag (``ss -x``, no
privilege needed). Reading another user's /proc/<pid>/fd needs that user's uid
or CAP_SYS_PTRACE (not in Docker's default set), so a forked child drops to
the workload uid to read them.
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any

from . import procs as P

ZYGOTE_MARK = "omnigent.runner._zygote"
ENTRY_MARK = "omnigent.runner._entry"
DAEMON_MARKS = ("omnigent.host._daemon_entry", "omnigent host")


def _read_fds(pids: list[int]) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for pid in pids:
        socks: list[int] = []
        stdout = ""
        try:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                t = P.fd_target(pid, int(fd)) or ""
                if t.startswith("socket:["):
                    socks.append(int(t[8:-1]))
                if fd == "1":
                    stdout = t
        except OSError:
            pass
        out[pid] = {"socks": socks, "stdout": stdout}
    return out


def fd_info(by_uid: dict[int, list[int]]) -> dict[int, dict[str, Any]]:
    """Socket inodes and stdout target per pid, dropping to each uid if root."""
    out: dict[int, dict[str, Any]] = {}
    for uid, pids in by_uid.items():
        if uid == os.getuid() or os.getuid() != 0:
            out.update(_read_fds(pids))
            continue
        r, w = os.pipe()
        child = os.fork()
        if child == 0:
            try:
                os.close(r)
                os.setgroups([])
                os.setgid(uid)
                os.setuid(uid)
                os.write(w, json.dumps(_read_fds(pids)).encode())
            finally:
                os._exit(0)
        os.close(w)
        chunks = []
        while True:
            b = os.read(r, 65536)
            if not b:
                break
            chunks.append(b)
        os.close(r)
        os.waitpid(child, 0)
        if chunks:
            out.update({int(k): v for k, v in json.loads(b"".join(chunks)).items()})
    return out


def stdout_targets(by_uid: dict[int, list[int]]) -> dict[int, str]:
    return {pid: v["stdout"] for pid, v in fd_info(by_uid).items()}


def unix_peers() -> dict[int, int]:
    """local inode -> peer inode for every connected unix stream socket."""
    p = subprocess.run(["ss", "-xH"], capture_output=True, text=True, check=False)
    peers: dict[int, int] = {}
    for line in p.stdout.splitlines():
        tok = line.split()
        if len(tok) < 4 or not tok[0].startswith("u_"):
            continue
        try:
            peers[int(tok[-3])] = int(tok[-1])
        except ValueError:
            continue
    return peers


def _is_daemon(p: P.Proc) -> bool:
    cmd = " ".join(p.cmdline)
    return any(m in cmd for m in DAEMON_MARKS)


def classify(procs: dict[int, P.Proc] | None = None) -> dict[str, Any]:
    procs = procs if procs is not None else P.scan()
    has_mark = {p.pid for p in procs.values() if ZYGOTE_MARK in " ".join(p.cmdline)}
    # A zygote is the exec'd forkserver; its forks carry the same cmdline.
    zygotes = sorted(pid for pid in has_mark if procs[pid].ppid not in has_mark)
    zset = set(zygotes)
    kids = [p for p in procs.values() if p.ppid in zset and p.state not in ("Z", "X")]
    by_uid: dict[int, list[int]] = {}
    for p in [*kids, *(procs[z] for z in zygotes)]:
        by_uid.setdefault(p.uid, []).append(p.pid)
    info = fd_info(by_uid)
    peers = unix_peers()
    runners: list[int] = []
    harnesses: list[int] = []
    for p in kids:
        zsocks = set(info.get(p.ppid, {}).get("socks", []))
        mine = info.get(p.pid, {}).get("socks", [])
        if any(peers.get(s) in zsocks for s in mine):
            runners.append(p.pid)
        else:
            harnesses.append(p.pid)
    direct = [p.pid for p in procs.values() if ENTRY_MARK in " ".join(p.cmdline) and p.state not in ("Z", "X")]
    return {
        "daemons": [p.pid for p in procs.values() if _is_daemon(p)],
        "zygotes": zygotes,
        "runners": sorted(runners + direct),
        "harnesses": sorted(harnesses),
        "direct_runners": sorted(direct),
        "runner_count": len(runners) + len(direct),
        # Naive counts, for comparison only.
        "zygote_children": len(kids),
        "runner_log_stdout": sum(1 for p in kids if "/logs/runner/" in info.get(p.pid, {}).get("stdout", "")),
    }
