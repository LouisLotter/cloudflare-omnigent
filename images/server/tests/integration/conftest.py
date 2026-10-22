"""Fixtures for the image tests: the built server image, an S3 stand-in, and a faulty link.

Run from the repository root, after building the image:

    docker build -f images/server/Dockerfile -t cfo-wp23-server:dev .   (no --target, as Wrangler)
    uv run --no-project --with pytest==9.1.1 --with httpx==0.28.1 --with boto3==1.40.0 \\
      --with jsonschema==4.26.0 pytest -p no:cacheprovider images/server/tests/integration

Each server runs in its own container, with no volume: replacing it means SIGKILL, remove,
and a fresh container that restores from the replica, as on Cloudflare Containers. Every
credential is generated for the run; results never contain them.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest

HERE = Path(__file__).resolve().parent
IMAGE = os.environ.get("CFO_IT_IMAGE", "cfo-wp23-server:dev")
PROJECT = "cfo-wp23"
NETWORK = f"{PROJECT}_default"
BUCKET = "cfo-wp23-replica"
OWNER = "owner"


def _docker_ok() -> bool:
    if shutil.which("docker") is None:
        return False
    probe = subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True)
    return probe.returncode == 0


pytestmark = pytest.mark.skipif(not _docker_ok(), reason=f"needs Docker and the image {IMAGE}")


def docker(*args: str, check: bool = True, timeout: float = 300) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=check, timeout=timeout
    )


@dataclass
class Stack:
    env: dict[str, str]
    s3_url: str
    toxi_url: str
    workdir: Path
    servers: list[Server] = field(default_factory=list)
    #: More exact values the log scan must not find, such as issued magic-link tokens.
    extra_canaries: list[str] = field(default_factory=list)

    def s3(self):  # noqa: ANN201
        import boto3

        return boto3.client(
            "s3",
            endpoint_url=self.s3_url,
            region_name="us-east-1",
            aws_access_key_id=self.env["CFO_IT_S3_USER"],
            aws_secret_access_key=self.env["CFO_IT_S3_PASSWORD"],
        )

    def objects(self, prefix: str) -> list[str]:
        response = self.s3().list_objects_v2(Bucket=BUCKET, Prefix=prefix.rstrip("/") + "/")
        return [o["Key"] for o in response.get("Contents", [])]

    # The "R2" link ---------------------------------------------------------------------
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

    # Servers ---------------------------------------------------------------------------
    def server(self, prefix: str, *, initialized: bool, **extra: str) -> Server:
        env = {
            "CFO_INSTALLATION_INITIALIZED": "true" if initialized else "false",
            "CFO_REPLICA_URL": f"s3://{BUCKET}/{prefix}",
            "CFO_REPLICA_ENDPOINT": "http://toxiproxy:9000",
            "CFO_REPLICA_REGION": "us-east-1",
            "LITESTREAM_ACCESS_KEY_ID": self.env["CFO_IT_S3_USER"],
            "LITESTREAM_SECRET_ACCESS_KEY": self.env["CFO_IT_S3_PASSWORD"],
            "OMNIGENT_ACCOUNTS_BASE_URL": "http://cfo-wp23.invalid",
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


class Server:
    def __init__(self, stack: Stack, env: dict[str, str]) -> None:
        self.stack = stack
        self.env = env
        self.name = f"{PROJECT}-server-{uuid.uuid4().hex[:8]}"
        self.app_port = 0
        self.status_port = 0
        self._logs = ""

    def start(self) -> Server:
        env_file = self.stack.workdir / f"{self.name}.env"
        env_file.write_text("".join(f"{k}={v}\n" for k, v in self.env.items()))
        env_file.chmod(0o600)
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
        )
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

    def wait_phase(self, phase: str, timeout: float = 120) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        last: dict[str, Any] = {}
        while time.monotonic() < deadline:
            if not self.running():
                raise AssertionError(f"{self.name} exited: {self.logs()[-3000:]}")
            try:
                last = self.status()
            except (httpx.HTTPError, ValueError):
                last = {}
            if last.get("phase") == phase:
                return last
            time.sleep(0.25)
        raise AssertionError(f"{self.name}: phase {phase!r} not reached; last {last}")

    def wait_healthy(self, timeout: float = 120) -> None:
        self.wait_phase("running", timeout)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.running():
                raise AssertionError(f"{self.name} exited: {self.logs()[-3000:]}")
            try:
                if httpx.get(f"{self.url}/health", timeout=5).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.25)
        raise AssertionError(f"{self.name} never healthy: {self.logs()[-3000:]}")

    def position(self) -> httpx.Response:
        """``GET /position`` on the control port, as the server's Durable Object reads it."""
        return httpx.get(f"http://127.0.0.1:{self.status_port}/position", timeout=10)

    def wait_replicated(self, timeout: float = 60) -> dict[str, Any]:
        """The watchdog's check: a later ``replicatedTxid`` of the same boot reaches a
        ``txid`` read after the commits of interest."""
        deadline = time.monotonic() + timeout
        first: dict[str, Any] | None = None
        while time.monotonic() < deadline:
            response = self.position()
            if response.status_code == 200:
                current = response.json()
                if first is None:
                    first = current
                assert current["bootId"] == first["bootId"]
                if current["replicatedTxid"] >= first["txid"]:
                    return {"target": first, "reached": current}
            time.sleep(0.2)
        raise AssertionError(f"not replicated: first {first}, status {self.status()}")

    def kill(self, signal: str = "KILL") -> None:
        docker("kill", "-s", signal, self.name, check=False)

    def wait_exit(self, timeout: float = 300) -> int:
        out = docker("wait", self.name, timeout=timeout).stdout.strip()
        return int(out)

    def logs(self) -> str:
        result = docker("logs", self.name, check=False)
        text = result.stdout + result.stderr
        if text:
            self._logs = text
        return self._logs

    def events(self, name: str) -> list[dict[str, Any]]:
        found = []
        for line in self.logs().splitlines():
            if line.startswith("{") and f'"cfo.{name}"' in line:
                found.append(json.loads(line))
        return found

    def exec(self, *command: str) -> subprocess.CompletedProcess:
        return docker("exec", self.name, *command, check=False)

    def remove(self) -> None:
        # Keep every server's output for the run's canary scan (CFO_CANARY_VALUES set to the
        # run's generated secrets): no credential may appear in a log.
        logs_dir = self.stack.workdir / "logs"
        logs_dir.mkdir(exist_ok=True)
        (logs_dir / f"{self.name}.log").write_text(self.logs())
        docker("rm", "-f", self.name, check=False)

    def replace(self, **extra: str) -> Server:
        """SIGKILL, remove, and start a fresh container on the same replica."""
        self.kill("KILL")
        self.remove()
        env = {**self.env, **extra}
        nxt = Server(self.stack, env)
        self.stack.servers.append(nxt)
        return nxt.start()

    # Omnigent, as a client would use it --------------------------------------------------
    def client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self.url, timeout=60, limits=httpx.Limits(max_keepalive_connections=0)
        )

    def login(self, *, refresh: bool = False, password: str | None = None) -> dict[str, Any]:
        with self.client() as c:
            response = c.post(
                "/auth/login",
                json={
                    "username": OWNER,
                    "password": password or self.env["OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD"],
                    "issue_refresh": refresh,
                },
            )
        assert response.status_code == 200, response.text
        return response.json()

    def bearer(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.login()['token']}"}


