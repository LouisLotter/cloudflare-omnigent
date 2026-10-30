"""Restore points and the rollback to one (WP3.41, ADR 0007).

``bootstrap.ts update`` names a restore point in the new release's server environment
(``CFO_RESTORE_POINT``). At the first start under that name, after the previous server's final
sync and this start's own restore, and before Litestream replicates or Omnigent (and its
migrations) starts, the entrypoint copies every object of the Litestream replica beside it:

    <replica's parent>/cfo-restore-points/<id>/replica/<key under the replica's path>
    <replica's parent>/cfo-restore-points/<id>/manifest.json      (written last)

For the default replica ``s3://<bucket>/omnigent`` that is ``s3://<bucket>/cfo-restore-points/``.
Nothing writes the replica while the copy is made (the previous server has stopped, this one
has not started replicating), so the copy is a complete replica of its own, which Litestream
restores like any other. It lives outside Litestream's path, so Litestream's retention never
deletes it, and the installation's buckets have no lifecycle rule. The manifest lists every
object with its size and the restored database's SHA-256: a restore point exists only once its
manifest does, and Omnigent never starts under a restore point's name before it exists. The
newest ``KEPT`` restore points are kept; older ones are deleted when a new one is complete.

The rollback (``CFO_ROLLBACK_TO``, the same name, which only ``bootstrap.ts update --rollback``
sets inside the update's read-only window) puts the restore point back as the live replica:
it restores the copy to a scratch file and checks it against the manifest (before anything is
deleted), then deletes the replica's objects, copies the restore point's back, checks the
listing, and writes ``rolled-back.json`` beside the manifest. A rollback already done is never
done again: after it, the previous release's server writes to the replica. The previous release's
server then restores exactly the replica it left.

Credentials stay in the entrypoint: Litestream's own pair, given to this process's S3 client and
never logged. Errors carry no credential (``entrypoint.redact`` runs over them as well).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import re
import shutil
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, Protocol
from urllib.parse import urlsplit

#: The installer's restore point names: ``rp-``, the window's UTC start, and 8 random hex digits.
RESTORE_POINT_ID = re.compile(r"rp-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}")
#: The folder beside the replica that holds the restore points.
POINTS_DIR = "cfo-restore-points"
#: How many complete restore points are kept (the newest).
KEPT = 3
MANIFEST = "manifest.json"
ROLLED_BACK = "rolled-back.json"
MANIFEST_FORMAT = 1


class RestorePointError(RuntimeError):
    """A restore point could not be taken, checked or put back. Names no credential."""


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ── Where things live ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Places:
    """Keys, relative to the store's root (an S3 bucket, or ``/`` for a file replica)."""

    #: The replica's objects: everything under it is Litestream's.
    replica: str
    #: The restore points' folder.
    points: str
    #: The store's scheme and root, for the installer's record: ``s3://<bucket>`` or ``file://``.
    root: str

    def point(self, rp_id: str) -> str:
        return f"{self.points}{rp_id}/"

    def copy(self, rp_id: str) -> str:
        return f"{self.points}{rp_id}/replica/"

    def manifest(self, rp_id: str) -> str:
        return f"{self.points}{rp_id}/{MANIFEST}"

    def marker(self, rp_id: str) -> str:
        return f"{self.points}{rp_id}/{ROLLED_BACK}"

    def copy_url(self, rp_id: str) -> str:
        """The restore point's copy as a replica URL Litestream reads."""
        return f"{self.root}/{self.copy(rp_id).rstrip('/')}"


def places(replica_url: str) -> Places:
    """Where a replica's restore points live; ``ValueError`` for a replica that has no room."""
    parts = urlsplit(replica_url)
    if parts.scheme not in ("s3", "file"):
        raise ValueError("restore points need an s3:// or file:// replica")
    segments = [s for s in parts.path.split("/") if s]
    if not segments:
        raise ValueError("restore points need a replica with a path: s3://<bucket>/<path>")
    if any(s in (".", "..") for s in segments) or segments[-1] == POINTS_DIR:
        raise ValueError(f"the replica's path must be a plain path, not {POINTS_DIR}")
    path = "/".join(segments)
    parent = "/".join(segments[:-1])
    points = f"{parent}/{POINTS_DIR}/" if parent else f"{POINTS_DIR}/"
    root = f"s3://{parts.netloc}" if parts.scheme == "s3" else "file://"
    return Places(replica=f"{path}/", points=points, root=root)


# ── Stores ────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Item:
    key: str
    size: int


