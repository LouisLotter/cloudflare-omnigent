"""Fake Claude Code and Codex CLIs, and the fake provider behind them (WP3.4; ported from S6).

Each fake writes its login file the way the pinned real CLI does, and answers the commands
the platform uses with the real CLI's output shapes and exit statuses:

  claude  ~/.claude/.credentials.json  temporary "<name>.tmp.<8 hex>" then rename, mode 0600
          (an atomic write: a new inode every time).
          ``auth login`` (signs in without a browser), ``auth status [--json]`` (JSON with
          ``loggedIn``; exit 0 signed in, 1 not), ``auth logout`` (revokes, then deletes;
          exit 0 even when the revocation failed, as the real one does).
  codex   ~/.codex/auth.json  rewritten in place: open(O_TRUNC) then write (same inode).
          ``login`` / ``login --device-auth`` (logs out first, as Codex does),
          ``login status`` ("Logged in using ChatGPT" exit 0, "Not logged in" exit 1),
          ``logout`` (revokes, then deletes; exit 0).
  Both    ``refresh`` rotates the refresh token at the provider and rewrites the login file;
          ``use`` makes a model call that refreshes an expired access token first.

The fake provider is a JSON file outside the computer's home (``CFO_FAKE_PROVIDER``): it knows
the current refresh token per login, rotates it, refuses a reused one (Codex then revokes the
whole family) and records revocation, so a test can tell which logins are still active.
Tokens are synthetic and carry the repository's canary prefix, so any leak is detectable.
Never point it at a real account: it never contacts a network.

Test knobs: ``CFO_FAKE_SLOW_WRITE_MS`` widens Codex's in-place write (half, pause, rest);
``CFO_FAKE_REVOKE_FAILS=1`` makes revocation fail silently, as the real CLIs report it.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import secrets
import sys
import time
from pathlib import Path

CANARY_PREFIX = "CFO_" + "CANARY_"  # split so this source holds no canary-shaped literal
HOME = Path(os.environ.get("HOME", "/home/omnigent"))
ACCESS_TTL = float(os.environ.get("CFO_FAKE_ACCESS_TTL", "3600"))
ROTATES = {"claude": True, "codex": True}


def token(provider: str, kind: str) -> str:
    return f"{CANARY_PREFIX}FAKE{provider}{kind}{secrets.token_hex(12)}"


def _h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def provider_path() -> Path:
    return Path(os.environ.get("CFO_FAKE_PROVIDER", "/var/lib/cfo-fake-provider/state.json"))


@contextlib.contextmanager
def provider_state():
    path = provider_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(path.read_text()) if path.exists() and path.stat().st_size else {}
        yield state
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=1))
        os.replace(tmp, path)


def provider_issue(provider: str) -> tuple[str, str, float]:
    access, refresh = token(provider, "access"), token(provider, "refresh")
    exp = time.time() + ACCESS_TTL
    with provider_state() as st:
        st[provider] = {
            "refresh": _h(refresh),
            "retired": [],
            "access": _h(access),
            "access_exp": exp,
            "revoked": False,
            "issued": st.get(provider, {}).get("issued", 0) + 1,
        }
    return access, refresh, exp


def provider_refresh(provider: str, refresh: str) -> tuple[str, str, float]:
    with provider_state() as st:
        fam = st.get(provider)
        if not fam or fam["revoked"]:
            raise PermissionError("refresh_token_invalidated")
        if _h(refresh) in fam["retired"]:
            if provider == "codex":
                fam["revoked"] = True  # reuse of a rotated token revokes the whole family
            raise PermissionError("refresh_token_reused")
        if _h(refresh) != fam["refresh"]:
            raise PermissionError("invalid_grant")
        access = token(provider, "access")
        new_refresh = refresh
        if ROTATES[provider]:
            new_refresh = token(provider, "refresh")
            fam["retired"].append(fam["refresh"])
            fam["refresh"] = _h(new_refresh)
        fam["access"] = _h(access)
        fam["access_exp"] = time.time() + ACCESS_TTL
        return access, new_refresh, fam["access_exp"]


def provider_revoke(provider: str, refresh: str | None) -> None:
    if os.environ.get("CFO_FAKE_REVOKE_FAILS") == "1":
        return
    with provider_state() as st:
        fam = st.get(provider)
        if fam and refresh and _h(refresh) in (fam["refresh"], *fam["retired"]):
            fam["revoked"] = True


def provider_check_access(provider: str, access: str) -> str:
    with provider_state() as st:
        fam = st.get(provider)
        if not fam or fam["revoked"]:
            return "revoked"
        if _h(access) != fam["access"]:
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
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    raw = data.encode()
    slow_ms = float(os.environ.get("CFO_FAKE_SLOW_WRITE_MS", "0"))
    with os.fdopen(fd, "wb") as f:
        if slow_ms > 0:
            f.write(raw[: len(raw) // 2])
            f.flush()
            time.sleep(slow_ms / 1000)
            f.write(raw[len(raw) // 2 :])
        else:
            f.write(raw)


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return None


def out(obj: object) -> None:
    print(json.dumps(obj))


# ---------------------------------------------------------------------------------------------
# claude

CLAUDE_CREDS = HOME / ".claude" / ".credentials.json"
CLAUDE_GLOBAL = HOME / ".claude.json"


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


def claude_set_global(update) -> None:
    data = read_json(CLAUDE_GLOBAL) or {}
    update(data)
    write_rename_claude_style(CLAUDE_GLOBAL, json.dumps(data, indent=2))


def claude(args: list[str]) -> int:
    cmd = args[:2]
    if cmd == ["auth", "login"]:
        current = read_json(CLAUDE_CREDS) or {}
        access, refresh, exp = provider_issue("claude")
        claude_store(access, refresh, exp, {k: v for k, v in current.items() if k != "claudeAiOauth"})
        claude_set_global(lambda d: d.update(oauthAccount={"accountUuid": "synthetic"}))
        print("Login successful.")
        return 0
    if cmd == ["auth", "status"]:
        creds = read_json(CLAUDE_CREDS) or {}
        logged_in = bool(creds.get("claudeAiOauth", {}).get("accessToken"))
        out(
            {
                "loggedIn": logged_in,
                "authMethod": "claude.ai" if logged_in else "none",
                "apiProvider": "firstParty",
            }
        )
        return 0 if logged_in else 1
    if cmd == ["auth", "logout"]:
        creds = read_json(CLAUDE_CREDS) or {}
        oauth = creds.get("claudeAiOauth") or {}
        provider_revoke("claude", oauth.get("refreshToken"))
        retained = {k: v for k, v in creds.items() if k == "mcpOAuth"}
        CLAUDE_CREDS.unlink(missing_ok=True)
        if retained:
            write_rename_claude_style(CLAUDE_CREDS, json.dumps(retained))
        claude_set_global(lambda d: d.pop("oauthAccount", None))
        print("Successfully logged out from your Anthropic account.")
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
            out({"error": str(e)})
            return 3
        claude_store(access, refresh, exp, {k: v for k, v in creds.items() if k != "claudeAiOauth"})
        out({"refresh": "ok"})
        return 0
    if args[:1] == ["use"]:
        return use("claude", lambda: (read_json(CLAUDE_CREDS) or {}).get("claudeAiOauth"), "accessToken", claude)
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
    if args[:2] == ["login", "status"]:
        data = read_json(CODEX_AUTH)
        if CODEX_AUTH.exists() and data is None:
            print("Error checking login status: invalid auth file")
            return 1
        ok = bool(data and data.get("tokens"))
        print("Logged in using ChatGPT" if ok else "Not logged in")
        return 0 if ok else 1
    if args[:1] == ["login"]:
        codex_logout()
        access, refresh, _ = provider_issue("codex")
        codex_write(access, refresh)
        print("Successfully logged in")
        return 0
    if args[:1] == ["logout"]:
        print("Successfully logged out" if codex_logout() else "Not logged in")
        return 0
    if args[:1] == ["refresh"]:
        data = read_json(CODEX_AUTH)
        if not data or not data.get("tokens"):
            out({"error": "not logged in"})
            return 1
        try:
            access, refresh, _ = provider_refresh("codex", data["tokens"]["refresh_token"])
        except PermissionError as e:
            out({"error": str(e)})
            return 3
        codex_write(access, refresh, data)
        out({"refresh": "ok"})
        return 0
    if args[:1] == ["use"]:
        return use("codex", lambda: (read_json(CODEX_AUTH) or {}).get("tokens"), "access_token", codex)
    print(f"fake codex: unknown command {args}", file=sys.stderr)
    return 2


def use(provider: str, load, access_key: str, cli) -> int:
    """A model call: refresh an expired access token first, then use it."""
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


def main() -> int:
    prog, args = sys.argv[1], sys.argv[2:]
    return {"claude": claude, "codex": codex}[prog](args)


if __name__ == "__main__":
    sys.exit(main())
