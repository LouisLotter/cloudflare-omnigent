"""Spike S6 owner session, on the laptop with Docker: real Claude and ChatGPT sign-in in a
container, credential checkpoints in MinIO, restores in both orders, sign-out and tombstones.
The fallback for the staging page (spikes/s6/staging), with the same steps.

Needs the owner at the keyboard for two sign-ins. Everything else is automatic. Run from the
repository root:

  python3 -I spikes/s6/owner/session_local.py            # the whole session (about 15 minutes)
  python3 -I spikes/s6/owner/session_local.py --fake     # dry run with the fake CLIs
  python3 -I spikes/s6/owner/session_local.py --cleanup  # sign out, verify, remove everything

Safety:
- One computer container at a time. Each is removed, and its removal confirmed, before the next
  starts, so two containers never hold the same login.
- Every step's result is checked; the first failure stops the session, which then signs out,
  verifies the sign-out in a fresh computer, and removes everything (cleanup).
- The credential watcher starts right after each restore, before any CLI runs, and every
  computer ends with a final credential checkpoint, so no refreshed login is left behind.
- MinIO keeps its data in memory (tmpfs); the controller database and MinIO's local password live
  in /dev/shm. All are removed at the end. Nothing that holds a login goes into the repository.
- Results under spikes/s6/results/owner-session/ are masked; a leak check run inside the
  computer, while signed in, confirms that no results file holds a login value.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import signal
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


class StepFailed(Exception):
    pass


def sh(*args: str, check: bool = True) -> str:
    r = subprocess.run(list(args), capture_output=True, text=True)
    if check and r.returncode != 0:
        raise StepFailed(f"command failed ({r.returncode}): {' '.join(args[:3])} ...")
    return (r.stdout or "").strip()


def record(step: str, **kw) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "session-log.jsonl", "a") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "step": step, **kw}) + "\n")


def say(text: str) -> None:
    print(f"\n=== {text}", flush=True)


class LookupFailed(StepFailed):
    """Docker could not answer: the state is unknown, which is never the same as "absent"."""


def lookup(*args: str) -> str:
    r = subprocess.run(list(args), capture_output=True, text=True)
    if r.returncode != 0:
        raise LookupFailed(f"lookup failed ({r.returncode}): {' '.join(args[:3])} ...")
    return (r.stdout or "").strip()


def computers() -> list[str]:
    out = lookup("docker", "ps", "-a", "--filter", f"name=^{PREFIX}", "--format", "{{.Names}}")
    return [x for x in out.splitlines() if x]


def store_state() -> str:
    """'running', 'stopped' or 'absent'; raises LookupFailed when Docker cannot tell."""
    if lookup("docker", "ps", "-q", "--filter", f"name=^{MINIO}$"):
        return "running"
    return "stopped" if lookup("docker", "ps", "-aq", "--filter", f"name=^{MINIO}$") else "absent"


# The session's durable marker, in the results directory (no secrets): the positive evidence of
# how far the session got. "started" is written before anything else, "signin-attempted" before
# the first sign-in command runs, and "signed-out-verified" or "closed-never-signed-in" at the end.
def state_file() -> Path:
    return OUT / "session-state.json"


def write_state(phase: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = state_file().with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump({"phase": phase, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, state_file())


def read_state() -> str | None:
    """The marker's phase; None when there is no marker; 'unreadable' when it cannot be read."""
    try:
        return json.loads(state_file().read_text())["phase"]
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError):
        return "unreadable"


def wait_until_no_computer(timeout_s: float = 90) -> bool:
    """A removal interrupted on the client side still completes in the daemon: wait for it."""
    deadline = time.time() + timeout_s
    while computers() and time.time() < deadline:
        for name in computers():
            sh("docker", "rm", "-f", name, check=False)
        time.sleep(2)
    return not computers()


