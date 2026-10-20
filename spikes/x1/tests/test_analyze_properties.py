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
    covered = sum(
        1 for k in range(start, end) if any(a <= k and k + 1 <= b for a, b in spans)
    )
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
    inside = soak[0] <= t <= soak[1]
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
        slot = analyze.Slot("i", 1, i, float(i * 1000))
        if answered:
            slot.replies, slot.rtt, slot.reply_t = 1, 20.0, i * 1000 + 20.0
        slots.append(slot)
    moment = float(len(pattern) * 1000 + moment_offset - 1000)
    start = analyze.drop_start(slots, moment)
    assert start <= moment
    last = max((i for i, a in enumerate(pattern) if a), default=-1)
    trailing = [s.deadline for s in slots[last + 1 :] if s.deadline <= moment]
    assert start == (min(trailing) if trailing else moment)


@given(count=st.integers(0, 20), hours=st.integers(1, 5))
def test_drop_rate_per_observed_hour(count, hours):
    assert analyze.drop_rate(count, hours * analyze.HOUR_MS) == count / hours
