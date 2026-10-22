"""Collect and analyse one WP2.2 staging run (test tooling, laptop only).

    python3 -I analyze.py collect <run-id> <out-dir>     copy runs/<run-id>/ from the bucket
    python3 -I analyze.py analyse <out-dir> [deploys.jsonl]

`collect` lists the run's objects with `cf r2 objects list` and fetches each with `cf r2 objects
get`, read-only. `analyse` reads the copy (run.json, end.json, events/, state/, server-log/) and
the deploy times run.sh recorded, and prints one JSON summary:

- every drop of the stand-in computer's connection and of each browser stream, its downtime, and
  what it lines up with: the forced reset, the platform deploy's version switch (240-420 s after
  its upload), the server container's stop, or nothing; drops inside the 15 minutes after the web
  deploy that line up with nothing are counted as the web deploy's;
- the watchdog case: the outage record and where its time went (stop to detection, detection to
  the new container's first log line, that line to the end of the outage);
- the bootstrap status at the end.

Run the copy through spikes/x1/scripts/redact.py before it leaves the laptop.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

BUCKET = "cfo-stg-wp22-platform-results"
RUN_ID = re.compile(r"^run-\d{8}T\d{6}Z$")
SAFE_PART = re.compile(r"^[A-Za-z0-9._-]+$")
PAGE = 1000


def staging_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(os.environ.get("CFO_STAGING_DIR") or Path(base) / "cloudflare-omnigent" / "staging")


def cf(args: list[str]) -> bytes:
    config = json.loads((staging_dir() / "config.json").read_text())
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": config["accountId"]}
    out = subprocess.run(["cf", *args], capture_output=True, env=env, check=False, timeout=300)
    if out.returncode != 0:
        raise RuntimeError(f"cf {args[0]} {args[1]} {args[2]} failed (exit {out.returncode})")
    return out.stdout


def collect(run_id: str, out: Path) -> int:
    if not RUN_ID.match(run_id):
        raise ValueError("not a run ID")
    prefix = f"runs/{run_id}/"
    keys: list[str] = []
    after: str | None = None
    while True:
        args = ["r2", "objects", "list", "--bucket-name", BUCKET, "--prefix", prefix]
        args += ["--per-page", str(PAGE)] + (["--start-after", after] if after else [])
        data = json.loads(cf(args))
        result = data.get("result", data) if isinstance(data, dict) else data
        if isinstance(result, dict):
            result = result.get("objects", [])
        page = [o["key"] for o in result if isinstance(o, dict) and isinstance(o.get("key"), str)]
        keys += page
        if len(page) < PAGE:
            break
        after = page[-1]
    for key in keys:
        parts = key[len(prefix) :].split("/")
        if not key.startswith(prefix) or not all(SAFE_PART.match(p) and p not in (".", "..") for p in parts):
            raise ValueError("a listed key is not a plain path below the run")
        path = out.joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(cf(["r2", "objects", "get", key, "--bucket-name", BUCKET]))
    return len(keys)


def load_jsonl(paths: list[Path]) -> list[dict]:
    rows: list[dict] = []
    for path in paths:
        for line in path.read_text().splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows


def drops(log: list[dict]) -> dict[str, list[dict]]:
    """Each client's closes, with the next open of the same client and the downtime."""
    by_client: dict[str, list[dict]] = {}
    for row in sorted(log, key=lambda r: r["wall"]):
        if row.get("ev") in ("open", "close"):
            by_client.setdefault(row["client"], []).append(row)
    last_wall_of_boot: dict[str, float] = {}
    for row in log:
        boot = row.get("boot")
        if boot is not None:
            last_wall_of_boot[boot] = max(last_wall_of_boot.get(boot, 0), row["wall"])
    out: dict[str, list[dict]] = {}
    for client, rows in by_client.items():
        found = []
        for i, row in enumerate(rows):
            if row["ev"] == "open" and i > 0 and rows[i - 1]["ev"] == "open":
                # Two opens without a close: the container that held the first one was stopped
                # before it could log the close. The drop came after its last log line.
                gone = last_wall_of_boot.get(rows[i - 1].get("boot"), rows[i - 1]["wall"])
                found.append(
                    {
                        "at": gone,
                        "code": None,
                        "boot": rows[i - 1].get("boot"),
                        "reopenedAt": row["wall"],
                        "downMs": None,
                        "note": "no close logged: its container was stopped; downtime unknown",
                    }
                )
                continue
            if row["ev"] != "close":
                continue
            reopen = next((r for r in rows[i + 1 :] if r["ev"] == "open"), None)
            found.append(
                {
                    "at": row["wall"],
                    "code": row.get("code"),
                    "boot": row.get("boot"),
                    "reopenedAt": reopen["wall"] if reopen else None,
                    "downMs": round(reopen["wall"] - row["wall"], 1) if reopen else None,
                }
            )
        out[client] = found
    return out


