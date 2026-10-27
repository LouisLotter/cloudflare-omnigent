"""RC-53's value collector, inside a computer: every live credential the scan must not find.

    sudo python3 -I -m cfo_computer.rc53_collect PATH...   (collect, then scan PATHs)

Run as root inside a computer during a staging check. The check is opt-in: once
``/var/cfo/rc53/enabled`` exists (``sudo touch`` it from the setup terminal), the supervisor runs
this before every capture and the capture worker scans each staged layer with the values before
reporting it staged, recording only counts. The values exist only in memory: the supervisor keeps
them for the container's life (so every generation of a rotated token is kept) and hands them to
the capture worker on an anonymous memory descriptor. Nothing here writes a value to disk, argv or
a log.

The rule: collect credentials, never identifiers
------------------------------------------------
A value is collected only when it is a credential, something that grants access by itself.
Identifiers, addresses, names, descriptions and commands are not, even when they are long and sit
next to a token in the same file: Omnigent and the CLIs write them into transcripts, settings and
logs that are meant to be saved, so collecting them fails every save. (The 27 Oct 2026 staging
sitting: every save failed with up to 146 findings, and none was a credential. They came from
tool names and descriptions, session, bridge and conversation IDs, the server URL, the
installation ID header, Claude's ``rateLimitTier``, Codex's ``account_id``, hook commands, and the
runner's ``OMNIGENT_RUNNER_SLICE_KEY``, which is the host's ID used as a routing key.)

A string of 16 characters or more is collected when:

1. **Its own name says credential** (``credential_name``). The name is split into words
   (``privateKeyPkcs8B64`` is private, key, pkcs, 8, b, 64), trailing encoding words are dropped
   (b64, base64, hex, pem, der, pkcs8, value, ...), and the last word left must be a credential
   noun (token, secret, password, passphrase, authorization, auth, cookie, credential(s), bearer,
   verifier, apikey) or ``key`` qualified as a credential (api, private, secret, access, signing,
   provider, client, session, ... key). So ``accessToken``, ``refresh_token``, ``id_token``,
   ``token``, ``OMNIGENT_HOST_TOKEN``, ``OMNIGENT_RUNNER_TUNNEL_BINDING_TOKEN``,
   ``Authorization``, ``X-Omnigent-Host-Token``, ``ANTHROPIC_API_KEY``, ``clientSecret`` and
   ``privateKeyPkcs8B64`` are credentials; ``account_id``, ``login_owner_id``,
   ``X-Omnigent-Installation-Id``, ``bridge_id``, ``ap_server_url``, ``rateLimitTier``,
   ``refreshTokenExpiresAt``, ``token_type``, ``OMNIGENT_RUNNER_SLICE_KEY``, ``GPG_KEY``,
   ``SSH_AUTH_SOCK`` and ``PWD`` are not. A credential-named value that is only a path or a plain
   URL is not taken (it names where a credential is, not the credential).
2. **It follows ``Bearer``** in any string (a header value, a curl command), as an RFC 6750
   token; a shell variable such as ``$OMNIGENT_RELAY_TOKEN`` is not a value.
3. **It is assigned to a credential name** inside a string (``NAME=value`` in a command, an env
   file or a URL query), or is the password of a URL (``https://user:<password>@host``).
4. **It has a credential's own format** anywhere in a string: ``sk-ant-...``, ``sk-...``,
   ``ghp_``/``gho_``/``ghu_``/``ghs_``/``ghr_...``, ``github_pat_...``, or a JWT.
5. **It is the literal argument of a credential helper's command**: ``printf``/``echo`` in
   ``apiKeyHelper`` (Omnigent writes ``printf %s '<key>'`` for a static provider key) or in an
   environment variable such as ``OMNIGENT_CLAUDE_API_KEY_HELPER``.
6. **It is the whole of a file named as a credential** (``provider_key``).
7. **Git's credential broker hands it out** for github.com (core change 17).

Where it looks: every process's environment (rules 1 to 5); the native harnesses' bridge files in
the home and under ``$TMPDIR``, with their temporary variants; the declared login files and
Omnigent's own login; the broker.

The formats, surveyed at fork ``cfo/integration`` ``3228d4de3``, Claude Code 2.1.311 and Codex
0.164.0 (credentials marked *; everything else is an identifier or setting and is not taken):

- ``bridge.json``: claude-native ``{token*, bridge_id, active_session_id, conversation_id,
  workspace, launch_model, model_env, model_picker_values, sandbox, updated_at}``; codex-native and
  the ACP relay ``{token*}``.
- ``server.json``: ``{token*, pid, socket | url, updated_at}``.
- ``tool_relay.json``: ``{url, token*, tools[{name, description, parameters}], pid, session_id,
  updated_at}``; ``tool_relay.env``: ``OMNIGENT_RELAY_URL``, ``OMNIGENT_RELAY_TOKEN*``.
- ``turn_router.json``, ``subagent_router.json``: ``{url, token*, pid, session_id, updated_at}``.
- ``permission_hook.json`` (claude-native), ``policy_hook.json`` (codex-native): ``{ap_server_url,
  ap_auth_headers{Authorization* (Bearer owner token), X-Omnigent-Installation-Id, ...},
  updated_at}``.
- ``claude-settings.json``: hooks and status-line commands, model, permissions, MCP and skill
  settings, and ``apiKeyHelper`` (rule 5).
- ``provider_key``: the key provider's key, alone (rule 6).
- ``.claude/.credentials.json``: ``claudeAiOauth{accessToken*, refreshToken*, expiresAt,
  refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier}``, and MCP servers' OAuth
  (``accessToken*``, ``refreshToken*``, ``clientSecret*``, ``clientId``, ...).
- ``.claude/.device-keys.json``: ``{keys{<id>: {privateKeyPkcs8B64*, rowPk}}}``.
- ``.codex/auth.json``: ``{OPENAI_API_KEY*, auth_mode, last_refresh, tokens{id_token*,
  access_token*, refresh_token*, account_id, login_owner_id, oauth_provenance{client_id,
  issuer}}}`` (0.164.0 added ``login_owner_id`` and ``oauth_provenance``).
- ``.codex/.credentials.json`` (MCP OAuth): ``access_token*``, ``refresh_token*``,
  ``client_secret*``; the server name, URL, client ID, expiry and scopes are not.
- Environments: the launch token ``OMNIGENT_HOST_TOKEN``, the runner's
  ``OMNIGENT_RUNNER_TUNNEL_BINDING_TOKEN`` and ``OMNIGENT_RUNNER_INITIAL_AUTH_TOKEN``, the relay's
  ``OMNIGENT_RELAY_TOKEN``, CLI and provider keys (``*_API_KEY``); not
  ``OMNIGENT_RUNNER_SLICE_KEY`` or ``OMNIGENT_RUNNER_ID``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import socket
from collections.abc import Iterable
from pathlib import Path

MIN = 16
HOME = Path("/home/omnigent")
LOGINS = (
    ".claude/.credentials.json",
    ".claude/.device-keys.json",
    ".codex/auth.json",
    ".codex/.credentials.json",
    ".omnigent/auth_tokens.json",
)
BRIDGE_NAMES = {
    "policy_hook.json",
    "bridge.json",
    "server.json",
    "tool_relay.json",
    "tool_relay.env",
    "turn_router.json",
    "subagent_router.json",
    "provider_key",
    "permission_hook.json",
    "claude-settings.json",
}

# Rule 1: a credential's name.
_NOUNS = frozenset(
    {
        "token",
        "secret",
        "password",
        "passwd",
        "passphrase",
        "authorization",
        "auth",
        "cookie",
        "credential",
        "credentials",
        "bearer",
        "verifier",
        "apikey",
    }
)
_KEY_KINDS = frozenset(
    {
        "api",
        "private",
        "secret",
        "access",
        "signing",
        "provider",
        "client",
        "encryption",
        "master",
        "session",
        "auth",
        "gateway",
        "vault",
        "license",
        "subscription",
        "account",
        "app",
        "deploy",
        "hmac",
        "shared",
        "storage",
        "service",
        "admin",
    }
)
_ENCODINGS = frozenset(
    {
        "b",
        "64",
        "b64",
        "base64",
        "base64url",
        "hex",
        "pem",
        "der",
        "pkcs",
        "pkcs8",
        "8",
        "jwk",
        "raw",
        "value",
        "str",
        "string",
        "data",
        "bytes",
        "encoded",
        "enc",
    }
)
_HELPERS = frozenset({"helper", "command", "cmd"})
_WORD = re.compile(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+")
# Rule 2: an RFC 6750 bearer token (b64token), never a shell variable.
_BEARER = re.compile(r"\bBearer\s+([A-Za-z0-9\-._~+/]+=*)", re.I)
# Rule 3: NAME=value in a command, an env file or a query; a URL's password.
_ASSIGNMENT = re.compile(
    r"(?:^|[\s;&?|(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)=(\"[^\"]*\"|'[^']*'|[^\s;&#|)]+)"
)
_URL_PASSWORD = re.compile(r"\b[a-z][a-z0-9+.-]*://[^/\s:@'\"]+:([^/\s@'\"]+)@", re.I)
# Rule 4: credential formats.
_FORMATS = re.compile(
    r"(?<![A-Za-z0-9_-])(?:"
    r"sk-ant-[A-Za-z0-9_-]{16,}"
    r"|sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}"
    r"|gh[pousr]_[A-Za-z0-9]{30,}"
    r"|github_pat_[A-Za-z0-9_]{30,}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r")"
)
_NOT_A_VALUE = re.compile(r"^(?:/|~/|\$|[a-z][a-z0-9+.-]*://[^@\s]*$)", re.I)


def words(name: str) -> list[str]:
    """``privateKeyPkcs8B64`` -> private, key, pkcs, 8, b, 64; ``X-Api-Key`` -> x, api, key."""
    return [w.lower() for part in re.split(r"[^A-Za-z0-9]+", name) for w in _WORD.findall(part)]


def _credential_words(ws: list[str]) -> bool:
    while ws and ws[-1] in _ENCODINGS:
        ws = ws[:-1]
    if not ws:
        return False
    last = ws[-1]
    return last in _NOUNS or (last in ("key", "keys") and len(ws) > 1 and ws[-2] in _KEY_KINDS)


def credential_name(name: str) -> bool:
    """Whether a field, header, variable or file named ``name`` holds a credential (rule 1)."""
    return _credential_words(words(name))


def helper_name(name: str) -> bool:
    """Whether ``name`` holds a command that prints a credential (``apiKeyHelper``)."""
    ws = words(name)
    return len(ws) > 1 and ws[-1] in _HELPERS and _credential_words(ws[:-1])


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def _helper_literals(command: str) -> list[str]:
    """Rule 5: the literal arguments ``printf``/``echo`` print in a credential helper."""
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return []
    out: list[str] = []
    segment: list[str] = []
    for token in [*tokens, ";"]:
        if token and set(token) <= set(";|&()"):
            while segment and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", segment[0]):
                segment.pop(0)
            if segment and os.path.basename(segment[0]) in ("printf", "echo"):
                out += [a for a in segment[1:] if not a.startswith(("-", "$")) and "%" not in a]
            segment = []
        else:
            segment.append(token)
    return out


def from_string(name: str, value: str) -> set[str]:
    """The credentials in one string value named ``name`` (rules 1 to 5)."""
    out: set[str] = set()
    text = value.strip()
    if credential_name(name) and not _NOT_A_VALUE.match(text):
        out.add(text)
    if helper_name(name):
        out.update(_helper_literals(text))
    out.update(_BEARER.findall(value))
    for assigned, raw in _ASSIGNMENT.findall(value):
        literal = _unquote(raw)
        if credential_name(assigned) and not _NOT_A_VALUE.match(literal):
            out.add(literal)
    out.update(_URL_PASSWORD.findall(value))
    out.update(m.group(0) for m in _FORMATS.finditer(value))
    return {v for v in out if len(v) >= MIN}


def from_json(value: object, name: str = "") -> set[str]:
    """Walk a parsed JSON document: each string is judged by the name of the field holding it
    (a list's items by the list's name)."""
    if isinstance(value, dict):
        return {s for k, v in value.items() for s in from_json(v, str(k))}
    if isinstance(value, list):
        return {s for v in value for s in from_json(v, name)}
    if isinstance(value, str):
        return from_string(name, value)
    return set()


def from_file(path: Path) -> set[str]:
    """The credentials in one bridge or login file: JSON by field, an env file by variable, and
    a file named as a credential (``provider_key``) whole."""
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return set()
    out: set[str] = set()
    stem = path.name.lstrip(".").split(".")[0]
    if credential_name(stem) and text.strip() and "\n" not in text.strip():
        out.add(text.strip())
    try:
        out |= from_json(json.loads(text))
    except ValueError:
        for line in text.splitlines():
            out |= from_string("", line)
    return {v for v in out if len(v) >= MIN}


def from_environ(environ: bytes) -> set[str]:
    """The credentials in one process's environment (``/proc/<pid>/environ``)."""
    out: set[str] = set()
    for item in environ.split(b"\0"):
        name, _, value = item.decode("utf-8", "replace").partition("=")
        if value:
            out |= from_string(name, value)
    return out


