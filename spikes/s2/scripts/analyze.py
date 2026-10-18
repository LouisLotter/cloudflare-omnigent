"""Summarise the S2 measurements: the uninterrupted soak, and reconnection after each deploy.

    python3 -I spikes/s2/scripts/analyze.py <records.jsonl> <deploys.jsonl> <soak-from-ms> <soak-to-ms>

Input is collect.py's output (Worker lines carry "s2" and "t"; computer reports carry "k" and
"ct", either straight from container stdout or wrapped in the Worker's "report" line under
"r"). Times are UTC milliseconds: "t" from the Worker, "ct" from the computer, deploy times
from the laptop. All three clocks are NTP-synchronised.
"""

from __future__ import annotations

import json
import re
import statistics
import sys
from pathlib import Path


def load(path: Path) -> tuple[list[dict], list[dict]]:
    worker: list[dict] = []
    computer: dict[tuple, dict] = {}
    for line in path.read_text().splitlines():
        record = json.loads(line)
        if record.get("s2") == "report" and isinstance(record.get("r"), dict):
            report = record["r"]
        elif "k" in record and "ct" in record:
            report = record
        elif "s2" in record:
            worker.append(record)
            continue
        else:
            continue
        # The same report arrives twice (stdout and the report route): keep one.
        key = (report.get("k"), report.get("ct"), report.get("boot"), report.get("n"))
        computer[key] = report
    return worker, sorted(computer.values(), key=lambda r: r["ct"])


def pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * p))], 1)


def live_time(build: str, deploy_dir: Path) -> int | None:
    """Laptop time of Wrangler's "Uploaded" line: the new version is active from then on."""
    log = deploy_dir / f"{build}.log"
    if not log.exists():
        return None
    for line in log.read_text().splitlines():
        match = re.match(r"(\d{13}) Uploaded ", line)
        if match:
            return int(match.group(1))
    return None


def soak(reports: list[dict], worker: list[dict], start: int, end: int) -> dict:
    window = [r for r in reports if start <= r["ct"] <= end]
    minutes = [r for r in window if r["k"] == "echo-minute"]
    rtt_p50 = [r["p50"] for r in minutes if r.get("p50") is not None]
    rtt_p95 = [r["p95"] for r in minutes if r.get("p95") is not None]
    rtt_max = [r["max"] for r in minutes if r.get("max") is not None]
    turns = [r for r in window if r["k"] == "conv-turn"]
    ok_turns = [r for r in turns if r.get("ok")]
    hellos = [r for r in window if r["k"] == "host-hello"]
    return {
        "fromMs": start,
        "toMs": end,
        "hours": round((end - start) / 3_600_000, 2),
        "echo": {
            "connects": sum(1 for r in window if r["k"] == "echo-up"),
            "drops": sum(1 for r in window if r["k"] == "echo-down"),
            "pings": sum(r.get("n", 0) for r in minutes),
            "lost": sum(r.get("lost", 0) for r in minutes),
            "minutesConnected": sum(1 for r in minutes if r.get("connected")),
            "minutes": len(minutes),
            "rttMinuteP50Median": round(statistics.median(rtt_p50), 1) if rtt_p50 else None,
            "rttMinuteP95Max": max(rtt_p95) if rtt_p95 else None,
            "rttMax": max(rtt_max) if rtt_max else None,
        },
        "host": {
            "hellos": len(hellos),
            "downs": sum(1 for r in window if r["k"] == "host-down"),
            "runnerDowns": sum(1 for r in window if r["k"] == "runner-down"),
            "serverViewChanges": [
                (r["ct"], r.get("host"), r.get("runner"))
                for r in window
                if r["k"] == "server-view"
            ],
        },
        "conversation": {
            "turns": len(turns),
            "ok": len(ok_turns),
            "failed": len(turns) - len(ok_turns),
            "replyMsP50": pct([r["replyMs"] for r in ok_turns], 0.5),
            "replyMsP95": pct([r["replyMs"] for r in ok_turns], 0.95),
            "replyMsMax": max((r["replyMs"] for r in ok_turns), default=None),
        },
        "computerBoots": sorted({r.get("boot") for r in window}),
        "serverStarts": sum(
            1 for w in worker if w.get("s2") == "server-start" and start <= w["t"] <= end
        ),
        "computerStarts": sum(
            1 for w in worker if w.get("s2") == "computer-start" and start <= w["t"] <= end
        ),
    }


def first(items: list[dict], pred, after: int, key: str = "ct") -> dict | None:
    return next((r for r in items if r[key] >= after and pred(r)), None)


