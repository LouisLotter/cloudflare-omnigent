"""X1 analysis: the pre-registration's definitions (section 6), eligibility and decision rule
(section 8, applied in order) and AR-17 (section 9), applied to one run's records.

    python3 -I spikes/x1/scripts/analyze.py <run-dir> --preflight <preflight-dir> \\
        --campaign <campaign.json> [--unsupported p6 ...] [--json <out.json>]
    python3 -I spikes/x1/scripts/analyze.py --preflight-only <preflight-dir>

<run-dir> and <preflight-dir> are collect.py's copies of the results bucket's run prefixes:
run.json, lifecycle/*.json and probe/<instance>/{batch-NNNNNN.jsonl,manifest.json}.
<campaign.json> is campaign.py's record of the two deploys (command start, the "Uploaded"
line, end, exit status and whether a container rollout started).

Clocks. Probe events carry wall and monotonic milliseconds. Each probe instance's events are
placed on one time line, t = monotonic + the instance's median (wall - monotonic), so durations
come from the monotonic clock and times compare with the Worker's (resets, RunDO's record) and
the laptop's (deploys) as wall-clock milliseconds. All clocks are NTP-synchronised.

--unsupported names a route the lead recorded as refused by Cloudflare at preflight (section 5);
it fails criterion 6 for that route. Everything below the I/O section is pure.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

ROUTES = ("p1", "p2", "p3", "p4", "p5", "p6")
PUBLIC = ("p4", "p5")
# Section 8's order: A′ (P2), then V (P6), then C (P5).
RULE_ORDER = (("p2", "A′ native forwarding"), ("p6", "V private Tunnel"), ("p5", "C public Tunnel"))
CANDIDATES = tuple(route for route, _ in RULE_ORDER)
# Section 7 writes a credential and block-list design for these three only.
DESIGNED = frozenset(CANDIDATES)
# Each candidate's policy point and the hop name it must give when refusing /x1/blocked.
POLICY_HOPS = {"p2": "p2-handler", "p5": "p5-route", "p6": "p6-handler"}

DEADLINE_MS = 1000.0
SPONTANEOUS_RECOVERY_MS = 5000.0
FORCED_RECOVERY_MS = 60_000.0
MAX_DROPS_PER_HOUR = 1.0
MIN_OUTCOME_FRACTION = 0.99
RESET_BEFORE_MS = 2000.0
RESET_AFTER_MS = 30_000.0
DEPLOY_AFTER_UPLOADED_MS = 330_000.0
HOUR_MS = 3_600_000.0
UNBOUNDED = math.inf


# ---------------------------------------------------------------------------------------------
# Time line


def instance_offset(events: list[dict]) -> float:
    """The median of wall - monotonic over one probe instance's events."""
    diffs = [e["wall"] - e["mono"] for e in events if "wall" in e and "mono" in e]
    if not diffs:
        raise ValueError("a probe instance has no timed events")
    return float(statistics.median(diffs))


def timeline(instances: dict[str, list[dict]]) -> list[dict]:
    """All probe events, each with its instance and its time t, in time order."""
    out: list[dict] = []
    for instance, events in instances.items():
        if not events:
            continue
        offset = instance_offset(events)
        for e in events:
            out.append({**e, "instance": instance, "t": e["mono"] + offset})
    out.sort(key=lambda e: (e["t"], e.get("instance", "")))
    return out


# ---------------------------------------------------------------------------------------------
# Forced windows and observed time (section 6)


@dataclass(frozen=True)
class Window:
    event: str
    kind: str  # "reset" or "deploy"
    start: float
    end: float


def reset_window(event: str, r: float) -> Window:
    """A reset at R, as RunDO recorded it: R - 2 s to R + 30 s."""
    return Window(event, "reset", r - RESET_BEFORE_MS, r + RESET_AFTER_MS)


def deploy_window(event: str, start: float, uploaded: float) -> Window:
    """A deploy: from the command's start to its "Uploaded" line plus 330 s."""
    return Window(event, "deploy", start, uploaded + DEPLOY_AFTER_UPLOADED_MS)


def windows_containing(t: float, windows: list[Window]) -> list[str]:
    """The events whose forced window contains t (both ends included)."""
    return [w.event for w in windows if w.start <= t <= w.end]


def union_length(intervals: list[tuple[float, float]]) -> float:
    total = 0.0
    current: tuple[float, float] | None = None
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if current is None or start > current[1]:
            if current is not None:
                total += current[1] - current[0]
            current = (start, end)
        else:
            current = (current[0], max(current[1], end))
    if current is not None:
        total += current[1] - current[0]
    return total


