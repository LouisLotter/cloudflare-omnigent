"""Restoring a workspace checkpoint: the layers merged, checked, then moved into place.

WorkspaceDO restores each layer of the manifest with ``DirectoryBackup`` into its own
directory under ``/var/cfo/restore`` (``layerDirs``) and sends ``restore_workspace``. Here:

1. every layer directory must be a real directory under the restore root; its index file's
   SHA-256 must be the manifest's ``indexSha256``, and the index must parse (``LayerIndex``),
   name the same layer, kind, computer and format, and chain to the previous layer's digest;
2. each layer is applied in order to a running index (deletions first, with everything below
   them, then entries), and the whole index's digest must be the layer's ``treeDigest``.
   Every path must lie under one of the manifest's roots, which must be the policy's roots;
3. the same steps are applied to a merge tree on disk: deleted paths are validated and never
   reached through a symbolic link; files are hard-linked out of the layer directory;
4. only then is the policy applied: a member the policy does not save (a credential family, a
   secret, anything excluded) is removed from the tree, never installed, and reported. The
   layer checks above ran on the published index, so a later, stricter policy never fails a
   restore;
5. owners and modes are applied, and the merge tree is checked against the index, entry by
   entry, with every file hashed;
6. each root is moved into the home by rename; a failure moves back what was moved.

A missing or corrupt layer, a refused path or a failed check leaves the home as it was.
The published index (unstripped) becomes the parent of the next delta.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import shutil
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .contract import (
    LAYER_INDEX_PATH,
    LAYER_METADATA_DIR,
    WORKSPACE_FORMAT_VERSION,
    Contract,
    ContractError,
)
from .policy import Policy
from .tree import logical, make_entry, tree_digest, walk_all

#: Largest layer index read (a base of a million entries is far below this).
MAX_INDEX_BYTES = 512 * 1024 * 1024


class RestoreFailed(Exception):
    """``reason`` is the contract's ``RestoreFailure``."""

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(detail or reason)
        self.reason = reason


@dataclass
class RestoreResult:
    tree_digest: str | None
    entries: int
    stripped: list[str] = field(default_factory=list)
    index: list[dict[str, Any]] = field(default_factory=list)


def _under_roots(path: str, roots: list[str]) -> bool:
    return any(path == r or path.startswith(r + "/") for r in roots)


def _inside(tree: str, rel: str) -> str:
    """``rel`` in ``tree``, refusing a symbolic link on the way (never follow one out)."""
    cur = tree
    for part in rel.split("/")[:-1]:
        cur = os.path.join(cur, part)
        if os.path.islink(cur):
            raise RestoreFailed("path_refused", "a symbolic link on a restored path")
    return os.path.join(tree, rel)


def _remove(path: str) -> None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISDIR(st.st_mode):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def _apply_index(index: dict[str, dict[str, Any]], layer: dict[str, Any]) -> None:
    for gone in layer["deleted"]:
        prefix = gone + "/"
        for path in [p for p in index if p == gone or p.startswith(prefix)]:
            del index[path]
    for entry in layer["entries"]:
        path = entry["path"]
        old = index.get(path)
        if old is not None and old["type"] == "dir" and entry["type"] != "dir":
            prefix = path + "/"
            for child in [p for p in index if p.startswith(prefix)]:
                del index[child]
        index[path] = entry


def _read_layer_index(layer_dir: Path, expected_sha: str, contract: Contract) -> dict[str, Any]:
    path = layer_dir / LAYER_INDEX_PATH
    try:
        st = os.lstat(path)
    except FileNotFoundError as exc:
        raise RestoreFailed("layer_missing", "a layer has no index") from exc
    if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_INDEX_BYTES:
        raise RestoreFailed("layer_corrupt", "a layer index is not a regular file")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_sha:
        raise RestoreFailed("layer_corrupt", "a layer index differs from the manifest")
    try:
        return contract.parse_layer_index(json.loads(data))
    except (ValueError, ContractError) as exc:
        raise RestoreFailed("layer_corrupt", "a layer index does not parse") from exc


def _source(layer_dir: Path, rel: str) -> str:
    """``rel`` in the layer directory, every ancestor a real directory: a corrupt layer whose
    directory is a symbolic link can never make a path resolve outside it."""
    cur = os.fspath(layer_dir)
    for part in rel.split("/")[:-1]:
        cur = os.path.join(cur, part)
        try:
            st = os.lstat(cur)
        except FileNotFoundError as exc:
            raise RestoreFailed("layer_corrupt", "a layer misses an indexed path") from exc
        if not stat.S_ISDIR(st.st_mode):
            raise RestoreFailed("layer_corrupt", "a layer directory is not a real directory")
    return os.path.join(layer_dir, rel)


