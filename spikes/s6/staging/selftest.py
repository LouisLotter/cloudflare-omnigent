"""Spike S6 self-test for the staging computer: fake CLIs only, no real accounts.

Runs inside the container, with a store and controller on the container's own disk, to check
that the file handling (renames, in-place writes, modes, settling) behaves in the Cloudflare
container runtime as it does under Docker. Measures the local part of change-to-published,
then checks the restore matrix and tombstones. The Durable Object path is exercised separately
by the "selftest" phase. Prints one JSON document; it holds no login material.

  python3 -I /opt/s6/staging/selftest.py [--rounds 10] [--settle-ms 500]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

S6 = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(S6 / "credsync"))

from ops import Computer, CredentialWatcher, capture_credentials, capture_workspace, mark_restored, restore  # noqa: E402
from controller import Controller  # noqa: E402
from objstore import LocalStore  # noqa: E402

FAKES = S6 / "fakes" / "fake_cli.py"
COMPUTER_ID = "s6-selftest"


def pct(v: list[float], p: float) -> float | None:
    v = sorted(v)
    if not v:
        return None
    k = (len(v) - 1) * p
    f, c = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[f] + (v[c] - v[f]) * (k - f), 1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=10)
    ap.add_argument("--settle-ms", type=float, default=500)
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="s6-selftest-"))
    os.environ["S6_STATE_DIR"] = str(tmp / "state")
    provider = tmp / "provider.json"
    ctl = Controller(tmp / "controller.sqlite")
    comp = Computer(COMPUTER_ID, ctl.start_generation(COMPUTER_ID), LocalStore(tmp / "store"), ctl)
    mark_restored(comp)  # a new computer: nothing to restore
    result: dict = {"store": "container-local directory", "settle_ms": a.settle_ms, "rounds": a.rounds, "checks": {}}
    n = 0

    def new_home() -> Path:
        nonlocal n
        n += 1
        h = tmp / f"home{n}"
        h.mkdir()
        return h

    def cli(home: Path, prog: str, *args: str) -> int:
        env = {"HOME": str(home), "S6_FAKE_PROVIDER": str(provider), "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        return subprocess.run([sys.executable, "-I", str(FAKES), prog, *args], env=env, capture_output=True).returncode

    def logged_in(home: Path) -> dict:
        return {"claude": cli(home, "claude", "auth", "status") == 0, "codex": cli(home, "codex", "login", "status") == 0,
                "omnigent": cli(home, "omnigent", "status", "http://omnigent.internal") == 0}

    try:
        # -- Latency: change -> published checkpoint, local store -------------------
        h1 = new_home()
        for prog, args in [("claude", ["auth", "login"]), ("codex", ["login"]), ("omnigent", ["login", "http://omnigent.internal"])]:
            cli(h1, prog, *args)
        capture_credentials(comp, h1)
        events: list[dict] = []
        lock = threading.Lock()

        def log(e: dict) -> None:
            with lock:
                events.append(e)

        w = CredentialWatcher(comp, h1, settle_s=a.settle_ms / 1000, poll_s=0.05, log=log)
        t = threading.Thread(target=w.run, daemon=True)
        t.start()
        samples = []
        changes = [("claude", ["refresh"], ".claude/.credentials.json"), ("codex", ["refresh"], ".codex/auth.json"),
                   ("omnigent", ["refresh", "http://omnigent.internal"], ".omnigent/auth_tokens.json")]
        for _ in range(a.rounds):
            for prog, args, path in changes:
                with lock:
                    before = len(events)
                cli(h1, prog, *args)
                changed = os.stat(h1 / path).st_mtime_ns / 1e9
                deadline = time.time() + a.settle_ms / 1000 + 20
                ev = None
                while time.time() < deadline and ev is None:
                    with lock:
                        ev = next((e for e in events[before:] if e["event"] == "published"), None)
                    time.sleep(0.005)
                if ev:
                    samples.append({"cli": prog, "total_ms": round((ev["t_published"] - changed) * 1000, 1),
                                    "upload_verify_ms": round((ev["t_uploaded"] - ev["t_snapshot"]) * 1000, 1),
                                    "publish_ms": round((ev["t_published"] - ev["t_uploaded"]) * 1000, 1)})
                else:
                    samples.append({"cli": prog, "error": "not published within 20 s"})
                time.sleep(0.2)
        w.stopped = True
        t.join(5)
        ok = [s for s in samples if "error" not in s]
        result["latency"] = {
            "n": len(ok), "errors": len(samples) - len(ok),
            "change_to_published_ms": {"p50": pct([s["total_ms"] for s in ok], 0.5), "p95": pct([s["total_ms"] for s in ok], 0.95),
                                       "max": max((s["total_ms"] for s in ok), default=None)},
            "upload_verify_ms": {"p50": pct([s["upload_verify_ms"] for s in ok], 0.5), "p95": pct([s["upload_verify_ms"] for s in ok], 0.95)},
            "publish_ms": {"p50": pct([s["publish_ms"] for s in ok], 0.5), "p95": pct([s["publish_ms"] for s in ok], 0.95)},
            "mean_total_ms": round(statistics.fmean(s["total_ms"] for s in ok), 1) if ok else None,
            "samples": samples,
        }

        # -- Newer credentials with an older workspace ----------------------------------------
        cli(h1, "claude", "session", "first")
        w1, _, _ = capture_workspace(comp, h1)
        cli(h1, "claude", "refresh")
        cli(h1, "codex", "refresh")
        c2, _, _ = capture_credentials(comp, h1)
        h2 = new_home()
        r = restore(comp, h2, tmp / "staging2")
        result["checks"]["newer_credentials_older_workspace"] = {
            "workspace_seq": r["workspace"]["seq"], "credential_seq": r["credentials"]["seq"],
            "pass": r["workspace"]["seq"] == w1 and r["credentials"]["seq"] == c2
            and (h2 / ".claude/projects/-work/first.jsonl").exists()
            and cli(h2, "claude", "refresh") == 0 and cli(h2, "codex", "refresh") == 0,
        }
        c3, _, _ = capture_credentials(comp, h2)  # the refreshes above rotated the tokens again

        # -- Older credentials with a newer workspace -----------------------------------------
        cli(h2, "codex", "session", "later")
        w2, _, _ = capture_workspace(comp, h2)
        h3 = new_home()
        r = restore(comp, h3, tmp / "staging3")
        result["checks"]["older_credentials_newer_workspace"] = {
            "workspace_seq": r["workspace"]["seq"], "credential_seq": r["credentials"]["seq"],
            "pass": r["workspace"]["seq"] == w2 and r["credentials"]["seq"] == c3
            and (h3 / ".codex/sessions/2026/10/18/rollout-later.jsonl").exists()
            and logged_in(h3) == {"claude": True, "codex": True, "omnigent": True}
            and cli(h3, "codex", "use") == 0,
        }

        # -- Logout tombstones ----------------------------------------------------------------
        cli(h3, "claude", "auth", "logout")
        cli(h3, "codex", "logout")
        cli(h3, "omnigent", "signout-delete")
        c4, _, snap = capture_credentials(comp, h3)
        h4 = new_home()
        r = restore(comp, h4, tmp / "staging4")
        result["checks"]["logout_tombstones_hold"] = {
            "states": {x.path: x.state for x in snap.records},
            "actions": [f["action"] for f in r["credentials"]["files"]],
            "pass": r["credentials"]["seq"] == c4 and r["workspace"]["seq"] == w2
            and logged_in(h4) == {"claude": False, "codex": False, "omnigent": False},
        }
        result["refusals"] = comp.controller.refusals(COMPUTER_ID)
        result["pass"] = all(c["pass"] for c in result["checks"].values()) and result["latency"]["errors"] == 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(json.dumps(result))
    return 0 if result.get("pass") else 1


if __name__ == "__main__":
    sys.exit(main())
