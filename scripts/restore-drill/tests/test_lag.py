"""The replication-lag warning, and the loss it predicts (FH-15, FM-06).

A watchdog samples the control port's ``/position`` as WP2.2's does, and folds the samples into
:class:`cfo_drill.lag.LagTracker`. With the replica blackholed, the warning must come up once
the oldest unreplicated write is older than the threshold, never before, and a server lost
during the lag must lose exactly the writes made since the block: the degraded mode's policy.
The threshold is 20 s here instead of the design's 60 s, to keep the test short.
"""

from __future__ import annotations

import time

import httpx

from cfo_drill import lag

from conftest import requires_docker
from harness_stack import Server, Stack

pytestmark = requires_docker

THRESHOLD_S = 20.0
SAMPLE_S = 1.0
WRITE_EVERY_S = 2.0


def _sample(server: Server) -> lag.Sample:
    now = time.monotonic()
    try:
        response = server.position()
    except httpx.HTTPError:
        return lag.Sample(now)
    if response.status_code != 200:
        return lag.Sample(now)
    body = response.json()
    return lag.Sample(now, body["bootId"], body["txid"], body["replicatedTxid"])


def _session(c: httpx.Client, bearer: dict[str, str], agent: str) -> str:
    response = c.post("/v1/sessions", json={"agent_id": agent}, headers=bearer)
    assert response.status_code in (200, 201), response.text
    assert "x-cfo-durability" not in response.headers  # an ordinary write: never held
    return response.json()["id"]


def _sessions(server: Server, password: str) -> set[str]:
    with httpx.Client(base_url=server.url, timeout=30) as c:
        token = c.post("/auth/login", json={"username": "owner", "password": password}).json()
        body = c.get(
            "/v1/sessions",
            params={"limit": 200},
            headers={"Authorization": f"Bearer {token['token']}"},
        ).json()
    return {s["id"] for s in (body.get("data") or body.get("sessions") or [])}


def _lag_under_block(server: Server, link: Stack, seconds: float) -> dict:
    """Blackhole the link, keep writing, and sample the position; return what was seen."""
    with httpx.Client(base_url=server.url, timeout=60) as c:
        token = c.post(
            "/auth/login", json={"username": "owner", "password": server.password}
        ).json()["token"]
        bearer = {"Authorization": f"Bearer {token}"}
        agent = c.get("/v1/agents", headers=bearer).json()
        agent = (agent.get("data") or agent)[0]["id"]
        before = [_session(c, bearer, agent) for _ in range(2)]
        server.wait_replicated()
        tracker = lag.LagTracker(threshold_s=THRESHOLD_S)
        states: list[tuple[float, lag.LagState]] = []
        for _ in range(3):
            states.append((time.monotonic(), tracker.observe(_sample(server))))
        assert not any(s.warning for _, s in states)
        link.blackhole()
        blocked_at = time.monotonic()
        during: list[tuple[float, str]] = []
        next_write = blocked_at
        while time.monotonic() - blocked_at < seconds:
            if time.monotonic() >= next_write:
                during.append((time.monotonic(), _session(c, bearer, agent)))
                next_write += WRITE_EVERY_S
            states.append((time.monotonic(), tracker.observe(_sample(server))))
            time.sleep(SAMPLE_S)
    return {
        "before": before,
        "during": during,
        "states": states,
        "blocked_at": blocked_at,
        "tracker": tracker,
    }


def _first_warning(states: list[tuple[float, lag.LagState]]) -> float | None:
    return next((t for t, s in states if s.warning), None)


def test_lag_warning_and_the_loss_of_a_server_lost_during_the_lag(link: Stack, prefix: str) -> None:
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    seen = _lag_under_block(server, link, THRESHOLD_S + 10)
    first_write = seen["during"][0][0]
    warned = _first_warning(seen["states"])
    assert warned is not None, [s for _, s in seen["states"]][-3:]
    # Never early: not before the first unreplicated write is THRESHOLD_S old. At most one
    # sample interval late, plus the time one position call takes.
    assert warned >= first_write + THRESHOLD_S - 0.01
    assert warned <= first_write + THRESHOLD_S + 2 * SAMPLE_S + 1.5
    final = seen["states"][-1][1]
    assert final.warning and final.reason == "lagging" and not final.caught_up

    # Lose the server now, while the link is still down (unblocking first would let Litestream
    # catch up before the kill). Every write since the block is lost; nothing before it is.
    lag_at_kill = final.lag_s
    server.kill("KILL")
    link.unblock()
    nxt = server.replace(CFO_INSTALLATION_INITIALIZED="true")
    nxt.wait_healthy()
    present = _sessions(nxt, server.password)
    assert set(seen["before"]) <= present
    lost = [sid for _, sid in seen["during"] if sid not in present]
    assert lost == [sid for _, sid in seen["during"]]
    assert len(lost) >= int((THRESHOLD_S + 10) / WRITE_EVERY_S) - 1
    assert lag_at_kill >= THRESHOLD_S


def test_lag_warning_clears_once_the_replica_catches_up(link: Stack, prefix: str) -> None:
    server = link.server(prefix, initialized=False).start()
    server.wait_healthy()
    seen = _lag_under_block(server, link, THRESHOLD_S + 4)
    assert _first_warning(seen["states"]) is not None
    tracker: lag.LagTracker = seen["tracker"]
    link.unblock()
    unblocked = time.monotonic()
    state = tracker.observe(_sample(server))
    while not state.caught_up and time.monotonic() - unblocked < 60:
        time.sleep(0.5)
        state = tracker.observe(_sample(server))
    caught_up_after = time.monotonic() - unblocked
    assert state.caught_up and state.lag_s == 0 and not state.warning
    assert caught_up_after < 30

    # Nothing was lost: the writes made during the block are durable now.
    nxt = server.replace(CFO_INSTALLATION_INITIALIZED="true")
    nxt.wait_healthy()
    present = _sessions(nxt, server.password)
    assert {sid for _, sid in seen["during"]} | set(seen["before"]) <= present
