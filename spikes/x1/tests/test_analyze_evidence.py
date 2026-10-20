"""Amendment 3 in the analysis: evidence validity (item 1), clock health (item 2) and AR-17's
evidence (item 5), with Codex's reproductions from the probe review (x1-probe r1)."""

from __future__ import annotations

import copy

import analyze
import pytest
from scenario import (
    DEPLOYS,
    RESETS,
    ROUTES,
    RUN_ID,
    T0,
    UPLOAD_MS,
    Builder,
    DropSpec,
    S,
    campaign,
    clean,
    preflight,
    preflight_run,
    run_json,
    spontaneous_time,
)
from test_analyze import build, drops_at, run


def setup_failed(report: analyze.Report, words: str) -> None:
    assert report.outcome.text.startswith("inconclusive (rule 5, setup failure)")
    assert report.outcome.selected is None
    assert any(words in p for p in report.setup_problems), report.setup_problems


# ---------------------------------------------------------------------------------------------
# Item 1: evidence validity (r1 finding 1)


def test_deleted_events_with_headers_kept_fail_setup():
    """Codex: every P2 event after warm-up deleted, the batch headers kept, gave 100%
    completeness, 7,200 unscheduled slots and "select P2"."""
    b = build(p6=drops_at(spontaneous_time(1), spontaneous_time(5)))
    probe = b.probe()
    for lines in probe[b.instance]["batches"].values():
        lines[:] = [x for x in lines if not (x.get("route") == "p2" and x["mono"] >= S)]
    report = run(probe=probe, setup_fails=True)
    setup_failed(report, "header's events is")
    assert report.would_be is None and report.routes == {}  # nothing computed from them


def test_deleted_close_record_fails_setup_even_with_the_counts_fixed():
    """Codex: deleting an unrecovered connection's close record turned P2 from not eligible
    (P6 selected) into eligible."""
    b = build(p2={"drops": (DropSpec(at=spontaneous_time(1), reconnect=False),)})
    assert run(b).outcome.selected == "p6"
    probe = b.probe(batches=1)
    lines = probe[b.instance]["batches"][1]
    lines[:] = [x for x in lines if not (x.get("ev") == "close" and x.get("route") == "p2")]
    setup_failed(run(probe=copy.deepcopy(probe), setup_fails=True), "header's events is")
    lines[0]["events"] = len(lines) - 1
    probe[b.instance]["manifest"]["events"] = len(lines) - 1
    setup_failed(run(probe=probe, setup_fails=True), "has no terminal record")


def test_a_manifest_declaring_fewer_batches_fails_setup():
    """Codex: a manifest declaring 0 batches while 3 exist still passed."""
    b = clean()
    probe = b.probe(batches=3)
    probe[b.instance]["manifest"]["batches"] = 0
    setup_failed(run(probe=probe, setup_fails=True), "batches beyond the manifest's count of 0")


def test_the_run_as_its_own_preflight_fails_setup():
    """Codex: supplying the run itself as --preflight satisfied criterion 6."""
    b = clean()
    report = run(b, pre=b.probe(), pre_run=run_json(), setup_fails=True)
    setup_failed(report, "the preflight records are the run's own")
    assert any("not a preflight" in p for p in report.setup_problems)


@pytest.mark.parametrize(
    ("change", "words"),
    [
        (lambda pre: pre.update(worker="cfo-stg-x1-other"), "another deployment"),
        (lambda pre: pre.update(t0=T0 + 1), "did not start before the run"),
        (lambda pre: pre.pop("t0"), "preflight: run.json has no finite t0"),
    ],
)
def test_preflight_metadata(change, words):
    pre = preflight_run()
    change(pre)
    setup_failed(run(pre_run=pre, setup_fails=True), words)


def test_preflight_from_another_deployment_by_generation():
    """A new deployment starts ComputerDO's generations afresh: a run at generation 1 cannot
    follow a preflight at generation 1."""
    b = Builder(instance="g1-0a1b2c3d-00a1b2")
    for route in ROUTES:
        b.route(route)
    setup_failed(run(b, setup_fails=True), "generations do not precede")


def test_preflight_records_are_validated_too():
    pre = preflight()
    pre[next(iter(pre))]["manifest"] = None
    setup_failed(run(pre=pre, setup_fails=True), "preflight probe")
    unclosed = preflight()
    lines = unclosed[next(iter(unclosed))]["batches"][1]
    lines[:] = [x for x in lines if not (x.get("ev") == "close" and x.get("route") == "p1")]
    lines[0]["events"] = len(lines) - 1
    unclosed[next(iter(unclosed))]["manifest"]["events"] = len(lines) - 1
    # The preflight's P1 connection ended at its tail's end, so it was still answering then.
    run(pre=unclosed)


