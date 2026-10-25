"""The workspace tree as the checkpoint policy saves it: scanning, index entries, digests.

A scan walks the policy's roots under a home directory and yields every saved entry (a regular
file, a directory or a symbolic link, never followed), deciding each path with the one policy.
A directory the policy does not save is skipped whole; a saved one is traversed and each member
decided on its own. Some saved paths are still left out, and reported:
- names that are not valid UTF-8, or paths the contract cannot represent (``RelativePath``);
- sockets, FIFOs and devices, which ``DirectoryBackup`` does not keep either;
- a regular file that shares its inode with an excluded one (a hard link to a login, as Codex's
  private home makes), or has links outside the saved selection, whatever its own path says.

Index entries have the contract's shape (``IndexEntry`` in manifests.ts), and the tree digest is
the SHA-256 of ``canonicalTreeBytes``; ``contracts/vectors/tree-digest-v1.json`` holds both
languages to the same bytes.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .policy import Policy

CHUNK = 1 << 20
MAX_PATH_CHARS = 4096
#: How many example paths a scan keeps per skip reason (the counts are complete).
MAX_EXAMPLES = 20


def representable(rel: str) -> bool:
    """Whether a relative path is a contract ``RelativePath``."""
    if not rel or len(rel) > MAX_PATH_CHARS or "\0" in rel:
        return False
    for segment in rel.split("/"):
        if segment in ("", ".", ".."):
            return False
    return well_formed(rel)


def well_formed(text: str) -> bool:
    """No lone surrogate (an undecodable byte arrives as one, through surrogateescape)."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def sha256_file(path: str | os.PathLike[str]) -> str:
    h = hashlib.sha256()
    with open(path, "rb", buffering=0) as fh:
        while True:
            block = fh.read(CHUNK)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def cache_key(st: os.stat_result) -> list[int]:
    return [st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]


class HashCache:
    """SHA-256 per path, reused while inode, size, mtime and ctime are unchanged.

    Corrupt optional state is discarded. ``load_errors`` and ``invalid_entries`` expose
    recovery without logging file names or cache contents. This is an optimization for
    trusted local state, not authentication of a well-formed but forged digest.
    """

    def __init__(self, entries: dict[str, Any] | None = None) -> None:
        self.entries: dict[str, Any] = {}
        self.invalid_entries = 0
        self.load_errors = 0
        self.hashed_files = 0
        self.hashed_bytes = 0
        if entries is not None:
            if not isinstance(entries, dict):
                self.invalid_entries += 1
            else:
                for rel, entry in entries.items():
                    if isinstance(rel, str) and self._valid_entry(entry):
                        self.entries[rel] = [list(entry[0]), entry[1]]
                    else:
                        self.invalid_entries += 1

    @staticmethod
    def _valid_entry(entry: Any) -> bool:
        return (
            isinstance(entry, list)
            and len(entry) == 2
            and isinstance(entry[0], list)
            and len(entry[0]) == 4
            and all(type(n) is int for n in entry[0])
            and entry[0][0] >= 0
            and entry[0][1] >= 0
            and isinstance(entry[1], str)
            and re.fullmatch(r"[0-9a-f]{64}", entry[1]) is not None
        )

    @classmethod
    def load(cls, path: Path) -> HashCache:
        try:
            entries = json.loads(Path(path).read_text())
            if not isinstance(entries, dict):
                raise ValueError("cache must be an object")
            return cls(entries)
        except (OSError, ValueError, RecursionError):
            cache = cls()
            cache.load_errors += 1
            return cache

    def save(self, path: Path) -> None:
        tmp = Path(f"{path}.tmp")
        tmp.write_text(json.dumps(self.entries, separators=(",", ":")))
        os.replace(tmp, path)

    def digest(self, rel: str, full: str, st: os.stat_result) -> str:
        key = cache_key(st)
        hit = self.entries.get(rel)
        if rel in self.entries:
            if not self._valid_entry(hit):
                self.invalid_entries += 1
                del self.entries[rel]
            elif hit[0] == key:
                return hit[1]
        digest = sha256_file(full)
        self.hashed_files += 1
        self.hashed_bytes += st.st_size
        # A file that changed while it was read is not cached under its old key.
        after = os.lstat(full)
        if cache_key(after) == key:
            self.entries[rel] = [key, digest]
        return digest

    def remember(self, rel: str, st: os.stat_result, digest: str) -> None:
        entry = [cache_key(st), digest]
        if not self._valid_entry(entry):
            raise ValueError("invalid hash cache entry")
        self.entries[rel] = entry


