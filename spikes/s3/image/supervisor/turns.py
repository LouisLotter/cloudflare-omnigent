"""Scripted coding turns for Claude Code and Codex, for the bytes-changed-per-turn measurement (AR-25).

Each CLI runs for real, in its own project, against Omnigent's mock LLM (no
account, no internet). The mock answers with a fixed script per turn, shaped
like a coding agent's turn:

1. inspect: a shell command whose output is a few KB, and on every fourth turn
   a test run of about 250 KB;
2. edit: read, then rewrite, one of five source files with about 6 KB of new code;
3. on every third turn, a git commit;
4. a final answer of about 1.5 KB.

So the CLIs write what they really write per turn: transcripts, history,
Codex's SQLite databases, Claude's project state. The edits and the tool output
are synthetic but deterministic, so staging and local runs are comparable.

Runs as the agent user (``python -m supervisor.turns <cli> <n> <canary>``),
printing one JSON line. The first turn creates the session; later turns resume it.
"""

from __future__ import annotations

import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.request

HOME = os.environ.get("HOME", "/home/agent")
MOCK = os.environ.get("S3_MOCK_URL", "http://127.0.0.1:9999")
STATE = os.path.join(HOME, ".cache", "s3-turns.json")  # session ids; ~/.cache is not captured

CLAUDE_MODEL = "claude-s3-mock"
CODEX_MODEL = "codex-s3-mock"
CLAUDE_ENV = {
    "ANTHROPIC_BASE_URL": MOCK,
    "ANTHROPIC_API_KEY": "sk-ant-synthetic-s3-not-a-key",
    "ANTHROPIC_MODEL": CLAUDE_MODEL,
    # Background requests (titles, summaries) go to another model key, so they
    # never take the turn's scripted answers.
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-s3-small",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "DISABLE_AUTOUPDATER": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
}
CODEX_ENV = {"S3_MOCK_KEY": "synthetic-s3-not-a-key"}
CODEX_CONFIG = f"""model = "{CODEX_MODEL}"
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
GIT = ["git", "-c", "user.name=S3 spike", "-c", "user.email=s3-spike@localhost"]
WORDS = ("def class return import from self value result items config error async await for while if "
         "else try except finally with lambda yield none true false request response session runner host "
         "server client payload status state export const function interface type string number").split()


def project(cli: str) -> str:
    return os.path.join(HOME, "work", f"{cli}-project")


def code_text(rng: random.Random, size: int) -> str:
    out: list[str] = []
    n = 0
    while n < size:
        line = " " * (4 * rng.randint(0, 3)) + " ".join(rng.choice(WORDS) for _ in range(rng.randint(3, 11))) + "\n"
        out.append(line)
        n += len(line)
    return "".join(out)[:size]


def ensure_project(cli: str) -> None:
    root = project(cli)
    if os.path.isdir(os.path.join(root, ".git")):
        return
    os.makedirs(os.path.join(root, "src"), exist_ok=True)
    rng = random.Random(cli)
    for i in range(5):
        with open(os.path.join(root, "src", f"mod_{i}.py"), "w") as fh:
            fh.write(code_text(rng, 6000))
    subprocess.run(["git", "init", "-q", root], check=True)
    subprocess.run([*GIT, "-C", root, "add", "-A"], check=True)
    subprocess.run([*GIT, "-C", root, "commit", "-qm", "initial"], check=True)


def script(cli: str, n: int) -> tuple[list[dict[str, object]], dict[str, int]]:
    """The mock's answers for turn n, and the sizes it was built with."""
    rng = random.Random(f"{cli}-{n}")
    root = project(cli)
    target = os.path.join(root, "src", f"mod_{n % 5}.py")
    heavy = n % 4 == 3
    if heavy:
        inspect = ("python3 -c \"import random; r=random.Random(%d); "
                   "[print(f'tests/test_{i%%200}.py::test_case_{i} PASSED [{i*100//4000}%%] {r.random():.6f}') "
                   "for i in range(4000)]\"" % n)
    else:
        inspect = f"cd {root} && git status --short && ls -la src && sed -n 1,80p src/mod_{(n + 1) % 5}.py"
    new_code = code_text(rng, 6000)
    calls: list[dict[str, object]] = []
    if cli == "claude":
        calls.append({"name": "Bash", "arguments": json.dumps({"command": inspect, "description": "inspect"})})
        # Claude Code's Write refuses a file this session has not read.
        calls.append({"name": "Read", "arguments": json.dumps({"file_path": target})})
        calls.append({"name": "Write", "arguments": json.dumps({"file_path": target, "content": new_code})})
        if n % 3 == 2:
            commit = f"cd {root} && {' '.join(GIT)} add -A && {' '.join(GIT)} commit -qm 'turn {n}'"
            calls.append({"name": "Bash", "arguments": json.dumps({"command": commit, "description": "commit"})})
    else:
        write = f"cat > {target} <<'S3EOF'\n{new_code}\nS3EOF"
        calls.append({"name": "exec_command", "arguments": json.dumps({"cmd": inspect})})
        calls.append({"name": "exec_command", "arguments": json.dumps({"cmd": write})})
        if n % 3 == 2:
            commit = f"cd {root} && {' '.join(GIT)} add -A && {' '.join(GIT)} commit -qm 'turn {n}'"
            calls.append({"name": "exec_command", "arguments": json.dumps({"cmd": commit})})
    answers: list[dict[str, object]] = []
    for i, call in enumerate(calls):
        answers.append({"tool_calls": [{**call, "call_id": f"call_{cli}_{n}_{i}"}]})
    answers.append({"text": f"Turn {n} done. " + code_text(rng, 1500)})
    return answers, {"edit_bytes": len(new_code), "heavy_output": int(heavy), "commit": int(n % 3 == 2)}


