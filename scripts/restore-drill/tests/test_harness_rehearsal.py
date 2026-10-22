"""A rehearsal of the staging measurement run, locally, with a short plan.

The drill image's default command is the harness. This test plays the harness Worker's part:
it starts the container with the environment the Durable Object passes, polls the status port,
reads every result, then kills the container and starts the replaced one, exactly as the
Durable Object does on staging. Only the sizes and counts are smaller, and the "R2" is the S3
stand-in behind Toxiproxy.
"""

from __future__ import annotations

import json
import secrets
import time
import uuid
from typing import Any

import httpx

from conftest import requires_docker
from harness_stack import BUCKET, IMAGE, NETWORK, Stack, docker

pytestmark = requires_docker

PLAN = "env,drill,barrier-1s,barrier-200ms,idle-1s,restore-20mb,restore-60mb,cf-replacement"


def _start(stack: Stack, name: str, env: dict[str, str]) -> int:
    env_file = stack.workdir / f"{name}.env"
    env_file.write_text("".join(f"{k}={v}\n" for k, v in env.items()))
    env_file.chmod(0o600)
    try:
        docker(
            "run", "-d", "--name", name, "--network", NETWORK, "-p", "127.0.0.1::8002",
            "--env-file", str(env_file), IMAGE,
        )
    finally:
        env_file.unlink()
    return int(docker("port", name, "8002/tcp").stdout.split(":")[-1])


def _wait(port: int, until: Any, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    status: dict[str, Any] = {}
    while time.monotonic() < deadline:
        try:
            status = httpx.get(f"http://127.0.0.1:{port}/status", timeout=10).json()
        except (httpx.HTTPError, ValueError):
            status = {}
        if status and until(status):
            return status
        time.sleep(1)
    raise AssertionError(f"harness did not finish: {status}")


def _results(port: int, names: list[str]) -> dict[str, Any]:
    return {n: httpx.get(f"http://127.0.0.1:{port}/results/{n}", timeout=30).json() for n in names}


def _save_logs(stack: Stack, name: str) -> None:
    logs = stack.workdir / "logs"
    logs.mkdir(exist_ok=True)
    result = docker("logs", name, check=False)
    (logs / f"{name}.log").write_text(result.stdout + result.stderr)


def test_measurement_run_and_container_replacement(stack: Stack) -> None:
    stack.unblock()
    run_id = f"rehearsal-{uuid.uuid4().hex[:6]}"
    env = {
        "DRILL_RUN_ID": run_id,
        "DRILL_PLAN": PLAN,
        "DRILL_BUCKET": BUCKET,
        "DRILL_ENDPOINT": "http://toxiproxy:9000",
        "DRILL_REGION": "us-east-1",
        "DRILL_OWNER_PASSWORD": f"owner-{secrets.token_hex(12)}",
        "DRILL_COOKIE_SECRET": secrets.token_hex(32),
        "DRILL_BARRIER_WRITES": "15",
        "DRILL_BARRIER_ITEMS": "8",
        "DRILL_IDLE_S": "5",
        "LITESTREAM_ACCESS_KEY_ID": stack.env["CFO_IT_S3_USER"],
        "LITESTREAM_SECRET_ACCESS_KEY": stack.env["CFO_IT_S3_PASSWORD"],
    }
    stack.extra_canaries += [env["DRILL_OWNER_PASSWORD"], env["DRILL_COOKIE_SECRET"]]
    first = f"cfo-wp25-server-harness-{uuid.uuid4().hex[:6]}"
    second = f"cfo-wp25-server-replaced-{uuid.uuid4().hex[:6]}"
    try:
        port = _start(stack, first, env)
        status = _wait(port, lambda s: s.get("awaiting_replacement") or s.get("done"), 1500)
        results = _results(port, status["results"])
        reports = stack.workdir / "reports"
        reports.mkdir(exist_ok=True)
        (reports / f"{run_id}.json").write_text(json.dumps(results, indent=2))
        assert status["errors"] == {}, {k: results[k].get("error") for k in status["errors"]}
        assert set(results) == set(PLAN.split(","))

        assert results["env"]["litestream"] == "0.5.17"
        drill = results["drill"]
        assert drill["ok"], drill
        assert drill["drill_side_restore"]["ok"] and drill["drill_after_replacement"]["ok"]
        assert all(c["ok"] for c in drill["http_checks"])
        assert drill["replacement"]["source"] == "restored"
        for sync in ("1s", "200ms"):
            barrier = results[f"barrier-{sync}"]
            assert barrier["writes"]["n"] == 15 and barrier["items"]["n"] == 8
            assert barrier["barrier_wait_ms"]["n"] == 15
            assert barrier["writes_unconfirmed"] == 0 and barrier["items_refused"] == 0
        assert results["idle-1s"]["seconds"] >= 5
        for size in (20, 60):
            restore = results[f"restore-{size}mb"]
            assert restore["ok"], restore
            assert restore["replacement"]["source"] == "restored"
            assert restore["resnapshot"]["first_confirmed_write_at_s"] is not None
        assert results["restore-20mb"]["drill_side_restore"]["ok"]

        waiting = status["awaiting_replacement"]
        assert waiting and waiting["prefix"] == "restore-60mb"
        # The Durable Object's part: kill the container, start the replaced one.
        docker("kill", "-s", "KILL", first, check=False)
        _save_logs(stack, first)
        docker("rm", "-f", first, check=False)
        replaced_env = {
            **env,
            "DRILL_MODE": "replaced",
            "DRILL_REPLACED_PREFIX": waiting["prefix"],
            "DRILL_REPLACED_MANIFEST": waiting["manifest"],
            "DRILL_REPLACED_FILLER_ROWS": str(waiting["filler_rows"]),
        }
        port = _start(stack, second, replaced_env)
        status = _wait(port, lambda s: s.get("done"), 600)
        replaced = _results(port, ["cf-replacement-container"])["cf-replacement-container"]
        (reports / f"{run_id}-replaced.json").write_text(json.dumps(replaced, indent=2))
        assert replaced["ok"], replaced
        assert replaced["acknowledged_changes"]["detail"]["missing"] == []
        assert replaced["filler_rows"] == waiting["filler_rows"]
    finally:
        for name in (first, second):
            _save_logs(stack, name)
            docker("rm", "-f", name, check=False)
