"""Copy one run's objects from X1's results bucket to the laptop, read-only.

    python3 -I spikes/x1/scripts/collect.py <run-id> <out-dir>

Lists runs/<run-id>/ with `cf r2 objects list` and fetches each object with `cf r2 objects get`,
into <out-dir>/<the key below runs/<run-id>/>: run.json, end.json, lifecycle/, probe/ and
server-log/, the layout analyze.py reads. Nothing is written to Cloudflare. The copy is raw;
run redact.py on it before it leaves the laptop.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

BUCKET = "cfo-stg-x1-transport-results"
RUN_ID = re.compile(r"^(run|preflight)-\d{8}T\d{6}Z$")
SAFE_PART = re.compile(r"^[A-Za-z0-9._-]+$")
PAGE = 1000

Runner = Callable[[list[str]], tuple[int, bytes, str]]


def staging_dir() -> Path:
    return Path(
        os.environ.get("CFO_STAGING_DIR")
        or Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        / "cloudflare-omnigent"
        / "staging"
    )


def cf_runner() -> Runner:
    config = json.loads((staging_dir() / "config.json").read_text())
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": config["accountId"]}

    def run(args: list[str]) -> tuple[int, bytes, str]:
        out = subprocess.run(["cf", *args], capture_output=True, env=env, check=False, timeout=300)
        return out.returncode, out.stdout, out.stderr.decode(errors="replace")

    return run


def listing(stdout: bytes) -> list[str]:
    data = json.loads(stdout)
    result = data.get("result", data) if isinstance(data, dict) else data
    if isinstance(result, dict):
        result = result.get("objects", [])
    if not isinstance(result, list):
        raise ValueError("unexpected object listing")
    return [o["key"] for o in result if isinstance(o, dict) and isinstance(o.get("key"), str)]


def list_keys(run: Runner, prefix: str) -> list[str]:
    keys: list[str] = []
    after: str | None = None
    while True:
        args = [
            "r2",
            "objects",
            "list",
            "--bucket-name",
            BUCKET,
            "--prefix",
            prefix,
            "--per-page",
            str(PAGE),
        ]
        if after:
            args += ["--start-after", after]
        code, stdout, stderr = run(args)
        if code != 0:
            raise RuntimeError(f"listing failed (exit {code}): {stderr.strip()[:200]}")
        page = listing(stdout)
        keys.extend(page)
        if len(page) < PAGE:
            return keys
        after = page[-1]


def local_path(out: Path, prefix: str, key: str) -> Path:
    """Where a key lands; refuses anything that is not a plain relative path below the prefix."""
    if not key.startswith(prefix):
        raise ValueError("a listed key is outside the run's prefix")
    parts = key[len(prefix) :].split("/")
    if not parts or not all(SAFE_PART.match(p) and p not in (".", "..") for p in parts):
        raise ValueError("a listed key is not a plain path")
    return out.joinpath(*parts)


def collect(run: Runner, run_id: str, out: Path) -> int:
    if not RUN_ID.match(run_id):
        raise ValueError("not a run ID")
    prefix = f"runs/{run_id}/"
    keys = list_keys(run, prefix)
    for key in keys:
        path = local_path(out, prefix, key)
        code, body, stderr = run(["r2", "objects", "get", key, "--bucket-name", BUCKET])
        if code != 0:
            raise RuntimeError(f"fetching an object failed (exit {code}): {stderr.strip()[:200]}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    return len(keys)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    count = collect(cf_runner(), argv[0], Path(argv[1]))
    print(f"{count} objects copied to {argv[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
