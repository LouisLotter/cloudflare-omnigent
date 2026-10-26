"""Runs ``tests/inprocess`` (the launcher fence, FH-29) inside the server image's test target.

The in-process tests need Omnigent, Litestream and the image's ``cfo_server``, which the
image's ``test`` target has; they need the S3 stand-in and Toxiproxy, which this suite's
stack runs. So they run in a container on the stack's network, with this directory mounted
read-only and the stack's generated credentials passed in an environment file.
"""

from __future__ import annotations

import os
import subprocess

from conftest import requires_docker
from harness_stack import BUCKET, HERE, NETWORK, PROJECT, Stack, docker

pytestmark = requires_docker

TEST_IMAGE = os.environ.get("CFO_FENCE_IMAGE", "cfo-wp25-server:test")


def test_launcher_fence_in_process(stack: Stack) -> None:
    if docker("image", "inspect", TEST_IMAGE, check=False).returncode != 0:
        raise AssertionError(f"build the image's test target as {TEST_IMAGE} first")
    stack.unblock()
    env_file = stack.workdir / "fence.env"
    env_file.write_text(
        "".join(
            f"{k}={v}\n"
            for k, v in {
                "CFO_FENCE_S3_USER": stack.env["CFO_IT_S3_USER"],
                "CFO_FENCE_S3_PASSWORD": stack.env["CFO_IT_S3_PASSWORD"],
                "CFO_FENCE_TOXI": "http://toxiproxy:8474",
                "CFO_FENCE_ENDPOINT": "http://toxiproxy:9000",
                "CFO_FENCE_BUCKET": BUCKET,
                "PYTHONPATH": "/opt/cfo:/opt/drill:/opt/drill/tests/inprocess",
            }.items()
        )
    )
    env_file.chmod(0o600)
    try:
        result = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--name",
                f"{PROJECT}-server-fence",
                "--network",
                NETWORK,
                "--env-file",
                str(env_file),
                "-v",
                f"{HERE.parent}:/opt/drill:ro",
                TEST_IMAGE,
                "python",
                "-m",
                "pytest",
                "-q",
                "-p",
                "no:cacheprovider",
                "--confcutdir=/opt/drill/tests/inprocess",
                "-o",
                "testpaths=",
                "/opt/drill/tests/inprocess",
            ],
            capture_output=True,
            text=True,
            timeout=900,
        )
    finally:
        env_file.unlink()
    logs = stack.workdir / "logs"
    logs.mkdir(exist_ok=True)
    (logs / "fence-suite.log").write_text(result.stdout + result.stderr)
    assert result.returncode == 0, (result.stdout + result.stderr)[-6000:]
    assert " passed" in result.stdout and " failed" not in result.stdout
