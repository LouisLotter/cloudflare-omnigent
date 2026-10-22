"""Replication lag from the server's replicated positions, and the lag warning (FH-15).

The design: "when replication lag exceeds a threshold, for example 60 seconds, the platform
page shows a warning". The server image reports positions, not ages: each ``GET /position``
on the control port answers ``txid`` (covering every commit made before the call) and
``replicatedTxid`` (what the replica holds). A watchdog that samples it gets ages this way:

- a sample taken at time ``t`` with ``txid > replicatedTxid`` proves that some commit made
  before ``t`` is not yet replicated, so the oldest unreplicated commit is **at least**
  ``now - t`` old, where ``t`` is the earliest such sample still not covered;
- a later ``replicatedTxid`` that reaches a sample's ``txid`` covers that sample;
- positions are compared only within one boot (a restore starts a new boot);
- a position the server cannot give (503: Litestream down, recovery, a failing control call)
  is "unknown", and an unknown that lasts as long as the threshold warns too.

The lag is a lower bound: the warning can come up to one sampling interval late, never early,
so an idle or healthy server never shows a false warning. :class:`LagTracker` is pure; the
durability suite drives it with real positions from a blackholed replica.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

DEFAULT_THRESHOLD_S = 60.0


@dataclass(frozen=True)
class Sample:
    """One reading of the control port's ``/position``; ``txid`` is ``None`` when it was 503."""

    at: float
    boot_id: str | None = None
    txid: int | None = None
    replicated_txid: int | None = None

    @property
    def available(self) -> bool:
        return self.txid is not None and self.replicated_txid is not None


@dataclass(frozen=True)
class LagState:
    #: Age of the oldest commit known to be unreplicated, in seconds (a lower bound).
    lag_s: float
    #: How long the position has been unknown, in seconds (0 when it is known).
    unknown_s: float
    #: The last known position is fully replicated.
    caught_up: bool
    #: ``lag_s`` or ``unknown_s`` has reached the threshold.
    warning: bool
    reason: str | None


@dataclass
class LagTracker:
    """Folds samples, in time order, into the lag and the warning."""

    threshold_s: float = DEFAULT_THRESHOLD_S
    _boot: str | None = None
    #: (time, txid) of samples not yet covered, oldest first, txids strictly increasing.
    _pending: deque[tuple[float, int]] = field(default_factory=deque)
    _unknown_since: float | None = None
    _last_at: float | None = None
    _caught_up: bool = True

    def __post_init__(self) -> None:
        if not self.threshold_s > 0:
            raise ValueError("threshold_s must be positive")

    def observe(self, sample: Sample) -> LagState:
        if self._last_at is not None and sample.at < self._last_at:
            raise ValueError("samples must be in time order")
        self._last_at = sample.at
        if not sample.available:
            if self._unknown_since is None:
                self._unknown_since = sample.at
            return self.state(sample.at)
        self._unknown_since = None
        if sample.boot_id != self._boot:
            # A new boot (a restore or a restart): earlier positions mean nothing now.
            self._boot = sample.boot_id
            self._pending.clear()
        assert sample.txid is not None and sample.replicated_txid is not None
        replicated = sample.replicated_txid
        while self._pending and self._pending[0][1] <= replicated:
            self._pending.popleft()
        if sample.txid > replicated and (not self._pending or sample.txid > self._pending[-1][1]):
            self._pending.append((sample.at, sample.txid))
        self._caught_up = replicated >= sample.txid
        return self.state(sample.at)

    def state(self, now: float) -> LagState:
        lag = max(0.0, now - self._pending[0][0]) if self._pending else 0.0
        unknown = max(0.0, now - self._unknown_since) if self._unknown_since is not None else 0.0
        reason = None
        if lag >= self.threshold_s:
            reason = "lagging"
        elif unknown >= self.threshold_s:
            reason = "unknown"
        return LagState(
            lag_s=lag,
            unknown_s=unknown,
            caught_up=self._caught_up and self._unknown_since is None,
            warning=reason is not None,
            reason=reason,
        )
