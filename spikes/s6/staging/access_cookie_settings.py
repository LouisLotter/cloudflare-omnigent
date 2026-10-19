"""Read the cookie settings of the S6 staging Access application (read-only; spike S6, IR-010).

Uses the `cf` CLI's existing login and the staging account from the staging tool's local config,
lists the Access application for the S6 hostname, and prints only its cookie and session
attributes. Prints no account ID, email, application ID or audience tag.

  python3 -I spikes/s6/staging/access_cookie_settings.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

NAME = "cfo-stg-s6-creds"
FIELDS = [
    "same_site_cookie_attribute",
    "http_only_cookie_attribute",
    "path_cookie_attribute",
    "enable_binding_cookie",
    "session_duration",
    "options_preflight_bypass",
    "cors_headers",
    "skip_interstitial",
    "app_launcher_visible",
    "auto_redirect_to_identity",
    "type",
]


def main() -> int:
    state = Path(os.environ.get("CFO_STAGING_DIR") or Path.home() / ".config" / "cloudflare-omnigent" / "staging")
    config = json.loads((state / "config.json").read_text())
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": config["accountId"]}
    r = subprocess.run(["cf", "zero-trust", "access", "applications", "list", "--name", NAME, "--exact"],
                       capture_output=True, text=True, env=env, timeout=60)
    if r.returncode != 0:
        print(json.dumps({"error": "cf exited non-zero", "exit": r.returncode}))
        return 1
    data = json.loads(r.stdout)
    apps = data if isinstance(data, list) else data.get("result", data.get("items", []))
    zone = config["zone"]
    apps = [a for a in apps if a.get("name") == NAME and a.get("domain") == f"{NAME}.{zone}"]
    out = {"applications_found": len(apps)}
    if apps:
        app = apps[0]
        out["settings"] = {k: app.get(k, "<not set: Cloudflare default>") for k in FIELDS}
        out["policies"] = [{"decision": p.get("decision"), "include_kinds": sorted({k for i in p.get("include", []) for k in i})}
                           for p in app.get("policies", [])]
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
