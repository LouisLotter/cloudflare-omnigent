"""Fake Claude Code, Codex and Omnigent CLIs for spike S6 (throwaway test code).

Each fake writes the same credential file, in the same way, as the pinned real CLI does
(see the S6 evidence report, kept outside the repository):

  claude    ~/.claude/.credentials.json   temp "<name>.tmp.<8 hex>" + rename, mode 0600.
            logout: revoke, then unlink (or rewrite with only non-Anthropic keys, such as
            mcpOAuth, when those exist). ~/.claude.json carries account metadata, no tokens.
  codex     ~/.codex/auth.json            in place: open(O_WRONLY|O_CREAT|O_TRUNC, 0600) + write.
            login first logs out (revoke + unlink). Refresh rotates the refresh token.
            logout: revoke, then unlink.
  omnigent  ~/.omnigent/auth_tokens.json  temp ".auth_tokens.json.<rand>.tmp" + os.replace,
            under an flock on auth_tokens.lock. Refresh keeps the (non-rotating) refresh grant.
            No logout command exists in 0.17.0; "logout" here models clear_token, which leaves
            "{}" behind, and "signout-delete" models the platform deleting the file.

A fake provider (a JSON file named by S6_FAKE_PROVIDER, outside the computer's home) plays the
token servers: it knows which refresh token is current, rotates, detects reuse and revocation.
Tokens are synthetic and carry the repository's canary prefix so leaks are detectable.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path

CANARY_PREFIX = "CFO_" + "CANARY_"  # split so the source holds no canary-shaped literal
HOME = Path(os.environ.get("HOME", "/root"))


def token(provider: str, kind: str) -> str:
    return f"{CANARY_PREFIX}S6{provider}{kind}{secrets.token_hex(12)}"


def h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


# ---------------------------------------------------------------------------------------------
# Fake provider


@contextlib.contextmanager
def provider_state():
    path = Path(os.environ.get("S6_FAKE_PROVIDER", "/tmp/s6-fake-provider.json"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_suffix(".lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        state = json.loads(path.read_text()) if path.exists() and path.stat().st_size else {}
        yield state
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=1))
        os.replace(tmp, path)


ROTATES = {"claude": True, "codex": True, "omnigent": False}
ACCESS_TTL = float(os.environ.get("S6_FAKE_ACCESS_TTL", "3600"))


def provider_issue(provider: str) -> tuple[str, str, float]:
    access, refresh = token(provider, "access"), token(provider, "refresh")
    exp = time.time() + ACCESS_TTL
    with provider_state() as st:
        st[provider] = {"refresh": h(refresh), "retired": [], "access": h(access), "access_exp": exp, "revoked": False}
    return access, refresh, exp


def provider_refresh(provider: str, refresh: str) -> tuple[str, str, float]:
    with provider_state() as st:
        fam = st.get(provider)
        if not fam or fam["revoked"]:
            raise PermissionError("refresh_token_invalidated")
        if h(refresh) in fam["retired"]:
            if provider == "codex":
                fam["revoked"] = True  # reuse of a rotated token revokes the whole family
            raise PermissionError("refresh_token_reused")
        if h(refresh) != fam["refresh"]:
            raise PermissionError("invalid_grant")
        access = token(provider, "access")
        new_refresh = refresh
        if ROTATES[provider]:
            new_refresh = token(provider, "refresh")
            fam["retired"].append(fam["refresh"])
            fam["refresh"] = h(new_refresh)
        fam["access"] = h(access)
        fam["access_exp"] = time.time() + ACCESS_TTL
        return access, new_refresh, fam["access_exp"]


def provider_revoke(provider: str, refresh: str | None) -> None:
    with provider_state() as st:
        fam = st.get(provider)
        if fam and refresh and h(refresh) in (fam["refresh"], *fam["retired"]):
            fam["revoked"] = True


def provider_check_access(provider: str, access: str) -> str:
    with provider_state() as st:
        fam = st.get(provider)
        if not fam or fam["revoked"]:
            return "revoked"
        if h(access) != fam["access"]:
            return "invalid"
        if time.time() >= fam["access_exp"]:
            return "expired"
        return "ok"


# ---------------------------------------------------------------------------------------------
# File writers that mimic each CLI


def write_rename_claude_style(target: Path, data: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = target.parent / f"{target.name}.tmp.{secrets.token_hex(4)}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(data)
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)


def write_in_place_codex_style(target: Path, data: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    raw = data.encode()
    slow_ms = float(os.environ.get("S6_FAKE_SLOW_WRITE_MS", "0"))
    with os.fdopen(fd, "wb") as f:
        if slow_ms > 0:
            # Widen the window between truncate and the end of the write, to test settling.
            f.write(raw[: len(raw) // 2])
            f.flush()
            time.sleep(slow_ms / 1000)
            f.write(raw[len(raw) // 2 :])
        else:
            f.write(raw)


def write_tempfile_replace_omnigent_style(target: Path, data: dict) -> None:
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(target.parent, 0o700)
    with tempfile.NamedTemporaryFile("w", dir=target.parent, prefix=f".{target.name}.", suffix=".tmp", delete=False) as f:
        tmp = Path(f.name)
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def out(obj) -> None:
    print(json.dumps(obj))


# ---------------------------------------------------------------------------------------------
# claude


CLAUDE_CREDS = HOME / ".claude" / ".credentials.json"
CLAUDE_GLOBAL = HOME / ".claude.json"


def claude_set_global(update) -> None:
    data = read_json(CLAUDE_GLOBAL) or {}
    update(data)
    write_rename_claude_style(CLAUDE_GLOBAL, json.dumps(data, indent=2))


def claude_store(access: str, refresh: str, exp: float, extra: dict | None = None) -> None:
    data = dict(extra or {})
    data["claudeAiOauth"] = {
        "accessToken": access,
        "refreshToken": refresh,
        "expiresAt": int(exp * 1000),
        "scopes": ["user:inference", "user:profile"],
        "subscriptionType": "synthetic",
    }
    write_rename_claude_style(CLAUDE_CREDS, json.dumps(data))


def claude(args: list[str]) -> int:
    cmd = " ".join(args[:2])
    if cmd == "auth login":
        current = read_json(CLAUDE_CREDS) or {}
        access, refresh, exp = provider_issue("claude")
        claude_store(access, refresh, exp, {k: v for k, v in current.items() if k != "claudeAiOauth"})
        claude_set_global(lambda d: d.update(oauthAccount={"accountUuid": "synthetic"}, hasCompletedOnboarding=True))
        out({"login": "ok"})
        return 0
    if cmd == "auth status":
        creds = read_json(CLAUDE_CREDS) or {}
        logged_in = bool(creds.get("claudeAiOauth", {}).get("accessToken"))
        out({"loggedIn": logged_in, "authMethod": "claude.ai" if logged_in else "none",
             "accountMetadata": "oauthAccount" in (read_json(CLAUDE_GLOBAL) or {})})
        return 0 if logged_in else 1
    if cmd == "auth logout":
        creds = read_json(CLAUDE_CREDS) or {}
        oauth = creds.get("claudeAiOauth") or {}
        provider_revoke("claude", oauth.get("refreshToken"))
        retained = {k: v for k, v in creds.items() if k == "mcpOAuth"}
        CLAUDE_CREDS.unlink(missing_ok=True)
        if retained:
            write_rename_claude_style(CLAUDE_CREDS, json.dumps(retained))
        claude_set_global(lambda d: d.pop("oauthAccount", None))
        out({"logout": "ok", "rewroteRetainedKeys": bool(retained)})
        return 0
    if args[:1] == ["refresh"]:
        creds = read_json(CLAUDE_CREDS) or {}
        oauth = creds.get("claudeAiOauth")
        if not oauth:
            out({"error": "not logged in"})
            return 1
        try:
            access, refresh, exp = provider_refresh("claude", oauth["refreshToken"])
        except PermissionError as e:
            out({"error": str(e), "action": "sign in again"})
            return 3
        claude_store(access, refresh, exp, {k: v for k, v in creds.items() if k != "claudeAiOauth"})
        out({"refresh": "ok"})
        return 0
    if args[:1] == ["use"]:
        return use("claude", lambda: (read_json(CLAUDE_CREDS) or {}).get("claudeAiOauth"), "accessToken", claude)
    if args[:1] == ["add-mcp-oauth"]:
        creds = read_json(CLAUDE_CREDS) or {}
        creds["mcpOAuth"] = {"synthetic-server": {"accessToken": token("mcp", "access")}}
        write_rename_claude_style(CLAUDE_CREDS, json.dumps(creds))
        return 0
    if args[:1] == ["session"]:
        return session(HOME / ".claude" / "projects" / "-work" / f"{args[1]}.jsonl", HOME / ".claude" / "history.jsonl", args[1])
    print(f"fake claude: unknown command {args}", file=sys.stderr)
    return 2


# ---------------------------------------------------------------------------------------------
# codex


CODEX_AUTH = HOME / ".codex" / "auth.json"


def codex_write(access: str, refresh: str, previous: dict | None = None) -> None:
    data = previous or {"auth_mode": "chatgpt", "OPENAI_API_KEY": None}
    data["tokens"] = {
        "id_token": token("codex", "id"),
        "access_token": access,
        "refresh_token": refresh,
        "account_id": "synthetic-account",
    }
    data["last_refresh"] = time.strftime("%Y-%m-%dT%H:%M:%S.000000Z", time.gmtime())
    write_in_place_codex_style(CODEX_AUTH, json.dumps(data, indent=2))


def codex_logout() -> bool:
    data = read_json(CODEX_AUTH)
    if data:
        provider_revoke("codex", (data.get("tokens") or {}).get("refresh_token"))
    existed = CODEX_AUTH.exists()
    CODEX_AUTH.unlink(missing_ok=True)
    return existed


def codex(args: list[str]) -> int:
    if args[:1] == ["login"] and "status" not in args:
        codex_logout()  # Codex clears existing auth (with revoke) before every login
        access, refresh, _ = provider_issue("codex")
        codex_write(access, refresh)
        out({"login": "ok"})
        return 0
    if args[:2] == ["login", "status"]:
        data = read_json(CODEX_AUTH)
        ok = bool(data and data.get("tokens"))
        print("Logged in using ChatGPT" if ok else "Not logged in")
        return 0 if ok else 1
    if args[:1] == ["logout"]:
        out({"logout": "ok" if codex_logout() else "not logged in"})
        return 0
    if args[:1] == ["refresh"]:
        data = read_json(CODEX_AUTH)
        if not data or not data.get("tokens"):
            out({"error": "not logged in"})
            return 1
        try:
            access, refresh, _ = provider_refresh("codex", data["tokens"]["refresh_token"])
        except PermissionError as e:
            out({"error": str(e), "action": "sign in again"})
            return 3
        codex_write(access, refresh, data)
        out({"refresh": "ok"})
        return 0
    if args[:1] == ["use"]:
        return use("codex", lambda: (read_json(CODEX_AUTH) or {}).get("tokens"), "access_token", codex)
    if args[:1] == ["session"]:
        return session(HOME / ".codex" / "sessions" / "2026" / "10" / "18" / f"rollout-{args[1]}.jsonl", HOME / ".codex" / "history.jsonl", args[1])
    print(f"fake codex: unknown command {args}", file=sys.stderr)
    return 2


# ---------------------------------------------------------------------------------------------
# omnigent


OMNI_DIR = HOME / ".omnigent"
OMNI_TOKENS = OMNI_DIR / "auth_tokens.json"


@contextlib.contextmanager
def omni_lock():
    OMNI_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(OMNI_DIR / "auth_tokens.lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        yield


def omnigent(args: list[str]) -> int:
    server = (args[1] if len(args) > 1 else "http://omnigent.internal").rstrip("/")
    if args[:1] == ["login"]:
        access, refresh, exp = provider_issue("omnigent")
        with omni_lock():
            data = read_json(OMNI_TOKENS) or {}
            data[server] = {"token": access, "user_id": "synthetic-user", "expires_at": exp, "refresh_token": refresh}
            write_tempfile_replace_omnigent_style(OMNI_TOKENS, data)
        (OMNI_DIR / "config.yaml").write_text(f"server: {server}\n")
        out({"login": "ok"})
        return 0
    if args[:1] == ["refresh"]:
        with omni_lock():
            data = read_json(OMNI_TOKENS) or {}
            entry = data.get(server)
            if not entry or not entry.get("refresh_token"):
                out({"error": "not logged in"})
                return 1
            try:
                access, refresh, exp = provider_refresh("omnigent", entry["refresh_token"])
            except PermissionError as e:
                out({"error": str(e), "action": "sign in again"})
                return 3
            entry.update(token=access, refresh_token=refresh, expires_at=exp)
            write_tempfile_replace_omnigent_style(OMNI_TOKENS, data)
        out({"refresh": "ok"})
        return 0
    if args[:1] == ["logout"]:  # models cli_auth.clear_token: the file stays, without the entry
        with omni_lock():
            data = read_json(OMNI_TOKENS)
            if data and server in data:
                entry = data.pop(server)
                provider_revoke("omnigent", entry.get("refresh_token"))
                write_tempfile_replace_omnigent_style(OMNI_TOKENS, data)
        out({"logout": "ok"})
        return 0
    if args[:1] == ["signout-delete"]:  # models the platform deleting the file
        data = read_json(OMNI_TOKENS) or {}
        for entry in data.values():
            provider_revoke("omnigent", entry.get("refresh_token"))
        OMNI_TOKENS.unlink(missing_ok=True)
        out({"signout": "ok"})
        return 0
    if args[:1] == ["status"]:
        data = read_json(OMNI_TOKENS) or {}
        ok = bool(data.get(server, {}).get("token"))
        out({"loggedIn": ok})
        return 0 if ok else 1
    if args[:1] == ["use"]:
        return use("omnigent", lambda: {"token": (read_json(OMNI_TOKENS) or {}).get(server, {}).get("token")}, "token",
                   lambda a: omnigent(["refresh", server]))
    print(f"fake omnigent: unknown command {args}", file=sys.stderr)
    return 2


# ---------------------------------------------------------------------------------------------


def use(provider: str, load, access_key: str, cli) -> int:
    """A model call: refresh when the access token has expired, then use it."""
    creds = load() or {}
    access = creds.get(access_key)
    if not access:
        out({"use": "not logged in"})
        return 1
    status = provider_check_access(provider, access)
    if status == "expired":
        rc = cli(["refresh"])
        if rc != 0:
            return rc
        access = (load() or {}).get(access_key)
        status = provider_check_access(provider, access)
    out({"use": status})
    return 0 if status == "ok" else 3


def session(path: Path, history: Path, name: str) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps({"turn": time.time(), "session": name}) + "\n")
    with open(history, "a") as f:
        f.write(json.dumps({"display": f"turn in {name}", "at": time.time()}) + "\n")
    return 0


def main() -> int:
    prog, args = sys.argv[1], sys.argv[2:]
    return {"claude": claude, "codex": codex, "omnigent": omnigent}[prog](args)


if __name__ == "__main__":
    sys.exit(main())
