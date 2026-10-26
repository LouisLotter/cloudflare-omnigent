"""Omnigent's own persistent-host lifecycle driving the Cloudflare launcher, in process.

The real fork modules (``persistent_hosts``, ``HostStore`` on SQLite, ``HostRegistry``) call the
real ``CloudflareLauncher`` as registered, which talks real HTTP to the fake launcher API. When
the fake platform hands a start's parameters to its "supervisor", a fake host process dials
in with that launch token, which the real store must accept. This proves the launcher meets
core change 13's expectations end to end on one machine: add, wake, keep alive, checkpoint,
sleep, wake again, a lost sleep reply, the durability fence, admission, and delete.

It is not the deployed platform: WorkspaceDO, the Worker's receiver and a real computer are
stand-ins here (they belong to 3.1, 3.3 and 3.4). Needs the fork's Omnigent build.
"""

from __future__ import annotations

import asyncio
import dataclasses
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("omnigent.server.persistent_hosts")
pytest_asyncio = pytest.importorskip("pytest_asyncio")

from conftest import FAST_BACKOFF, FAST_POLICIES, SUSPEND_POLL_S  # noqa: E402
from fake_platform import Computer, FakeLauncherApi  # noqa: E402
from omnigent.errors import ErrorCode, OmnigentError  # noqa: E402
from omnigent.host.frames import (  # noqa: E402
    CAP_PLUGINS,
    CAP_QUIESCE,
    HostHelloFrame,
    HostListDirFrame,
    HostPluginsFrame,
    HostPluginsResultFrame,
    HostQuiesceFrame,
    HostQuiesceResultFrame,
    decode_host_frame,
)
from omnigent.server import persistent_hosts  # noqa: E402
from omnigent.server.host_registry import HostConnection, HostRegistry  # noqa: E402
from omnigent.server.managed_hosts import ManagedSandboxDeployment  # noqa: E402
from omnigent.stores.host_store import HostStore  # noqa: E402

from cloudflare_omnigent.sandbox import client as client_module  # noqa: E402
from cloudflare_omnigent.sandbox import core as core_module  # noqa: E402
from cloudflare_omnigent.sandbox.registration import (  # noqa: E402
    cloudflare_sandbox_config,
    manage_url_template,
)
from cloudflare_omnigent.sandbox.settings import LauncherSettings  # noqa: E402

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(120)]

OWNER = "local"


class _FakeWs:
    async def send_text(self, data: str) -> None:
        del data

    async def close(self, code: int = 1000, reason: str = "") -> None:
        del code, reason


@dataclass
class Hosts:
    """The host processes the fake platform's supervisor starts, one per computer."""

    store: HostStore
    registry: HostRegistry
    loop: asyncio.AbstractEventLoop
    tokens: dict[str, list[str]] = field(default_factory=dict)
    refused: list[str] = field(default_factory=list)
    tasks: list[asyncio.Task[None]] = field(default_factory=list)

    def started(self, computer: Computer, token: str) -> None:
        """Called from the fake platform's thread when a start's parameters are taken."""
        assert computer.host_id is not None
        self.loop.call_soon_threadsafe(self.connect, computer.host_id, token)

    def connect(self, host_id: str, token: str) -> None:
        row = self.store.resolve_launch_token(host_id, token)
        if row is None:
            self.refused.append(token)
            return
        self.tokens.setdefault(host_id, []).append(token)
        self.store.upsert_on_connect(
            host_id=host_id, name=row.name, user_id=OWNER, managed_token=token
        )
        hello = HostHelloFrame(
            version="test",
            frame_protocol_version=1,
            name=row.name,
            capabilities=[CAP_PLUGINS, CAP_QUIESCE],
        )
        conn = self.registry.register(
            host_id, _FakeWs(), hello, owner=OWNER, registered_with_managed_token=True
        )
        self.tasks.append(self.loop.create_task(self._answer(conn)))

    async def _answer(self, conn: HostConnection) -> None:
        while True:
            outbound = await conn.outbound_queue.get()
            if outbound is None:
                return
            frame = decode_host_frame(outbound.data)
            if isinstance(frame, HostQuiesceFrame):
                future = conn.pending_quiesce.get(frame.request_id)
                if future is not None and not future.done():
                    future.set_result(
                        HostQuiesceResultFrame(request_id=frame.request_id, runners=[])
                    )
            elif isinstance(frame, HostPluginsFrame):
                plugins = conn.pending_plugins.pop(frame.request_id, None)
                if plugins is not None and not plugins.done():
                    plugins.set_result(
                        HostPluginsResultFrame(request_id=frame.request_id, status="ok")
                    )
            elif isinstance(frame, HostListDirFrame):
                listing = conn.pending_list_dirs.pop(frame.request_id, None)
                if listing is not None and not listing.done():
                    listing.set_result({"status": "ok", "entries": [], "has_more": False})


