"""Litestream's control socket: "is every commit so far replicated?".

One question serves every durability check in the image: the response barrier, the
transcript barrier, the final sync on shutdown, the replicated position the watchdog reads,
and (from WP3.6) the Cloudflare launcher's wait before a platform effect.

The answer comes from ``POST /sync`` on Litestream's control socket:

1. A sync **without** ``wait`` converts the WAL to an LTX file and returns ``txid``, the local
   position, which covers every commit made before the request.
2. Later syncs return ``replicated_txid``, the position the replica has confirmed. The commits
   are durable once ``replicated_txid >= txid``.

Never send ``wait: true``: with a request-scoped context it can drop Litestream's checkpoint
guard (Litestream issue #1552), after which a restore can silently miss committed rows
(#1540); spike S4 reproduced both on 0.5.17. Never checkpoint from the application either.
A test in the image scans its code for both.

Concurrent async waiters share sync requests (:class:`ReplicationWaiter`), so a burst of
acknowledgements costs a handful of control-socket calls, not one per request per poll.
Abandoned sync requests stay queued inside Litestream (issue #1541), which is one more reason
to keep their number small.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx

#: Litestream's control socket answers on any host name; this one is only a label.
_BASE = "http://litestream"


class LitestreamError(RuntimeError):
    """The control socket refused, failed or answered something unexpected."""


@dataclass(frozen=True)
class SyncResult:
    """One ``POST /sync`` answer."""

    #: Local position after the sync: covers every commit made before the request.
    txid: int
    #: Position the replica has confirmed.
    replicated_txid: int
    #: ``synced_local`` or ``no_change`` (never ``synced``: that would be a ``wait`` sync).
    status: str


@dataclass(frozen=True)
class WaitOutcome:
    """The result of one durability wait."""

    ok: bool
    target_txid: int | None
    replicated_txid: int | None
    polls: int
    elapsed_s: float
    #: ``None`` when ``ok``; otherwise ``timeout`` or ``error: <type>``.
    reason: str | None = None
    last_error: str | None = None

    def log_fields(self) -> dict[str, Any]:
        """Fields for a structured log line. Never contains credentials."""
        return {
            "ok": self.ok,
            "target_txid": self.target_txid,
            "replicated_txid": self.replicated_txid,
            "polls": self.polls,
            "elapsed_ms": round(self.elapsed_s * 1000, 1),
            "reason": self.reason,
            "last_error": self.last_error,
        }


def sync_request_body(db_path: str) -> dict[str, str]:
    """The only body this image ever sends to ``POST /sync``: no ``wait``, no ``timeout``.

    Without either, Litestream runs the sync under its own server context, which is what keeps
    the checkpoint guard intact (issue #1552).
    """
    return {"path": db_path}


def parse_sync(payload: Any) -> SyncResult:
    """Check and parse a ``POST /sync`` answer."""
    if not isinstance(payload, dict):
        raise LitestreamError(f"unexpected /sync answer: {type(payload).__name__}")
    try:
        txid = int(payload["txid"])
        replicated = int(payload.get("replicated_txid") or 0)
    except (KeyError, TypeError, ValueError) as exc:
        raise LitestreamError(f"unexpected /sync answer: {exc!r}") from None
    if txid < 0 or replicated < 0:
        raise LitestreamError("negative position in /sync answer")
    return SyncResult(txid=txid, replicated_txid=replicated, status=str(payload.get("status")))


def _raise_for(response: httpx.Response) -> None:
    if response.status_code != 200:
        try:
            message = response.json().get("error")
        except ValueError:
            message = response.text[:200]
        raise LitestreamError(f"control socket answered {response.status_code}: {message}")


# ── Blocking client: the entrypoint, the status port and (WP3.6) launcher threads ──────────


class BlockingClient:
    """A blocking control-socket client. One per thread; cheap to create."""

    def __init__(self, socket_path: str, db_path: str, *, timeout_s: float = 5.0) -> None:
        self._db_path = db_path
        self._client = httpx.Client(
            transport=httpx.HTTPTransport(uds=socket_path), base_url=_BASE, timeout=timeout_s
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> BlockingClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def sync(self, *, timeout_s: float | None = None) -> SyncResult:
        """One sync without ``wait``."""
        try:
            response = self._client.post(
                "/sync",
                json=sync_request_body(self._db_path),
                timeout=timeout_s if timeout_s is not None else httpx.USE_CLIENT_DEFAULT,
            )
        except httpx.HTTPError as exc:
            raise LitestreamError(f"{type(exc).__name__}: {exc}") from None
        _raise_for(response)
        return parse_sync(response.json())

    def databases(self, *, timeout_s: float | None = None) -> list[dict[str, Any]]:
        """``GET /list``: the databases Litestream manages, with their status."""
        try:
            response = self._client.get(
                "/list", timeout=timeout_s if timeout_s is not None else httpx.USE_CLIENT_DEFAULT
            )
        except httpx.HTTPError as exc:
            raise LitestreamError(f"{type(exc).__name__}: {exc}") from None
        _raise_for(response)
        payload = response.json()
        dbs = payload.get("databases") if isinstance(payload, dict) else None
        if not isinstance(dbs, list):
            raise LitestreamError("unexpected /list answer")
        return [d for d in dbs if isinstance(d, dict)]

    def wait_replicated(
        self,
        timeout_s: float,
        *,
        poll_s: float = 0.1,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> WaitOutcome:
        """Wait until every commit made before the call is replicated, within one deadline."""
        start = clock()
        deadline = start + timeout_s
        target: int | None = None
        replicated: int | None = None
        polls = 0
        last_error: str | None = None
        while True:
            remaining = deadline - clock()
            if remaining <= 0:
                return WaitOutcome(
                    False, target, replicated, polls, clock() - start, "timeout", last_error
                )
            try:
                result = self.sync(timeout_s=max(0.05, remaining))
            except LitestreamError as exc:
                last_error = str(exc)[:200]
            else:
                polls += 1
                if target is None:
                    target = result.txid
                replicated = max(replicated or 0, result.replicated_txid)
                if replicated >= target:
                    return WaitOutcome(True, target, replicated, polls, clock() - start)
            sleep(min(poll_s, max(0.0, deadline - clock())))


def wait_replicated_blocking(
    socket_path: str, db_path: str, timeout_s: float, *, poll_s: float = 0.1
) -> WaitOutcome:
    """Blocking durability wait for callers outside the event loop, such as launcher threads.

    Omnigent calls the launcher's methods in worker threads, so this never blocks its event
    loop. WP3.6's Cloudflare launcher calls it before every platform effect.
    """
    with BlockingClient(socket_path, db_path, timeout_s=min(5.0, timeout_s)) as client:
        return client.wait_replicated(timeout_s, poll_s=poll_s)


# ── Async waiter: the response barrier and the transcript barrier ───────────────────────────


class ReplicationWaiter:
    """Shared async durability waits for one event loop.

    Each wait needs a sync that *started after* the wait began, so its ``txid`` covers the
    caller's commit. Waiters that arrive while a sync is in flight wait for the next one, and
    every waiter that arrived before a sync started shares its answer. Polls for
    ``replicated_txid`` share syncs the same way.
    """

    def __init__(
        self,
        socket_path: str,
        db_path: str,
        *,
        poll_s: float = 0.05,
        request_timeout_s: float = 5.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._socket_path = socket_path
        self._db_path = db_path
        self._poll_s = poll_s
        self._request_timeout_s = request_timeout_s
        self._clock = clock
        self._client: httpx.AsyncClient | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._rounds_started = 0
        self._inflight: asyncio.Task[SyncResult] | None = None
        self._inflight_number = 0
        #: Number of control-socket syncs sent; for tests and logs.
        self.syncs_sent = 0

    def _bind_loop(self) -> None:
        """Shared state belongs to one event loop; a call from another loop starts afresh."""
        loop = asyncio.get_running_loop()
        if self._loop is not loop:
            self._loop = loop
            self._client = None
            self._inflight = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                transport=httpx.AsyncHTTPTransport(uds=self._socket_path),
                base_url=_BASE,
                timeout=self._request_timeout_s,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _sync_once(self) -> SyncResult:
        self.syncs_sent += 1
        try:
            response = await self._http().post("/sync", json=sync_request_body(self._db_path))
        except httpx.HTTPError as exc:
            raise LitestreamError(f"{type(exc).__name__}: {exc}") from None
        _raise_for(response)
        return parse_sync(response.json())

    async def _sync_started_after(self, ticket: int) -> SyncResult:
        """A sync answer from a request that started after ``ticket`` syncs had started."""
        while True:
            if self._inflight is None or self._inflight.done():
                self._rounds_started += 1
                self._inflight_number = self._rounds_started
                task = asyncio.get_running_loop().create_task(self._sync_once())
                # Retrieve the exception even if every waiter has left.
                task.add_done_callback(lambda t: t.cancelled() or t.exception())
                self._inflight = task
            task, number = self._inflight, self._inflight_number
            if number > ticket:
                return await asyncio.shield(task)
            with contextlib.suppress(Exception):
                await asyncio.shield(task)

    async def wait(self, timeout_s: float) -> WaitOutcome:
        """Wait until every commit made before the call is replicated, within one deadline.

        Never raises (except for cancellation of the caller) and never blocks the loop.
        """
        self._bind_loop()
        start = self._clock()
        ticket = self._rounds_started
        target: int | None = None
        replicated: int | None = None
        polls = 0
        last_error: str | None = None
        try:
            async with asyncio.timeout(timeout_s):
                while True:
                    try:
                        result = await self._sync_started_after(ticket)
                    except Exception as exc:  # noqa: BLE001 - any failure is "not confirmed yet"
                        last_error = f"{type(exc).__name__}: {exc}"[:200]
                    else:
                        polls += 1
                        if target is None:
                            target = result.txid
                        replicated = max(replicated or 0, result.replicated_txid)
                        if replicated >= target:
                            return WaitOutcome(
                                True, target, replicated, polls, self._clock() - start
                            )
                    await asyncio.sleep(self._poll_s)
                    ticket = self._rounds_started
        except TimeoutError:
            reason = "timeout" if target is not None or last_error is None else "error"
            return WaitOutcome(
                False, target, replicated, polls, self._clock() - start, reason, last_error
            )
