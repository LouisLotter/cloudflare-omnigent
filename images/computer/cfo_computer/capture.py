"""The capture worker: one bounded capture under a pause lease, in its own process.

Run as ``cfo_computer.capture <spec.json> <result.json>`` by the supervisor, so a crashed or
wedged worker exercises the lease guard exactly as a crashed controller would (S3, IR-012).

Sequence (design, "Capture sequence"):
 1. disk budget, with nothing paused;
 2. the unpaused copy into the kept snapshot;
 3. the lease guard, started, ready, then armed with the hard budget;
 4. pause: the workload cgroup frozen, or every workload process stopped by the guard;
 5. with everything paused, one scan of the home with the checkpoint policy, and the
    content-correct copy of exactly that scan;
 6. release (the guard resumes everything, at the latest at the deadline);
 7. after the resume: the index of the snapshot, a delta against the published index (or a
    base), and the staged layer, which WorkspaceDO uploads.
Any failure or an expired lease stages nothing. The kept snapshot stays: every capture's paused
pass compares contents, so a partly updated snapshot is never trusted as it is.
"""

from __future__ import annotations

import contextlib
import json
import os
import select
import shutil
import stat
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from . import freeze as F
from . import procs as P
from .contract import DECLARED_CREDENTIAL_PATHS, Contract
from .copier import (
    CopyFailed,
    Stopped,
    clean_temporaries,
    free_bytes,
    snapshot_paths,
    sync_snapshot,
    tree_bytes,
)
from .ids import iso
from .layers import StageError, diff, layer_index_document, stage_layer
from .policy import Policy
from .procutil import module_argv
from .tree import HashCache, make_entry, scan_home, tree_digest

#: The worker stops copying this long before the guard's own deadline, to release in time.
RELEASE_MARGIN_S = 0.1
GUARD_READY_S = 10.0


class CaptureFailed(Exception):
    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def _write_json(path: Path, value: Any) -> None:
    tmp = Path(f"{path}.tmp")
    tmp.write_text(json.dumps(value, separators=(",", ":"), ensure_ascii=False))
    os.replace(tmp, path)


class Guard:
    """The controller's side of the lease guard's line protocol."""

    def __init__(self, budget_s: float, log_path: Path, lease_id: str) -> None:
        self.proc = subprocess.Popen(
            module_argv(
                "cfo_computer.lease_guard",
                "--lease-id",
                lease_id,
                "--budget-s",
                repr(budget_s),
                "--log",
                str(log_path),
            ),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            start_new_session=True,
        )
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.out = self.proc.stdout
        self.inp = self.proc.stdin
        self.expired = False
        self.gone = False

    def wait_ready(self) -> None:
        ready, _, _ = select.select([self.out], [], [], GUARD_READY_S)
        if not ready or self.out.readline().decode().strip() != "ready":
            self.proc.kill()
            raise CaptureFailed("copy_failed", "the lease guard did not start")

    def send(self, line: str) -> None:
        try:
            self.inp.write((line + "\n").encode())
            self.inp.flush()
        except (BrokenPipeError, OSError) as exc:
            self.gone = True
            raise F.FreezeError("lease guard is gone") from exc

    def ask(self, line: str, expect: str) -> str:
        self.send(line)
        while True:
            raw = self.out.readline()
            if not raw:
                self.gone = True
                raise F.FreezeError("lease guard is gone")
            answer = raw.decode().strip()
            if answer == "expired":
                self.expired = True
                continue
            if answer.startswith("ok " + expect):
                return "ok"
            if answer.startswith("refused " + expect):
                return answer.split()[-1]

    def poll_expired(self) -> bool:
        """Non-blocking: whether the guard reported expiry (or went away)."""
        while True:
            ready, _, _ = select.select([self.out], [], [], 0)
            if not ready:
                return self.expired or self.gone
            raw = self.out.readline()
            if not raw:
                self.gone = True
                return True
            if raw.decode().strip() == "expired":
                self.expired = True

    def release(self) -> str:
        try:
            self.send("release")
        except F.FreezeError:
            return "gone"
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.out], [], [], max(0.0, deadline - time.monotonic()))
            if not ready:
                break
            raw = self.out.readline()
            if not raw:
                return "gone"
            answer = raw.decode().strip()
            if answer in ("released", "expired", "controller_lost", "protocol_error"):
                return answer
        return "gone"

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self.inp.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


