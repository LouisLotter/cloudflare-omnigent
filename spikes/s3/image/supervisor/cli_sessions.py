"""Create and reopen Claude Code and Codex sessions against the mock LLM.

Runs as the agent user inside a computer container. No real account: Claude
Code uses ANTHROPIC_BASE_URL + a synthetic API key, Codex a custom model
provider with a synthetic key, both pointed at Omnigent's mock LLM.

  python -m supervisor.cli_sessions create <canary>   -> JSON with session ids
  python -m supervisor.cli_sessions reopen <claude_id> <codex_id>
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

HOME = os.environ.get("HOME", "/home/agent")
PROJ = os.path.join(HOME, "work", "cli-project")
MOCK = os.environ.get("S3_MOCK_URL", "http://mockllm:9999")

CLAUDE_ENV = {
    "ANTHROPIC_BASE_URL": MOCK,
    "ANTHROPIC_API_KEY": "sk-ant-synthetic-s3-not-a-key",
    "ANTHROPIC_MODEL": "claude-s3-mock",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-s3-mock",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "DISABLE_AUTOUPDATER": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
}
CODEX_ENV = {"S3_MOCK_KEY": "synthetic-s3-not-a-key"}
CODEX_CONFIG = f"""model = "codex-s3-mock"
model_provider = "s3mock"
check_for_update_on_startup = false

[model_providers.s3mock]
name = "S3 mock"
base_url = "{MOCK}/v1"
env_key = "S3_MOCK_KEY"
wire_api = "responses"

[analytics]
enabled = false
"""


def run(argv: list[str], env: dict[str, str], timeout: float = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, env={**os.environ, **env}, cwd=PROJ, capture_output=True, text=True,
                          timeout=timeout, stdin=subprocess.DEVNULL)


def codex_config() -> None:
    os.makedirs(os.path.join(HOME, ".codex"), exist_ok=True)
    with open(os.path.join(HOME, ".codex", "config.toml"), "w") as fh:
        fh.write(CODEX_CONFIG)


def create(canary: str) -> dict[str, object]:
    os.makedirs(PROJ, exist_ok=True)
    codex_config()
    out: dict[str, object] = {}
    c = run(["claude", "-p", f"Remember the code word {canary}-claude. Reply OK.", "--output-format", "json"], CLAUDE_ENV)
    out["claude_rc"] = c.returncode
    try:
        out["claude_session"] = json.loads(c.stdout)["session_id"]
    except (json.JSONDecodeError, KeyError):
        out["claude_stdout"] = c.stdout[-1500:]
        out["claude_stderr"] = c.stderr[-1500:]
    x = run(["codex", "exec", "--skip-git-repo-check", f"Remember the code word {canary}-codex. Reply OK."], CODEX_ENV)
    out["codex_rc"] = x.returncode
    m = re.search(r"session id:\s*([0-9a-f-]{36})", x.stdout + x.stderr)
    if m:
        out["codex_session"] = m.group(1)
    else:
        out["codex_stdout"] = x.stdout[-1500:]
        out["codex_stderr"] = x.stderr[-1500:]
    out["files"] = listing()
    return out


def reopen(claude_id: str, codex_id: str) -> dict[str, object]:
    os.makedirs(PROJ, exist_ok=True)
    out: dict[str, object] = {}
    c = run(["claude", "-p", "--resume", claude_id, "What was the code word?", "--output-format", "json"], CLAUDE_ENV)
    out["claude_rc"] = c.returncode
    out["claude_out"] = (c.stdout or c.stderr)[-600:]
    x = run(["codex", "exec", "--skip-git-repo-check", "resume", codex_id, "What was the code word?"], CODEX_ENV)
    out["codex_rc"] = x.returncode
    out["codex_out"] = (x.stdout + x.stderr)[-600:]
    return out


def listing() -> list[str]:
    files = []
    for root in (os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(HOME, ".claude")), os.path.join(HOME, ".codex")):
        for dp, _dn, fns in os.walk(root):
            for f in fns:
                files.append(os.path.relpath(os.path.join(dp, f), HOME))
    return sorted(files)


def main() -> None:
    if sys.argv[1] == "create":
        print(json.dumps(create(sys.argv[2])))
    elif sys.argv[1] == "reopen":
        print(json.dumps(reopen(sys.argv[2], sys.argv[3])))
    elif sys.argv[1] == "list":
        print(json.dumps(listing()))


if __name__ == "__main__":
    main()