class Store(Protocol):
    """The few object operations restore points need, on keys relative to the store's root."""

    def list(self, prefix: str) -> list[Item]: ...

    def copy(self, source: str, target: str) -> None: ...

    def delete(self, key: str) -> None: ...

    def read(self, key: str) -> bytes | None: ...

    def write(self, key: str, data: bytes) -> None: ...


class FileStore:
    """A file replica (tests and local runs): keys are paths under ``root``."""

    def __init__(self, root: Path = Path("/")) -> None:
        self.root = root

    def _path(self, key: str) -> Path:
        return self.root / PurePosixPath(key)

    def list(self, prefix: str) -> list[Item]:
        base = self._path(prefix)
        if not base.is_dir():
            return []
        items = []
        for path in sorted(base.rglob("*")):
            if path.is_file():
                items.append(Item(prefix + path.relative_to(base).as_posix(), path.stat().st_size))
        return items

    def copy(self, source: str, target: str) -> None:
        to = self._path(target)
        to.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self._path(source), to)

    def delete(self, key: str) -> None:
        with contextlib.suppress(FileNotFoundError):
            self._path(key).unlink()

    def read(self, key: str) -> bytes | None:
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError:
            return None

    def write(self, key: str, data: bytes) -> None:
        to = self._path(key)
        to.parent.mkdir(parents=True, exist_ok=True)
        tmp = to.with_name(f".{to.name}.tmp")
        tmp.write_bytes(data)
        tmp.replace(to)


class S3Store:
    """The replica's bucket, with Litestream's own credentials (an R2 bucket on Cloudflare).

    Checksums only where S3 requires them, as for the artifact store (``config``): a plain
    request that R2 and the tests' S3 stand-in both accept. One object per delete: a replica
    holds tens of objects, and ``DeleteObjects`` needs a checksum.
    """

    def __init__(self, bucket: str, client: Any) -> None:
        self.bucket = bucket
        self._s3 = client

    @classmethod
    def connect(
        cls,
        bucket: str,
        *,
        endpoint: str | None,
        region: str,
        force_path_style: bool,
        access_key_id: str,
        secret_access_key: str,
    ) -> S3Store:
        import boto3
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            config=Config(
                s3={"addressing_style": "path" if force_path_style else "auto"},
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
                retries={"max_attempts": 5, "mode": "standard"},
                connect_timeout=10,
                read_timeout=60,
            ),
        )
        return cls(bucket, client)

    def list(self, prefix: str) -> list[Item]:
        items: list[Item] = []
        token: str | None = None
        while True:
            args: dict[str, Any] = {"Bucket": self.bucket, "Prefix": prefix}
            if token is not None:
                args["ContinuationToken"] = token
            page = self._s3.list_objects_v2(**args)
            for entry in page.get("Contents", []) or []:
                items.append(Item(str(entry["Key"]), int(entry["Size"])))
            if not page.get("IsTruncated"):
                return sorted(items, key=lambda i: i.key)
            token = page.get("NextContinuationToken")

    def copy(self, source: str, target: str) -> None:
        self._s3.copy_object(
            Bucket=self.bucket, Key=target, CopySource={"Bucket": self.bucket, "Key": source}
        )

    def delete(self, key: str) -> None:
        self._s3.delete_object(Bucket=self.bucket, Key=key)

    def read(self, key: str) -> bytes | None:
        try:
            answer = self._s3.get_object(Bucket=self.bucket, Key=key)
        except Exception as exc:  # noqa: BLE001 - botocore's NoSuchKey, or a real failure
            code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if code in ("NoSuchKey", "404", "NotFound"):
                return None
            raise
        return answer["Body"].read()

    def write(self, key: str, data: bytes) -> None:
        self._s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType="application/json")


def open_store(
    replica_url: str,
    *,
    endpoint: str | None,
    region: str,
    force_path_style: bool,
    env: Mapping[str, str],
) -> Store:
    """The replica's store: its S3 bucket with Litestream's pair, or the file system."""
    parts = urlsplit(replica_url)
    if parts.scheme == "file":
        return FileStore()
    return S3Store.connect(
        parts.netloc,
        endpoint=endpoint,
        region=region,
        force_path_style=force_path_style,
        access_key_id=env.get("LITESTREAM_ACCESS_KEY_ID", ""),
        secret_access_key=env.get("LITESTREAM_SECRET_ACCESS_KEY", ""),
    )