@dataclass
class World:
    api: FakeLauncherApi
    store: HostStore
    hosts: Hosts
    fence_calls: list[str]
    fence: Callable[[], Any]

    def requests(self, operation: str) -> list[Any]:
        return self.api.accepted(operation)

    def operations(self) -> list[str | None]:
        return [r.operation for r in self.api.accepted()]


@pytest_asyncio.fixture
async def world(
    api: FakeLauncherApi, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[World]:
    # Short budgets for lost replies; Omnigent's own waits shortened as its tests do.
    monkeypatch.setattr(core_module, "POLICIES", FAST_POLICIES)
    monkeypatch.setattr(core_module, "SUSPEND_POLL_S", SUSPEND_POLL_S)
    monkeypatch.setattr(client_module, "BACKOFF_S", FAST_BACKOFF[0])
    monkeypatch.setattr(client_module, "MAX_BACKOFF_S", FAST_BACKOFF[1])
    monkeypatch.setattr(persistent_hosts, "FENCE_DRAIN_S", 5.0)
    monkeypatch.setattr(persistent_hosts, "_STATUS_POLL_S", 0.05)
    monkeypatch.setattr(persistent_hosts, "_UNKNOWN_RETRY_S", 0.05)
    monkeypatch.setattr(persistent_hosts, "_resume_locks", {})

    store = HostStore(f"sqlite:///{tmp_path / 'hosts.db'}")
    registry = HostRegistry()
    registry.admission_gate = persistent_hosts.admit_host_work
    registry.send_guard = persistent_hosts.guard_host_request
    hosts = Hosts(store, registry, asyncio.get_running_loop())
    api.on_start_host = hosts.started

    fence_calls: list[str] = []
    state: dict[str, Any] = {"confirm": True}

    def durability_wait(timeout_s: float) -> bool:
        # Which request the effect follows: proves the wait came first.
        fence_calls.append(f"after:{len(api.requests)}")
        confirm = state["confirm"]
        return bool(confirm()) if callable(confirm) else bool(confirm)

    settings = LauncherSettings(
        signing_key=api.key, signing_key_id=api.key_id, base_url=api.base_url
    )
    entry = cloudflare_sandbox_config(
        settings=settings,
        durability_wait=durability_wait,
        manage_url=manage_url_template("https://computers.example.test"),
    )
    persistent_hosts._states.clear()
    persistent_hosts.configure(store, registry, ManagedSandboxDeployment.single(entry))
    world = World(api, store, hosts, fence_calls, lambda: state["confirm"])
    world.confirm = state  # type: ignore[attr-defined]
    world.entry = entry  # type: ignore[attr-defined]
    try:
        yield world
    finally:
        for task in hosts.tasks:
            task.cancel()
        for lifecycle in persistent_hosts._states.values():
            if lifecycle.wake_task is not None:
                lifecycle.wake_task.cancel()
        persistent_hosts.configure(None, None, None)
        persistent_hosts._states.clear()


async def _ready(host_id: str, timeout_s: float = 30) -> None:
    """Readiness for one message, in its own task, so its admission ends with the task."""
    await asyncio.create_task(
        persistent_hosts.ensure_host_ready(host_id, operation="message", timeout_s=timeout_s)
    )


async def _awake(world: World, name: str = "Work computer") -> str:
    host = await persistent_hosts.create_host(owner=OWNER, name=name, provider="cloudflare")
    await _ready(host.host_id)
    return host.host_id


def _launcher(world: World) -> Any:
    return world.entry.launcher_factory()  # type: ignore[attr-defined]


# ── The whole lifecycle ─────────────────────────────────────────────────────────────────


async def test_add_wake_save_sleep_wake_and_delete_a_computer(world: World) -> None:
    host_id = await _awake(world)
    row = world.store.get_host(host_id)
    assert row is not None and row.sandbox_provider == "cloudflare"
    sandbox_id = row.sandbox_id
    computer = world.api.computer(sandbox_id)

    # Add: preflight, the computer recorded by Omnigent's stable name, then the first start.
    ops = world.operations()
    assert ops[:2] == ["prepare", "provision"]
    # Fork 3228d4de3 (WP3.8b) provisions by the whole host ID, so two hosts sharing the first
    # 8 hex digits never share a computer.
    assert world.requests("provision")[0].body["name"] == f"managed-{host_id}"
    for step in ("resume", "claim_start", "start_host"):
        assert step in ops
    assert ops.index("resume") < ops.index("claim_start") < ops.index("start_host")
    (start,) = world.requests("start_host")
    assert start.body["hostId"] == host_id and start.body["hostName"] == "Work computer"
    assert start.body["startAttempt"] == 1
    assert start.body["hostConfig"] == {"runner": {"idle_timeout_s": 600}}
    # The token the platform got is the one Omnigent armed, and the host connected with it.
    assert computer.tokens == world.hosts.tokens[host_id] and not world.hosts.refused
    # The fence ran before provision and before start_host, and for nothing else.
    sent = [r.operation for r in world.api.requests]
    assert [sent[int(c.split(":")[1])] for c in world.fence_calls] == ["provision", "start_host"]

    # Stay awake and save during use.
    launcher = _launcher(world)
    assert await asyncio.to_thread(launcher.keep_alive, sandbox_id) is True
    operation_id = await asyncio.to_thread(launcher.checkpoint, sandbox_id, reason="turn_completed")
    assert operation_id == world.requests("checkpoint")[0].operation_id

    # Sleep: Omnigent's fence, then suspend under its operation ID, followed until stopped.
    world.api.suspend_polls = 2
    assert await persistent_hosts.sleep_if_idle(host_id) == "stopped"
    sleeps = world.requests("suspend")
    assert len(sleeps) == 3 and len({r.operation_id for r in sleeps}) == 1
    assert world.fence_calls[-1] == f"after:{world.api.requests.index(sleeps[0])}"
    assert computer.status == "stopped"
    first_token = computer.tokens[-1]
    assert world.store.resolve_launch_token(host_id, first_token) is None  # revoked

    # Wake for new work: a new generation, attempt 2, a fresh token, a fresh admission report.
    before = len(world.api.requests)
    await _ready(host_id)
    later = [r.operation for r in world.api.requests[before:]]
    assert later.index("resume") < later.index("claim_start") < later.index("start_host")
    assert "admission" in later[later.index("start_host") :]
    assert computer.generation == 2 and computer.attempt == 2
    assert computer.tokens[-1] != first_token
    assert world.hosts.tokens[host_id][-1] == computer.tokens[-1]

    # Delete: the tombstone first, then terminate after the fence; the computer refuses wakes.
    host = world.store.get_host(host_id)
    assert host is not None
    await persistent_hosts.delete_host(host)
    (removal,) = world.requests("terminate")
    assert world.fence_calls[-1] == f"after:{world.api.requests.index(removal)}"
    assert computer.removal
    from cloudflare_omnigent.sandbox.client import PlatformGone

    with pytest.raises(Exception) as caught:
        await asyncio.to_thread(launcher.resume, sandbox_id)
    assert type(caught.value).__name__ == "SandboxGoneError"
    assert not isinstance(caught.value, PlatformGone)


async def test_a_lost_sleep_reply_keeps_admission_closed_until_the_same_operation_reports(
    world: World,
) -> None:
    host_id = await _awake(world)
    world.api.fault("suspend", "drop_after", times=1000)
    assert await persistent_hosts.sleep_if_idle(host_id) == "unknown"
    state = persistent_hosts._state(host_id)
    assert not state.admitting.is_set()
    operation_id = state.unknown_suspend_operation
    assert operation_id is not None
    world.api.faults.clear()
    assert await persistent_hosts.sleep_if_idle(host_id, only_operation=operation_id) == "stopped"
    assert state.admitting.is_set()
    assert {r.operation_id for r in world.requests("suspend")} == {operation_id}


async def test_work_waiting_on_an_unknown_sleep_resolves_it_then_wakes(world: World) -> None:
    host_id = await _awake(world)
    world.api.fault("suspend", "drop_after", times=1000)
    assert await persistent_hosts.sleep_if_idle(host_id) == "unknown"
    world.api.faults.clear()  # the platform is reachable again
    await _ready(host_id)
    assert world.api.computer().generation == 2  # stopped for the sleep, then woken


# ── Durability fence through Omnigent (FH-25, FH-29) ────────────────────────────────────


async def test_blocked_replication_fails_the_first_start_visibly_and_creates_nothing(
    world: World,
) -> None:
    world.confirm["confirm"] = False  # type: ignore[attr-defined]
    host = await persistent_hosts.create_host(owner=OWNER, name="Work computer", provider=None)
    with pytest.raises(OmnigentError):
        await asyncio.wait_for(persistent_hosts._state(host.host_id).wake_task, 30)  # type: ignore[arg-type]
    row = world.store.get_host(host.host_id)
    assert row is not None and row.sandbox_id is None
    assert "not yet replicated" in (row.start_failure or "")
    assert world.requests("provision") == [] and world.api.computers == {}
    # Once replication catches up, "Start again" works.
    world.confirm["confirm"] = True  # type: ignore[attr-defined]
    await asyncio.wait_for(persistent_hosts.start_host_now(host.host_id), 30)
    assert world.hosts.tokens.get(host.host_id)


async def test_blocked_replication_at_the_start_publishes_no_token(world: World) -> None:
    # Replication stops once the start is claimed, so the re-arm can never be confirmed.
    world.confirm["confirm"] = lambda: not world.requests("claim_start")  # type: ignore[attr-defined]
    host = await persistent_hosts.create_host(owner=OWNER, name="Work computer", provider=None)
    task = persistent_hosts._state(host.host_id).wake_task
    assert task is not None
    with pytest.raises(OmnigentError, match="not yet replicated"):
        await asyncio.wait_for(task, 30)
    assert world.requests("claim_start") and world.requests("start_host") == []
    assert all(c.tokens == [] for c in world.api.computers.values())
    assert world.hosts.tokens == {}


# ── Admission (R-13) ────────────────────────────────────────────────────────────────────


async def test_admission_refuses_only_on_an_explicit_refusal(world: World) -> None:
    entry = world.entry  # type: ignore[attr-defined]
    assert entry.persistent is not None
    entry.persistent = dataclasses.replace(entry.persistent, admission_max_age_s=0.5)
    host_id = await _awake(world)
    computer = world.api.computer()
    # A failed refresh is retried within the deadline, never shown as a refusal.
    await asyncio.sleep(0.6)
    world.api.fault("admission", "html502", times=1)
    await _ready(host_id)
    # An explicit refusal is shown with its reason.
    computer.admitting = False
    await asyncio.sleep(0.6)
    with pytest.raises(OmnigentError) as caught:
        await _ready(host_id, timeout_s=5)
    assert caught.value.code == ErrorCode.HOST_NOT_ADMITTING
    assert "35 minutes" in str(caught.value)
    computer.admitting = True
    await asyncio.sleep(0.6)
    await _ready(host_id)


async def test_an_unreachable_platform_fails_waiting_work_as_status_unknown(world: World) -> None:
    entry = world.entry  # type: ignore[attr-defined]
    assert entry.persistent is not None
    entry.persistent = dataclasses.replace(entry.persistent, admission_max_age_s=0.5)
    host_id = await _awake(world)
    await asyncio.sleep(0.6)
    world.api.fault("admission", "drop_after", times=10_000)
    with pytest.raises(OmnigentError) as caught:
        await _ready(host_id, timeout_s=3)
    assert caught.value.code != ErrorCode.HOST_NOT_ADMITTING
