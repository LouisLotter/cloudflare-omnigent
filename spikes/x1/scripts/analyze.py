"""X1 analysis: the pre-registration's definitions (section 6), eligibility and decision rule
(section 8, applied in order) and AR-17 (section 9), as Amendment 1 settles them, applied to one
run's records.

    python3 -I spikes/x1/scripts/analyze.py <run-dir> --preflight <preflight-dir> \\
        --campaign <campaign.json> [--unsupported p6 ...] [--json <out.json>]
    python3 -I spikes/x1/scripts/analyze.py --preflight-only <preflight-dir>

<run-dir> and <preflight-dir> are collect.py's copies of the results bucket's run prefixes:
run.json, lifecycle/*.json and probe/<instance>/{batch-NNNNNN.jsonl,manifest.json}.
<campaign.json> is campaign.py's record of the two deploys (command start, the "Uploaded"
line, end, exit status and whether a container rollout started).

Clocks. The probe stamps every record from one monotonic-to-wall mapping fixed at its start
(Amendment 3, item 2). Each instance's events are placed on one time line, t = monotonic + the
instance's median (wall - monotonic), so durations come from the monotonic clock and times
compare with the Worker's (the soak, resets) and the laptop's (deploys) as wall-clock
milliseconds. A mapping that moves, a clock step in the probe's minute records, a skew against
the Worker or a laptop clock out of bounds is a setup failure.

Evidence (Amendment 3, item 1). Before the rule, the records are checked: batches, headers,
spans and manifests, every connection's end, and the preflight's identity. Any failure is a
setup failure; nothing is repaired or inferred.

The soak is [S, E): its 1-second slots run from S, and a drop counts when it starts at or after S
and before E. The recovery tail (Amendment 1, item 7) is [E, E + 60 s]: recoveries may complete
in it; drops that start in it are not counted.

--unsupported names a route the lead recorded as refused by Cloudflare at preflight (section 5);
it fails criterion 6 for that route. Everything below the I/O section is pure.
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import re
import statistics
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

ROUTES = ("p1", "p2", "p3", "p4", "p5", "p6")
# Section 8's order: A′ (P2), then V (P6), then C (P5).
RULE_ORDER = (("p2", "A′ native forwarding"), ("p6", "V private Tunnel"), ("p5", "C public Tunnel"))
CANDIDATES = tuple(route for route, _ in RULE_ORDER)
# Section 7 writes a credential and block-list design for these three only.
DESIGNED = frozenset(CANDIDATES)
# Each candidate's policy point and the hop name it must give when refusing /x1/blocked.
POLICY_HOPS = {"p2": "p2-handler", "p5": "p5-route", "p6": "p6-handler"}

SLOT_MS = 1000.0
DEADLINE_MS = 1000.0
TAIL_MS = 60_000.0
SPONTANEOUS_RECOVERY_MS = 5000.0
FORCED_RECOVERY_MS = 60_000.0
MAX_DROPS_PER_HOUR = 1.0
MIN_OUTCOME_FRACTION = 0.99
RESET_BEFORE_MS = 2000.0
RESET_AFTER_MS = 30_000.0
DEPLOY_AFTER_UPLOADED_MS = 330_000.0
HOUR_MS = 3_600_000.0
UNBOUNDED = math.inf
RULE5_TEXT = (
    "The owner chooses between B, one rerun with a fixed budget and a changed setup, and the "
    "fallbacks in AR section 6."
)


# ---------------------------------------------------------------------------------------------
# Time line and record coverage


def instance_offset(events: list[dict]) -> float:
    """The median of wall - monotonic over one probe instance's events."""
    diffs = [e["wall"] - e["mono"] for e in events if "wall" in e and "mono" in e]
    if not diffs:
        raise ValueError("a probe instance has no timed events")
    return float(statistics.median(diffs))


def instance_events(probe: dict[str, dict]) -> dict[str, list[dict]]:
    """Each instance's events from its present batches (batch headers have no "ev")."""
    out = {}
    for instance, data in probe.items():
        events: list[dict] = []
        for n in sorted(data.get("batches", {})):
            events.extend(e for e in data["batches"][n] if "ev" in e)
        out[instance] = events
    return out


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


