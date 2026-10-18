"""Criteria 3 and 4: a blocked store and a full disk.

blocked   Publish a baseline checkpoint. Capture again, start the upload, and
          block MinIO (docker pause: connections hang, like a black-holed
          store) for --block seconds (> 90). During the block: conversation
          turns every 10 s in three sessions, the host's state every second,
          and one more capture (its pause must not depend on the store).
          Two upload policies: "short" (20 s request timeout, 3 attempts:
          fails during the block) and "patient" (deadline long enough to
          finish after the block ends).
fulldisk  Snapshots go to a 48 MB tmpfs. (a) the pre-flight check sees the
          workspace does not fit: the capture is skipped before any pause.
          (b) the check is forced through (as if files grew after it), so
          the copy hits ENOSPC during the pause. Both must be reported, leave
          nothing published, and resume everything.

  python3 spikes/s3/bench/upload_tests.py [--block 120] [--runs 2]
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from typing import Any

import omni
from capture_bench import HostPoller, genws
from common import docker, save, stats, sup, wait_for
from lease_tests import stopped_workload

MINIO = "cfo-s3-minio-1"


def job(body: dict[str, Any]) -> str:
    return sup("/upload", body)["job"]


def job_result(jid: str, timeout: float) -> dict[str, Any]:
    return wait_for(lambda: (j := sup(f"/jobs/{jid}"))["state"] != "running" and j, timeout, 1, "upload job")


def pointer() -> Any:
    return sup("/pointer")["pointer"]


class TurnLoop:
    """One turn every `every` seconds, rotating over sessions, until stopped."""

    def __init__(self, sessions: list[str], every: float = 10.0) -> None:
        self.rows: list[dict[str, Any]] = []
        self._s = sessions
        self._every = every
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        i = 0
        while not self._stop.is_set():
            sid = self._s[i % len(self._s)]
            t = time.time()
            r = omni.turn(sid, f"turn during block {i}", timeout=60)
            self.rows.append({"at": t, "session": sid[:8], **r})
            i += 1
            self._stop.wait(self._every)

    def __enter__(self) -> TurnLoop:
        self._t.start()
        return self

    def __exit__(self, *a: object) -> None:
        self._stop.set()
        self._t.join()


def blocked_run(policy: dict[str, Any], block_s: float, sessions: list[str]) -> dict[str, Any]:
    base = sup("/capture", {"method": "rsync-2phase", "budget_s": 20})
    assert base["outcome"] == "snapshot_ready", base
    r0 = job_result(job({"snapshot_dir": base["snapshot_dir"], "capture_id": base["capture_id"]}), 600)
    assert r0["result"]["published"], r0
    before = pointer()

    cap = sup("/capture", {"method": "rsync-2phase", "budget_s": 20})
    jid = job({"snapshot_dir": cap["snapshot_dir"], "capture_id": cap["capture_id"], **policy})
    time.sleep(1.0)
    t_block = time.time()
    docker("pause", MINIO)
    try:
        with HostPoller() as hp, TurnLoop(sessions) as tl:
            time.sleep(20)
            during = sup("/capture", {"method": "rsync-2phase", "budget_s": 20})
            if during.get("snapshot_dir"):
                sup("/rm", {"path": during["snapshot_dir"]})
            remaining = block_s - (time.time() - t_block)
            time.sleep(max(0.0, remaining))
            runners_during = sup("/runners")["runner_count"]
    finally:
        docker("unpause", MINIO)
    t_unblock = time.time()
    res = job_result(jid, 1200)["result"]
    after = pointer()
    turns = tl.rows
    row = {
        "policy": policy,
        "block_s": round(t_unblock - t_block, 1),
        "upload": {k: res.get(k) for k in ("outcome", "published", "error", "total_s", "upload_s", "abort_error")},
        "upload_finished_after_unblock_s": round(res.get("total_s", 0) - (t_unblock - t_block) - 1.0, 1),
        "pointer_before": before["capture_id"] if before else None,
        "pointer_after": after["capture_id"] if after else None,
        "pointer_moved_to_new": bool(after and after["capture_id"] == cap["capture_id"]),
        "turns": len(turns),
        "turns_ok": sum(1 for t in turns if t["ok"]),
        "turn_s": stats([t["s"] for t in turns]),
        "host_states": sorted(set(hp.states)),
        "capture_during_block": {k: during.get(k) for k in ("outcome", "pause_s", "copy_s")},
        "runners_during_block": runners_during,
        "stopped_after": [p["pid"] for p in stopped_workload()],
    }
    print(json.dumps(row))
    return row


def fulldisk(sessions: list[str]) -> list[dict[str, Any]]:
    rows = []
    before = pointer()
    df = sup("/df", {"path": "/snap-small"})
    cases = [
        # (a) pre-flight refusal: no pause at all.
        ("preflight", {"method": "rsync", "budget_s": 20, "snapshot_root": "/snap-small"}),
        # (b) the estimate is wrong (files grew after it): ENOSPC inside the pause.
        ("enospc_during_paused_copy", {"method": "rsync", "budget_s": 20, "snapshot_root": "/snap-small",
                                       "margin_bytes": -(10**12)}),
        # (c) two-phase: ENOSPC in the unpaused pre-copy, so nothing is paused.
        ("enospc_during_precopy", {"method": "rsync-2phase", "budget_s": 20, "snapshot_root": "/snap-small",
                                   "margin_bytes": -(10**12)}),
    ]
    for name, body in cases:
        res = sup("/capture", body)
        left = sup("/exec", {"argv": ["ls", "-A", "/snap-small"], "timeout": 10})["stdout"].split()
        rows.append({
            "case": name,
            "snap_fs_bytes": df["size"],
            "outcome": res["outcome"],
            "detail": res.get("detail") or res.get("copy_stderr", "")[-200:],
            "required_bytes": res.get("required_bytes"),
            "free_bytes": res.get("free_bytes"),
            "pause_s": res.get("pause_s_by_guard"),
            "guard": (res.get("guard") or {}).get("outcome"),
            "published": res.get("published"),
            "left_in_snapshot_area": left,
            "pointer_unchanged": pointer() == before,
            "stopped_after": [p["pid"] for p in stopped_workload()],
            "turn_after": omni.turn(sessions[0], "after full disk"),
        })
        print(json.dumps(rows[-1]))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--block", type=float, default=120)
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--profile", default="realistic")
    args = ap.parse_args()
    agent = omni.register_agent()
    sessions = [omni.new_session(agent)["session_id"] for _ in range(3)]
    for s in sessions:
        assert omni.turn(s, "hello")["ok"]
    genws(args.profile)
    policies = [
        {"name": "short", "request_timeout_s": 20, "attempts": 3, "deadline_s": 600},
        {"name": "patient", "request_timeout_s": 60, "attempts": 10, "deadline_s": 900},
    ]
    blocked = []
    for _ in range(args.runs):
        for p in policies:
            blocked.append(blocked_run(p, args.block, sessions))
    disk = fulldisk(sessions)
    summary = {
        "blocked": {
            p["name"]: {
                "outcomes": sorted({r["upload"]["outcome"] for r in blocked if r["policy"]["name"] == p["name"]}),
                "all_turns_ok": all(r["turns_ok"] == r["turns"] for r in blocked if r["policy"]["name"] == p["name"]),
                "host_always_online": all(r["host_states"] == ["online"] for r in blocked if r["policy"]["name"] == p["name"]),
                "pointer_only_moves_on_success": all(
                    r["pointer_moved_to_new"] == bool(r["upload"]["published"]) for r in blocked if r["policy"]["name"] == p["name"]),
                "capture_during_block_pause_s": stats([r["capture_during_block"]["pause_s"] or 0 for r in blocked if r["policy"]["name"] == p["name"]]),
            }
            for p in policies
        },
        "fulldisk": {r["case"]: {k: r[k] for k in ("outcome", "published", "pointer_unchanged", "left_in_snapshot_area", "stopped_after")} | {"turn_ok": r["turn_after"]["ok"]} for r in disk},
    }
    print(json.dumps(summary, indent=1))
    save("upload-and-disk", {"summary": summary, "blocked": blocked, "fulldisk": disk})


if __name__ == "__main__":
    main()