def configure_mock(cli: str, answers: list[dict[str, object]]) -> None:
    key, tool = (CLAUDE_MODEL, "Bash") if cli == "claude" else (CODEX_MODEL, "exec_command")
    body = json.dumps({"key": key, "required_tools": [tool], "responses": answers}).encode()
    req = urllib.request.Request(MOCK + "/mock/configure", data=body, method="POST")
    req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def load_state() -> dict[str, str]:
    try:
        with open(STATE) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict[str, str]) -> None:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w") as fh:
        json.dump(state, fh)


def run(argv: list[str], env: dict[str, str], cwd: str, timeout: float = 300) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, env={**os.environ, **env}, cwd=cwd, capture_output=True, text=True,
                          timeout=timeout, stdin=subprocess.DEVNULL)


def turn(cli: str, n: int, canary: str) -> dict[str, object]:
    ensure_project(cli)
    state = load_state()
    answers, sizes = script(cli, n)
    configure_mock(cli, answers)
    prompt = f"Turn {n}: continue the refactor of the project."
    if n == 0:
        prompt += f" Remember the code word {canary}-{cli}."
    t0 = time.monotonic()
    out: dict[str, object] = {"cli": cli, "n": n, **sizes}
    if cli == "claude":
        argv = ["claude", "-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"]
        if state.get("claude"):
            argv[2:2] = ["--resume", state["claude"]]
        p = run(argv, CLAUDE_ENV, project(cli))
        out["rc"] = p.returncode
        try:
            res = json.loads(p.stdout)
            state["claude"] = res["session_id"]
            out["num_turns"] = res.get("num_turns")
            out["result"] = str(res.get("result", ""))[:40]
        except (json.JSONDecodeError, KeyError):
            out["stderr"] = (p.stderr or p.stdout)[-500:]
    else:
        os.makedirs(os.path.join(HOME, ".codex"), exist_ok=True)
        cfg = os.path.join(HOME, ".codex", "config.toml")
        if not os.path.exists(cfg):
            with open(cfg, "w") as fh:
                fh.write(CODEX_CONFIG)
        base = ["codex", "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"]
        argv = [*base, "resume", state["codex"], prompt] if state.get("codex") else [*base, prompt]
        p = run(argv, CODEX_ENV, project(cli))
        out["rc"] = p.returncode
        m = re.search(r"session id:\s*([0-9a-f-]{36})", p.stdout + p.stderr)
        if m:
            state["codex"] = m.group(1)
        else:
            out["stderr"] = (p.stderr or p.stdout)[-500:]
    out["s"] = round(time.monotonic() - t0, 2)
    out["session"] = state.get(cli)
    save_state(state)
    return out


def reopen(claude_dir: str, codex_dir: str, canary: str) -> dict[str, object]:
    """Resume both sessions from a restored copy of the CLI homes (VD-09), against the mock.

    Passes when each CLI exits 0 and its resumed request carries the code word
    from turn 0, so the CLI reloaded the conversation from the restored files.
    """
    state = load_state()
    out: dict[str, object] = {}
    reset = urllib.request.Request(MOCK + "/mock/reset", data=b"{}", method="POST")
    reset.add_header("content-type", "application/json")
    urllib.request.urlopen(reset, timeout=10).read()
    question = "What was the code word?"
    if state.get("claude"):
        env = {**CLAUDE_ENV, "CLAUDE_CONFIG_DIR": claude_dir}
        p = run(["claude", "-p", "--resume", state["claude"], question, "--output-format", "json",
                 "--dangerously-skip-permissions"], env, project("claude"))
        out["claude_rc"] = p.returncode
    if state.get("codex"):
        env = {**CODEX_ENV, "CODEX_HOME": codex_dir}
        p = run(["codex", "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
                 "resume", state["codex"], question], env, project("codex"))
        out["codex_rc"] = p.returncode
    with urllib.request.urlopen(MOCK + "/mock/requests", timeout=10) as r:
        reqs = json.loads(r.read())
    reqs = reqs.get("requests", reqs) if isinstance(reqs, dict) else reqs
    texts = [json.dumps(x) for x in reqs]
    out["claude_history"] = any(f"{canary}-claude" in t and question in t for t in texts)
    out["codex_history"] = any(f"{canary}-codex" in t and question in t for t in texts)
    return out


def main() -> int:
    if sys.argv[1] == "reopen":
        print(json.dumps(reopen(sys.argv[2], sys.argv[3], sys.argv[4])))
        return 0
    print(json.dumps(turn(sys.argv[1], int(sys.argv[2]), sys.argv[3])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
