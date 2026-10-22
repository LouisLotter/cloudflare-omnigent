"""Incremental workspace layers (AR-25): index, delta, staging, merge on restore, verify.

The design's incremental saves, as far as the staging probe needs them:

* An **index** of a snapshot maps every path (``<root name>/<relative path>``)
  to its type, mode, owner, size and SHA-256 (files) or target (symbolic links). A
  file whose inode, size, mtime and ctime are unchanged since the previous
  index keeps its hash, so only changed files are read again. The kept snapshot
  is written only by the capture's rsync, so its ctime moves on every write.
* A **delta** is the paths whose entry changed or is new, plus the paths that
  are gone. A **base** is every path.
* A **layer** is a directory staged for ``DirectoryBackup``: the changed
  entries, hard-linked from the snapshot, and ``.cfo-layer.json`` with the
  deleted paths. The staged hard links share the snapshot's inodes, so the
  next capture must not start before the upload ends (the campaign is
  sequential; production needs a copy or no ``--inplace``).
* **Restore** applies the base and each delta in order into a staging tree:
  deleted paths are validated (relative, inside a declared root, no ``..``,
  no symbolic link on the way), credential members are stripped, and the
  result is checked against the last layer's index.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import time
from typing import Any

from . import credpolicy

LAYER_META = ".cfo-layer.json"
FORMAT = 1
CHUNK = 1 << 20


class LayerError(RuntimeError):
    pass


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb", buffering=0) as fh:
        while True:
            b = fh.read(CHUNK)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def build_index(top: str, prev: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Index every entry under ``top`` (a snapshot or a restored tree).

    Returns (index, stats). ``prev`` lends hashes to files whose cache key is
    unchanged. The layer metadata file is never indexed.
    """
    t0 = time.monotonic()
    prev = prev or {}
    index: dict[str, Any] = {}
    hashed = hashed_bytes = total_bytes = files = 0
    for name in sorted(os.listdir(top)):
        if name == LAYER_META:
            continue
        stack = [name]
        while stack:
            rel = stack.pop()
            full = os.path.join(top, rel)
            st = os.lstat(full)
            mode = stat.S_IMODE(st.st_mode)
            owner = f"{st.st_uid}:{st.st_gid}"
            if stat.S_ISDIR(st.st_mode):
                index[rel] = {"t": "d", "m": mode, "o": owner}
                with os.scandir(full) as it:
                    stack.extend(os.path.join(rel, e.name) for e in it)
            elif stat.S_ISLNK(st.st_mode):
                index[rel] = {"t": "l", "m": mode, "o": owner, "l": os.readlink(full)}
            elif stat.S_ISREG(st.st_mode):
                key = [st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]
                old = prev.get(rel)
                if old and old.get("t") == "f" and old.get("k") == key:
                    digest = old["h"]
                else:
                    digest = _sha256(full)
                    hashed += 1
                    hashed_bytes += st.st_size
                index[rel] = {"t": "f", "m": mode, "o": owner, "s": st.st_size, "h": digest, "k": key}
                files += 1
                total_bytes += st.st_size
            # Sockets, devices and FIFOs are not kept, as in DirectoryBackup.
    return index, {"entries": len(index), "files": files, "bytes": total_bytes, "hashed_files": hashed,
                   "hashed_bytes": hashed_bytes, "index_s": round(time.monotonic() - t0, 3)}


def _logical(e: dict[str, Any]) -> tuple[Any, ...]:
    return (e.get("t"), e.get("m"), e.get("o"), e.get("s"), e.get("h"), e.get("l"))


def diff(prev: dict[str, Any], cur: dict[str, Any]) -> tuple[list[str], list[str]]:
    """(changed or new paths, deleted paths). A deleted directory hides its children."""
    changed = sorted(p for p, e in cur.items() if p not in prev or _logical(prev[p]) != _logical(e))
    gone = sorted(p for p in prev if p not in cur)
    deleted: list[str] = []
    for p in gone:
        if deleted and p.startswith(deleted[-1] + "/"):
            continue
        deleted.append(p)
    return changed, deleted


