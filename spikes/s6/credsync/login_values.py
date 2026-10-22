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
organisation ids), "plan" (tier, subscription, scopes) or "jwt-claim:<claim>".

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
SECRET_KEY = re.compile(r"(token|secret|password|private|apikey|api_key|cookie|credential|key$)", re.I)
IDENT_KEY = re.compile(r"(account|organi[sz]ation|user|uuid|_id$|^id$|Id$)", re.I)
PLAN_KEY = re.compile(r"(tier|subscription|plan|scope)", re.I)
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
LONG_ID = re.compile(r"[A-Za-z0-9_\-+/=.]{24,}")
EMAIL = re.compile(r"[^\s@]+@[^\s@]+")


def classify(key_path: str) -> str:
    last = key_path.split(".")[-1].replace("[]", "")
    if SECRET_KEY.search(last) and not IDENT_KEY.search(last):
        return "secret"
    if PLAN_KEY.search(key_path):
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


def leaves(value, path: str = ""):
    """(key path, string) for every string leaf; list indices are written as []."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield from leaves(v, f"{path}.{k}" if path else str(k))
    elif isinstance(value, list):
        for v in value:
            yield from leaves(v, f"{path}[]")
    elif isinstance(value, str):
        yield path, value


def needles_for(source: str, data) -> list[dict]:
    """The searched forms of every value in one login file: [{source, key, class, form, bytes}]."""
    out: list[dict] = []

    def add(key: str, cls: str, value: str, secret: bool) -> None:
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
            out.append({"source": source, "key": key, "class": cls, "form": form, "bytes": b})

    for key, value in leaves(data):
        if key.split(".")[-1].replace("[]", "") in TIMESTAMP_KEYS:
            continue
        cls = classify(key)
        if len(value) >= MIN_LEN:
            add(key, cls, value, cls == "secret")
        claims = jwt_claims(value)
        if claims:
            for ckey, cval in leaves(claims):
                top = ckey.split(".")[0].split("[")[0]
                if top in SKIP_CLAIMS or len(cval) < MIN_CLAIM_LEN or cval.startswith("http"):
                    continue
                add(f"{key}#{ckey}", f"jwt-claim:{ckey}", cval, False)
    return out


def masked(segment: str, values: list[bytes]) -> str:
    """A key or record label as it may be printed: never a login value, id or address."""
    b = segment.encode()
    if any(v and v in b for v in values):
        return "<a login value>"
    segment = UUID.sub("<uuid>", segment)
    segment = EMAIL.sub("<address>", segment)
    return LONG_ID.sub("<id>", segment)


def mask_path(key_path: str, values: list[bytes]) -> str:
    return ".".join(masked(s, values) for s in key_path.split("."))


def where_json(obj, needle: bytes, values: list[bytes]) -> set[str]:
    found = set()
    for key, value in leaves(obj):
        if needle in value.encode():
            found.add(mask_path(key, values) or "<top level>")
    if isinstance(obj, dict):  # a value used as a key
        stack = [("", obj)]
        while stack:
            path, o = stack.pop()
            if isinstance(o, dict):
                for k, v in o.items():
                    if needle in str(k).encode():
                        found.add(f"{mask_path(path, values) or '<top level>'}.<key holds the value>")
                    stack.append((f"{path}.{k}" if path else str(k), v))
            elif isinstance(o, list):
                stack.extend((f"{path}[]", v) for v in o)
    return found


def record_label(rec, values: list[bytes]) -> str:
    if not isinstance(rec, dict):
        return "<not an object>"
    parts = [str(rec.get("type", "?"))]
    payload = rec.get("payload")
    if isinstance(payload, dict) and "type" in payload:
        parts.append(str(payload["type"]))
    return masked("/".join(parts), values)


def locate(path: Path, data: bytes, needle: bytes, values: list[bytes]) -> tuple[str, list[str]]:
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
                            spots.append(f"table {masked(t, values)}, column {masked(c, values)} ({n} rows)")
            finally:
                con.close()
        except sqlite3.Error as e:
            spots.append(f"unreadable ({type(e).__name__})")
        return "sqlite", spots or ["raw bytes only (free pages or an index)"]
    text = data.decode("utf-8", "replace")
    try:
        return "json", sorted(where_json(json.loads(text), needle, values)) or ["raw bytes only"]
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
            for kp in where_json(rec, needle, values) or {"raw bytes only"}:
                label = f"record {record_label(rec, values)}: {kp}"
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
    keys: dict[str, list[dict]] = {}
    for p in sources:
        rel = str(p.relative_to(home)) if p.is_relative_to(home) else p.name
        try:
            data = json.loads(p.read_bytes())
        except (FileNotFoundError, ValueError):
            continue
        found = needles_for(rel, data)
        needles.extend(found)
        keys[rel] = sorted(
            {(n["key"], n["class"]) for n in found if n["form"] == "whole"}, key=lambda kc: kc[0]
        )
    values = [n["bytes"] for n in needles]
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
            rel = "/".join(masked(s, values) for s in p.relative_to(home).parts)
            entry = report.setdefault(rel, {"kind": None, "matches": []})
            for n in hits:
                kind, spots = locate(p, data, n["bytes"], values)
                entry["kind"] = kind
                entry["matches"].append(
                    {
                        "source": n["source"],
                        "key": mask_path(n["key"], values),
                        "class": n["class"],
                        "form": n["form"],
                        "where": spots,
                    }
                )
    summary = {
        "values_checked": len({n["bytes"] for n in needles}),
        "source_keys": {
            s: [{"key": mask_path(k, values), "class": c} for k, c in kc] for s, kc in keys.items()
        },
        "files_scanned": scanned,
        "files_holding_a_login_value": report,
        "secrets_outside_login_files": sorted(
            {f for f, e in report.items() if any(m["class"] == "secret" for m in e["matches"])}
        ),
    }
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