def redeploy(deploy: dict, live: int, reports: list[dict], worker: list[dict], horizon: int) -> dict:
    span = [r for r in reports if live - 30_000 <= r["ct"] <= horizon]
    wspan = [w for w in worker if live - 30_000 <= w["t"] <= horizon]
    echo_down = first(span, lambda r: r["k"] == "echo-down", live - 30_000)
    echo_up = first(span, lambda r: r["k"] == "echo-up", echo_down["ct"]) if echo_down else None
    host_down = first(span, lambda r: r["k"] == "host-down", live - 30_000)
    host_up = first(span, lambda r: r["k"] == "host-hello", host_down["ct"]) if host_down else None
    view_up = (
        first(span, lambda r: r["k"] == "server-view" and r.get("host") is True, host_up["ct"])
        if host_up
        else None
    )
    turn = (
        first(span, lambda r: r["k"] == "conv-turn" and r.get("ok"), host_up["ct"])
        if host_up
        else first(span, lambda r: r["k"] == "conv-turn" and r.get("ok"), live)
    )
    failed_turns = [
        r for r in span if r["k"] == "conv-turn" and not r.get("ok") and r["ct"] >= live - 30_000
    ]
    intercepts = [w for w in wspan if w.get("s2") == "intercept" and w["t"] >= live - 5_000]
    routes = [w for w in wspan if w.get("s2") == "route" and w["t"] >= live]
    new_build = deploy["build"]
    first_new_route = next((w for w in routes if w.get("build") == new_build), None)
    wakes = [w for w in wspan if w.get("s2", "").endswith("-wake") and w["t"] >= live - 5_000]

    def since(record: dict | None, key: str = "ct") -> int | None:
        return record[key] - live if record else None

    return {
        "build": new_build,
        "reregister": deploy.get("reregister"),
        "liveMs": live,
        "deployEndMs": deploy["end"],
        "echoDownAfterLiveMs": since(echo_down),
        "echoUpAfterLiveMs": since(echo_up),
        "echoOutageMs": echo_up.get("outageMs") if echo_up else None,
        "hostDownAfterLiveMs": since(host_down),
        "hostDownDetail": (host_down or {}).get("detail"),
        "hostHelloAfterLiveMs": since(host_up),
        "hostOutageMs": host_up["ct"] - host_down["ct"] if host_up and host_down else None,
        "serverViewOnlineAfterLiveMs": since(view_up),
        "firstOkTurnAfterLiveMs": since(turn),
        "firstOkTurn": {k: turn.get(k) for k in ("n", "trigger", "replyMs", "assistantItems")}
        if turn
        else None,
        "failedTurnsAround": [
            {k: r.get(k) for k in ("n", "trigger", "error")} for r in failed_turns
        ],
        "wakes": [(w["s2"], w.get("build"), w.get("running"), w["t"] - live) for w in wakes],
        "interceptsAfterLiveMs": [
            (w.get("build"), w["t"] - live, w.get("generation")) for w in intercepts
        ],
        "firstRouteOnNewBuild": {
            "afterLiveMs": first_new_route["t"] - live,
            "path": first_new_route.get("path"),
            "registeredBy": first_new_route.get("registeredBy"),
        }
        if first_new_route
        else None,
        "routeRegisteredBy": sorted({str(w.get("registeredBy")) for w in routes}),
        "serverStarts": sum(1 for w in wspan if w.get("s2") == "server-start" and w["t"] >= live),
        "computerStarts": sum(
            1 for w in wspan if w.get("s2") == "computer-start" and w["t"] >= live
        ),
        "computerBoots": sorted({r.get("boot") for r in span}),
    }


def main() -> None:
    records, deploys_path = Path(sys.argv[1]), Path(sys.argv[2])
    soak_from, soak_to = int(sys.argv[3]), int(sys.argv[4])
    worker, reports = load(records)
    deploys = [json.loads(line) for line in deploys_path.read_text().splitlines() if line]
    deploy_dir = deploys_path.parent / "deploys"
    result: dict[str, object] = {"soak": soak(reports, worker, soak_from, soak_to)}
    rows = []
    for i, deploy in enumerate(deploys):
        live = live_time(deploy["build"], deploy_dir)
        if live is None or live < soak_to:
            continue
        nxt = deploys[i + 1]["start"] if i + 1 < len(deploys) else live + 600_000
        rows.append(redeploy(deploy, live, reports, worker, min(nxt, live + 600_000)))
    result["redeploys"] = rows
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
