"""Spike S3 supervisor: starts the host, serves a small control API.

The API stands in for the computer API that WorkspaceDO would call. It binds
inside the container; the compose file publishes it on 127.0.0.1 only.

  GET  /health            liveness
  GET  /runners           runner count from /proc (supervisor view)
  GET  /procs             process table (evidence)
  POST /capture           one bounded capture (runs the capture worker process)
  GET  /captures/<id>     a capture's result, for callers that went away
  POST /upload            upload a snapshot as a background job -> {"job": id}
  GET  /jobs/<id>         job status/result
  GET  /pointer           the published checkpoint pointer
  GET  /probe             environment probe for the staging run
  POST /bench             self-contained capture bench (job), for the staging run
  POST /exec, /rm, /df, /fetch   spike conveniences for the bench scripts
"""

from __future__ import annotations

import json
import os
import pwd
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import procs as P
from . import runners as R
from . import upload as U

AGENT = os.environ.get("S3_AGENT_USER", "agent")
PW = pwd.getpwnam(AGENT)
HOME = PW.pw_dir
SNAP_ROOT = os.environ.get("S3_SNAPSHOT_ROOT", "/snap")
LOG_DIR = "/var/log/s3"
CG_ROOT = "/sys/fs/cgroup"
CG_WORKLOAD = os.path.join(CG_ROOT, "workload")
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(HOME, ".claude"))

# The declared directories of the workspace checkpoint (design, "Checkpoints").
# Credential files, their temporary siblings and locks are excluded by
# credpolicy from S6's audited list (IR-015); these lists hold caches, logs and
# runtime files only. home_rel ties each root to S6's home-relative names.
ITEMS: list[dict[str, Any]] = [
    {"name": "work", "src": os.path.join(HOME, "work"), "home_rel": "work",
     "exclude": ["node_modules/", ".venv/", "venv/", "__pycache__/", ".cache/", ".pytest_cache/"]},
    {"name": "claude", "src": CLAUDE_DIR, "home_rel": os.path.relpath(CLAUDE_DIR, HOME),
     "exclude": ["shell-snapshots/", "statsig/"]},
    # Codex reinstalls its bundled skills (skills/.system) on start; they hold
    # PNG assets that the RC-22 canary scanner cannot decode.
    {"name": "codex", "src": os.path.join(HOME, ".codex"), "home_rel": ".codex",
     "exclude": ["log/", ".tmp/", "tmp/", "/skills/.system/"]},
    {"name": "omnigent", "src": os.path.join(HOME, ".omnigent"), "home_rel": ".omnigent",
     "exclude": ["logs/", "cache/", "run/", "*.pid", "*.lock", "*.sock"]},
]
ROOTS = {it["name"]: it["home_rel"] for it in ITEMS}

STATE: dict[str, Any] = {"workload_pids": [], "jobs": {}, "cgroup": False, "last_snapshot": None}


def setup_cgroup() -> bool:
    if os.environ.get("S3_FREEZER") != "cgroup":
        return False
    try:
        os.makedirs(CG_WORKLOAD, exist_ok=True)
        return os.access(os.path.join(CG_WORKLOAD, "cgroup.freeze"), os.W_OK)
    except OSError as exc:
        print(f"cgroup freezer unavailable: {exc}", file=sys.stderr)
        return False


def agent_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {
        "HOME": HOME,
        "USER": AGENT,
        "LOGNAME": AGENT,
        "PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "SHELL": "/bin/bash",
    }
    for k, v in os.environ.items():
        if k.startswith(("OMNIGENT_", "CLAUDE_", "DISABLE_", "CODEX_", "ANTHROPIC_", "OPENAI_", "MOCK_")):
            env[k] = v
    env.update(extra or {})
    return env


def as_agent(argv: list[str]) -> list[str]:
    """Wrap argv so it runs as the agent user, inside the workload cgroup if any."""
    move = f"echo $$ > {CG_WORKLOAD}/cgroup.procs && " if STATE["cgroup"] else ""
    return ["bash", "-c", f'{move}exec setpriv --reuid={PW.pw_uid} --regid={PW.pw_gid} --init-groups -- "$@"', "_", *argv]


