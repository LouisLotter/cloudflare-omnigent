"""Credential and workspace checkpoints for spike S6 (throwaway spike code).

Rules this module follows, from the design ("Checkpoints", "Which credentials win"):

- A credential checkpoint holds only the declared credential files, as opaque bytes. Every
  checkpoint records every declared file: present (with its bytes) or absent (a tombstone).
- A workspace checkpoint never holds a declared credential file, nor the temporary files the
  CLIs write next to them, so it can never bring a login back.
- Restore order: workspace first, then credentials through a staging directory. Only the declared
  files are installed; tombstoned files are deleted. CLI homes are never replaced wholesale.
- The code never parses credential bytes and never logs them. Reports carry paths, modes, sizes,
  states and timestamps only.
"""

from __future__ import annotations

import dataclasses
import fcntl
import hashlib
import io
import json
import os
import re
import secrets
import stat
import tarfile
import tempfile
import time
from collections.abc import Iterable, Iterator
from pathlib import Path, PurePosixPath

FORMAT_VERSION = 1
CRED_KIND = "credential"
WORKSPACE_KIND = "workspace"


@dataclasses.dataclass(frozen=True)
class DeclaredFile:
    """One declared credential file, relative to the computer's home directory."""

    cli: str
    path: str
    # Names of temporary siblings the CLI may leave next to the file. They hold credential bytes
    # too, so the workspace checkpoint must exclude them.
    temp_name_patterns: tuple[str, ...] = ()
    # Lock files next to the credential file: no credential bytes, but no value in a checkpoint.
    lock_names: tuple[str, ...] = ()

    @property
    def name(self) -> str:
        return PurePosixPath(self.path).name

    @property
    def parent(self) -> str:
        return str(PurePosixPath(self.path).parent)


# The list confirmed by spike S6 for Claude Code 2.1.296, Codex 0.162.1 and Omnigent 0.17.0,
# plus one provisional entry. Evidence: docs/verification/spike-s6.md.
DECLARED_FILES: tuple[DeclaredFile, ...] = (
    DeclaredFile(
        cli="claude",
        path=".claude/.credentials.json",
        # Claude's atomic writer stages "<target>.tmp.<8 hex>" (or ".tmp.<pid>.<12 hex>") beside
        # the target and renames it into place.
        temp_name_patterns=(r"\.credentials\.json\.tmp\.[0-9a-f]{8}", r"\.credentials\.json\.tmp\.\d+\.[0-9a-f]{12}"),
    ),
    DeclaredFile(
        cli="claude",
        path=".claude/.device-keys.json",
        # Provisional: Claude Code 2.1.296 has a device-key store (a private key for its device
        # registry) kept either inside .credentials.json or in this file. No tested flow created
        # it; until the owner session shows whether a real login does, it is treated as login
        # material, so it never enters a workspace checkpoint.
        temp_name_patterns=(r"\.device-keys\.json\.tmp\.[0-9a-f]{8}", r"\.device-keys\.json\.tmp\.\d+\.[0-9a-f]{12}"),
        lock_names=(".device-keys.lock",),
    ),
    DeclaredFile(
        cli="codex",
        path=".codex/auth.json",
        # Codex 0.162.1 rewrites auth.json in place (O_TRUNC), so it has no temporary sibling.
    ),
    DeclaredFile(
        cli="omnigent",
        path=".omnigent/auth_tokens.json",
        # Omnigent writes ".auth_tokens.json.<random>.tmp" and os.replace()s it into place, under
        # an flock on "auth_tokens.lock".
        temp_name_patterns=(r"\.auth_tokens\.json\..+\.tmp",),
        lock_names=("auth_tokens.lock",),
    ),
)

# Workspace checkpoint roots, relative to home. The real image declares its own list (WP3.4).
WORKSPACE_ROOTS: tuple[str, ...] = (".claude", ".claude.json", ".codex", ".omnigent", "work")
WORKSPACE_EXCLUDED_DIRS: frozenset[str] = frozenset({".cache", "node_modules", ".venv", "cache", "log", "logs"})


def declared_paths() -> list[str]:
    return [d.path for d in DECLARED_FILES]