def inner(name: str, *args: str, must: bool = True) -> tuple[int, str]:
    """Run one masked inner.sh action; with must=True a non-zero exit stops the session."""
    r = subprocess.run(["docker", "exec", name, "bash", "/opt/s6/owner/inner.sh", *args], capture_output=True, text=True)
    text = (r.stdout or "").strip()
    print(f"   [{args[0]}] exit {r.returncode}: " + text.replace("\n", "\n      "), flush=True)
    record("inner", computer=name, action=args[0], exit=r.returncode)
    if must and r.returncode != 0:
        raise StepFailed(f"{args[0]} failed in {name}")
    return r.returncode, text


def sign_in(name: str, *cmd: str) -> None:
    rc = subprocess.run(["docker", "exec", *([] if FAKE else ["-it"]), name, *cmd]).returncode
    record("sign-in", computer=name, command=cmd[0], exit=rc)
    if rc != 0:
        raise StepFailed(f"{cmd[0]} sign-in failed")


def s3_env(s3: dict) -> list[str]:
    return ["-e", f"S6_S3_ENDPOINT=http://{MINIO}:9000", "-e", "S6_S3_BUCKET=s6-owner",
            "-e", f"S6_S3_ACCESS_KEY={s3['user']}", "-e", f"S6_S3_SECRET_KEY={s3['password']}"]


def start_computer(letter: str, s3: dict) -> str:
    existing = computers()
    if existing:
        raise StepFailed(f"refusing to start a second computer while {existing} exists")
    name = f"{PREFIX}-{letter}"
    fake_env = ["-e", "S6_FAKE=1", "-e", "S6_FAKE_PROVIDER=/ctl/fake-provider.json",
                "-e", "PATH=/opt/s6/fakes/bin:/opt/venv/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"] if FAKE else []
    sh("docker", "run", "-d", "--name", name, "--network", NET, *fake_env, *s3_env(s3),
       "-v", f"{SHM}:/ctl", "-v", f"{OUT}:/out", IMAGE)
    inner(name, "start-generation")
    record("computer-started", computer=name)
    # Workspace first, then credentials; only after this may credentials be captured.
    inner(name, "restore")
    return name


def stop_computer(name: str, final_capture: bool = True) -> None:
    if final_capture:
        inner(name, "watch-stop", must=False)
        inner(name, "capture", "credential")  # nothing refreshed is left behind
    sh("docker", "rm", "-f", name)
    gone = name not in computers()
    print(f"   {name} removed: {gone}")
    record("computer-removed", computer=name, confirmed_gone=gone)
    if not gone:
        raise StepFailed("container still present")


def is_running(name: str) -> bool:
    """Whether a computer runs. One being removed (an interrupted removal) counts as gone."""
    for _ in range(15):
        try:
            return lookup("docker", "inspect", "-f", "{{.State.Running}}", name) == "true"
        except LookupFailed:
            if name not in computers():
                return False
            time.sleep(2)
    raise LookupFailed(f"cannot tell whether {name} runs")


def read_store_config() -> dict:
    try:
        cfg = json.loads((SHM / "s3.json").read_text())
        if not (isinstance(cfg, dict) and cfg.get("user") and cfg.get("password")):
            raise ValueError("incomplete")
        return cfg
    except (OSError, ValueError) as e:
        raise StepFailed(f"the store configuration is missing or unreadable ({type(e).__name__})") from None