def observed_ms(soak_start: float, soak_end: float, windows: list[Window]) -> float:
    """The soak's duration minus the union of the forced windows (clipped to the soak)."""
    clipped = [(max(w.start, soak_start), min(w.end, soak_end)) for w in windows]
    return (soak_end - soak_start) - union_length(clipped)


# ---------------------------------------------------------------------------------------------
# One route's records


@dataclass
class Slot:
    instance: str
    conn: int
    seq: int
    sent: float
    reply_t: float | None = None
    rtt: float | None = None
    replies: int = 0
    miss_recorded: bool = False

    @property
    def answered(self) -> bool:
        return self.rtt is not None and self.rtt <= DEADLINE_MS

    @property
    def deadline(self) -> float:
        return self.sent + DEADLINE_MS

    @property
    def outcome_recorded(self) -> bool:
        return self.replies > 0 or self.miss_recorded


@dataclass
class Connection:
    instance: str
    conn: int
    open_t: float
    close_t: float | None = None
    by: str | None = None
    code: int | None = None
    reason: str | None = None
    error: str | None = None
    ids: list[dict] = field(default_factory=list)


@dataclass
class RouteRecords:
    route: str
    slots: dict[tuple[str, int], Slot] = field(default_factory=dict)
    connections: dict[tuple[str, int], Connection] = field(default_factory=dict)
    attempts: list[dict] = field(default_factory=list)
    duplicates: int = 0
    unexpected: int = 0
    reordered: int = 0
    unknown_replies: int = 0
    pings: int = 0
    pongs: list[float] = field(default_factory=list)
    pongs_missing: int = 0


def route_records(events: list[dict], route: str) -> RouteRecords:
    """Slots, connections, replies, pings and pongs of one route, from the time line."""
    rec = RouteRecords(route)
    max_seq: dict[tuple[str, int], int] = {}
    for e in events:
        if e.get("route") != route:
            continue
        kind = e.get("ev")
        inst = e["instance"]
        if kind == "attempt":
            rec.attempts.append(e)
        elif kind == "open":
            rec.connections[(inst, e["conn"])] = Connection(inst, e["conn"], e["t"])
        elif kind == "send":
            rec.slots[(inst, e["seq"])] = Slot(inst, e["conn"], e["seq"], e["t"])
        elif kind == "reply":
            slot = rec.slots.get((inst, e["seq"]))
            if slot is None:
                rec.unknown_replies += 1
                continue
            slot.replies += 1
            if slot.replies > 1:
                rec.duplicates += 1
                continue
            slot.reply_t = e["t"]
            slot.rtt = e["t"] - slot.sent
            key = (inst, e["conn"])
            if e["seq"] < max_seq.get(key, -1):
                rec.reordered += 1
            max_seq[key] = max(max_seq.get(key, -1), e["seq"])
        elif kind == "duplicate":
            rec.duplicates += 1
        elif kind == "unexpected":
            rec.unexpected += 1
        elif kind == "miss":
            slot = rec.slots.get((inst, e["seq"]))
            if slot is not None:
                slot.miss_recorded = True
        elif kind == "ident":
            conn = rec.connections.get((inst, e["conn"]))
            if conn is not None:
                conn.ids.append(e.get("id") or {})
        elif kind == "close":
            conn = rec.connections.get((inst, e["conn"]))
            if conn is not None and conn.close_t is None:
                conn.close_t = e["t"]
                conn.by = e.get("by")
                conn.code = e.get("code")
                conn.reason = e.get("reason")
                conn.error = e.get("error")
        elif kind == "ping":
            rec.pings += 1
        elif kind == "pong":
            rec.pongs.append(float(e["rtt"]))
        elif kind == "pong-missing":
            rec.pongs_missing += 1
    return rec


def slots_of(rec: RouteRecords, instance: str, conn: int) -> list[Slot]:
    return sorted(
        (s for s in rec.slots.values() if s.instance == instance and s.conn == conn),
        key=lambda s: s.seq,
    )


# ---------------------------------------------------------------------------------------------
# Drops, recoveries and gaps (section 6)


@dataclass
class Drop:
    route: str
    instance: str
    conn: int
    moment: float
    start: float
    by: str | None
    code: int | None
    reason: str | None
    ids_before: dict | None
    recovered_at: float | None = None
    recovery_ms: float = UNBOUNDED
    ids_after: dict | None = None
    windows: list[str] = field(default_factory=list)
    kind: str = "outside"  # "spontaneous", "forced" or "outside" the soak


def drop_start(slots: list[Slot], moment: float) -> float:
    """The earlier of the drop's moment and the first missed deadline in the run of misses
    before it: the slots after the connection's last answered one whose deadline had passed."""
    last_answered = max((i for i, s in enumerate(slots) if s.answered), default=-1)
    run = [s for s in slots[last_answered + 1 :] if not s.answered and s.deadline <= moment]
    if not run:
        return moment
    return min(moment, min(s.deadline for s in run))