def is_credential_or_sibling(rel: str, declared: Iterable[DeclaredFile] = DECLARED_FILES) -> bool:
    """True for a declared credential file, its temporary siblings and its lock files."""
    p = PurePosixPath(rel)
    for d in declared:
        if str(p) == d.path:
            return True
        if str(p.parent) == d.parent and (
            p.name in d.lock_names or any(re.fullmatch(pat, p.name) for pat in d.temp_name_patterns)
        ):
            return True
    return False


# ---------------------------------------------------------------------------------------------
# Reading files consistently, without parsing them


@dataclasses.dataclass(frozen=True)
class Signature:
    """What a poll sees of one path. Equal signatures mean "no visible change"."""

    exists: bool
    dev: int = 0
    ino: int = 0
    size: int = 0
    mtime_ns: int = 0
    ctime_ns: int = 0
    mode: int = 0
    is_regular: bool = False


def signature(path: Path) -> Signature:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return Signature(exists=False)
    return Signature(
        exists=True,
        dev=st.st_dev,
        ino=st.st_ino,
        size=st.st_size,
        mtime_ns=st.st_mtime_ns,
        ctime_ns=st.st_ctime_ns,
        mode=stat.S_IMODE(st.st_mode),
        is_regular=stat.S_ISREG(st.st_mode),
    )


class UnstableRead(Exception):
    """The file changed while it was being read; the caller waits and tries again."""


class RefusedFile(Exception):
    """A declared path is not a regular file (for example a symlink or a directory)."""


def read_stable(path: Path, max_bytes: int = 1 << 20) -> tuple[Signature, bytes | None]:
    """Read a file's bytes only if its signature is identical before and after the read.

    Returns (signature, None) for an absent file. Never follows symlinks.
    """
    before = signature(path)
    if not before.exists:
        return before, None
    if not before.is_regular:
        raise RefusedFile(str(path))
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except (FileNotFoundError, OSError) as e:
        # Deleted or replaced between the stat and the open (for example a logout): settle again.
        if isinstance(e, FileNotFoundError) or getattr(e, "errno", None) == 40:  # ELOOP
            raise UnstableRead(str(path)) from None
        raise
    try:
        chunks = []
        total = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise RefusedFile(f"{path} is larger than {max_bytes} bytes")
            chunks.append(chunk)
    finally:
        os.close(fd)
    after = signature(path)
    if after != before:
        raise UnstableRead(str(path))
    return before, b"".join(chunks)


# ---------------------------------------------------------------------------------------------
# Credential snapshots and manifests


@dataclasses.dataclass
class FileRecord:
    path: str
    state: str  # "present" or "absent"
    sha256: str | None = None
    size: int | None = None
    mode: str | None = None

    def to_json(self) -> dict:
        d = {"path": self.path, "state": self.state}
        if self.state == "present":
            d.update(sha256=self.sha256, size=self.size, mode=self.mode)
        return d


@dataclasses.dataclass
class CredentialSnapshot:
    records: list[FileRecord]
    blobs: dict[str, bytes]  # path -> bytes, present files only. Never logged.
    taken_at: float
    # Position in the order the copies were taken on this computer, within one generation.
    # Publishing is fenced on it, so a copy that is uploaded late never replaces a newer one.
    order: int = 0

    def digest(self) -> str:
        """Identity of the snapshot's contents: paths, states and content hashes."""
        h = hashlib.sha256()
        for r in sorted(self.records, key=lambda r: r.path):
            h.update(f"{r.path}\0{r.state}\0{r.sha256 or ''}\0{r.mode or ''}\n".encode())
        return h.hexdigest()


def default_state_dir() -> Path:
    """Per-computer state outside the home directory (never checkpointed)."""
    explicit = os.environ.get("S6_STATE_DIR")
    if explicit:
        return Path(explicit)
    system = Path("/var/lib/s6")
    try:
        system.mkdir(parents=True, exist_ok=True)
        if os.access(system, os.W_OK):
            return system
    except OSError:
        pass
    return Path(tempfile.gettempdir()) / f"s6-state-{os.getuid()}"