def cleanup() -> dict:
    """Sign out, and verify it in a fresh computer, before anything that could retry is removed.

    The outcome is "verified" only on positive evidence:
    - the session's marker shows it never reached a sign-in; or
    - the latest checkpoints, restored into a fresh computer, are signed out, after signing out
      in any computer still running.
    Anything else is unknown: a stopped or missing store, a failing Docker lookup, missing or
    unreadable store configuration, an unreadable marker, recovery material without a marker.
    Then nothing is removed, the exit status is non-zero, and the owner is told to revoke the
    account sessions if a retry cannot verify the sign-out.
    """
    say("Cleanup: sign out, verify in a fresh computer, remove everything")
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # a second Ctrl-C must not abandon the sign-out
    outcome: dict = {"signed_out_verified": None, "basis": None}
    marker = read_state()
    outcome["session_marker"] = marker
    try:
        if marker == "started":
            outcome.update(signed_out_verified=True, basis="never signed in: the session stopped before any sign-in")
        elif marker in ("signed-out-verified", "closed-never-signed-in", "abandoned-after-manual-revocation"):
            outcome.update(signed_out_verified=True, basis=f"already closed ({marker})")
        elif marker is None:
            leftovers = computers() or store_state() != "absent" or SHM.exists()
            if leftovers:
                raise StepFailed("recovery material exists without a session marker")
            outcome.update(signed_out_verified=True, basis="no session: no marker and nothing left")
        else:  # "signin-attempted", or a marker that cannot be read
            if marker != "signin-attempted":
                raise StepFailed(f"the session marker is {marker}")
            s3 = read_store_config()
            store = store_state()
            if store != "running":
                raise StepFailed(f"the checkpoint store is {store}")
            # 1. A computer that still runs may hold a login newer than any checkpoint: sign out
            #    in it, check, and checkpoint the sign-out. If any of that fails, keep it.
            for name in computers():
                if is_running(name):
                    inner(name, "watch-stop", must=False)
                    inner(name, "claude-logout")
                    inner(name, "codex-logout")
                    inner(name, "signed-out-check")
                    rc, _ = inner(name, "capture", "credential", must=False)
                    if rc not in (0, 3):  # 3: its restore never finished, so the checkpoint is current
                        raise StepFailed(f"capture failed in {name}")
                sh("docker", "rm", "-f", name, check=False)  # verified just below
            if not wait_until_no_computer():
                raise StepFailed("a computer could not be removed")
            # 2. Restore the latest checkpoints into a fresh computer; sign out there if needed.
            r = start_computer("recover", s3)
            rc, _ = inner(r, "signed-out-check", must=False)
            if rc != 0:
                inner(r, "claude-logout")
                inner(r, "codex-logout")
                inner(r, "signed-out-check")
                inner(r, "capture", "credential")
            stop_computer(r, final_capture=False)
            # 3. Verify in another fresh computer.
            v = start_computer("verify", s3)
            rc, _ = inner(v, "signed-out-check", must=False)
            stop_computer(v, final_capture=False)
            if rc != 0:
                raise StepFailed("the restored checkpoint is still signed in")
            outcome.update(signed_out_verified=True, basis="signed out, verified in a fresh computer")
    except StepFailed as e:  # includes LookupFailed
        outcome["recovery_error"] = str(e)
    if outcome["signed_out_verified"] is True:
        try:
            for name in computers():
                sh("docker", "rm", "-f", name, check=False)
        except LookupFailed:
            pass
        sh("docker", "rm", "-f", MINIO, check=False)
        sh("docker", "network", "rm", NET, check=False)
        shutil.rmtree(SHM, ignore_errors=True)
        if marker in (None, "signed-out-verified", "closed-never-signed-in", "abandoned-after-manual-revocation"):
            pass
        else:
            write_state("closed-never-signed-in" if marker == "started" else "signed-out-verified")
    if OUT.exists():  # results were written by root in the container; hand them back
        sh("docker", "run", "--rm", "-v", f"{OUT}:/out", "--entrypoint", "chown", IMAGE, "-R",
           f"{os.getuid()}:{os.getgid()}", "/out", check=False)
    try:
        outcome["left_behind"] = {"computers": computers(), "store": store_state(), "shm": SHM.exists()}
    except LookupFailed:
        outcome["left_behind"] = {"docker": "lookup failed", "shm": SHM.exists()}
    print(f"   cleanup: {outcome}")
    record("cleanup", **outcome)
    if outcome["signed_out_verified"] is True:
        print(f"   {outcome['basis']}")
    else:
        print("\n!!! The sign-out is NOT verified, and the state is unknown. Nothing has been removed:\n"
              "!!! the store, /dev/shm/cfo-s6-owner and any computer still running are kept.\n"
              "!!! Fix the cause and run this again with --cleanup. If it still cannot verify the\n"
              "!!! sign-out, revoke this computer's sessions in your Claude and ChatGPT account\n"
              "!!! settings, tell the lead, and then run this with --abandon-after-revoking.")
    return outcome