def find_drops(rec: RouteRecords) -> list[Drop]:
    """Every connection that ended by a close frame, a transport error or the silence deadline.
    The probe's own close at the end of the run is not a drop."""
    drops = []
    for conn in rec.connections.values():
        if conn.close_t is None or conn.by == "end":
            continue
        slots = slots_of(rec, conn.instance, conn.conn)
        drops.append(
            Drop(
                route=rec.route,
                instance=conn.instance,
                conn=conn.conn,
                moment=conn.close_t,
                start=drop_start(slots, conn.close_t),
                by=conn.by,
                code=conn.code,
                reason=conn.reason,
                ids_before=conn.ids[-1] if conn.ids else None,
            )
        )
    drops.sort(key=lambda d: d.start)
    return drops


def attach_recoveries(rec: RouteRecords, drops: list[Drop], soak_end: float) -> None:
    """Recovery: from the drop start to the first answered echo on a new connection, by the
    soak's end. Otherwise the recovery time is unbounded."""
    for drop in drops:
        best: Slot | None = None
        for slot in rec.slots.values():
            if not slot.answered or (slot.instance, slot.conn) == (drop.instance, drop.conn):
                continue
            conn = rec.connections.get((slot.instance, slot.conn))
            if conn is None or conn.open_t < drop.moment:
                continue
            if slot.reply_t is None or slot.reply_t > soak_end:
                continue
            if best is None or slot.reply_t < best.reply_t:
                best = slot
        if best is not None:
            drop.recovered_at = best.reply_t
            drop.recovery_ms = best.reply_t - drop.start
            conn = rec.connections[(best.instance, best.conn)]
            drop.ids_after = conn.ids[0] if conn.ids else None


def classify(drops: list[Drop], soak_start: float, soak_end: float, windows: list[Window]) -> None:
    """A drop that starts in a forced window is a forced-event drop of that event; every other
    drop in the soak is spontaneous. Drops that start outside the soak are not counted."""
    for drop in drops:
        drop.windows = windows_containing(drop.start, windows)
        if not soak_start <= drop.start <= soak_end:
            drop.kind = "outside"
        elif drop.windows:
            drop.kind = "forced"
        else:
            drop.kind = "spontaneous"


@dataclass
class Gap:
    instance: str
    conn: int
    start: float
    misses: int
    end: float
    windows: list[str] = field(default_factory=list)


def find_gaps(rec: RouteRecords, windows: list[Window]) -> list[Gap]:
    """Missed deadlines followed by an answered echo on the same connection, with no drop."""
    gaps = []
    for conn in rec.connections.values():
        run: list[Slot] = []
        for slot in slots_of(rec, conn.instance, conn.conn):
            if not slot.answered:
                run.append(slot)
                continue
            if run:
                start = run[0].deadline
                gaps.append(
                    Gap(
                        conn.instance,
                        conn.conn,
                        start,
                        len(run),
                        float(slot.reply_t),
                        windows_containing(start, windows),
                    )
                )
                run = []
    gaps.sort(key=lambda g: g.start)
    return gaps


# ---------------------------------------------------------------------------------------------
# Per-route results


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(len(ordered) * p))], 1)


@dataclass
class RouteResult:
    route: str
    built: bool
    connections: int
    first_open: float | None
    attempts: int
    failed_attempts: int
    failed_statuses: dict[str, int]
    soak_slots: int
    soak_slots_with_outcome: int
    outcome_fraction: float | None
    observed_slots: int
    observed_answered: int
    availability: float | None
    spontaneous: list[Drop]
    forced: dict[str, list[Drop]]
    outside: list[Drop]
    spontaneous_rate: float
    gaps: list[Gap]
    lost: int
    duplicated: int
    reordered: int
    unexpected: int
    unknown_replies: int
    pings: int
    pongs: int
    pongs_missing: int
    pong_p50: float | None
    pong_p95: float | None
    pong_max: float | None


def drop_rate(count: int, observed: float) -> float:
    if observed <= 0:
        return UNBOUNDED if count > 0 else 0.0
    return count / (observed / HOUR_MS)


