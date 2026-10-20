"""The X1 analyzer against synthetic records: every branch of section 8's rule, each eligibility
criterion's boundary, forced-window edges, Amendment 1's slots, failed opens, setup failure and
recovery tail, and the record anomalies section 6 reports."""

from __future__ import annotations

import json
import math

import analyze
import pytest
from scenario import (
    DEPLOYS,
    FIRST_OPEN,
    MIN,
    OBSERVED_MS,
    RESETS,
    ROUTES,
    SLOTS,
    T0,
    TAIL,
    TAIL_END,
    UPLOAD_MS,
    Builder,
    DropSpec,
    E,
    S,
    campaign,
    clean,
    inputs,
    lifecycle,
    preflight,
    run_json,
    spontaneous_time,
)


def build(**per_route) -> Builder:
    """A run where every route is connected throughout, except as `per_route` says."""
    b = Builder()
    for route in ROUTES:
        spec = per_route.get(route, {})
        if spec == "never":
            b.never(route)
        elif spec != "absent":
            b.route(route, **spec)
    return b


def run(b: Builder | None = None, **kwargs) -> analyze.Report:
    return analyze.analyze(inputs(b, **kwargs))


def drops_at(*times: float, outage: float = 500.0, **kw) -> dict:
    return {"drops": tuple(DropSpec(at=t, outage=outage, **kw) for t in times)}


# Slots touching a forced window on the default schedule: 33 per reset (R-2 s .. R+30 s on the
# grid) and 351 per deploy (start .. Uploaded + 330 s).
OBSERVED_SLOTS = SLOTS - 3 * 33 - 2 * 351


# ---------------------------------------------------------------------------------------------
# The rule, in order


def test_clean_run_selects_a_prime():
    report = run()
    assert report.setup_problems == []
    assert report.outcome.rule == 1 and report.outcome.selected == "p2"
    assert report.eligible == {"p2": True, "p6": True, "p5": True}
    p2 = report.routes["p2"]
    assert p2.spontaneous == [] and p2.availability == 1.0 and p2.outcome_fraction == 1.0
    assert (p2.slots.total, p2.slots.answered, p2.slots.down) == (SLOTS, SLOTS, 0)
    assert p2.slots.observed == OBSERVED_SLOTS
    assert report.observed_hours == pytest.approx(OBSERVED_MS / 3_600_000)
    assert report.tail_end == TAIL_END
    assert report.ar17 == {"p2": ("no benefit: neither deploy drops the route", 0, 0)}
    text = analyze.render(report)
    assert "OUTCOME (rule 1): select A′ native forwarding (P2)." in text
    assert "core changes 12 and 14" in text
    assert "for information only" not in text


def test_v_when_p2_fails_drop_rate():
    b = build(p2=drops_at(spontaneous_time(1), spontaneous_time(5)))
    report = run(b)
    crit = report.criteria["p2"]
    assert not crit["1 drop rate"].passed
    assert crit["2 spontaneous recovery"].passed
    assert report.outcome.rule == 2 and report.outcome.selected == "p6"
    rate = 2 / (OBSERVED_MS / 3_600_000)
    assert report.routes["p2"].spontaneous_rate == pytest.approx(rate)


def test_v_when_p2_fails_spontaneous_recovery():
    b = build(p2=drops_at(spontaneous_time(1), outage=5000.0))
    report = run(b)
    crit = report.criteria["p2"]
    assert crit["1 drop rate"].passed
    assert not crit["2 spontaneous recovery"].passed
    assert report.routes["p2"].spontaneous[0].recovery_ms == pytest.approx(5020.0)
    assert report.outcome.selected == "p6"


def test_v_when_p2_fails_forced_recovery():
    reset = RESETS["reset-s30"]
    b = build(p2=drops_at(reset + 1000, outage=61_000.0))
    report = run(b)
    crit = report.criteria["p2"]
    assert crit["1 drop rate"].passed and crit["2 spontaneous recovery"].passed
    assert not crit["3 forced recovery"].passed
    assert [d.kind for d in report.routes["p2"].forced["reset reset-s30"]] == ["forced"]
    assert report.outcome.selected == "p6"


def test_v_when_p2_first_connects_after_the_soak_starts():
    b = build(p2={"start": S + 1000})
    report = run(b)
    assert "first connection" in report.criteria["p2"]["5 complete data"].detail
    assert report.outcome.selected == "p6"


def test_v_when_p2_is_not_supported():
    report = run(pre=preflight(("p1", "p3", "p4", "p5", "p6")))
    crit = report.criteria["p2"]["6 supported"]
    assert not crit.passed and "preflight" in crit.detail
    assert report.outcome.selected == "p6"
    refused = run(refused={"p2"})
    assert not refused.criteria["p2"]["6 supported"].passed
    assert refused.outcome.selected == "p6"


