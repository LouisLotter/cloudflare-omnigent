"""Capture worker: one bounded capture under a pause lease.

Run as its own process (``python -m supervisor.capture spec.json result.json``)
so that killing or wedging it exercises the lease guard, exactly like a crashed
or hung supervisor would.

Sequence (design, "Capture sequence", steps 2-4):
  budget check -> start guard -> pause -> verify -> copy -> release -> publish
  the local snapshot directory (rename) or discard it.
"""

from __future__ import annotations

import json
import os
import select
import shutil
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import asdict
from typing import Any

from . import freeze as F

# Fault-injection seams for the lease tests. Never set outside the spike.
FAULT_ENV = "S3_CAPTURE_FAULT"  # "hang_after_freeze" | "die_after_freeze" | "slow_copy:<s>"


def tree_size(path: str, excludes: list[str]) -> tuple[int, int]:
    """(bytes, files) under path, honoring simple name excludes."""
    total = 0
    files = 0
    names = {e.rstrip("/") for e in excludes}
    if os.path.isfile(path):
        st = os.lstat(path)
        return st.st_size, 1
    stack = [path]
    while stack:
        d = stack.pop()
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                if e.name in names:
                    continue
                try:
                    if e.is_dir(follow_symlinks=False):
                        stack.append(e.path)
                    else:
                        st = e.stat(follow_symlinks=False)
                        total += st.st_size
                        files += 1
                except OSError:
                    continue
    return total, files


def free_bytes(path: str) -> int:
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def copy_cmd(method: str, src: str, dst: str, excludes: list[str]) -> list[str]:
    ex: list[str] = []
    for e in excludes:
        ex += ["--exclude", e]
    if method in ("rsync", "rsync-incremental"):
        # -a: perms, times, symlinks, owners. --delete: incremental base may hold
        # files that no longer exist. --inplace avoids temp files on the target.
        s = src + "/" if os.path.isdir(src) else src
        return ["rsync", "-a", "--delete", "--inplace", *ex, s, dst]
    raise ValueError(method)