def route_result(
    events: list[dict],
    route: str,
    built: bool,
    soak_start: float,
    soak_end: float,
    windows: list[Window],
) -> RouteResult:
    rec = route_records(events, route)
    drops = find_drops(rec)
    attach_recoveries(rec, drops, soak_end)
    classify(drops, soak_start, soak_end, windows)
    forced: dict[str, list[Drop]] = {w.event: [] for w in windows}
    for drop in drops:
        if drop.kind == "forced":
            for event in drop.windows:
                forced[event].append(drop)
    soak = [s for s in rec.slots.values() if soak_start <= s.sent <= soak_end]
    observed = [s for s in soak if not windows_containing(s.sent, windows)]
    answered_observed = sum(1 for s in observed if s.answered)
    recorded = sum(1 for s in soak if s.outcome_recorded)
    statuses: dict[str, int] = {}
    failed = [a for a in rec.attempts if not a.get("ok")]
    for a in failed:
        key = str(a.get("status") or a.get("error") or "unknown")
        statuses[key] = statuses.get(key, 0) + 1
    opens = [c.open_t for c in rec.connections.values()]
    spontaneous = [d for d in drops if d.kind == "spontaneous"]
    obs_ms = observed_ms(soak_start, soak_end, windows)
    return RouteResult(
        route=route,
        built=built,
        connections=len(rec.connections),
        first_open=min(opens) if opens else None,
        attempts=len(rec.attempts),
        failed_attempts=len(failed),
        failed_statuses=statuses,
        soak_slots=len(soak),
        soak_slots_with_outcome=recorded,
        outcome_fraction=(recorded / len(soak)) if soak else None,
        observed_slots=len(observed),
        observed_answered=answered_observed,
        availability=(answered_observed / len(observed)) if observed else None,
        spontaneous=spontaneous,
        forced=forced,
        outside=[d for d in drops if d.kind == "outside"],
        spontaneous_rate=drop_rate(len(spontaneous), obs_ms),
        gaps=[g for g in find_gaps(rec, windows) if soak_start <= g.start <= soak_end],
        lost=sum(1 for s in soak if s.replies == 0),
        duplicated=rec.duplicates,
        reordered=rec.reordered,
        unexpected=rec.unexpected,
        unknown_replies=rec.unknown_replies,
        pings=rec.pings,
        pongs=len(rec.pongs),
        pongs_missing=rec.pongs_missing,
        pong_p50=percentile(rec.pongs, 0.5),
        pong_p95=percentile(rec.pongs, 0.95),
        pong_max=round(max(rec.pongs), 1) if rec.pongs else None,
    )


# ---------------------------------------------------------------------------------------------
# Data completeness (criterion 5's first part)


@dataclass
class Completeness:
    instances: int
    batches_expected: int
    batches_present: int
    missing: dict[str, list[int]]
    no_manifest: list[str]
    unexpected: dict[str, list[int]]

    @property
    def all_present(self) -> bool:
        return self.instances > 0 and not self.missing and not self.no_manifest


def completeness(probe: dict[str, dict]) -> Completeness:
    """Every probe batch is present: each instance has its manifest, and batches 1..N of it."""
    expected = present = 0
    missing: dict[str, list[int]] = {}
    unexpected: dict[str, list[int]] = {}
    no_manifest: list[str] = []
    for instance, data in sorted(probe.items()):
        numbers = set(data.get("batches", {}))
        manifest = data.get("manifest")
        if manifest is None:
            no_manifest.append(instance)
            top = max(numbers, default=0)
            gaps = sorted(set(range(1, top + 1)) - numbers)
        else:
            top = int(manifest["batches"])
            gaps = sorted(set(range(1, top + 1)) - numbers)
            extra = sorted(n for n in numbers if n > top)
            if extra:
                unexpected[instance] = extra
        if gaps:
            missing[instance] = gaps
        expected += top
        present += len(numbers & set(range(1, top + 1)))
    return Completeness(len(probe), expected, present, missing, no_manifest, unexpected)


# ---------------------------------------------------------------------------------------------
# Eligibility and the decision rule (section 8)


@dataclass
class Criterion:
    passed: bool
    detail: str


def connected(events: list[dict], route: str) -> bool:
    return any(e.get("ev") == "open" and e.get("route") == route for e in events)


