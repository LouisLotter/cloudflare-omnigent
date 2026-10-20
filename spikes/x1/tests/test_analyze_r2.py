"""The analysis under Codex's final review (x1-probe r2), one test per reproduction: preflight
evidence (finding 2), conflicts at the final flush (finding 3), malformed records (finding 4)
and terminal forms (finding 5)."""

from __future__ import annotations

import json

import analyze
import pytest
from scenario import (
    PRE_ID,
    PRE_INSTANCE,
    ROUTES,
    Builder,
    DropSpec,
    campaign,
    clean,
    lifecycle,
    preflight,
    preflight_run,
    run_json,
    spontaneous_time,
)
from test_analyze import build, drops_at, run
from test_analyze_evidence import setup_failed


def nothing_computed(report: analyze.Report) -> None:
    assert report.would_be is None
    assert report.routes == {} and report.criteria == {} and report.eligible == {}
    assert {v for v, _, _ in report.ar17.values()} == {"unassessable: the setup failed"}


# ---------------------------------------------------------------------------------------------
# Finding 2: the preflight's evidence is checked as the run's is


def preflight_with(**builder: object) -> dict:
    b = Builder(instance=PRE_INSTANCE, run_id=PRE_ID, **builder)
    for route in ROUTES:
        b.route(route, start=preflight_run()["t0"] + 20_000, end=preflight_run()["tailEnd"])
    return b


@pytest.mark.parametrize(
    ("builder", "words"),
    [
        ({"drift": -15_000.0}, "preflight probe g1-0f0f0f0f-0f0f0f: clock step"),
        ({"skew": None}, "preflight: no skew estimate from P3's echoes"),
    ],
)
def test_preflight_clock_failures_fail_the_run(builder, words):
    """Codex: a −15 s preflight clock step, or a preflight with no skew estimates, each gave
    "select P2" with no setup problem and AR-17 "no benefit"."""
    pre = preflight_with(**builder).probe(batches=1)
    report = run(pre=pre, setup_fails=True)
    setup_failed(report, words)
    assert report.would_be is not None and report.would_be.selected == "p2"  # for information
    assert {v for v, _, _ in report.ar17.values()} == {"unassessable: the setup failed"}
    # The preflight-only analysis finds the same problem with the same check.
    assert any(words in p for p in analyze.analyze_preflight(preflight_run(), [], pre).problems)


def test_a_preflight_batch_conflict_fails_the_run():
    """Codex: a preflight batch conflict gave "select P2"."""
    b = preflight_with()
    b.add("batch-conflict", preflight_run()["t0"] + 60_000, what="batch 1")
    report = run(pre=b.probe(batches=1), setup_fails=True)
    setup_failed(report, "preflight: the recorder held a different body for the probe's batch 1")
    assert report.outcome.selected is None


def test_malformed_preflight_records_fail_the_run():
    pre = preflight()
    pre[PRE_INSTANCE]["batches"][1][1]["mono"] = "late"
    report = run(pre=pre, setup_fails=True)
    setup_failed(report, "preflight probe g1-0f0f0f0f-0f0f0f: batch 1 holds a")
    only = analyze.analyze_preflight(preflight_run(), [], pre)
    assert only.routes == {} and only.problems


# ---------------------------------------------------------------------------------------------
# Finding 3: conflicts at the final flush are evidence


def test_a_conflicting_final_batch_named_in_the_manifest_fails_setup():
    """Codex: the stored final batch held another body with matching counts (a different
    terminal record), the conflict stayed local, and the selection changed from P6 to P2. The
    probe now names the batch in its manifest, and the analysis refuses the records."""
    b = build(p2={"drops": (DropSpec(at=spontaneous_time(1), reconnect=False),)})
    probe = b.probe(batches=3)
    data = probe[b.instance]
    for x in data["batches"][3]:
        if x.get("ev") == "close" and x.get("route") == "p2":
            x["by"] = "end"  # same count, different content
    data["manifest"]["conflicts"] = [3]
    report = run(probe=probe, setup_fails=True)
    setup_failed(report, "the recorder held other bodies for batches 3")
    nothing_computed(report)


