"""Synthetic X1 records for the analyzer's tests: a probe log per route, RunDO's lifecycle
records, the campaign's deploy record and a preflight, on the real schedule's times.

Probe events use wall == monotonic, so each instance's offset is 0 and t == the given time.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field

import analyze

MIN = 60_000
T0 = 1_800_000_000_000
S = T0 + 5 * MIN
E = S + 120 * MIN
RESETS = {"reset-s30": S + 30 * MIN, "reset-s60": S + 60 * MIN, "reset-s90": S + 90 * MIN}
UPLOAD_MS = 20_000
DEPLOYS = {"ui": S + 45 * MIN, "transport": S + 75 * MIN}
ROUTES = ("p1", "p2", "p3", "p4", "p5", "p6")
INSTANCE = "g1-0a1b2c3d-00a1b2"
FIRST_OPEN = T0 + 20_000
# Observed time on the default schedule: 7200 s minus 3 x 32 s of resets and 2 x 350 s of deploys.
OBSERVED_MS = 120 * MIN - 3 * 32_000 - 2 * (UPLOAD_MS + 330_000)


@dataclass
class DropSpec:
    at: float
    by: str = "peer"
    code: int | None = 1006
    misses_before: int = 0
    outage: float = 500.0
    misses_after: int = 0
    reconnect: bool = True


@dataclass
class Builder:
    instance: str = INSTANCE
    events: list[dict] = field(default_factory=list)

    def add(self, ev: str, t: float, **fields: object) -> None:
        self.events.append({"ev": ev, "wall": t, "mono": t, **fields})

    def route(
        self,
        route: str,
        start: float = FIRST_OPEN,
        end: float = E,
        drops: tuple[DropSpec, ...] = (),
        rtt: float = 20.0,
        miss_at: tuple[float, ...] = (),
        no_outcome: int = 0,
        ids: dict | None = None,
        pings: bool = False,
    ) -> None:
        """Connected from `start` to `end`, an echo every second, with the given drops. The
        connection open at `end` is closed by the probe itself. `miss_at` names send times whose
        echo is missed without a drop; `no_outcome` leaves the first N soak slots with neither a
        reply nor a miss recorded."""
        seq = 0
        conn = 0
        blank = no_outcome
        open_at = start
        segments: list[tuple[float, float, DropSpec | None, int]] = []
        first_misses = 0
        for drop in sorted(drops, key=lambda d: d.at):
            segments.append((open_at, drop.at, drop, first_misses))
            if not drop.reconnect:
                open_at = None  # type: ignore[assignment]
                break
            open_at = drop.at + drop.outage
            first_misses = drop.misses_after
        if open_at is not None:
            segments.append((open_at, end, None, first_misses))
        identity = ids or {"by": "server", "boot": "b0", "start": 1}
        for seg_open, seg_close, drop, misses_first in segments:
            conn += 1
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
                seq += 1
                self.add("send", sent, route=route, conn=conn, seq=seq)
                if blank > 0 and S <= sent <= E:
                    blank -= 1
                    continue
                missed = i < misses_first or i >= len(sends) - misses_last or sent in miss_at
                if missed:
                    self.add("miss", min(sent + 1000.0, seg_close), route=route, conn=conn, seq=seq)
                    continue
                self.add("reply", sent + rtt, route=route, conn=conn, seq=seq, rtt=rtt)
                if first_reply:
                    self.add("ident", sent + rtt, route=route, conn=conn, id={**identity, "conn": conn})
                    first_reply = False
                if pings and i % 5 == 4:
                    self.add("ping", sent + 1, route=route, conn=conn, n=i)
                    self.add("pong", sent + 6, route=route, conn=conn, n=i, rtt=5.0)
            if drop is None:
                self.add("close", seg_close, route=route, conn=conn, by="end", code=1000)
            else:
                self.add("close", seg_close, route=route, conn=conn, by=drop.by, code=drop.code)

    def never(self, route: str, status: int = 502, start: float = FIRST_OPEN) -> None:
        for n in range(3):
            self.add("attempt", start + n * 500, route=route, n=n + 1, ok=False, ms=3.0, status=status)

    def probe(self, batches: int = 3, missing: tuple[int, ...] = (), manifest: bool = True) -> dict:
        ordered = sorted(self.events, key=lambda e: e["mono"])
        size = max(1, -(-len(ordered) // batches))
        chunks = {n + 1: ordered[n * size : (n + 1) * size] for n in range(batches)}
        for n in missing:
            chunks.pop(n, None)
        return {
            self.instance: {
                "batches": chunks,
                "manifest": {"batches": batches, "instance": self.instance} if manifest else None,
            }
        }


def run_json(
    public: bool = True, soak_end: float = E, mode: str = "run", routes: tuple[str, ...] | None = None
) -> dict:
    built = list(routes) if routes is not None else (list(ROUTES) if public else ["p1", "p2", "p3", "p6"])
    return {
        "runId": "run-20270115T080000Z",
        "mode": mode,
        "t0": T0,
        "soakStart": S,
        "soakEnd": soak_end,
        "publicRoutes": public,
        "routes": built,
        "events": [{"id": k, "kind": "reset", "at": v} for k, v in RESETS.items()]
        + [{"id": "end", "kind": "end", "at": soak_end}],
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
        "runId": "run-20270115T080000Z",
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


def preflight(routes: tuple[str, ...] = ROUTES) -> dict:
    b = Builder(instance="g1-0f0f0f0f-0f0f0f")
    for route in routes:
        b.route(route, start=T0 - 30 * MIN, end=T0 - 25 * MIN)
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
    refused: set[str] | None = None,
    probe: dict | None = None,
) -> analyze.Inputs:
    b = b or clean(public)
    if pre == "default":
        pre = preflight(ROUTES if public else ("p1", "p2", "p3", "p6"))
    return analyze.Inputs(
        run=run or run_json(public),
        lifecycle=lifecycle() if life is None else life,
        probe=probe if probe is not None else b.probe(),
        campaign=campaign() if camp is None else camp,
        preflight_probe=copy.deepcopy(pre),  # type: ignore[arg-type]
        refused=refused or set(),
    )


def spontaneous_time(k: int) -> float:
    """A soak time outside every forced window: S + 10 min + k minutes."""
    return S + 10 * MIN + k * MIN