def merge(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """The union of closed intervals, as sorted disjoint intervals; touching ones join."""
    merged: list[tuple[float, float]] = []
    for start, end in sorted(intervals):
        if end < start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def coverage(probe: dict[str, dict]) -> list[tuple[float, float]]:
    """The time the present batches account for. Each batch's header gives the monotonic span
    it holds (fromMono to cutMono); a missing batch, or the time between two probe instances,
    is not covered."""
    spans = []
    for instance, events in instance_events(probe).items():
        if not events:
            continue
        offset = instance_offset(events)
        for lines in probe[instance].get("batches", {}).values():
            for header in (h for h in lines if "ev" not in h):
                if "fromMono" in header and "cutMono" in header:
                    spans.append((header["fromMono"] + offset, header["cutMono"] + offset))
    return merge(spans)


def covered(spans: list[tuple[float, float]], a: float, b: float) -> bool:
    """Whether [a, b] lies within one covered span."""
    i = bisect.bisect_right([s for s, _ in spans], a) - 1
    return i >= 0 and spans[i][1] >= b


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
    return sum(end - start for start, end in merge([(s, e) for s, e in intervals if e > s]))


def observed_ms(soak_start: float, soak_end: float, windows: list[Window]) -> float:
    """The soak's duration minus the union of the forced windows (clipped to the soak)."""
    clipped = [(max(w.start, soak_start), min(w.end, soak_end)) for w in windows]
    return (soak_end - soak_start) - union_length(clipped)


def slot_observed(a: float, windows: list[Window]) -> bool:
    """A slot [a, a + 1 s) is in the observed time when no forced window touches it."""
    return not any(w.start < a + SLOT_MS and w.end >= a for w in windows)


# ---------------------------------------------------------------------------------------------
# One route's records


@dataclass
class Echo:
    instance: str
    conn: int
    seq: int
    sent: float
    reply_t: float | None = None
    rtt: float | None = None
    replies: int = 0

    @property
    def answered(self) -> bool:
        return self.rtt is not None and self.rtt <= DEADLINE_MS

    @property
    def deadline(self) -> float:
        return self.sent + DEADLINE_MS


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
    answered: bool = False


@dataclass
class RouteRecords:
    route: str
    echoes: dict[tuple[str, int], Echo] = field(default_factory=dict)
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
    """Echoes, connections, replies, pings and pongs of one route, from the time line."""
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
            rec.echoes[(inst, e["seq"])] = Echo(inst, e["conn"], e["seq"], e["t"])
        elif kind == "reply":
            echo = rec.echoes.get((inst, e["seq"]))
            if echo is None:
                rec.unknown_replies += 1
                continue
            echo.replies += 1
            if echo.replies > 1:
                rec.duplicates += 1
                continue
            echo.reply_t = e["t"]
            echo.rtt = e["t"] - echo.sent
            key = (inst, e["conn"])
            if e["seq"] < max_seq.get(key, -1):
                rec.reordered += 1
            max_seq[key] = max(max_seq.get(key, -1), e["seq"])
            conn = rec.connections.get(key)
            if conn is not None and echo.answered:
                conn.answered = True
        elif kind == "duplicate":
            rec.duplicates += 1
        elif kind == "unexpected":
            rec.unexpected += 1
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


def echoes_of(rec: RouteRecords, instance: str, conn: int) -> list[Echo]:
    return sorted(
        (s for s in rec.echoes.values() if s.instance == instance and s.conn == conn),
        key=lambda s: s.seq,
    )


# ---------------------------------------------------------------------------------------------
# Slots (Amendment 1, item 1; Amendment 2, items 1 and 2)


@dataclass
class Slots:
    total: int
    answered: int
    missed: int
    down: int
    unscheduled: int
    unaccounted: int
    observed: int
    observed_unscheduled: int
    observed_answered: int

    @property
    def outcome_fraction(self) -> float | None:
        """Slots with an outcome (answered, missed, down or unscheduled) over all slots."""
        return (self.total - self.unaccounted) / self.total if self.total else None

    @property
    def availability(self) -> float | None:
        """Answered slots over the observed slots, leaving out unscheduled ones."""
        counted = self.observed - self.observed_unscheduled
        return self.observed_answered / counted if counted else None


def slot_outcomes(
    rec: RouteRecords, soak_start: float, soak_end: float, spans: list[tuple[float, float]]
) -> list[str | None]:
    """Each 1-second slot of the soak, on the probe's time line:
      - "missed" if an echo sent in it was not answered within 1.0 s (with two echoes, either);
      - "answered" if every echo sent in it was answered within 1.0 s;
      - with no echo sent in it, "unscheduled" if a connection was open at any point in it (one
        ended before that second's echo, or jitter moved the echo into the next slot), else
        "down".
    A slot the records do not cover, with its echoes' deadline, has no outcome (None)."""
    n = int((soak_end - soak_start) // SLOT_MS)
    by_slot: dict[int, list[Echo]] = {}
    for echo in rec.echoes.values():
        k = math.floor((echo.sent - soak_start) / SLOT_MS)
        if 0 <= k < n:
            by_slot.setdefault(k, []).append(echo)
    open_spans = merge(
        [
            (c.open_t, c.close_t if c.close_t is not None else UNBOUNDED)
            for c in rec.connections.values()
        ]
    )
    out: list[str | None] = []
    for k in range(n):
        a = soak_start + k * SLOT_MS
        echoes = by_slot.get(k, [])
        if not covered(spans, a, a + SLOT_MS + DEADLINE_MS):
            out.append(None)
        elif echoes:
            out.append("answered" if all(e.answered for e in echoes) else "missed")
        # Open at some point in [a, a + 1 s): opened before the slot ends, closed after it starts.
        elif any(s < a + SLOT_MS and e > a for s, e in open_spans):
            out.append("unscheduled")
        else:
            out.append("down")
    return out


def count_slots(outcomes: list[str | None], soak_start: float, windows: list[Window]) -> Slots:
    observed = observed_unscheduled = observed_answered = 0
    for k, outcome in enumerate(outcomes):
        if slot_observed(soak_start + k * SLOT_MS, windows):
            observed += 1
            observed_unscheduled += outcome == "unscheduled"
            observed_answered += outcome == "answered"
    return Slots(
        total=len(outcomes),
        answered=outcomes.count("answered"),
        missed=outcomes.count("missed"),
        down=outcomes.count("down"),
        unscheduled=outcomes.count("unscheduled"),
        unaccounted=outcomes.count(None),
        observed=observed,
        observed_unscheduled=observed_unscheduled,
        observed_answered=observed_answered,
    )


# ---------------------------------------------------------------------------------------------
# Drops, failed opens, recoveries and gaps (section 6, Amendment 1 items 2 and 7)


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


def drop_start(echoes: list[Echo], moment: float) -> float:
    """The earlier of the drop's moment and the first missed deadline in the run of misses
    before it: the echoes after the connection's last answered one whose deadline had passed."""
    last_answered = max((i for i, s in enumerate(echoes) if s.answered), default=-1)
    run = [s for s in echoes[last_answered + 1 :] if not s.answered and s.deadline <= moment]
    if not run:
        return moment
    return min(moment, min(s.deadline for s in run))


def ended(conn: Connection) -> bool:
    """Ended by a close frame, a transport error or the silence deadline, not by the probe's
    own close at the end of the run."""
    return conn.close_t is not None and conn.by != "end"


def find_drops(rec: RouteRecords) -> list[Drop]:
    """A connection on which an echo was answered, ending: a drop. A connection that ends before
    any echo is answered on it is a failed attempt, not a drop (Amendment 1, item 2)."""
    drops = []
    for conn in rec.connections.values():
        if not ended(conn) or not conn.answered:
            continue
        assert conn.close_t is not None
        drops.append(
            Drop(
                route=rec.route,
                instance=conn.instance,
                conn=conn.conn,
                moment=conn.close_t,
                start=drop_start(echoes_of(rec, conn.instance, conn.conn), conn.close_t),
                by=conn.by,
                code=conn.code,
                reason=conn.reason,
                ids_before=conn.ids[-1] if conn.ids else None,
            )
        )
    drops.sort(key=lambda d: d.start)
    return drops


def failed_opens(rec: RouteRecords) -> list[Connection]:
    """Connections that opened and ended with no echo answered on them."""
    return sorted(
        (c for c in rec.connections.values() if ended(c) and not c.answered),
        key=lambda c: c.open_t,
    )


def attach_recoveries(rec: RouteRecords, drops: list[Drop], tail_end: float) -> None:
    """Recovery: from the drop start to the first answered echo on a new connection, by the
    tail's end. Failed opens in between are part of the same recovery. Otherwise the recovery
    time is unbounded."""
    answers = sorted(
        ((echo.reply_t, echo) for echo in rec.echoes.values() if echo.answered),
        key=lambda pair: pair[0],
    )
    for drop in drops:
        for reply_t, echo in answers:
            if reply_t > tail_end:
                break
            conn = rec.connections.get((echo.instance, echo.conn))
            same = (echo.instance, echo.conn) == (drop.instance, drop.conn)
            if conn is None or same or conn.open_t < drop.moment:
                continue
            drop.recovered_at = reply_t
            drop.recovery_ms = reply_t - drop.start
            drop.ids_after = conn.ids[0] if conn.ids else None
            break


def in_soak(t: float, soak_start: float, soak_end: float) -> bool:
    return soak_start <= t < soak_end


def classify(drops: list[Drop], soak_start: float, soak_end: float, windows: list[Window]) -> None:
    """A drop that starts in a forced window is a forced-event drop of that event; every other
    drop that starts in the soak is spontaneous. Drops that start before the soak or in the tail
    are not counted."""
    for drop in drops:
        drop.windows = windows_containing(drop.start, windows)
        if not in_soak(drop.start, soak_start, soak_end):
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
        run: list[Echo] = []
        for echo in echoes_of(rec, conn.instance, conn.conn):
            if not echo.answered:
                run.append(echo)
                continue
            if run:
                start = run[0].deadline
                gaps.append(
                    Gap(
                        conn.instance,
                        conn.conn,
                        start,
                        len(run),
                        float(echo.reply_t if echo.reply_t is not None else start),
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
    first_connection: float | None
    failed_opens: list[float]
    attempts: int
    failed_attempts: int
    failed_statuses: dict[str, int]
    slots: Slots
    spontaneous: list[Drop]
    forced: dict[str, list[Drop]]
    outside: list[Drop]
    spontaneous_rate: float
    gaps: list[Gap]
    echoes: int
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

    @property
    def outcome_fraction(self) -> float | None:
        return self.slots.outcome_fraction

    @property
    def availability(self) -> float | None:
        return self.slots.availability


def drop_rate(count: int, observed: float) -> float:
    if observed <= 0:
        return UNBOUNDED if count > 0 else 0.0
    return count / (observed / HOUR_MS)


def route_result(
    events: list[dict],
    route: str,
    built: bool,
    soak: tuple[float, float, float],
    windows: list[Window],
    spans: list[tuple[float, float]],
) -> RouteResult:
    """One route's numbers. `soak` is (S, E, end of the recovery tail)."""
    soak_start, soak_end, tail_end = soak
    rec = route_records(events, route)
    drops = find_drops(rec)
    attach_recoveries(rec, drops, tail_end)
    classify(drops, soak_start, soak_end, windows)
    forced: dict[str, list[Drop]] = {w.event: [] for w in windows}
    for drop in drops:
        if drop.kind == "forced":
            for event in drop.windows:
                forced[event].append(drop)
    sent = [s for s in rec.echoes.values() if in_soak(s.sent, soak_start, soak_end)]
    statuses: dict[str, int] = {}
    failed = [a for a in rec.attempts if not a.get("ok")]
    for a in failed:
        key = str(a.get("status") or a.get("error") or "unknown")
        statuses[key] = statuses.get(key, 0) + 1
    opens = [c.open_t for c in rec.connections.values()]
    working = [c.open_t for c in rec.connections.values() if c.answered]
    spontaneous = [d for d in drops if d.kind == "spontaneous"]
    outcomes = slot_outcomes(rec, soak_start, soak_end, spans)
    return RouteResult(
        route=route,
        built=built,
        connections=len(rec.connections),
        first_open=min(opens) if opens else None,
        first_connection=min(working) if working else None,
        failed_opens=[c.open_t for c in failed_opens(rec)],
        attempts=len(rec.attempts),
        failed_attempts=len(failed),
        failed_statuses=statuses,
        slots=count_slots(outcomes, soak_start, windows),
        spontaneous=spontaneous,
        forced=forced,
        outside=[d for d in drops if d.kind == "outside"],
        spontaneous_rate=drop_rate(len(spontaneous), observed_ms(soak_start, soak_end, windows)),
        gaps=[g for g in find_gaps(rec, windows) if in_soak(g.start, soak_start, soak_end)],
        echoes=len(sent),
        lost=sum(1 for s in sent if s.replies == 0),
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
        else:
            top = int(manifest["batches"])
            extra = sorted(n for n in numbers if n > top)
            if extra:
                unexpected[instance] = extra
        gaps = sorted(set(range(1, top + 1)) - numbers)
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
    first = result.first_connection
    reasons = []
    if not complete.all_present:
        reasons.append(
            f"batches missing {complete.missing or '-'}, no manifest {complete.no_manifest or '-'}"
        )
    if fraction is None or fraction < MIN_OUTCOME_FRACTION:
        reasons.append(f"soak slots with an outcome {fmt_fraction(fraction)} < 99%")
    if first is None or first >= soak_start:
        reasons.append("first connection (an echo answered on it) not before the soak started")
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
    """Criterion 6 (Amendment 1, item 4): at least one successful open at the preflight and at
    the run, and not recorded as refused by Cloudflare at the preflight."""
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
    return Outcome(5, None, f"inconclusive. {RULE5_TEXT}", watched)


def setup_failure() -> Outcome:
    """Amendment 1, item 6: a setup failure makes the outcome inconclusive (rule 5)."""
    return Outcome(5, None, f"inconclusive (rule 5, setup failure). {RULE5_TEXT}", [])


# ---------------------------------------------------------------------------------------------
# AR-17 (section 9, Amendment 1 item 5)


def ar17(
    result: RouteResult, ui_event: str, transport_event: str, unassessable: str | None = None
) -> tuple[str, int | None, int | None]:
    """Clear benefit, no benefit or no help, from the deploys' forced-event drops; or, without
    the evidence (Amendment 3, item 5), unassessable."""
    if unassessable is not None:
        return f"unassessable: {unassessable}", None, None
    t = len(result.forced.get(transport_event, []))
    u = len(result.forced.get(ui_event, []))
    if u > 0:
        verdict = "no help: the UI deploy drops the route"
    elif t > 0:
        verdict = "clear benefit: the transport deploy drops the route and the UI deploy does not"
    else:
        verdict = "no benefit: neither deploy drops the route"
    return verdict, t, u


def ar17_unassessable(
    windows: list[Window], spans: list[tuple[float, float]], setup_failed: bool
) -> str | None:
    """Why AR-17 cannot be assessed: a deploy window that cannot be placed, the probe's record
    over a window incomplete, or any other setup failure (Amendment 4, item 7: placing the
    windows and the deploys' effect both depend on a valid setup, so a clock step or a rollout
    counts too). None when it can."""
    deploys = {w.event: w for w in windows if w.kind == "deploy"}
    for event in ("ui deploy", "transport deploy"):
        if event not in deploys:
            return f"the {event} window cannot be placed"
    for event, w in deploys.items():
        if not covered(spans, w.start, w.end):
            return f"the probe's record over the {event} window is incomplete"
    if setup_failed:
        return "the setup failed"
    return None


# ---------------------------------------------------------------------------------------------
# Evidence validity and clock health (Amendment 3, items 1 and 2)

MAX_STEP_MS = 1000.0
MAX_SKEW_MS = 2000.0
# "Still answering at the tail's end": an echo answered within the last two seconds of the tail.
ANSWERING_MS = 2 * SLOT_MS
INSTANCE_GENERATION = re.compile(r"^g(\d+)-")


def short(numbers: list[int]) -> str:
    return ", ".join(str(n) for n in numbers[:8]) + (" …" if len(numbers) > 8 else "")


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def batch_problems(
    where: str, n: int, lines: list[dict], instance: str, run_id: object
) -> tuple[list[str], dict | None]:
    """One batch against its header: its number, instance, run, event count and span."""
    headers = [x for x in lines if "ev" not in x]
    events = [x for x in lines if "ev" in x]
    if len(headers) != 1:
        return [f"{where} batch {n}: {len(headers)} headers"], None
    h = headers[0]
    problems = [
        f"{where} batch {n}: its header's {key} is {h.get(key)!r}, not {want!r}"
        for key, want in (
            ("batch", n),
            ("instance", instance),
            ("runId", run_id),
            ("events", len(events)),
        )
        if h.get(key) != want
    ]
    start, cut = h.get("fromMono"), h.get("cutMono")
    if not (is_number(start) and is_number(cut)) or cut < start:
        return [*problems, f"{where} batch {n}: its header has no valid span"], None
    # A record timed before it was written (a close frame's arrival) carries loggedMono: the
    # batch holds the moment of writing.
    written = [e.get("loggedMono", e.get("mono")) for e in events]
    outside = sum(1 for m in written if not (is_number(m) and start <= m <= cut))
    if outside:
        problems.append(f"{where} batch {n}: {outside} events lie outside its span")
    return problems, h


def validate_batches(probe: dict[str, dict], run_id: object, label: str) -> list[str]:
    """Batches numbered 1 to the manifest's count with none beyond it, each matching its header
    and contents, spans joining without gaps, and the manifest's event count."""
    if not probe:
        return [f"{label}: no probe records"]
    problems: list[str] = []
    for instance, data in sorted(probe.items()):
        where = f"{label} probe {instance}"
        batches = data.get("batches", {})
        manifest = data.get("manifest")
        declared = max(batches, default=0)
        if manifest is None:
            problems.append(f"{where}: no manifest")
        elif not is_number(manifest.get("batches")) or manifest["batches"] < 0:
            problems.append(f"{where}: its manifest has no batch count")
        else:
            declared = int(manifest["batches"])
            if manifest.get("instance") != instance:
                problems.append(f"{where}: its manifest names another instance")
        missing = sorted(set(range(1, declared + 1)) - set(batches))
        beyond = sorted(n for n in batches if not 1 <= n <= declared)
        if missing:
            problems.append(f"{where}: batches missing: {short(missing)}")
        if beyond:
            problems.append(
                f"{where}: batches beyond the manifest's count of {declared}: {short(beyond)}"
            )
        total = 0
        previous: tuple[int, float] | None = None
        for n in sorted(batches):
            total += sum(1 for x in batches[n] if "ev" in x)
            found, header = batch_problems(where, n, batches[n], instance, run_id)
            problems.extend(found)
            if header is None:
                previous = None
                continue
            if previous is not None and previous[0] == n - 1 and header["fromMono"] != previous[1]:
                problems.append(f"{where} batch {n}: its span does not join batch {n - 1}'s")
            previous = (n, header["cutMono"])
        if manifest is not None and manifest.get("events") not in (None, total):
            problems.append(
                f"{where}: its manifest counts {manifest.get('events')} events, its batches hold {total}"
            )
    return problems


def terminal_problems(events: list[dict], tail_end: float, label: str) -> list[str]:
    """Every connection ends on record (close, error or silence close), or is still answering
    at the tail's end."""
    problems = []
    for route in ROUTES:
        rec = route_records(events, route)
        for c in rec.connections.values():
            if c.close_t is not None:
                continue
            last = max(
                (
                    e.reply_t
                    for e in rec.echoes.values()
                    if (e.instance, e.conn) == (c.instance, c.conn) and e.answered and e.reply_t
                ),
                default=None,
            )
            if last is None or last < tail_end - ANSWERING_MS:
                problems.append(
                    f"{label}: {route.upper()} connection {c.instance}/{c.conn} has no close "
                    "record and was not answering at the tail's end"
                )
    return problems


def conflict_problems(events: list[dict]) -> list[str]:
    return [
        f"the recorder held a different body for the probe's {e.get('what')}"
        for e in events
        if e.get("ev") == "batch-conflict"
    ]


def clock_problems(probe: dict[str, dict], label: str) -> list[str]:
    """The probe's clock: one fixed mapping from monotonic to wall time in its records, no step
    of more than 1.0 s in its per-minute clock records, and its skew against the Worker's clock
    (from P3's echoes) within ±2.0 s in every minute that has an estimate."""
    problems = []
    clocks = estimates = 0
    for instance, events in sorted(instance_events(probe).items()):
        diffs = [e["wall"] - e["mono"] for e in events if "wall" in e and "mono" in e]
        if diffs and max(diffs) - min(diffs) > MAX_STEP_MS:
            problems.append(
                f"{label} probe {instance}: its records are not on one fixed clock mapping (wall "
                f"minus monotonic moves by {max(diffs) - min(diffs):.0f} ms)"
            )
        steps, skews = [], []
        for e in events:
            if e.get("ev") == "clock":
                clocks += 1
                drift = e.get("driftMs")
                if not is_number(drift) or abs(drift) > MAX_STEP_MS:
                    steps.append(drift)
            elif e.get("ev") == "skew" and e.get("medianMs") is not None:
                estimates += 1
                if not is_number(e["medianMs"]) or abs(e["medianMs"]) > MAX_SKEW_MS:
                    skews.append(e["medianMs"])
        if steps:
            problems.append(
                f"{label} probe {instance}: clock step: {len(steps)} minute records differ from "
                f"the start's mapping by more than 1.0 s (first {steps[0]} ms)"
            )
        if skews:
            problems.append(
                f"{label} probe {instance}: skew against the Worker beyond ±2.0 s in "
                f"{len(skews)} minutes (first {skews[0]} ms)"
            )
    if clocks == 0:
        problems.append(f"{label}: no clock records")
    if estimates == 0:
        problems.append(f"{label}: no skew estimate from P3's echoes")
    return problems


def laptop_clock_problems(campaign: dict | None) -> list[str]:
    """The laptop's time synchronisation and its skew against Cloudflare's Date header, at the
    campaign's start and end."""
    clock = (campaign or {}).get("clock") or {}
    problems = []
    for point in ("start", "end"):
        record = clock.get(point)
        if not isinstance(record, dict):
            problems.append(f"no laptop clock record at the campaign's {point}")
            continue
        if record.get("synchronized") is not True:
            problems.append(f"the laptop's clock was not synchronised at the campaign's {point}")
        skew = record.get("skewMs")
        if not is_number(skew) or abs(skew) > MAX_SKEW_MS:
            problems.append(
                f"the laptop's skew against Cloudflare at the campaign's {point} is {skew} ms, "
                "beyond ±2.0 s"
            )
    return problems


def generations(probe: dict[str, dict]) -> list[int]:
    found = (INSTANCE_GENERATION.match(instance) for instance in probe)
    return [int(m.group(1)) for m in found if m]


def preflight_problems(
    pre_run: dict | None, run: dict, pre_probe: dict[str, dict] | None, run_probe: dict[str, dict]
) -> list[str]:
    """The preflight names a preflight run of the same deployment, distinct from the run and
    before it. Same deployment: the same Worker, and ComputerDO's generations (kept in its
    storage, which a new deployment starts afresh) all lower than the run's."""
    if pre_run is None or pre_probe is None:
        return ["no preflight records"]
    problems = []
    if pre_run.get("mode") != "preflight":
        problems.append(f"the preflight records are a {pre_run.get('mode')}, not a preflight")
    if pre_run.get("runId") == run.get("runId"):
        problems.append("the preflight records are the run's own")
    if not (
        is_number(pre_run.get("t0")) and is_number(run.get("t0")) and pre_run["t0"] < run["t0"]
    ):
        problems.append("the preflight did not start before the run")
    if pre_run.get("worker") is None or pre_run.get("worker") != run.get("worker"):
        problems.append("the preflight names another deployment")
    before, after = generations(pre_probe), generations(run_probe)
    if not before or not after or max(before) >= min(after):
        problems.append("the preflight's computer generations do not precede the run's")
    return problems


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
    preflight_run: dict | None = None


@dataclass
class Report:
    run_id: str
    mode: str
    soak_start: float
    soak_end: float
    tail_end: float
    public_built: bool
    windows: list[Window]
    observed_hours: float
    setup_problems: list[str]
    deviations: list[str]
    completeness: Completeness
    routes: dict[str, RouteResult]
    criteria: dict[str, dict[str, Criterion]]
    eligible: dict[str, bool]
    outcome: Outcome
    would_be: Outcome
    ar17: dict[str, tuple[str, int | None, int | None]]
    blocked: list[dict]


def probe_events(probe: dict[str, dict]) -> list[dict]:
    return timeline(instance_events(probe))


def soak_of(run: dict) -> tuple[float, float, float]:
    start, end = float(run["soakStart"]), float(run["soakEnd"])
    return start, end, float(run.get("tailEnd", end + TAIL_MS))


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
    """The forced windows, the setup problems (Amendment 1, item 6) and the deviations from the
    schedule that are reported only."""
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
        if d.get("uploaded") is None:
            problems.append(f'the {target} deploy has no "Uploaded" line: its window is undefined')
            continue
        if d.get("status") not in (0, None):
            deviations.append(
                f"the {target} deploy exited with status {d.get('status')} after its Uploaded line"
            )
        windows.append(deploy_window(f"{target} deploy", float(d["start"]), float(d["uploaded"])))
    return windows, problems, deviations


def blocked_checks(events: list[dict]) -> list[dict]:
    out = []
    for e in events:
        if e.get("ev") != "blocked-check":
            continue
        target = e.get("target")
        expected = POLICY_HOPS.get(str(target), f"{target}-handler")
        if target == "p5-badcred":
            expected = "p5-route"
        ok = e.get("status") == 403 and e.get("refusedBy") == expected
        out.append({**{k: e.get(k) for k in ("target", "status", "refusedBy")}, "ok": ok})
    return out


def analyze(inputs: Inputs) -> Report:
    run = inputs.run
    soak = soak_of(run)
    soak_start, soak_end, tail_end = soak
    public_built = bool(run.get("publicRoutes"))
    built_routes = set(run.get("routes") or [])
    events = probe_events(inputs.probe)
    spans = coverage(inputs.probe)
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
    # Amendment 3: the records are checked before the rule; nothing is repaired or inferred.
    invalid = (
        validate_batches(inputs.probe, run.get("runId"), "run")
        + terminal_problems(events, tail_end, "run")
        + conflict_problems(events)
    )
    pre = preflight_problems(inputs.preflight_run, run, inputs.preflight_probe, inputs.probe)
    if not pre:
        assert inputs.preflight_run is not None and inputs.preflight_probe is not None
        pre += validate_batches(
            inputs.preflight_probe, inputs.preflight_run.get("runId"), "preflight"
        )
        pre += terminal_problems(preflight or [], soak_of(inputs.preflight_run)[2], "preflight")
    problems += invalid + pre + clock_problems(inputs.probe, "run")
    problems += laptop_clock_problems(inputs.campaign)
    complete = completeness(inputs.probe)
    results = {r: route_result(events, r, r in built_routes, soak, windows, spans) for r in ROUTES}
    criteria = {}
    eligible = {}
    for route in CANDIDATES:
        support = supported(route, route in built_routes, preflight, events, inputs.refused)
        criteria[route] = eligibility(results[route], complete, soak_start, support)
        eligible[route] = route in built_routes and all(c.passed for c in criteria[route].values())
    rates = {r: results[r].spontaneous_rate for r in ROUTES}
    would_be = decide(eligible, rates, public_built)
    outcome = setup_failure() if problems else would_be
    ar: dict[str, tuple[str, int | None, int | None]] = {}
    unassessable = ar17_unassessable(windows, spans, bool(problems))
    for route in [outcome.selected] if outcome.selected else list(CANDIDATES):
        if route in built_routes:
            ar[route] = ar17(results[route], "ui deploy", "transport deploy", unassessable)
        else:
            ar[route] = ("not built", None, None)
    return Report(
        run_id=str(run.get("runId")),
        mode=str(run.get("mode")),
        soak_start=soak_start,
        soak_end=soak_end,
        tail_end=tail_end,
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
        would_be=would_be,
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
    problems: list[str]


def analyze_preflight(run: dict, lifecycle: list[dict], probe: dict[str, dict]) -> PreflightReport:
    """Section 5's preflight checks: all six routes, the forced reset, the block list, record
    completeness and validity (Amendment 3, item 1), and the probe's clock (item 2)."""
    events = probe_events(probe)
    problems = validate_batches(probe, run.get("runId"), "preflight")
    problems += terminal_problems(events, soak_of(run)[2], "preflight")
    problems += conflict_problems(events) + clock_problems(probe, "preflight")
    spans = coverage(probe)
    resets = resets_from(lifecycle)
    windows = [reset_window(f"reset {name}", r) for name, r in resets]
    routes = {}
    for route in ROUTES:
        built = route in (run.get("routes") or [])
        result = route_result(events, route, built, soak_of(run), windows, spans)
        routes[route] = {
            "built": built,
            "connected": connected(events, route),
            "connections": result.connections,
            "failedOpens": len(result.failed_opens),
            "failedAttempts": result.failed_attempts,
            "failedStatuses": result.failed_statuses,
            "drops": len(result.spontaneous) + sum(len(v) for v in result.forced.values()),
            "forcedRecoveryMs": [d.recovery_ms for v in result.forced.values() for d in v],
            "outcomeFraction": result.outcome_fraction,
        }
    return PreflightReport(
        str(run.get("runId")), routes, blocked_checks(events), resets, completeness(probe), problems
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
        f"soak {fmt_t(report.soak_start, s)} to {fmt_t(report.soak_end, s)}, recovery tail to "
        f"{fmt_t(report.tail_end, s)}; observed hours {report.observed_hours:.4f}; "
        f"P4/P5 built: {report.public_built}",
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
        sl = r.slots
        lines.append(f"{route.upper()} (built: {r.built})")
        lines.append(
            f"  connections {r.connections}, failed opens {len(r.failed_opens)}, attempts "
            f"{r.attempts} ({r.failed_attempts} failed: {r.failed_statuses or '-'}), first open "
            f"{fmt_t(r.first_open, s)}, first connection {fmt_t(r.first_connection, s)}"
        )
        lines.append(
            f"  slots {sl.total}: answered {sl.answered}, missed {sl.missed}, down {sl.down}, "
            f"unscheduled {sl.unscheduled}, no outcome {sl.unaccounted} "
            f"(with an outcome {fmt_fraction(sl.outcome_fraction)})"
        )
        lines.append(
            f"  observed slots {sl.observed} ({sl.observed_unscheduled} unscheduled, left out), "
            f"answered {sl.observed_answered}, availability {fmt_fraction(sl.availability)}"
        )
        lines.append(
            f"  spontaneous drops {len(r.spontaneous)} ({fmt_rate(r.spontaneous_rate)} per observed hour)"
        )
        lines.extend(render_drop(d, s) for d in r.spontaneous)
        for event, drops in r.forced.items():
            lines.append(f"  forced-event drops, {event}: {len(drops)}")
            lines.extend(render_drop(d, s) for d in drops)
        if r.outside:
            lines.append(f"  drops before the soak or in the tail (not counted): {len(r.outside)}")
        lines.append(f"  gaps {len(r.gaps)}")
        for g in r.gaps:
            lines.append(
                f"      {fmt_t(g.start, s)} .. {fmt_t(g.end, s)} misses={g.misses} "
                f"windows={g.windows or '-'}"
            )
        lines.append(
            f"  echoes {r.echoes}: lost {r.lost}, duplicated {r.duplicated}, reordered "
            f"{r.reordered}, unexpected {r.unexpected}, replies to unknown echoes {r.unknown_replies}"
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
        lines.append("SETUP FAILED:")
        lines.extend(f"  {p}" for p in report.setup_problems)
    lines.append(f"OUTCOME (rule {report.outcome.rule}): {report.outcome.text}")
    if report.setup_problems:
        lines.append(
            f"(for information only, without the setup failure the rule would give rule "
            f"{report.would_be.rule}: {report.would_be.text})"
        )
    for route, (verdict, t, u) in report.ar17.items():
        counts = "" if t is None else f" (transport deploy drops {t}, UI deploy drops {u})"
        lines.append(f"AR-17 {route.upper()}: {verdict}{counts}")
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
    lines.append(f"record problems: {len(report.problems)}")
    lines.extend(f"  {p}" for p in report.problems)
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
    pre_run, _, preflight_probe = load_dir(args.preflight) if args.preflight else (None, [], None)
    campaign = read_json(args.campaign) if args.campaign else None
    report = analyze(
        Inputs(run, lifecycle, probe, campaign, preflight_probe, set(args.unsupported), pre_run)
    )
    print(render(report))
    if args.json:
        args.json.write_text(json.dumps(jsonable(asdict(report)), indent=2, default=str) + "\n")
    # 2 marks a setup failure: the outcome is then inconclusive by Amendment 1, item 6.
    return 2 if report.setup_problems else 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