def _forbidden_aliases(layer_dirs: list[Path], policy: Policy) -> list[set[str]]:
    """Per layer, the saved paths that are hard links to a file the policy does not save.

    A layer from an older or a foreign capture could hold ``.codex/auth.json`` and a saved
    ``work/alias`` sharing its inode: stripping the first by name would leave its bytes in the
    second. The forbidden inodes are gathered across ALL the restored layer directories before
    any file is placed, so an alias in one layer of a credential in another is found too
    (Codex r2, finding 2). Every file is looked at, indexed or not. Never follows a link."""
    forbidden: set[tuple[int, int]] = set()
    saved: list[dict[tuple[int, int], list[str]]] = []
    for layer_dir in layer_dirs:
        by_inode: dict[tuple[int, int], list[str]] = {}
        saved.append(by_inode)
        for dirpath, dirnames, filenames in os.walk(layer_dir):
            rel_dir = os.path.relpath(dirpath, layer_dir)
            if rel_dir == ".":
                dirnames[:] = [d for d in dirnames if d != LAYER_METADATA_DIR]
            for name in filenames:
                rel = name if rel_dir == "." else f"{rel_dir}/{name}"
                st = os.lstat(os.path.join(dirpath, name))
                if not stat.S_ISREG(st.st_mode):
                    continue
                key = (st.st_dev, st.st_ino)
                if policy.classify(rel).saved:
                    by_inode.setdefault(key, []).append(rel)
                else:
                    forbidden.add(key)
    return [{rel for key in forbidden for rel in by_inode.get(key, ())} for by_inode in saved]


def _place(layer_dir: Path, merge: str, entry: dict[str, Any]) -> None:
    rel = entry["path"]
    dst = _inside(merge, rel)
    os.makedirs(os.path.dirname(dst), mode=0o700, exist_ok=True)
    kind = entry["type"]
    try:
        have = os.lstat(dst)
    except FileNotFoundError:
        have = None
    src = _source(layer_dir, rel)
    if kind == "dir":
        try:
            src_st = os.lstat(src)
        except FileNotFoundError:
            src_st = None
        if src_st is not None and not stat.S_ISDIR(src_st.st_mode):
            raise RestoreFailed("layer_corrupt", "a layer directory is not a real directory")
        if have is not None and not stat.S_ISDIR(have.st_mode):
            _remove(dst)
            have = None
        if have is None:
            os.mkdir(dst, 0o700)
        return
    try:
        src_st = os.lstat(src)
    except FileNotFoundError as exc:
        raise RestoreFailed("layer_corrupt", "a layer misses an indexed path") from exc
    if have is not None:
        _remove(dst)
    if kind == "symlink":
        if not stat.S_ISLNK(src_st.st_mode) or os.readlink(src) != entry["target"]:
            raise RestoreFailed("layer_corrupt", "a layer link differs from its index")
        os.symlink(entry["target"], dst)
        return
    if not stat.S_ISREG(src_st.st_mode) or src_st.st_size != entry["size"]:
        raise RestoreFailed("layer_corrupt", "a layer file differs from its index")
    # A file with other links is copied, never linked: owners and modes are applied to the
    # merge tree, and must never reach an inode shared with anything else.
    if src_st.st_nlink == 1:
        try:
            os.link(src, dst, follow_symlinks=False)
            return
        except OSError:
            pass
    shutil.copyfile(src, dst, follow_symlinks=False)