def take_credential_snapshot(home: Path, declared: Iterable[DeclaredFile] = DECLARED_FILES,
                             state_dir: Path | None = None) -> CredentialSnapshot:
    """Copy every declared file's bytes, or record its absence. Raises UnstableRead on a race.

    The copy is taken under an exclusive lock that also hands out its order number, so the order
    numbers of all copies on one computer follow the order in which the files were read.
    """
    state = state_dir or default_state_dir()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(state / "snapshot.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        counter = state / "snapshot.counter"
        try:
            order = int(counter.read_text() or "0") + 1
        except FileNotFoundError:
            order = 1
        counter.write_text(str(order))
        snap = _read_declared(home, declared)
        snap.order = order
        return snap


def _read_declared(home: Path, declared: Iterable[DeclaredFile]) -> CredentialSnapshot:
    records: list[FileRecord] = []
    blobs: dict[str, bytes] = {}
    for d in declared:
        sig, data = read_stable(home / d.path)
        if data is None:
            records.append(FileRecord(path=d.path, state="absent"))
            continue
        records.append(
            FileRecord(
                path=d.path,
                state="present",
                sha256=hashlib.sha256(data).hexdigest(),
                size=len(data),
                mode=f"{sig.mode:04o}",
            )
        )
        blobs[d.path] = data
    return CredentialSnapshot(records=records, blobs=blobs, taken_at=time.time())


def pack_tar(entries: dict[str, tuple[bytes, int]]) -> bytes:
    """Deterministic, uncompressed tar of regular files: path -> (bytes, mode)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
        for path in sorted(entries):
            data, mode = entries[path]
            ti = tarfile.TarInfo(name=path)
            ti.size = len(data)
            ti.mode = mode
            ti.mtime = 0
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ""
            tf.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def unpack_tar_regular_files(blob: bytes, allowed: set[str] | None = None) -> dict[str, tuple[bytes, int]]:
    """Read regular files from a tar. Refuses links, devices, absolute paths and '..'."""
    out: dict[str, tuple[bytes, int]] = {}
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:") as tf:
        for m in tf.getmembers():
            p = PurePosixPath(m.name)
            if m.isdir():
                continue
            if not m.isreg():
                raise ValueError(f"refusing non-regular tar member {m.name!r}")
            if p.is_absolute() or ".." in p.parts:
                raise ValueError(f"refusing unsafe tar member {m.name!r}")
            if allowed is not None and str(p) not in allowed:
                raise ValueError(f"refusing undeclared tar member {m.name!r}")
            f = tf.extractfile(m)
            assert f is not None
            out[str(p)] = (f.read(), m.mode & 0o7777)
    return out


def credential_manifest(snapshot: CredentialSnapshot, *, computer_id: str, generation: int, seq: int, archive_key: str, archive_sha256: str) -> dict:
    return {
        "format": "cfo.s6.credential-checkpoint",
        "version": FORMAT_VERSION,
        "kind": CRED_KIND,
        "computer_id": computer_id,
        "generation": generation,
        "seq": seq,
        "snapshot_order": snapshot.order,
        "captured_at": snapshot.taken_at,
        "archive": {"key": archive_key, "sha256": archive_sha256},
        "files": [r.to_json() for r in snapshot.records],
    }


# ---------------------------------------------------------------------------------------------
# Workspace snapshots


def iter_workspace_files(home: Path, roots: Iterable[str] = WORKSPACE_ROOTS) -> Iterator[tuple[str, Path]]:
    for root in roots:
        top = home / root
        if not top.exists() and not top.is_symlink():
            continue
        if top.is_file() and not top.is_symlink():
            rel = root
            if not is_credential_or_sibling(rel):
                yield rel, top
            continue
        for dirpath, dirnames, filenames in os.walk(top, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames if d not in WORKSPACE_EXCLUDED_DIRS)
            for fn in sorted(filenames):
                full = Path(dirpath) / fn
                rel = str(full.relative_to(home))
                if is_credential_or_sibling(rel):
                    continue
                if full.is_symlink() or not full.is_file():
                    continue
                yield rel, full


def take_workspace_snapshot(home: Path, roots: Iterable[str] = WORKSPACE_ROOTS) -> dict[str, tuple[bytes, int]]:
    entries: dict[str, tuple[bytes, int]] = {}
    for rel, full in iter_workspace_files(home, roots):
        try:
            _, data = read_stable(full, max_bytes=256 << 20)
        except (UnstableRead, RefusedFile, FileNotFoundError):
            continue  # S3 owns the paused, bounded capture; this spike only needs the contents
        if data is None:
            continue
        entries[rel] = (data, stat.S_IMODE(os.lstat(full).st_mode))
    return entries


def workspace_manifest(entries: dict[str, tuple[bytes, int]], *, computer_id: str, generation: int, seq: int, archive_key: str, archive_sha256: str) -> dict:
    return {
        "format": "cfo.s6.workspace-checkpoint",
        "version": FORMAT_VERSION,
        "kind": WORKSPACE_KIND,
        "computer_id": computer_id,
        "generation": generation,
        "seq": seq,
        "captured_at": time.time(),
        "archive": {"key": archive_key, "sha256": archive_sha256},
        "file_count": len(entries),
        "bytes": sum(len(d) for d, _ in entries.values()),
    }


# ---------------------------------------------------------------------------------------------
# Installing


def _ensure_private_dir(path: Path) -> None:
    if not path.exists():
        path.mkdir(parents=True, mode=0o700)


def atomic_install(target: Path, data: bytes, mode: int = 0o600) -> None:
    """Write bytes beside the target, fsync, set the mode, then rename into place."""
    _ensure_private_dir(target.parent)
    tmp = target.parent / f".{target.name}.s6install.{secrets.token_hex(4)}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        view = memoryview(data)
        while view:
            n = os.write(fd, view)
            view = view[n:]
        os.fchmod(fd, mode)
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        tmp.unlink(missing_ok=True)
        raise
    os.close(fd)
    os.replace(tmp, target)
    dfd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def install_workspace(home: Path, entries: dict[str, tuple[bytes, int]]) -> int:
    """Restore workspace files. A credential file in a workspace archive is a bug: refuse it."""
    for rel in entries:
        if is_credential_or_sibling(rel):
            raise ValueError(f"workspace checkpoint holds a credential file: {rel}")
    for rel, (data, mode) in entries.items():
        atomic_install(home / rel, data, mode or 0o600)
    return len(entries)


def stage_and_install_credentials(home: Path, staging: Path, manifest: dict, archive: bytes, declared: Iterable[DeclaredFile] = DECLARED_FILES) -> list[dict]:
    """Second restore step: archive -> staging directory -> declared files only.

    Present files are installed atomically with their recorded mode; tombstoned files are
    deleted. Nothing else under the CLI homes is touched. Returns a report without contents.
    """
    declared = list(declared)
    allowed = {d.path for d in declared}
    if hashlib.sha256(archive).hexdigest() != manifest["archive"]["sha256"]:
        raise ValueError("credential archive does not match its manifest")
    members = unpack_tar_regular_files(archive, allowed=allowed)
    by_path = {f["path"]: f for f in manifest["files"]}
    if set(by_path) != allowed:
        raise ValueError("credential manifest does not record every declared file")

    staging.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(staging, 0o700)
    for rel, (data, mode) in members.items():
        rec = by_path[rel]
        if rec["state"] != "present" or hashlib.sha256(data).hexdigest() != rec["sha256"]:
            raise ValueError(f"staged file {rel} does not match its manifest record")
        atomic_install(staging / rel, data, 0o600)

    report = []
    for d in declared:
        rec = by_path[d.path]
        target = home / d.path
        if rec["state"] == "present":
            data = (staging / d.path).read_bytes()
            mode = int(rec.get("mode") or "0600", 8)
            atomic_install(target, data, mode)
            report.append({"path": d.path, "action": "installed", "size": len(data), "mode": f"{mode:04o}"})
        else:
            existed = target.exists() or target.is_symlink()
            if existed:
                target.unlink()
            report.append({"path": d.path, "action": "tombstone-deleted" if existed else "tombstone-absent"})
    # The staging copy holds credential bytes; remove it once installed.
    for rel in members:
        (staging / rel).unlink(missing_ok=True)
    return report
