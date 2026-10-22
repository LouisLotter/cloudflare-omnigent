"""All-in-one mode for staging: the Omnigent server and the mock LLM beside the supervisor.

The staging footprint is one ``standard-2`` container without internet, so the
server the host connects to and the model the CLIs and runners talk to run in
the same container, as children of the supervisor. Being in the supervisor's
process tree keeps them out of the pause, as a remote server would be. They
take some of the container's CPU and memory, which the evidence records.

  S3_ALL_IN_ONE=1   start both before the host
"""

from __future__ import annotations

import glob
import os
import subprocess
import time
import urllib.request
from typing import Any

SERVER_DIR = "/var/lib/s3/server"
LOG_DIR = "/var/log/s3"
SERVER_PORT = 8000
MOCK_PORT = 9999

# Defaults for the computer's environment when the Durable Object passes none.
COMPUTER_ENV = {
    "OMNIGENT_SERVER_URL": f"http://127.0.0.1:{SERVER_PORT}",
    "OMNIGENT_HOST_ID": "6d2f6c1e-3b1a-4c55-9a51-5f3e0a000001",
    "OMNIGENT_HOST_NAME": "s3-computer-1",
    "OMNIGENT_DISABLE_TELEMETRY": "1",
    "CLAUDE_CONFIG_DIR": "/home/agent/.claude",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "DISABLE_AUTOUPDATER": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "S3_RUNNER_IDLE_TIMEOUT_S": "900",
    "S3_MOCK_URL": f"http://127.0.0.1:{MOCK_PORT}",
    "S3_SERVER_URL": f"http://127.0.0.1:{SERVER_PORT}",
}

PROCS: dict[str, subprocess.Popen[bytes]] = {}


def apply_defaults() -> None:
    for k, v in COMPUTER_ENV.items():
        os.environ.setdefault(k, v)


def _up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return 200 <= r.status < 500
    except Exception:  # noqa: BLE001 - not up yet
        return False


def start() -> dict[str, Any]:
    """Start the server and the mock, and wait until both answer."""
    os.makedirs(os.path.join(SERVER_DIR, "home"), exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    t0 = time.monotonic()
    server_env = {
        "PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "HOME": os.path.join(SERVER_DIR, "home"),
        "OMNIGENT_DATA_DIR": os.path.join(SERVER_DIR, "home", ".omnigent"),
        "OMNIGENT_AUTH_PROVIDER": "header",
        "OMNIGENT_LOCAL_SINGLE_USER": "1",
        "OMNIGENT_DISABLE_CATALOG_LOOKUP": "1",
        "OMNIGENT_DISABLE_TELEMETRY": "1",
        # Computers use 150 s (core change 12), above RC-21's 100 s bound.
        "OMNIGENT_RUNNER_DISCONNECT_GRACE_S": "150",
    }
    PROCS["server"] = subprocess.Popen(
        ["/opt/venv/bin/omnigent", "server", "--host", "127.0.0.1", "--port", str(SERVER_PORT), "--no-open",
         "--database-uri", f"sqlite:///{SERVER_DIR}/chat.db", "--artifact-location", f"{SERVER_DIR}/artifacts"],
        env=server_env, cwd=SERVER_DIR,
        stdout=open(os.path.join(LOG_DIR, "server.log"), "ab"), stderr=subprocess.STDOUT,
    )
    PROCS["mock"] = subprocess.Popen(
        ["/opt/venv/bin/python", "-m", "uvicorn", "--app-dir", "/opt/s3/mockllm", "mock_llm_server:app",
         "--host", "127.0.0.1", "--port", str(MOCK_PORT), "--log-level", "warning"],
        env={"PATH": "/opt/venv/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/root"}, cwd="/opt/s3/mockllm",
        stdout=open(os.path.join(LOG_DIR, "mock.log"), "ab"), stderr=subprocess.STDOUT,
    )
    ready = {"server": False, "mock": False}
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline and not all(ready.values()):
        ready["server"] = ready["server"] or _up(f"http://127.0.0.1:{SERVER_PORT}/health")
        ready["mock"] = ready["mock"] or _up(f"http://127.0.0.1:{MOCK_PORT}/stats")
        for name, p in PROCS.items():
            if p.poll() is not None:
                raise RuntimeError(f"{name} exited with {p.returncode}; see {LOG_DIR}/{name}.log")
        time.sleep(0.5)
    if not all(ready.values()):
        raise RuntimeError(f"all-in-one services not ready: {ready}")
    return {"ready_s": round(time.monotonic() - t0, 1), "pids": {k: p.pid for k, p in PROCS.items()}}


def host_connects() -> int:
    """How many times the host has opened its tunnel ("Connecting to" in its logs).

    Each redial after a drop or a silence deadline adds one, so the difference
    across a pause counts the reconnects it caused.
    """
    n = 0
    paths = [os.path.join(LOG_DIR, "host.log"),
             *glob.glob("/home/agent/.omnigent/logs/host/*.log"),
             *glob.glob("/home/agent/.omnigent/logs/*.log")]
    for path in paths:
        try:
            with open(path, "rb") as fh:
                n += fh.read().count(b"Connecting to ")
        except OSError:
            continue
    return n
