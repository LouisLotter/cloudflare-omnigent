"""Measure the time from a credential change to its published checkpoint (spike S6).

Starts MinIO (the S3 stand-in for R2) in Docker, runs the credential watcher against it, makes
credential changes with the fake CLIs, and records for each change:

  change    the file's mtime after the CLI wrote it
  detect    when the watcher first saw the change
  settled   when the change had been quiet for the settle window
  snapshot  when the local copy was taken
  uploaded  when the archive and manifest were uploaded and verified (PUT, then GET and compare)
  published when the controller switched the pointer

Run:  python3 -I spikes/s6/bench/latency.py --out spikes/s6/results/latency-minio.json
      [--settle-ms 250,500,1000] [--rounds 20] [--minio-endpoint URL --use-env-keys]
Docker must be available unless --minio-endpoint is given. No real credentials are involved.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

S6 = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(S6 / "credsync"))

from controller import Controller  # noqa: E402
from objstore import S3Store  # noqa: E402
from ops import Computer, CredentialWatcher, capture_credentials, mark_restored  # noqa: E402

MINIO_IMAGE = "pgsty/minio@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372"
FAKES = S6 / "fakes" / "fake_cli.py"

CHANGES = [
    ("claude-refresh (temp + rename)", "claude", ["refresh"], ".claude/.credentials.json"),
    ("codex-refresh (in place, O_TRUNC)", "codex", ["refresh"], ".codex/auth.json"),
    ("omnigent-refresh (tempfile + os.replace)", "omnigent", ["refresh", "http://omnigent.internal"], ".omnigent/auth_tokens.json"),
]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def pct(values: list[float], p: float) -> float:
    v = sorted(values)
    if not v:
        return float("nan")
    k = (len(v) - 1) * p
    f, c = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[f] + (v[c] - v[f]) * (k - f), 1)


def summary(values: list[float]) -> dict:
    return {"n": len(values), "p50": pct(values, 0.5), "p95": pct(values, 0.95), "max": round(max(values), 1) if values else None,
            "mean": round(statistics.fmean(values), 1) if values else None}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--settle-ms", default="250,500,1000")
    ap.add_argument("--poll-ms", type=float, default=50)
    ap.add_argument("--rounds", type=int, default=20)
    ap.add_argument("--minio-endpoint")
    ap.add_argument("--label", default="laptop, MinIO on loopback")
    a = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="s6-bench-"))
    os.environ["S6_STATE_DIR"] = str(tmp / "state")
    container = None
    user, password = "s6bench", secrets.token_hex(16)  # throwaway local MinIO root, never kept
    try:
        if a.minio_endpoint:
            endpoint = a.minio_endpoint
            user, password = os.environ["S6_S3_ACCESS_KEY"], os.environ["S6_S3_SECRET_KEY"]
        else:
            port = free_port()
            container = f"s6-bench-minio-{secrets.token_hex(3)}"
            subprocess.run(["docker", "run", "-d", "--rm", "--name", container, "-p", f"127.0.0.1:{port}:9000",
                            "-e", f"MINIO_ROOT_USER={user}", "-e", f"MINIO_ROOT_PASSWORD={password}",
                            MINIO_IMAGE, "server", "/data"], check=True, capture_output=True)
            endpoint = f"http://127.0.0.1:{port}"
        store = S3Store(endpoint, "s6-bench", user, password)
        for _ in range(100):
            try:
                store.create_bucket()
                break
            except OSError:
                time.sleep(0.2)
        else:
            raise SystemExit("MinIO did not start")

        results = {"label": a.label, "minio_image": MINIO_IMAGE, "poll_ms": a.poll_ms, "rounds": a.rounds,
                   "python": sys.version.split()[0], "runs": []}
        for settle_ms in [float(x) for x in a.settle_ms.split(",")]:
            home = tmp / f"home-{int(settle_ms)}"
            home.mkdir()
            env = {"HOME": str(home), "S6_FAKE_PROVIDER": str(tmp / f"provider-{int(settle_ms)}.json"), "PATH": os.environ["PATH"]}

            def cli(prog: str, *args: str) -> None:
                subprocess.run([sys.executable, "-I", str(FAKES), prog, *args], env=env, check=True, capture_output=True)

            cli("claude", "auth", "login")
            cli("codex", "login")
            cli("omnigent", "login", "http://omnigent.internal")
            ctl = Controller(tmp / f"ctl-{int(settle_ms)}.sqlite")
            comp = Computer(f"bench{int(settle_ms)}", ctl.start_generation(f"bench{int(settle_ms)}"), store, ctl)
            mark_restored(comp)  # a new computer: nothing to restore
            capture_credentials(comp, home)

            events: list[dict] = []
            lock = threading.Lock()

            def log(e: dict) -> None:
                with lock:
                    events.append(e)

            w = CredentialWatcher(comp, home, settle_s=settle_ms / 1000, poll_s=a.poll_ms / 1000, log=log)
            t = threading.Thread(target=w.run, daemon=True)
            t.start()
            samples = []
            for r in range(a.rounds):
                for name, prog, args, path in CHANGES:
                    with lock:
                        before = len(events)
                    cli(prog, *args)
                    change = os.stat(home / path).st_mtime_ns / 1e9
                    deadline = time.time() + settle_ms / 1000 + 10
                    ev = None
                    while time.time() < deadline:
                        with lock:
                            new = [e for e in events[before:] if e["event"] == "published"]
                        if new:
                            ev = new[0]
                            break
                        time.sleep(0.005)
                    if ev is None:
                        samples.append({"change": name, "round": r, "error": "not published in time"})
                        continue
                    samples.append({
                        "change": name, "round": r, "seq": ev["seq"],
                        "detect_ms": round((ev["t_first_change"] - change) * 1000, 1),
                        "settle_wait_ms": round((ev["t_settled"] - ev["t_first_change"]) * 1000, 1),
                        "snapshot_ms": round((ev["t_snapshot"] - ev["t_settled"]) * 1000, 1),
                        "upload_verify_ms": round((ev["t_uploaded"] - ev["t_snapshot"]) * 1000, 1),
                        "publish_ms": round((ev["t_published"] - ev["t_uploaded"]) * 1000, 1),
                        "change_to_published_ms": round((ev["t_published"] - change) * 1000, 1),
                    })
                    time.sleep(0.2)
            w.stopped = True
            t.join(5)
            ok = [s for s in samples if "error" not in s]
            run = {"settle_ms": settle_ms, "samples": samples, "errors": len(samples) - len(ok),
                   "change_to_published_ms": summary([s["change_to_published_ms"] for s in ok]),
                   "upload_verify_ms": summary([s["upload_verify_ms"] for s in ok]),
                   "detect_ms": summary([s["detect_ms"] for s in ok]),
                   "by_change": {n: summary([s["change_to_published_ms"] for s in ok if s["change"] == n]) for n, *_ in CHANGES}}
            results["runs"].append(run)
            print(json.dumps({k: run[k] for k in ("settle_ms", "errors", "change_to_published_ms", "upload_verify_ms")}))
        Path(a.out).write_text(json.dumps(results, indent=1) + "\n")
    finally:
        if container:
            subprocess.run(["docker", "rm", "-f", container], capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
