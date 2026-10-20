"""X1's laptop side of the run (pre-registration section 5, Amendments 1 and 3), after the owner
clicks Start run.

    python3 -I spikes/x1/scripts/campaign.py [--results DIR] [--t0-wait-min 60] [--date-url URL]

1. Records the laptop's clock at the start (Amendment 3, item 2): its time-synchronisation status
   (`timedatectl`) and its skew against the Date header of a Cloudflare-served response.
2. Waits for T0: RunDO writes runs/current.json to the results bucket when the run starts. It is
   read with `wrangler r2 object get … --remote`, read-only, with the pinned Wrangler.
3. Deploys the UI at S+45 min and the transport at S+75 min, each with deploy.sh, which runs
   the guarded staging tool and records the command's start, its "Uploaded" line, its end and
   whether a container rollout started.
4. Before the transport deploy it refuses, and deploys nothing, if the deploy would start a
   container rollout: if the images' fingerprint (their layers, rebuilt locally from Docker's
   cache) differs from the last transport deploy's, or the staging record was recreated (a new
   build epoch). The analysis then finds no record of that deploy and reports a setup failure.
5. Waits for runs/<run>/end.json, which RunDO writes once the probe's manifest (its completion
   marker) is stored and both containers are stopped, then records the laptop's clock again.

After every step (Amendment 3, item 6) the record so far is written to campaign.json and the
step appended to campaign-steps.jsonl, so an interrupted campaign keeps what it measured.
"""

from __future__ import annotations

import argparse
import email.utils
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

X1 = Path(__file__).resolve().parents[1]
ROOT = X1.parents[1]
BUCKET = "cfo-stg-x1-transport-results"
TRANSPORT = "cfo-stg-x1-transport"
MINUTE_MS = 60_000
DEPLOYS = (("ui", 45), ("transport", 75))
PRECHECK_LEAD_MS = 3 * MINUTE_MS
END_GRACE_MS = 15 * MINUTE_MS
TAIL_MS = 60_000
# A Cloudflare-served response for the Date header; any will do.
DATE_URL = "https://www.cloudflare.com/cdn-cgi/trace"


def staging_dir() -> Path:
    return Path(
        os.environ.get("CFO_STAGING_DIR")
        or Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        / "cloudflare-omnigent"
        / "staging"
    )


@dataclass
class Ports:
    """Everything the campaign does outside itself, so tests can drive it."""

    now_ms: Callable[[], int]
    sleep: Callable[[float], None]
    get_object: Callable[[str], dict | None]
    deploy: Callable[[str, str], dict | None]
    fingerprint: Callable[[], dict]
    record_created_at: Callable[[], str | None]
    last_transport: Callable[[], dict | None]
    clock: Callable[[], dict]
    save: Callable[[str, dict], None]
    say: Callable[[str], None] = print


@dataclass
class Campaign:
    run_id: str | None = None
    t0: int | None = None
    soak_start: int | None = None
    soak_end: int | None = None
    tail_end: int | None = None
    clock: dict[str, dict] = field(default_factory=dict)
    deploys: list[dict] = field(default_factory=list)
    refused: list[dict] = field(default_factory=list)
    end: dict | None = None
    notes: list[str] = field(default_factory=list)

    def record(self) -> dict:
        return {
            "runId": self.run_id,
            "t0": self.t0,
            "soakStart": self.soak_start,
            "soakEnd": self.soak_end,
            "tailEnd": self.tail_end,
            "clock": self.clock,
            "deploys": self.deploys,
            "refused": self.refused,
            "end": self.end,
            "notes": self.notes,
        }


def sleep_until(ports: Ports, when_ms: int) -> None:
    while True:
        left = when_ms - ports.now_ms()
        if left <= 0:
            return
        ports.sleep(min(left / 1000, 30.0))


def wait_for_t0(ports: Ports, started_ms: int, timeout_ms: int) -> dict:
    """The current run's pointer once a run (not a preflight) started near or after `started_ms`."""
    while ports.now_ms() - started_ms < timeout_ms:
        current = ports.get_object("runs/current.json")
        if (
            current
            and current.get("mode") == "run"
            and current.get("status") == "active"
            and current.get("t0", 0) >= started_ms - 10 * MINUTE_MS
        ):
            return current
        ports.sleep(15.0)
    raise TimeoutError("no run started; was Start run clicked?")


