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
import tempfile
import time
import uuid
from dataclasses import asdict
from typing import Any

from . import credpolicy
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


METHODS = ("rsync", "rsync-2phase", "rsync-incremental", "reflink")


def rsync_argv(src: str, dst: str, it: dict[str, Any], *, final: bool) -> list[str]:
    """One rsync of one declared root.

    -a: perms, times, symlinks, owners. --delete and --delete-excluded: a
    reused snapshot may hold files that no longer exist or are now excluded.
    final: the destination already holds an earlier copy (the two-phase second
    pass, or a reused snapshot), so compare contents, not size and mtime
    (IR-011): rsync's quick check skips a same-size rewrite within the same
    second, or one that kept its mtime, and the snapshot kept the old bytes.
    """
    ex: list[str] = []
    for pattern in credpolicy.rsync_excludes(it):
        ex += ["--exclude", pattern]
    s = src + "/" if os.path.isdir(src) else src
    content = ["--checksum"] if final else []
    return ["rsync", "-a", *content, "--no-specials", "--no-devices", "--delete", "--delete-excluded",
            "--inplace", *ex, s, dst]


def copy_steps(method: str, items: list[dict[str, Any]], snap: str, *, final: bool = True) -> list[list[str]]:
    """The copy as a list of separate commands, one or two per declared root."""
    if method not in METHODS:
        raise ValueError(f"unknown copy method {method!r}")
    steps: list[list[str]] = []
    for it in items:
        src = it["src"]
        if not os.path.lexists(src):
            continue
        dst = os.path.join(snap, it["name"])
        is_dir = os.path.isdir(src) and not os.path.islink(src)
        if method == "reflink":
            # Copy-on-write clones (btrfs, XFS): data is shared, only metadata is
            # written. Excluded files are cloned too and pruned afterwards.
            if is_dir:
                steps.append(["mkdir", "-p", dst])
                steps.append(["cp", "-a", "--reflink=always", src + "/.", dst + "/"])
            else:
                steps.append(["cp", "-a", "--reflink=always", src, dst])
        else:
            if is_dir:
                steps.append(["mkdir", "-p", dst])
            steps.append(rsync_argv(src, dst, it, final=final))
    return steps