def start_host() -> subprocess.Popen[bytes]:
    for d in (".omnigent", "work"):
        os.makedirs(os.path.join(HOME, d), exist_ok=True)
        os.chown(os.path.join(HOME, d), PW.pw_uid, PW.pw_gid)
    idle = os.environ.get("S3_RUNNER_IDLE_TIMEOUT_S")
    cfg = os.path.join(HOME, ".omnigent", "config.yaml")
    if idle and not os.path.exists(cfg):
        with open(cfg, "w") as fh:
            fh.write(f"runner:\n  idle_timeout_s: {int(idle)}\n")
        os.chown(cfg, PW.pw_uid, PW.pw_gid)
    log = open(os.path.join(LOG_DIR, "host.log"), "ab")
    server = os.environ["OMNIGENT_SERVER_URL"]
    proc = subprocess.Popen(
        as_agent(["/opt/venv/bin/python", "-m", "omnigent.host._daemon_entry", "--server", server]),
        env=agent_env({"OMNIGENT_PROCESS_LOG_FILE": os.path.join(HOME, ".omnigent", "host-daemon.log")}),
        cwd=HOME,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    STATE["workload_pids"].append(proc.pid)
    return proc


def run_capture(body: dict[str, Any]) -> dict[str, Any]:
    cid = body.get("capture_id") or uuid.uuid4().hex[:12]
    root = body.get("snapshot_root", SNAP_ROOT)
    spec = {
        "capture_id": cid,
        "snapshot_root": root,
        "method": body.get("method", "rsync"),
        "budget_s": body.get("budget_s", 20.0),
        "items": body.get("items", ITEMS),
        "mechanism": "cgroup" if (STATE["cgroup"] and body.get("mechanism", "cgroup") == "cgroup") else "sigstop",
        "cgroup_dir": CG_WORKLOAD,
        "supervisor_pid": os.getpid(),
        "workload_pids": STATE["workload_pids"] + body.get("extra_workload_pids", []),
        "log_dir": LOG_DIR,
        "fault": body.get("fault", ""),
        "margin_bytes": body.get("margin_bytes", 64 << 20),
    }
    if body.get("method") == "rsync-incremental" and STATE["last_snapshot"]:
        spec["incremental_base"] = STATE["last_snapshot"]
    spec_path = os.path.join(LOG_DIR, f"capture-{cid}.spec.json")
    result_path = os.path.join(LOG_DIR, f"capture-{cid}.result.json")
    with open(spec_path, "w") as fh:
        json.dump(spec, fh)
    t0 = time.monotonic()
    worker = subprocess.Popen([sys.executable, "-m", "supervisor.capture", spec_path, result_path],
                              env={**os.environ, "PYTHONPATH": "/opt/s3"})
    STATE["worker_pid"] = worker.pid
    try:
        rc = worker.wait(timeout=float(spec["budget_s"]) + 60)
    except subprocess.TimeoutExpired:
        # A wedged worker. Its lease guard has already resumed everything at
        # the deadline; the worker's copy can never be published.
        worker.kill()
        rc = worker.wait()
    wall = time.monotonic() - t0
    try:
        with open(result_path) as fh:
            res = json.load(fh)
    except (OSError, json.JSONDecodeError):
        res = {"capture_id": cid, "outcome": "worker_died", "worker_rc": rc, "published": False}
        guard_log = os.path.join(LOG_DIR, f"lease-{cid}.json")
        # The guard writes its log when it exits; give it a moment.
        for _ in range(100):
            if os.path.exists(guard_log):
                break
            time.sleep(0.05)
        try:
            with open(guard_log) as fh:
                res["guard"] = json.load(fh)
        except (OSError, json.JSONDecodeError):
            pass
        partial = os.path.join(root, f"{cid}.partial")
        res["partial_left"] = os.path.exists(partial)
        if os.path.exists(partial):
            subprocess.run(["rm", "-rf", partial])
    res["worker_wall_s"] = round(wall, 3)
    if res.get("outcome") == "snapshot_ready" and body.get("method") == "rsync-incremental":
        STATE["last_snapshot"] = res["snapshot_dir"]
    return res


def start_job(fn: Any, *args: Any) -> str:
    jid = uuid.uuid4().hex[:10]
    STATE["jobs"][jid] = {"state": "running", "started": time.time()}

    def run() -> None:
        try:
            out = fn(*args)
            STATE["jobs"][jid].update(state="done", result=out)
        except Exception as exc:  # noqa: BLE001
            STATE["jobs"][jid].update(state="error", error=f"{type(exc).__name__}: {exc}")

    threading.Thread(target=run, daemon=True).start()
    return jid


def do_upload(body: dict[str, Any]) -> dict[str, Any]:
    spec = {
        "bucket": os.environ.get("S3_BUCKET", "checkpoints"),
        "computer_id": os.environ.get("S3_COMPUTER_ID", "computer-1"),
        "generation": int(os.environ.get("S3_GENERATION", "1")),
        "roots": ROOTS,
        **body,
    }
    return U.upload_snapshot(spec)


def do_exec(body: dict[str, Any]) -> dict[str, Any]:
    t0 = time.monotonic()
    p = subprocess.run(
        as_agent(body["argv"]),
        env=agent_env(body.get("env")),
        cwd=body.get("cwd", HOME),
        capture_output=True,
        timeout=body.get("timeout", 300),
        input=body.get("stdin", "").encode(),
    )
    return {
        "rc": p.returncode,
        "stdout": p.stdout.decode(errors="replace")[-20000:],
        "stderr": p.stderr.decode(errors="replace")[-8000:],
        "s": round(time.monotonic() - t0, 3),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:  # quiet
        pass

    def _send(self, code: int, obj: Any) -> None:
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict[str, Any]:
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True, "cgroup": STATE["cgroup"], "workload_pids": STATE["workload_pids"]})
        elif self.path == "/runners":
            t0 = time.monotonic()
            res = R.classify()
            res["scan_s"] = round(time.monotonic() - t0, 4)
            self._send(200, res)
        elif self.path == "/procs":
            procs = P.scan()
            by_uid: dict[int, list[int]] = {}
            for p in procs.values():
                by_uid.setdefault(p.uid, []).append(p.pid)
            outs = R.stdout_targets(by_uid)
            self._send(200, [
                {"pid": p.pid, "ppid": p.ppid, "state": p.state, "uid": p.uid, "cmd": p.cmd()[:200],
                 "stdout": outs.get(p.pid)}
                for p in sorted(procs.values(), key=lambda p: p.pid)
            ])
        elif self.path == "/probe":
            from . import probe

            self._send(200, probe.probe())
        elif self.path.startswith("/captures/"):
            cid = os.path.basename(self.path)
            try:
                with open(os.path.join(LOG_DIR, f"capture-{cid}.result.json")) as fh:
                    self._send(200, json.load(fh))
            except OSError:
                self._send(404, {})
        elif self.path.startswith("/jobs/"):
            job = STATE["jobs"].get(self.path.split("/")[-1])
            self._send(200 if job else 404, job or {})
        elif self.path == "/pointer":
            self._send(200, {"pointer": U.current_pointer(os.environ.get("S3_BUCKET", "checkpoints"),
                                                          os.environ.get("S3_COMPUTER_ID", "computer-1"))})
        else:
            self._send(404, {})

    def do_POST(self) -> None:  # noqa: N802
        body = self._body()
        try:
            if self.path == "/capture":
                self._send(200, run_capture(body))
            elif self.path == "/upload":
                self._send(200, {"job": start_job(do_upload, body)})
            elif self.path == "/exec":
                self._send(200, do_exec(body))
            elif self.path == "/fetch":
                # Spike convenience: download a stored object for the canary scan.
                dest = "/tmp/" + os.path.basename(body["dest"])
                U.client(30, 3).download_file(os.environ.get("S3_BUCKET", "checkpoints"), body["key"], dest)
                self._send(200, {"path": dest, "size": os.path.getsize(dest)})
            elif self.path == "/bench":
                from . import probe

                # Minutes long: run as a job, poll GET /jobs/<id>.
                self._send(200, {"job": start_job(probe.bench, body, run_capture, as_agent)})
            elif self.path == "/rm":
                # Spike convenience: remove snapshots (root-owned) between runs.
                path = os.path.realpath(body["path"])
                if path in ("/snap", "/snap-small") and body.get("all"):
                    for name in os.listdir(path):
                        subprocess.run(["rm", "-rf", os.path.join(path, name)], check=False)
                elif path.startswith(("/snap/", "/snap-small/", "/restore-staging/")):
                    subprocess.run(["rm", "-rf", path], check=False)
                else:
                    self._send(400, {"error": "refused"})
                    return
                if body.get("forget_base"):
                    STATE["last_snapshot"] = None
                self._send(200, {"removed": path})
            elif self.path == "/df":
                st = os.statvfs(body.get("path", SNAP_ROOT))
                self._send(200, {"free": st.f_bavail * st.f_frsize, "size": st.f_blocks * st.f_frsize})
            else:
                self._send(404, {})
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})