def classify(at: float, marks: dict[str, float | None]) -> str:
    reset, switch_from, stop, web = (marks.get(k) for k in ("reset", "platformUpload", "stop", "webUpload"))
    if reset is not None and reset - 1_000 <= at <= reset + 15_000:
        return "forced_reset"
    if switch_from is not None and switch_from + 240_000 <= at <= switch_from + 420_000:
        return "version_switch"
    if stop is not None and stop - 1_000 <= at <= stop + 180_000:
        return "server_restart"
    if web is not None and web <= at <= web + 900_000:
        return "web_deploy"
    return "unexplained"


def analyse(out: Path, deploys_path: Path | None) -> dict:
    run = json.loads((out / "run.json").read_text())
    end = json.loads((out / "end.json").read_text()) if (out / "end.json").exists() else None
    events = [json.loads(p.read_text()) for p in sorted((out / "events").glob("*.json"))]
    states = [json.loads(p.read_text()) for p in sorted((out / "state").glob("*.json"))]
    log = load_jsonl(sorted((out / "server-log").glob("*.jsonl")))
    deploys = load_jsonl([deploys_path]) if deploys_path and deploys_path.exists() else []

    def first(name: str) -> dict | None:
        return next((e for e in events if e["event"] == name), None)

    reset = first("reset_requested")
    stop = first("container_stop_requested")
    stop_at = (stop or {}).get("result", {}).get("at") if stop else None
    web = next((d for d in deploys if d.get("target") == "web" and d.get("t0Offset", -1) > 0), None)
    platform = next((d for d in deploys if d.get("target") == "platform" and d.get("t0Offset", -1) > 0), None)
    marks = {
        "reset": reset["at"] if reset else None,
        "webUpload": web.get("end") if web else None,
        "platformUpload": platform.get("end") if platform else None,
        "stop": stop_at,
    }
    per_client = drops(log)
    summary_clients = {}
    for client, found in per_client.items():
        for d in found:
            d["cause"] = classify(d["at"], marks)
        summary_clients[client] = {
            "drops": found,
            "byCause": {c: sum(1 for d in found if d["cause"] == c) for c in {d["cause"] for d in found}},
            "maxDownMs": max((d["downMs"] or 0 for d in found), default=0),
        }

    outages = states[-1]["outages"] if states else []
    watchdog = None
    if stop_at is not None:
        record = next((o for o in outages if Date(o["detectedAt"]) >= stop_at - 1_000), None)
        boots = sorted({r["boot"]: r["wall"] for r in log if r.get("ev") == "boot"}.items(), key=lambda kv: kv[1])
        new_boot = next((wall for _, wall in boots if wall > stop_at), None)
        if record:
            detected, ended = Date(record["detectedAt"]), Date(record["endedAt"]) if record["endedAt"] else None
            watchdog = {
                "record": record,
                "stopToDetectedMs": detected - stop_at,
                "detectedToNewBootMs": (new_boot - detected) if new_boot else None,
                "newBootToReadyMs": (ended - new_boot) if (ended and new_boot) else None,
                "stopToReadyMs": (ended - stop_at) if ended else None,
            }
    reset_restarted_server = bool(
        reset and any(r.get("ev") == "boot" and reset["at"] <= r["wall"] <= reset["at"] + 60_000 for r in log)
    )
    return {
        "runId": run["runId"],
        "ended": end is not None,
        "marks": marks,
        "clients": summary_clients,
        "resetRestartedServerContainer": reset_restarted_server,
        "watchdog": watchdog,
        "outages": outages,
        "bootstrap": states[-1]["bootstrap"] if states else None,
    }


def Date(iso: str) -> float:  # noqa: N802 - mirrors Date.parse
    from datetime import datetime

    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[0] == "collect":
        print(f"{collect(argv[1], Path(argv[2]))} objects copied")
        return 0
    if len(argv) >= 2 and argv[0] == "analyse":
        deploys = Path(argv[2]) if len(argv) > 2 else None
        print(json.dumps(analyse(Path(argv[1]), deploys), indent=2))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
