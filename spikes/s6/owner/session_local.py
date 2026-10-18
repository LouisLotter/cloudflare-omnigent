"""Spike S6 owner session, on the laptop with Docker: real Claude and ChatGPT sign-in in a
container, credential checkpoints in MinIO, restores in both orders, sign-out and tombstones.

Needs the owner at the keyboard for two sign-ins. Everything else is automatic. Run from the
repository root:

  python3 -I spikes/s6/owner/session_local.py            # the whole session (about 15 minutes)
  python3 -I spikes/s6/owner/session_local.py --cleanup  # sign out and remove everything

Safety:
- One computer container at a time. Each is removed, and its removal confirmed, before the next
  starts, so two containers never hold the same login.
- MinIO keeps its data in memory (tmpfs); the controller database lives in /dev/shm. Both are
  removed at the end. Nothing that holds a login is written to the repository.
- Results under spikes/s6/results/owner-session/ are masked; a leak check run inside the
  computer, while signed in, confirms that no results file holds a login value.
- The session ends signed out of both accounts (`claude auth logout`, `codex logout`, both
  revoke on the provider side), with the sign-out checked in a fresh container.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

S6 = Path(__file__).resolve().parents[1]
REPO = S6.parents[1]
IMAGE = os.environ.get("S6_IMAGE", "cfo-s6-computer:dev")
MINIO_IMAGE = "pgsty/minio@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372"
NET = "cfo-s6-owner-net"
MINIO = "cfo-s6-owner-minio"
PREFIX = "cfo-s6-owner-pc"
SHM = Path("/dev/shm/cfo-s6-owner")
OUT = S6 / "results" / "owner-session"
FAKE = False  # --fake: a dry run of the whole session with the fake CLIs, no real accounts


def sh(*args: str, check: bool = True, capture: bool = True) -> str:
    r = subprocess.run(list(args), capture_output=capture, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"command failed ({r.returncode}): {' '.join(args[:4])} ...\n{(r.stderr or '')[-400:]}")
    return (r.stdout or "").strip() if capture else ""


def record(step: str, **kw) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "session-log.jsonl", "a") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "step": step, **kw}) + "\n")


def say(text: str) -> None:
    print(f"\n=== {text}", flush=True)


def pause(text: str) -> None:
    if not FAKE:
        input(f"\n>>> {text}\n    Press Enter to continue... ")


def running_computers() -> list[str]:
    out = sh("docker", "ps", "-a", "--filter", f"name=^{PREFIX}", "--format", "{{.Names}}", check=False)
    return [x for x in out.splitlines() if x]


def inner(name: str, *args: str, interactive: bool = False) -> str:
    if interactive:
        subprocess.run(["docker", "exec", *([] if FAKE else ["-it"]), name, *args])
        return ""
    r = subprocess.run(["docker", "exec", name, "bash", "/opt/s6/owner/inner.sh", *args], capture_output=True, text=True)
    text = (r.stdout or "").strip()
    print("   " + text.replace("\n", "\n   "))
    return text


def start_computer(letter: str, s3: dict) -> str:
    existing = running_computers()
    if existing:
        raise SystemExit(f"refusing to start a second computer while {existing} exists")
    name = f"{PREFIX}-{letter}"
    fake_env = ["-e", "S6_FAKE=1", "-e", "S6_FAKE_PROVIDER=/ctl/fake-provider.json",
                "-e", "PATH=/opt/s6/fakes/bin:/opt/venv/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"] if FAKE else []
    sh("docker", "run", "-d", "--name", name, "--network", NET, *fake_env,
       "-e", f"S6_S3_ENDPOINT=http://{MINIO}:9000", "-e", "S6_S3_BUCKET=s6-owner",
       "-e", f"S6_S3_ACCESS_KEY={s3['user']}", "-e", f"S6_S3_SECRET_KEY={s3['password']}",
       "-v", f"{SHM}:/ctl", "-v", f"{OUT}:/out", IMAGE)
    inner(name, "start-generation")
    record("computer-started", computer=name)
    return name


def stop_computer(name: str) -> None:
    sh("docker", "rm", "-f", name)
    gone = name not in running_computers()
    print(f"   {name} removed: {gone}")
    record("computer-removed", computer=name, confirmed_gone=gone)
    if not gone:
        raise SystemExit("container still present; stopping the session")


def cleanup() -> None:
    say("Cleanup: sign out in any running computer, then remove everything")
    for name in running_computers():
        subprocess.run(["docker", "exec", name, "bash", "-c", "claude auth logout; codex logout"], capture_output=True)
        sh("docker", "rm", "-f", name, check=False)
    sh("docker", "rm", "-f", MINIO, check=False)
    sh("docker", "network", "rm", NET, check=False)
    shutil.rmtree(SHM, ignore_errors=True)
    if OUT.exists():  # results were written by root in the container; hand them back
        sh("docker", "run", "--rm", "-v", f"{OUT}:/out", "--entrypoint", "chown", IMAGE, "-R",
           f"{os.getuid()}:{os.getgid()}", "/out", check=False)
    left = {"computers": running_computers(), "minio": bool(sh("docker", "ps", "-aq", "--filter", f"name=^{MINIO}$", check=False)),
            "network": bool(sh("docker", "network", "ls", "-q", "--filter", f"name=^{NET}$", check=False)), "shm": SHM.exists()}
    print(f"   left behind: {left}")
    record("cleanup", left_behind=left)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cleanup", action="store_true")
    ap.add_argument("--fake", action="store_true", help="dry run with the fake CLIs")
    a = ap.parse_args()
    global FAKE, OUT
    if a.fake:
        FAKE = True
        OUT = S6 / "results" / "owner-session-fake-dryrun"
    if a.cleanup:
        cleanup()
        return 0
    if running_computers():
        raise SystemExit("a previous session is still present; run with --cleanup first")

    OUT.mkdir(parents=True, exist_ok=True)
    revision = sh("git", "-C", str(REPO), "rev-parse", "HEAD", check=False)
    dirty = bool(sh("git", "-C", str(REPO), "status", "--porcelain", "--", "spikes/s6", check=False))
    image_id = sh("docker", "image", "inspect", IMAGE, "--format", "{{.Id}}")
    record("session-start", revision=revision, spike_tree_dirty=dirty, image=IMAGE, image_id=image_id,
           mode="fake CLIs (dry run)" if FAKE else "real accounts",
           approval=None if FAKE else "standing owner approval for real-account S6 runs (AGENTS.md, 18 Oct 2026)")

    say("Preparing: network, MinIO in memory, controller database in /dev/shm")
    SHM.mkdir(mode=0o700, parents=True, exist_ok=True)
    s3 = {"user": "s6owner", "password": secrets.token_hex(16)}  # local, in-memory MinIO only
    sh("docker", "network", "create", NET)
    sh("docker", "run", "-d", "--name", MINIO, "--network", NET, "--tmpfs", "/data:rw,size=256m",
       "-e", f"MINIO_ROOT_USER={s3['user']}", "-e", f"MINIO_ROOT_PASSWORD={s3['password']}", MINIO_IMAGE, "server", "/data")
    time.sleep(3)
    sh("docker", "run", "--rm", "--network", NET, "-e", f"S6_S3_ENDPOINT=http://{MINIO}:9000",
       "-e", "S6_S3_BUCKET=s6-owner", "-e", f"S6_S3_ACCESS_KEY={s3['user']}", "-e", f"S6_S3_SECRET_KEY={s3['password']}",
       "--entrypoint", "python3", IMAGE, "-I", "-c",
       "import sys; sys.path.insert(0,'/opt/s6/credsync'); from objstore import S3Store; S3Store.from_env().create_bucket()")

    try:
        # ---------------------------------------------------------------- computer A: sign in
        a_name = start_computer("a", s3)
        versions = sh("docker", "exec", a_name, "bash", "-c", "claude --version; codex --version; omnigent --version | tail -1")
        record("versions", versions=versions.splitlines())
        inner(a_name, "audit", "A fresh")

        say("Sign in to Claude (owner)")
        print("   Claude Code prints a link. Open it in your browser, sign in with your Claude account,\n"
              "   then copy the code the page shows and paste it at 'Paste code here if prompted'.")
        inner(a_name, "claude", "auth", "login", "--claudeai", interactive=True)
        record("claude-sign-in", status=inner(a_name, "claude-status"))

        say("Sign in to ChatGPT for Codex (owner)")
        print("   Device-code login must be enabled first: ChatGPT > Settings > Security.\n"
              "   Codex prints a link and a one-time code. Open the link, sign in, enter the code.")
        inner(a_name, "codex", "login", "--device-auth", interactive=True)
        record("codex-sign-in", status=inner(a_name, "codex-status"))

        say("Audit after sign-in (masked)")
        inner(a_name, "audit", "A after sign-in")
        inner(a_name, "copies", "A after sign-in")
        inner(a_name, "lifetimes", "A after sign-in")

        say("One small request each, to prove the logins work and create continuation state")
        inner(a_name, "claude-ask")
        inner(a_name, "codex-ask")

        say("Checkpoints right after sign-in: workspace W1, credentials C1; start the watcher")
        inner(a_name, "capture", "workspace")
        inner(a_name, "capture", "credential")
        inner(a_name, "watch-start")

        say("Force a refresh of each login, and watch the credential checkpoints follow")
        inner(a_name, "claude-force-refresh")
        inner(a_name, "codex-force-refresh")
        time.sleep(3)
        inner(a_name, "audit", "A after refresh")
        inner(a_name, "copies", "A after refresh")
        inner(a_name, "lifetimes", "A after refresh")
        inner(a_name, "leak-check", "A")
        inner(a_name, "watch-stop")
        stop_computer(a_name)

        # ------------------------------------- computer B: older workspace, newer credentials
        say("Computer B: restore W1 (older workspace) with C2 (newer credentials)")
        b_name = start_computer("b", s3)
        inner(b_name, "restore")
        inner(b_name, "audit", "B after restore")
        record("b-status", claude=inner(b_name, "claude-status"), codex=inner(b_name, "codex-status"))
        inner(b_name, "claude-ask")
        inner(b_name, "codex-ask")
        inner(b_name, "watch-start")
        inner(b_name, "capture", "workspace")  # W2: newer than the credential checkpoint
        time.sleep(2)
        inner(b_name, "watch-stop")
        stop_computer(b_name)

        # ---------------------------- computer C: newer workspace, older credentials; sign out
        say("Computer C: restore W2 (newer workspace) with the latest credentials, then sign out")
        c_name = start_computer("c", s3)
        inner(c_name, "restore")
        inner(c_name, "audit", "C after restore")
        record("c-status", claude=inner(c_name, "claude-status"), codex=inner(c_name, "codex-status"))
        inner(c_name, "codex-ask")
        inner(c_name, "leak-check", "C")
        inner(c_name, "watch-start")
        say("Signing out of both accounts")
        subprocess.run(["docker", "exec", c_name, "claude", "auth", "logout"])
        subprocess.run(["docker", "exec", c_name, "codex", "logout"])
        time.sleep(3)
        inner(c_name, "watch-stop")
        inner(c_name, "capture", "credential")  # the design also checkpoints right after a logout
        inner(c_name, "audit", "C after sign-out")
        record("c-signed-out", claude=inner(c_name, "claude-status"), codex=inner(c_name, "codex-status"))
        stop_computer(c_name)

        # ------------------------------------------- computer D: tombstones hold after restore
        say("Computer D: restore the latest checkpoints; the logins must stay signed out")
        d_name = start_computer("d", s3)
        inner(d_name, "restore")
        inner(d_name, "audit", "D after restore")
        record("d-status", claude=inner(d_name, "claude-status"), codex=inner(d_name, "codex-status"))
        stop_computer(d_name)
    except BaseException as e:
        record("session-error", error=type(e).__name__)
        print(f"\nThe session stopped ({type(e).__name__}). Cleaning up, which signs out first.")
        cleanup()
        raise
    cleanup()
    say(f"Done. Masked results: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
