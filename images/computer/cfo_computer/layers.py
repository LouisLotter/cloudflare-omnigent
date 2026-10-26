"""Workspace layers: deltas against the published index, and staging for DirectoryBackup.

A layer is a directory WorkspaceDO uploads with the Sandbox SDK's ``DirectoryBackup``: the
entries it adds or changes, at their home-relative paths, and its own index at
``.cfo-layer/index.json`` (``LayerIndex`` in manifests.ts). A base lists every entry of the
tree; a delta its changes and the paths it deletes against its parent tree. Files are hard
links into the kept snapshot, which is never written in place, so the layer keeps its bytes
while it is uploaded. Directories that only hold an entry are containers: they are not in the
index, and a restore never applies them.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
from pathlib import Path
from typing import Any

from .contract import LAYER_INDEX_PATH, LAYER_METADATA_DIR, WORKSPACE_FORMAT_VERSION, Contract
from .tree import logical, sha256_file


def _key(path: str) -> bytes:
    return path.encode("utf-8")


def diff(
    parent: list[dict[str, Any]], current: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[str]]:
    """(changed or new entries, deleted paths). A deleted path hides everything below it."""
    before = {e["path"]: e for e in parent}
    after = {e["path"]: e for e in current}
    changed = sorted(
        (e for p, e in after.items() if p not in before or logical(before[p]) != logical(e)),
        key=lambda e: _key(e["path"]),
    )
    gone = {p for p in before if p not in after}
    deleted = sorted(
        (p for p in gone if not _has_ancestor_in(p, gone)),
        key=_key,
    )
    return changed, deleted


def _has_ancestor_in(path: str, paths: set[str]) -> bool:
    cut = path.rfind("/")
    while cut > 0:
        if path[:cut] in paths:
            return True
        cut = path.rfind("/", 0, cut)
    return False


def layer_index_document(
    *,
    kind: str,
    layer_id: str,
    computer_id: str,
    generation: int,
    entries: list[dict[str, Any]],
    deleted: list[str],
    tree_digest: str,
    parent_tree_digest: str | None,
) -> dict[str, Any]:
    return {
        "formatVersion": WORKSPACE_FORMAT_VERSION,
        "layerId": layer_id,
        "kind": kind,
        "computerId": computer_id,
        "generation": generation,
        "parentTreeDigest": parent_tree_digest,
        "entries": entries,
        "deleted": deleted,
        "treeDigest": tree_digest,
    }


class StageError(RuntimeError):
    pass


def stage_layer(
    snapshot: Path,
    layer_dir: Path,
    document: dict[str, Any],
    contract: Contract,
) -> tuple[str, int]:
    """Write the layer directory; return (SHA-256 of its index file, bytes of its files)."""
    contract.check_outbound("LayerIndex", document)
    if os.path.lexists(layer_dir):
        shutil.rmtree(layer_dir)
    layer_dir.mkdir(mode=0o700, parents=True)
    root = os.geteuid() == 0
    dirs: list[tuple[str, dict[str, Any]]] = []
    total = 0
    for entry in document["entries"]:  # sorted by path: parents before children
        rel = entry["path"]
        dst = os.path.join(layer_dir, rel)
        os.makedirs(os.path.dirname(dst), mode=0o700, exist_ok=True)
        if entry["type"] == "dir":
            os.makedirs(dst, mode=0o700, exist_ok=True)
            dirs.append((dst, entry))
        elif entry["type"] == "symlink":
            os.symlink(entry["target"], dst)
            if root:
                os.lchown(dst, entry["uid"], entry["gid"])
        else:
            src = os.path.join(snapshot, rel)
            try:
                os.link(src, dst, follow_symlinks=False)
            except OSError:
                shutil.copyfile(src, dst, follow_symlinks=False)
                os.chmod(dst, entry["mode"])
                if root:
                    os.chown(dst, entry["uid"], entry["gid"])
            total += entry["size"]
    for dst, entry in reversed(dirs):
        if root:
            os.chown(dst, entry["uid"], entry["gid"])
        os.chmod(dst, entry["mode"])
    meta = layer_dir / LAYER_METADATA_DIR
    meta.mkdir(mode=0o700)
    data = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    (layer_dir / LAYER_INDEX_PATH).write_bytes(data)
    verify_staged(snapshot, layer_dir, document)
    return hashlib.sha256(data).hexdigest(), total


def verify_staged(snapshot: Path, layer_dir: Path, document: dict[str, Any]) -> None:
    """Check the staged directory holds exactly its index's entries, with their bytes."""
    want = {e["path"]: e for e in document["entries"]}
    containers = set()
    for path in want:
        cut = path.rfind("/")
        while cut > 0:
            containers.add(path[:cut])
            cut = path.rfind("/", 0, cut)
    for dirpath, dirnames, filenames in os.walk(layer_dir):
        rel_dir = os.path.relpath(dirpath, layer_dir)
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d != LAYER_METADATA_DIR]
        for name in [*dirnames, *filenames]:
            rel = name if rel_dir == "." else f"{rel_dir}/{name}"
            full = os.path.join(dirpath, name)
            st = os.lstat(full)
            entry = want.get(rel)
            if entry is None:
                if stat.S_ISDIR(st.st_mode) and rel in containers:
                    continue
                raise StageError("staged layer holds a path its index does not list")
            kind = entry["type"]
            if kind == "dir" and not stat.S_ISDIR(st.st_mode):
                raise StageError("staged directory has the wrong type")
            if kind == "symlink" and (
                not stat.S_ISLNK(st.st_mode) or os.readlink(full) != entry["target"]
            ):
                raise StageError("staged link differs from its index")
            if kind == "file":
                if not stat.S_ISREG(st.st_mode) or st.st_size != entry["size"]:
                    raise StageError("staged file differs from its index")
                snap = os.lstat(os.path.join(snapshot, rel))
                same_inode = (snap.st_dev, snap.st_ino) == (st.st_dev, st.st_ino)
                if not same_inode and sha256_file(full) != entry["sha256"]:
                    raise StageError("staged file's bytes differ from its index")
            if kind in ("dir", "file") and stat.S_IMODE(st.st_mode) != entry["mode"]:
                raise StageError("staged mode differs from its index")
    for rel in want:
        if not os.path.lexists(os.path.join(layer_dir, rel)):
            raise StageError("staged layer misses an indexed path")
