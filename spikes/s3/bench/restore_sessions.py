"""Criterion 5: restored Claude Code and Codex sessions reopen.

No real account. Both CLIs talk to Omnigent's mock LLM with synthetic keys
(supervisor/cli_sessions.py), which records every request it receives.

1. computer: create one Claude Code and one Codex session that each hold a
   runtime canary word. Plant decoy credential files holding another canary.
2. Capture under the pause lease, upload, publish.
3. Stop computer (the container is lost). Start computer2 from the same image
   with an empty home; its supervisor restores the published checkpoint
   before anything else runs.
4. computer2: `claude -p --resume <id>` and `codex exec resume <id>`. Pass if
   both exit 0 and the mock received the earlier turn's canary in the resumed
   request (the CLI reloaded the conversation from the restored files).
5. Controls: the decoy credential files and their canary are absent after
   restore; a fresh container without the restore cannot resume.

  python3 spikes/s3/bench/restore_sessions.py [--runs 3]
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
from typing import Any

from common import MOCK, ROOT, SUP2, as_agent, compose, docker, http, save, sup, wait_for
from upload_tests import job, job_result

PY = "/opt/venv/bin/python"
S3ENV = {"PYTHONPATH": "/opt/s3"}


def mock_requests() -> list[dict[str, Any]]:
    code, out = http("GET", MOCK + "/mock/requests")
    return out.get("requests", out) if isinstance(out, dict) else out


def scan_archive(key: str, canary: str) -> dict[str, Any]:
    """Run the repository's canary scanner on the uploaded checkpoint object.

    Exit 0 means clean. A positive control scans the live credential file,
    which must be found (exit 1).
    """
    got = sup("/fetch", {"key": key, "dest": "ckpt.tar.zst"})
    local = "/tmp/cfo-s3-ckpt.tar.zst"
    docker("cp", f"cfo-s3-computer-1:{got['path']}", local)
    env = {**os.environ, "CFO_CANARY_VALUES": canary}
    clean = subprocess.run(["node", "scripts/canary-scan.ts", local], cwd=ROOT, env=env, capture_output=True, text=True)
    as_agent(["bash", "-c", "cp ~/.claude/.credentials.json /tmp/control-cred.json"])
    docker("cp", "cfo-s3-computer-1:/tmp/control-cred.json", "/tmp/cfo-s3-control-cred.json")
    control = subprocess.run(["node", "scripts/canary-scan.ts", "/tmp/cfo-s3-control-cred.json"], cwd=ROOT, env=env,
                             capture_output=True, text=True)
    os.remove(local)
    os.remove("/tmp/cfo-s3-control-cred.json")
    # The scanner never prints a full canary value, so its report is safe to keep.
    return {"archive_bytes": got["size"], "archive_scan_exit": clean.returncode,
            "archive_scan_report": (clean.stdout + clean.stderr)[-800:],
            "control_scan_exit": control.returncode}


def one_run(run: int) -> dict[str, Any]:
    canary = f"S3CANARY{secrets.token_hex(4).upper()}"
    # Built at run time with the canary scanner's prefix (scripts/canary-scan.ts),
    # so the repository's own RC-22 scanner can look for it in the checkpoint.
    cred_canary = "CFO_" + "CANARY_" + "S3CRED" + secrets.token_hex(6).upper()
    compose("up", "-d", "computer")
    wait_for(lambda: sup("/health", timeout=3), 120, what="computer")
    as_agent(["bash", "-c", "rm -rf ~/work/cli-project ~/.codex ~/.claude"])
    made = json.loads(as_agent([PY, "-m", "supervisor.cli_sessions", "create", canary], env_extra=S3ENV, timeout=300)["stdout"])
    assert made.get("claude_session") and made.get("codex_session"), made
    as_agent(["bash", "-c",
              f"echo '{{\"synthetic\":\"{cred_canary}\"}}' > ~/.claude/.credentials.json && "
              f"echo '{{\"synthetic\":\"{cred_canary}\"}}' > ~/.codex/auth.json"])
    cap = sup("/capture", {"method": "rsync", "budget_s": 20})
    assert cap["outcome"] == "snapshot_ready", cap
    up = job_result(job({"snapshot_dir": cap["snapshot_dir"], "capture_id": cap["capture_id"]}), 600)["result"]
    assert up["published"], up
    scan = scan_archive(up["key"], cred_canary)

    # The computer is lost; a new one restores the checkpoint.
    compose("stop", "computer")
    compose("--profile", "restore", "up", "-d", "--force-recreate", "computer2")
    wait_for(lambda: sup("/health", base=SUP2, timeout=3), 180, what="computer2")
    restore = json.loads(sup("/exec", {"argv": ["cat", "/var/log/s3/restore.json"], "timeout": 10}, base=SUP2)["stdout"])
    creds = as_agent(["bash", "-c", "ls -a ~/.claude/.credentials.json ~/.codex/auth.json 2>&1; "
                      f"grep -rl {cred_canary} ~ 2>/dev/null | head -5; echo done"], base=SUP2)
    http("POST", MOCK + "/mock/reset")
    reopened = json.loads(as_agent([PY, "-m", "supervisor.cli_sessions", "reopen", made["claude_session"], made["codex_session"]],
                                   env_extra=S3ENV, timeout=300, base=SUP2)["stdout"])
    reqs = mock_requests()
    claude_reqs = [json.dumps(r) for r in reqs if "claude-s3-mock" in json.dumps(r)[:20000]]
    codex_reqs = [json.dumps(r) for r in reqs if "codex-s3-mock" in json.dumps(r)[:20000]]
    claude_history = any(f"{canary}-claude" in r and "What was the code word" in r for r in claude_reqs)
    codex_history = any(f"{canary}-codex" in r and "What was the code word" in r for r in codex_reqs)

    # Control: a fresh container that skipped the restore cannot resume.
    control = docker("run", "--rm", "--network", "cfo-s3_default", "-u", "agent", "-e", "HOME=/home/agent",
                     "-e", "CLAUDE_CONFIG_DIR=/home/agent/.claude", "-e", "PYTHONPATH=/opt/s3",
                     "--entrypoint", PY, "cfo-s3-computer:spike", "-m", "supervisor.cli_sessions", "reopen",
                     made["claude_session"], made["codex_session"], check=False)
    control_res = json.loads(control.strip().splitlines()[-1])
    compose("--profile", "restore", "stop", "computer2")
    row = {
        "run": run,
        "restore": restore,
        "claude": {"rc": reopened["claude_rc"], "history_in_resumed_request": claude_history,
                   "requests": len(claude_reqs), "out": reopened["claude_out"][-200:]},
        "codex": {"rc": reopened["codex_rc"], "history_in_resumed_request": codex_history,
                  "requests": len(codex_reqs), "out": reopened["codex_out"][-200:]},
        "credential_files_after_restore": creds["stdout"].strip().splitlines(),
        "control_without_restore": {"claude_rc": control_res["claude_rc"], "codex_rc": control_res["codex_rc"],
                                    "claude_out": control_res["claude_out"][-160:], "codex_out": control_res["codex_out"][-160:]},
        "checkpoint_files": [f for f in made["files"] if "/skills/" not in f],
        "canary_scan_of_uploaded_checkpoint": scan,
    }
    print(json.dumps({k: row[k] for k in ("run", "claude", "codex", "credential_files_after_restore")}))
    return row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()
    rows = [one_run(i + 1) for i in range(args.runs)]
    compose("up", "-d", "computer")
    summary = {
        "runs": len(rows),
        "claude_reopened": sum(1 for r in rows if r["claude"]["rc"] == 0 and r["claude"]["history_in_resumed_request"]),
        "codex_reopened": sum(1 for r in rows if r["codex"]["rc"] == 0 and r["codex"]["history_in_resumed_request"]),
        "controls_failed_to_resume": sum(1 for r in rows if r["control_without_restore"]["claude_rc"] != 0 and r["control_without_restore"]["codex_rc"] != 0),
        "restore_s": [r["restore"].get("restore_s") for r in rows],
        "archive_canary_scan_exits": [r["canary_scan_of_uploaded_checkpoint"]["archive_scan_exit"] for r in rows],
        "control_canary_scan_exits": [r["canary_scan_of_uploaded_checkpoint"]["control_scan_exit"] for r in rows],
    }
    print(json.dumps(summary, indent=1))
    save("restore-sessions", {"summary": summary, "rows": rows})


if __name__ == "__main__":
    main()