def stage(snapshot: str, layer_dir: str, index: dict[str, Any], changed: list[str], deleted: list[str],
          meta: dict[str, Any]) -> dict[str, Any]:
    """Stage a layer directory: the changed entries (hard links) and the metadata file."""
    t0 = time.monotonic()
    if os.path.exists(layer_dir):
        shutil.rmtree(layer_dir)
    os.makedirs(layer_dir)
    by_root: dict[str, int] = {}
    nbytes = nfiles = 0
    biggest: list[tuple[int, str]] = []
    made: list[str] = []  # staged directories, which mirror the snapshot's owner and mode

    def mkdir_like(rel: str) -> None:
        missing = []
        cur = rel
        while cur and not os.path.isdir(os.path.join(layer_dir, cur)):
            missing.append(cur)
            cur = os.path.dirname(cur)
        for d in reversed(missing):
            os.mkdir(os.path.join(layer_dir, d))
            st = os.lstat(os.path.join(snapshot, d))
            os.chown(os.path.join(layer_dir, d), st.st_uid, st.st_gid)
            made.append(d)

    for rel in changed:  # sorted, so parents come first
        e = index[rel]
        src = os.path.join(snapshot, rel)
        dst = os.path.join(layer_dir, rel)
        mkdir_like(os.path.dirname(rel))
        if e["t"] == "d":
            mkdir_like(rel)
        elif e["t"] == "l":
            os.symlink(e["l"], dst)
            st = os.lstat(src)
            os.lchown(dst, st.st_uid, st.st_gid)
        else:
            try:
                os.link(src, dst)
            except OSError:
                shutil.copy2(src, dst)
                st = os.lstat(src)
                os.chown(dst, st.st_uid, st.st_gid)
            nfiles += 1
            nbytes += e["s"]
            root = rel.split("/", 1)[0]
            by_root[root] = by_root.get(root, 0) + e["s"]
            biggest.append((e["s"], rel))
    # Directory modes after their contents, so a read-only directory still fills.
    for rel in reversed(made):
        os.chmod(os.path.join(layer_dir, rel), stat.S_IMODE(os.lstat(os.path.join(snapshot, rel)).st_mode))
    with open(os.path.join(layer_dir, LAYER_META), "w") as fh:
        json.dump({**meta, "format": FORMAT, "deleted": deleted}, fh)
    biggest.sort(reverse=True)
    return {"changed_entries": len(changed), "changed_files": nfiles, "changed_bytes": nbytes,
            "deleted": len(deleted), "bytes_by_root": by_root,
            "largest": [{"path": p, "bytes": s} for s, p in biggest[:8]],
            "stage_s": round(time.monotonic() - t0, 3)}


def refresh_keys(snapshot: str, index_path: str) -> int:
    """After a staged layer is removed, refresh the cache keys its hard links disturbed.

    Linking and unlinking change a file's ctime, not its contents. A file keeps
    its hash only if its inode, size and mtime are unchanged; the campaign never
    captures between staging and committing, so nothing else wrote it.
    """
    index = load_index(index_path)
    n = 0
    for rel, e in index.items():
        if e.get("t") != "f":
            continue
        try:
            st = os.lstat(os.path.join(snapshot, rel))
        except OSError:
            continue
        k = e["k"]
        if [st.st_ino, st.st_size, st.st_mtime_ns] == k[:3] and st.st_ctime_ns != k[3]:
            e["k"] = [st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]
            n += 1
    with open(index_path, "w") as fh:
        json.dump(index, fh, separators=(",", ":"))
    return n