def restore_workspace(
    manifest: dict[str, Any] | None,
    layer_dirs: list[str],
    *,
    home: Path,
    restore_root: Path,
    merge_root: Path,
    replaced_root: Path,
    policy: Policy,
    contract: Contract,
    job_id: str,
    owner: tuple[int, int] | None = None,
) -> RestoreResult:
    """Restore ``manifest`` into ``home``; raise :class:`RestoreFailed` leaving it untouched."""
    if manifest is None:
        return RestoreResult(tree_digest=None, entries=0)
    if manifest["formatVersion"] != WORKSPACE_FORMAT_VERSION:
        raise RestoreFailed("unsupported_format", "unsupported workspace format")
    roots = list(manifest["roots"])
    if not set(roots) <= set(policy.roots):
        raise RestoreFailed("path_refused", "a manifest root the policy does not know")
    base = os.path.realpath(restore_root)
    dirs: list[Path] = []
    for raw in layer_dirs:
        real = os.path.realpath(raw)
        if os.path.dirname(real) != base or real != os.path.normpath(raw):
            raise RestoreFailed("path_refused", "a layer directory outside the restore root")
        if not os.path.isdir(raw) or os.path.islink(raw):
            raise RestoreFailed("layer_missing", "a layer directory is missing")
        dirs.append(Path(raw))

    merge = os.path.join(merge_root, job_id)
    _remove(merge)
    os.makedirs(merge, mode=0o700)
    try:
        index: dict[str, dict[str, Any]] = {}
        aliases: set[str] = set()
        previous = None
        aliases_by_layer = _forbidden_aliases(dirs, policy)
        for (meta, layer_dir), layer_aliases in zip(
            zip(manifest["layers"], dirs, strict=True), aliases_by_layer, strict=True
        ):
            layer = _read_layer_index(layer_dir, meta["indexSha256"], contract)
            if (
                layer["layerId"] != meta["layerId"]
                or layer["kind"] != meta["kind"]
                or layer["computerId"] != manifest["computerId"]
            ):
                raise RestoreFailed("layer_corrupt", "a layer index names another layer")
            if layer["formatVersion"] != WORKSPACE_FORMAT_VERSION:
                raise RestoreFailed("unsupported_format", "unsupported layer format")
            if layer["treeDigest"] != meta["treeDigest"]:
                raise RestoreFailed("index_mismatch", "a layer's digest differs from the manifest")
            if layer["kind"] == "delta" and layer["parentTreeDigest"] != previous:
                raise RestoreFailed("index_mismatch", "a delta does not follow its parent")
            for path in [*layer["deleted"], *(e["path"] for e in layer["entries"])]:
                if not _under_roots(path, roots):
                    raise RestoreFailed("path_refused", "a layer path outside the roots")
            _apply_index(index, layer)
            if tree_digest(index.values()) != layer["treeDigest"]:
                raise RestoreFailed("index_mismatch", "the merged index differs from its digest")
            for gone in layer["deleted"]:
                _remove(_inside(merge, gone))
                aliases.difference_update(
                    a for a in list(aliases) if a == gone or a.startswith(gone + "/")
                )
            for entry in sorted(layer["entries"], key=lambda e: e["path"].encode("utf-8")):
                if entry["path"] in layer_aliases:
                    aliases.add(entry["path"])  # never placed, stripped below
                    continue
                aliases.discard(entry["path"])
                _place(layer_dir, merge, entry)
            previous = layer["treeDigest"]
        if previous != manifest["treeDigest"]:
            raise RestoreFailed("index_mismatch", "the last layer is not the manifest's tree")
        published = sorted(index.values(), key=lambda e: e["path"].encode("utf-8"))

        # The one policy, on restore: strip anything it does not save, and every hard link to
        # such a file.
        stripped = [p for p in index if not policy.classify(p).saved or p in aliases]
        for path in sorted(stripped, key=len):
            if path in index:
                prefix = path + "/"
                for child in [p for p in index if p == path or p.startswith(prefix)]:
                    del index[child]
                _remove(_inside(merge, path))
        expected = sorted(index.values(), key=lambda e: e["path"].encode("utf-8"))

        # Owners and modes, deepest first; then the tree against the index.
        root = os.geteuid() == 0
        for entry in reversed(expected):
            full = os.path.join(merge, entry["path"])
            if root:
                os.lchown(full, entry["uid"], entry["gid"])
            elif owner is not None and (entry["uid"], entry["gid"]) != owner:
                raise RestoreFailed("move_failed", "owners need root")
            if entry["type"] != "symlink":
                os.chmod(full, entry["mode"])
        got = {
            rel: make_entry(rel, os.lstat(os.path.join(merge, rel)), os.path.join(merge, rel), None)
            for rel in walk_all(merge)
        }
        want = {e["path"]: e for e in expected}
        if set(got) != set(want) or any(logical(got[p]) != logical(want[p]) for p in want):
            raise RestoreFailed("index_mismatch", "the restored tree differs from its index")

        _move_into_place(merge, home, roots, replaced_root, job_id)
        return RestoreResult(
            tree_digest=manifest["treeDigest"],
            entries=len(expected),
            stripped=sorted(stripped),
            index=published,
        )
    except RestoreFailed:
        raise
    except OSError as exc:
        reason = "disk_full" if exc.errno in (errno.ENOSPC, errno.EDQUOT) else "move_failed"
        raise RestoreFailed(reason, type(exc).__name__) from exc
    finally:
        _remove(merge)


def _move_into_place(
    merge: str, home: Path, roots: list[str], replaced_root: Path, job_id: str
) -> None:
    """Move each merged root into the home; on any failure put everything back.

    Every completed rename is recorded at once, so a failure part-way through a root still
    puts that root's original back. The originals are deleted only once every root is in
    place, or once a rollback has fully succeeded; otherwise they stay under ``replaced_root``
    for recovery, and the failure says so.
    """
    aside = os.path.join(replaced_root, job_id)
    _remove(aside)
    os.makedirs(aside, mode=0o700)
    done: list[tuple[str, str]] = []  # ("aside" | "placed", root), in order
    try:
        for root in roots:
            src = os.path.join(merge, root)
            if not os.path.lexists(src):
                continue
            dst = os.path.join(home, root)
            if os.path.lexists(dst):
                os.replace(dst, os.path.join(aside, root))
                done.append(("aside", root))
            os.replace(src, dst)
            done.append(("placed", root))
    except OSError as exc:
        intact = True
        for step, root in reversed(done):
            dst = os.path.join(home, root)
            try:
                if step == "placed":
                    _remove(dst)
                else:
                    os.replace(os.path.join(aside, root), dst)
            except OSError:
                intact = False
        if intact:
            _remove(aside)
            raise RestoreFailed("move_failed", type(exc).__name__) from exc
        raise RestoreFailed(
            "move_failed", f"{type(exc).__name__}; originals kept under {aside}"
        ) from exc
    _remove(aside)