def test_v_when_p2_never_connected_at_the_run():
    report = run(build(p2="never"))
    p2 = report.routes["p2"]
    assert not report.criteria["p2"]["6 supported"].passed
    assert "the run" in report.criteria["p2"]["6 supported"].detail
    assert p2.first_open is None and p2.first_connection is None
    # Every slot of a route that never connected is down: the records account for all of them.
    assert p2.slots.down == SLOTS and p2.outcome_fraction == 1.0 and p2.availability == 0.0
    assert p2.failed_statuses == {"502": 3}
    assert report.outcome.selected == "p6"


def test_design_criterion_is_section_seven():
    result = run().routes["p1"]
    crit = analyze.eligibility(result, analyze.completeness({}), S, (True, "x"))
    assert not crit["4 design"].passed
    assert not crit["5 complete data"].passed  # no instances at all: nothing is present


def test_c_when_p2_and_p6_fail():
    b = build(
        p2=drops_at(spontaneous_time(1), spontaneous_time(5)),
        p6=drops_at(spontaneous_time(2), outage=9000.0),
    )
    report = run(b)
    assert report.outcome.rule == 3 and report.outcome.selected == "p5"
    assert "F7 decision" in report.outcome.text
    assert set(report.ar17) == {"p5"}


def test_rule_four_when_every_route_recycles():
    twice = drops_at(spontaneous_time(1), spontaneous_time(5))
    b = build(p2=twice, p3=twice, p4=twice, p5=twice, p6=twice)
    report = run(b)
    assert report.outcome.rule == 4 and report.outcome.selected is None
    assert report.outcome.rule4_routes == ["p3", "p4", "p5", "p6"]
    assert set(report.ar17) == {"p2", "p6", "p5"}


def test_inconclusive_when_one_watched_route_is_quiet():
    twice = drops_at(spontaneous_time(1), spontaneous_time(5))
    once = drops_at(spontaneous_time(3))
    b = build(p2=twice, p3=once, p4=twice, p5=twice, p6=twice)
    report = run(b)
    assert report.outcome.rule == 5
    assert report.outcome.text.startswith("inconclusive.")


def test_f7_declined_rule_four_reads_p3_and_p6():
    twice = drops_at(spontaneous_time(1), spontaneous_time(5))
    b = Builder()
    for route, spec in (("p1", {}), ("p2", twice), ("p3", twice), ("p6", twice)):
        b.route(route, **spec)
    report = run(b, public=False)
    assert not report.public_built
    assert not report.eligible["p5"]
    assert report.criteria["p5"]["6 supported"].detail == "not built"
    assert report.outcome.rule == 4 and report.outcome.rule4_routes == ["p3", "p6"]
    assert report.ar17["p5"] == ("not built", 0, 0)


def test_f7_declined_never_selects_c():
    b = Builder()
    for route in ("p1", "p2", "p3", "p6"):
        b.route(
            route,
            **(drops_at(spontaneous_time(1), spontaneous_time(5)) if route in ("p2", "p6") else {}),
        )
    # Even with P5 records present, an unbuilt route is not eligible.
    b.route("p5")
    report = run(b, public=False)
    assert report.outcome.rule == 5


# ---------------------------------------------------------------------------------------------
# Criterion boundaries


def boundary_run(drops: int) -> analyze.Report:
    """A soak whose observed time is exactly 2 hours, with `drops` spontaneous P2 drops."""
    soak_end = S + 2 * 3_600_000 + (E - S - OBSERVED_MS)
    times = [spontaneous_time(k) for k in range(drops)]
    end = soak_end + TAIL
    b = build(
        p2={**drops_at(*times), "end": end},
        **{r: {"end": end} for r in ("p1", "p3", "p4", "p5", "p6")},
    )
    return run(b, run=run_json(soak_end=soak_end))


def test_exactly_one_drop_per_observed_hour_passes():
    report = boundary_run(2)
    assert report.observed_hours == pytest.approx(2.0)
    assert report.routes["p2"].spontaneous_rate == 1.0
    assert report.criteria["p2"]["1 drop rate"].passed
    assert not boundary_run(3).criteria["p2"]["1 drop rate"].passed


@pytest.mark.parametrize(("outage", "passed"), [(4980.0, True), (4981.0, False)])
def test_spontaneous_recovery_boundary_is_5_seconds(outage, passed):
    report = run(build(p2=drops_at(spontaneous_time(1), outage=outage)))
    assert report.criteria["p2"]["2 spontaneous recovery"].passed is passed


@pytest.mark.parametrize(("outage", "passed"), [(59_980.0, True), (59_981.0, False)])
def test_forced_recovery_boundary_is_60_seconds(outage, passed):
    report = run(build(p2=drops_at(RESETS["reset-s60"], outage=outage)))
    drops = report.routes["p2"].forced["reset reset-s60"]
    assert len(drops) == 1
    assert report.criteria["p2"]["3 forced recovery"].passed is passed