def test_batch_and_manifest_identities():
    b = clean()
    probe = b.probe(batches=3)
    data = probe[b.instance]
    data["batches"][1][0]["runId"] = "run-20990101T000000Z"
    data["batches"][2][0]["batch"] = 7
    data["batches"][3].append({"batch": 3})
    data["manifest"]["instance"] = "g9-0a1b2c3d-000009"
    data["manifest"]["events"] = 1
    joined = " | ".join(analyze.validate_batches(probe, RUN_ID, "run"))
    assert "batch 1: its header's runId" in joined
    assert "batch 2: its header's batch is 7" in joined
    assert "batch 3: 2 headers" in joined
    assert "its manifest names another instance" in joined
    assert "its manifest counts 1 events" in joined


def test_spans_and_events_within_them():
    b = clean()
    probe = b.probe(batches=3)
    batches = probe[b.instance]["batches"]
    batches[3][-1]["mono"] = batches[3][0]["cutMono"] + 1  # an event after its batch's cut
    batches[1][0]["cutMono"] = batches[1][0]["fromMono"] - 1  # a span that ends before it starts
    # A record timed before its batch's span but written inside it (a close frame's arrival)
    # is fine.
    batches[2][1]["loggedMono"] = batches[2][1]["mono"]
    batches[2][1]["mono"] = batches[2][0]["fromMono"] - 3
    joined = " | ".join(analyze.validate_batches(probe, RUN_ID, "run"))
    assert "batch 1: its span ends before it starts" in joined
    assert "batch 3: 1 events lie outside its span" in joined
    assert "batch 2" not in joined
    probe = b.probe(batches=3)
    probe[b.instance]["batches"][2][0]["fromMono"] += 5  # no longer joins batch 1
    joined = " | ".join(analyze.validate_batches(probe, RUN_ID, "run"))
    assert "batch 2: its span does not join batch 1's" in joined


def test_manifest_without_a_count_and_no_records():
    b = clean()
    probe = b.probe(batches=1)
    probe[b.instance]["manifest"]["batches"] = "one"
    assert any(
        "the manifest's batch count is not a count" in p for p in analyze.record_shape(probe, "run")
    )
    assert analyze.validate_batches({}, RUN_ID, "run") == ["run: no probe records"]


def test_a_connection_needs_a_close_or_to_be_answering_at_the_tails_end():
    line = analyze.timeline(
        {"i": [{"wall": 0.0, "mono": 0.0, "ev": "open", "route": "p1", "conn": 1}]}
    )
    assert analyze.terminal_problems(line, 10_000.0, "run") == [
        "run: P1 connection i/1 has no terminal record and was not answering at the tail's end"
    ]
    answering = [
        {"ev": "open", "route": "p1", "conn": 1, "wall": 0.0, "mono": 0.0},
        {"ev": "send", "route": "p1", "conn": 1, "seq": 1, "wall": 8500.0, "mono": 8500.0},
        {"ev": "reply", "route": "p1", "conn": 1, "seq": 1, "wall": 8520.0, "mono": 8520.0},
    ]
    assert analyze.terminal_problems(analyze.timeline({"i": answering}), 10_000.0, "run") == []
    assert analyze.terminal_problems(analyze.timeline({"i": answering}), 11_000.0, "run") != []


def test_a_recorder_conflict_fails_setup():
    b = clean()
    b.add("batch-conflict", spontaneous_time(1), what="batch 4")
    setup_failed(run(b, setup_fails=True), "a different body for the probe's batch 4")


# ---------------------------------------------------------------------------------------------
# Item 2: clock health (r1 finding 4)


def test_a_15_second_backward_step_fails_setup_not_p2_eligible():
    """Codex: a 15 s backward probe-clock step moved a drop from R+40 s to R+25 s, turning a
    failing spontaneous recovery into a passing forced one and making P2 eligible."""
    r = RESETS["reset-s30"]
    b = build(p2=drops_at(r + 40_000, outage=10_000.0))
    before = run(b)
    assert before.routes["p2"].spontaneous[0].recovery_ms == pytest.approx(10_020.0)
    assert before.outcome.selected == "p6"
    probe = b.probe()
    for lines in probe[b.instance]["batches"].values():
        for x in lines:
            if "ev" in x and x["mono"] >= r:
                x["wall"] -= 15_000  # stamped from the live wall clock, as the old probe did
    report = run(probe=probe, setup_fails=True)
    setup_failed(report, "not on one fixed clock mapping")
    assert report.would_be.selected == "p2"  # what the step alone would have done


