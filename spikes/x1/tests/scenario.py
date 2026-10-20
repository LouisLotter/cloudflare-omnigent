"""Synthetic X1 records for the analyzer's tests: a probe log per route, RunDO's lifecycle
records, the campaign's deploy record and a preflight, on the real schedule's times.

Probe events use wall == monotonic, so each instance's offset is 0 and t == the given time.
Batches carry headers naming the span they account for, as the probe writes them.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field

import analyze

MIN = 60_000
T0 = 1_800_000_000_000
S = T0 + 5 * MIN
E = S + 120 * MIN
TAIL = 60_000
TAIL_END = E + TAIL
RESETS = {"reset-s30": S + 30 * MIN, "reset-s60": S + 60 * MIN, "reset-s90": S + 90 * MIN}
UPLOAD_MS = 20_000
DEPLOYS = {"ui": S + 45 * MIN, "transport": S + 75 * MIN}
ROUTES = ("p1", "p2", "p3", "p4", "p5", "p6")
INSTANCE = "g2-0a1b2c3d-00a1b2"
RUN_ID = "run-20270115T080000Z"
PRE_ID = "preflight-20270115T072000Z"
PRE_INSTANCE = "g1-0f0f0f0f-0f0f0f"
WORKER = "cfo-stg-x1-transport"
PRE_T0 = T0 - 40 * MIN
FIRST_OPEN = T0 + 20_000
# Observed time on the default schedule: 7200 s minus 3 x 32 s of resets and 2 x 350 s of deploys.
OBSERVED_MS = 120 * MIN - 3 * 32_000 - 2 * (UPLOAD_MS + 330_000)
SLOTS = 7200


@dataclass
class DropSpec:
    """A connection ending at `at`. The next connection that works opens `outage` ms later;
    `failed` names offsets from `at` at which a connection opens, sends one echo that is not
    answered, and is closed 300 ms later: failed opens within the recovery."""

    at: float
    by: str = "peer"
    code: int | None = 1006
    misses_before: int = 0
    outage: float = 500.0
    misses_after: int = 0
    reconnect: bool = True
    failed: tuple[float, ...] = ()
    # The connection's terminal records: "close", "error", "silence", or "silence+close" (as the
    # probe writes a silence close).
    terminal: str = "close"


@dataclass
class Builder:
    instance: str = INSTANCE
    run_id: str = RUN_ID
    # Per-minute clock and skew records, as the probe writes them (Amendment 3, item 2).
    health: bool = True
    drift: float = 0.0
    skew: float | None = 120.0
    # This instance's monotonic clock reads `mono_shift` ms behind its wall clock.
    mono_shift: float = 0.0
    events: list[dict] = field(default_factory=list)
    conns: dict[str, int] = field(default_factory=dict)
    seqs: dict[str, int] = field(default_factory=dict)

    def add(self, ev: str, t: float, **fields: object) -> None:
        self.events.append({"ev": ev, "wall": t, "mono": t - self.mono_shift, **fields})

    def mark(self, t: float) -> None:
        """An event with no route, so the records cover up to (or from) t."""
        self.add("mark", t)

    def next_conn(self, route: str) -> int:
        self.conns[route] = self.conns.get(route, 0) + 1
        return self.conns[route]

    def next_seq(self, route: str) -> int:
        self.seqs[route] = self.seqs.get(route, 0) + 1
        return self.seqs[route]

    def failed_open(self, route: str, at: float, closes_after: float = 300.0) -> None:
        conn = self.next_conn(route)
        self.add("attempt", at, route=route, n=conn, ok=True, ms=5.0, conn=conn)
        self.add("open", at, route=route, conn=conn, attempt=conn)
        seq = self.next_seq(route)
        self.add("send", at, route=route, conn=conn, seq=seq)
        self.add("miss", at + closes_after, route=route, conn=conn, seq=seq, afterClose=True)
        self.add("close", at + closes_after, route=route, conn=conn, by="peer", code=1011)

    def route(
        self,
        route: str,
        start: float = FIRST_OPEN,
        end: float = TAIL_END,
        drops: tuple[DropSpec, ...] = (),
        rtt: float = 20.0,
        miss_at: tuple[float, ...] = (),
        ids: dict | None = None,
        pings: bool = False,
    ) -> None:
        """Connected from `start` to `end`, an echo every second, with the given drops. The
        connection open at `end` is closed by the probe itself. `miss_at` names send times whose
        echo is missed without a drop."""
        open_at: float | None = start
        segments: list[tuple[float, float, DropSpec | None, int]] = []
        first_misses = 0
        for drop in sorted(drops, key=lambda d: d.at):
            assert open_at is not None
            segments.append((open_at, drop.at, drop, first_misses))
            if not drop.reconnect:
                open_at = None
                break
            open_at = drop.at + drop.outage
            first_misses = drop.misses_after
        if open_at is not None:
            segments.append((open_at, end, None, first_misses))
        identity = ids or {"by": "server", "boot": "b0", "start": 1}
        for seg_open, seg_close, drop, misses_first in segments:
            conn = self.next_conn(route)
            self.add("attempt", seg_open, route=route, n=conn, ok=True, ms=5.0, conn=conn)
            self.add("open", seg_open, route=route, conn=conn, attempt=conn)
            sends = []
            t = seg_open
            while t < seg_close:
                sends.append(t)
                t += 1000.0
            misses_last = drop.misses_before if drop else 0
            first_reply = True
            for i, sent in enumerate(sends):
                seq = self.next_seq(route)
                self.add("send", sent, route=route, conn=conn, seq=seq)
                missed = i < misses_first or i >= len(sends) - misses_last or sent in miss_at
                if missed:
                    self.add("miss", min(sent + 1000.0, seg_close), route=route, conn=conn, seq=seq)
                    continue
                self.add("reply", sent + rtt, route=route, conn=conn, seq=seq, rtt=rtt)
                if first_reply:
                    self.add(
                        "ident", sent + rtt, route=route, conn=conn, id={**identity, "conn": conn}
                    )
                    first_reply = False
                if pings and i % 5 == 4:
                    self.add("ping", sent + 1, route=route, conn=conn, n=i)
                    self.add("pong", sent + 6, route=route, conn=conn, n=i, rtt=5.0)
            if drop is None:
                self.add("close", seg_close, route=route, conn=conn, by="end", code=1000)
            else:
                self.end(route, conn, seg_close, drop)
                for offset in drop.failed:
                    self.failed_open(route, drop.at + offset)

    def end(self, route: str, conn: int, t: float, drop: DropSpec) -> None:
        if drop.terminal in ("silence", "silence+close"):
            self.add("silence", t, route=route, conn=conn, quietMs=3000.0, outstanding=3)
        if drop.terminal == "error":
            self.add("error", t, route=route, conn=conn, error="ConnectionResetError")
        if drop.terminal in ("close", "silence+close"):
            self.add("close", t, route=route, conn=conn, by=drop.by, code=drop.code)

    def never(self, route: str, status: int = 502, start: float = FIRST_OPEN) -> None:
        for n in range(3):
            self.add(
                "attempt", start + n * 500, route=route, n=n + 1, ok=False, ms=3.0, status=status
            )

    def probe(self, batches: int = 3, missing: tuple[int, ...] = (), manifest: bool = True) -> dict:
        """The instance's batches, each led by a header with the span it accounts for: from the
        previous cut (the first from the earliest event) to its last event."""
        events = list(self.events)
        if self.health and events:
            first, last = min(e["wall"] for e in events), max(e["wall"] for e in events)
            t = first
            while t <= last:
                live = t + self.drift if t > first else t
                mono = t - self.mono_shift
                events.append(
                    {"ev": "clock", "wall": t, "mono": mono, "liveWall": live, "driftMs": live - t}
                )
                n = 50 if self.skew is not None else 0
                events.append(
                    {
                        "ev": "skew",
                        "wall": t,
                        "mono": mono,
                        "route": "p3",
                        "n": n,
                        "medianMs": self.skew,
                    }
                )
                t += 60_000
        ordered = sorted(events, key=lambda e: e["mono"])
        size = max(1, -(-len(ordered) // batches))
        chunks: dict[int, list[dict]] = {}
        cut = ordered[0]["mono"] if ordered else 0.0
        for n in range(batches):
            lines = ordered[n * size : (n + 1) * size]
            start, cut = cut, (lines[-1]["mono"] if lines else cut)
            header = {
                "batch": n + 1,
                "instance": self.instance,
                "runId": self.run_id,
                "fromMono": start,
                "cutMono": cut,
                "events": len(lines),
            }
            chunks[n + 1] = [header, *lines]
        for n in missing:
            chunks.pop(n, None)
        record = {
            "batches": batches,
            "instance": self.instance,
            "runId": self.run_id,
            "events": len(ordered),
            "conflicts": [],
        }
        return {self.instance: {"batches": chunks, "manifest": record if manifest else None}}


def run_json(
    public: bool = True,
    soak_end: float = E,
    mode: str = "run",
    routes: tuple[str, ...] | None = None,
) -> dict:
    built = (
        list(routes)
        if routes is not None
        else (list(ROUTES) if public else ["p1", "p2", "p3", "p6"])
    )
    return {
        "runId": RUN_ID,
        "worker": WORKER,
        "mode": mode,
        "t0": T0,
        "soakStart": S,
        "soakEnd": soak_end,
        "tailEnd": soak_end + TAIL,
        "publicRoutes": public,
        "routes": built,
        "events": [{"id": k, "kind": "reset", "at": v} for k, v in RESETS.items()]
        + [{"id": "end", "kind": "end", "at": soak_end + TAIL}],
    }


def lifecycle(resets: dict[str, float] | None = None) -> list[dict]:
    resets = RESETS if resets is None else resets
    return [{"x1": "reset-requested", "event": k, "R": v, "t": v} for k, v in resets.items()]


def campaign(
    deploys: dict[str, float] | None = None,
    uploaded: dict[str, float | None] | None = None,
    rollout: tuple[str, ...] = (),
    status: dict[str, int] | None = None,
) -> dict:
    deploys = DEPLOYS if deploys is None else deploys
    uploaded = uploaded or {}
    status = status or {}
    return {
        "runId": RUN_ID,
        "clock": {
            "start": {"synchronized": True, "skewMs": 150.0},
            "end": {"synchronized": True, "skewMs": -90.0},
        },
        "deploys": [
            {
                "target": target,
                "start": start,
                "uploaded": uploaded.get(target, start + UPLOAD_MS),
                "end": start + 60_000,
                "status": status.get(target, 0),
                "rollout": target in rollout,
            }
            for target, start in deploys.items()
        ],
    }


def preflight_run(public: bool = True) -> dict:
    """The preflight's run.json: 10 minutes from PRE_T0 and its 60 s tail, same deployment."""
    return {
        **run_json(public),
        "runId": PRE_ID,
        "mode": "preflight",
        "t0": PRE_T0,
        "soakStart": PRE_T0,
        "soakEnd": PRE_T0 + 10 * MIN,
        "tailEnd": PRE_T0 + 10 * MIN + TAIL,
        "events": [],
    }


