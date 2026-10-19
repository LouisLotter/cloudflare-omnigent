"""What never enters a workspace snapshot, and the prune that enforces it.

Two kinds of exclusion:

* Credential files (IR-015). The filename families come from S6's audited
  policy, ``spikes/s6/credsync/core.py`` (copied into the image as
  ``/opt/s3/s6credsync/core.py``): each declared credential file, the
  temporary siblings its CLI writes before renaming, its lock files, and the
  provisional Claude device-key file with its siblings. Capture, prune and
  restore all use S6's own predicate, ``is_credential_or_sibling``.
* Each declared root's own patterns (caches, logs, runtime files), in a
  small subset of rsync's syntax:
    "name/"   a directory with this name, anywhere
    "name"    a file or directory with this name (glob allowed), anywhere
    "/a/b/"   a path anchored at the root

rsync gets both as exclude patterns (the credential regexes widened to
globs). ``prune`` then applies the exact rules to the finished snapshot, so a
copy method without exclude support (reflink) ends up with the same contents,
and a glob that missed a name is still caught. A failed removal raises: the
caller must discard the snapshot (IR-016).
"""

from __future__ import annotations

import fnmatch
import importlib.util
import os
import re
import shutil
import sys
from pathlib import Path, PurePosixPath
from typing import Any

# Declared roots by snapshot name, for archives whose manifest predates "roots".
DEFAULT_ROOTS = {"work": "work", "claude": ".claude", "codex": ".codex", "omnigent": ".omnigent"}

_S6: Any = None


def s6() -> Any:
    """S6's credential policy module, loaded once from the first path that exists."""
    global _S6
    if _S6 is not None:
        return _S6
    here = Path(__file__).resolve()
    candidates = [os.environ.get("S3_S6_CORE"), "/opt/s3/s6credsync/core.py",
                  str(here.parents[3] / "s6" / "credsync" / "core.py")]
    for c in candidates:
        if c and os.path.isfile(c):
            name = "s3_s6_credential_policy"
            spec = importlib.util.spec_from_file_location(name, c)
            assert spec and spec.loader
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod  # dataclasses look their module up here
            spec.loader.exec_module(mod)
            _S6 = mod
            return mod
    raise RuntimeError("S6 credential policy not found; run spikes/s3/bench/sync_policy.py")


def is_credential(home_rel: str) -> bool:
    """A declared credential file, a temporary sibling or a lock, by home-relative path."""
    return bool(s6().is_credential_or_sibling(str(PurePosixPath(home_rel))))


def regex_to_glob(pattern: str) -> str:
    """Widen one of S6's filename regexes to an rsync glob that matches at least as much.

    Escaped characters stay literal; a class, \\d or "." with any quantifier
    becomes "*". Anything a glob cannot express is widened, never narrowed,
    and prune applies the exact regex afterwards anyway.
    """
    out: list[str] = []
    i = 0

    def skip_quantifier(k: int) -> int:
        if k < len(pattern) and pattern[k] in "+*?":
            return k + 1
        if k < len(pattern) and pattern[k] == "{":
            return pattern.index("}", k) + 1
        return k

    while i < len(pattern):
        c = pattern[i]
        if c == "\\" and i + 1 < len(pattern):
            n = pattern[i + 1]
            if n.isalpha():  # \d, \w, \s: a class
                out.append("*")
                i = skip_quantifier(i + 2)
            else:
                out.append("[" + n + "]" if n in "*?[" else n)
                i += 2
        elif c == "[":
            out.append("*")
            i = skip_quantifier(pattern.index("]", i + 1) + 1)
        elif c == ".":
            out.append("*")
            i = skip_quantifier(i + 1)
        elif c in "^$":
            i += 1
        else:
            out.append(c)
            i += 1
    return re.sub(r"\*+", "*", "".join(out))


def home_rel(item: dict[str, Any]) -> str:
    return item.get("home_rel") or DEFAULT_ROOTS.get(item["name"], item["name"])


def credential_excludes(root_rel: str) -> list[str]:
    """Anchored rsync patterns for every credential family under one declared root."""
    out: list[str] = []
    for d in s6().DECLARED_FILES:
        parent = str(PurePosixPath(d.parent))
        if parent != root_rel and not parent.startswith(root_rel + "/"):
            continue
        sub = os.path.relpath(parent, root_rel)
        prefix = "/" if sub == "." else f"/{sub}/"
        out.append(prefix + d.name)
        out += [prefix + regex_to_glob(p) for p in d.temp_name_patterns]
        out += [prefix + n for n in d.lock_names]
    return out


def rsync_excludes(item: dict[str, Any]) -> list[str]:
    return [*credential_excludes(home_rel(item)), *item.get("exclude", [])]


def _match(pattern: str, rel: str, is_dir: bool) -> bool:
    dir_only = pattern.endswith("/")
    p = pattern.rstrip("/")
    if dir_only and not is_dir:
        return False
    if p.startswith("/"):
        return fnmatch.fnmatchcase(rel, p.lstrip("/"))
    if "/" in p:
        return fnmatch.fnmatchcase(rel, p) or fnmatch.fnmatchcase(rel, "*/" + p)
    return fnmatch.fnmatchcase(os.path.basename(rel), p)


def excluded(item: dict[str, Any], rel: str, is_dir: bool) -> bool:
    """rel is relative to the item's root."""
    if not is_dir and is_credential(f"{home_rel(item)}/{rel}"):
        return True
    return any(_match(p, rel, is_dir) for p in item.get("exclude", []))


def strip_restored(staging: str, roots: dict[str, str] | None) -> list[str]:
    """Remove credential members from an extracted workspace archive before it is
    installed (IR-015): an older archive may hold them. Returns home-relative paths."""
    roots = roots or DEFAULT_ROOTS
    removed: list[str] = []
    for name in sorted(os.listdir(staging)):
        top = os.path.join(staging, name)
        base = roots.get(name, name)
        if not os.path.isdir(top) or os.path.islink(top):
            if is_credential(base):
                _remove(top, False)
                removed.append(base)
            continue
        for dirpath, _dirnames, filenames in os.walk(top):
            for f in filenames:
                full = os.path.join(dirpath, f)
                rel = f"{base}/{os.path.relpath(full, top)}"
                if is_credential(rel):
                    _remove(full, False)
                    removed.append(rel)
    return sorted(removed)


def _remove(path: str, is_dir: bool) -> None:
    if is_dir:
        shutil.rmtree(path)
    else:
        os.unlink(path)


def prune(snapshot_dir: str, items: list[dict[str, Any]]) -> list[str]:
    """Remove every excluded path from a snapshot; return what was removed.

    Errors propagate: a snapshot that could not be pruned must not be used.
    """
    removed: list[str] = []
    for it in items:
        root = os.path.join(snapshot_dir, it["name"])
        if not os.path.isdir(root) or os.path.islink(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root, topdown=True):
            keep = []
            for d in dirnames:
                full = os.path.join(dirpath, d)
                rel = os.path.relpath(full, root)
                is_dir = not os.path.islink(full)
                if excluded(it, rel, is_dir):
                    _remove(full, is_dir)
                    removed.append(f"{it['name']}/{rel}")
                else:
                    keep.append(d)
            dirnames[:] = keep
            for f in filenames:
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, root)
                if excluded(it, rel, False):
                    _remove(full, False)
                    removed.append(f"{it['name']}/{rel}")
    return removed
