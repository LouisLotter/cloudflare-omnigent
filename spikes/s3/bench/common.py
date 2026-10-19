"""Shared helpers for the S3 bench scripts. Standard library only.

Run every script from the repository root, for example:
  python3 spikes/s3/bench/up.py
"""

from __future__ import annotations

import json
import os
import secrets
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
SPIKE = ROOT / "spikes" / "s3"
RESULTS = SPIKE / "results"
COMPOSE = ["docker", "compose", "-p", "cfo-s3", "-f", str(SPIKE / "compose.yaml")]
ENV_FILE = Path("/tmp/cfo-s3.env")  # generated MinIO values; never committed

SUP = "http://127.0.0.1:17070"
SUP2 = "http://127.0.0.1:17071"
SRV = "http://127.0.0.1:18000"
MOCK = "http://127.0.0.1:19999"


def env() -> dict[str, str]:
    if not ENV_FILE.exists():
        ENV_FILE.write_text(
            f"S3_MINIO_KEY=s3spike{secrets.token_hex(4)}\nS3_MINIO_SECRET={secrets.token_hex(16)}\n"
        )
        ENV_FILE.chmod(0o600)
    out = dict(os.environ)
    for line in ENV_FILE.read_text().splitlines():
        k, _, v = line.partition("=")
        out[k] = v
    return out


def compose(*args: str, extra_env: dict[str, str] | None = None, check: bool = True) -> str:
    e = env()
    e.update(extra_env or {})
    p = subprocess.run([*COMPOSE, *args], env=e, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"compose {args} failed: {p.stderr[-2000:]}")
    return p.stdout


def docker(*args: str, check: bool = True) -> str:
    p = subprocess.run(["docker", *args], capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"docker {args} failed: {p.stderr[-2000:]}")
    return p.stdout


def http(method: str, url: str, body: Any = None, timeout: float = 600, headers: dict[str, str] | None = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            code = r.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        code = exc.code
    try:
        return code, json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return code, raw.decode(errors="replace")


def sup(path: str, body: Any = None, base: str = SUP, timeout: float = 600) -> Any:
    code, out = http("POST" if body is not None else "GET", base + path, body, timeout=timeout)
    if code != 200:
        raise RuntimeError(f"supervisor {path}: {code} {out}")
    return out


def wait_for(fn: Any, timeout: float, interval: float = 0.5, what: str = "condition") -> Any:
    deadline = time.monotonic() + timeout
    last: Any = None
    while time.monotonic() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {what}: {last!r}")


def as_agent(argv: list[str], timeout: float = 300, env_extra: dict[str, str] | None = None, base: str = SUP, cwd: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"argv": argv, "timeout": timeout, "env": env_extra or {}}
    if cwd:
        body["cwd"] = cwd
    return sup("/exec", body, base=base, timeout=timeout + 30)


def stats(xs: list[float]) -> dict[str, float]:
    if not xs:
        return {}
    return {"n": len(xs), "median": round(statistics.median(xs), 3), "worst": round(max(xs), 3),
            "best": round(min(xs), 3)}


def meta() -> dict[str, Any]:
    def run(*a: str) -> str:
        p = subprocess.run(list(a), capture_output=True, text=True, cwd=ROOT)
        return p.stdout.strip()
    return {
        "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "spike_commit": run("git", "rev-parse", "HEAD"),
        "computer_image": run("docker", "image", "inspect", "cfo-s3-computer:spike", "--format", "{{.Id}}"),
        "host_cpus": os.cpu_count(),
        "docker": run("docker", "version", "--format", "{{.Server.Version}}"),
        "kernel": os.uname().release,
    }


def save(name: str, obj: Any) -> Path:
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"{name}.json"
    script = Path(sys.argv[0]).resolve()
    rel = str(script.relative_to(ROOT)) if script.is_relative_to(ROOT) else script.name
    path.write_text(json.dumps({"meta": meta(), "script": rel, "argv": sys.argv[1:], "data": obj}, indent=1))
    print(f"wrote {path.relative_to(ROOT)}")
    return path