def gap_probe(gap_slots: int) -> dict:
    """Two probe instances, each with every batch and its manifest, with the records covering
    nothing for `gap_slots` - 1 seconds between them. A slot needs its second and its echoes'
    1.0 s deadline covered, so that leaves `gap_slots` slots with no outcome."""
    c1 = spontaneous_time(3)
    c2 = c1 + 1000 * (gap_slots - 1)
    first, second = Builder(instance="g1-0a1b2c3d-000001"), Builder(instance="g2-0a1b2c3d-000002")
    for route in ROUTES:
        first.route(route, end=c1 + 1)
        second.route(route, start=c2)
    first.mark(c1)
    second.mark(c2)
    return {**first.probe(batches=2), **second.probe(batches=2)}


@pytest.mark.parametrize(("gap_slots", "passed"), [(72, True), (73, False)])
def test_outcome_fraction_boundary_is_99_percent(gap_slots, passed):
    report = run(probe=gap_probe(gap_slots))
    assert report.completeness.all_present
    for route in ("p2", "p5", "p6"):
        slots = report.routes[route].slots
        assert (slots.total, slots.unaccounted) == (SLOTS, gap_slots)
        assert report.criteria[route]["5 complete data"].passed is passed


def test_slots_without_records_are_shared_by_every_route():
    """Completeness counts slots the records cover, which no route's own events change: P2
    cannot fail criterion 5's 99% alone (only its first connection is its own)."""
    report = run(probe=gap_probe(100))
    fractions = {r.outcome_fraction for r in report.routes.values()}
    assert fractions == {(SLOTS - 100) / SLOTS}
    assert "slots with an outcome" in report.criteria["p2"]["5 complete data"].detail


def test_recovery_counts_missed_echoes_on_the_new_connection():
    b = build(p2=drops_at(spontaneous_time(1), outage=500.0, misses_after=3))
    drop = run(b).routes["p2"].spontaneous[0]
    assert drop.recovery_ms == pytest.approx(500 + 3000 + 20)


def test_unrecovered_drop_is_unbounded():
    b = build(p2={"drops": (DropSpec(at=spontaneous_time(1), reconnect=False),)})
    report = run(b)
    drop = report.routes["p2"].spontaneous[0]
    assert math.isinf(drop.recovery_ms) and drop.recovered_at is None
    assert not report.criteria["p2"]["2 spontaneous recovery"].passed
    assert "unbounded" in analyze.render(report)


# ---------------------------------------------------------------------------------------------
# Amendment 1, item 7: the recovery tail


def test_a_drop_near_the_soak_end_recovers_in_the_tail():
    b = build(p2=drops_at(E - 2000, outage=5000.0))
    drop = run(b).routes["p2"].spontaneous[0]
    assert drop.recovered_at == E + 3020 and drop.recovery_ms == pytest.approx(5020.0)


@pytest.mark.parametrize(("outage", "recovered"), [(61_980.0, True), (61_981.0, False)])
def test_recovery_completing_at_the_tails_last_moment(outage, recovered):
    """A drop at E - 2 s, recovered by an echo answered at exactly E + 60 s, or 1 ms later."""
    b = build(p2={**drops_at(E - 2000, outage=outage), "end": TAIL_END + 1000})
    drop = run(b).routes["p2"].spontaneous[0]
    if recovered:
        assert drop.recovered_at == TAIL_END and drop.recovery_ms == pytest.approx(62_000.0)
    else:
        assert drop.recovered_at is None and math.isinf(drop.recovery_ms)


@pytest.mark.parametrize(
    ("at", "kind"),
    [
        (S - 1, "outside"),
        (S, "spontaneous"),
        (E - 1, "spontaneous"),
        (E, "outside"),
        (E + 30_000, "outside"),
    ],
)
def test_soak_edges_for_drops(at, kind):
    """The soak is [S, E): a drop starting at S+120 min exactly is in the tail, not counted."""
    r = run(build(p2=drops_at(at))).routes["p2"]
    found = r.spontaneous + r.outside
    assert [d.kind for d in found] == [kind]


# ---------------------------------------------------------------------------------------------
# Amendment 1, item 2: failed opens


def test_failed_open_during_recovery_is_part_of_it():
    """A connection opens and closes with no echo answered on it while the route recovers: no
    new drop, and the recovery runs on to the first answered echo."""
    at = spontaneous_time(2)
    b = build(p2=drops_at(at, outage=3000.0, failed=(500.0, 1500.0)))
    r = run(b).routes["p2"]
    assert len(r.spontaneous) == 1 and r.outside == []
    assert r.failed_opens == [at + 500.0, at + 1500.0]
    assert r.connections == 4
    assert r.spontaneous[0].recovery_ms == pytest.approx(3020.0)
    # Their unanswered echoes are missed slots; the seconds with no connection are down.
    assert r.slots.missed == 2


