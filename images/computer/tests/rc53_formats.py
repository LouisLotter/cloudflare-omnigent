"""Every file RC-53's collector reads, written as a live computer has them (WP3.22).

Runs on Omnigent's interpreter (``/opt/venv/bin/python -I``) with a throwaway HOME and TMPDIR.
The bridge, relay, router, hook and settings files are written by Omnigent's own code at the
image's pin (fork ``cfo/integration``), with the arguments a host-launched runner passes; the
runner's environment is the host's own ``_build_runner_env``. The login files are written in the
CLIs' formats (Claude Code 2.1.311's ``.credentials.json`` and ``.device-keys.json``, Codex
0.164.0's ``auth.json`` with ``login_owner_id`` and ``oauth_provenance``), as surveyed with real
logins in spike S6 and WP3.20, since only the CLIs themselves write them. Synthetic values only:
every credential is a run-time canary, in its real format where it has one; no network.

    rc53_formats.py write <out.json>
        writes the files and records {"credentials": {label: value}, "identifiers": {label:
        value}, "files": [path...], "runner_env": {...}, "home": ..., "tmp": ...}
    rc53_formats.py templates <out.json>
        the same files as one document, each credential replaced by @@label@@ and the run's HOME
        and TMPDIR by /home/omnigent and /tmp: the committed fixture
        python/tests/computer/fixtures/rc53-formats.json (no canary is ever committed)
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import secrets
import shlex
import sys
from pathlib import Path

CANARY = "CFO_" + "CANARY_"
HOME = Path(os.environ["HOME"])
TMP = Path(os.environ["TMPDIR"])
SERVER = "https://omnigent.example.test"
CONVERSATION = "conv_0199c3a47b2e7c1d9f00000000322a"
BRIDGE_ID = "bridge_0199c3a47b2e7c1d9f00000000322b"
CODEX_SESSION = "conv_0199c3a47b2e7c1d9f00000000322c"
HOST_ID = "0f3c9a2e5b7d41e8a6c2d9f04b1e7a53"
RUNNER_ID = "runner_0199c3a47b2e7c1d9f00000000322d"


def canary(label: str) -> str:
    return f"{CANARY}R53{label}{secrets.token_hex(10)}"


def credential(label: str, shape: str = "plain") -> str:
    """A synthetic credential in its real format (Anthropic, OpenAI, a JWT), or plain, or shaped to
    defeat a collector that judges by the value (opaque, slash-prefixed)."""
    value = canary(label)
    if shape == "oat":
        return f"sk-ant-oat01-{value}"
    if shape == "ort":
        return f"sk-ant-ort01-{value}"
    if shape == "sk":
        return f"sk-proj-{value}"
    if shape == "jwt":
        return f"eyJhbGciOiJSUzI1NiIsImtpZCI6InIifQ.eyJzdWIiOiJyYzUzIn0.{value}"
    if shape == "opaque":  # no known format; starts with "-", holds "%" and "$" (quoted)
        return f"-{value}%s$x"
    if shape == "slash":  # base64 tokens may start with "/"
        return f"/{value}+=="
    return value


def write() -> dict:
    from omnigent.cli_auth import databricks_request_headers
    from omnigent.harnesses.claude_native import bridge as cb
    from omnigent.harnesses.codex_native import bridge as xb
    from omnigent.host import connect
    from omnigent.inner import codex_executor
    from omnigent.runner import subagent_routing
    from omnigent.runner.tool_dispatch import build_native_relay_tool_schemas

    creds: dict[str, str] = {}
    ids: dict[str, str] = {}

    def cred(label: str, shape: str = "plain") -> str:
        creds[label] = credential(label, shape)
        return creds[label]

    workspace = HOME / "work"
    workspace.mkdir(parents=True, exist_ok=True)
    owner = cred("owner_bearer")
    # The runner's server headers, as the claude-native runner passes them to the hooks:
    # the owner bearer, and the installation ID from Omnigent's telemetry state.
    headers = databricks_request_headers(SERVER, bearer_token=owner)

    # Claude-native: bridge, MCP control server, relay, hooks and settings.
    bridge = cb.prepare_bridge_dir(
        CONVERSATION,
        bridge_id=BRIDGE_ID,
        workspace=workspace,
        launch_model="claude-opus-4-7",
        launch_env={"ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-7"},
    )
    creds["claude_bridge_token"] = json.loads((bridge / "bridge.json").read_text())["token"]
    httpd = cb._start_http_ingress(bridge, creds["claude_bridge_token"], queue.Queue())
    httpd.shutdown()
    httpd.server_close()
    tools = build_native_relay_tool_schemas(None)

    async def relay() -> None:
        async def no_tool(name, args):
            return {}

        handle = cb.start_tool_relay(
            bridge_dir=bridge,
            tools=tools,
            tool_executor=no_tool,
            loop=asyncio.get_running_loop(),
            session_id=CONVERSATION,
        )
        info = json.loads((bridge / "tool_relay.json").read_text())
        creds["relay_token"] = info["token"]
        ids["relay_url"] = info["url"]
        handle._httpd.shutdown()
        handle._httpd.server_close()

    asyncio.run(relay())
    provider_key = cred("anthropic_provider_key", "opaque")
    subagent_routing.write_advertisement(
        bridge, url="http://127.0.0.1:41999", token=cred("turn_router"), filename="turn_router.json"
    )
    subagent_routing.write_advertisement(
        bridge,
        url="http://127.0.0.1:41998",
        token=cred("subagent_router"),
        filename="subagent_router.json",
    )
    cb.augment_claude_args(
        ("--permission-mode", "default"),
        bridge_dir=bridge,
        python_executable="/opt/venv/bin/python",
        ap_server_url=SERVER,
        ap_auth_headers=headers,
        api_key_helper=f"printf %s {shlex.quote(provider_key)}",
        subagent_router_dir=bridge,
        turn_routing=True,
    )
    settings = json.loads((bridge / "claude-settings.json").read_text())
    for event, groups in settings["hooks"].items():
        for i, group in enumerate(groups):
            for j, hook in enumerate(group["hooks"]):
                ids[f"hook {event} {i}.{j}"] = hook["command"]
    ids["status line"] = settings["statusLine"]["command"]

    # Codex-native: bridge, policy hook with a renewed owner bearer, routers, provider key.
    xbridge = xb.prepare_bridge_dir(CODEX_SESSION)
    xb.write_mcp_bridge_config(xbridge)
    creds["codex_bridge_token"] = json.loads((xbridge / "bridge.json").read_text())["token"]
    xb.write_policy_hook_config(xbridge, ap_server_url=SERVER, ap_auth_headers=headers)
    renewed = cred("owner_bearer_renewed")
    xb.update_policy_hook_auth_headers(
        xbridge, databricks_request_headers(SERVER, bearer_token=renewed)
    )
    subagent_routing.write_advertisement(
        xbridge,
        url="http://127.0.0.1:41997",
        token=cred("codex_router"),
        filename="turn_router.json",
    )
    codex_home = xb.codex_home_for_bridge_dir(xbridge)
    overrides = codex_executor._provider_codex_config_overrides(
        model="gpt-5.5",
        base_url="http://127.0.0.1:41996/v1",
        api_key=cred("codex_provider_key", "sk"),
        wire_api="responses",
    )
    codex_executor.materialize_codex_provider_config(
        codex_home, overrides, key_file=xbridge / "provider_key"
    )

    # The CLIs' logins, in their own formats.
    claude = HOME / ".claude"
    claude.mkdir(mode=0o700, exist_ok=True)
    (claude / ".credentials.json").write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": cred("claude_access", "oat"),
                    "refreshToken": cred("claude_refresh", "ort"),
                    "expiresAt": 1793120000000,
                    "refreshTokenExpiresAt": 1795700000000,
                    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
                    "subscriptionType": "max",
                    "rateLimitTier": "default_claude_max_20x",
                },
                "mcpOAuth": {
                    "omnigent-docs|5f1e0c2a9b3d7e41": {
                        "serverName": "omnigent-docs",
                        "serverUrl": "https://mcp.example.test/sse",
                        "clientId": "mcp-client-0199c3a47b2e7c1d",
                        "clientSecret": cred("claude_mcp_client_secret"),
                        "accessToken": cred("claude_mcp_access", "slash"),
                        "refreshToken": cred("claude_mcp_refresh"),
                        "expiresAt": 1793120000000,
                        "scope": "read write",
                    }
                },
            }
        )
    )
    (claude / ".device-keys.json").write_text(
        json.dumps(
            {
                "keys": {
                    "org_0199c3a47b2e7c1d9f0000000322e": {
                        "privateKeyPkcs8B64": cred("claude_device_key"),
                        "rowPk": "dk_0199c3a47b2e7c1d9f00000000322f",
                    }
                }
            }
        )
    )
    codex = HOME / ".codex"
    codex.mkdir(mode=0o700, exist_ok=True)
    (codex / "auth.json").write_text(
        json.dumps(
            {
                "OPENAI_API_KEY": None,
                "auth_mode": "chatgpt",
                "last_refresh": "2026-10-27T16:00:00.000000000Z",
                "tokens": {
                    "id_token": cred("codex_id", "jwt"),
                    "access_token": cred("codex_access", "jwt"),
                    "refresh_token": cred("codex_refresh"),
                    "account_id": "7f9c2e1a-5b3d-4e8f-a6c2-d9f04b1e7a53",
                    "login_owner_id": "Q2ZvUmM1M0xvZ2luT3duZXJJZGVudGlmaWVyMDAwMDA",
                    "oauth_provenance": {
                        "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
                        "issuer": "https://auth.openai.com",
                    },
                },
            },
            indent=2,
        )
    )
    (codex / ".credentials.json").write_text(
        json.dumps(
            {
                "omnigent-docs|9a1b2c3d": {
                    "server_name": "omnigent-docs",
                    "url": "https://mcp.example.test/mcp",
                    "client_id": "mcp-client-0199c3a47b2e7c1e",
                    "access_token": cred("codex_mcp_access"),
                    "refresh_token": cred("codex_mcp_refresh"),
                    "expires_at": 1793120000000,
                    "scopes": ["read"],
                }
            }
        )
    )

    # A host-launched runner's environment, from the host's own builder.
    runner_env = connect._build_runner_env(
        {"PATH": os.environ["PATH"], "HOME": str(HOME), "OMNIGENT_HOST_TOKEN": cred("launch")},
        server_url=SERVER,
        runner_id=RUNNER_ID,
        binding_token=cred("runner_binding"),
        workspace=str(HOME),
        parent_pid=1,
        initial_auth_token=cred("runner_initial"),
        host_id=HOST_ID,
        harness="claude-native",
        interactive_shells=["/bin/bash"],
    )
    runner_env["OMNIGENT_HOST_TOKEN"] = creds["launch"]
    runner_env["AWS_SECRET_ACCESS_KEY"] = cred("aws_secret", "slash")
    runner_env["GPG_KEY"] = "7169605F62C751356D054A26A821E680E5FA6305"
    runner_env["SSH_AUTH_SOCK"] = "/tmp/ssh-XXXXq1w2e3/agent.4242"
    runner_env["PWD"] = str(workspace)

    for tool in tools:
        ids[f"tool {tool['name']}"] = tool["name"]
        if isinstance(tool.get("description"), str):
            ids[f"tool {tool['name']} description"] = tool["description"]
    for name, value in headers.items():
        if name != "Authorization":
            ids[f"header {name}"] = value
    claude_bridge = json.loads((bridge / "bridge.json").read_text())
    for key in ("bridge_id", "active_session_id", "conversation_id", "workspace"):
        ids[f"bridge.json {key}"] = claude_bridge[key]
    ids.update(
        {
            "server url": SERVER,
            "slice key (host id)": HOST_ID,
            "runner id": RUNNER_ID,
            "GPG_KEY": runner_env["GPG_KEY"],
            "SSH_AUTH_SOCK": runner_env["SSH_AUTH_SOCK"],
            "codex account_id": "7f9c2e1a-5b3d-4e8f-a6c2-d9f04b1e7a53",
            "codex login_owner_id": "Q2ZvUmM1M0xvZ2luT3duZXJJZGVudGlmaWVyMDAwMDA",
            "codex oauth client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
            "claude rateLimitTier": "default_claude_max_20x",
            "claude device rowPk": "dk_0199c3a47b2e7c1d9f00000000322f",
            "mcp server url": "https://mcp.example.test/sse",
        }
    )
    files = sorted(
        str(p)
        for root in (HOME, TMP)
        for p in root.rglob("*")
        if p.is_file() and not p.is_symlink()
    )
    return {
        "credentials": creds,
        "identifiers": {k: v for k, v in ids.items() if len(v) >= 16},
        "files": files,
        "runner_env": runner_env,
        "home": str(HOME),
        "tmp": str(TMP),
    }


def templates(out: Path) -> None:
    record = write()
    replacements = sorted(
        [(v, f"@@{k}@@") for k, v in record["credentials"].items()]
        + [(record["home"], "/home/omnigent"), (record["tmp"], "/tmp")],
        key=lambda pair: -len(pair[0]),
    )

    def template(text: str) -> str:
        for old, new in replacements:
            text = text.replace(old, new)
        return text

    files = {}
    for src in map(Path, record["files"]):
        rel = (
            f"home/{src.relative_to(HOME)}"
            if src.is_relative_to(HOME)
            else f"tmp/{src.relative_to(TMP)}"
        )
        if src.name in ("owner.pid", "telemetry.json"):
            continue
        files[rel] = template(src.read_text())
    document = {
        "about": (
            "RC-53's collector inputs as a live computer has them, written by "
            "images/computer/tests/rc53_formats.py (Omnigent's own writers at the image's pin). "
            "@@label@@ marks a credential, filled in at run time; everything else must never be "
            "collected."
        ),
        "credentials": {k: credential_shape(v) for k, v in sorted(record["credentials"].items())},
        "files": dict(sorted(files.items())),
        "runner_env": {k: template(v) for k, v in sorted(record["runner_env"].items())},
        "identifiers": {k: template(v) for k, v in sorted(record["identifiers"].items())},
    }
    out.write_text(json.dumps(document, indent=2) + "\n")


def credential_shape(value: str) -> str:
    for shape in ("oat", "ort", "sk", "jwt", "opaque", "slash"):
        probe = credential("x", shape)
        if value.startswith(probe[: probe.index(CANARY)]) and CANARY in value:
            return shape
    return "plain" if value.startswith(CANARY) else "random"


def main() -> int:
    mode, target = sys.argv[1], Path(sys.argv[2])
    if mode == "write":
        target.write_text(json.dumps(write()))
    elif mode == "templates":
        templates(target)
    else:
        raise SystemExit(f"unknown mode {mode}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
