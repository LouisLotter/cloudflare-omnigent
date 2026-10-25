"""Bringing the kept snapshot up to date with the saved part of the home directory.

A capture runs this twice (design, "Capture sequence", step 3):
- **unpaused,** with ``content=False``: a file whose size and modification time match its copy
  is skipped; the result is inconsistent, but it moves most of the bytes while work goes on;
- **paused,** with ``content=True``: every file is compared byte for byte with its copy, so a
  rewrite that kept the size and the modification time is still caught (IR-011). This reads
  both trees, which is the cost owner decision D25 accepted for version 1.

The set of paths comes from one scan with the checkpoint policy (``tree.scan_home``); anything
else in the snapshot is removed, so an excluded or deleted path never survives a capture.

The snapshot is never written in place: a changed file or link is written beside its target and
renamed over it, so a hard link to the previous copy (a staged layer) keeps its bytes. Symbolic
links are copied as links and never followed. Every step is checked; ``check()`` is called
before each entry and each chunk, so an expired lease stops the copy within one chunk.
"""

from __future__ import annotations

import contextlib
import errno
import os
import secrets
import shutil
import stat
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

CHUNK = 1 << 20
TMP_PREFIX = ".cfo-copy-tmp."


class Stopped(Exception):
    """The lease ended (or the controller asked to stop) during the copy."""