def test_failed_open_in_the_warm_up_and_after_it():
    """The first open fails in the warm-up; the route works before S: no drop, criterion 5
    passes. For P6 the only open before S fails and the first working connection comes after S:
    no drop either, and criterion 5 fails on the first connection."""
    b = Builder()
    for route in ROUTES:
        if route in ("p2", "p6"):
            b.failed_open(route, FIRST_OPEN - 5000)
        start = S + 30_000 if route == "p6" else FIRST_OPEN
        b.route(route, start=start)
    report = run(b)
    p2, p6 = report.routes["p2"], report.routes["p6"]
    assert p2.failed_opens == [FIRST_OPEN - 5000] and p2.spontaneous == p2.outside == []
    assert p2.first_open == FIRST_OPEN - 5000 and p2.first_connection == FIRST_OPEN
    assert report.criteria["p2"]["5 complete data"].passed
    assert p6.spontaneous == p6.outside == [] and p6.first_connection == S + 30_000
    assert not report.criteria["p6"]["5 complete data"].passed
    assert report.outcome.selected == "p2"


def test_a_connection_with_only_late_replies_is_a_failed_open():
    at = spontaneous_time(2)
    b = build(p2=drops_at(at, outage=2000.0))
    b.failed_open("p2", at + 500.0)
    late = [
        e for e in b.events if e["ev"] == "send" and e["route"] == "p2" and e["mono"] == at + 500.0
    ][0]
    b.add("reply", at + 1600.0, route="p2", conn=2, seq=late["seq"], rtt=1100.0)
    r = run(b).routes["p2"]
    assert len(r.spontaneous) == 1 and r.failed_opens == [at + 500.0]


# ---------------------------------------------------------------------------------------------
# Amendment 1, item 1: slots


def records(events: list[dict]) -> analyze.RouteRecords:
    line = analyze.timeline({"i": [{"wall": e["t"], "mono": e["t"], **e} for e in events]})
    return analyze.route_records(line, "p1")


def echo(seq: int, sent: float, rtt: float | None, conn: int = 1) -> list[dict]:
    out = [{"ev": "send", "route": "p1", "conn": conn, "seq": seq, "t": sent}]
    if rtt is not None:
        out.append({"ev": "reply", "route": "p1", "conn": conn, "seq": seq, "t": sent + rtt})
    return out


def test_slot_edges_and_outcomes():
    """Slots are [S + k s, S + (k+1) s) for the soak [S, E); an echo belongs to the slot its send
    time falls in. Here S = 0 and E = 6 s: six slots."""
    events = [{"ev": "open", "route": "p1", "conn": 1, "t": -5000.0}]
    events += echo(1, -1.0, 10)  # before the soak: no slot
    events += echo(2, 0.0, 10)  # slot 0, answered
    events += echo(3, 1000.0, 1001)  # slot 1, answered late: missed
    events += echo(4, 2000.0, None) + echo(5, 2999.0, 1000)  # slot 2: one missed, one answered
    # slot 3: nothing sent, a connection open: down (counted as down while open)
    events += [{"ev": "close", "route": "p1", "conn": 1, "by": "peer", "code": 1006, "t": 3500.0}]
    # slot 4: nothing sent, no connection: down
    events += echo(6, 5999.0, None)  # slot 5 (the last one), missed
    events += echo(7, 6000.0, 10)  # at E exactly: no slot
    rec = records(events)
    outcomes = analyze.slot_outcomes(rec, 0.0, 6000.0, [(-10_000.0, 10_000.0)])
    assert outcomes == ["answered", "missed", "answered", "down", "down", "missed"]
    counts = analyze.count_slots(rec, outcomes, 0.0, [])
    assert (counts.answered, counts.missed, counts.down, counts.down_while_open) == (2, 2, 2, 1)
    assert counts.availability == pytest.approx(2 / 6) and counts.outcome_fraction == 1.0


def test_a_slot_needs_its_second_and_its_deadline_covered():
    rec = records(echo(1, 0.0, 10) + echo(2, 1000.0, 10) + echo(3, 2000.0, 10))
    # Records cover 0 .. 2.999 s: slot 0 (with its deadline, to 2 s) is covered; slot 1's
    # deadline runs to 3 s, past the cover; slot 2 too.
    outcomes = analyze.slot_outcomes(rec, 0.0, 3000.0, [(0.0, 2999.0)])
    assert outcomes == ["answered", None, None]
    counts = analyze.count_slots(rec, outcomes, 0.0, [])
    assert counts.unaccounted == 2 and counts.outcome_fraction == pytest.approx(1 / 3)
    assert analyze.slot_outcomes(rec, 0.0, 3000.0, []) == [None, None, None]


def test_observed_slots_exclude_any_slot_a_window_touches():
    w = analyze.Window("w", "reset", 1500.0, 2000.0)
    assert [analyze.slot_observed(a, [w]) for a in (0.0, 1000.0, 2000.0, 3000.0)] == [
        True,
        False,
        False,
        True,
    ]
    edge = analyze.Window("e", "reset", 999.0, 999.0)
    assert analyze.slot_observed(0.0, [edge]) is False and analyze.slot_observed(1000.0, [edge])


