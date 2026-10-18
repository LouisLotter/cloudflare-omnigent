"""Environment probe and self-contained capture bench, for the staging run.

In staging there is no Omnigent server, mock or MinIO, so the supervisor runs
the measurements that only the real Containers platform can answer:

* /probe: kernel, filesystem types, disk size and free space, CPUs, memory,
  capabilities, whether cgroupfs is writable (cgroup freezer), whether
  root may read another user's /proc/<pid>/fd, whether reflink copies work.
* /bench: generate a workspace profile, start the busy writer and some idle
  processes, then run captures and report pause and copy times.
"""

from __future__ import annotations

import json
import os
import platform
import statistics
import subprocess
import time
from typing import Any


def sh(cmd: str) -> str:
    p = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True, timeout=120)
    return (p.stdout + p.stderr).strip()


def probe() -> dict[str, Any]:
    out: dict[str, Any] = {
        "kernel": platform.release(),
        "cpus": os.cpu_count(),
        "nproc": sh("nproc"),
        "mem": sh("grep -E 'MemTotal|MemAvailable' /proc/meminfo"),
        "mounts": sh("for p in / /home/agent /snap /sys/fs/cgroup; do findmnt -no TARGET,FSTYPE,OPTIONS -T $p; done"),
        "df": sh("df -B1 --output=target,fstype,size,avail / /snap 2>&1"),
        "caps": sh("grep Cap /proc/self/status"),
        "cgroup": sh("cat /proc/self/cgroup; ls /sys/fs/cgroup | head -30; cat /sys/fs/cgroup/cgroup.controllers 2>&1"),
    }
    try:
        os.makedirs("/sys/fs/cgroup/s3probe", exist_ok=True)
        out["cgroup_writable"] = os.path.exists("/sys/fs/cgroup/s3probe/cgroup.freeze")
        os.rmdir("/sys/fs/cgroup/s3probe")
    except OSError as exc:
        out["cgroup_writable"] = f"no: {exc}"
    out["reflink"] = sh(
        "dd if=/dev/urandom of=/snap/.rl-src bs=1M count=8 status=none && "
        "cp --reflink=always /snap/.rl-src /snap/.rl-dst && echo reflink-ok; rm -f /snap/.rl-src /snap/.rl-dst"
    )
    out["proc_fd_other_uid"] = sh("setpriv --reuid=1000 --regid=1000 --init-groups sleep 30 >/dev/null 2>&1 & p=$!; "
                                  "sleep 0.2; readlink /proc/$p/fd/1 && echo readable || echo denied; kill $p")
    out["seq_write_1g"] = sh("dd if=/dev/zero of=/snap/.ddtest bs=4M count=256 conv=fdatasync 2>&1 | tail -1; rm -f /snap/.ddtest")
    return out


def bench(body: dict[str, Any], run_capture: Any, as_agent_argv: Any) -> dict[str, Any]:
    profile = body.get("profile", "realistic")
    runs = int(body.get("runs", 5))
    methods = body.get("methods", ["rsync", "tar"])
    env = {"PYTHONPATH": "/opt/s3", "HOME": "/home/agent"}
    t0 = time.monotonic()
    g = subprocess.run(as_agent_argv(["/opt/venv/bin/python", "-m", "supervisor.genws", profile]),
                       env={**os.environ, **env}, capture_output=True, text=True, timeout=3600)
    gen_s = time.monotonic() - t0
    subprocess.run(as_agent_argv(["bash", "-c",
                                  "nohup /opt/venv/bin/python -m supervisor.writer /home/agent/work/writer.log >/dev/null 2>&1 & "
                                  "for i in $(seq 50); do nohup sleep 100000 >/dev/null 2>&1 & done"]),
                   env={**os.environ, **env})
    rows = []
    for method in methods:
        for cold in (False, True):
            for _ in range(runs):
                if cold:
                    subprocess.run(as_agent_argv(["/opt/venv/bin/python", "-m", "supervisor.genws", "evict"]),
                                   env={**os.environ, **env}, capture_output=True)
                res = run_capture({"method": method, "budget_s": float(body.get("budget_s", 85))})
                rows.append({"method": method, "cold": cold, **{k: res.get(k) for k in (
                    "outcome", "pause_s", "freeze_s", "copy_s", "size_bytes", "files", "mechanism")}})
                if res.get("snapshot_dir"):
                    subprocess.run(["rm", "-rf", res["snapshot_dir"]])
    subprocess.run(["pkill", "-f", "supervisor.writer"])
    subprocess.run(["pkill", "-f", "sleep 100000"])
    summary = {}
    for method in methods:
        for cold in (False, True):
            xs = [r["pause_s"] for r in rows if r["method"] == method and r["cold"] == cold and r["pause_s"]]
            if xs:
                summary[f"{method}-{'cold' if cold else 'warm'}"] = {
                    "median": round(statistics.median(xs), 3), "worst": round(max(xs), 3), "n": len(xs)}
    return {"profile": profile, "gen": g.stdout.strip()[-200:], "gen_s": round(gen_s, 1),
            "summary": summary, "rows": rows, "probe": probe()}


if __name__ == "__main__":
    print(json.dumps(probe(), indent=1))
