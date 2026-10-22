"""DC-45's key report (credsync/login_values.py): it names the login file key, its class and where
each copy sits, and never prints a value, a fragment, an id or an address (S6 follow-up)."""

from __future__ import annotations

import base64
import json
import sqlite3
import subprocess
import sys
import uuid
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent / "credsync" / "login_values.py"
P = "CFO_" + "CANARY_"


def b64u(d: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


def run(home: Path, *files: Path) -> tuple[dict, str]:
    out = subprocess.run([sys.executable, "-I", str(TOOL), "--home", str(home), *map(str, files)],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out), out


def test_report_by_key_class_and_place_without_values(tmp_path: Path) -> None:
    home = tmp_path
    (home / ".claude").mkdir()
    (home / ".codex/sessions").mkdir(parents=True)
    access = P + "claudeaccess0123456789abcdef0123456789"
    refresh = P + "codexrefresh0123456789abcdef0123456789a"
    account = str(uuid.uuid4())
    email = "synthetic-user@example.invalid"
    idt = "h." + b64u({"email": email, "iss": "https://issuer.invalid"}) + ".s"
    creds = home / ".claude/.credentials.json"
    creds.write_text(json.dumps({"claudeAiOauth": {"accessToken": access, "expiresAt": 1,
                                                   "rateLimitTier": "default_claude_max_20x",
                                                   "scopes": ["user:sessions:claude_code"]}}))
    auth = home / ".codex/auth.json"
    auth.write_text(json.dumps({"tokens": {"id_token": idt, "refresh_token": refresh, "account_id": account},
                                "last_refresh": "2026-10-22T00:00:00Z"}))
    # Copies: a plan value used as a key and as a value; an account id in a rollout; an identity
    # claim in a database; a cut piece of a token in a log; a base64 copy of a token.
    (home / ".claude.json").write_text(json.dumps({"oauthAccount": {"accountUuid": account,
                                                   "tier": "default_claude_max_20x"},
                                                   "seen": {"default_claude_max_20x": 1}}))
    (home / ".codex/sessions/rollout.jsonl").write_text(
        json.dumps({"type": "session_meta", "payload": {"type": "m", "acct": account}}) + "\n"
        + json.dumps({"type": "event", "payload": {"type": "log", "t": "..." + refresh[8:38] + "..."}}) + "\n")
    con = sqlite3.connect(home / ".codex/state.sqlite")
    con.execute("create table threads (id text, owner text)")
    con.execute("insert into threads values (?, ?)", ("t1", email))
    con.commit()
    con.close()
    (home / "notes.log").write_text("Basic " + base64.b64encode(access.encode()).decode())
    (home / "blob.txt").write_text(base64.b64encode(b"xy" + refresh.encode() + b"z").decode())

    report, raw = run(home, creds, auth, home / ".omnigent/auth_tokens.json")

    files = report["files_holding_a_login_value"]
    assert set(files) == {".claude.json", ".codex/sessions/rollout.jsonl", ".codex/state.sqlite", "notes.log", "blob.txt"}
    assert {m["form"] for m in files["blob.txt"]["matches"]} >= {"base64 (offset 2)"}
    cj = {(m["key"], m["class"]): m["where"] for m in files[".claude.json"]["matches"]}
    assert cj[("claudeAiOauth.rateLimitTier", "plan")] == ["oauthAccount.tier", "seen.<key holds the value>"]
    assert ("tokens.account_id", "identifier") in cj
    roll = {(m["key"], m["form"]): m["where"] for m in files[".codex/sessions/rollout.jsonl"]["matches"]}
    assert roll[("tokens.account_id", "whole")] == ["record session_meta/m: payload.acct (1 lines)"]
    assert roll[("tokens.refresh_token", "middle piece")] == ["record event/log: payload.t (1 lines)"]
    db = files[".codex/state.sqlite"]["matches"]
    assert db[0]["class"] == "jwt-claim:email" and db[0]["where"] == ["table threads, column owner (1 rows)"]
    assert "base64 (offset 0)" in {m["form"] for m in files["notes.log"]["matches"]}
    assert report["secrets_outside_login_files"] == [".codex/sessions/rollout.jsonl", "blob.txt", "notes.log"]
    # Nothing printable gives a value away.
    for value in (access, refresh, account, email, idt, refresh[8:38], "default_claude_max_20x"):
        assert value not in raw


def test_masks_values_used_in_paths(tmp_path: Path) -> None:
    home = tmp_path
    (home / ".codex").mkdir()
    account = str(uuid.uuid4())
    auth = home / ".codex/auth.json"
    auth.write_text(json.dumps({"tokens": {"account_id": account}}))
    d = home / "cache" / account
    d.mkdir(parents=True)
    (d / "state.json").write_text(json.dumps({account: {"x": account}}))
    report, raw = run(home, auth)
    assert account not in raw
    (path,) = report["files_holding_a_login_value"]
    assert path == "cache/<a login value>/state.json"
    where = report["files_holding_a_login_value"][path]["matches"][0]["where"]
    assert where == ["<a login value>.x", "<top level>.<key holds the value>"]


def test_review_r1_nothing_printable_leaks_through_names(tmp_path: Path) -> None:
    """Review s6-fu-r1: dotted secrets used as keys, dotted address keys, address-shaped claim
    names, JSONL record types and SQLite names must all print masked."""
    home = tmp_path
    (home / ".codex").mkdir()
    secret = P + "dotted.secret.0123456789abcdef.0123456789abcdef"
    address = "first.last-person@example.invalid"
    idt = "h." + b64u({"email": address, address: "claim-value-0123", "sub": "user-0123456789"}) + ".s"
    auth = home / ".codex/auth.json"
    auth.write_text(json.dumps({"tokens": {"access_token": secret, "id_token": idt}}))
    # A file that uses the secret and the address as keys, with a matching value beneath each.
    (home / "keys.json").write_text(json.dumps({secret: {"x": secret}, address: {"y": address}}))
    (home / "records.jsonl").write_text(json.dumps({"type": address, "payload": {"type": secret, "v": secret}}) + "\n")
    con = sqlite3.connect(home / "db.sqlite")
    con.execute(f'create table "{address}" ("{secret}" text)')
    con.execute(f'insert into "{address}" values (?)', (secret,))
    con.commit()
    con.close()
    report, raw = run(home, auth)
    for leak in (secret, address, "first.last", "first", "last-person", "dotted.secret", "0123456789abcdef",
                 "claim-value-0123", "user-0123456789"):
        assert leak not in raw, leak
    keys = report["files_holding_a_login_value"]["keys.json"]["matches"]
    assert {w for m in keys for w in m["where"]} >= {"<a login value>.x", "<a login value>.y"}
    classes = {m["class"] for f in report["files_holding_a_login_value"].values() for m in f["matches"]}
    assert "jwt-claim:<address>" in classes or all(":" not in c or "@" not in c for c in classes)
    db = report["files_holding_a_login_value"]["db.sqlite"]["matches"]
    assert any("table <a login value>, column <a login value>" in w for m in db for w in m["where"])


def test_review_r2_decorated_pieces_are_masked(tmp_path: Path) -> None:
    """Review s6-fu-r2: a piece of a token inside a longer printable name, with text around it,
    is masked in key paths, record types, SQLite names and file names."""
    home = tmp_path
    (home / ".codex").mkdir()
    token = P + "header0123456789" + "middle-abcdefghijklmnop" + "trailer9876543210"
    account = str(uuid.uuid4())
    auth = home / ".codex/auth.json"
    auth.write_text(json.dumps({"tokens": {"access_token": token, "account_id": account}}))
    piece, id_piece = "header0123456789", account[9:23]
    (home / "keys.json").write_text(json.dumps({f"prefix {piece} suffix": {"x": token}}))
    (home / "records.jsonl").write_text(json.dumps({"type": f"kind {id_piece} end", "v": token}) + "\n")
    con = sqlite3.connect(home / "db.sqlite")
    con.execute(f'create table "t {piece} u" ("c {id_piece} d" text)')
    con.execute(f'insert into "t {piece} u" values (?)', (account,))
    con.commit()
    con.close()
    d = home / f"dir {piece} x"
    d.mkdir()
    (d / "f.json").write_text(json.dumps({"y": account}))
    report, raw = run(home, auth)
    for leak in (piece, id_piece, token, account):
        assert leak not in raw, leak
    files = report["files_holding_a_login_value"]
    assert "<a login value>/f.json" in files
    assert files["keys.json"]["matches"][0]["where"] == ["<a login value>.x"]