def test_outages_count_against_availability():
    at = spontaneous_time(2)
    r = run(build(p2=drops_at(at, outage=4500.0))).routes["p2"]
    # The connection ends at `at` (a slot start); the next opens 4.5 s later. Slots at, +1 s,
    # +2 s and +3 s have no echo: down. The one at +4 s holds the new connection's first echo.
    assert r.slots.down == 4 and r.slots.down_while_open == 0
    assert r.slots.observed_answered == r.slots.observed - 4
    assert r.availability == pytest.approx((OBSERVED_SLOTS - 4) / OBSERVED_SLOTS)


def test_gap_is_reported_not_counted_as_a_drop():
    miss = (spontaneous_time(4), spontaneous_time(4) + 1000)
    report = run(build(p2={"miss_at": miss}))
    r = report.routes["p2"]
    assert r.spontaneous == []
    assert len(r.gaps) == 1 and r.gaps[0].misses == 2
    assert r.gaps[0].start == miss[0] + 1000
    assert r.slots.missed == 2 and r.slots.observed_answered == r.slots.observed - 2
    assert r.lost == 2
    assert report.eligible["p2"]


# ---------------------------------------------------------------------------------------------
# Drop start and forced-window attribution


def test_drop_start_is_the_first_missed_deadline_before_a_silence_close():
    last_answered = spontaneous_time(1)
    # Misses from the next send; the silence close comes 3.0 s after the last frame.
    moment = last_answered + 20 + 3000
    b = build(p2={"drops": (DropSpec(at=moment, by="silence", code=4000, misses_before=3),)})
    drop = run(b).routes["p2"].spontaneous[0]
    # Sends at +1000, +2000, +3000 are missed; deadlines at +2000 and +3000 precede the close.
    assert drop.start == last_answered + 2000
    assert drop.moment == moment
    assert drop.by == "silence" and drop.code == 4000


def test_drop_without_misses_starts_at_its_moment():
    drop = run(build(p2=drops_at(spontaneous_time(2) + 300))).routes["p2"].spontaneous[0]
    assert drop.start == spontaneous_time(2) + 300


@pytest.mark.parametrize(
    ("offset", "kind"),
    [(-2001, "spontaneous"), (-2000, "forced"), (30_000, "forced"), (30_001, "spontaneous")],
)
def test_reset_window_edges(offset, kind):
    r = RESETS["reset-s90"]
    report = run(build(p2=drops_at(r + offset)))
    drops = report.routes["p2"]
    found = drops.spontaneous + drops.forced["reset reset-s90"]
    assert [d.kind for d in found] == [kind]


@pytest.mark.parametrize(
    ("offset", "kind"),
    [
        (-1, "spontaneous"),
        (0, "forced"),
        (UPLOAD_MS + 330_000, "forced"),
        (UPLOAD_MS + 330_001, "spontaneous"),
    ],
)
def test_deploy_window_edges(offset, kind):
    start = DEPLOYS["transport"]
    report = run(build(p2=drops_at(start + offset)))
    r = report.routes["p2"]
    found = r.spontaneous + r.forced["transport deploy"]
    assert [d.kind for d in found] == [kind]


def test_drop_in_two_windows_is_forced_for_both():
    camp = campaign(deploys={"ui": RESETS["reset-s30"] - 1000, "transport": DEPLOYS["transport"]})
    report = run(build(p2=drops_at(RESETS["reset-s30"] + 500)), camp=camp)
    forced = report.routes["p2"].forced
    assert len(forced["reset reset-s30"]) == 1 and len(forced["ui deploy"]) == 1


def test_drops_before_the_soak_are_not_counted():
    b = build(p2=drops_at(T0 + 60_000))
    report = run(b)
    assert len(report.routes["p2"].outside) == 1
    assert report.routes["p2"].spontaneous == []
    assert report.eligible["p2"]


# ---------------------------------------------------------------------------------------------
# Gaps, sequence anomalies and pongs


def test_gap_in_a_forced_window_names_it():
    r = RESETS["reset-s30"] + 1000
    gaps = run(build(p2={"miss_at": (r - 1000,)})).routes["p2"].gaps
    assert gaps[0].windows == ["reset reset-s30"]


def test_duplicated_reordered_and_unknown_replies():
    b = clean()
    t = spontaneous_time(6)
    seqs = sorted(
        e["seq"]
        for e in b.events
        if e["ev"] == "send" and e["route"] == "p3" and t <= e["mono"] <= t + 3000
    )
    a, c = seqs[0], seqs[2]
    replies = {e["seq"]: e for e in b.events if e["ev"] == "reply" and e["route"] == "p3"}
    # a's reply arrives after c's, so a is reordered; a duplicate of a and a stray reply follow.
    replies[a]["mono"] = replies[a]["wall"] = replies[c]["mono"] + 5
    b.add("reply", t + 2500, route="p3", conn=1, seq=a, rtt=2500)
    b.add("duplicate", t + 2600, route="p3", conn=1, seq=a)
    b.add("reply", t + 2700, route="p3", conn=1, seq=999_999, rtt=1)
    b.add("unexpected", t + 2800, route="p3", conn=1, size=3)
    r = run(b).routes["p3"]
    assert r.duplicated == 2 and r.reordered == 1 and r.unknown_replies == 1 and r.unexpected == 1