def run_capture(spec: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """Fill ``result`` as the capture goes, so a failure still reports what happened."""
    t_start = time.monotonic()
    home = Path(spec["home"])
    snapshot = Path(spec["snapshot"])
    data_dir = Path(spec["data_dir"])
    log_dir = Path(spec["log_dir"])
    layer_id = spec["layer_id"]
    lease = spec["lease"]
    hard_s = lease["hardMs"] / 1000.0
    policy = Policy.load(Path(spec["policy_file"]))
    contract = Contract(Path(spec["schema_dir"]))
    declared = spec.get("declared", list(DECLARED_CREDENTIAL_PATHS))
    fault = spec.get("fault", "")
    paused_ms = 0
    result["layerId"] = layer_id

    snapshot.mkdir(parents=True, exist_ok=True)
    clean_temporaries(snapshot)

    # 1. Disk budget, nothing paused yet.
    first = scan_home(home, policy, declared=declared)
    need_total = sum(st.st_size for _rel, st in first.entries if stat.S_ISREG(st.st_mode))
    have = tree_bytes(snapshot)
    required = max(0, need_total - have) + int(spec.get("margin_bytes", 64 << 20))
    free = free_bytes(snapshot)
    result.update(sourceBytes=need_total, requiredBytes=required, freeBytes=free)
    if free < required:
        raise CaptureFailed("disk_budget", f"need {required} bytes, {free} free")

    # 2. The unpaused copy.
    t0 = time.monotonic()
    try:
        pre = sync_snapshot(home, snapshot, first.entries, content=False)
    except CopyFailed as exc:
        raise CaptureFailed(exc.reason, str(exc)) from exc
    result["unpausedCopy"] = {"s": round(time.monotonic() - t0, 3), "bytes": pre.copied_bytes}
    if fault == "fail_after_precopy":
        raise CaptureFailed("copy_failed", "injected")

    # 3. The guard, armed only once ready, so its start-up never eats the lease.
    guard = Guard(hard_s, log_dir / f"lease-{layer_id}.json", layer_id)
    try:
        guard.wait_ready()
        guard.send("arm")
        deadline = time.monotonic() + hard_s - RELEASE_MARGIN_S

        def lease_alive() -> bool:
            return time.monotonic() < deadline and not guard.poll_expired()

        def check() -> None:
            if not lease_alive():
                raise Stopped("lease over")

        supervisor_pid = int(spec["supervisor_pid"])
        workload = {int(p) for p in spec.get("workload_pids", [])}
        scope_pids = spec.get("scope_pids")
        cgroup_dir = spec.get("cgroup_dir")
        if cgroup_dir:
            fz: F.SignalFreezer | F.CgroupFreezer = F.CgroupFreezer(
                cgroup_dir, lambda cg: guard.ask(f"freeze {cg}", "freeze"), lease_alive
            )
        else:
            fz = F.SignalFreezer(
                lambda: {supervisor_pid, os.getpid(), guard.proc.pid},
                lambda: workload,
                lambda pid, start: guard.ask(f"stop {pid} {start}", f"stop {pid}"),
                lease_alive,
                # The whole container (every descendant of init) only when the supervisor
                # says it is the container's main process; otherwise only the named trees,
                # and none when none are named, so a test can never pause its host machine.
                scope=None
                if spec.get("whole_container")
                else (lambda: {int(p) for p in scope_pids or ()}),
            )
        t_pause = time.monotonic()
        failure: CaptureFailed | None = None
        paused_scan = None
        try:
            # 4. Pause.
            frozen = fz.freeze()
            running = fz.verify_frozen()
            if running:
                raise F.FreezeError(f"{len(running)} workload processes still running")
            result["stopped"] = len(frozen.stopped)
            result["mechanism"] = frozen.mechanism
            if spec.get("record_kinds"):
                result["stoppedByKind"] = P.kinds([pid for pid, _ in frozen.stopped])
            cut_at = time.time()
            if fault == "hang_paused":
                while True:
                    time.sleep(3600)
            if fault == "die_paused":
                os._exit(9)
            # 5. One scan while paused, and the content-correct copy of exactly it.
            paused_scan = scan_home(home, policy, declared=declared)
            check()
            stats = sync_snapshot(home, snapshot, paused_scan.entries, content=True, check=check)
            result["pausedCopy"] = {
                "comparedBytes": stats.compared_bytes,
                "copiedBytes": stats.copied_bytes,
                "copiedFiles": stats.copied_files,
                "removed": stats.removed,
            }
        except Stopped:
            failure = CaptureFailed("lease_expired", "the lease ended during the paused copy")
        except CopyFailed as exc:
            failure = CaptureFailed(exc.reason, str(exc))
        except F.FreezeError as exc:
            # The lease running out while pausing is an expired lease, whoever noticed first.
            over = guard.expired or time.monotonic() >= deadline
            failure = CaptureFailed("lease_expired" if over else "copy_failed", f"pause: {exc}")
        finally:
            # 6. Release. The guard resumes; if it is gone, resume what it confirmed ourselves.
            answer = guard.release()
            if answer == "gone":
                fz.thaw()
            paused_ms = int((time.monotonic() - t_pause) * 1000)
            result["pausedMs"] = paused_ms
            result["guard"] = answer
            result["overTarget"] = paused_ms > lease["targetMs"]
        if failure is None and answer != "released":
            failure = CaptureFailed("lease_expired", f"guard answered {answer}")
        if failure is not None:
            raise failure
    finally:
        guard.close()

    # 7. After the resume: index, delta, stage.
    assert paused_scan is not None
    rels = [rel for rel, _st in paused_scan.entries]
    if snapshot_paths(snapshot) != set(rels):
        raise CaptureFailed("stage_failed", "the snapshot differs from the paused scan")
    for rel in rels:
        if not policy.classify(rel).saved:
            raise CaptureFailed("policy_violation", "a path the policy does not save")
    cache_path = data_dir / "hash-cache.json"
    cache = HashCache.load(cache_path)
    entries = [
        make_entry(rel, os.lstat(snapshot / rel), str(snapshot / rel), cache) for rel in rels
    ]
    digest = tree_digest(entries)
    cache.save(cache_path)
    result.update(
        cutAt=iso(cut_at),
        treeDigest=digest,
        skipped=paused_scan.skipped,
        skippedExamples=paused_scan.examples,
    )
    kind = spec["kind"]
    parent_digest = None
    if kind == "delta":
        parent_digest = spec["parent"]["treeDigest"]
        parent_path = spec.get("parent_index")
        parent_entries = _load_json(Path(parent_path)) if parent_path else None
        if parent_entries is None or tree_digest(parent_entries) != parent_digest:
            raise CaptureFailed("parent_mismatch", "the parent is not the published index")
        changed, deleted = diff(parent_entries, entries)
        if not changed and not deleted:
            result.update(state="unchanged")
            return result
    else:
        changed = sorted(entries, key=lambda e: e["path"].encode("utf-8"))
        deleted = []
    document = layer_index_document(
        kind=kind,
        layer_id=layer_id,
        computer_id=spec["computer_id"],
        generation=int(spec["generation"]),
        entries=changed,
        deleted=deleted,
        tree_digest=digest,
        parent_tree_digest=parent_digest,
    )
    layer_dir = Path(spec["staged_root"]) / layer_id
    try:
        index_sha, nbytes = stage_layer(snapshot, layer_dir, document, contract)
    except (OSError, StageError, ValueError) as exc:
        shutil.rmtree(layer_dir, ignore_errors=True)
        raise CaptureFailed("stage_failed", type(exc).__name__) from exc
    _write_json(data_dir / f"pending-{layer_id}.json", entries)
    result.update(
        state="staged",
        layerDir=str(layer_dir),
        indexSha256=index_sha,
        entries=len(changed),
        deleted=len(deleted),
        bytes=nbytes,
        totalS=round(time.monotonic() - t_start, 3),
    )
    return result


def main() -> int:
    spec_path, result_path = Path(sys.argv[1]), Path(sys.argv[2])
    spec = _load_json(spec_path)
    result: dict[str, Any] = {"layerId": spec.get("layer_id")}
    try:
        run_capture(spec, result)
    except CaptureFailed as exc:
        result.update(state="failed", reason=exc.reason, detail=str(exc)[:300])
    except Exception as exc:  # noqa: BLE001 - any failure fails the capture, reported
        result.update(
            state="failed",
            reason="copy_failed",
            detail=type(exc).__name__,
            trace=traceback.format_exc(limit=5)[-1500:],
        )
    result.setdefault("pausedMs", 0)
    _write_json(result_path, result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
