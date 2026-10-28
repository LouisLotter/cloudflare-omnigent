"""What the built image holds, checked inside it.

Exact CLI and Omnigent pins; Codex's managed settings; core change 17's gh wrapper first on
PATH; no GitHub App, Databricks or credential-key variable in the image's environment; no
Omnigent login file anywhere in the image; an empty home; the supervisor on the image's own
Python with the standard library only; tini as the entrypoint.
"""

from __future__ import annotations

import ast
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _run(*argv: str) -> str:
    return subprocess.run(argv, capture_output=True, text=True, check=True).stdout


def test_pinned_versions() -> None:
    # The real CLIs (the test variant puts its fakes first on PATH).
    assert _run("/usr/local/bin/claude", "--version").split()[0] == "2.1.311"
    assert _run("/usr/local/bin/codex", "--version").strip().splitlines()[-1] == "codex-cli 0.164.0"
    assert "0.19.0.dev0" in _run("/opt/venv/bin/omnigent", "--version")
    assert _run("/usr/local/bin/gh", "--version").split()[2] == "2.103.3"
    assert _run("/usr/local/bin/ttyd", "--version").split()[2].startswith("1.7.7")
    assert Path("/usr/local/bin/sandbox-shim").exists()
    assert Path("/usr/bin/tini").exists()


def test_gh_goes_through_the_broker_wrapper() -> None:
    path = os.environ["PATH"].split(":")
    found = [p for p in path if Path(p, "gh").exists()]
    assert found[0] == "/opt/venv/bin", found
    assert "credential_broker import gh_main" in Path("/opt/venv/bin/gh").read_text()
    # Login shells keep the venv first too (Debian's /etc/profile resets PATH).
    out = _run("bash", "-lc", "command -v gh")
    assert out.strip() == "/opt/venv/bin/gh"


def test_codex_managed_settings() -> None:
    text = Path("/etc/codex/managed_config.toml").read_text()
    for line in (
        'cli_auth_credentials_store = "file"',
        "check_for_update_on_startup = false",
        "enabled = false",
    ):
        assert line in text


def test_claude_code_managed_settings() -> None:
    """WP3.22: the renderer is named, so 2.1.311's fullscreen upsell never blocks a driven
    terminal; root's and read-only to everyone else, so no settings file overrides it."""
    path = Path("/etc/claude-code/managed-settings.json")
    st = path.stat()
    assert (st.st_uid, st.st_gid, st.st_mode & 0o7777) == (0, 0, 0o644)
    assert (Path("/etc/claude-code").stat().st_mode & 0o7777) == 0o755
    assert json.loads(path.read_text()) == {"tui": "default"}
    # The person's account, which Claude Code runs as, can read it.
    read = ["runuser", "-u", "omnigent", "--", "cat", str(path)]
    assert json.loads(subprocess.run(read, capture_output=True, check=True).stdout) == {
        "tui": "default"
    }


def test_runners_get_the_cli_settings_from_omnigents_own_host_env_builder(tmp_path: Path) -> None:
    """WP3.22: the environment the supervisor gives ``omnigent host``, through the host's own
    ``_build_runner_env`` (the fork's allowlist), still holds the CLIs' settings."""
    from cfo_computer.host import StartParams, host_env
    from cfo_computer.procutil import CLI_ENV, workload_env

    env = host_env(workload_env(tmp_path, "omnigent"), StartParams(1, "h" * 32, "c", "t", {}))
    script = (
        "import json, sys\n"
        "from omnigent.host.connect import _build_runner_env\n"
        "base = json.load(sys.stdin)\n"
        "print(json.dumps(_build_runner_env(base, server_url='http://omnigent.internal', "
        "runner_id='runner_1', binding_token='b', workspace=base['HOME'], parent_pid=1)))\n"
    )
    out = subprocess.run(
        ["/opt/venv/bin/python", "-I", "-c", script],
        input=json.dumps(env),
        capture_output=True,
        text=True,
        check=True,
        env={**env, "HOME": str(tmp_path)},
    ).stdout
    runner = json.loads(out.strip().splitlines()[-1])
    assert {k: runner.get(k) for k in CLI_ENV} == CLI_ENV


def test_environment_and_account() -> None:
    env = os.environ
    assert env["IS_SANDBOX"] == "1"
    banned = (
        "OMNIGENT_GITHUB_APP",
        "OMNIGENT_DATABRICKS",
        "DATABRICKS_",
        "OMNIGENT_CREDENTIAL",
        "VAULT_",
        "GIT_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
    )
    assert not [k for k in env if k.startswith(banned)]
    assert _run("id", "-u", "omnigent").strip() == "1000"
    home = Path("/home/omnigent")
    assert sorted(p.name for p in home.iterdir()) == [".bashrc", ".profile"]
    assert _run("sudo", "-n", "-u", "omnigent", "sudo", "-n", "true") == ""


def test_no_omnigent_login_file_anywhere() -> None:
    found = []
    for top in ("/",):
        for dirpath, dirnames, filenames in os.walk(top):
            if dirpath.startswith(("/proc", "/sys", "/dev", "/tmp")):
                dirnames[:] = []
                continue
            for name in filenames:
                if name in ("auth_tokens.json", ".credentials.json", "auth.json", "hosts.yml"):
                    found.append(os.path.join(dirpath, name))
    # Packages may ship test data named like a login file; none may be in a home or config.
    assert [f for f in found if f.startswith(("/root", "/home", "/etc", "/var"))] == []


def test_supervisor_uses_the_standard_library_only() -> None:
    pkg = Path("/usr/local/lib/python3.12/site-packages/cfo_computer")
    stdlib = set(sys.stdlib_module_names)
    for source in pkg.glob("*.py"):
        tree = ast.parse(source.read_text())
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names = [node.module or ""]
            for name in names:
                assert name.split(".")[0] in stdlib, (source.name, name)


def test_the_contract_assets_and_tools() -> None:
    assert Path("/opt/cfo/contracts/schema/WorkspaceCommand.schema.json").exists()
    policy = json.loads(Path("/opt/cfo/contracts/checkpoint-policy-v1.json").read_text())
    assert policy["format"] == "cfo.checkpoint-policy" and policy["version"] == 1
    assert shutil.which("setpriv") and shutil.which("ss")
