"""FH-29's stub-launcher part: blocked replication fails each launcher call before its effect.

Omnigent's own routes and lifecycle code drive the launcher: ``POST /v1/hosts`` provisions,
a wake re-arms a launch token and calls ``start_host``, the fenced sleep revokes the token and
calls ``suspend``, and ``DELETE /v1/hosts/{id}`` tombstones the host and calls ``terminate``
(the reaper retries it). For each one:

- **blocked:** the call fails before any effect, in the form Omnigent shows as a refusal, and no
  launch token is published; Omnigent's event loop keeps answering meanwhile;
- **healthy:** the effect happens only once the write it depends on is in the replica, shown by
  restoring the replica at the position it held at the moment of the effect;
- **control:** without the fence, a blocked replica lets ``start_host`` publish a token whose
  re-arm the replica does not have, which is the loss the fence prevents.

The tests share one app and run in order.
"""

from __future__ import annotations

import functools
import threading
import time
import uuid

from conftest import BARRIER_TIMEOUT_S, FENCE_TIMEOUT_S, ONLINE_TIMEOUT_S, World

STATE: dict[str, str] = {}


class HealthProbe:
    """Polls ``/health`` from another thread: Omnigent's event loop must keep answering."""

    def __init__(self, world: World) -> None:
        self.latencies: list[float] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(world,), daemon=True)

    def _run(self, world: World) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            assert world.client.get("/health").status_code == 200
            self.latencies.append(time.monotonic() - started)
            time.sleep(0.05)

    def __enter__(self) -> HealthProbe:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=10)


def _wake_finished(world: World, host_id: str) -> bool:
    """A wake of a host with no computer to dial back ends in a recorded start failure."""
    row = world.host_row(host_id)
    return bool(row and row["start_failure"])


def _host_id(world: World, name: str) -> str | None:
    body = world.client.get("/v1/hosts", headers=world.bearer()).json()
    hosts = body.get("data") or body.get("hosts") or body
    return next((h["host_id"] for h in hosts if h.get("name") == name), None)


def _create(world: World, name: str) -> tuple[int, str]:
    response = world.client.post("/v1/hosts", json={"name": name}, headers=world.bearer())
    host_id = world.wait_for(lambda: _host_id(world, name), 10, f"host {name}")
    return response.status_code, host_id


def test_provision_fails_before_its_effect_while_blocked(world: World) -> None:
    world.block()
    try:
        with HealthProbe(world) as probe:
            status, host_id = _create(world, "blocked-create")
            row = world.wait_for(
                lambda: (r := world.host_row(host_id)) and r["start_failure"] and r,
                FENCE_TIMEOUT_S + 15,
                "the first start's failure",
            )
    finally:
        world.unblock()
    latencies = probe.latencies
    world.wait_caught_up()
    assert status == 424  # the pending row itself is a security write (WP2.3)
    assert world.effects.of("provision") == []
    assert row["sandbox_id"] is None
    assert "provision was not started" in row["start_failure"]
    assert "database is saved" in row["start_failure"]
    assert [e["ok"] for e in world.fence.log if e["method"] == "provision"] == [False]
    assert latencies and max(latencies) < 0.5  # the wait ran in a worker thread


def test_provision_and_start_happen_only_once_their_writes_are_replicated(world: World) -> None:
    world.gate.set()
    logged = len(world.fence.log)
    status, host_id = _create(world, "computer")
    assert status == 201
    world.wait_for(lambda: world.effects.of("start_host"), ONLINE_TIMEOUT_S, "start_host")
    provision = world.effects.of("provision")[-1]
    start = world.effects.of("start_host")[-1]
    STATE.update(host=host_id, sandbox=start.sandbox_id)
    assert provision.sandbox_id == start.sandbox_id
    assert all(e["ok"] for e in world.fence.log[logged:])
    # At the moment of each effect, the replica already held the write it depends on.
    at_provision = world.host_row(host_id, world.restore_at(provision.replicated_txid))
    assert at_provision is not None and at_provision["lifecycle"] is not None
    at_start = world.host_row(host_id, world.restore_at(start.replicated_txid))
    assert at_start["token_hash"] == start.token_sha256
    assert world.host_row(host_id)["token_hash"] == start.token_sha256
    # No computer dials back here, so the wake gives up and records it.
    world.wait_for(lambda: _wake_finished(world, host_id), ONLINE_TIMEOUT_S + 10, "wake")