def make_entry(rel: str, st: os.stat_result, full: str, cache: HashCache | None) -> dict[str, Any]:
    """The index entry for one saved path, in the contract's shape."""
    mode = st.st_mode
    if stat.S_ISDIR(mode):
        return {
            "path": rel,
            "type": "dir",
            "mode": stat.S_IMODE(mode),
            "uid": st.st_uid,
            "gid": st.st_gid,
        }
    if stat.S_ISLNK(mode):
        return {
            "path": rel,
            "type": "symlink",
            "uid": st.st_uid,
            "gid": st.st_gid,
            "target": os.readlink(full),
        }
    digest = cache.digest(rel, full, st) if cache is not None else sha256_file(full)
    return {
        "path": rel,
        "type": "file",
        "mode": stat.S_IMODE(mode),
        "uid": st.st_uid,
        "gid": st.st_gid,
        "size": st.st_size,
        "sha256": digest,
    }


def _index_integer(value: Any, maximum: int) -> int:
    """JSON Schema accepts integral floats; never truncate fractions or coerce booleans."""
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or (isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()))
        or not 0 <= value <= maximum
    ):
        raise ValueError("invalid integer in tree index")
    return int(value)


def canonical_tree_bytes(entries: Iterable[dict[str, Any]]) -> bytes:
    """``canonicalTreeBytes`` of manifests.ts: entries sorted by path as UTF-8 bytes, each as
    NUL-terminated fields with a fixed count per type."""
    out: list[str] = []
    for e in sorted(entries, key=lambda e: e["path"].encode("utf-8")):
        uid = _index_integer(e["uid"], 0xFFFFFFFF)
        gid = _index_integer(e["gid"], 0xFFFFFFFF)
        if e["type"] == "file":
            fields = [
                "F",
                e["path"],
                f"{_index_integer(e['mode'], 0o7777):04o}",
                uid,
                gid,
                _index_integer(e["size"], 2**53 - 1),
                e["sha256"],
            ]
        elif e["type"] == "dir":
            fields = [
                "D",
                e["path"],
                f"{_index_integer(e['mode'], 0o7777):04o}",
                uid,
                gid,
            ]
        else:
            fields = ["L", e["path"], uid, gid, e["target"]]
        out.append("".join(f"{f}\0" for f in fields))
    return "".join(out).encode("utf-8")


def tree_digest(entries: Iterable[dict[str, Any]]) -> str:
    return hashlib.sha256(canonical_tree_bytes(entries)).hexdigest()


def logical(entry: dict[str, Any]) -> tuple[Any, ...]:
    """What makes two entries equal: everything in the canonical bytes."""
    return (
        entry["type"],
        entry.get("mode"),
        entry["uid"],
        entry["gid"],
        entry.get("size"),
        entry.get("sha256"),
        entry.get("target"),
    )