def _scan_logs(stack: Stack) -> None:
    """Run the repository's canary scanner over every server's output, with the run's
    generated secrets as exact canary values. Any hit fails the run."""
    logs_dir = stack.workdir / "logs"
    scanner = HERE.parents[3] / "scripts" / "canary-scan.ts"
    if not logs_dir.exists() or shutil.which("node") is None or not scanner.exists():
        return
    result = subprocess.run(
        ["node", str(scanner), str(logs_dir)],
        env={**os.environ, "CFO_CANARY_VALUES": ",".join(stack.secrets())},
        capture_output=True,
        text=True,
        timeout=300,
    )
    (stack.workdir / "canary-scan.txt").write_text(result.stdout + result.stderr)
    assert result.returncode == 0, result.stdout[-2000:]


@pytest.fixture(scope="session")
def stack(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Stack]:
    workdir = tmp_path_factory.mktemp("it")
    env = {
        **os.environ,
        "CFO_IT_S3_USER": f"cfo{secrets.token_hex(6)}",
        "CFO_IT_S3_PASSWORD": secrets.token_hex(20),
        "CFO_IT_COOKIE_SECRET": secrets.token_hex(32),
        "CFO_IT_OWNER_PASSWORD": f"owner-{secrets.token_hex(12)}",
    }
    compose = ["docker", "compose", "-p", PROJECT, "-f", str(HERE / "compose.yaml")]
    subprocess.run([*compose, "up", "-d"], env=env, check=True, capture_output=True, timeout=600)
    try:

        def port(service: str, inner: int) -> int:
            out = subprocess.run(
                [*compose, "port", service, str(inner)],
                env=env,
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            return int(out.strip().rsplit(":", 1)[-1])

        stack = Stack(
            env=env,
            s3_url=f"http://127.0.0.1:{port('minio', 9000)}",
            toxi_url=f"http://127.0.0.1:{port('toxiproxy', 8474)}",
            workdir=workdir,
        )
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                if httpx.get(f"{stack.s3_url}/minio/health/live", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
        stack.s3().create_bucket(Bucket=BUCKET)
        stack.reset_link()
        yield stack
        _scan_logs(stack)
    finally:
        for name in docker("ps", "-a", "-q", "--filter", f"name={PROJECT}-server-").stdout.split():
            docker("rm", "-f", name, check=False)
        subprocess.run(
            [*compose, "down", "-v", "--remove-orphans"], env=env, capture_output=True, timeout=300
        )


@pytest.fixture
def link(stack: Stack) -> Iterator[Stack]:
    """The stack, with the R2 link healthy before and after the test."""
    stack.unblock()
    yield stack
    stack.unblock()
    for server in stack.servers:
        server.remove()
    stack.servers.clear()


@pytest.fixture
def prefix() -> str:
    return f"t-{uuid.uuid4().hex[:10]}"
