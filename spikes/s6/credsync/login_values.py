"""Which login values sit in other files, by JSON key (spike S6 follow-up, DC-45).

find_copies.py says only which files hold a long string from a login file. This report says,
for each such file, which key of which login file the string comes from, what kind of value
that key holds, and where in the file it sits: a JSON key path, a JSONL record type and key
path, an SQLite table and column, or "raw bytes". It never prints a value, a hash of a value, a
match position or a fragment.

Values searched, from each login file given (missing files are skipped):
- every string of 16 or more characters, by its key path (timestamps excepted);
- for a JSON Web Token, also its string claims of 8 or more characters (issuer and audience
  URLs and scope lists excepted), so an identity claim copied on its own is found;
- for a secret of 40 or more characters, also a 24-character piece from its middle (a cut or
  partly logged copy) and its base64 forms at each alignment (an encoded copy).

Each source key gets a class from its name: "secret" (tokens, keys), "identifier" (account and
organisation ids), "plan" (tier, subscription, scopes), "jwt-claim" or "other".

Everything printed that comes from a file (key names, claim names, record types, table and
column names, file names) is masked one component at a time, before any component is joined
into a path: a component that holds a login value, or a piece of one, prints as "<a login
value>", and addresses, UUIDs and long identifiers are masked too (review s6-fu-r1).

  python3 -I login_values.py --home ~ ~/.claude/.credentials.json ~/.codex/auth.json ...
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import re
import sqlite3
from pathlib import Path

SKIP_DIRS = {".cache", "node_modules", ".npm", "proc"}
TIMESTAMP_KEYS = {"expiresAt", "refreshTokenExpiresAt", "last_refresh", "expires_at"}
SKIP_CLAIMS = {"iss", "aud", "scp", "scope", "amr", "exp", "iat", "nbf", "auth_time"}
MIN_LEN = 16
MIN_CLAIM_LEN = 8
MIN_PIECE = 12  # a printed component this long that is part of a secret or an id is masked
SECRET_KEY = re.compile(r"(token|secret|password|private|apikey|api_key|cookie|credential|key$)", re.I)
IDENT_KEY = re.compile(r"(account|organi[sz]ation|user|uuid|_id$|^id$|Id$)", re.I)
PLAN_KEY = re.compile(r"(tier|subscription|plan|scope)", re.I)
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
LONG_ID = re.compile(r"[A-Za-z0-9_\-+/=.]{24,}")
EMAIL = re.compile(r"\S*@\S*")
LIST = "[]"

Parts = tuple[str, ...]


def classify(parts: Parts) -> str:
    names = [p for p in parts if p != LIST]
    last = names[-1] if names else ""
    if SECRET_KEY.search(last) and not IDENT_KEY.search(last):
        return "secret"
    if any(PLAN_KEY.search(n) for n in names):
        return "plan"
    if IDENT_KEY.search(last):
        return "identifier"
    return "other"


def jwt_claims(value: str) -> dict | None:
    parts = value.split(".")
    if len(parts) != 3 or not all(parts):
        return None
    try:
        payload = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        claims = json.loads(payload)
    except (ValueError, binascii.Error):
        return None
    return claims if isinstance(claims, dict) else None


def leaves(value, path: Parts = ()):
    """(key path as components, string) for every string leaf; a list item adds "[]"."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield from leaves(v, (*path, str(k)))
    elif isinstance(value, list):
        for v in value:
            yield from leaves(v, (*path, LIST))
    elif isinstance(value, str):
        yield path, value


def needles_for(source: str, data) -> list[dict]:
    """The searched forms of every value in one login file:
    [{source, key (parts), claim (parts or None), class, form, bytes}]."""
    out: list[dict] = []

    def add(key: Parts, claim: Parts | None, cls: str, value: str, secret: bool) -> None:
        forms = {"whole": value.encode()}
        if secret and len(value) >= 40:
            mid = len(value) // 2
            forms["middle piece"] = value[mid - 12 : mid + 12].encode()
            # Base64 of the value inside a longer encoded string: at each of the three
            # alignments, the characters that depend on the value alone.
            for shift, start in ((0, 0), (1, 2), (2, 3)):
                enc = base64.b64encode(b"\0" * shift + value.encode())[start:-4]
                forms[f"base64 (offset {shift})"] = enc
                forms[f"base64url (offset {shift})"] = enc.replace(b"+", b"-").replace(b"/", b"_")
        for form, b in forms.items():
            out.append({"source": source, "key": key, "claim": claim, "class": cls, "form": form, "bytes": b})

    for key, value in leaves(data):
        if key and key[-1] in TIMESTAMP_KEYS:
            continue
        cls = classify(key)
        if len(value) >= MIN_LEN:
            add(key, None, cls, value, cls == "secret")
        claims = jwt_claims(value)
        if claims:
            for ckey, cval in leaves(claims):
                if not ckey or ckey[0] in SKIP_CLAIMS or len(cval) < MIN_CLAIM_LEN or cval.startswith("http"):
                    continue
                add(key, ckey, "jwt-claim", cval, False)
    return out


class Masker:
    """Masks every printable component; knows every searched value and piece of one."""

    def __init__(self, values: list[bytes], private: list[bytes]):
        self.values = [v for v in values if v]  # every searched form
        self.private = [v for v in private if v]  # whole secrets, ids and claims

    def component(self, segment: str) -> str:
        b = segment.encode()
        if any(v in b for v in self.values) or (
            len(b) >= MIN_PIECE and any(b in v for v in self.private)
        ):
            return "<a login value>"
        if "@" in segment:
            return EMAIL.sub("<address>", segment) if len(segment) < 80 else "<address>"
        segment = UUID.sub("<uuid>", segment)
        return LONG_ID.sub("<id>", segment)

    def path(self, parts: Parts) -> str:
        out = ""
        for p in parts:
            out += LIST if p == LIST else (("." if out else "") + self.component(p))
        return out