def test_pong_record():
    b = build(p1={"pings": True})
    b.add("pong-missing", spontaneous_time(1), route="p1", conn=1, n=1)
    r = run(b).routes["p1"]
    assert r.pongs > 0 and r.pings == r.pongs and r.pongs_missing == 1
    assert r.pong_p50 == 5.0 and r.pong_max == 5.0


def test_drop_records_instance_identities_on_either_side():
    b = Builder()
    for route in ROUTES:
        if route == "p2":
            b.route(
                route,
                drops=(DropSpec(at=spontaneous_time(1)),),
                ids={"by": "server", "serverdo": "aa"},
            )
        else:
            b.route(route)
    drop = run(b).routes["p2"].spontaneous[0]
    assert drop.ids_before == {"by": "server", "serverdo": "aa", "conn": 1}
    assert drop.ids_after == {"by": "server", "serverdo": "aa", "conn": 2}


# ---------------------------------------------------------------------------------------------
# Data completeness and setup (Amendment 1, item 6)


def test_missing_batch_fails_every_route_and_leaves_its_slots_without_outcome():
    b = clean()
    report = run(b, probe=b.probe(batches=4, missing=(2,)))
    for route in ("p2", "p5", "p6"):
        assert not report.criteria[route]["5 complete data"].passed
        assert report.routes[route].slots.unaccounted > 0
    assert report.completeness.missing == {b.instance: [2]}
    assert report.outcome.rule == 5


def test_missing_manifest_fails_completeness():
    b = clean()
    report = run(b, probe=b.probe(batches=2, missing=(2,), manifest=False))
    assert report.completeness.no_manifest == [b.instance]
    assert report.completeness.missing == {}
    assert not report.completeness.all_present


def test_batches_beyond_the_manifest_are_listed():
    probe = clean().probe(batches=3)
    data = next(iter(probe.values()))
    data["manifest"]["batches"] = 2
    c = analyze.completeness(probe)
    assert c.unexpected == {next(iter(probe)): [3]} and c.all_present


def test_a_batch_without_its_span_covers_nothing():
    b = clean()
    probe = b.probe(batches=1)
    del probe[b.instance]["batches"][1][0]["cutMono"]
    report = run(probe=probe)
    assert report.routes["p2"].slots.unaccounted == SLOTS


def test_rollout_makes_the_outcome_inconclusive_and_still_reports():
    report = run(camp=campaign(rollout=("transport",)))
    assert report.outcome.rule == 5 and report.outcome.selected is None
    assert report.outcome.text.startswith("inconclusive (rule 5, setup failure).")
    assert report.would_be.rule == 1 and report.would_be.selected == "p2"
    assert "container rollout" in report.setup_problems[0]
    # Nothing is selected, so AR-17 covers every candidate.
    assert set(report.ar17) == {"p2", "p6", "p5"}
    text = analyze.render(report)
    assert "SETUP FAILED" in text
    assert "OUTCOME (rule 5): inconclusive (rule 5, setup failure)." in text
    assert "(for information only, without the setup failure the rule would give rule 1:" in text


def test_missing_uploaded_line_and_missing_deploy():
    report = run(camp=campaign(uploaded={"ui": None}, deploys={"ui": DEPLOYS["ui"]}))
    assert any('no "Uploaded" line' in p for p in report.setup_problems)
    assert any("no record of the transport deploy" in p for p in report.setup_problems)
    assert [w.event for w in report.windows] == [f"reset {k}" for k in RESETS]
    assert report.outcome.text.startswith("inconclusive (rule 5, setup failure)")


def test_failed_deploy_status_and_missing_reset_are_deviations():
    life = lifecycle({k: v for k, v in RESETS.items() if k != "reset-s60"})
    report = run(camp=campaign(status={"ui": 1}), life=life)
    assert report.setup_problems == []
    assert any("exited with status 1 after its Uploaded line" in d for d in report.deviations)
    assert any("reset-s60 was not recorded" in d for d in report.deviations)
    assert "schedule deviations" in analyze.render(report)


def test_preflight_records_and_campaign_must_match_the_run():
    report = run(run=run_json(mode="preflight"))
    assert any("a preflight, not a run" in p for p in report.setup_problems)
    camp = campaign()
    camp["runId"] = "run-20990101T000000Z"
    assert any("another run" in p for p in run(camp=camp).setup_problems)


def test_no_preflight_records_means_not_supported():
    report = run(pre=None)
    assert report.criteria["p2"]["6 supported"].detail == "no preflight records"
    assert report.outcome.rule == 5