@dataclass
class Scan:
    """The saved entries under a home directory, with what was left out and why."""

    entries: list[tuple[str, os.stat_result]] = field(default_factory=list)
    skipped: dict[str, int] = field(default_factory=dict)
    examples: dict[str, list[str]] = field(default_factory=dict)

    def skip(self, reason: str, rel: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1
        shown = self.examples.setdefault(reason, [])
        if len(shown) < MAX_EXAMPLES:
            shown.append(rel if well_formed(rel) else rel.encode("utf-8", "replace").decode())


def scan_home(
    home: str | os.PathLike[str],
    policy: Policy,
    *,
    declared: Iterable[str] = (),
    tmp_rel: str | None = None,
) -> Scan:
    """Walk the policy's roots under ``home`` and return the saved entries in pre-order.

    ``declared`` names the declared credential files (home-relative): their inodes, and every
    excluded file's seen during the walk, are never saved under another name. For every other
    multiply linked file, ALL links must be distinct saved paths. This accounts for aliases
    into skipped directories or outside the roots without crawling excluded trees. An
    unaccounted link is conservatively refused, even if its contents might be harmless.

    Like the rest of this scanner, this audit describes a quiescent tree. The capture caller
    must freeze writers and verify its copy before publishing; it cannot reuse an old scan.
    """
    home = os.fspath(home)
    result = Scan()
    excluded_inodes: set[tuple[int, int]] = set()
    for rel in declared:
        try:
            st = os.lstat(os.path.join(home, rel))
        except OSError:
            continue
        if stat.S_ISREG(st.st_mode):
            excluded_inodes.add((st.st_dev, st.st_ino))
    regular: dict[tuple[int, int], list[int]] = {}

    def visit(rel: str, st: os.stat_result) -> bool:
        """Record one path; return whether to descend into it."""
        decision = policy.classify(rel, tmp_rel=tmp_rel)
        mode = st.st_mode
        if not decision.saved:
            if decision.action == "unclassified":
                result.skip("unclassified", rel)
            if stat.S_ISREG(mode):
                excluded_inodes.add((st.st_dev, st.st_ino))
            return False
        if not representable(rel):
            result.skip("unrepresentable", rel)
            return False
        if stat.S_ISLNK(mode):
            try:
                target = os.readlink(os.path.join(home, rel))
            except OSError:
                result.skip("unreadable", rel)
                return False
            if not target or not well_formed(target) or len(target) > MAX_PATH_CHARS:
                result.skip("unrepresentable", rel)
                return False
        elif not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            result.skip("special_file", rel)
            return False
        if stat.S_ISREG(mode):
            regular.setdefault((st.st_dev, st.st_ino), []).append(len(result.entries))
        result.entries.append((rel, st))
        return stat.S_ISDIR(mode)

    for root in policy.roots:
        try:
            st = os.lstat(os.path.join(home, root))
        except FileNotFoundError:
            continue
        if not visit(root, st):
            continue
        stack = [root]
        while stack:
            rel_dir = stack.pop()
            try:
                with os.scandir(os.path.join(home, rel_dir)) as it:
                    children = sorted(it, key=lambda e: e.name, reverse=True)
            except FileNotFoundError:
                continue
            for child in children:
                rel = f"{rel_dir}/{child.name}"
                try:
                    st = os.lstat(child.path)
                except FileNotFoundError:
                    continue
                if visit(rel, st):
                    stack.append(rel)
    if regular:
        refused: set[int] = set()
        for identity, positions in regular.items():
            paths = {result.entries[i][0] for i in positions}
            link_counts = {result.entries[i][1].st_nlink for i in positions}
            if identity in excluded_inodes:
                reason = "hard_link_to_excluded"
            elif link_counts != {len(paths)}:
                reason = "unaccounted_hard_link"
            else:
                continue
            for i in positions:
                refused.add(i)
                result.skip(reason, result.entries[i][0])
        result.entries = [e for i, e in enumerate(result.entries) if i not in refused]
    return result


def build_index(
    top: str | os.PathLike[str],
    paths: Iterable[str] | None = None,
    *,
    cache: HashCache | None = None,
) -> list[dict[str, Any]]:
    """Index entries for ``paths`` under ``top`` (by default every entry under it)."""
    top = os.fspath(top)
    if paths is None:
        paths = list(walk_all(top))
    out = []
    for rel in paths:
        full = os.path.join(top, rel)
        out.append(make_entry(rel, os.lstat(full), full, cache))
    return out


def walk_all(top: str, *, skip_top_names: Iterable[str] = ()) -> Iterable[str]:
    """Every path under ``top``, relative to it, in pre-order; links are not followed."""
    skip = set(skip_top_names)
    stack = [""]
    while stack:
        rel_dir = stack.pop()
        with os.scandir(os.path.join(top, rel_dir) if rel_dir else top) as it:
            children = sorted(it, key=lambda e: e.name, reverse=True)
        for child in children:
            if not rel_dir and child.name in skip:
                continue
            rel = f"{rel_dir}/{child.name}" if rel_dir else child.name
            yield rel
            if child.is_dir(follow_symlinks=False):
                stack.append(rel)