def abandon() -> int:
    """The owner revoked the sessions by hand: remove what cleanup kept, and record that."""
    say("Abandon: the owner has revoked this computer's sessions in the account settings")
    try:
        names = computers()
    except LookupFailed:
        print("Docker cannot list the computers; nothing removed.")
        return 1
    for name in names:
        sh("docker", "rm", "-f", name, check=False)
    sh("docker", "rm", "-f", MINIO, check=False)
    sh("docker", "network", "rm", NET, check=False)
    shutil.rmtree(SHM, ignore_errors=True)
    write_state("abandoned-after-manual-revocation")
    record("abandoned", removed_computers=names, basis="owner revoked the sessions in the account settings")
    print(f"   removed: computers {names}, the store, the network and {SHM}")
    return 0


def session(s3: dict) -> None:
    # ---------------------------------------------------------------- computer A: sign in
    a = start_computer("a", s3)
    versions = sh("docker", "exec", a, "bash", "-c", "claude --version; codex --version; omnigent --version | tail -1")
    record("versions", versions=versions.splitlines())
    inner(a, "audit", "A fresh")

    write_state("signin-attempted")  # from here on, only a verified sign-out closes the session
    say("Sign in to Claude (owner)")
    print("   Claude Code prints a link. Open it in your browser, sign in with your Claude account,\n"
          "   then copy the code the page shows and paste it at 'Paste code here if prompted'.")
    sign_in(a, "claude", "auth", "login", "--claudeai")
    say("Sign in to ChatGPT for Codex (owner)")
    print("   Device-code login must be enabled first: ChatGPT > Settings > Security.\n"
          "   Codex prints a link and a one-time code. Open the link, sign in, enter the code.")
    sign_in(a, "codex", "login", "--device-auth")

    say("Computer A: checkpoint right after sign-in, then watch")
    inner(a, "claude-status")
    inner(a, "codex-status")
    inner(a, "capture", "credential")  # C1
    inner(a, "watch-start")
    inner(a, "audit", "A after sign-in")
    inner(a, "copies", "A after sign-in")
    inner(a, "lifetimes", "A after sign-in")
    inner(a, "claude-ask")
    inner(a, "codex-ask")
    inner(a, "capture", "workspace")  # W1
    say("Force a refresh of each login; the watcher publishes the new credentials")
    inner(a, "claude-force-refresh")
    inner(a, "codex-force-refresh")
    inner(a, "watch-stop")
    inner(a, "capture", "credential")
    inner(a, "audit", "A after refresh")
    inner(a, "copies", "A after refresh")
    inner(a, "lifetimes", "A after refresh")
    inner(a, "leak-check", "A")
    stop_computer(a, final_capture=False)  # final checkpoint just taken

    # ------------------------------------- computer B: older workspace, newer credentials
    say("Computer B: W1 (older workspace) with the latest credentials")
    b = start_computer("b", s3)
    inner(b, "watch-start")  # before any CLI runs
    inner(b, "audit", "B after restore")
    _, c = inner(b, "claude-status")
    _, x = inner(b, "codex-status")
    if '"true"' not in c or '"true"' not in x:
        raise StepFailed("computer B is not signed in after the restore")
    inner(b, "claude-ask")
    inner(b, "codex-ask")
    inner(b, "capture", "workspace")  # W2: newer than the credential checkpoint
    stop_computer(b)

    # ---------------------------- computer C: newer workspace, older credentials; sign out
    say("Computer C: W2 (newer workspace) with the latest credentials, then sign out")
    c_name = start_computer("c", s3)
    inner(c_name, "watch-start")
    inner(c_name, "audit", "C after restore")
    _, c = inner(c_name, "claude-status")
    _, x = inner(c_name, "codex-status")
    if '"true"' not in c or '"true"' not in x:
        raise StepFailed("computer C is not signed in after the restore")
    inner(c_name, "codex-ask")
    inner(c_name, "leak-check", "C")
    say("Signing out of both accounts")
    inner(c_name, "claude-logout")
    inner(c_name, "codex-logout")
    inner(c_name, "watch-stop")
    inner(c_name, "capture", "credential")  # the design also checkpoints right after a logout
    inner(c_name, "signed-out-check")
    inner(c_name, "audit", "C after sign-out")
    stop_computer(c_name, final_capture=False)

    # ------------------------------------------- computer D: tombstones hold after restore
    say("Computer D: restore the latest checkpoints; the logins must stay signed out")
    d = start_computer("d", s3)
    inner(d, "signed-out-check")
    inner(d, "audit", "D after restore")
    stop_computer(d, final_capture=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cleanup", action="store_true")
    ap.add_argument("--fake", action="store_true", help="dry run with the fake CLIs")
    ap.add_argument("--abandon-after-revoking", action="store_true",
                    help="only after you revoked this computer's sessions in your Claude and ChatGPT account "
                         "settings: remove the recovery material that --cleanup could not verify")
    ap.add_argument("--inject-failure", metavar="ACTION",
                    help="dry runs only: make this inner.sh action always fail, to test recovery")
    a = ap.parse_args()
    if a.inject_failure and not a.fake:
        raise SystemExit("--inject-failure is for dry runs (--fake) only")
    global FAKE, OUT
    if a.fake:
        FAKE = True
        OUT = S6 / "results" / "owner-session-fake-dryrun"
    if a.cleanup:
        return 0 if cleanup().get("signed_out_verified") is True else 1
    if a.abandon_after_revoking:
        return abandon()
    if computers() or read_state() not in (None, "signed-out-verified", "closed-never-signed-in",
                                           "abandoned-after-manual-revocation"):
        raise SystemExit("a previous session is still open; run with --cleanup first")

    OUT.mkdir(parents=True, exist_ok=True)
    write_state("started")
    revision = sh("git", "-C", str(REPO), "rev-parse", "HEAD", check=False)
    # Uncommitted code changes, not results (results are written while the session runs).
    dirty = bool(sh("git", "-C", str(REPO), "status", "--porcelain", "--", "spikes/s6", ":!spikes/s6/results", check=False))
    image_id = sh("docker", "image", "inspect", IMAGE, "--format", "{{.Id}}")
    record("session-start", revision=revision, spike_tree_dirty=dirty, image=IMAGE, image_id=image_id,
           mode="fake CLIs (dry run)" if FAKE else "real accounts",
           approval=None if FAKE else "standing owner approval for real-account S6 runs (AGENTS.md, 18 Oct 2026)")

    say("Preparing: network, MinIO in memory, controller database in /dev/shm")
    SHM.mkdir(mode=0o700, parents=True, exist_ok=True)
    s3 = {"user": "s6owner", "password": secrets.token_hex(16)}  # local, in-memory MinIO only
    fd = os.open(SHM / "s3.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(fd, json.dumps(s3).encode())
    os.close(fd)
    if a.inject_failure:
        (SHM / f"fail-always-{a.inject_failure}").write_text("injected\n")
        record("failure-injected", action=a.inject_failure)
    ok = False
    try:
        sh("docker", "network", "create", NET)
        sh("docker", "run", "-d", "--name", MINIO, "--network", NET, "--tmpfs", "/data:rw,size=256m",
           "-e", f"MINIO_ROOT_USER={s3['user']}", "-e", f"MINIO_ROOT_PASSWORD={s3['password']}", MINIO_IMAGE, "server", "/data")
        time.sleep(3)
        sh("docker", "run", "--rm", "--network", NET, *s3_env(s3), "--entrypoint", "python3", IMAGE, "-I", "-c",
           "import sys; sys.path.insert(0,'/opt/s6/credsync'); from objstore import S3Store; S3Store.from_env().create_bucket()")
        session(s3)
        ok = True
    except (StepFailed, KeyboardInterrupt) as e:
        record("session-stopped", reason=type(e).__name__, detail=str(e)[:200])
        print(f"\nThe session stopped: {e}")
    finally:
        outcome = cleanup()
    record("session-end", completed=ok, signed_out_verified=outcome.get("signed_out_verified"))
    say(f"{'Done' if ok else 'Stopped'}. Masked results: {OUT}")
    return 0 if ok and outcome.get("signed_out_verified") is True else 1


if __name__ == "__main__":
    sys.exit(main())