def rollout_risk(ports: Ports) -> list[str]:
    """Reasons the next transport deploy would push new images (DC-36), or none."""
    last = ports.last_transport()
    if last is None or "fingerprint" not in last:
        return ["no earlier transport deploy with an image fingerprint is recorded"]
    reasons = []
    if ports.fingerprint() != last["fingerprint"]:
        reasons.append("the images' layers differ from the last transport deploy's")
    if ports.record_created_at() != last.get("recordCreatedAt"):
        reasons.append("the staging record was recreated: the build epoch changed")
    return reasons


def run_campaign(ports: Ports, started_ms: int, t0_wait_ms: int) -> Campaign:
    c = Campaign()

    def step(name: str, **detail: object) -> None:
        ports.save(name, {"at": ports.now_ms(), **detail, "record": c.record()})

    c.clock["start"] = ports.clock()
    step("clock-start")
    try:
        current = wait_for_t0(ports, started_ms, t0_wait_ms)
    except TimeoutError:
        c.notes.append("no run started within the wait for T0")
        step("no-t0")
        raise
    c.run_id, c.t0 = current["runId"], current["t0"]
    c.soak_start, c.soak_end = current["soakStart"], current["soakEnd"]
    # Amendment 1, item 7: the probe and RunDO run 60 s past the soak's end.
    c.tail_end = current.get("tailEnd", c.soak_end + TAIL_MS)
    ports.say(f"T0 {c.t0} ({c.run_id}); soak {c.soak_start}..{c.soak_end}, tail to {c.tail_end}")
    step("t0")
    for target, minutes in DEPLOYS:
        planned = c.soak_start + minutes * MINUTE_MS
        reasons: list[str] = []
        if target == "transport":
            sleep_until(ports, planned - PRECHECK_LEAD_MS)
            reasons = rollout_risk(ports)
        if reasons:
            c.refused.append({"target": target, "planned": planned, "reasons": reasons})
            ports.say(f"REFUSED the {target} deploy: {'; '.join(reasons)}. The run fails setup.")
            step("refused", target=target)
            continue
        sleep_until(ports, planned)
        late = ports.now_ms() - planned
        if late > MINUTE_MS:
            c.notes.append(f"the {target} deploy started {late / 1000:.0f} s late")
        step("deploy-start", target=target)
        result = ports.deploy(target, f"campaign-{target}")
        if result is None:
            c.notes.append(f"the {target} deploy left no record")
            step("deploy-unrecorded", target=target)
            continue
        parsed = result.get("parsed") or {}
        c.deploys.append(
            {
                "target": target,
                "planned": planned,
                "build": result.get("build"),
                "start": result.get("start"),
                "uploaded": parsed.get("uploaded"),
                "end": result.get("end"),
                "status": result.get("status"),
                "rollout": bool(parsed.get("rollout")),
                "rolloutEvidence": parsed.get("evidence", []),
            }
        )
        if parsed.get("rollout"):
            ports.say(f"the {target} deploy started a container rollout: the run fails setup")
        step("deploy", target=target)
    while ports.now_ms() < c.tail_end + END_GRACE_MS:
        end = ports.get_object(f"runs/{c.run_id}/end.json")
        if end is not None:
            c.end = end
            break
        ports.sleep(30.0)
    else:
        c.notes.append("no end.json within 15 minutes of the recovery tail's end")
    step("end")
    c.clock["end"] = ports.clock()
    step("clock-end")
    return c


# ---------------------------------------------------------------------------------------------
# The laptop's clock (Amendment 3, item 2)


def skew_from_date(date_header: str | None, sent_ms: float, received_ms: float) -> float | None:
    """The server's time minus the laptop's at the request's midpoint. The Date header has
    whole seconds, so the server's time is taken as the middle of its second."""
    if not date_header:
        return None
    try:
        server = email.utils.parsedate_to_datetime(date_header).timestamp() * 1000 + 500
    except (TypeError, ValueError):
        return None
    return round(server - (sent_ms + received_ms) / 2, 1)


def date_skew_ms(url: str) -> float | None:
    sent = time.time() * 1000
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=15) as res:  # noqa: S310 - https only
            date = res.headers.get("Date")
    except urllib.error.HTTPError as error:
        date = error.headers.get("Date")
    except Exception:  # noqa: BLE001 - no answer: no skew, which the analysis refuses
        return None
    return skew_from_date(date, sent, time.time() * 1000)


