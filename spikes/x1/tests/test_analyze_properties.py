"""Property tests for the analyzer's window attribution, observed time and drop start."""

from __future__ import annotations

import analyze
from hypothesis import given, settings
from hypothesis import strategies as st

times = st.integers(min_value=0, max_value=10_000_000)


@given(r=times, t=times)
def test_reset_window_contains_exactly_r_minus_2s_to_r_plus_30s(r, t):
    hit = analyze.windows_containing(t, [analyze.reset_window("reset", r)]) == ["reset"]
    assert hit == (r - 2000 <= t <= r + 30_000)


@given(start=times, upload=st.integers(min_value=0, max_value=600_000), t=times)
def test_deploy_window_runs_from_start_to_uploaded_plus_330s(start, upload, t):
    w = analyze.deploy_window("deploy", start, start + upload)
    assert (analyze.windows_containing(t, [w]) == ["deploy"]) == (
        start <= t <= start + upload + 330_000
    )


window = st.tuples(st.integers(-50, 250), st.integers(0, 120)).map(lambda p: (p[0], p[0] + p[1]))


@settings(max_examples=300)
@given(
    soak=st.tuples(st.integers(0, 100), st.integers(0, 150)).map(lambda p: (p[0], p[0] + p[1])),
    spans=st.lists(window, max_size=8),
)
def test_observed_time_is_the_soak_minus_the_union_of_windows(soak, spans):
    """On integer end points, the union's length is the number of unit cells it covers."""
    start, end = soak
    windows = [analyze.Window(f"w{i}", "reset", a, b) for i, (a, b) in enumerate(spans)]
    covered = sum(1 for k in range(start, end) if any(a <= k and k + 1 <= b for a, b in spans))
    observed = analyze.observed_ms(start, end, windows)
    assert observed == (end - start) - covered
    assert 0 <= observed <= end - start
    # More windows never add observed time.
    assert analyze.observed_ms(start, end, windows[:-1]) >= observed


@settings(max_examples=300)
@given(
    soak=st.tuples(times, st.integers(1, 1_000_000)).map(lambda p: (p[0], p[0] + p[1])),
    resets=st.lists(times, max_size=4),
    t=times,
)
def test_classification_follows_the_drop_start(soak, resets, t):
    windows = [analyze.reset_window(f"r{i}", r) for i, r in enumerate(resets)]
    drop = analyze.Drop("p2", "i", 1, t, t, "peer", 1006, None, None)
    analyze.classify([drop], soak[0], soak[1], windows)
    inside = soak[0] <= t < soak[1]  # the soak is [S, E)
    named = [w.event for w in windows if w.start <= t <= w.end]
    assert drop.windows == named
    if not inside:
        assert drop.kind == "outside"
    else:
        assert drop.kind == ("forced" if named else "spontaneous")


@given(
    pattern=st.lists(st.booleans(), min_size=0, max_size=12),
    moment_offset=st.integers(0, 15_000),
)
def test_drop_start_is_the_first_passed_deadline_of_the_trailing_misses(pattern, moment_offset):
    slots = []
    for i, answered in enumerate(pattern):
        echo = analyze.Echo("i", 1, i, float(i * 1000))
        if answered:
            echo.replies, echo.rtt, echo.reply_t = 1, 20.0, i * 1000 + 20.0
        slots.append(echo)
    moment = float(len(pattern) * 1000 + moment_offset - 1000)
    start = analyze.drop_start(slots, moment)
    assert start <= moment
    last = max((i for i, a in enumerate(pattern) if a), default=-1)
    trailing = [s.deadline for s in slots[last + 1 :] if s.deadline <= moment]
    assert start == (min(trailing) if trailing else moment)


@given(count=st.integers(0, 20), hours=st.integers(1, 5))
def test_drop_rate_per_observed_hour(count, hours):
    assert analyze.drop_rate(count, hours * analyze.HOUR_MS) == count / hours


spans_strategy = st.lists(
    st.tuples(st.integers(0, 60), st.integers(0, 20)).map(lambda p: (p[0], p[0] + p[1])),
    max_size=6,
)


@settings(max_examples=300)
@given(spans=spans_strategy, a=st.integers(0, 80), length=st.integers(0, 20))
def test_covered_matches_a_point_by_point_check(spans, a, length):
    """[a, b] is covered when every half-unit point of it lies in some span (integer ends)."""
    merged = analyze.merge([(float(s), float(e)) for s, e in spans])
    b = a + length
    points = [a + k / 2 for k in range(2 * length + 1)]
    expected = all(any(s <= p <= e for s, e in spans) for p in points)
    assert analyze.covered(merged, a, b) == expected
    assert all(merged[i][1] < merged[i + 1][0] for i in range(len(merged) - 1))


@settings(max_examples=200)
@given(
    sends=st.lists(
        st.tuples(st.integers(-1500, 6500), st.one_of(st.none(), st.integers(0, 2000))),
        max_size=12,
    )
)
def test_slot_outcomes_follow_the_precedence(sends):
    """missed if an echo sent in the slot was not answered within 1.0 s, answered if every one
    was, down if none was sent (no connection is open here); slots are [k s, (k+1) s) over a
    5 s soak (Amendment 2, items 1 and 2)."""
    events = []
    for seq, (sent, rtt) in enumerate(sends, start=1):
        events.append({"ev": "send", "route": "p1", "conn": 1, "seq": seq, "t": float(sent)})
        if rtt is not None:
            reply = {"ev": "reply", "route": "p1", "conn": 1, "seq": seq, "t": float(sent + rtt)}
            events.append(reply)
    line = analyze.timeline({"i": [{"wall": e["t"], "mono": e["t"], **e} for e in events]})
    rec = analyze.route_records(line, "p1")
    outcomes = analyze.slot_outcomes(rec, 0.0, 5000.0, [(-10_000.0, 20_000.0)])
    for k, outcome in enumerate(outcomes):
        mine = [(s, r) for s, r in sends if k * 1000 <= s < (k + 1) * 1000]
        if not mine:
            assert outcome == "down"
        elif all(r is not None and r <= 1000 for _, r in mine):
            assert outcome == "answered"
        else:
            assert outcome == "missed"