def test_a_failure_record_in_place_of_the_manifest_fails_setup():
    b = clean()
    probe = b.probe(batches=2, manifest=False)
    probe[b.instance]["failure"] = {"failure": "manifest conflict", "conflicts": []}
    report = run(probe=probe, setup_fails=True)
    setup_failed(report, "the probe recorded manifest conflict")
    assert any(p.endswith(": no manifest") for p in report.setup_problems)
    nothing_computed(report)


def test_failure_records_are_read_from_the_collected_copy(tmp_path):
    root = tmp_path / "run"
    (root / "lifecycle").mkdir(parents=True)
    (root / "run.json").write_text(json.dumps(run_json()))
    instance = root / "probe" / "g2-0a1b2c3d-00a1b2"
    instance.mkdir(parents=True)
    (instance / "failure.json").write_text('{"failure": "manifest conflict"}')
    _, _, probe = analyze.load_dir(root)
    assert probe["g2-0a1b2c3d-00a1b2"]["failure"] == {"failure": "manifest conflict"}


# ---------------------------------------------------------------------------------------------
# Finding 4: malformed records give a setup failure, never an exception


def malformed(change) -> analyze.Report:
    b = clean()
    probe = b.probe(batches=3)
    change(probe[b.instance])
    return run(probe=probe, setup_fails=True)


@pytest.mark.parametrize(
    ("change", "words"),
    [
        (
            lambda d: d["manifest"].update(runId="run-20990101T000000Z"),
            "its manifest names another run",
        ),
        (lambda d: d["manifest"].update(batches=3.5), "the manifest's batch count is not a count"),
        (lambda d: d["batches"][2][3].pop("mono"), "batch 2 holds a"),
        (lambda d: d["batches"][1][0].update(fromMono="0"), "a header without a finite fromMono"),
        (lambda d: d["manifest"].update(batches=-1), "the manifest's batch count is not a count"),
        (
            lambda d: d["manifest"].update(batches="three"),
            "the manifest's batch count is not a count",
        ),
        (
            lambda d: d["batches"][1][0].update(events=2.0),
            "a header whose event count is not a count",
        ),
        (lambda d: d["batches"][1].append("not an object"), "holds lines that are not objects"),
        (lambda d: d["batches"].update({"4": []}), "batch '4' is not a batch number"),
        (lambda d: d["manifest"].update(conflicts="none"), "the manifest's conflicts are not"),
        (lambda d: d.update(failure="oops"), "its failure record is not an object"),
        (lambda d: d["batches"][2][2].update(wall=float("nan")), "without a finite wall"),
        (lambda d: d["batches"][1][0].update(batch=0), "a header without a batch number"),
        (lambda d: d["batches"][1][0].pop("runId"), "a header without its runId"),
        (lambda d: d.update(manifest=["3"]), "the manifest is not an object"),
        (lambda d: d["manifest"].update(events=-4), "the manifest's event count is not a count"),
        (lambda d: d["manifest"].pop("instance"), "the manifest has no instance"),
        (lambda d: d["batches"][2][2].update(loggedMono=None), "without a finite loggedMono"),
    ],
)
def test_malformed_records_give_a_setup_failure_and_nothing_computed(change, words):
    """Codex's reproductions: a manifest naming another run was accepted; 3.5 was truncated;
    a missing mono, a string span and an invalid manifest count raised exceptions."""
    report = malformed(change)
    setup_failed(report, words)
    nothing_computed(report)
    assert "OUTCOME (rule 5): inconclusive (rule 5, setup failure)" in analyze.render(report)


@pytest.mark.parametrize(
    ("event", "words"),
    [
        ({"ev": 7}, "an event without a name"),
        ({"ev": "send", "route": "p2", "conn": 1}, "a send event without its seq"),
        ({"ev": "open", "route": "p9", "conn": 1}, "an open event for an unknown route"),
        ({"ev": "reply", "route": "p2", "conn": -1, "seq": 1}, "whose conn is not a count"),
        (
            {"ev": "pong", "route": "p2", "conn": 1, "rtt": "fast"},
            "a pong event without a finite rtt",
        ),
    ],
)
def test_each_event_needs_its_fields(event, words):
    b = clean()
    b.events.append({"wall": 1_800_000_100_000.0, "mono": 1_800_000_100_000.0, **event})
    report = run(b, setup_fails=True)
    setup_failed(report, words)
    nothing_computed(report)