def _process_ids(process_scope: set[int] | None) -> list[str]:
    """Every process, or (outside a computer, as in tests) only these trees."""
    if process_scope is None:
        return [p for p in os.listdir("/proc") if p.isdigit()]
    from . import procs as P

    return [str(pid) for pid in P.descendants(P.scan(with_cmdline=False), process_scope)]


def _bridge_files(roots: Iterable[Path]) -> Iterable[Path]:
    for root in roots:
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                if name in BRIDGE_NAMES or any(
                    name.startswith(f".{b}.") or name.startswith(f"{b}.") for b in BRIDGE_NAMES
                ):
                    yield Path(dirpath, name)


def collect(
    home: Path = HOME,
    *,
    tmp_roots: list[Path] | None = None,
    process_scope: set[int] | None = None,
    broker_root: Path | None = None,
) -> set[str]:
    """The live credentials, in memory.

    ``process_scope``: None reads every process's environment (inside a computer); a set
    reads only those trees. ``tmp_roots``: where the native bridges under ``$TMPDIR`` live
    (``/tmp``). ``broker_root``: where the host's credential-broker sockets live (``/tmp``
    inside a computer); None asks no broker.
    """
    values: set[str] = set()
    for pid in _process_ids(process_scope):
        try:
            values |= from_environ(Path(f"/proc/{pid}/environ").read_bytes())
        except OSError:
            continue
    for rel in LOGINS:
        values |= from_file(home / rel)
    roots = [home / ".omnigent", *(tmp_roots if tmp_roots is not None else [Path("/tmp")])]
    for path in _bridge_files(roots):
        values |= from_file(path)
    if broker_root is not None:
        values.update(github_token(broker_root))
    return {v for v in values if len(v) >= MIN}


def github_token(broker_root: Path) -> list[str]:
    """Ask each credential-broker socket for github.com, as git does (core change 17)."""
    out = []
    for sock in broker_root.glob("omnigent-*/credentials-*.sock"):
        try:
            with socket.socket(socket.AF_UNIX) as s:
                s.settimeout(5)
                s.connect(str(sock))
                s.sendall(b"protocol=https\nhost=github.com\n\n")
                s.shutdown(socket.SHUT_WR)
                reply = b""
                while chunk := s.recv(4096):
                    reply += chunk
        except OSError:
            continue
        for line in reply.decode("utf-8", "replace").splitlines():
            if line.startswith("password=") and len(line) > 9 + MIN:
                out.append(line[9:])
    return out


def main() -> int:
    """Collect the values in memory and scan PATHs with them; print the scan's report only."""
    from . import rc53

    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+", type=Path)
    args = ap.parse_args()
    values = collect(broker_root=Path("/tmp"))
    code, report = rc53.run(args.paths, sorted(values), [])
    print(json.dumps({"status": code, "values": len(values), **report}, indent=1))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
