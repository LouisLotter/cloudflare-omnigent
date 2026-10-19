"""Read the spike's log lines back from Workers Logs (read-only API), into results/.

    python3 -I spikes/s2/scripts/collect.py <from-ms> <to-ms> <out.jsonl>

Keeps only lines that carry the "s2" marker, from the Worker (`{"s2": ...}`) and from the
computer container (`S2 {...}` on stdout), one JSON object per line with the log's own
timestamp. The account ID, zone and owner email are redacted.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT = "cfo-stg-s2-route"
STATE = Path(
    os.environ.get("CFO_STAGING_DIR")
    or Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    / "cloudflare-omnigent"
    / "staging"
)
PAGE_MS = 10 * 60_000


def secrets() -> list[tuple[str, str]]:
    config = json.loads((STATE / "config.json").read_text())
    pairs = [
        (config.get("accountId"), "<account>"),
        (config.get("ownerEmail"), "<owner-email>"),
        (config.get("zone"), "<zone>"),
    ]
    return [(v, m) for v, m in pairs if v]


def query(start: int, end: int, offset: str | None) -> list[dict]:
    body: dict[str, object] = {
        "queryId": "s2-collect",
        "timeframe": {"from": start, "to": end},
        "view": "events",
        "limit": 2000,
        "parameters": {
            "filters": [
                {
                    "key": "$workers.scriptName",
                    "operation": "eq",
                    "type": "string",
                    "value": SCRIPT,
                }
            ],
        },
    }
    if offset:
        body["offset"] = offset
    account = json.loads((STATE / "config.json").read_text())["accountId"]
    out = subprocess.run(
        ["cf", "o11y", "telemetry", "query", "--body", json.dumps(body)],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "CLOUDFLARE_ACCOUNT_ID": account},
    )
    if out.returncode != 0:
        raise RuntimeError(f"query failed (exit {out.returncode}): {out.stderr.strip()[:200]}")
    data = json.loads(out.stdout)
    result = data.get("result", data)
    events = (result.get("events") or {}).get("events") or []
    return events


def extract(event: dict) -> dict | None:
    """The s2 record in one Workers Logs event, with the event's own timestamp."""
    ts = event.get("timestamp") or (event.get("$metadata") or {}).get("timestamp")
    meta = event.get("$metadata") or {}
    message = meta.get("message") or event.get("message") or ""
    source = event.get("source")
    candidates = []
    if isinstance(source, dict):
        candidates.append(source)
    if isinstance(message, str):
        text = message.strip()
        if text.startswith("S2 "):
            text = text[3:]
        if text.startswith("{"):
            try:
                candidates.append(json.loads(text))
            except ValueError:
                pass
    for record in candidates:
        if "s2" in record or "k" in record:
            return {"logTs": ts, "origin": meta.get("type") or meta.get("origin"), **record}
    return None


def main() -> None:
    start, end, out_path = int(sys.argv[1]), int(sys.argv[2]), Path(sys.argv[3])
    pairs = secrets()
    seen: set[str] = set()
    records: list[dict] = []
    raw_count = 0
    window = start
    while window < end:
        stop = min(window + PAGE_MS, end)
        offset = None
        while True:
            events = query(window, stop, offset)
            raw_count += len(events)
            for event in events:
                key = (event.get("$metadata") or {}).get("id") or json.dumps(event, sort_keys=True)
                if key in seen:
                    continue
                seen.add(key)
                record = extract(event)
                if record is not None:
                    records.append(record)
            if len(events) < 2000:
                break
            offset = (events[-1].get("$metadata") or {}).get("id")
        window = stop
    records.sort(key=lambda r: (r.get("logTs") or 0, r.get("t") or r.get("ct") or 0))
    with out_path.open("w") as fh:
        for record in records:
            line = json.dumps(record, separators=(",", ":"))
            for value, mask in pairs:
                line = line.replace(value, mask)
            fh.write(line + "\n")
    print(f"{raw_count} events read, {len(records)} s2 records written to {out_path}")


if __name__ == "__main__":
    main()
