"""Independent teardown check for cfo-stg-s2-route, with read-only `cf` calls.

    python3 -I spikes/s2/scripts/teardown_check.py

Checks the Worker, both container applications, their registry images, the Access
application on the hostname, and the staging registry record. Prints redacted results.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

NAME = "cfo-stg-s2-route"
CONTAINERS = [f"{NAME}-server", f"{NAME}-computer"]
STATE = Path(
    os.environ.get("CFO_STAGING_DIR")
    or Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    / "cloudflare-omnigent"
    / "staging"
)
CONFIG = json.loads((STATE / "config.json").read_text())
HOSTNAME = f"{NAME}.{CONFIG['zone']}"
ENV = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": CONFIG["accountId"]}


def cf(*args: str) -> tuple[int, object, str]:
    out = subprocess.run(["cf", *args], capture_output=True, text=True, env=ENV, check=False)
    try:
        body = json.loads(out.stdout) if out.stdout.strip() else None
    except ValueError:
        body = out.stdout[:200]
    if isinstance(body, dict) and "result" in body:
        body = body["result"]
    return out.returncode, body, out.stderr


def say(line: str) -> None:
    for value, mask in [(CONFIG["accountId"], "<account>"), (CONFIG["zone"], "<zone>")]:
        line = line.replace(value, mask)
    print(line, flush=True)


def main() -> None:
    say(f"checked at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    code, _, err = cf("workers", "get", NAME)
    gone = code != 0 and "[10007]" in err and "404" in err
    say(f"worker {NAME}: {'absent ([10007] 404)' if gone else f'PRESENT or unknown (exit {code})'}")
    for name in CONTAINERS:
        code, apps, _ = cf("containers", "applications", "list", "--name", name)
        matching = [a for a in (apps or []) if isinstance(a, dict) and a.get("name") == name]
        say(f"container application {name}: {len(matching)} found (exit {code})")
    code, images, _ = cf("containers", "images", "list")
    text = json.dumps(images)
    for name in CONTAINERS:
        say(f"registry images for {name}: {text.count(name)} references (exit {code})")
    code, apps, _ = cf(
        "zero-trust", "access", "applications", "list", "--domain", HOSTNAME, "--exact"
    )
    say(f"Access applications on {HOSTNAME}: {len(apps or [])} (exit {code})")
    registry = json.loads((STATE / "resources.json").read_text())
    names = [d["name"] for d in registry.get("deployments", [])]
    say(f"staging registry record for {NAME}: {'present' if NAME in names else 'absent'}")
    try:
        with urllib.request.urlopen(f"https://{HOSTNAME}/s2/status", timeout=15) as res:
            say(f"https://{HOSTNAME}/s2/status: HTTP {res.status}")
    except urllib.error.HTTPError as error:
        say(f"https://{HOSTNAME}/s2/status: HTTP {error.code}")
    except Exception as error:  # noqa: BLE001 - unreachable is the expected answer
        say(f"https://{HOSTNAME}/s2/status: {type(error).__name__}")


if __name__ == "__main__":
    main()