class CopyFailed(Exception):
    """A copy step failed; ``reason`` is the contract's ``CaptureFailure``."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason


@dataclass
class SyncStats:
    entries: int = 0
    copied_files: int = 0
    copied_bytes: int = 0
    compared_bytes: int = 0
    removed: int = 0
    vanished: int = 0


def _fail(exc: OSError, what: str) -> CopyFailed:
    reason = "disk_budget" if exc.errno in (errno.ENOSPC, errno.EDQUOT) else "copy_failed"
    return CopyFailed(reason, f"{what}: {errno.errorcode.get(exc.errno or 0, 'error')}")


def _remove(path: str) -> None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(st.st_mode):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def _same_content(a: str, b: str, size: int, check: Callable[[], None], stats: SyncStats) -> bool:
    with open(a, "rb", buffering=0) as fa, open(b, "rb", buffering=0) as fb:
        remaining = size
        while remaining > 0:
            check()
            x = fa.read(CHUNK)
            y = fb.read(CHUNK)
            stats.compared_bytes += len(x)
            if x != y:
                return False
            if not x:
                break
            remaining -= len(x)
        # A source that grew while it was read is not equal to the copy.
        return fa.read(1) == fb.read(1) == b""


def _copy_file(
    src: str, dst: str, st: os.stat_result, check: Callable[[], None], stats: SyncStats
) -> None:
    tmp = os.path.join(os.path.dirname(dst), TMP_PREFIX + secrets.token_hex(6))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        try:
            with open(src, "rb", buffering=0) as fin:
                while True:
                    check()
                    block = fin.read(CHUNK)
                    if not block:
                        break
                    view = memoryview(block)
                    while view:
                        n = os.write(fd, view)
                        view = view[n:]
                    stats.copied_bytes += len(block)
            if os.geteuid() == 0:
                os.fchown(fd, st.st_uid, st.st_gid)
            os.fchmod(fd, stat.S_IMODE(st.st_mode))
        finally:
            os.close(fd)
        os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns), follow_symlinks=False)
        os.replace(tmp, dst)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    stats.copied_files += 1


def _fix_metadata(dst: str, st: os.stat_result, *, link: bool) -> None:
    cur = os.lstat(dst)
    if os.geteuid() == 0 and (cur.st_uid, cur.st_gid) != (st.st_uid, st.st_gid):
        os.lchown(dst, st.st_uid, st.st_gid)
    if not link and stat.S_IMODE(cur.st_mode) != stat.S_IMODE(st.st_mode):
        os.chmod(dst, stat.S_IMODE(st.st_mode))


def clean_temporaries(snapshot: str | os.PathLike[str]) -> int:
    """Remove copy temporaries a killed capture left behind."""
    removed = 0
    for dirpath, dirnames, filenames in os.walk(snapshot):
        for name in [*filenames, *dirnames]:
            if name.startswith(TMP_PREFIX):
                _remove(os.path.join(dirpath, name))
                removed += 1
    return removed


def sync_snapshot(
    home: str | os.PathLike[str],
    snapshot: str | os.PathLike[str],
    entries: list[tuple[str, os.stat_result]],
    *,
    content: bool,
    check: Callable[[], None] = lambda: None,
) -> SyncStats:
    """Make ``snapshot`` hold exactly ``entries`` (from a scan of ``home``), with their bytes.

    Raises :class:`Stopped` from ``check``, or :class:`CopyFailed` when a snapshot-side step
    fails. A source path that vanished since the scan is removed from the snapshot.
    """
    home, snapshot = os.fspath(home), os.fspath(snapshot)
    stats = SyncStats(entries=len(entries))
    desired = {rel: st for rel, st in entries}
    try:
        os.makedirs(snapshot, exist_ok=True)
        # 1. Remove what must not be there: unsaved, deleted, or of another type.
        stack = [""]
        while stack:
            rel_dir = stack.pop()
            base = os.path.join(snapshot, rel_dir) if rel_dir else snapshot
            with os.scandir(base) as it:
                children = list(it)
            for child in children:
                check()
                rel = f"{rel_dir}/{child.name}" if rel_dir else child.name
                want = desired.get(rel)
                is_dir = child.is_dir(follow_symlinks=False)
                if want is None or stat.S_ISDIR(want.st_mode) != is_dir:
                    _remove(child.path)
                    stats.removed += 1
                elif is_dir:
                    stack.append(rel)
        # 2. Bring every saved entry up to date, parents first.
        dirs: list[tuple[str, os.stat_result]] = []
        for rel, scanned in entries:
            check()
            src = os.path.join(home, rel)
            dst = os.path.join(snapshot, rel)
            mode = scanned.st_mode
            if stat.S_ISDIR(mode):
                if not os.path.isdir(dst) or os.path.islink(dst):
                    _remove(dst)
                    os.mkdir(dst, 0o700)
                dirs.append((dst, scanned))
                continue
            try:
                cur = os.lstat(src)
            except FileNotFoundError:
                cur = None
            if cur is None or stat.S_IFMT(cur.st_mode) != stat.S_IFMT(mode):
                # Gone, or replaced by another type, since the scan: the next scan decides.
                _remove(dst)
                stats.vanished += 1
                continue
            if stat.S_ISLNK(mode):
                try:
                    target = os.readlink(src)
                except FileNotFoundError:
                    _remove(dst)
                    stats.vanished += 1
                    continue
                if not (os.path.islink(dst) and os.readlink(dst) == target):
                    tmp = os.path.join(os.path.dirname(dst), TMP_PREFIX + secrets.token_hex(6))
                    os.symlink(target, tmp)
                    os.replace(tmp, dst)
                    stats.copied_files += 1
                _fix_metadata(dst, cur, link=True)
                continue
            try:
                have = os.lstat(dst)
            except FileNotFoundError:
                have = None
            if have is None or not stat.S_ISREG(have.st_mode) or have.st_size != cur.st_size:
                need = True
            elif not content:
                need = have.st_mtime_ns != cur.st_mtime_ns
            else:
                try:
                    need = not _same_content(src, dst, cur.st_size, check, stats)
                except FileNotFoundError:
                    _remove(dst)
                    stats.vanished += 1
                    continue
            if need:
                try:
                    _copy_file(src, dst, cur, check, stats)
                except FileNotFoundError:
                    _remove(dst)
                    stats.vanished += 1
                    continue
            _fix_metadata(dst, cur, link=False)
        # 3. Directory owners and modes last, deepest first, so a read-only one still fills.
        for dst, scanned in reversed(dirs):
            _fix_metadata(dst, scanned, link=False)
    except OSError as exc:
        raise _fail(exc, "snapshot copy") from exc
    return stats


def tree_bytes(top: str | os.PathLike[str]) -> int:
    """Total size of the regular files under ``top`` (zero if it does not exist)."""
    total = 0
    for dirpath, _dirnames, filenames in os.walk(top):
        for name in filenames:
            try:
                st = os.lstat(os.path.join(dirpath, name))
            except FileNotFoundError:
                continue
            if stat.S_ISREG(st.st_mode):
                total += st.st_size
    return total


def free_bytes(path: str | os.PathLike[str]) -> int:
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


def snapshot_paths(snapshot: Path) -> set[str]:
    from .tree import walk_all

    return set(walk_all(os.fspath(snapshot)))