def eligibility(
    result: RouteResult,
    complete: Completeness,
    soak_start: float,
    supported: tuple[bool, str],
) -> dict[str, Criterion]:
    """Section 8's six criteria for one candidate route."""
    rate = result.spontaneous_rate
    spont = [d.recovery_ms for d in result.spontaneous]
    forced = [d.recovery_ms for drops in result.forced.values() for d in drops]
    fraction = result.outcome_fraction
    first = result.first_open
    reasons = []
    if not complete.all_present:
        reasons.append(
            f"batches missing {complete.missing or '-'}, no manifest {complete.no_manifest or '-'}"
        )
    if fraction is None or fraction < MIN_OUTCOME_FRACTION:
        reasons.append(f"soak slots with an outcome {fmt_fraction(fraction)} < 99%")
    if first is None or first >= soak_start:
        reasons.append("first connection not before the soak started")
    return {
        "1 drop rate": Criterion(
            rate <= MAX_DROPS_PER_HOUR,
            f"{len(result.spontaneous)} spontaneous drops, {fmt_rate(rate)} per observed hour",
        ),
        "2 spontaneous recovery": Criterion(
            all(r <= SPONTANEOUS_RECOVERY_MS for r in spont),
            f"max {fmt_ms(max(spont))} over {len(spont)} drops" if spont else "no drops",
        ),
        "3 forced recovery": Criterion(
            all(r <= FORCED_RECOVERY_MS for r in forced),
            f"max {fmt_ms(max(forced))} over {len(forced)} drops" if forced else "no drops",
        ),
        "4 design": Criterion(
            result.route in DESIGNED, "section 7" if result.route in DESIGNED else "none"
        ),
        "5 complete data": Criterion(not reasons, "; ".join(reasons) or "complete"),
        "6 supported": Criterion(*supported),
    }


def supported(
    route: str, built: bool, preflight: list[dict] | None, run: list[dict], refused: set[str]
) -> tuple[bool, str]:
    """Criterion 6: connected at preflight and at the run, without a Cloudflare refusal."""
    if not built:
        return False, "not built"
    if route in refused:
        return False, "recorded as refused by Cloudflare at preflight"
    if preflight is None:
        return False, "no preflight records"
    at_preflight = connected(preflight, route)
    at_run = connected(run, route)
    if at_preflight and at_run:
        return True, "connected at preflight and at the run"
    missing = [n for n, ok in (("preflight", at_preflight), ("run", at_run)) if not ok]
    return False, f"never connected at the {' or the '.join(missing)}"


@dataclass
class Outcome:
    rule: int
    selected: str | None
    text: str
    rule4_routes: list[str]


def decide(eligible: dict[str, bool], rates: dict[str, float], public_built: bool) -> Outcome:
    """Section 8's outcome, in order."""
    for rule, (route, name) in enumerate(RULE_ORDER, start=1):
        if eligible.get(route, False):
            note = " C still needs the owner's F7 decision at G1b." if route == "p5" else ""
            return Outcome(rule, route, f"select {name} ({route.upper()}).{note}", [])
    # If F7-staging was declined, P4 and P5 were not built and rule 4 reads "each of P3 and P6".
    watched = ["p3", "p4", "p5", "p6"] if public_built else ["p3", "p6"]
    if all(rates.get(r, 0.0) > MAX_DROPS_PER_HOUR for r in watched):
        return Outcome(
            4,
            None,
            "revisit with the owner (B, or the Cloudflare-only constraint): no candidate is "
            f"eligible and each of {', '.join(r.upper() for r in watched)} has more than one "
            "spontaneous drop an hour, so the container's egress recycles whatever the route.",
            watched,
        )
    return Outcome(
        5,
        None,
        "inconclusive. The owner chooses between B, one rerun with a fixed budget and a changed "
        "setup, and the fallbacks in AR section 6.",
        watched,
    )


# ---------------------------------------------------------------------------------------------
# AR-17 (section 9)


def ar17(result: RouteResult, ui_event: str, transport_event: str) -> tuple[str, int, int]:
    """Clear benefit, no benefit or no help, from the deploys' forced-event drops."""
    t = len(result.forced.get(transport_event, []))
    u = len(result.forced.get(ui_event, []))
    if u > 0:
        verdict = "no help: the UI deploy drops the route" + (
            " too"
            if t > 0
            else " (the transport deploy does not; section 9 does not name this case)"
        )
    elif t > 0:
        verdict = "clear benefit: the transport deploy drops the route and the UI deploy does not"
    else:
        verdict = "no benefit: neither deploy drops the route"
    return verdict, t, u


# ---------------------------------------------------------------------------------------------
# The whole analysis


@dataclass
class Inputs:
    run: dict
    lifecycle: list[dict]
    probe: dict[str, dict]
    campaign: dict | None
    preflight_probe: dict[str, dict] | None
    refused: set[str] = field(default_factory=set)


@dataclass
class Report:
    run_id: str
    mode: str
    soak_start: float
    soak_end: float
    public_built: bool
    windows: list[Window]
    observed_hours: float
    setup_problems: list[str]
    deviations: list[str]
    completeness: Completeness
    routes: dict[str, RouteResult]
    criteria: dict[str, dict[str, Criterion]]
    eligible: dict[str, bool]
    outcome: Outcome | None
    would_be: Outcome | None
    ar17: dict[str, tuple[str, int, int]]
    blocked: list[dict]