# ── Manifests ─────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Manifest:
    rp_id: str
    taken_at: str
    #: Every object of the replica, relative to its path, with its size.
    objects: dict[str, int]
    #: The database this start restored from those objects: its SHA-256 and size, or ``None``
    #: when the start used a database it found on its disk.
    database_sha256: str | None
    database_bytes: int | None
    #: The image that took it (its Omnigent commit), for the record.
    build: Mapping[str, Any] | None

    def to_json(self) -> bytes:
        body = {
            "format": MANIFEST_FORMAT,
            "id": self.rp_id,
            "takenAt": self.taken_at,
            "objects": [{"key": k, "size": s} for k, s in sorted(self.objects.items())],
            "database": (
                None
                if self.database_sha256 is None
                else {"sha256": self.database_sha256, "bytes": self.database_bytes}
            ),
            "build": dict(self.build) if self.build is not None else None,
        }
        return (json.dumps(body, indent=2, sort_keys=True) + "\n").encode()

    @classmethod
    def parse(cls, data: bytes, rp_id: str) -> Manifest:
        try:
            body = json.loads(data)
            if body["format"] != MANIFEST_FORMAT or body["id"] != rp_id:
                raise ValueError("another format or restore point")
            objects = {str(o["key"]): int(o["size"]) for o in body["objects"]}
            database = body.get("database")
            return cls(
                rp_id=rp_id,
                taken_at=str(body["takenAt"]),
                objects=objects,
                database_sha256=None if database is None else str(database["sha256"]),
                database_bytes=None if database is None else int(database["bytes"]),
                build=body.get("build"),
            )
        except (ValueError, KeyError, TypeError) as exc:
            raise RestorePointError(f"the manifest of {rp_id} is malformed: {exc}") from None

    def summary(self) -> dict[str, Any]:
        """What ``/status`` reports: no key, no credential."""
        return {
            "id": self.rp_id,
            "takenAt": self.taken_at,
            "objects": len(self.objects),
            "bytes": sum(self.objects.values()),
        }


