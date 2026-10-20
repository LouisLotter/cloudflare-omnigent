"""Independent teardown check for X1's two deployments, with read-only `cf` calls.

    python3 -I spikes/x1/scripts/teardown_check.py

Checks that nothing named cfo-stg-x1-… is left: both Workers, both container applications and
their registry images, the R2 bucket, the Tunnel, its DNS record, the VPC service, the service
token, the Access applications on all three hostnames and the staging registry's records, and
that none of the hostnames answers. Prints redacted results; exits 1 if anything is left or a
lookup's answer is unknown.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

PREFIX = "cfo-stg-x1"
TRANSPORT = "cfo-stg-x1-transport"
UI = "cfo-stg-x1-ui"
WORKERS = (TRANSPORT, UI)
CONTAINERS = (f"{TRANSPORT}-server", f"{TRANSPORT}-computer")
BUCKET = f"{TRANSPORT}-results"
TOKEN = f"{TRANSPORT}-svc"
PAGE = 100

Runner = Callable[[list[str]], tuple[int, object, str]]


def staging_dir() -> Path:
    return Path(
        os.environ.get("CFO_STAGING_DIR")
        or Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        / "cloudflare-omnigent"
        / "staging"
    )


def cf_runner(account: str) -> Runner:
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": account}

    def run(args: list[str]) -> tuple[int, object, str]:
        out = subprocess.run(["cf", *args], capture_output=True, text=True, env=env, check=False)
        try:
            body: object = json.loads(out.stdout) if out.stdout.strip() else None
        except ValueError:
            body = None
        if isinstance(body, dict) and "result" in body:
            body = body["result"]
        return out.returncode, body, out.stderr

    return run


def names(body: object, key: str = "name") -> list[str] | None:
    """The `key` of every item of a listing, or None when the answer is not a list of objects that
    each carry a non-empty string `key`: an answer of unknown shape, or an item without a name, is
    never taken for an empty listing or for someone else's resource (review AIR2-002)."""
    if not isinstance(body, list):
        return None
    found: list[str] = []
    for item in body:
        value = item.get(key) if isinstance(item, dict) else None
        if not isinstance(value, str) or value == "":
            return None
        found.append(value)
    return found


def listed(run: Runner, args: list[str], key: str = "name", paged: bool = True) -> list[str] | None:
    """Every page of a listing's names, or None if any page fails or has an unknown shape."""
    found: list[str] = []
    page = 1
    while True:
        command = [*args, "--per-page", str(PAGE), "--page", str(page)] if paged else args
        code, body, _ = run(command)
        items = names(body, key) if code == 0 else None
        if items is None:
            return None
        found += items
        if not paged or len(items) < PAGE:
            return found
        page += 1


def none_named(items: list[str] | None, prefix: str = PREFIX) -> bool:
    """Gone only if the listing is known and nothing in it starts with `prefix`, nonce-suffixed
    names included."""
    return items is not None and not [n for n in items if n.startswith(prefix)]


def checks(
    run: Runner, zone: str, registry: list[str], http: Callable[[str], str]
) -> list[tuple[str, bool]]:
    """(description, gone) for every resource X1 may have left. Every listing is matched by the
    cfo-stg-x1 prefix, locally and over all its pages; an unknown answer counts as not gone."""
    out: list[tuple[str, bool]] = []
    for name in WORKERS:
        code, _, err = run(["workers", "get", name])
        out.append((f"Worker {name} absent", code != 0 and "[10007]" in err and "404" in err))
    for name in CONTAINERS:
        apps = listed(run, ["containers", "applications", "list", "--name", name], paged=False)
        out.append((f"container application {name} absent", none_named(apps, name)))
    # An image's repository may sit under any field, so the whole answer is searched, but only
    # once every item is a non-empty object.
    code, body, _ = run(["containers", "images", "list"])
    images_known = (
        code == 0
        and isinstance(body, list)
        and all(isinstance(item, dict) and item for item in body)
    )
    out.append(
        (f"no registry image of {TRANSPORT}", images_known and TRANSPORT not in json.dumps(body))
    )
    code, _, err = run(["r2", "buckets", "get", BUCKET])
    out.append((f"R2 bucket {BUCKET} absent", code != 0 and "[10006]" in err and "404" in err))
    tunnels = listed(
        run,
        [
            "tunnels",
            "list",
            "--include-prefix",
            PREFIX,
            "--is-deleted",
            "false",
            "--tun-types",
            "cfd_tunnel",
        ],
    )
    out.append(("no live Tunnel cfo-stg-x1-…", none_named(tunnels)))
    records = listed(run, ["dns", "records", "list", "--zone", zone, "--name-startswith", PREFIX])
    out.append(("no DNS record cfo-stg-x1-…", none_named(records)))
    out.append(
        (
            "no VPC service cfo-stg-x1-…",
            none_named(listed(run, ["workers-vpc", "services", "list"])),
        )
    )
    # The token's name carries its create's nonce (`<deployment>-svc--<nonce>`), and the list
    # filters by exact name only: every token is listed and matched by prefix.
    tokens = listed(run, ["zero-trust", "access", "service-tokens", "list"])
    out.append((f"no service token {TOKEN}…", none_named(tokens, TOKEN)))
    hosts = [f"{TRANSPORT}.{zone}", f"{UI}.{zone}", f"{TRANSPORT}-tunnel.{zone}"]
    for host in hosts:
        domains = listed(
            run,
            ["zero-trust", "access", "applications", "list", "--domain", host, "--exact"],
            key="domain",
        )
        out.append(
            (f"no Access application on {host}", domains is not None and host not in domains)
        )
    for name in WORKERS:
        out.append((f"no staging registry record for {name}", name not in registry))
    for host in hosts:
        answer = http(f"https://{host}/")
        out.append((f"https://{host}/ does not answer ({answer})", not answer.startswith("HTTP 2")))
    return out


def http_status(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=15) as res:  # noqa: S310 - https only
            return f"HTTP {res.status}"
    except urllib.error.HTTPError as error:
        return f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001 - unreachable is the expected answer
        return type(error).__name__


def main() -> int:
    state = staging_dir()
    config = json.loads((state / "config.json").read_text())
    registry_file = state / "resources.json"
    registry = (
        [d["name"] for d in json.loads(registry_file.read_text()).get("deployments", [])]
        if registry_file.exists()
        else []
    )

    def say(line: str) -> None:
        for value, mask in ((config["accountId"], "<account>"), (config["zone"], "<zone>")):
            line = line.replace(value, mask)
        print(line, flush=True)

    say(f"checked at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    results = checks(cf_runner(config["accountId"]), config["zone"], registry, http_status)
    for what, gone in results:
        say(f"{'ok  ' if gone else 'LEFT'} {what}")
    return 0 if all(gone for _, gone in results) else 1


if __name__ == "__main__":
    sys.exit(main())