def probe_events(probe: dict[str, dict]) -> list[dict]:
    instances = {}
    for instance, data in probe.items():
        events: list[dict] = []
        for n in sorted(data.get("batches", {})):
            events.extend(e for e in data["batches"][n] if "ev" in e)
        instances[instance] = events
    return timeline(instances)


def resets_from(lifecycle: list[dict]) -> list[tuple[str, float]]:
    return sorted(
        (
            (str(r.get("event")), float(r["R"]))
            for r in lifecycle
            if r.get("x1") == "reset-requested"
        ),
        key=lambda x: x[1],
    )


def windows_from(
    lifecycle: list[dict], campaign: dict | None
) -> tuple[list[Window], list[str], list[str]]:
    """The forced windows, the setup problems that stop the rule being applied, and deviations
    from the schedule that are reported only."""
    windows = [reset_window(f"reset {name}", r) for name, r in resets_from(lifecycle)]
    problems: list[str] = []
    deviations: list[str] = []
    deploys = {d.get("target"): d for d in (campaign or {}).get("deploys", [])}
    for target in ("ui", "transport"):
        d = deploys.get(target)
        if d is None:
            problems.append(f"no record of the {target} deploy")
            continue
        if d.get("rollout"):
            problems.append(f"the {target} deploy started a container rollout")
        if d.get("status") not in (0, None):
            deviations.append(f"the {target} deploy exited with status {d.get('status')}")
        if d.get("uploaded") is None:
            problems.append(f'the {target} deploy has no "Uploaded" line: its window is undefined')
            continue
        windows.append(deploy_window(f"{target} deploy", float(d["start"]), float(d["uploaded"])))
    return windows, problems, deviations


def blocked_checks(events: list[dict]) -> list[dict]:
    out = []
    for e in events:
        if e.get("ev") != "blocked-check":
            continue
        target = e.get("target")
        expected = POLICY_HOPS.get(str(target), f"{target}-handler")
        ok = e.get("status") == 403 and e.get("refusedBy") == expected
        if target == "p5-badcred":
            ok = e.get("status") == 403 and e.get("refusedBy") == "p5-route"
        out.append({**{k: e.get(k) for k in ("target", "status", "refusedBy")}, "ok": ok})
    return out


def analyze(inputs: Inputs) -> Report:
    run = inputs.run
    soak_start, soak_end = float(run["soakStart"]), float(run["soakEnd"])
    public_built = bool(run.get("publicRoutes"))
    built_routes = set(run.get("routes") or [])
    events = probe_events(inputs.probe)
    preflight = probe_events(inputs.preflight_probe) if inputs.preflight_probe is not None else None
    windows, problems, deviations = windows_from(inputs.lifecycle, inputs.campaign)
    if run.get("mode") != "run":
        problems.append(f"the records are a {run.get('mode')}, not a run")
    if inputs.campaign is not None and inputs.campaign.get("runId") not in (None, run.get("runId")):
        problems.append("the campaign record names another run")
    planned = [e for e in run.get("events", []) if e.get("kind") == "reset"]
    recorded = {name for name, _ in resets_from(inputs.lifecycle)}
    for e in planned:
        if e.get("id") not in recorded:
            deviations.append(f"forced reset {e.get('id')} was not recorded by RunDO")
    complete = completeness(inputs.probe)
    results = {
        r: route_result(events, r, r in built_routes, soak_start, soak_end, windows) for r in ROUTES
    }
    criteria = {}
    eligible = {}
    for route in CANDIDATES:
        support = supported(route, route in built_routes, preflight, events, inputs.refused)
        criteria[route] = eligibility(results[route], complete, soak_start, support)
        eligible[route] = route in built_routes and all(c.passed for c in criteria[route].values())
    rates = {r: results[r].spontaneous_rate for r in ROUTES}
    decision = decide(eligible, rates, public_built)
    outcome = decision if not problems else None
    ar = {}
    targets = [decision.selected] if decision.selected else list(CANDIDATES)
    for route in targets:
        if route in built_routes:
            ar[route] = ar17(results[route], "ui deploy", "transport deploy")
        else:
            ar[route] = ("not built", 0, 0)
    return Report(
        run_id=str(run.get("runId")),
        mode=str(run.get("mode")),
        soak_start=soak_start,
        soak_end=soak_end,
        public_built=public_built,
        windows=windows,
        observed_hours=observed_ms(soak_start, soak_end, windows) / HOUR_MS,
        setup_problems=problems,
        deviations=deviations,
        completeness=complete,
        routes=results,
        criteria=criteria,
        eligible=eligible,
        outcome=outcome,
        would_be=decision,
        ar17=ar,
        blocked=blocked_checks(events),
    )


