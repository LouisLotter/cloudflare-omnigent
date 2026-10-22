"""Collect and analyse one WP3.3 staging run (test tooling, laptop only).

    python3 -I analyze.py collect <bucket> <run-id> <out-dir>   copy runs/<run-id>/ from the bucket
    python3 -I analyze.py analyse <out-dir> [deploys.jsonl]

`collect` lists the run's objects with `cf r2 objects list` and fetches each with `cf r2 objects
get`, read-only. `analyse` reads the copy (run.json, end.json, rows-*.jsonl) and prints one JSON
summary:

- every disruption (forced reset, server container stop, the platform deploy's version switch)
  and, for each stand-in computer and route, when the connection's end reached the computer
  after it, how (a close frame and its code, the transport's end, or the probe's own 75 s silence
  deadline), and when it was open again;
- the bridge route's own view of each server-side end (when the Worker saw it);
- the large-message ladder and the flood counts per route;
- the start bench's cycles.

Run the copy through spikes/x1/scripts/redact.py before it leaves the laptop.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

RUN_ID = re.compile(r"^run-\d{8}T\d{6}Z$")
BUCKET = re.compile(r"^cfo-stg-wp33-[a-z]+-results$")
SAFE_PART = re.compile(r"^[A-Za-z0-9._-]+$")
PAGE = 1000
WINDOW_MS = 120_000


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


def collect(bucket: str, run_id: str, out: Path) -> int:
    if not RUN_ID.match(run_id) or not BUCKET.match(bucket):
        raise ValueError("not a run ID or not a wp33 bucket")
    prefix = f"runs/{run_id}/"
    keys: list[str] = []
    after: str | None = None
    while True:
        args = ["r2", "objects", "list", "--bucket-name", bucket, "--prefix", prefix]
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
        path.write_bytes(cf(["r2", "objects", "get", key, "--bucket-name", bucket]))
    return len(keys)


def rows(out: Path, kind: str) -> list[dict]:
    path = out / f"rows-{kind}.jsonl"
    if not path.exists():
        return []
    found = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                found.append(json.loads(line))
            except ValueError:
                pass
    return found


def disruptions(events: list[dict], server: list[dict], deploys: list[dict], t0: float) -> list[dict]:
    found: list[dict] = []
    n_reset = 0
    for ev in events:
        if ev.get("ev") == "reset_requested":
            n_reset += 1
            found.append({"kind": "reset", "n": n_reset, "at": ev["wall"]})
        if ev.get("ev") == "stop_done" and isinstance(ev.get("result"), dict):
            found.append({"kind": "stop", "at": ev["result"].get("at", ev["wall"])})
    # The version switch: the server's own close records (code 1006 or None) for computer
    # connections, 200-450 s after a platform upload that ended during the run.
    for deploy in deploys:
        if deploy.get("target") != "platform" or deploy.get("end", 0) < t0:
            continue
        lo, hi = deploy["end"] + 200_000, deploy["end"] + 450_000
        closes = [
            r["wall"]
            for r in server
            if r.get("ev") == "close" and lo <= r["wall"] <= hi and "ladder" not in r.get("client", "")
        ]
        near_other = any(abs(d["at"] - min(closes)) < 30_000 for d in found) if closes else True
        if closes and not near_other:
            found.append(
                {"kind": "switch", "at": min(closes), "uploadEnd": deploy["end"],
                 "afterUploadS": round((min(closes) - deploy["end"]) / 1000, 1)}
            )
    return sorted(found, key=lambda d: d["at"])


def analyse(out: Path, deploys_path: Path | None) -> dict:
    run = json.loads((out / "run.json").read_text())
    events = rows(out, "event")
    probe = rows(out, "probe")
    notes = rows(out, "note")
    server = rows(out, "server")
    bench = rows(out, "bench")
    deploys: list[dict] = []
    if deploys_path and deploys_path.exists():
        deploys = [json.loads(l) for l in deploys_path.read_text().splitlines() if l.strip()]
    found = disruptions(events, server, deploys, run["t0"])
    ends = [r for r in probe if r.get("ev") == "end"]
    opens = [r for r in probe if r.get("ev") == "open"]
    pairs = sorted({(r["variant"], r["host"]) for r in opens})
    table = []
    for d in found:
        row = {**d, "atT0S": round((d["at"] - run["t0"]) / 1000, 1), "computers": {}}
        for variant, host in pairs:
            candidates = [
                e for e in ends
                if e["variant"] == variant and e["host"] == host and d["at"] - 2000 <= e["wall"] <= d["at"] + WINDOW_MS
            ]
            key = f"{variant}/{host.split('.')[0]}"
            if not candidates:
                row["computers"][key] = {"end": None}
                continue
            e = min(candidates, key=lambda r: r["wall"])
            back = [o for o in opens if o["variant"] == variant and o["host"] == host and o["wall"] >= e["wall"]]
            reopened = min((o["wall"] for o in back), default=None)
            row["computers"][key] = {
                "endAfterS": round((e["wall"] - d["at"]) / 1000, 2),
                "by": e.get("by"),
                "code": e.get("code"),
                "error": e.get("error"),
                "lastReplyBeforeS": round((d["at"] - e["wall_last_reply"]) / 1000, 2) if e.get("wall_last_reply") else None,
                "backAfterS": round((reopened - d["at"]) / 1000, 2) if reopened else None,
            }
        bridge = [n for n in notes if n.get("ev") == "bridge_end" and n.get("from") == "server"
                  and d["at"] - 2000 <= n["wall"] <= d["at"] + WINDOW_MS]
        row["bridgeSawServerEnd"] = {
            n["variant"]: {"afterS": round((n["wall"] - d["at"]) / 1000, 2), "code": n.get("code")}
            for n in sorted(bridge, key=lambda n: n["wall"], reverse=True)
        }
        table.append(row)
    unexplained = []
    for e in ends:
        if not any(d["at"] - 2000 <= e["wall"] <= d["at"] + WINDOW_MS for d in found):
            unexplained.append({k: e.get(k) for k in ("variant", "host", "wall", "by", "code", "error")})
    ladder = [{k: r.get(k) for k in ("variant", "host", "mib", "ok", "ms", "by", "code", "error")}
              for r in probe if r.get("ev") == "ladder"]
    flood = {}
    for r in probe:
        if r.get("ev") in ("flood", "flood_end", "flood_open"):
            flood.setdefault(f"{r['variant']}/{r['host'].split('.')[0]}", []).append(
                {k: r.get(k) for k in ("ev", "attempt", "sent", "received", "s", "by", "code", "error")}
            )
    flood_summary = {k: [v for v in vs if v["ev"] != "flood"] + ([vs[-1]] if vs and vs[-1]["ev"] == "flood" else [])
                     for k, vs in flood.items()}
    cycles = [r for r in bench if r.get("ev") == "cycle"]
    binary = {}
    for e in ends:
        key = f"{e['variant']}/{e['host'].split('.')[0]}"
        agg = binary.setdefault(key, {"ok": 0, "bad": 0})
        agg["ok"] += e.get("binary_ok", 0) or 0
        agg["bad"] += e.get("binary_bad", 0) or 0
    return {
        "runId": run["runId"],
        "mode": run["mode"],
        "t0": run["t0"],
        "disruptions": table,
        "unexplainedEnds": unexplained,
        "binaryEchoes": binary,
        "ladder": ladder,
        "flood": flood_summary,
        "bench": cycles,
        "events": [{k: v for k, v in e.items() if k in ("ev", "wall", "result", "error")} for e in events],
    }


def main(argv: list[str]) -> int:
    if len(argv) >= 4 and argv[0] == "collect":
        print(collect(argv[1], argv[2], Path(argv[3])), "objects")
        return 0
    if len(argv) >= 2 and argv[0] == "analyse":
        deploys = Path(argv[2]) if len(argv) >= 3 else None
        print(json.dumps(analyse(Path(argv[1]), deploys), indent=1))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
