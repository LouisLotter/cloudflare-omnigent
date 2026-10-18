"""Masked audit of the CLIs' login files (throwaway spike code).

Reports paths, types, modes, sizes, inode numbers, timestamps and JSON key names only. Values
are never printed. Whether a value changed between two audits is computed from SHA-256 digests
kept in a private state file (mode 0600, never part of the results); only "changed: true/false"
is reported. Only these timestamp fields are shown as values: expiresAt,
refreshTokenExpiresAt, last_refresh, expires_at.

Run with `python3 -I` so nothing from the current directory or environment is imported.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import stat
from pathlib import Path

from core import DECLARED_FILES

TIMESTAMP_KEYS = {"expiresAt", "refreshTokenExpiresAt", "last_refresh", "expires_at"}
# Files whose JSON key structure is reported (names only; values masked).
STRUCTURED = [d.path for d in DECLARED_FILES] + [
    ".claude.json",
    ".claude/.device-keys.json",
    ".codex/.credentials.json",
]
INVENTORY_ROOTS = [".claude", ".codex", ".omnigent", ".config/claude", ".local/share/claude", ".local/state/claude"]
INVENTORY_LIMIT = 400


def _iso(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, _dt.UTC).isoformat(timespec="milliseconds")


def file_meta(p: Path) -> dict:
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return {"exists": False}
    kind = "file" if stat.S_ISREG(st.st_mode) else "dir" if stat.S_ISDIR(st.st_mode) else "symlink" if stat.S_ISLNK(st.st_mode) else "other"
    return {
        "exists": True,
        "type": kind,
        "mode": f"{stat.S_IMODE(st.st_mode):04o}",
        "size": st.st_size,
        "uid": st.st_uid,
        "inode": st.st_ino,
        "nlink": st.st_nlink,
        "mtime": _iso(st.st_mtime),
    }


def _walk(value, prefix: str, out: list[dict], digests: dict[str, str], depth: int, max_depth: int) -> None:
    if isinstance(value, dict):
        out.append({"key": prefix or "$", "type": "object", "keys": sorted(value.keys()) if depth < max_depth else len(value)})
        if depth < max_depth:
            for k in sorted(value):
                _walk(value[k], f"{prefix}.{k}" if prefix else k, out, digests, depth + 1, max_depth)
        return
    leaf = prefix.rsplit(".", 1)[-1]
    entry: dict = {"key": prefix, "type": type(value).__name__ if value is not None else "null"}
    if leaf in TIMESTAMP_KEYS and isinstance(value, (int, float, str)):
        entry["value"] = value
    if isinstance(value, list):
        entry["length"] = len(value)
    digests[prefix] = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    out.append(entry)


def structure(p: Path, max_depth: int) -> tuple[dict, dict[str, str]]:
    digests: dict[str, str] = {}
    try:
        raw = p.read_bytes()
    except (FileNotFoundError, IsADirectoryError):
        return {}, digests
    digests["$file"] = hashlib.sha256(raw).hexdigest()
    try:
        data = json.loads(raw)
    except ValueError:
        return {"parse": "not-json"}, digests
    keys: list[dict] = []
    _walk(data, "", keys, digests, 0, max_depth)
    return {"parse": "json", "keys": keys}, digests


def audit(home: Path, state_file: Path | None, label: str) -> dict:
    prev: dict = {}
    if state_file and state_file.exists():
        prev = json.loads(state_file.read_text())
    new_state: dict = {}
    files = []
    for rel in STRUCTURED:
        p = home / rel
        meta = file_meta(p)
        rec = {"path": rel, **meta}
        if meta.get("type") == "file":
            # ~/.claude.json holds account details: report key names one level deep only.
            info, digests = structure(p, max_depth=1 if rel == ".claude.json" else 3)
            rec.update(info)
            new_state[rel] = {"digests": digests, "inode": meta["inode"]}
            if rel in prev:
                old = prev[rel]
                rec["inode_changed"] = old.get("inode") != meta["inode"]
                rec["file_changed"] = old["digests"].get("$file") != digests.get("$file")
                rec["changed_keys"] = sorted(k for k in digests if k != "$file" and old["digests"].get(k) != digests[k])
                rec["removed_keys"] = sorted(k for k in old["digests"] if k not in digests)
        elif rel in prev:
            rec["was_present_before"] = True
        files.append(rec)
    inventory = []
    for root in INVENTORY_ROOTS:
        top = home / root
        if not top.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(top):
            dirnames.sort()
            for name in sorted(dirnames) + sorted(filenames):
                full = Path(dirpath) / name
                if len(inventory) < INVENTORY_LIMIT:
                    m = file_meta(full)
                    inventory.append({"path": str(full.relative_to(home)), "type": m.get("type"), "mode": m.get("mode"),
                                      "size": m.get("size") if m.get("type") == "file" else None})
    for root in [".claude", ".codex", ".omnigent"]:
        m = file_meta(home / root)
        if m["exists"]:
            files.append({"path": root, **m})
    if state_file:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(state_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(new_state, f)
    return {"label": label, "at": _iso(_dt.datetime.now(_dt.UTC).timestamp()), "home": "~", "files": files,
            "inventory": inventory, "inventory_truncated": len(inventory) >= INVENTORY_LIMIT}
