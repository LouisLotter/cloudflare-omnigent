"""The declared credential files: copies, tombstones, install, and the watcher.

Only the declared files travel (``DeclaredCredentialPath``), as opaque bytes, never parsed.
- **A bundle is one whole snapshot.** Every declared file is read under one lock, each copy
  read stably (same inode, size and modification time before and after), and the bundle takes
  the next order number. A file's copy order is that of the snapshot that last found it
  changed, so it never decreases in a generation; an absent file is a tombstone, so a logout is
  never undone by an older copy (S6; ``credentialIsNewer``).
- **The watcher** polls the files' metadata, waits until a change has settled for 500 ms (Codex
  rewrites its file in place), and then takes a bundle; after 10 s of continuous change it takes
  one anyway, still with a stable read. A file some process still holds open for writing is
  never copied (a stalled in-place write would otherwise be copied torn).
- **Publication** is retried until WorkspaceDO acknowledges it (``published`` or
  ``superseded``, R-18). A newer bundle replaces one still waiting.
- **Install** writes the files of a bundle into a staging directory first, then replaces only
  the declared files, deleting tombstoned ones. The CLI homes are never replaced wholesale. The
  same install, into a scratch directory, verifies a sign-out (Q6).
"""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
import shutil
import stat
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .contract import (
    CREDENTIAL_FORMAT_VERSION,
    DECLARED_CREDENTIAL_PATHS,
    MAX_CREDENTIAL_FILE_BYTES,
)

SETTLE_S = 0.5
FORCE_AFTER_S = 10.0
POLL_S = 0.25


class UnstableRead(Exception):
    """A declared file changed while it was read; try again once it settles."""


class CredentialAlert(Exception):
    """A declared file the supervisor refuses to copy (too large, or not a regular file)."""


def _signature(path: Path) -> tuple[int, ...] | None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    return (st.st_mode, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def _writers_among(pids: list[str], st: os.stat_result) -> tuple[bool, list[str]]:
    """(found a writer, pids whose descriptors could not be read)."""
    unreadable = []
    for pid in pids:
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
        except PermissionError:
            unreadable.append(pid)
            continue
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.stat(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if (target.st_dev, target.st_ino) != (st.st_dev, st.st_ino):
                continue
            try:
                with open(f"/proc/{pid}/fdinfo/{fd}") as info:
                    flags = next(
                        (int(line.split()[1], 8) for line in info if line.startswith("flags:")), 0
                    )
            except (OSError, ValueError):
                return True, unreadable
            if flags & (os.O_WRONLY | os.O_RDWR):
                return True, unreadable
    return False, unreadable


def open_for_writing(st: os.stat_result) -> bool:
    """Whether any process holds this inode open for writing.

    Codex rewrites ``auth.json`` in place (truncate, then write), so a writer that stalls
    mid-write leaves a torn file whose size and modification time hold still: settling and a
    stable read alone would copy it (found by this package's tests with a slow fake writer).
    An open write descriptor means the write is not over. Root reads every process's
    descriptors where it has CAP_SYS_PTRACE (Cloudflare, S3); without it (Docker's default),
    another account's processes are inspected from a child that drops to that account. A
    process neither can read counts as a writer: never copy what cannot be checked.
    """
    pids = [p for p in os.listdir("/proc") if p.isdigit()]
    found, unreadable = _writers_among(pids, st)
    if found or not unreadable:
        return found
    if os.geteuid() != 0:
        # Without root (tests only), another account's processes are out of reach; a declared
        # file is 0600 and the account's own processes were read above.
        return False
    by_uid: dict[int, list[str]] = {}
    for pid in unreadable:
        try:
            by_uid.setdefault(os.stat(f"/proc/{pid}").st_uid, []).append(pid)
        except OSError:
            continue
    for uid, group in by_uid.items():
        child = os.fork()
        if child == 0:  # only os calls in the child
            code = 2
            try:
                os.setgroups([])
                os.setgid(uid)
                os.setuid(uid)
                hit, still = _writers_among(group, st)
                code = 1 if hit or still else 0
            finally:
                os._exit(code)
        _pid, status = os.waitpid(child, 0)
        if os.waitstatus_to_exitcode(status) != 0:
            return True
    return False


def read_stably(path: Path) -> tuple[bytes, int] | None:
    """(content, mode) of a declared file, or None when it is absent. Never follows a link."""
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise CredentialAlert("a declared credential path is not a regular file")
    if before.st_size > MAX_CREDENTIAL_FILE_BYTES:
        raise CredentialAlert("a declared credential file is larger than the limit")
    if open_for_writing(before):
        raise UnstableRead("a writer still holds the file open")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        data = b""
        while True:
            block = os.read(fd, MAX_CREDENTIAL_FILE_BYTES + 1 - len(data))
            if not block:
                break
            data += block
            if len(data) > MAX_CREDENTIAL_FILE_BYTES:
                raise UnstableRead("the file grew while it was read")
        during = os.fstat(fd)
    finally:
        os.close(fd)
    try:
        after = os.lstat(path)
    except FileNotFoundError as exc:
        raise UnstableRead("the file went away while it was read") from exc
    same = lambda a, b: (a.st_ino, a.st_size, a.st_mtime_ns) == (b.st_ino, b.st_size, b.st_mtime_ns)  # noqa: E731
    if not (same(before, during) and same(during, after)) or len(data) != after.st_size:
        raise UnstableRead("the file changed while it was read")
    return data, stat.S_IMODE(after.st_mode) & 0o777


@dataclass
class _Copy:
    digest: str | None  # None: a tombstone
    copy_order: int
    mode: int = 0o600
    content: bytes = b""


@dataclass
class InstallResult:
    installed: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)


def install_bundle(
    bundle: dict[str, Any] | None,
    *,
    home: Path,
    staging: Path,
    uid: int,
    gid: int,
) -> InstallResult:
    """Install a bundle's declared files into ``home`` through ``staging``.

    Present files are written whole into the staging directory, then renamed over their
    targets one by one; tombstoned files are deleted. Nothing else in the home changes.
    """
    result = InstallResult()
    if bundle is None:
        return result
    root = os.geteuid() == 0
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(mode=0o700, parents=True)
    staged: dict[str, Path] = {}
    try:
        for rel in DECLARED_CREDENTIAL_PATHS:
            entry = bundle["files"][rel]
            if entry["state"] != "present":
                continue
            content = base64.b64decode(entry["contentBase64"], validate=True)
            if len(content) > MAX_CREDENTIAL_FILE_BYTES:
                raise CredentialAlert("a bundle file is larger than the limit")
            tmp = staging / secrets.token_hex(8)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, content)
                os.fsync(fd)
            finally:
                os.close(fd)
            staged[rel] = tmp
        for rel in DECLARED_CREDENTIAL_PATHS:
            entry = bundle["files"][rel]
            target = home / rel
            parent = target.parent
            if entry["state"] == "present":
                if not parent.exists():
                    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    if root:
                        os.chown(parent, uid, gid)
                if parent.is_symlink():
                    raise CredentialAlert("a credential directory is a symbolic link")
                tmp = parent / f".{target.name}.cfo-install.{secrets.token_hex(6)}"
                shutil.move(str(staged[rel]), tmp)
                if root:
                    os.chown(tmp, uid, gid)
                os.chmod(tmp, int(entry["mode"]) & 0o777)
                os.replace(tmp, target)
                result.installed.append(rel)
            elif os.path.lexists(target):
                os.unlink(target)
                result.removed.append(rel)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return result