# ---------------------------------------------------------------------------------------------
# AR-17 (Amendment 1, item 5)


def test_ar17_clear_benefit():
    b = build(p2=drops_at(DEPLOYS["transport"] + 60_000))
    assert run(b).ar17["p2"][0].startswith("clear benefit")


def test_ar17_no_help_whenever_the_ui_deploy_drops_the_route():
    both = build(p2=drops_at(DEPLOYS["transport"] + 60_000, DEPLOYS["ui"] + 60_000))
    assert run(both).ar17["p2"] == ("no help: the UI deploy drops the route", 1, 1)
    ui_only = build(p2=drops_at(DEPLOYS["ui"] + 60_000))
    assert run(ui_only).ar17["p2"] == ("no help: the UI deploy drops the route", 0, 1)


# ---------------------------------------------------------------------------------------------
# Clocks, preflight and the command line


def test_instance_offset_is_the_median_and_needs_events():
    events = [
        {"wall": 100.0, "mono": 1.0},
        {"wall": 105.0, "mono": 2.0},
        {"wall": 1000.0, "mono": 3.0},
    ]
    assert analyze.instance_offset(events) == 103.0
    with pytest.raises(ValueError):
        analyze.instance_offset([{"ev": "x"}])
    line = analyze.timeline({"a": [{"ev": "send", "wall": 50.0, "mono": 10.0}], "b": []})
    assert line == [{"ev": "send", "wall": 50.0, "mono": 10.0, "instance": "a", "t": 50.0}]


def test_two_instances_share_one_time_line():
    first = Builder(instance="g1-0a1b2c3d-000001")
    second = Builder(instance="g2-0a1b2c3d-000002")
    # The second instance's monotonic clock starts near zero; its wall clock carries on.
    first.route("p2", drops=(DropSpec(at=spontaneous_time(1), reconnect=False),))
    for route in ("p1", "p3", "p4", "p5", "p6"):
        first.route(route)
    restart = spontaneous_time(1) + 30_000
    second.route("p2", start=restart)
    for e in second.events:
        e["mono"] -= restart - 1000
    probe = {**first.probe(batches=1), **second.probe(batches=1)}
    probe[second.instance]["batches"][1][0]["fromMono"] -= restart - 1000
    probe[second.instance]["batches"][1][0]["cutMono"] -= restart - 1000
    report = run(probe=probe)
    drop = report.routes["p2"].spontaneous[0]
    assert drop.recovery_ms == pytest.approx(30_020.0)
    # Both instances' batches cover the soak, so every slot has an outcome.
    assert report.routes["p2"].slots.unaccounted == 0
    assert report.routes["p2"].slots.down == 30


def test_empty_instance_and_empty_batches():
    b = clean()
    probe = b.probe(batches=1)
    probe["g9-0a1b2c3d-000009"] = {"batches": {}, "manifest": {"batches": 0}}
    assert analyze.coverage(probe) == analyze.coverage(b.probe(batches=1))
    assert analyze.merge([(5.0, 4.0), (0.0, 1.0), (1.0, 2.0)]) == [(0.0, 2.0)]


def test_blocked_checks():
    b = clean()
    for target, status, hop in (
        ("p1", 403, "p1-handler"),
        ("p2", 403, "p2-handler"),
        ("p5", 403, "p5-route"),
        ("p6", 403, "p6-handler"),
        ("p5-badcred", 403, "p5-route"),
        ("p6", 502, None),
    ):
        b.add("blocked-check", T0 + 1000, target=target, status=status, refusedBy=hop)
    checks = run(b).blocked
    assert [c["ok"] for c in checks] == [True, True, True, True, True, False]


def test_preflight_report():
    b = Builder()
    pre_end = T0 + 10 * MIN
    for route in ROUTES:
        if route == "p6":
            b.never(route, status=426, start=T0 + 1000)
            continue
        drops = (DropSpec(at=T0 + 5 * MIN + 1000, outage=2000.0),) if route == "p1" else ()
        b.route(route, start=T0 + 20_000, end=pre_end + TAIL, drops=drops)
    b.add("blocked-check", T0 + 2000, target="p2", status=403, refusedBy="p2-handler")
    pre_run = {
        **run_json(),
        "mode": "preflight",
        "soakStart": T0,
        "soakEnd": pre_end,
        "tailEnd": pre_end + TAIL,
    }
    report = analyze.analyze_preflight(
        pre_run, lifecycle({"reset-t5": T0 + 5 * MIN}), b.probe(batches=1)
    )
    assert report.routes["p6"]["connected"] is False
    assert report.routes["p6"]["failedStatuses"] == {"426": 3}
    assert report.routes["p1"]["forcedRecoveryMs"] == [pytest.approx(2020.0)]
    assert report.routes["p1"]["failedOpens"] == 0
    assert report.blocked[0]["ok"] is True
    text = analyze.render_preflight(report)
    assert "P6:" in text and "reset reset-t5" in text


