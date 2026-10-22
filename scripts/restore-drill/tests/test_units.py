"""Pure parts of the drill: percentiles, the lag tracker, snapshots and record checks."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from cfo_drill import db, drill, lag, stats

# ── Percentiles ─────────────────────────────────────────────────────────────────────────


def test_nearest_rank_percentiles() -> None:
    values = list(range(1, 101))
    assert stats.percentile(values, 50) == 50
    assert stats.percentile(values, 95) == 95
    assert stats.percentile(values, 99) == 99
    assert stats.percentile(values, 100) == 100
    assert stats.percentile([7.0], 99) == 7.0
    assert stats.percentile([], 50) is None
    assert stats.percentile([3, 1, 2], 1) == 1
    with pytest.raises(ValueError):
        stats.percentile(values, 0)
    with pytest.raises(ValueError):
        stats.percentile(values, 101)


@given(st.lists(st.floats(min_value=0, max_value=1e6, allow_nan=False), min_size=1, max_size=300))
def test_percentiles_are_observed_values_in_order(values: list[float]) -> None:
    p50, p95, p99 = (stats.percentile(values, p) for p in (50, 95, 99))
    assert p50 in values and p95 in values and p99 in values
    assert min(values) <= p50 <= p95 <= p99 <= max(values)


def test_summary() -> None:
    assert stats.summary([]) == {
        "n": 0,
        "min": None,
        "p50": None,
        "p95": None,
        "p99": None,
        "max": None,
        "mean": None,
    }
    s = stats.summary([1.0, 2.0, 3.0, 4.0])
    assert s["n"] == 4 and s["p50"] == 2.0 and s["max"] == 4.0 and s["mean"] == 2.5


# ── The lag tracker ─────────────────────────────────────────────────────────────────────


def _s(at: float, txid: int | None, rep: int | None, boot: str = "b1") -> lag.Sample:
    return lag.Sample(at=at, boot_id=boot, txid=txid, replicated_txid=rep)


def test_healthy_and_idle_never_warn() -> None:
    tracker = lag.LagTracker(threshold_s=60)
    for t in range(0, 600, 5):
        state = tracker.observe(_s(t, 10 + t // 10, 10 + t // 10))
        assert state.lag_s == 0 and not state.warning and state.caught_up


def test_lag_counts_from_the_first_uncovered_sample() -> None:
    tracker = lag.LagTracker(threshold_s=60)
    tracker.observe(_s(0, 5, 5))
    assert tracker.observe(_s(10, 6, 5)).lag_s == 0  # first uncovered sample now
    assert tracker.observe(_s(20, 7, 5)).lag_s == 10
    state = tracker.observe(_s(70, 9, 5))
    assert state.lag_s == 60 and state.warning and state.reason == "lagging"
    # The replica reaches 6: the sample at 10 is covered, the one at 20 is not.
    state = tracker.observe(_s(75, 9, 6))
    assert state.lag_s == 55 and not state.warning and not state.caught_up
    state = tracker.observe(_s(80, 9, 9))
    assert state.lag_s == 0 and state.caught_up and not state.warning


def test_a_new_boot_starts_afresh() -> None:
    tracker = lag.LagTracker(threshold_s=30)
    tracker.observe(_s(0, 50, 10))
    assert tracker.observe(_s(40, 60, 10)).warning
    state = tracker.observe(_s(41, 3, 3, boot="b2"))
    assert state.lag_s == 0 and not state.warning


def test_an_unknown_position_warns_after_the_threshold() -> None:
    tracker = lag.LagTracker(threshold_s=60)
    tracker.observe(_s(0, 5, 5))
    assert tracker.observe(_s(10, None, None)).unknown_s == 0
    state = tracker.observe(_s(69, None, None))
    assert state.unknown_s == 59 and not state.warning and not state.caught_up
    state = tracker.observe(_s(70, None, None))
    assert state.warning and state.reason == "unknown"
    assert not tracker.observe(_s(71, 5, 5)).warning


def test_samples_must_be_in_time_order_and_threshold_positive() -> None:
    tracker = lag.LagTracker()
    tracker.observe(_s(10, 1, 1))
    with pytest.raises(ValueError):
        tracker.observe(_s(9, 1, 1))
    with pytest.raises(ValueError):
        lag.LagTracker(threshold_s=0)


positions = st.lists(
    st.tuples(
        st.floats(min_value=0, max_value=30, allow_nan=False),  # time step
        st.integers(min_value=0, max_value=3),  # new commits
        st.integers(min_value=0, max_value=4),  # replica progress
        st.booleans(),  # available
    ),
    min_size=1,
    max_size=80,
)


@settings(max_examples=300)
@given(positions)
def test_lag_is_a_lower_bound_on_the_oldest_unreplicated_commit(steps: list) -> None:
    """Model: commits happen at sample times; the tracker never overstates their age, never
    warns while caught up, and warns whenever a known-unreplicated sample is old enough."""
    tracker = lag.LagTracker(threshold_s=45)
    now = 0.0
    txid = replicated = 0
    first_unreplicated_seen: dict[int, float] = {}
    for step, commits, progress, available in steps:
        now += step
        txid += commits
        replicated = min(txid, replicated + progress)
        if not available:
            state = tracker.observe(lag.Sample(now))
            assert state.lag_s >= 0 and not state.caught_up
            continue
        for t in range(replicated + 1, txid + 1):
            first_unreplicated_seen.setdefault(t, now)
        state = tracker.observe(lag.Sample(now, "b", txid, replicated))
        oldest = min(
            (seen for t, seen in first_unreplicated_seen.items() if t > replicated), default=None
        )
        if oldest is None:
            assert state.lag_s == 0 and state.caught_up and not state.warning
        else:
            assert 0 <= state.lag_s <= now - oldest + 1e-9
            assert not state.caught_up
        assert state.warning == (state.lag_s >= 45 or state.unknown_s >= 45)


# ── Snapshots and record checks ─────────────────────────────────────────────────────────


def _make_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None)
    conn.executescript(
        """
        CREATE TABLE alembic_version (version_num TEXT);
        INSERT INTO alembic_version VALUES ('v1');
        CREATE TABLE users (workspace_id INT, id TEXT, password_hash TEXT, is_admin INT,
                            deleted_at INT, PRIMARY KEY (workspace_id, id));
        INSERT INTO users VALUES (0, 'owner', 'h1', 1, NULL);
        CREATE TABLE device_grants (workspace_id INT, id TEXT, refresh_token_hash TEXT,
                                    PRIMARY KEY (workspace_id, id));
        CREATE TABLE account_tokens (workspace_id INT, id TEXT, PRIMARY KEY (workspace_id, id));
        CREATE TABLE hosts (workspace_id INT, host_id BLOB, PRIMARY KEY (workspace_id, host_id));
        CREATE TABLE scheduled_tasks (workspace_id INT, id BLOB, name TEXT, rrule TEXT,
                                      PRIMARY KEY (workspace_id, id));
        CREATE TABLE conversation_items (workspace_id INT, conversation_id BLOB, id BLOB,
                                         created_at INT, data TEXT);
        CREATE TABLE _litestream_seq (id INT);
        """
    )
    return conn


CONV = bytes.fromhex("aa" * 16)
ITEM = bytes.fromhex("bb" * 16)
TASK = bytes.fromhex("cc" * 16)


def test_snapshot_compare_and_canaries(tmp_path: Path) -> None:
    conn = _make_db(tmp_path / "live.db")
    conn.execute("INSERT INTO scheduled_tasks VALUES (0, ?, 'a', 'r')", (TASK,))
    conn.execute("INSERT INTO device_grants VALUES (0, 'g1', 'x')")
    conn.execute("INSERT INTO conversation_items VALUES (0, ?, ?, 1, 'd')", (CONV, ITEM))
    live = db.snapshot(conn, conversations=[CONV.hex()])
    assert "_litestream_seq" not in live.tables and live.schema_version == ["v1"]
    assert live.counts["scheduled_tasks"] == 1 and len(live.items) == 1

    same = db.snapshot(conn, conversations=[CONV.hex()])
    assert all(c.ok for c in db.compare(live, same))
    assert db.Snapshot.from_json(live.to_json()).to_json() == live.to_json()

    canaries = [
        db.Canary("schedule", "scheduled_tasks", (0, TASK), True),
        db.Canary("grant", "device_grants", (0, "g1"), True),
        db.Canary("item", db.ITEMS_TABLE, (0, CONV, ITEM), True),
        db.Canary("deleted", "scheduled_tasks", (0, b"\x01"), True, expect="absent"),
        db.Canary("unacked", "scheduled_tasks", (0, b"\x02"), False),
    ]
    check = db.check_canaries(canaries, live, same)
    assert check.ok and check.detail["present"] == 4
    assert check.detail["unacknowledged"] == {"unacked": "absent"}
    assert db.Canary.from_json(canaries[2].to_json()) == canaries[2]
    assert db.snapshot_file(tmp_path / "live.db", conversations=[CONV.hex()]).to_json() == (
        live.to_json()
    )

    # A row changed, a row lost, an item lost: each check names what it found.
    conn.execute("UPDATE scheduled_tasks SET name = 'b'")
    conn.execute("DELETE FROM device_grants")
    conn.execute("DELETE FROM conversation_items")
    conn.execute("INSERT INTO scheduled_tasks VALUES (0, ?, 'x', 'r')", (b"\x01",))
    broken = db.snapshot(conn, conversations=[CONV.hex()])
    checks = {c.name: c for c in db.compare(live, broken)}
    assert checks["schema_version"].ok and checks["tables"].ok
    assert not checks["row_counts"].ok
    assert checks["security_tables"].detail["scheduled_tasks"] == {
        "rows": 1,
        "missing": 0,
        "changed": 1,
        "extra": 1,
    }
    assert checks["security_tables"].detail["device_grants"]["missing"] == 1
    assert checks["transcript_items"].detail["missing"] == 1
    canary_check = db.check_canaries(canaries, live, broken)
    assert not canary_check.ok
    assert set(canary_check.detail["missing"]) == {"grant", "item", "deleted"}
    assert canary_check.detail["differ"] == ["schedule"]
    # Without a live snapshot only presence counts.
    assert set(db.check_canaries(canaries, None, broken).detail["missing"]) == {
        "grant",
        "item",
        "deleted",
    }
    conn.close()


def test_schema_and_table_differences(tmp_path: Path) -> None:
    first = _make_db(tmp_path / "a.db")
    a = db.snapshot(first)
    first.close()
    other = _make_db(tmp_path / "b.db")
    other.execute("UPDATE alembic_version SET version_num = 'v2'")
    other.execute("CREATE TABLE extra (x INT)")
    checks = {c.name: c for c in db.compare(a, db.snapshot(other))}
    assert not checks["schema_version"].ok
    assert checks["tables"].detail == {"missing": [], "extra": ["extra"]}
    other.close()


def test_digests_distinguish_types_and_values() -> None:
    assert db.digest([1]) != db.digest(["1"]) != db.digest([b"1"])
    assert db.digest([1.0]) != db.digest([1])
    assert db.digest([None]) == db.digest([None])
    assert len(db.key_digest("t", [0, "k"])) == db.DIGEST_CHARS


def test_integrity_of_a_good_database(tmp_path: Path) -> None:
    conn = _make_db(tmp_path / "x.db")
    assert db.integrity(conn) == "ok"
    conn.close()


def test_txid_hex() -> None:
    assert drill.txid_hex(26) == "000000000000001a"
    with pytest.raises(ValueError):
        drill.txid_hex(-1)
