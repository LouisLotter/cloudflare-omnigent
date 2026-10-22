"""The control-socket client: one deadline, shared syncs, never a ``wait`` sync."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest

from cfo_server.litestream import (
    BlockingClient,
    LitestreamError,
    ReplicationWaiter,
    parse_sync,
    sync_request_body,
    wait_replicated_blocking,
)

from fake_litestream import FakeLitestream

DB = "/data/omnigent.db"


def test_sync_body_never_asks_litestream_to_wait() -> None:
    assert sync_request_body(DB) == {"path": DB}


@pytest.mark.parametrize(
    "payload",
    [None, [], {}, {"txid": "x"}, {"txid": -1}, {"txid": 3, "replicated_txid": -2}],
)
def test_parse_sync_rejects_malformed_answers(payload: object) -> None:
    with pytest.raises(LitestreamError):
        parse_sync(payload)


def test_parse_sync_reads_positions() -> None:
    result = parse_sync({"txid": 7, "replicated_txid": None, "status": "no_change"})
    assert (result.txid, result.replicated_txid, result.status) == (7, 0, "no_change")


def test_blocking_wait_confirms_once_the_replica_covers_the_first_sync(
    fake_litestream: FakeLitestream,
) -> None:
    fake_litestream.lag_syncs = 2
    outcome = wait_replicated_blocking(str(fake_litestream.socket_path), DB, 5, poll_s=0.01)
    assert outcome.ok
    assert outcome.replicated_txid is not None and outcome.target_txid is not None
    assert outcome.replicated_txid >= outcome.target_txid
    assert outcome.polls >= 3


def test_blocking_wait_times_out_while_blocked(fake_litestream: FakeLitestream) -> None:
    fake_litestream.mode = "blocked"
    started = time.monotonic()
    outcome = wait_replicated_blocking(str(fake_litestream.socket_path), DB, 0.5, poll_s=0.05)
    assert not outcome.ok and outcome.reason == "timeout"
    assert time.monotonic() - started < 2


def test_blocking_wait_keeps_one_deadline_when_litestream_hangs(
    fake_litestream: FakeLitestream,
) -> None:
    fake_litestream.mode = "hang"
    fake_litestream.hang_s = 10
    started = time.monotonic()
    outcome = wait_replicated_blocking(str(fake_litestream.socket_path), DB, 0.6)
    assert not outcome.ok
    assert time.monotonic() - started < 2.5


def test_blocking_wait_reports_errors_until_the_deadline(fake_litestream: FakeLitestream) -> None:
    fake_litestream.mode = "error"
    outcome = wait_replicated_blocking(str(fake_litestream.socket_path), DB, 0.4, poll_s=0.05)
    assert not outcome.ok
    assert outcome.last_error and "500" in outcome.last_error


def test_blocking_wait_without_a_socket_fails_within_the_deadline(tmp_path: Path) -> None:
    outcome = wait_replicated_blocking(str(tmp_path / "missing.sock"), DB, 0.3, poll_s=0.05)
    assert not outcome.ok and outcome.target_txid is None


def test_databases_lists_the_replicated_database(fake_litestream: FakeLitestream) -> None:
    with BlockingClient(str(fake_litestream.socket_path), DB) as client:
        assert [d["path"] for d in client.databases()] == [DB]


def run(coro):  # noqa: ANN001, ANN201
    return asyncio.run(coro)


def test_async_wait_confirms_and_shares_syncs_between_waiters(
    fake_litestream: FakeLitestream,
) -> None:
    fake_litestream.lag_syncs = 1
    waiter = ReplicationWaiter(str(fake_litestream.socket_path), DB, poll_s=0.01)

    async def burst() -> list:
        try:
            return await asyncio.gather(*(waiter.wait(5) for _ in range(40)))
        finally:
            await waiter.aclose()

    outcomes = run(burst())
    assert all(o.ok for o in outcomes)
    # 40 waiters, each needing a fresh sync and at least one poll: shared, not 80+ syncs.
    assert waiter.syncs_sent < 20, waiter.syncs_sent


def test_async_wait_target_comes_from_a_sync_started_after_the_call(
    fake_litestream: FakeLitestream,
) -> None:
    """A sync already in flight when a wait starts may predate the caller's commit."""
    fake_litestream.mode = "hang"
    fake_litestream.hang_s = 0.3
    waiter = ReplicationWaiter(str(fake_litestream.socket_path), DB, poll_s=0.01)

    async def scenario() -> tuple:
        first = asyncio.ensure_future(waiter.wait(5))
        await asyncio.sleep(0.05)  # the first sync is now in flight
        fake_litestream.mode = "healthy"
        second = await waiter.wait(5)
        return await first, second

    try:
        first, second = run(scenario())
    finally:
        run(waiter.aclose())
    assert first.ok and second.ok
    assert second.target_txid > first.target_txid


def test_async_wait_times_out_without_blocking_the_loop(fake_litestream: FakeLitestream) -> None:
    fake_litestream.mode = "blocked"
    waiter = ReplicationWaiter(str(fake_litestream.socket_path), DB, poll_s=0.02)

    async def scenario() -> tuple:
        ticks = 0

        async def ticker() -> None:
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        task = asyncio.ensure_future(ticker())
        started = time.monotonic()
        outcome = await waiter.wait(0.5)
        elapsed = time.monotonic() - started
        task.cancel()
        await waiter.aclose()
        return outcome, elapsed, ticks

    outcome, elapsed, ticks = run(scenario())
    assert not outcome.ok and outcome.reason == "timeout"
    assert 0.45 < elapsed < 1.5
    assert ticks > 20  # the loop kept running throughout


def test_async_wait_one_deadline_covers_a_hanging_socket(fake_litestream: FakeLitestream) -> None:
    fake_litestream.mode = "hang"
    fake_litestream.hang_s = 10
    waiter = ReplicationWaiter(str(fake_litestream.socket_path), DB)

    async def scenario() -> tuple:
        started = time.monotonic()
        outcome = await waiter.wait(0.5)
        return outcome, time.monotonic() - started

    outcome, elapsed = run(scenario())
    assert not outcome.ok and elapsed < 1.5


def test_async_wait_reports_error_when_no_answer_ever_came(tmp_path: Path) -> None:
    waiter = ReplicationWaiter(str(tmp_path / "missing.sock"), DB, poll_s=0.02)
    outcome = run(waiter.wait(0.3))
    assert not outcome.ok and outcome.reason == "error" and outcome.last_error