def write_dir(root, run_doc, life, probe):
    root.mkdir(parents=True)
    (root / "run.json").write_text(json.dumps(run_doc))
    (root / "lifecycle").mkdir()
    for i, rec in enumerate(life):
        (root / "lifecycle" / f"{i:04d}.json").write_text(json.dumps(rec))
    (root / "probe").mkdir()
    (root / "probe" / "stray.txt").write_text("not an instance")
    for instance, data in probe.items():
        d = root / "probe" / instance
        d.mkdir()
        for n, lines in data["batches"].items():
            (d / f"batch-{n:06d}.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + "\n")
        if data["manifest"] is not None:
            (d / "manifest.json").write_text(json.dumps(data["manifest"]))


def test_command_line(tmp_path, capsys):
    b = build(p2={"drops": (DropSpec(at=spontaneous_time(1), reconnect=False),)})
    write_dir(tmp_path / "run", run_json(), lifecycle(), b.probe())
    write_dir(tmp_path / "pre", run_json(mode="preflight"), [], preflight())
    (tmp_path / "campaign.json").write_text(json.dumps(campaign()))
    out = tmp_path / "out.json"
    code = analyze.main(
        [
            str(tmp_path / "run"),
            "--preflight",
            str(tmp_path / "pre"),
            "--campaign",
            str(tmp_path / "campaign.json"),
            "--json",
            str(out),
        ]
    )
    assert code == 0
    printed = capsys.readouterr().out
    assert "OUTCOME (rule 2): select V private Tunnel (P6)." in printed
    saved = json.loads(out.read_text())
    assert saved["outcome"]["selected"] == "p6"
    assert saved["routes"]["p2"]["spontaneous"][0]["recovery_ms"] == "unbounded"
    # Without a campaign record the setup failed: the outcome is inconclusive, exit status 2.
    assert analyze.main([str(tmp_path / "run"), "--preflight", str(tmp_path / "pre")]) == 2
    assert "inconclusive (rule 5, setup failure)" in capsys.readouterr().out
    pre_json = tmp_path / "pre.json"
    assert analyze.main(["--preflight-only", str(tmp_path / "pre"), "--json", str(pre_json)]) == 0
    assert json.loads(pre_json.read_text())["routes"]["p1"]["connected"] is True
    with pytest.raises(SystemExit):
        analyze.main([])


def test_formatting_helpers():
    assert analyze.fmt_ms(None) == "-" and analyze.fmt_ms(1500.0) == "1.500 s"
    assert analyze.fmt_rate(math.inf) == "unbounded"
    assert analyze.fmt_fraction(None) == "-"
    assert analyze.fmt_t(None, 0) == "-"
    assert analyze.percentile([], 0.5) is None
    assert analyze.drop_rate(0, 0) == 0.0 and math.isinf(analyze.drop_rate(1, 0))
    assert analyze.jsonable((1, math.inf)) == [1, "unbounded"]
    empty = analyze.Slots(0, 0, 0, 0, 0, 0, 0, 0)
    assert empty.outcome_fraction is None and empty.availability is None


def test_first_connection_before_the_soak_is_required_even_when_otherwise_clean():
    assert run(build(p6={"start": S})).criteria["p6"]["5 complete data"].passed is False
    assert run(build(p6={"start": S - 1})).criteria["p6"]["5 complete data"].passed is True


def test_records_of_unknown_connections_are_ignored():
    b = clean()
    b.add("ident", T0, route="p2", conn=99, id={})
    b.add("close", T0, route="p2", conn=99, by="peer", code=1000)
    b.add("send", T0, route="p2", conn=99, seq=10**9)
    b.add("reply", T0 + 5, route="p2", conn=99, seq=10**9, rtt=5)
    r = run(b).routes["p2"]
    assert r.connections == 1 and r.spontaneous == [] and r.outside == []


def test_first_open_is_the_earliest():
    assert run().routes["p1"].first_open == FIRST_OPEN


def test_render_lists_checks_outside_drops_and_gaps():
    b = build(p2={**drops_at(T0 + 60_000, outage=1000.0), "miss_at": (spontaneous_time(4),)})
    b.add("blocked-check", T0 + 1000, target="p2", status=403, refusedBy="p2-handler")
    b.add("something-new", T0 + 1000, route="p2")
    text = analyze.render(run(b))
    assert "block-list check p2: 403 p2-handler ok=True" in text
    assert "drops before the soak or in the tail (not counted): 1" in text
    assert "misses=1" in text
    assert "slots 7200: answered 7199, missed 1, down 0" in text


def test_preflight_only_without_json(tmp_path, capsys):
    write_dir(tmp_path / "pre", run_json(mode="preflight"), [], preflight())
    assert analyze.main(["--preflight-only", str(tmp_path / "pre")]) == 0
    assert "X1 preflight" in capsys.readouterr().out