def restore_on_start() -> dict[str, Any] | None:
    if os.environ.get("S3_RESTORE_ON_START") != "1":
        return None
    staging = "/restore-staging/root"
    res = U.restore_latest(os.environ.get("S3_BUCKET", "checkpoints"),
                           os.environ.get("S3_COMPUTER_ID", "computer-1"), staging)
    if res.get("outcome") == "restored":
        for it in ITEMS:
            src = os.path.join(staging, it["name"])
            if os.path.exists(src):
                subprocess.run(["rm", "-rf", it["src"]], check=True)
                os.makedirs(os.path.dirname(it["src"]), exist_ok=True)
                subprocess.run(["mv", src, it["src"]], check=True)
        subprocess.run(["chown", "-R", f"{PW.pw_uid}:{PW.pw_gid}", HOME], check=True)
    with open(os.path.join(LOG_DIR, "restore.json"), "w") as fh:
        json.dump(res, fh)
    return res


def ensure_bucket() -> None:
    bucket = os.environ.get("S3_BUCKET", "checkpoints")
    for _ in range(60):
        try:
            s3 = U.client(5, 1)
            names = [b["Name"] for b in s3.list_buckets().get("Buckets", [])]
            if bucket not in names:
                s3.create_bucket(Bucket=bucket)
            return
        except Exception:  # noqa: BLE001 - store not up yet
            time.sleep(1)


def main() -> int:
    os.makedirs(LOG_DIR, exist_ok=True)
    os.makedirs(SNAP_ROOT, exist_ok=True)
    if "S3_ENDPOINT" in os.environ:
        threading.Thread(target=ensure_bucket, daemon=True).start()
    STATE["cgroup"] = setup_cgroup()
    # Nothing that writes the restored directories runs before the restore.
    STATE["restore"] = restore_on_start()
    if os.environ.get("S3_START_HOST", "1") == "1":
        start_host()
    srv = ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("S3_API_PORT", "7070"))), Handler)
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