def test_a_clock_step_in_the_minute_records_fails_setup():
    """The probe stamps events from its fixed mapping, so a step shows in the clock records."""
    b = clean()
    b.drift = -15_000.0
    setup_failed(run(b, setup_fails=True), "clock step")


@pytest.mark.parametrize(("skew", "fails"), [(2000.0, False), (-2000.5, True)])
def test_skew_against_the_worker_beyond_two_seconds_fails_setup(skew, fails):
    b = clean()
    b.skew = skew
    report = run(b, setup_fails=fails)
    if fails:
        setup_failed(report, "skew against the Worker beyond ±2.0 s")


def test_no_clock_or_skew_records_fail_setup():
    b = clean()
    b.skew = None
    setup_failed(run(b, setup_fails=True), "no skew estimate")
    b = clean()
    b.health = False
    setup_failed(run(b, setup_fails=True), "no clock records")


def test_a_clock_record_without_a_drift_fails_setup():
    b = clean()
    b.add("clock", spontaneous_time(1), liveWall=1.0)
    setup_failed(run(b, setup_fails=True), "clock step")


OK = {"synchronized": True, "skewMs": 0.0}


@pytest.mark.parametrize(
    ("clock", "words"),
    [
        (None, "no laptop clock record at the campaign's start"),
        (
            {"start": {"synchronized": False, "skewMs": 0.0}, "end": OK},
            "not synchronised at the campaign's start",
        ),
        (
            {"start": OK, "end": {"synchronized": True, "skewMs": 2500.0}},
            "at the campaign's end is 2500.0 ms",
        ),
        ({"start": OK, "end": {"synchronized": True}}, "at the campaign's end is None ms"),
    ],
)
def test_laptop_clock(clock, words):
    camp = campaign()
    camp["clock"] = clock
    setup_failed(run(camp=camp, setup_fails=True), words)


# ---------------------------------------------------------------------------------------------
# Item 5: AR-17 needs its evidence (r1 finding 7)


def test_ar17_unassessable_without_a_deploy_window():
    """Codex: with the UI Uploaded timestamp removed, the analyzer reported "no benefit"."""
    report = run(camp=campaign(uploaded={"ui": None}), setup_fails=True)
    assert set(report.ar17) == {"p2", "p6", "p5"}
    for verdict, t, u in report.ar17.values():
        assert verdict == "unassessable: the ui deploy window cannot be placed"
        assert (t, u) == (None, None)
    text = analyze.render(report)
    assert "AR-17 P2: unassessable: the ui deploy window cannot be placed\n" in text


def test_ar17_unassessable_when_the_record_over_a_window_is_missing():
    """Two probe instances, each with every batch and its manifest, that leave the transport
    deploy's window uncovered: valid evidence, but none over that window."""
    w0 = DEPLOYS["transport"]
    first, second = Builder(instance="g2-0a1b2c3d-000002"), Builder(instance="g3-0a1b2c3d-000003")
    for route in ROUTES:
        first.route(route, end=w0 - 10_000)
        second.route(route, start=w0 + UPLOAD_MS + 400_000)
    report = run(probe={**first.probe(), **second.probe()})
    verdict = next(iter(report.ar17.values()))[0]
    assert verdict == (
        "unassessable: the probe's record over the transport deploy window is incomplete"
    )


def test_ar17_unassessable_on_invalid_records():
    b = clean()
    b.add("batch-conflict", spontaneous_time(1), what="batch 4")
    report = run(b, setup_fails=True)
    verdict = next(iter(report.ar17.values()))[0]
    assert verdict == "unassessable: the setup failed"


def test_ar17_unassessable_on_any_setup_failure():
    """Amendment 4, item 7: a clock step or a rollout too, with every window placed and
    covered, and a UI-deploy drop that would otherwise read "no help"."""
    b = build(p2=drops_at(DEPLOYS["ui"] + 60_000))
    assert run(b).ar17["p2"][0].startswith("no help")
    stepped = build(p2=drops_at(DEPLOYS["ui"] + 60_000))
    stepped.drift = -15_000.0
    rolled = run(b, camp=campaign(rollout=("transport",)), setup_fails=True)
    for report in (run(stepped, setup_fails=True), rolled):
        assert set(report.ar17) == {"p2", "p6", "p5"}
        assert {v for v, _, _ in report.ar17.values()} == {"unassessable: the setup failed"}
        assert all((t, u) == (None, None) for _, t, u in report.ar17.values())


def test_preflight_only_lists_record_problems():
    pre = preflight()
    pre[next(iter(pre))]["manifest"] = None
    report = analyze.analyze_preflight(preflight_run(), [], pre)
    assert any("no manifest" in p for p in report.problems)
    assert "record problems: " in analyze.render_preflight(report)