def test_many_malformed_lines_are_listed_up_to_ten():
    def change(d):
        for x in d["batches"][1][1:13]:
            x["mono"] = None

    problems = malformed(change).setup_problems
    assert sum("batch 1 holds" in p for p in problems) == 10
    assert any(p.endswith("and 2 more") for p in problems)


@pytest.mark.parametrize(
    ("change", "words"),
    [
        (lambda r: r.pop("soakEnd"), "run: run.json has no finite soakEnd"),
        (lambda r: r.update(runId=None), "run: run.json has no runId"),
        (lambda r: r.update(tailEnd="later"), "run: run.json has no finite tailEnd"),
        (
            lambda r: r.update(soakEnd=r["soakStart"]),
            "run: run.json's soak and tail are out of order",
        ),
    ],
)
def test_a_malformed_run_json_gives_a_setup_failure(change, words):
    meta = run_json()
    change(meta)
    report = run(run=meta, setup_fails=True)
    setup_failed(report, words)
    nothing_computed(report)
    analyze.render(report)


def test_unreadable_inputs_give_a_setup_failure():
    report = analyze.analyze(
        analyze.Inputs(
            run="not json",  # type: ignore[arg-type]
            lifecycle="nothing",  # type: ignore[arg-type]
            probe=[],  # type: ignore[arg-type]
            campaign={"deploys": "none"},
            preflight_probe=None,
        )
    )
    joined = " | ".join(report.setup_problems)
    assert "run: run.json is not an object" in joined
    assert "run: the probe records are not readable" in joined
    assert "the lifecycle records are not readable" in joined
    assert "the campaign record's deploys are not readable" in joined
    assert "no preflight records" in joined
    nothing_computed(report)
    unreadable = run(probe={"g2-0a1b2c3d-00a1b2": {"batches": []}}, setup_fails=True)
    setup_failed(unreadable, "its records are not readable")


def test_malformed_lifecycle_and_campaign_records_are_setup_failures():
    life = lifecycle()
    life[0]["R"] = "soon"
    camp = campaign()
    camp["deploys"][0]["start"] = "now"
    report = run(life=life, camp=camp, setup_fails=True)
    setup_failed(report, "the reset record for reset-s30 has no finite R")
    setup_failed(report, "the ui deploy's record is malformed")
    assert [w.event for w in report.windows if w.kind == "reset"] == [
        "reset reset-s60",
        "reset reset-s90",
    ]
    assert analyze.lifecycle_problems([1]) == ["the lifecycle records are not readable"]


def test_a_laptop_clock_record_that_is_not_an_object():
    camp = campaign()
    camp["clock"] = "synced"
    setup_failed(run(camp=camp, setup_fails=True), "no laptop clock record at the campaign's start")


# ---------------------------------------------------------------------------------------------
# Finding 5: close, error and silence records all end a connection


@pytest.mark.parametrize(
    ("terminal", "by", "code"),
    [("error", "error", 1006), ("silence", "silence", 4000), ("silence+close", "silence", 4000)],
)
def test_error_and_silence_records_end_a_connection_once(terminal, by, code):
    """Codex: a connection ending with only an error or a silence record was rejected as having
    no close. Each is a valid end, counted once, also when its close follows."""
    at = spontaneous_time(2)
    b = build(p2={"drops": (DropSpec(at=at, by="silence", code=4000, terminal=terminal),)})
    r = run(b).routes["p2"]
    assert len(r.spontaneous) == 1
    drop = r.spontaneous[0]
    assert (drop.by, drop.code, drop.moment) == (by, code, at)
    assert drop.recovery_ms == pytest.approx(520.0)


def test_an_error_record_without_a_connection_ends_nothing():
    b = clean()
    b.add("error", spontaneous_time(1), route="p2", error="RuntimeError")
    assert run(b).routes["p2"].spontaneous == []


def test_the_preflight_only_report_lists_malformed_lifecycle_records():
    life = [{"x1": "reset-requested", "event": "reset-t5"}]
    report = analyze.analyze_preflight(preflight_run(), life, preflight())
    assert "the reset record for reset-t5 has no finite R" in report.problems
    assert report.routes  # the preflight's own records are fine
    assert drops_at  # shared helpers stay importable
