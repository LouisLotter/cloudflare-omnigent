"""Environment probe for the staging run (VD-13 and the inputs to the pause decision).

Only the real Containers platform can answer these, so the probe records them
as raw facts; every check catches its own failure and reports it as text:

* kernel, CPUs, memory and the cgroup's limits;
* filesystems, mount options and free space for the workspace, the snapshot
  area and the restore area;
* capabilities (CAP_KILL, CAP_SYS_PTRACE, ...), decoded;
* SIGSTOP and SIGCONT on another user's process;
* the cgroup v2 freezer: writable, and whether a frozen cgroup really stops a process;
* reflink copies within the snapshot area and from the workspace into it;
* disk throughput: a 1 GiB write with fdatasync, the read back cold (after
  posix_fadvise DONTNEED) and warm, and whether drop_caches is writable;
* small-file create and stat rates;
* ctime granularity: how often a content change keeps the same ctime, the
  condition a cheaper change journal would have to rule out;
* every process in the container, to see what the platform itself runs there
  (anything outside our entrypoint's tree is never paused).

  python -m supervisor.probe
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import signal
import subprocess
import time
from typing import Any

from . import procs as P

AGENT_UID = 1000
CAPS = {0: "CAP_CHOWN", 1: "CAP_DAC_OVERRIDE", 2: "CAP_DAC_READ_SEARCH", 3: "CAP_FOWNER", 5: "CAP_KILL",
        6: "CAP_SETGID", 7: "CAP_SETUID", 12: "CAP_NET_ADMIN", 19: "CAP_SYS_PTRACE", 21: "CAP_SYS_ADMIN",
        24: "CAP_SYS_RESOURCE"}


def sh(cmd: str, timeout: float = 300) -> str:
    try:
        p = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True, timeout=timeout)
        return (p.stdout + p.stderr).strip()
    except subprocess.TimeoutExpired:
        return f"timeout after {timeout}s"


def guarded(fn: Any) -> Any:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - a probe reports, never fails
        return f"error: {type(exc).__name__}: {exc}"[:300]


def caps() -> dict[str, Any]:
    out: dict[str, Any] = {}
    with open("/proc/self/status") as fh:
        for line in fh:
            if line.startswith(("CapEff", "CapBnd", "CapPrm")):
                k, v = line.split(":", 1)
                bits = int(v.strip(), 16)
                out[k] = {name: bool(bits >> b & 1) for b, name in CAPS.items()}
    return out


def meminfo() -> dict[str, int]:
    out = {}
    with open("/proc/meminfo") as fh:
        for line in fh:
            k, v = line.split(":", 1)
            if k in ("MemTotal", "MemAvailable", "Cached", "Dirty", "SwapTotal"):
                out[k] = int(v.split()[0]) * 1024
    return out


def agent_sleep(seconds: int) -> subprocess.Popen[bytes]:
    return subprocess.Popen(["setpriv", f"--reuid={AGENT_UID}", f"--regid={AGENT_UID}", "--init-groups",
                             "sleep", str(seconds)])


def state_of(pid: int) -> str:
    st = P.read_stat(pid)
    return st[0] if st else "gone"


def sigstop_other_uid() -> dict[str, Any]:
    p = agent_sleep(60)
    time.sleep(0.2)
    try:
        os.kill(p.pid, signal.SIGSTOP)
        time.sleep(0.1)
        stopped = state_of(p.pid)
        os.kill(p.pid, signal.SIGCONT)
        time.sleep(0.1)
        return {"stopped_state": stopped, "resumed_state": state_of(p.pid)}
    finally:
        p.kill()
        p.wait()


def cgroup_freezer() -> dict[str, Any]:
    out: dict[str, Any] = {"controllers": sh("cat /sys/fs/cgroup/cgroup.controllers"),
                           "self": sh("cat /proc/self/cgroup")}
    d = "/sys/fs/cgroup/s3probe"
    try:
        os.makedirs(d, exist_ok=True)
    except OSError as exc:
        out["writable"] = f"no: {exc}"
        return out
    out["writable"] = os.path.exists(os.path.join(d, "cgroup.freeze"))
    p = subprocess.Popen(["sleep", "60"])
    try:
        with open(os.path.join(d, "cgroup.procs"), "w") as fh:
            fh.write(str(p.pid))
        with open(os.path.join(d, "cgroup.freeze"), "w") as fh:
            fh.write("1")
        t0 = time.monotonic()
        frozen = False
        while time.monotonic() - t0 < 2:
            if "frozen 1" in open(os.path.join(d, "cgroup.events")).read():
                frozen = True
                break
            time.sleep(0.01)
        out["froze"] = frozen
        out["freeze_s"] = round(time.monotonic() - t0, 4)
        with open(os.path.join(d, "cgroup.freeze"), "w") as fh:
            fh.write("0")
        out["thawed"] = "frozen 0" in open(os.path.join(d, "cgroup.events")).read()
    except OSError as exc:
        out["freeze_test"] = f"error: {exc}"
    finally:
        p.kill()
        p.wait()
        try:
            # Move ourselves nowhere; the killed sleep has left the cgroup.
            os.rmdir(d)
        except OSError as exc:
            out["rmdir"] = str(exc)
    return out


def reflink() -> dict[str, str]:
    os.makedirs("/home/agent/work", exist_ok=True)
    return {
        "within_snapshot_area": sh("dd if=/dev/urandom of=/snap/.rl-src bs=1M count=8 status=none && "
                                   "cp --reflink=always /snap/.rl-src /snap/.rl-dst && echo ok; "
                                   "rm -f /snap/.rl-src /snap/.rl-dst"),
        "workspace_to_snapshot": sh("dd if=/dev/urandom of=/home/agent/work/.rl-src bs=1M count=8 status=none && "
                                    "cp --reflink=always /home/agent/work/.rl-src /snap/.rl-dst && echo ok; "
                                    "rm -f /home/agent/work/.rl-src /snap/.rl-dst"),
    }


def disk(mib: int = 1024) -> dict[str, Any]:
    path = "/snap/.ddtest"
    out: dict[str, Any] = {}
    try:
        t0 = time.monotonic()
        with open(path, "wb", buffering=0) as fh:
            block = os.urandom(4 << 20)
            for _ in range(mib // 4):
                fh.write(block)
            os.fdatasync(fh.fileno())
        out["write_fdatasync_mb_s"] = round(mib * 1.048576 / (time.monotonic() - t0), 1)

        def read_all() -> float:
            t = time.monotonic()
            with open(path, "rb", buffering=0) as fh:
                while fh.read(4 << 20):
                    pass
            return time.monotonic() - t

        fd = os.open(path, os.O_RDONLY)
        os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        os.close(fd)
        out["read_after_fadvise_mb_s"] = round(mib * 1.048576 / read_all(), 1)
        out["read_warm_mb_s"] = round(mib * 1.048576 / read_all(), 1)
        try:
            os.sync()
            with open("/proc/sys/vm/drop_caches", "w") as fh:
                fh.write("1")
            out["drop_caches"] = "writable"
            out["read_after_drop_caches_mb_s"] = round(mib * 1.048576 / read_all(), 1)
        except OSError as exc:
            out["drop_caches"] = f"not writable: {exc.strerror}"
    finally:
        if os.path.exists(path):
            os.unlink(path)
    return out


def small_files(n: int = 10000) -> dict[str, Any]:
    d = "/snap/.smalltest"
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
    data = b"x" * 4096
    try:
        t0 = time.monotonic()
        for i in range(n):
            with open(os.path.join(d, f"f{i:05d}"), "wb") as fh:
                fh.write(data)
        os.sync()
        create = time.monotonic() - t0
        t0 = time.monotonic()
        for i in range(n):
            os.lstat(os.path.join(d, f"f{i:05d}"))
        st = time.monotonic() - t0
        return {"files": n, "create_and_sync_per_s": round(n / create), "stat_per_s": round(n / st)}
    finally:
        shutil.rmtree(d, ignore_errors=True)


def ctime_granularity(n: int = 2000) -> dict[str, Any]:
    """Rewrite one file n times with new same-size content, a stat between each.

    ``same_ctime`` counts rewrites that left (mtime, ctime) unchanged: a change
    journal keyed on them would miss those changes. Kernels with multigrain
    timestamps (6.13+, on supported filesystems) should report zero.
    """
    path = "/home/agent/work/.ctime-probe"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    same = 0
    deltas: list[int] = []
    try:
        with open(path, "wb") as fh:
            fh.write(b"0" * 64)
        prev = os.stat(path)
        for i in range(1, n + 1):
            with open(path, "r+b") as fh:
                fh.write(f"{i:064d}".encode())
            cur = os.stat(path)
            if (cur.st_ctime_ns, cur.st_mtime_ns) == (prev.st_ctime_ns, prev.st_mtime_ns):
                same += 1
            else:
                deltas.append(cur.st_ctime_ns - prev.st_ctime_ns)
            prev = cur
    finally:
        if os.path.exists(path):
            os.unlink(path)
    positive = sorted(d for d in deltas if d > 0)
    return {"rewrites": n, "same_ctime": same,
            "min_ctime_step_ns": positive[0] if positive else None,
            "median_ctime_step_ns": positive[len(positive) // 2] if positive else None}


def processes() -> list[dict[str, Any]]:
    procs = P.scan()
    me = os.getpid()
    tree = P.descendants(procs, {os.getppid()}) if os.getppid() > 0 else set(procs)
    return [{"pid": p.pid, "ppid": p.ppid, "uid": p.uid, "kind": P.kind(p, procs), "comm": p.comm,
             "in_entrypoint_tree": p.pid in tree, "self": p.pid == me}
            for p in sorted(procs.values(), key=lambda x: x.pid)]


def probe() -> dict[str, Any]:
    t0 = time.monotonic()
    out: dict[str, Any] = {
        "kernel": platform.release(),
        "cpus": os.cpu_count(),
        "nproc": sh("nproc"),
        "meminfo": guarded(meminfo),
        "cgroup_limits": sh("for f in memory.max memory.high cpu.max io.max; do echo $f: "
                            "$(cat /sys/fs/cgroup/$f 2>&1); done"),
        "mounts": sh("for p in / /home/agent /snap /restore-staging /var/lib /sys/fs/cgroup; do "
                     "findmnt -no TARGET,SOURCE,FSTYPE,OPTIONS -T $p; done"),
        "df": sh("df -B1 --output=target,fstype,size,avail / /snap /restore-staging 2>&1"),
        "block_devices": sh("lsblk -o NAME,SIZE,ROTA,TYPE,MOUNTPOINT 2>&1 | head -20; "
                            "cat /sys/block/*/queue/rotational 2>/dev/null | head -5"),
        "caps": guarded(caps),
        "sigstop_other_uid": guarded(sigstop_other_uid),
        "cgroup_freezer": guarded(cgroup_freezer),
        "reflink": guarded(reflink),
        "proc_fd_other_uid": sh("setpriv --reuid=1000 --regid=1000 --init-groups sleep 30 >/dev/null 2>&1 & p=$!; "
                                "sleep 0.2; readlink /proc/$p/fd/1 >/dev/null && echo readable || echo denied; kill $p"),
        "disk": guarded(disk),
        "small_files": guarded(small_files),
        "ctime_granularity": guarded(ctime_granularity),
        "processes": guarded(processes),
    }
    out["probe_s"] = round(time.monotonic() - t0, 1)
    return out


if __name__ == "__main__":
    print(json.dumps(probe(), indent=1))