def run_copy(method: str, items: list[dict[str, Any]], snap: str) -> subprocess.Popen[bytes]:
    """Start the copy of all declared items as one shell pipeline."""
    steps: list[str] = []
    for it in items:
        src = it["src"]
        if not os.path.exists(src):
            continue
        dst = os.path.join(snap, it["name"])
        excludes = it.get("exclude", [])
        if method == "tar":
            ex = " ".join(f"--exclude={sh(e.rstrip('/'))}" for e in excludes)
            if os.path.isdir(src):
                steps.append(f"mkdir -p {sh(dst)} && tar -C {sh(src)} {ex} -cf - . | tar -C {sh(dst)} -xf -")
            else:
                steps.append(f"cp -p {sh(src)} {sh(dst)}")
        elif method == "reflink":
            # Copy-on-write clones (btrfs, XFS): data is shared, only metadata is
            # written. Excluded directories are cloned too, then removed.
            if os.path.isdir(src):
                names = " -o ".join(f"-name {sh(e.strip('/'))}" for e in excludes if "/" not in e.strip("/") and "*" not in e)
                prune = f" && find {sh(dst)} -depth \\( {names} \\) -exec rm -rf {{}} +" if names else ""
                steps.append(f"mkdir -p {sh(dst)} && cp -a --reflink=always {sh(src)}/. {sh(dst)}/{prune}")
            else:
                steps.append(f"cp -a --reflink=always {sh(src)} {sh(dst)}")
        elif method == "tar-zstd":
            ex = " ".join(f"--exclude={sh(e.rstrip('/'))}" for e in excludes)
            parent, base = os.path.split(src.rstrip("/"))
            steps.append(
                f"tar -C {sh(parent)} {ex} -cf - {sh(base)} | zstd -q -1 -T0 -o {sh(dst + '.tar.zst')}"
            )
        else:
            if os.path.isdir(src):
                steps.append(f"mkdir -p {sh(dst)}")
            steps.append(" ".join(sh(a) for a in copy_cmd(method, src, dst, excludes)))
    script = "set -eo pipefail\n" + "\n".join(steps) + "\n"
    return subprocess.Popen(
        ["bash", "-c", script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        # Own process group, so an expired lease can stop the whole pipeline
        # (bash, rsync's helpers, tar) and not just the shell.
        start_new_session=True,
    )


def sh(s: str) -> str:
    return "'" + s.replace("'", "'\"'\"'") + "'"


def capture(spec: dict[str, Any]) -> dict[str, Any]:
    t_start = time.monotonic()
    cid = spec.get("capture_id") or uuid.uuid4().hex[:12]
    root = spec["snapshot_root"]
    method = spec.get("method", "rsync")
    budget = float(spec.get("budget_s", 20.0))
    items = spec["items"]
    mechanism = spec.get("mechanism", "sigstop")
    res: dict[str, Any] = {"capture_id": cid, "method": method, "mechanism": mechanism, "budget_s": budget}

    # 1. Disk budget, outside the pause.
    t0 = time.monotonic()
    need = 0
    nfiles = 0
    for it in items:
        if os.path.exists(it["src"]):
            b, n = tree_size(it["src"], it.get("exclude", []))
            need += b
            nfiles += n
    base_dir = spec.get("incremental_base")
    reuse = 0
    if method == "rsync-incremental" and base_dir and os.path.isdir(base_dir):
        reuse, _ = tree_size(base_dir, [])
    margin = int(spec.get("margin_bytes", 64 * 1024 * 1024))
    free = free_bytes(root)
    required = max(0, need - reuse) + margin
    res.update(size_bytes=need, files=nfiles, free_bytes=free, required_bytes=required,
               budget_check_s=round(time.monotonic() - t0, 4))
    if free < required:
        res.update(outcome="skipped_no_space", published=False,
                   detail=f"need {required} bytes, {free} free")
        return res

    partial = os.path.join(root, f"{cid}.partial")
    final = os.path.join(root, cid)
    if method == "rsync-incremental" and base_dir and os.path.isdir(base_dir):
        os.rename(base_dir, partial)  # reuse the previous snapshot as the copy base
    else:
        os.makedirs(partial, exist_ok=False)

    if method == "rsync-2phase":
        # Phase 1, not paused: copy everything while the workload runs. The
        # result is inconsistent, but phase 2 (paused) only has to fix up the
        # files that changed since, so the pause no longer scales with size.
        t_pre = time.monotonic()
        pre = run_copy("rsync", items, partial)
        _, pre_err = pre.communicate()
        res["precopy_s"] = round(time.monotonic() - t_pre, 4)
        res["precopy_rc"] = pre.returncode
        if pre.returncode not in (0, 24):  # 24: files vanished while copying, expected
            shutil.rmtree(partial, ignore_errors=True)
            nospace = b"No space left on device" in pre_err
            res.update(outcome="failed_no_space" if nospace else "failed_copy", published=False,
                       copy_stderr=pre_err.decode(errors="replace")[-500:])
            return res
        method = "rsync"

    # 2. Lease guard, before anything is paused. Wait until it is ready, then
    # arm it: the lease clock starts only now, so guard start-up time can
    # never make the lease expire before the first process is stopped.
    guard_log = os.path.join(spec.get("log_dir", "/tmp"), f"lease-{cid}.json")
    guard = subprocess.Popen(
        [sys.executable, "-m", "supervisor.lease_guard", "--lease-id", cid,
         "--budget-s", repr(budget), "--log", guard_log],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    )
    assert guard.stdin is not None and guard.stdout is not None
    gin, gout = guard.stdin, guard.stdout
    r, _, _ = select.select([gout], [], [], 10.0)
    if not r or gout.readline().decode().strip() != "ready":
        guard.kill()
        shutil.rmtree(partial, ignore_errors=True)
        res.update(outcome="failed_guard", published=False)
        return res
    gin.write(b"arm\n")
    gin.flush()
    # Our deadline is never later than the guard's: it armed after we wrote.
    deadline = time.monotonic() + budget

    def notify(line: str) -> None:
        try:
            gin.write((line + "\n").encode())
            gin.flush()
        except BrokenPipeError as exc:
            raise F.FreezeError("lease guard is gone") from exc

    def may_stop() -> bool:
        # Never stop another process once the lease may have expired.
        return time.monotonic() < deadline

    main_pid = int(spec["supervisor_pid"])
    workload_roots = set(spec.get("workload_pids", []))

    def infra_roots() -> set[int]:
        return {main_pid, os.getpid(), guard.pid}

    def wl_roots() -> set[int]:
        return workload_roots

    if mechanism == "cgroup":
        fz: F.SignalFreezer | F.CgroupFreezer = F.CgroupFreezer(spec["cgroup_dir"], notify)
    else:
        fz = F.SignalFreezer(infra_roots, wl_roots, notify, may_stop)

    fault = os.environ.get(FAULT_ENV, spec.get("fault", ""))
    expired = False
    t_expired: float | None = None
    copy_rc: int | None = None
    copy_err = ""
    t_freeze0 = time.monotonic()
    try:
        fr = fz.freeze()
        t_frozen = time.monotonic()
        res["freeze"] = {k: v for k, v in asdict(fr).items() if k not in ("stopped",)}
        res["freeze"]["stopped_count"] = len(fr.stopped)
        res["running_after_freeze"] = fz.verify_frozen()

        if fault == "die_after_freeze":
            os.kill(os.getpid(), signal.SIGKILL)
        if fault == "hang_after_freeze":
            # A wedged controller: it never copies and never releases.
            while True:
                time.sleep(3600)

        # 3. Copy, watching the guard for expiry.
        cp = run_copy(method, items, partial)
        if fault.startswith("slow_copy:"):
            time.sleep(float(fault.split(":", 1)[1]))
        while True:
            rc = cp.poll()
            if rc is not None:
                copy_rc = rc
                break
            r, _, _ = select.select([gout], [], [], 0.01)
            if r:
                line = gout.readline().decode().strip()
                if line == "expired":
                    # The guard has already resumed everything at the deadline.
                    # Resume our own list too: SIGCONT is idempotent.
                    expired = True
                    t_expired = time.monotonic()
                    fz.thaw()
                    try:
                        os.killpg(cp.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    cp.wait()
                    copy_rc = -9
                    break
        assert cp.stderr is not None
        copy_err = cp.stderr.read().decode(errors="replace")[-2000:]
        t_copied = time.monotonic()
    except F.FreezeError as exc:
        # Resume whatever we stopped before giving up; the guard does too.
        res["freeze_error"] = str(exc)
        fz.thaw()
        t_frozen = t_copied = time.monotonic()

    # 4. Release: the guard resumes, and tells us whether the lease held.
    reply = ""
    if expired:
        # Tell a still-lingering guard we are done; it answers "expired".
        try:
            gin.write(b"release\n")
            gin.flush()
        except BrokenPipeError:
            pass
    else:
        try:
            gin.write(b"release\n")
            gin.flush()
            r, _, _ = select.select([gout], [], [], 5.0)
            reply = gout.readline().decode().strip() if r else ""
        except BrokenPipeError:
            reply = ""
        if reply == "expired":
            expired = True
        elif reply != "released":
            # Guard gone: resume ourselves. The copy is valid only if the lease
            # deadline had not passed (the guard thaws only at the deadline).
            fz.thaw()
            if time.monotonic() > deadline:
                expired = True
    t_resumed = time.monotonic()
    if t_expired is not None:
        t_resumed = t_expired
    try:
        gin.close()
    except OSError:
        pass
    guard.wait(timeout=5)

    pause_s = t_resumed - t_freeze0
    res.update(
        freeze_s=round(t_frozen - t_freeze0, 4),
        copy_s=round(t_copied - t_frozen, 4),
        release_s=round(t_resumed - t_copied, 4),
        pause_s=round(pause_s, 4),
        guard_reply=reply or ("expired" if expired else "none"),
        copy_rc=copy_rc,
    )
    try:
        with open(guard_log) as fh:
            res["guard"] = json.load(fh)
        resumed = [e for e in res["guard"]["events"] if e["event"] == "resumed"]
        if resumed:
            # When the guard resumed, by the same monotonic clock.
            res["pause_s_by_guard"] = round(resumed[0]["mono"] - t_freeze0, 4)
    except OSError:
        pass

    nospace = "No space left on device" in copy_err
    if expired or copy_rc != 0 or "freeze_error" in res:
        shutil.rmtree(partial, ignore_errors=True)
        if expired:
            outcome = "discarded_lease_expired"
        elif nospace:
            outcome = "failed_no_space"
        elif "freeze_error" in res:
            outcome = "failed_freeze"
        else:
            outcome = "failed_copy"
        res.update(outcome=outcome, published=False, copy_stderr=copy_err[-500:])
    else:
        os.rename(partial, final)
        snap_bytes, snap_files = tree_size(final, [])
        res.update(outcome="snapshot_ready", snapshot_dir=final, published=False,
                   snapshot_bytes=snap_bytes, snapshot_files=snap_files)
    res["total_s"] = round(time.monotonic() - t_start, 4)
    return res


def main() -> int:
    spec_path, result_path = sys.argv[1], sys.argv[2]
    with open(spec_path) as fh:
        spec = json.load(fh)
    res = capture(spec)
    tmp = result_path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(res, fh, indent=1)
    os.rename(tmp, result_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