def declared_present(home: Path) -> list[str]:
    return [rel for rel in DECLARED_CREDENTIAL_PATHS if os.path.lexists(home / rel)]


def verify_signed_out(bundle: dict[str, Any] | None, *, scratch: Path, uid: int, gid: int) -> list[str]:
    """Install ``bundle`` into an empty scratch home, as a fresh computer would, and list the
    declared files present afterwards: empty means the bundle is signed out (Q6)."""
    shutil.rmtree(scratch, ignore_errors=True)
    home = scratch / "home"
    home.mkdir(mode=0o700, parents=True)
    try:
        install_bundle(bundle, home=home, staging=scratch / "staging", uid=uid, gid=gid)
        return declared_present(home)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


class Credentials:
    """Copy numbering, bundles and the watcher for one generation."""

    def __init__(
        self,
        *,
        home: Path,
        computer_id: str,
        generation: int,
        publish: Callable[[dict[str, Any]], str],
        alert: Callable[[str], None] = lambda message: None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.home = home
        self.computer_id = computer_id
        self.generation = generation
        self._publish = publish
        self._alert = alert
        self._clock = clock
        self._lock = threading.RLock()
        self._order = 0
        self._copies: dict[str, _Copy] = {}
        self._signatures: dict[str, tuple[int, ...] | None] = {}
        self._latest: dict[str, Any] | None = None
        self._acknowledged: dict[str, Any] | None = None
        self._outbox: dict[str, Any] | None = None
        self._started = False
        self._dirty_since: float | None = None
        self._last_change: float | None = None
        self._seen: dict[str, tuple[int, ...] | None] = {}
        self._stop = threading.Event()
        self._wake = threading.Event()
        self.on_change: Callable[[], None] = lambda: None

    # -- numbering and bundles ----------------------------------------------------------------

    @property
    def order(self) -> int:
        with self._lock:
            return self._order

    @property
    def started(self) -> bool:
        return self._started

    def baseline(self) -> None:
        """After an install: the current files are the starting point; the watcher starts."""
        with self._lock:
            self._signatures = {rel: _signature(self.home / rel) for rel in DECLARED_CREDENTIAL_PATHS}
            self._seen = dict(self._signatures)
            self._started = True

    def snapshot(self, *, force: bool = False) -> dict[str, Any] | None:
        """Take a whole bundle under the lock: a new order if any file changed (or ``force``).

        Returns the bundle, or None when nothing changed and nothing was forced. Raises
        :class:`UnstableRead` when a file is still being written.
        """
        with self._lock:
            reads: dict[str, tuple[bytes, int] | None] = {}
            signatures: dict[str, tuple[int, ...] | None] = {}
            for rel in DECLARED_CREDENTIAL_PATHS:
                path = self.home / rel
                signatures[rel] = _signature(path)
                try:
                    reads[rel] = read_stably(path)
                except CredentialAlert as exc:
                    self._alert(str(exc))
                    raise
            changed = []
            for rel, read in reads.items():
                digest = hashlib.sha256(read[0]).hexdigest() if read is not None else None
                old = self._copies.get(rel)
                if old is None or old.digest != digest or (read is not None and old.mode != read[1]):
                    changed.append(rel)
            if not changed and not force and self._latest is not None:
                self._signatures = signatures
                return None
            if changed or self._latest is None:
                self._order += 1
                for rel in changed or list(DECLARED_CREDENTIAL_PATHS):
                    read = reads[rel]
                    if read is None:
                        self._copies[rel] = _Copy(None, self._order)
                    else:
                        self._copies[rel] = _Copy(
                            hashlib.sha256(read[0]).hexdigest(), self._order, read[1], read[0]
                        )
            self._signatures = signatures
            self._latest = self._bundle()
            return self._latest

    def _bundle(self) -> dict[str, Any]:
        files: dict[str, Any] = {}
        for rel in DECLARED_CREDENTIAL_PATHS:
            copy = self._copies[rel]
            if copy.digest is None:
                files[rel] = {"state": "tombstone", "copyOrder": copy.copy_order}
            else:
                files[rel] = {
                    "state": "present",
                    "mode": copy.mode,
                    "copyOrder": copy.copy_order,
                    "contentBase64": base64.b64encode(copy.content).decode("ascii"),
                }
        return {
            "formatVersion": CREDENTIAL_FORMAT_VERSION,
            "computerId": self.computer_id,
            "generation": self.generation,
            "order": max(f["copyOrder"] for f in files.values()),
            "files": files,
        }

    def pending(self) -> list[str]:
        """Declared files changed since the last acknowledged bundle (``credentialsPending``)."""
        with self._lock:
            out = set()
            acked = self._acknowledged
            for rel in DECLARED_CREDENTIAL_PATHS:
                copy = self._copies.get(rel)
                if copy is not None and (
                    acked is None or acked["files"][rel]["copyOrder"] < copy.copy_order
                ):
                    out.add(rel)
                if self._started and _signature(self.home / rel) != self._signatures.get(rel):
                    out.add(rel)
            return [rel for rel in DECLARED_CREDENTIAL_PATHS if rel in out]

    # -- publication --------------------------------------------------------------------------

    def enqueue(self, bundle: dict[str, Any]) -> None:
        with self._lock:
            if self._outbox is None or bundle["order"] >= self._outbox["order"]:
                self._outbox = bundle
        self._wake.set()

    def publish_pending(self) -> bool:
        """Send the waiting bundle once; True when nothing is left waiting."""
        with self._lock:
            bundle = self._outbox
        if bundle is None:
            return True
        outcome = self._publish(bundle)  # raises on transport failure: retried
        with self._lock:
            if outcome in ("published", "superseded"):
                if self._acknowledged is None or bundle["order"] >= self._acknowledged["order"]:
                    self._acknowledged = bundle
                if self._outbox is bundle:
                    self._outbox = None
        self.on_change()
        return self._outbox is None

    # -- the watcher --------------------------------------------------------------------------

    def tick(self) -> None:
        """One poll: notice changes, and take a bundle once they settle (or after 10 s)."""
        if not self._started:
            return
        now = self._clock()
        with self._lock:
            current = {rel: _signature(self.home / rel) for rel in DECLARED_CREDENTIAL_PATHS}
            if current != self._seen:
                self._seen = current
                self._last_change = now
                if self._dirty_since is None and current != self._signatures:
                    self._dirty_since = now
            if self._dirty_since is None:
                return
            settled = now - (self._last_change or now) >= SETTLE_S
            forced = now - self._dirty_since >= FORCE_AFTER_S
            if not (settled or forced):
                return
            try:
                bundle = self.snapshot()
            except UnstableRead:
                return
            except CredentialAlert:
                bundle = None
            self._dirty_since = None
        if bundle is not None:
            self.enqueue(bundle)
            self.on_change()

    def run(self, retry_s: Callable[[int], float] = lambda n: min(30.0, 0.5 * 2**n)) -> None:
        """The watcher and publisher loop, until :meth:`stop`."""
        failures = 0
        next_send = 0.0
        while not self._stop.is_set():
            self.tick()
            if self._clock() >= next_send:
                try:
                    if not self.publish_pending():
                        next_send = 0.0
                    failures = 0
                except Exception:  # noqa: BLE001 - any transport failure: retry with backoff
                    failures += 1
                    next_send = self._clock() + retry_s(failures)
            self._wake.wait(POLL_S)
            self._wake.clear()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
