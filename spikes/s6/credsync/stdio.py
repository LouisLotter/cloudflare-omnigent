"""Checkpoint transfer over a process's standard input and output (spike S6, staging).

In staging, the Durable Object runs these through the container's exec() API, so it is the
Durable Object that numbers, stores and publishes checkpoints, as WorkspaceDO will. Archive bytes
travel base64-encoded inside JSON lines on the exec pipes; they are never logged.

  export  --kind credential|workspace --home H        one JSON line: records, archive
  import  --kind credential|workspace --home H --staging DIR   reads {manifest, archive_b64}
  watch-export --home H --settle-ms N --log FILE      one JSON line per settled change; waits for
                                                      {"seq": N, "published": bool} on stdin
"""

from __future__ import annotations

import base64
import hashlib
import json
import sys
import time
from pathlib import Path

from core import (
    RefusedFile,
    UnstableRead,
    install_workspace,
    pack_tar,
    stage_and_install_credentials,
    take_credential_snapshot,
    take_workspace_snapshot,
    unpack_tar_regular_files,
)
from ops import CredentialWatcher


def _snapshot(home: Path):
    for _ in range(40):
        try:
            return take_credential_snapshot(home)
        except UnstableRead:
            time.sleep(0.05)
    raise UnstableRead("credential files kept changing")


def _cred_payload(snap) -> dict:
    entries = {r.path: (snap.blobs[r.path], int(r.mode, 8)) for r in snap.records if r.state == "present"}
    archive = pack_tar(entries)
    return {
        "kind": "credential",
        "records": [r.to_json() for r in snap.records],
        "taken_at": snap.taken_at,
        "order": snap.order,
        "archive_sha256": hashlib.sha256(archive).hexdigest(),
        "archive_b64": base64.b64encode(archive).decode(),
    }


def export(kind: str, home: Path) -> int:
    if kind == "credential":
        payload = _cred_payload(_snapshot(home))
    else:
        entries = take_workspace_snapshot(home)
        archive = pack_tar(entries)
        payload = {
            "kind": "workspace",
            "file_count": len(entries),
            "bytes": sum(len(d) for d, _ in entries.values()),
            "taken_at": time.time(),
            "archive_sha256": hashlib.sha256(archive).hexdigest(),
            "archive_b64": base64.b64encode(archive).decode(),
        }
    sys.stdout.write(json.dumps(payload) + "\n")
    return 0


def import_(kind: str, home: Path, staging: Path) -> int:
    req = json.loads(sys.stdin.read())
    manifest = req["manifest"]
    archive = base64.b64decode(req["archive_b64"])
    if hashlib.sha256(archive).hexdigest() != manifest["archive"]["sha256"]:
        raise SystemExit("archive does not match its manifest")
    if kind == "workspace":
        report = {"kind": kind, "seq": manifest["seq"], "files": install_workspace(home, unpack_tar_regular_files(archive))}
    else:
        report = {"kind": kind, "seq": manifest["seq"], "files": stage_and_install_credentials(home, staging, manifest, archive)}
    print(json.dumps(report))
    return 0


def watch_export(home: Path, settle_ms: float, poll_ms: float, log_path: str | None) -> int:
    if log_path:
        Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    logf = open(log_path, "a") if log_path else None

    def log(e: dict) -> None:
        if logf:
            logf.write(json.dumps(e) + "\n")
            logf.flush()

    def publisher(snap, timings: dict) -> tuple[int, bool]:
        line = _cred_payload(snap)
        line.update(event="snapshot", **{f"t_{k}": v for k, v in timings.items()})
        sys.stdout.write(json.dumps(line) + "\n")
        sys.stdout.flush()
        ack = sys.stdin.readline()
        if not ack:
            raise SystemExit(0)  # the Durable Object closed the pipe: stop watching
        now = time.time()
        timings["uploaded"] = now
        timings["published"] = now  # on this clock: when the acknowledgement arrived
        a = json.loads(ack)
        return a.get("seq", -1), bool(a.get("published"))

    w = CredentialWatcher(None, home, settle_s=settle_ms / 1000, poll_s=poll_ms / 1000, log=log, publisher=publisher)
    sys.stdout.write(json.dumps({"event": "watching", "settle_ms": settle_ms}) + "\n")
    sys.stdout.flush()
    try:
        w.run()
    except RefusedFile as e:
        log({"event": "refused", "reason": str(e)[-80:]})
    return 0


def watch_summary(log_path: str) -> int:
    """Change-to-acknowledged-publish times from a watch-export log, on the container's clock."""
    try:
        events = [json.loads(x) for x in open(log_path) if x.strip()]
    except FileNotFoundError:
        events = []
    lat = sorted(e["latency_ms"] for e in events if e.get("event") == "published")

    def pct(p: float):
        if not lat:
            return None
        k = (len(lat) - 1) * p
        f, c = int(k), min(int(k) + 1, len(lat) - 1)
        return round(lat[f] + (lat[c] - lat[f]) * (k - f), 1)

    print(json.dumps({"published": len(lat), "fenced": sum(e.get("event") == "fenced" for e in events),
                      "change_to_published_ms": {"p50": pct(0.5), "p95": pct(0.95), "max": lat[-1] if lat else None},
                      "last_states": events[-1]["files"] if events and "files" in events[-1] else None}))
    return 0
