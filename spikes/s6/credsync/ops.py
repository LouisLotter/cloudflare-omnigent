"""Capture, publish and restore checkpoints; the settle-and-copy credential watcher."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import time
from collections.abc import Callable
from pathlib import Path

from core import (
    CRED_KIND,
    DECLARED_FILES,
    WORKSPACE_KIND,
    CredentialSnapshot,
    RefusedFile,
    UnstableRead,
    credential_manifest,
    install_workspace,
    pack_tar,
    signature,
    stage_and_install_credentials,
    take_credential_snapshot,
    take_workspace_snapshot,
    unpack_tar_regular_files,
    workspace_manifest,
)
from controller import Controller
from objstore import ObjectStore


@dataclasses.dataclass
class Computer:
    computer_id: str
    generation: int
    store: ObjectStore
    controller: Controller


def _put_verified(store: ObjectStore, key: str, data: bytes) -> str:
    digest = hashlib.sha256(data).hexdigest()
    store.put(key, data)
    if hashlib.sha256(store.get(key)).hexdigest() != digest:
        raise OSError(f"verification failed for {key}")
    return digest


def publish_credential_snapshot(comp: Computer, snap: CredentialSnapshot, *, timings: dict | None = None,
                                before_publish: Callable[[], None] | None = None) -> tuple[int, bool]:
    """Upload one credential checkpoint and switch the pointer. Returns (seq, published)."""
    seq = comp.controller.next_seq(comp.computer_id, CRED_KIND, comp.generation)
    entries = {r.path: (snap.blobs[r.path], int(r.mode, 8)) for r in snap.records if r.state == "present"}
    archive = pack_tar(entries)
    base = f"computers/{comp.computer_id}/cred/{seq:08d}"
    archive_sha = _put_verified(comp.store, base + ".tar", archive)
    manifest = credential_manifest(snap, computer_id=comp.computer_id, generation=comp.generation, seq=seq,
                                   archive_key=base + ".tar", archive_sha256=archive_sha)
    _put_verified(comp.store, base + ".json", json.dumps(manifest, sort_keys=True).encode())
    if timings is not None:
        timings["uploaded"] = time.time()
    if before_publish is not None:
        before_publish()
    ok = comp.controller.publish(comp.computer_id, CRED_KIND, comp.generation, seq, base + ".json")
    if timings is not None:
        timings["published"] = time.time()
    return seq, ok


def capture_credentials(comp: Computer, home: Path, retries: int = 20) -> tuple[int, bool, CredentialSnapshot]:
    for _ in range(retries):
        try:
            snap = take_credential_snapshot(home)
            break
        except UnstableRead:
            time.sleep(0.05)
    else:
        raise UnstableRead("credential files kept changing")
    seq, ok = publish_credential_snapshot(comp, snap)
    return seq, ok, snap


def capture_workspace(comp: Computer, home: Path) -> tuple[int, bool, dict]:
    entries = take_workspace_snapshot(home)
    seq = comp.controller.next_seq(comp.computer_id, WORKSPACE_KIND, comp.generation)
    base = f"computers/{comp.computer_id}/ws/{seq:08d}"
    archive_sha = _put_verified(comp.store, base + ".tar", pack_tar(entries))
    manifest = workspace_manifest(entries, computer_id=comp.computer_id, generation=comp.generation, seq=seq,
                                  archive_key=base + ".tar", archive_sha256=archive_sha)
    _put_verified(comp.store, base + ".json", json.dumps(manifest, sort_keys=True).encode())
    ok = comp.controller.publish(comp.computer_id, WORKSPACE_KIND, comp.generation, seq, base + ".json")
    return seq, ok, manifest


def restore(comp: Computer, home: Path, staging: Path) -> dict:
    """Workspace first, then credentials through the staging directory."""
    report: dict = {"workspace": None, "credentials": None}
    ws = comp.controller.current(comp.computer_id, WORKSPACE_KIND)
    if ws:
        manifest = json.loads(comp.store.get(ws[1]))
        archive = comp.store.get(manifest["archive"]["key"])
        if hashlib.sha256(archive).hexdigest() != manifest["archive"]["sha256"]:
            raise ValueError("workspace archive does not match its manifest")
        n = install_workspace(home, unpack_tar_regular_files(archive))
        report["workspace"] = {"seq": ws[0], "files": n}
    cred = comp.controller.current(comp.computer_id, CRED_KIND)
    if cred:
        manifest = json.loads(comp.store.get(cred[1]))
        archive = comp.store.get(manifest["archive"]["key"])
        report["credentials"] = {"seq": cred[0], "files": stage_and_install_credentials(home, staging, manifest, archive)}
    return report


class CredentialWatcher:
    """Polls the declared files; after a change has settled, captures and publishes.

    Start it only after the credential restore has finished: it takes the files it sees at start
    as the published state, so it never publishes the empty pre-restore home as tombstones.
    """

    def __init__(self, comp: Computer | None, home: Path, *, settle_s: float = 0.5, poll_s: float = 0.05,
                 max_wait_s: float = 10.0, log: Callable[[dict], None] | None = None,
                 publisher: Callable[[CredentialSnapshot, dict], tuple[int, bool]] | None = None):
        self.comp = comp
        # Publishes one snapshot and fills timings["uploaded"] and timings["published"].
        self.publisher = publisher or (lambda snap, timings: publish_credential_snapshot(comp, snap, timings=timings))
        self.home = home
        self.settle_s = settle_s
        self.poll_s = poll_s
        self.max_wait_s = max_wait_s
        self.log = log or (lambda e: None)
        self.paths = [d.path for d in DECLARED_FILES]
        self.last_sigs = self._sigs()
        self.published_digest = self._digest_now()
        self.dirty_since: float | None = None
        self.last_change: float | None = None
        self.stopped = False

    def _sigs(self):
        return tuple(signature(self.home / p) for p in self.paths)

    def _digest_now(self) -> str | None:
        for _ in range(20):
            try:
                return take_credential_snapshot(self.home).digest()
            except UnstableRead:
                time.sleep(0.05)
        return None

    def step(self) -> dict | None:
        now = time.time()
        sigs = self._sigs()
        if sigs != self.last_sigs:
            self.last_sigs = sigs
            self.last_change = now
            if self.dirty_since is None:
                self.dirty_since = now
        if self.dirty_since is None:
            return None
        quiet = now - (self.last_change or now)
        forced = now - self.dirty_since >= self.max_wait_s
        if quiet < self.settle_s and not forced:
            return None
        try:
            snap = take_credential_snapshot(self.home)
        except UnstableRead:
            self.last_change = time.time()
            return None
        except RefusedFile as e:
            event = {"event": "refused", "reason": str(e).split("/")[-1], "at": time.time()}
            self.log(event)
            self.dirty_since = None
            return event
        digest = snap.digest()
        if digest == self.published_digest:
            self.dirty_since = None
            return None
        timings = {"first_change": self.dirty_since, "settled": now, "snapshot": time.time()}
        seq, ok = self.publisher(snap, timings)
        if ok:
            self.published_digest = digest
        self.dirty_since = None
        event = {
            "event": "published" if ok else "fenced",
            "seq": seq,
            "forced": forced,
            "files": [{"path": r.path, "state": r.state, "size": r.size, "mode": r.mode} for r in snap.records],
            **{f"t_{k}": v for k, v in timings.items()},
            "latency_ms": round((timings["published"] - timings["first_change"]) * 1000, 1),
        }
        self.log(event)
        return event

    def run(self, until: Callable[[], bool] | None = None) -> None:
        while not self.stopped and not (until and until()):
            self.step()
            time.sleep(self.poll_s)
