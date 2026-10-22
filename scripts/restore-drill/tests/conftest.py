"""Fixtures for the durability suite (WP2.5).

The pure tests (``test_units.py``) need only Python. The Docker tests need the drill image:

    docker build -f images/server/Dockerfile -t cfo-wp25-server:dev .
    docker build -f scripts/restore-drill/staging/Dockerfile -t cfo-wp25-drill:dev .
    uv run --no-project --with pytest==9.1.1 --with httpx==0.28.1 --with hypothesis==6.169.0 \\
      --with boto3==1.40.0 \\
      pytest -p no:cacheprovider scripts/restore-drill/tests

The in-process tests (``inprocess/``) run inside the server image's test target, on the same
Docker network; ``test_fence_suite.py`` starts them.
"""

from __future__ import annotations

import os
import secrets
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

from harness_stack import BUCKET, PROJECT, Stack, docker, docker_ok  # noqa: E402

requires_docker = pytest.mark.skipif(not docker_ok(), reason="needs Docker and the drill image")

#: The in-process tests run inside the image (test_fence_suite.py starts them), never here.
collect_ignore = ["inprocess"]


def _create_bucket(stack: Stack) -> None:
    import boto3

    boto3.client(
        "s3",
        endpoint_url=stack.s3_url,
        region_name="us-east-1",
        aws_access_key_id=stack.env["CFO_IT_S3_USER"],
        aws_secret_access_key=stack.env["CFO_IT_S3_PASSWORD"],
    ).create_bucket(Bucket=BUCKET)


@pytest.fixture(scope="session")
def stack(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Stack]:
    if not docker_ok():
        pytest.skip("needs Docker and the drill image")
    workdir = tmp_path_factory.mktemp("drill")
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
        _create_bucket(stack)
        stack.reset_link()
        yield stack
        for server in list(stack.servers):
            server.remove()
        stack.scan()
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
