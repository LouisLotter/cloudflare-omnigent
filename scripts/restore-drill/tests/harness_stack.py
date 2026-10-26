"""The durability suite's Docker stack: an S3 stand-in, a faulty link, and server containers.

Adapted from the server image's own image tests (WP2.3), under this package's names. Servers
run the drill image (the server image plus ``cfo_drill``) with the server's own entrypoint.
Each server has no volume: replacing it means SIGKILL, remove, and a fresh container that
restores from the replica, as on Cloudflare Containers. Every credential is generated per run.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
IMAGE = os.environ.get("CFO_DRILL_IMAGE", "cfo-wp25-drill:dev")
#: The Compose project, which also names the server containers; a gate rerun may set its own.
PROJECT = os.environ.get("CFO_DRILL_PROJECT", "cfo-wp25")
NETWORK = f"{PROJECT}_default"
BUCKET = "cfo-wp25-replica"
OWNER = "owner"


def docker(
    *args: str, check: bool = True, timeout: float = 300, **kw: Any
) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=check, timeout=timeout, **kw
    )


def docker_ok() -> bool:
    if shutil.which("docker") is None:
        return False
    return docker("image", "inspect", IMAGE, check=False).returncode == 0


@dataclass
class Stack:
    env: dict[str, str] = field(repr=False)
    s3_url: str
    toxi_url: str
    workdir: Path
    servers: list[Server] = field(default_factory=list, repr=False)
    extra_canaries: list[str] = field(default_factory=list, repr=False)

    def reset_link(self) -> None:
        httpx.delete(f"{self.toxi_url}/proxies/r2", timeout=30)
        httpx.post(
            f"{self.toxi_url}/proxies",
            json={
                "name": "r2",
                "listen": "0.0.0.0:9000",
                "upstream": "minio:9000",
                "enabled": True,
            },
            timeout=30,
        ).raise_for_status()

    def blackhole(self) -> None:
        """Connections open, and no data flows (Toxiproxy ``timeout`` toxic, timeout 0)."""
        for stream in ("upstream", "downstream"):
            httpx.post(
                f"{self.toxi_url}/proxies/r2/toxics",
                json={
                    "name": f"bh_{stream}",
                    "type": "timeout",
                    "stream": stream,
                    "attributes": {"timeout": 0},
                },
                timeout=30,
            ).raise_for_status()

    def unblock(self) -> None:
        httpx.post(f"{self.toxi_url}/proxies/r2", json={"enabled": True}, timeout=30)
        for toxic in httpx.get(f"{self.toxi_url}/proxies/r2/toxics", timeout=30).json():
            httpx.delete(f"{self.toxi_url}/proxies/r2/toxics/{toxic['name']}", timeout=30)

    def server(self, prefix: str, *, initialized: bool, **extra: str) -> Server:
        env = {
            "CFO_INSTALLATION_INITIALIZED": "true" if initialized else "false",
            "CFO_REPLICA_URL": f"s3://{BUCKET}/{prefix}",
            "CFO_REPLICA_ENDPOINT": "http://toxiproxy:9000",
            "CFO_REPLICA_REGION": "us-east-1",
            "LITESTREAM_ACCESS_KEY_ID": self.env["CFO_IT_S3_USER"],
            "LITESTREAM_SECRET_ACCESS_KEY": self.env["CFO_IT_S3_PASSWORD"],
            "OMNIGENT_ACCOUNTS_BASE_URL": "http://cfo-wp25.invalid",
            "OMNIGENT_ACCOUNTS_COOKIE_SECRET": self.env["CFO_IT_COOKIE_SECRET"],
            "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME": OWNER,
            "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD": self.env["CFO_IT_OWNER_PASSWORD"],
            "CFO_RESPONSE_BARRIER_TIMEOUT_S": "5",
            "CFO_TRANSCRIPT_BARRIER_TIMEOUT_S": "3",
            "CFO_RESTORE_DEADLINE_S": "60",
            "CFO_FINAL_SYNC_TIMEOUT_S": "30",
        }
        env.update(extra)
        server = Server(self, env)
        self.servers.append(server)
        return server

    def secrets(self) -> list[str]:
        return [
            self.env[k]
            for k in ("CFO_IT_S3_PASSWORD", "CFO_IT_COOKIE_SECRET", "CFO_IT_OWNER_PASSWORD")
        ] + self.extra_canaries

    def scan(self) -> None:
        """The repository's canary scanner over every server's output and every report."""
        scanner = REPO_ROOT / "scripts" / "canary-scan.ts"
        if shutil.which("node") is None or not scanner.exists():
            return
        result = subprocess.run(
            ["node", str(scanner), str(self.workdir)],
            env={**os.environ, "CFO_CANARY_VALUES": ",".join(self.secrets())},
            capture_output=True,
            text=True,
            timeout=300,
        )
        (self.workdir / "canary-scan.txt").write_text(result.stdout + result.stderr)
        assert result.returncode == 0, result.stdout[-2000:]


class Server:
    def __repr__(self) -> str:
        return f"Server({self.name})"

    def __init__(self, stack: Stack, env: dict[str, str]) -> None:
        self.stack = stack
        self.env = env
        self.name = f"{PROJECT}-server-{uuid.uuid4().hex[:8]}"
        self.app_port = 0
        self.status_port = 0
        self._logs = ""

    @property
    def password(self) -> str:
        return self.env["OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD"]

    def start(self) -> Server:
        env_file = self.stack.workdir / f"{self.name}.env"
        env_file.write_text("".join(f"{k}={v}\n" for k, v in self.env.items()))
        env_file.chmod(0o600)
        try:
            docker(
                "run",
                "-d",
                "--name",
                self.name,
                "--network",
                NETWORK,
                "-p",
                "127.0.0.1::8000",
                "-p",
                "127.0.0.1::8001",
                "--env-file",
                str(env_file),
                "--stop-timeout",
                "120",
                IMAGE,
                "python",
                "-m",
                "cfo_server.entrypoint",
            )
        finally:
            env_file.unlink()
        self.app_port = int(docker("port", self.name, "8000/tcp").stdout.split(":")[-1])
        self.status_port = int(docker("port", self.name, "8001/tcp").stdout.split(":")[-1])
        return self

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.app_port}"

    def status(self) -> dict[str, Any]:
        return httpx.get(f"http://127.0.0.1:{self.status_port}/status", timeout=10).json()

    def running(self) -> bool:
        state = docker("inspect", "-f", "{{.State.Running}}", self.name, check=False).stdout
        return state.strip() == "true"

    def wait_healthy(self, timeout: float = 180) -> float:
        started = time.monotonic()
        deadline = started + timeout
        while time.monotonic() < deadline:
            if not self.running():
                raise AssertionError(f"{self.name} exited: {self.logs()[-3000:]}")
            try:
                if httpx.get(f"{self.url}/health", timeout=5).status_code == 200:
                    return time.monotonic() - started
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        raise AssertionError(f"{self.name} never healthy: {self.logs()[-3000:]}")

    def position(self) -> httpx.Response:
        return httpx.get(f"http://127.0.0.1:{self.status_port}/position", timeout=30)

    def wait_replicated(self, timeout: float = 60) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        first: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            response = self.position()
            if response.status_code == 200:
                current = response.json()
                first = first or current
                if current["replicatedTxid"] >= first["txid"]:
                    return {"target": first, "reached": current}
            time.sleep(0.2)
        raise AssertionError(f"not replicated: first {first}")

    def kill(self, signal: str = "KILL") -> None:
        docker("kill", "-s", signal, self.name, check=False)

    def logs(self) -> str:
        result = docker("logs", self.name, check=False)
        text = result.stdout + result.stderr
        if text:
            self._logs = text
        return self._logs

    def events(self, name: str) -> list[dict[str, Any]]:
        return [
            json.loads(line)
            for line in self.logs().splitlines()
            if line.startswith("{") and f'"cfo.{name}"' in line
        ]

    def remove(self) -> None:
        logs = self.stack.workdir / "logs"
        logs.mkdir(exist_ok=True)
        (logs / f"{self.name}.log").write_text(self.logs())
        docker("rm", "-f", self.name, check=False)

    def replace(self, **extra: str) -> Server:
        """SIGKILL, remove, and start a fresh container on the same replica."""
        self.kill("KILL")
        self.remove()
        nxt = Server(self.stack, {**self.env, **extra})
        self.stack.servers.append(nxt)
        return nxt.start()

    # The drill, inside the server container ------------------------------------------------
    def drill(self, *args: str, stdin: str | None = None, timeout: float = 600) -> tuple[int, dict]:
        result = docker(
            "exec",
            "-i",
            self.name,
            "python",
            "-m",
            "cfo_drill",
            "drill",
            *args,
            check=False,
            timeout=timeout,
            input=stdin,
        )
        reports = self.stack.workdir / "reports"
        reports.mkdir(exist_ok=True)
        (reports / f"{self.name}-{uuid.uuid4().hex[:6]}.json").write_text(result.stdout)
        try:
            report = json.loads(result.stdout)
        except ValueError:
            raise AssertionError(
                f"drill printed no report: {result.stdout[-2000:]} {result.stderr[-2000:]}"
            ) from None
        return result.returncode, report

    def query(self, sql: str, params: tuple[Any, ...] | list[Any] = ()) -> list[tuple[Any, ...]]:
        result = docker(
            "exec", self.name, "python", "-m", "cfo_drill", "query", sql, json.dumps(list(params))
        )
        return [tuple(row) for row in json.loads(result.stdout)]

    def litestream_position(self) -> dict[str, int]:
        result = docker("exec", self.name, "python", "-m", "cfo_drill", "position")
        return json.loads(result.stdout)


def checks_by_name(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["name"]: c for c in report.get("checks", [])}


def manifest(run: Any) -> str:
    """The drill's input from a canary run: identifiers and verdicts, no credentials."""
    return json.dumps(
        {
            "canaries": [c.to_json() for c in run.canaries],
            "conversations": [run.conversation] if run.conversation else [],
        }
    )