@dataclass
class PreflightReport:
    run_id: str
    routes: dict[str, dict]
    blocked: list[dict]
    resets: list[tuple[str, float]]
    completeness: Completeness


def analyze_preflight(run: dict, lifecycle: list[dict], probe: dict[str, dict]) -> PreflightReport:
    """Section 5's preflight checks: all six routes, the forced reset, the block list and record
    completeness."""
    events = probe_events(probe)
    resets = resets_from(lifecycle)
    windows = [reset_window(f"reset {name}", r) for name, r in resets]
    start, end = float(run["soakStart"]), float(run["soakEnd"])
    routes = {}
    for route in ROUTES:
        built = route in (run.get("routes") or [])
        result = route_result(events, route, built, start, end, windows)
        routes[route] = {
            "built": built,
            "connected": connected(events, route),
            "connections": result.connections,
            "failedAttempts": result.failed_attempts,
            "failedStatuses": result.failed_statuses,
            "drops": len(result.spontaneous) + sum(len(v) for v in result.forced.values()),
            "forcedRecoveryMs": [d.recovery_ms for v in result.forced.values() for d in v],
            "outcomeFraction": result.outcome_fraction,
        }
    return PreflightReport(
        str(run.get("runId")), routes, blocked_checks(events), resets, completeness(probe)
    )


# ---------------------------------------------------------------------------------------------
# Rendering


def fmt_ms(value: float | None) -> str:
    if value is None:
        return "-"
    if math.isinf(value):
        return "unbounded"
    return f"{value / 1000:.3f} s"


def fmt_rate(value: float) -> str:
    return "unbounded" if math.isinf(value) else f"{value:.3f}"


def fmt_fraction(value: float | None) -> str:
    return "-" if value is None else f"{100 * value:.3f}%"


def fmt_t(value: float | None, origin: float) -> str:
    if value is None:
        return "-"
    return f"S{(value - origin) / 1000:+.3f}s"


def render_drop(d: Drop, origin: float) -> str:
    return (
        f"      start {fmt_t(d.start, origin)} moment {fmt_t(d.moment, origin)} by={d.by} "
        f"code={d.code} conn={d.instance}/{d.conn} recovery={fmt_ms(d.recovery_ms)} "
        f"before={json.dumps(d.ids_before, sort_keys=True)} "
        f"after={json.dumps(d.ids_after, sort_keys=True)}"
    )


def render(report: Report) -> str:
    s = report.soak_start
    lines = [
        f"X1 analysis of {report.run_id} ({report.mode})",
        f"soak {fmt_t(report.soak_start, s)} to {fmt_t(report.soak_end, s)}; "
        f"observed hours {report.observed_hours:.4f}; P4/P5 built: {report.public_built}",
        "forced windows:",
    ]
    for w in report.windows:
        lines.append(f"  {w.event}: {fmt_t(w.start, s)} .. {fmt_t(w.end, s)}")
    c = report.completeness
    lines.append(
        f"probe batches: {c.batches_present}/{c.batches_expected} over {c.instances} instances; "
        f"missing {c.missing or 'none'}; without manifest {c.no_manifest or 'none'}; "
        f"beyond manifest {c.unexpected or 'none'}"
    )
    for item in report.blocked:
        lines.append(
            f"block-list check {item['target']}: {item['status']} {item['refusedBy']} ok={item['ok']}"
        )
    for route, r in report.routes.items():
        lines.append(f"{route.upper()} (built: {r.built})")
        lines.append(
            f"  connections {r.connections}, attempts {r.attempts} ({r.failed_attempts} failed: "
            f"{r.failed_statuses or '-'}), first open {fmt_t(r.first_open, s)}"
        )
        lines.append(
            f"  soak slots {r.soak_slots}, with an outcome {r.soak_slots_with_outcome} "
            f"({fmt_fraction(r.outcome_fraction)}); observed slots {r.observed_slots}, answered "
            f"{r.observed_answered}, availability {fmt_fraction(r.availability)}"
        )
        lines.append(
            f"  spontaneous drops {len(r.spontaneous)} ({fmt_rate(r.spontaneous_rate)} per observed hour)"
        )
        lines.extend(render_drop(d, s) for d in r.spontaneous)
        for event, drops in r.forced.items():
            lines.append(f"  forced-event drops, {event}: {len(drops)}")
            lines.extend(render_drop(d, s) for d in drops)
        if r.outside:
            lines.append(f"  drops outside the soak (not counted): {len(r.outside)}")
        lines.append(f"  gaps {len(r.gaps)}")
        for g in r.gaps:
            lines.append(
                f"      {fmt_t(g.start, s)} .. {fmt_t(g.end, s)} misses={g.misses} "
                f"windows={g.windows or '-'}"
            )
        lines.append(
            f"  sequence: lost {r.lost}, duplicated {r.duplicated}, reordered {r.reordered}, "
            f"unexpected {r.unexpected}, replies to unknown slots {r.unknown_replies}"
        )
        lines.append(
            f"  pongs {r.pongs}/{r.pings} pings, missing {r.pongs_missing}, rtt p50 "
            f"{r.pong_p50} p95 {r.pong_p95} max {r.pong_max} ms"
        )
    lines.append("eligibility:")
    for route, crits in report.criteria.items():
        lines.append(
            f"  {route.upper()}: {'ELIGIBLE' if report.eligible[route] else 'not eligible'}"
        )
        for name, crit in crits.items():
            lines.append(f"    {name}: {'pass' if crit.passed else 'FAIL'} ({crit.detail})")
    if report.deviations:
        lines.append("schedule deviations (reported only):")
        lines.extend(f"  {d}" for d in report.deviations)
    if report.setup_problems:
        lines.append("SETUP FAILED; the rule is not applied:")
        lines.extend(f"  {p}" for p in report.setup_problems)
        assert report.would_be is not None
        lines.append(
            f"(for information only, the rule would give rule {report.would_be.rule}: {report.would_be.text})"
        )
    else:
        assert report.outcome is not None
        lines.append(f"OUTCOME (rule {report.outcome.rule}): {report.outcome.text}")
    for route, (verdict, t, u) in report.ar17.items():
        lines.append(
            f"AR-17 {route.upper()}: {verdict} (transport deploy drops {t}, UI deploy drops {u})"
        )
    lines.append("In every case: core changes 12 and 14. The selection is provisional until RC-26.")
    return "\n".join(lines)


