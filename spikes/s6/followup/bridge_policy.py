"""The native harnesses' checkpoint policy, generated from one classification (S6 follow-up).

R-08 and G1BR-001: capture, prune and restore take every decision from the same file,
bridge-classification.json, so the three cannot drift apart. This module also holds the spike's
small layered workspace checkpoint (a base, then deltas against the published index), the
restore that strips any excluded member with an alert, and the RC-53-style canary scan of every
decompressed layer. Throwaway spike code; WP3.4 builds the real one.

Paths outside the classification (the rest of the home directory) follow the S6 credential
policy (credsync.core: declared login files, their siblings and locks are excluded) and the
design's cache exclusions.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import urllib.parse
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
CLASSIFICATION = HERE / "bridge-classification.json"
sys.path.insert(0, str(HERE.parent / "credsync"))
from core import is_credential_or_sibling  # noqa: E402  (spike code: the S6 credential policy)

# The design's general exclusions (DC-12) for the rest of the home directory.
GENERAL_EXCLUDED_DIRS = {".cache", "node_modules", ".venv"}
GENERAL_EXCLUDED_PREFIXES = (".codex/log", ".codex/.tmp", ".codex/skills/.system", ".omnigent/logs",
                             ".claude/backups", ".claude/shell-snapshots", ".claude/statsig")


def _glob_regex(pattern: str) -> re.Pattern[str]:
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


@dataclass(frozen=True)
class Rule:
    id: str
    root: str
    cls: str
    action: str
    patterns: tuple[re.Pattern[str], ...]


def load_rules(path: Path = CLASSIFICATION) -> list[Rule]:
    data = json.loads(path.read_text())
    return [
        Rule(r["id"], r.get("root", "home"), r["class"], r["action"], tuple(_glob_regex(p) for p in r["patterns"]))
        for r in data["rules"]
    ]


RULES = load_rules()


@dataclass(frozen=True)
class Decision:
    action: str  # exclude | save | save-link | decide | unclassified
    rule: str  # the classification rule, or "general:<reason>"
    cls: str


# The design's credential family beyond the S6 spike's declared list: Codex's MCP sign-in store
# (SEC-07), which the spike's credsync predates.
GENERAL_CREDENTIAL_FILES = {".codex/.credentials.json"}


def decide(rel: str, *, tmp_rel: str | None = None) -> Decision:
    """The one decision for a path relative to the home directory.

    tmp_rel is $TMPDIR relative to the home directory, when $TMPDIR lies inside it.
    """
    for rule in RULES:
        target = rel
        if rule.root == "tmp":
            if tmp_rel is None or not (rel == tmp_rel or rel.startswith(tmp_rel + "/")):
                continue
            target = rel[len(tmp_rel) + 1 :]
        if any(p.match(target) for p in rule.patterns):
            return Decision(rule.action, rule.id, rule.cls)
    if is_credential_or_sibling(rel) or rel in GENERAL_CREDENTIAL_FILES or any(
        rel.startswith(f + ".") for f in GENERAL_CREDENTIAL_FILES
    ):
        return Decision("exclude", "general:declared credential family (S6)", "credential family")
    parts = PurePosixPath(rel).parts
    if any(p in GENERAL_EXCLUDED_DIRS for p in parts) or any(
        rel == p or rel.startswith(p + "/") for p in GENERAL_EXCLUDED_PREFIXES
    ):
        return Decision("exclude", "general:cache or log (DC-12)", "runtime")
    return Decision("save", "general:workspace", "workspace")


# ---------------------------------------------------------------------------------------------
# Layered workspace checkpoint (spike): base and deltas against the published index.


def _entry(path: Path) -> dict:
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        return {"type": "link", "target": os.readlink(path)}
    if stat.S_ISDIR(st.st_mode):
        return {"type": "dir", "mode": oct(st.st_mode & 0o7777)}
    if stat.S_ISREG(st.st_mode):
        return {"type": "file", "mode": oct(st.st_mode & 0o7777), "size": st.st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    return {"type": "other"}


def scan_tree(home: Path, *, tmp_rel: str | None = None) -> tuple[dict[str, dict], list[dict]]:
    """(index of saved entries, audit). The audit lists excluded paths, hard-link aliases of an
    excluded file, and links that point at a credential, with the rule that decided each."""
    index: dict[str, dict] = {}
    audit: list[dict] = []
    excluded_inodes: set[tuple[int, int]] = set()
    candidates: list[tuple[str, Path, Decision]] = []
    for dirpath, dirnames, filenames in os.walk(home, followlinks=False):
        here = Path(dirpath)
        names = sorted(dirnames) + sorted(filenames)
        keep_dirs = []
        for name in names:
            p = here / name
            rel = str(p.relative_to(home))
            d = decide(rel, tmp_rel=tmp_rel)
            is_dir = name in dirnames and not p.is_symlink()
            if d.action in ("exclude", "unclassified"):
                audit.append({"path": rel, "action": d.action, "rule": d.rule})
                with _suppress():
                    st = os.lstat(p)
                    if stat.S_ISREG(st.st_mode):
                        excluded_inodes.add((st.st_dev, st.st_ino))
                    if is_dir:
                        for sub in p.rglob("*"):
                            sst = os.lstat(sub)
                            if stat.S_ISREG(sst.st_mode):
                                excluded_inodes.add((sst.st_dev, sst.st_ino))
                continue
            if is_dir:
                keep_dirs.append(name)
            candidates.append((rel, p, d))
        dirnames[:] = [d for d in dirnames if d in keep_dirs]
    for rel, p, d in candidates:
        st = os.lstat(p)
        if stat.S_ISREG(st.st_mode) and st.st_nlink > 1 and (st.st_dev, st.st_ino) in excluded_inodes:
            audit.append({"path": rel, "action": "exclude", "rule": "audit:hard link to an excluded file", "alert": True})
            continue
        e = _entry(p)
        if e["type"] == "link":
            tgt = (p.parent / e["target"]).resolve()
            with _suppress():
                trel = str(tgt.relative_to(home.resolve()))
                if decide(trel, tmp_rel=tmp_rel).action == "exclude":
                    audit.append({"path": rel, "action": "save-link", "rule": "audit:link to an excluded file (kept as a link, never followed)"})
        e["rule"] = d.rule
        index[rel] = e
    return index, audit


class _suppress:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return exc[0] is not None and issubclass(exc[0], (OSError, ValueError))


def write_layer(home: Path, out: Path, *, parent_index: dict[str, dict] | None = None,
                tmp_rel: str | None = None) -> dict:
    """Capture one layer: the whole tree (a base) or what changed since parent_index (a delta).
    Returns its manifest: kind, index of the whole tree, members written, deleted paths, audit."""
    index, audit = scan_tree(home, tmp_rel=tmp_rel)
    if parent_index is None:
        members = sorted(index)
        deleted: list[str] = []
    else:
        members = sorted(k for k, v in index.items() if parent_index.get(k) != v)
        deleted = sorted(k for k in parent_index if k not in index)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for rel in members:
            p = home / rel
            ti = tar.gettarinfo(str(p), arcname=rel)  # never follows links
            if ti.islnk():  # a hard link inside the layer: store the content, never a link entry
                ti.type = tarfile.REGTYPE
                ti.linkname = ""
                ti.size = p.stat().st_size
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ""
            if ti.isreg():
                with open(p, "rb") as f:
                    tar.addfile(ti, f)
            else:
                tar.addfile(ti)
        meta = json.dumps({"deleted": deleted}).encode()
        mi = tarfile.TarInfo(".s6-layer.json")
        mi.size = len(meta)
        tar.addfile(mi, io.BytesIO(meta))
    out.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
    return {"kind": "base" if parent_index is None else "delta", "index": index, "members": members,
            "deleted": deleted, "audit": audit}


def restore_layers(layers: list[Path], home: Path, *, tmp_rel: str | None = None) -> dict:
    """Apply a base and its deltas, in order, into an empty home. Every member is validated like
    an archive member and decided by the same policy; an excluded member is stripped and raises
    an alert. Returns what was stripped."""
    home.mkdir(parents=True, exist_ok=True)
    stripped: list[dict] = []
    for layer in layers:
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(layer.read_bytes())), mode="r") as tar:
            deleted: list[str] = []
            for m in tar.getmembers():
                name = m.name
                if name == ".s6-layer.json":
                    deleted = json.loads(tar.extractfile(m).read())["deleted"]
                    continue
                pp = PurePosixPath(name)
                if pp.is_absolute() or ".." in pp.parts or m.islnk() or not (m.isreg() or m.isdir() or m.issym()):
                    stripped.append({"path": name, "why": "unsafe archive member"})
                    continue
                d = decide(name, tmp_rel=tmp_rel)
                if d.action in ("exclude", "unclassified"):
                    stripped.append({"path": name, "why": f"excluded by {d.rule}", "alert": True})
                    continue
                tar.extract(m, home, filter="tar")
            for rel in deleted:
                pp = PurePosixPath(rel)
                if pp.is_absolute() or ".." in pp.parts:
                    stripped.append({"path": rel, "why": "unsafe deleted path"})
                    continue
                target = home / rel
                if target.is_symlink() or target.is_file():
                    target.unlink()
                elif target.is_dir():
                    import shutil

                    shutil.rmtree(target)
    return {"stripped": stripped}


# ---------------------------------------------------------------------------------------------
# RC-53-style scan: every decompressed layer, every planted value, in the forms it could take.


def forms(value: str) -> dict[str, bytes]:
    v = value.encode()
    out = {"raw": v, "url-encoded": urllib.parse.quote(value, safe="").encode(),
           "json-escaped": json.dumps(value)[1:-1].encode(), "hex": v.hex().encode()}
    for shift in range(3):  # base64 of the value at any alignment inside a longer string
        enc = base64.b64encode(b"\0" * shift + v)
        start = (shift * 4 + 2) // 3 + (1 if shift else 0)
        stable = enc[start : len(enc) - 4]
        if len(stable) >= 12:
            out[f"base64+{shift}"] = stable
            out[f"base64url+{shift}"] = stable.replace(b"+", b"-").replace(b"/", b"_")
    return out


def scan_layer(layer: Path, canaries: dict[str, str]) -> list[dict]:
    data = gzip.decompress(layer.read_bytes())
    found = []
    for label, value in canaries.items():
        for form, needle in forms(value).items():
            if needle and needle in data:
                found.append({"canary": label, "form": form})
    return found