def sha256_of(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _relative(items: Iterable[Item], prefix: str) -> dict[str, int]:
    return {i.key[len(prefix) :]: i.size for i in items if i.key.startswith(prefix)}


# ── Taking one ────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Taken:
    manifest: Manifest
    #: False when an earlier start under the same name had taken it already.
    new: bool
    #: Restore points deleted as older than the newest ``KEPT``.
    pruned: tuple[str, ...] = ()


def take(
    store: Store,
    where: Places,
    rp_id: str,
    *,
    database: Path | None,
    build: Mapping[str, Any] | None,
    deadline: float,
    should_stop: Callable[[], bool] = lambda: False,
    clock: Callable[[], float] = time.monotonic,
    log: Callable[..., None] = lambda *_a, **_k: None,
) -> Taken:
    """The restore point ``rp_id`` of the replica as it is now, unless it exists already.

    ``database`` is the file this start restored from the replica (its digest goes in the
    manifest), or ``None`` for one it found on its disk. Raises :class:`RestorePointError`; a
    partial copy has no manifest, so it never counts, and the next attempt starts it over.
    """
    if not RESTORE_POINT_ID.fullmatch(rp_id):
        raise RestorePointError("not a restore point's name")
    existing = store.read(where.manifest(rp_id))
    if existing is not None:
        return Taken(Manifest.parse(existing, rp_id), new=False)
    objects = _relative(store.list(where.replica), where.replica)
    if not objects:
        raise RestorePointError("the replica holds no backup, so there is nothing to protect")
    copy = where.copy(rp_id)
    # Leftovers of an attempt that never finished: it had no manifest, so nothing relied on it.
    for item in store.list(copy):
        store.delete(item.key)

    def check_time() -> None:
        if should_stop():
            raise RestorePointError("stopped before the restore point was complete")
        if clock() > deadline:
            raise RestorePointError("the restore point was not complete within its deadline")

    for key in sorted(objects):
        check_time()
        store.copy(where.replica + key, copy + key)
    copied = _relative(store.list(copy), copy)
    if copied != objects:
        raise RestorePointError(
            f"the copy differs from the replica ({len(copied)} of {len(objects)} objects match)"
        )
    digest, size = (None, None) if database is None else sha256_of(database)
    manifest = Manifest(
        rp_id=rp_id,
        taken_at=now_iso(),
        objects=objects,
        database_sha256=digest,
        database_bytes=size,
        build=build,
    )
    check_time()
    store.write(where.manifest(rp_id), manifest.to_json())
    written = store.read(where.manifest(rp_id))
    if written is None or Manifest.parse(written, rp_id) != manifest:
        raise RestorePointError("the manifest did not read back as written")
    pruned: tuple[str, ...] = ()
    try:
        pruned = prune(store, where, rp_id)
    except Exception as exc:  # noqa: BLE001 - pruning is housekeeping, never a failed start
        log("restore_point.prune_failed", error=f"{type(exc).__name__}: {exc}"[:200])
    return Taken(manifest, new=True, pruned=pruned)


def prune(store: Store, where: Places, current: str, keep: int = KEPT) -> tuple[str, ...]:
    """Deletes restore points older than the newest ``keep`` complete ones, ``current``
    included, and leftovers of attempts older than it that never finished. Never ``current``,
    never one newer than it (another installer's, which cannot exist, is left alone)."""
    keys = store.list(where.points)
    names: dict[str, list[str]] = {}
    for item in keys:
        rp_id = item.key[len(where.points) :].split("/", 1)[0]
        if RESTORE_POINT_ID.fullmatch(rp_id):
            names.setdefault(rp_id, []).append(item.key)
    complete = sorted(n for n, ks in names.items() if where.manifest(n) in ks and n <= current)
    kept = set(complete[-keep:]) | {current}
    gone = sorted(n for n in names if n < current and n not in kept)
    for rp_id in gone:
        # The manifest first: a restore point stops counting before any of its copy goes.
        for key in sorted(names[rp_id], key=lambda k: k != where.manifest(rp_id)):
            store.delete(key)
    return tuple(gone)


# ── Putting one back ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RolledBack:
    #: False when the restore point did not exist: the update's server never took it, so it
    #: never started Omnigent, and the replica is the one the previous release left.
    restored: bool
    #: True when a rollback to this restore point had been done before (nothing done again).
    already: bool
    detail: str


def roll_back(
    store: Store,
    where: Places,
    rp_id: str,
    *,
    verify_copy: Callable[[Manifest], str | None],
    should_stop: Callable[[], bool] = lambda: False,
    log: Callable[..., None] = lambda *_a, **_k: None,
) -> RolledBack:
    """Puts restore point ``rp_id`` back as the live replica, once.

    ``verify_copy`` restores the restore point's copy to a scratch file and says what is wrong
    with it (``None``: it is the database the manifest records). It runs before anything is
    deleted, so a restore point that cannot give back its database leaves the replica as it is.
    Raises :class:`RestorePointError`; every step can be run again.
    """
    if not RESTORE_POINT_ID.fullmatch(rp_id):
        raise RestorePointError("not a restore point's name")
    done = store.read(where.marker(rp_id))
    if done is not None:
        return RolledBack(restored=True, already=True, detail="rolled back before")
    raw = store.read(where.manifest(rp_id))
    if raw is None:
        # Omnigent never starts under a restore point's name before its manifest exists, so the
        # update's server never wrote the replica: there is nothing to put back.
        detail = "no restore point: the update's server never started Omnigent"
        _mark(store, where, rp_id, restored=False, detail=detail)
        return RolledBack(restored=False, already=False, detail=detail)
    manifest = Manifest.parse(raw, rp_id)
    copy = where.copy(rp_id)
    held = _relative(store.list(copy), copy)
    if held != manifest.objects:
        raise RestorePointError(
            f"the restore point {rp_id} is incomplete: {len(held)} of "
            f"{len(manifest.objects)} objects as recorded"
        )
    problem = verify_copy(manifest)
    if problem is not None:
        raise RestorePointError(
            f"the restore point {rp_id} does not restore as recorded: {problem}"
        )
    if should_stop():
        raise RestorePointError("stopped before the replica was changed")
    # From here the live replica changes. Nothing replicates meanwhile: this start never runs
    # Litestream's replication, and the update's server has stopped.
    for item in store.list(where.replica):
        store.delete(item.key)
    if store.list(where.replica):
        raise RestorePointError("the replica's objects could not all be deleted")
    for key in sorted(manifest.objects):
        store.copy(copy + key, where.replica + key)
    live = _relative(store.list(where.replica), where.replica)
    if live != manifest.objects:
        raise RestorePointError(
            f"the replica differs from the restore point after the copy ({len(live)} objects)"
        )
    detail = f"{len(live)} objects put back as the replica"
    _mark(store, where, rp_id, restored=True, detail=detail)
    log("rollback.replica_restored", restore_point=rp_id, objects=len(live))
    return RolledBack(restored=True, already=False, detail=detail)


def _mark(store: Store, where: Places, rp_id: str, *, restored: bool, detail: str) -> None:
    body = {"id": rp_id, "at": now_iso(), "restored": restored, "detail": detail}
    store.write(where.marker(rp_id), (json.dumps(body, sort_keys=True) + "\n").encode())