def render_preflight(report: PreflightReport) -> str:
    lines = [f"X1 preflight {report.run_id}"]
    for route, r in report.routes.items():
        lines.append(f"{route.upper()}: {json.dumps(r, sort_keys=True, default=str)}")
    for name, r in report.resets:
        lines.append(f"reset {name} at {r}")
    for item in report.blocked:
        lines.append(
            f"block-list check {item['target']}: {item['status']} {item['refusedBy']} ok={item['ok']}"
        )
    c = report.completeness
    lines.append(
        f"batches {c.batches_present}/{c.batches_expected}; missing {c.missing or 'none'}; "
        f"without manifest {c.no_manifest or 'none'}"
    )
    return "\n".join(lines)


def jsonable(value: object) -> object:
    if isinstance(value, float) and math.isinf(value):
        return "unbounded"
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


# ---------------------------------------------------------------------------------------------
# I/O


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def load_dir(directory: Path) -> tuple[dict, list[dict], dict[str, dict]]:
    run = read_json(directory / "run.json")
    lifecycle = [read_json(p) for p in sorted((directory / "lifecycle").glob("*.json"))]
    probe: dict[str, dict] = {}
    for inst_dir in sorted((directory / "probe").glob("*")):
        if not inst_dir.is_dir():
            continue
        batches = {}
        for p in sorted(inst_dir.glob("batch-*.jsonl")):
            batches[int(p.stem.split("-")[1])] = read_jsonl(p)
        manifest_path = inst_dir / "manifest.json"
        probe[inst_dir.name] = {
            "batches": batches,
            "manifest": read_json(manifest_path) if manifest_path.exists() else None,
        }
    return run, lifecycle, probe


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("run_dir", nargs="?", type=Path)
    parser.add_argument("--preflight", type=Path)
    parser.add_argument("--preflight-only", type=Path)
    parser.add_argument("--campaign", type=Path)
    parser.add_argument("--unsupported", action="append", default=[], choices=ROUTES)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args(argv)
    if args.preflight_only is not None:
        run, lifecycle, probe = load_dir(args.preflight_only)
        pre = analyze_preflight(run, lifecycle, probe)
        print(render_preflight(pre))
        if args.json:
            args.json.write_text(json.dumps(jsonable(asdict(pre)), indent=2, default=str) + "\n")
        return 0
    if args.run_dir is None:
        parser.error("give a run directory or --preflight-only")
    run, lifecycle, probe = load_dir(args.run_dir)
    preflight_probe = load_dir(args.preflight)[2] if args.preflight else None
    campaign = read_json(args.campaign) if args.campaign else None
    report = analyze(
        Inputs(run, lifecycle, probe, campaign, preflight_probe, set(args.unsupported))
    )
    print(render(report))
    if args.json:
        args.json.write_text(json.dumps(jsonable(asdict(report)), indent=2, default=str) + "\n")
    return 0 if report.outcome is not None else 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