def test_start_host_publishes_no_token_while_blocked(world: World) -> None:
    host_id = STATE["host"]
    published = {e.token_sha256 for e in world.effects.of("start_host")}
    before = len(world.effects.of("start_host"))
    world.gate.clear()  # hold the wake after its status check
    response = world.client.post(f"/v1/hosts/{host_id}/start", headers=world.bearer())
    assert response.status_code == 202
    started = time.monotonic()
    world.block()
    try:
        with HealthProbe(world) as probe:
            world.gate.set()
            row = world.wait_for(
                lambda: (
                    (r := world.host_row(host_id))
                    and "start_host was not started" in (r["start_failure"] or "")
                    and r
                ),
                ONLINE_TIMEOUT_S + FENCE_TIMEOUT_S + 10,
                "the refused start",
            )
    finally:
        world.unblock()
    latencies = probe.latencies
    world.wait_caught_up()
    assert len(world.effects.of("start_host")) == before  # no effect, no token published
    assert world.effects.of("resume", STATE["sandbox"])  # the unfenced resume did run
    # The re-arm happened locally (a new token hash), but its token went nowhere.
    assert row["token_hash"] is not None and row["token_hash"] not in published
    assert time.monotonic() - started < ONLINE_TIMEOUT_S + FENCE_TIMEOUT_S + 10
    assert latencies and max(latencies) < 0.5


def test_control_without_the_fence_a_token_outruns_its_rearm(world: World) -> None:
    host_id = STATE["host"]
    world.fence.enabled = False
    world.block()
    try:
        world.client.post(f"/v1/hosts/{host_id}/start", headers=world.bearer())
        effect = world.wait_for(
            lambda: [
                e
                for e in world.effects.of("start_host")
                if e.replicated_txid is not None
                and e.txid is not None
                and e.replicated_txid < e.txid
            ],
            ONLINE_TIMEOUT_S,
            "an unfenced start_host",
        )[-1]
    finally:
        world.unblock()
        world.fence.enabled = True
    world.wait_caught_up()
    restored = world.host_row(host_id, world.restore_at(effect.replicated_txid))
    # The computer would hold a token the replica has never seen: a server restored now
    # would refuse it, or accept the earlier one it replaced (FH-25's case).
    assert restored["token_hash"] != effect.token_sha256
    world.wait_for(lambda: _wake_finished(world, host_id), ONLINE_TIMEOUT_S + 10, "wake")


def _sleep(world: World, host_id: str, operation: str) -> str:
    from omnigent.server import persistent_hosts
    from omnigent.stores.host_store import HostStore

    store = HostStore(f"sqlite:///{world.db_path}")
    assert store.begin_host_sleep(host_id, operation_id=operation)  # revokes the token
    world.client.portal.call(persistent_hosts.recover_pending_sleeps)
    return world.client.portal.call(
        functools.partial(persistent_hosts.sleep_if_idle, host_id, only_operation=operation)
    )


def test_suspend_is_refused_before_any_stop_while_blocked(world: World) -> None:
    host_id = STATE["host"]
    token_before = world.host_row(host_id)["token_hash"]
    assert token_before is not None
    world.block()
    try:
        outcome = _sleep(world, host_id, uuid.uuid4().hex)
    finally:
        world.unblock()
    world.wait_caught_up()
    assert outcome == "refused"
    assert world.effects.of("suspend") == []
    row = world.host_row(host_id)
    assert row["sleep_operation_id"] is None and row["token_hash"] == token_before  # restored


def test_suspend_stops_only_once_the_revocation_is_replicated(world: World) -> None:
    host_id = STATE["host"]
    operation = uuid.uuid4().hex
    outcome = _sleep(world, host_id, operation)
    assert outcome == "stopped"
    effect = world.effects.of("suspend")[-1]
    restored = world.host_row(host_id, world.restore_at(effect.replicated_txid))
    assert restored["sleep_operation_id"] == operation  # the token was revoked durably first


def test_terminate_waits_for_the_tombstone_and_the_reaper_retries(world: World) -> None:
    from omnigent.server import persistent_hosts
    from omnigent.server.managed_sandbox_reaper import ManagedSandboxReaper
    from omnigent.stores.host_store import HostStore

    host_id = STATE["host"]
    world.block()
    try:
        started = time.monotonic()
        response = world.client.delete(f"/v1/hosts/{host_id}", headers=world.bearer())
        elapsed = time.monotonic() - started
    finally:
        world.unblock()
    world.wait_caught_up()
    assert response.status_code == 424  # the tombstone is applied, durability unconfirmed
    assert elapsed >= BARRIER_TIMEOUT_S - 0.5
    assert world.effects.of("terminate") == []
    tombstone = world.host_row(host_id)
    assert tombstone["deleted_at"] is not None and tombstone["sandbox_id"] == STATE["sandbox"]

    reaper = ManagedSandboxReaper(
        host_store=HostStore(f"sqlite:///{world.db_path}"),
        sandbox_config=persistent_hosts._deployment,
    )
    world.client.portal.call(reaper.sweep_once)
    effect = world.effects.of("terminate", STATE["sandbox"])[-1]
    restored = world.host_row(host_id, world.restore_at(effect.replicated_txid))
    assert restored is not None and restored["deleted_at"] is not None