class CopyRunner:
    """Runs the copy steps one after another (IR-016).

    The first step that exits with a status outside ``ok`` fails the whole
    copy; nothing later runs and the failure is reported. A shell script with
    ``set -e`` hid a failed ``cp`` inside an ``&&`` list when a later root
    succeeded. Each step runs in its own process group, so an expired lease
    can kill it whole.
    """

    def __init__(self, steps: list[list[str]], ok: tuple[int, ...] = (0,)) -> None:
        self.steps = steps
        self.ok = set(ok)
        self.i = -1
        self.cur: subprocess.Popen[bytes] | None = None
        self.rc: int | None = None
        self.failed_step: list[str] | None = None
        self._err = tempfile.TemporaryFile()
        self._next()

    def _next(self) -> None:
        self.i += 1
        if self.i >= len(self.steps):
            self.rc = 0
            self.cur = None
            return
        self.cur = subprocess.Popen(self.steps[self.i], stdout=subprocess.DEVNULL, stderr=self._err,
                                    start_new_session=True)

    def poll(self) -> int | None:
        while self.rc is None:
            assert self.cur is not None
            r = self.cur.poll()
            if r is None:
                return None
            if r not in self.ok:
                self.rc = r
                self.failed_step = self.steps[self.i]
                return r
            self._next()
        return self.rc

    def wait(self) -> int:
        while self.poll() is None:
            time.sleep(0.005)
        assert self.rc is not None
        return self.rc

    def kill(self) -> None:
        if self.cur is not None and self.cur.poll() is None:
            try:
                os.killpg(self.cur.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.cur.wait()
        if self.rc is None:
            self.rc = -9

    def stderr(self) -> str:
        self._err.seek(0)
        return self._err.read().decode(errors="replace")[-2000:]


def capture(spec: dict[str, Any]) -> dict[str, Any]:
    t_start = time.monotonic()
    cid = spec.get("capture_id") or uuid.uuid4().hex[:12]
    root = spec["snapshot_root"]
    method = spec.get("method", "rsync")
    budget = float(spec.get("budget_s", 20.0))
    items = spec["items"]
    mechanism = spec.get("mechanism", "sigstop")
    # In-process test hooks (callables); never set by the supervisor.
    hooks = spec.get("hooks") or {}
    res: dict[str, Any] = {"capture_id": cid, "method": method, "mechanism": mechanism, "budget_s": budget}
    if method not in METHODS:
        res.update(outcome="failed_method", published=False, detail=f"unknown copy method {method!r}")
        return res

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
        # 24: files vanished while copying, expected while the workload runs.
        pre = CopyRunner(copy_steps("rsync", items, partial, final=False), ok=(0, 24))
        pre_rc = pre.wait()
        res["precopy_s"] = round(time.monotonic() - t_pre, 4)
        res["precopy_rc"] = pre_rc
        # Test seam (IR-011): change files between the two passes.
        if hooks.get("after_precopy"):
            hooks["after_precopy"]()
        if pre_rc != 0:
            shutil.rmtree(partial, ignore_errors=True)
            pre_err = pre.stderr()
            nospace = "No space left on device" in pre_err
            res.update(outcome="failed_no_space" if nospace else "failed_copy", published=False,
                       copy_stderr=pre_err[-500:], failed_step=pre.failed_step)
            return res
    paused_method = "reflink" if method == "reflink" else "rsync"

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

    guard_state = {"expired_seen": False, "gone": False}

    def ask_guard(line: str, expect_prefix: str) -> str:
        """Send one request and wait for its answer; the guard does the stopping
        (IR-012). Returns "ok" or the guard's reason for refusing."""
        try:
            gin.write((line + "\n").encode())
            gin.flush()
        except BrokenPipeError as exc:
            guard_state["gone"] = True
            raise F.FreezeError("lease guard is gone") from exc
        while True:
            raw = gout.readline()
            if not raw:
                guard_state["gone"] = True
                raise F.FreezeError("lease guard is gone")
            ans = raw.decode().strip()
            if ans == "expired":
                guard_state["expired_seen"] = True
                continue
            if ans.startswith("ok " + expect_prefix):
                return "ok"
            if ans.startswith("refused " + expect_prefix):
                return ans.split()[-1]

    def request_stop(pid: int, start: int) -> str:
        return ask_guard(f"stop {pid} {start}", f"stop {pid}")

    def request_freeze(cg: str) -> str:
        return ask_guard(f"freeze {cg}", "freeze")

    def lease_alive() -> bool:
        return time.monotonic() < deadline and not guard_state["expired_seen"]

    main_pid = int(spec["supervisor_pid"])
    workload_roots = set(spec.get("workload_pids", []))

    def infra_roots() -> set[int]:
        return {main_pid, os.getpid(), guard.pid}

    def wl_roots() -> set[int]:
        return workload_roots

    fault = os.environ.get(FAULT_ENV, spec.get("fault", ""))
    stalled = {"done": False}

    def before_stop(_pid: int) -> None:
        # Fault seam (IR-012): stall after finding a target and before its stop,
        # until the lease has expired and the guard has resumed everything.
        if fault.startswith("stall_before_stop") and not stalled["done"]:
            time.sleep(max(0.0, deadline - time.monotonic()) + float(spec.get("stall_extra_s", 0.5)))

    def after_stop(_pid: int) -> None:
        # ...then, for the "then_die" variant, the controller dies right after its late stop
        # attempt (with the guard as the authority, the guard refused that stop).
        if fault == "stall_before_stop_then_die" and not stalled["done"]:
            os.kill(os.getpid(), signal.SIGKILL)
        stalled["done"] = True
        if hooks.get("after_stop"):
            hooks["after_stop"](_pid)

    scope_pid = spec.get("scope_pid")
    scope = (lambda: {int(scope_pid)}) if scope_pid else None
    if mechanism == "cgroup":
        fz: F.SignalFreezer | F.CgroupFreezer = F.CgroupFreezer(
            spec["cgroup_dir"], request_freeze, lease_alive, before_stop=before_stop, after_stop=after_stop)
    else:
        fz = F.SignalFreezer(infra_roots, wl_roots, request_stop, lease_alive, scope=scope,
                             before_stop=before_stop, after_stop=after_stop)

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
        # The destination holds an earlier copy for two-phase and incremental:
        # the paused pass must compare contents (IR-011). A full copy into an
        # empty directory copies every file anyway.
        reused = method in ("rsync-2phase", "rsync-incremental")
        cp = CopyRunner(copy_steps(paused_method, items, partial, final=reused))
        if fault.startswith("slow_copy:"):
            time.sleep(float(fault.split(":", 1)[1]))
        while True:
            rc = cp.poll()
            if rc is not None:
                copy_rc = rc
                break
            r, _, _ = select.select([gout], [], [], 0.01)
            if r:
                raw = gout.readline()
                line = raw.decode().strip()
                if line == "expired" or not raw:
                    # The guard has resumed everything at the deadline (or is gone):
                    # this copy can no longer be consistent.
                    expired = True
                    t_expired = time.monotonic()
                    guard_state["gone"] = guard_state["gone"] or not raw
                    cp.kill()
                    if guard_state["gone"]:
                        fz.thaw()  # fallback: nobody else is left to resume
                    copy_rc = -9
                    break
        copy_err = cp.stderr()
        res["failed_step"] = cp.failed_step
        t_copied = time.monotonic()
    except F.FreezeError as exc:
        # The guard resumes what it stopped when we release below; we resume
        # ourselves only if the guard itself is gone.
        res["freeze_error"] = str(exc)
        if guard_state["gone"]:
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
    prune_error = None
    if not (expired or copy_rc != 0 or "freeze_error" in res):
        # 5. Enforce the exclusions on the finished copy, after the resume: the
        # snapshot is local and fixed now. Any failure discards it (IR-016).
        try:
            res["pruned"] = credpolicy.prune(partial, items)
        except Exception as exc:  # noqa: BLE001 - any prune failure invalidates the snapshot
            prune_error = f"{type(exc).__name__}: {exc}"[:300]
    if expired or copy_rc != 0 or "freeze_error" in res or prune_error:
        shutil.rmtree(partial, ignore_errors=True)
        if expired:
            outcome = "discarded_lease_expired"
        elif nospace:
            outcome = "failed_no_space"
        elif "freeze_error" in res:
            outcome = "failed_freeze"
        elif prune_error:
            outcome = "failed_prune"
            res["prune_error"] = prune_error
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