def where_json(obj, needle: bytes, m: Masker) -> set[str]:
    found = set()
    for key, value in leaves(obj):
        if needle in value.encode():
            found.add(m.path(key) or "<top level>")
    stack: list[tuple[Parts, object]] = [((), obj)]
    while stack:  # a value used as a key
        path, o = stack.pop()
        if isinstance(o, dict):
            for k, v in o.items():
                if needle in str(k).encode():
                    found.add(f"{m.path(path) or '<top level>'}.<key holds the value>")
                stack.append(((*path, str(k)), v))
        elif isinstance(o, list):
            stack.extend(((*path, LIST), v) for v in o)
    return found


def record_label(rec, m: Masker) -> str:
    if not isinstance(rec, dict):
        return "<not an object>"
    parts = [m.component(str(rec.get("type", "?")))]
    payload = rec.get("payload")
    if isinstance(payload, dict) and "type" in payload:
        parts.append(m.component(str(payload["type"])))
    return "/".join(parts)


def locate(path: Path, data: bytes, needle: bytes, m: Masker) -> tuple[str, list[str]]:
    """The file's kind and where in it the needle sits, as printable labels."""
    if data.startswith(b"SQLite format 3\x00"):
        spots = []
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
            try:
                tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
                for t in tables:
                    cols = [r[1] for r in con.execute(f'PRAGMA table_info("{t}")')]
                    for c in cols:
                        n = con.execute(
                            f'SELECT count(*) FROM "{t}" WHERE instr(CAST("{c}" AS BLOB), ?) > 0', (needle,)
                        ).fetchone()[0]
                        if n:
                            spots.append(f"table {m.component(t)}, column {m.component(c)} ({n} rows)")
            finally:
                con.close()
        except sqlite3.Error as e:
            spots.append(f"unreadable ({type(e).__name__})")
        return "sqlite", spots or ["raw bytes only (free pages or an index)"]
    text = data.decode("utf-8", "replace")
    try:
        return "json", sorted(where_json(json.loads(text), needle, m)) or ["raw bytes only"]
    except ValueError:
        pass
    lines = [ln for ln in text.splitlines() if needle in ln.encode()]
    parsed = []
    for ln in lines:
        try:
            parsed.append(json.loads(ln))
        except ValueError:
            parsed = None
            break
    if parsed is not None and lines:
        spots: dict[str, int] = {}
        for rec in parsed:
            for kp in where_json(rec, needle, m) or {"raw bytes only"}:
                label = f"record {record_label(rec, m)}: {kp}"
                spots[label] = spots.get(label, 0) + 1
        return "jsonl", [f"{k} ({n} lines)" for k, n in sorted(spots.items())]
    return "other", [f"raw bytes ({len(lines)} lines)" if lines else "raw bytes"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", required=True)
    ap.add_argument("--max-bytes", type=int, default=64 << 20)
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    home = Path(a.home).resolve()
    sources = {Path(f).resolve(): f for f in a.files}
    needles: list[dict] = []
    for p in sources:
        rel = str(p.relative_to(home)) if p.is_relative_to(home) else p.name
        try:
            data = json.loads(p.read_bytes())
        except (FileNotFoundError, ValueError):
            continue
        needles.extend(needles_for(rel, data))
    m = Masker(
        [n["bytes"] for n in needles],
        [n["bytes"] for n in needles if n["form"] == "whole" and n["class"] != "plan"],
    )

    def describe(n: dict) -> dict:
        cls = n["class"] if n["claim"] is None else f"jwt-claim:{m.path(n['claim'])}"
        key = m.path(n["key"]) + ("" if n["claim"] is None else f"#{m.path(n['claim'])}")
        return {"source": "/".join(m.component(s) for s in Path(n["source"]).parts), "key": key, "class": cls}

    keys: dict[str, set[tuple[str, str]]] = {}
    for n in needles:
        if n["form"] == "whole":
            d = describe(n)
            keys.setdefault(d["source"], set()).add((d["key"], d["class"]))
    report: dict[str, dict] = {}
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(home):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            p = Path(dirpath) / name
            if p.resolve() in sources or p.is_symlink() or not p.is_file():
                continue
            try:
                if p.stat().st_size > a.max_bytes:
                    continue
                data = p.read_bytes()
            except OSError:
                continue
            scanned += 1
            hits = [n for n in needles if n["bytes"] in data]
            if not hits:
                continue
            rel = "/".join(m.component(s) for s in p.relative_to(home).parts)
            entry = report.setdefault(rel, {"kind": None, "matches": []})
            for n in hits:
                kind, spots = locate(p, data, n["bytes"], m)
                entry["kind"] = kind
                entry["matches"].append({**describe(n), "form": n["form"], "where": spots})
    summary = {
        "values_checked": len({n["bytes"] for n in needles}),
        "source_keys": {s: [{"key": k, "class": c} for k, c in sorted(kc)] for s, kc in keys.items()},
        "files_scanned": scanned,
        "files_holding_a_login_value": report,
        "secrets_outside_login_files": sorted(
            {f for f, e in report.items() if any(x["class"] == "secret" for x in e["matches"])}
        ),
    }
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
