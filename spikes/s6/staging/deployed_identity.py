"""Record the deployed identity of the S6 staging Worker and container (read-only; IR-010).

Runs the read-only `wrangler deployments status`, `wrangler containers list --json` and
`cf containers applications versions list` with the owner's existing logins and the staging account from the staging tool's local config,
and prints the active Worker version and its traffic share, and the image digest of the container
application version that serves (the application record itself lags behind a rollout). Account IDs are masked; nothing is created, changed or deleted.

  python3 -I spikes/s6/staging/deployed_identity.py [--out FILE]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

NAME = "cfo-stg-s6-creds"
CONTAINER = "cfo-stg-s6-creds-pc"
REPO = Path(__file__).resolve().parents[3]
WRANGLER = REPO / "worker" / "node_modules" / ".bin" / "wrangler"


def run(args: list[str], env: dict) -> str:
    r = subprocess.run([str(WRANGLER), *args], capture_output=True, text=True, env=env, timeout=120, cwd="/tmp")
    if r.returncode != 0:
        raise SystemExit(f"wrangler {' '.join(args[:2])} failed ({r.returncode})")
    return r.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    a = ap.parse_args()
    state = Path(os.environ.get("CFO_STAGING_DIR") or Path.home() / ".config" / "cloudflare-omnigent" / "staging")
    account = json.loads((state / "config.json").read_text())["accountId"]
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": account}
    mask = lambda t: t.replace(account, "<account>")  # noqa: E731

    status = mask(run(["deployments", "status", "--name", NAME], env))
    versions = re.findall(r"\((\d+)%\)\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", status)
    created = re.search(r"Created:\s*(\S+)", status)  # the status also names the author: not kept
    apps = json.loads(run(["containers", "list", "--json"], env))
    app = next((x for x in apps if x.get("name") == CONTAINER), None)
    image = mask(json.dumps(app.get("image"))) if app else None
    # The application's own "image" lags behind a rollout; its versions say which image serves.
    serving = []
    if app:
        r = subprocess.run(["cf", "containers", "applications", "versions", "list", "--application-id", app["id"]],
                           capture_output=True, text=True, env=env, timeout=60)
        if r.returncode == 0:
            data = json.loads(r.stdout)
            items = data if isinstance(data, list) else data.get("result", [])
            serving = [{"version": v.get("version"), "percentage": v.get("percentage"),
                        "image": mask(v.get("configuration", {}).get("image", ""))}
                       for v in items if v.get("percentage")]
    out = {
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "worker": NAME,
        "active_versions": [{"version_id": v, "traffic_percent": int(p)} for p, v in versions],
        "deployment_created": created.group(1) if created else None,
        "container_application": CONTAINER if app else None,
        "container_image_serving": serving,
        "container_application_record": {"version": (app or {}).get("version"), "image": json.loads(image) if image else None},
        "container_instances": (app or {}).get("instances"),
    }
    text = json.dumps(out, indent=2)
    if a.out:
        Path(a.out).write_text(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