def save_index(index: dict[str, Any], path: str) -> dict[str, int]:
    """Write the index as JSON with its cache keys, for the next capture.

    Returns the raw and zstd-compressed size of the index a manifest would
    carry (path, type, mode, size, SHA-256 or target; no cache keys): a cost
    every published save pays.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(index, fh, separators=(",", ":"))
    manifest = {p: {k: v for k, v in e.items() if k != "k"} for p, e in index.items()}
    data = json.dumps(manifest, separators=(",", ":"), sort_keys=True).encode()
    z = subprocess.run(["zstd", "-q", "-3", "-c"], input=data, capture_output=True, check=True).stdout
    return {"index_bytes": len(data), "index_zstd_bytes": len(z)}


def load_index(path: str) -> dict[str, Any]:
    with open(path) as fh:
        return json.load(fh)


def validate_deleted(rel: object, roots: set[str]) -> str:
    """A deleted path must stay inside a declared root of the tree; refuse anything else."""
    if not isinstance(rel, str) or not rel or "\0" in rel or rel.startswith("/"):
        raise LayerError(f"refused deleted path {rel!r}: not a relative path")
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise LayerError(f"refused deleted path {rel!r}: not normalized")
    if parts[0] not in roots:
        raise LayerError(f"refused deleted path {rel!r}: outside the declared roots")
    return rel


def _inside(tree: str, rel: str) -> str:
    """The path of rel in tree, refusing a symbolic link on the way (never follow one out)."""
    cur = tree
    parts = rel.split("/")
    for p in parts[:-1]:
        cur = os.path.join(cur, p)
        if os.path.islink(cur):
            raise LayerError(f"refused {rel!r}: {os.path.relpath(cur, tree)} is a symbolic link")
    return os.path.join(tree, rel)


def _remove(path: str) -> None:
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.unlink(path)


def merge(layer_dir: str, tree: str, roots: dict[str, str]) -> dict[str, Any]:
    """Apply one restored layer to the staging tree. ``roots`` maps root names to home-relative names.

    Raises LayerError on a refused path; the caller discards the tree.
    """
    t0 = time.monotonic()
    with open(os.path.join(layer_dir, LAYER_META)) as fh:
        meta = json.load(fh)
    if meta.get("format") != FORMAT:
        raise LayerError(f"unknown layer format {meta.get('format')!r}")
    os.makedirs(tree, exist_ok=True)
    deleted = [validate_deleted(p, set(roots)) for p in meta.get("deleted", [])]
    # Never install a credential member, whatever a layer holds (IR-015).
    stripped: list[str] = []
    for name in sorted(os.listdir(layer_dir)):
        if name == LAYER_META:
            continue
        if name not in roots:
            raise LayerError(f"refused layer entry {name!r}: outside the declared roots")
        for dirpath, _dirs, files in os.walk(os.path.join(layer_dir, name)):
            for f in files:
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, os.path.join(layer_dir, name))
                if credpolicy.is_credential(f"{roots[name]}/{rel}"):
                    os.unlink(full)
                    stripped.append(f"{name}/{rel}")
    for rel in deleted:
        _remove(_inside(tree, rel))
    moved = 0
    # Top-down: a directory the tree lacks moves over whole; otherwise descend.
    stack = sorted((n for n in os.listdir(layer_dir) if n != LAYER_META), reverse=True)
    dir_modes: list[tuple[str, int]] = []
    while stack:
        rel = stack.pop()
        src = os.path.join(layer_dir, rel)
        dst = _inside(tree, rel)
        if os.path.isdir(src) and not os.path.islink(src):
            if os.path.lexists(dst) and (os.path.islink(dst) or not os.path.isdir(dst)):
                _remove(dst)
            if not os.path.lexists(dst):
                os.replace(src, dst)
                moved += 1
                continue
            st = os.lstat(src)
            os.lchown(dst, st.st_uid, st.st_gid)
            dir_modes.append((dst, stat.S_IMODE(st.st_mode)))
            stack.extend(sorted((os.path.join(rel, n) for n in os.listdir(src)), reverse=True))
        else:
            if os.path.isdir(dst) and not os.path.islink(dst):
                shutil.rmtree(dst)
            os.replace(src, dst)
            moved += 1
    for dst, mode in dir_modes:
        os.chmod(dst, mode)
    return {"seq": meta.get("seq"), "base": bool(meta.get("base")), "deleted": len(deleted), "moved": moved,
            "stripped_credential_members": stripped, "merge_s": round(time.monotonic() - t0, 3)}


def verify(tree: str, expected: dict[str, Any]) -> dict[str, Any]:
    """Check a restored tree against an index: same paths, types, modes, sizes, hashes and targets."""
    t0 = time.monotonic()
    got, _ = build_index(tree)
    missing = sorted(set(expected) - set(got))
    extra = sorted(set(got) - set(expected))
    mismatched = sorted(p for p in set(got) & set(expected) if _logical(got[p]) != _logical(expected[p]))
    return {"equal": not (missing or extra or mismatched), "entries": len(got), "missing": len(missing),
            "extra": len(extra), "mismatched": len(mismatched),
            "examples": (missing[:3] + extra[:3] + mismatched[:3]), "verify_s": round(time.monotonic() - t0, 3)}