def preflight(routes: tuple[str, ...] = ROUTES) -> dict:
    b = Builder(instance=PRE_INSTANCE, run_id=PRE_ID)
    for route in routes:
        b.route(route, start=PRE_T0 + 20_000, end=PRE_T0 + 10 * MIN + TAIL)
    return b.probe(batches=1)


def clean(public: bool = True) -> Builder:
    b = Builder()
    for route in ROUTES if public else ("p1", "p2", "p3", "p6"):
        b.route(route)
    return b


def inputs(
    b: Builder | None = None,
    *,
    public: bool = True,
    run: dict | None = None,
    life: list[dict] | None = None,
    camp: dict | None = None,
    pre: dict | None | str = "default",
    pre_run: dict | None | str = "default",
    refused: set[str] | None = None,
    probe: dict | None = None,
) -> analyze.Inputs:
    b = b or clean(public)
    if pre == "default":
        pre = preflight(ROUTES if public else ("p1", "p2", "p3", "p6"))
    if pre_run == "default":
        pre_run = preflight_run(public)
    return analyze.Inputs(
        run=run or run_json(public),
        lifecycle=lifecycle() if life is None else life,
        probe=probe if probe is not None else b.probe(),
        campaign=campaign() if camp is None else camp,
        preflight_probe=copy.deepcopy(pre),  # type: ignore[arg-type]
        refused=refused or set(),
        preflight_run=copy.deepcopy(pre_run),  # type: ignore[arg-type]
    )


def spontaneous_time(k: int) -> float:
    """A soak time outside every forced window: S + 10 min + k minutes."""
    return S + 10 * MIN + k * MIN