def synchronized() -> bool | None:
    """systemd's view: True or False, or None when it cannot tell."""
    try:
        out = subprocess.run(
            ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return {"yes": True, "no": False}.get(out.stdout.strip())


def laptop_clock(url: str) -> dict:
    return {
        "at": int(time.time() * 1000),
        "synchronized": synchronized(),
        "skewMs": date_skew_ms(url),
    }


# ---------------------------------------------------------------------------------------------
# The real ports


def wrangler() -> str:
    return str(ROOT / "worker" / "node_modules" / ".bin" / "wrangler")


def account_env() -> dict[str, str]:
    config = json.loads((staging_dir() / "config.json").read_text())
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": config["accountId"]}
    env.pop("CLOUDFLARE_ENV", None)
    return env


def r2_get(key: str) -> dict | None:
    """One JSON object from the results bucket, read-only; None if it is not there (yet)."""
    with tempfile.TemporaryDirectory() as empty:  # no Wrangler config to pick up
        out = subprocess.run(
            [wrangler(), "r2", "object", "get", f"{BUCKET}/{key}", "--remote", "--pipe"],
            capture_output=True,
            cwd=empty,
            env=account_env(),
            check=False,
            timeout=120,
        )
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout)
    except ValueError:
        return None


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def saver(results: Path) -> Callable[[str, dict], None]:
    """Writes the record so far to campaign.json (atomically) and appends the step."""

    def save(name: str, detail: dict) -> None:
        record = detail["record"]
        tmp = results / "campaign.json.tmp"
        tmp.write_text(json.dumps(record, indent=2) + "\n")
        os.replace(tmp, results / "campaign.json")
        step = {"step": name, **{k: v for k, v in detail.items() if k != "record"}}
        with (results / "campaign-steps.jsonl").open("a") as fh:
            fh.write(json.dumps(step) + "\n")

    return save


def real_ports(results: Path, date_url: str = DATE_URL) -> Ports:
    deploys = results / "deploys.jsonl"

    def deploy(target: str, label: str) -> dict | None:
        before = len(read_jsonl(deploys))
        subprocess.run(
            [str(X1 / "scripts" / "deploy.sh"), target, label],
            env={**os.environ, "X1_RESULTS": str(results)},
            check=False,
        )
        after = read_jsonl(deploys)
        return after[-1] if len(after) > before else None

    def fingerprint() -> dict:
        out = subprocess.run(
            [str(X1 / "scripts" / "deploy.sh"), "fingerprint"],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(out.stdout)

    def record_created_at() -> str | None:
        registry = json.loads((staging_dir() / "resources.json").read_text())
        found = [d for d in registry.get("deployments", []) if d.get("name") == TRANSPORT]
        return found[0].get("createdAt") if found else None

    def last_transport() -> dict | None:
        found = [
            d
            for d in read_jsonl(deploys)
            if d.get("target") == "transport" and d.get("status") == 0
        ]
        return found[-1] if found else None

    def say(message: str) -> None:
        line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}"
        print(line, flush=True)
        with (results / "campaign.log").open("a") as fh:
            fh.write(line + "\n")

    return Ports(
        now_ms=lambda: int(time.time() * 1000),
        sleep=time.sleep,
        get_object=r2_get,
        deploy=deploy,
        fingerprint=fingerprint,
        record_created_at=record_created_at,
        last_transport=last_transport,
        clock=lambda: laptop_clock(date_url),
        save=saver(results),
        say=say,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--results", type=Path, default=X1 / "results" / "run")
    parser.add_argument("--t0-wait-min", type=int, default=60)
    parser.add_argument("--date-url", default=DATE_URL)
    args = parser.parse_args(argv)
    args.results.mkdir(parents=True, exist_ok=True)
    ports = real_ports(args.results, args.date_url)
    started = ports.now_ms()
    campaign = run_campaign(ports, started, args.t0_wait_min * MINUTE_MS)
    ports.say(f"campaign record in {args.results / 'campaign.json'}")
    clocks_ok = all(
        c.get("synchronized") is True and c.get("skewMs") is not None and abs(c["skewMs"]) <= 2000
        for c in campaign.clock.values()
    )
    ok = clocks_ok and not campaign.refused and all(not d["rollout"] for d in campaign.deploys)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
