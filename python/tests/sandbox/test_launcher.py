"""``CloudflareLauncher`` as Omnigent sees it: the fork's ``SandboxHostLauncher`` interface,
its capability flags, and every outcome mapped to what core change 13 expects.

Needs the fork's Omnigent build (``cfo/integration``); skipped where it is not installed.
"""

from __future__ import annotations

import time

import click
import pytest

pytest.importorskip("omnigent.onboarding.sandboxes.base")

from conftest import FAST_BACKOFF, FAST_POLICIES, SUSPEND_POLL_S, Fence, launch_token  # noqa: E402
from fake_platform import FakeLauncherApi  # noqa: E402
from omnigent.onboarding.sandboxes.base import (  # noqa: E402
    SandboxCapabilityError,
    SandboxGoneError,
    SandboxHostLauncher,
)
from omnigent.onboarding.sandboxes.types import (  # noqa: E402
    AdmissionReport,
    StartClaim,
    SuspendResult,
)

from cloudflare_omnigent.sandbox import protocol  # noqa: E402
from cloudflare_omnigent.sandbox.client import LauncherClient, OutcomeUnknown  # noqa: E402
from cloudflare_omnigent.sandbox.core import LauncherCore  # noqa: E402
from cloudflare_omnigent.sandbox.launcher import PROVIDER, CloudflareLauncher  # noqa: E402
from cloudflare_omnigent.sandbox.settings import LauncherSettings  # noqa: E402

HOST_ID = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f"
SERVER = "http://omnigent.internal"


def _launcher(settings: LauncherSettings | None, fence: Fence | None) -> CloudflareLauncher:
    client = None if settings is None else LauncherClient(settings, backoff_s=FAST_BACKOFF)
    core = LauncherCore(
        settings, fence, client=client, policies=FAST_POLICIES, suspend_poll_s=SUSPEND_POLL_S
    )
    return CloudflareLauncher(settings, fence, core=core)


@pytest.fixture
def launcher(settings: LauncherSettings, fence: Fence) -> CloudflareLauncher:
    return _launcher(settings, fence)


def _start(launcher: CloudflareLauncher, sandbox_id: str, attempt: int | None, **kw: object) -> str:
    args: dict[str, object] = {
        "token": launch_token(),
        "host_id": HOST_ID,
        "host_name": "Work computer",
        "server_url": SERVER,
        "start_attempt": attempt,
    }
    args.update(kw)
    return launcher.start_host(sandbox_id, **args)  # type: ignore[arg-type]


# ── The interface ───────────────────────────────────────────────────────────────────────


def test_it_implements_omnigents_launcher_with_the_persistent_capabilities() -> None:
    launcher = CloudflareLauncher(None, None)  # abstract methods missing would raise here
    assert isinstance(launcher, SandboxHostLauncher)
    assert launcher.provider == PROVIDER == "cloudflare"
    caps = launcher.capabilities
    assert caps.managed_launch and caps.resume_stopped and caps.programmatic_terminate
    assert caps.checkpoint and caps.suspend and caps.admission and caps.start_claims
    assert not caps.cli_bootstrap and not caps.local_port_forward and not caps.file_copy
    assert not caps.streaming_exec and not caps.foreground_exec and not caps.git_clone_options
    assert not caps.classifies_runner_by_agent
    assert "key" not in repr(launcher).lower()


def test_an_unconfigured_launcher_fails_readably_and_sends_nothing(api: FakeLauncherApi) -> None:
    launcher = _launcher(None, Fence())
    for call in (
        launcher.prepare,
        lambda: launcher.provision("managed-0123abcd"),
        lambda: launcher.resume("cmp_01hzy3m8k6q4t2v9w7x5r0s1n3"),
        lambda: _start(launcher, "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3", 1),
    ):
        with pytest.raises(click.ClickException, match="not configured"):
            call()
    assert launcher.keep_alive("cmp_01hzy3m8k6q4t2v9w7x5r0s1n3") is False
    assert api.requests == []


# ── Outcomes mapped onto Omnigent ───────────────────────────────────────────────────────


def test_a_wake_through_the_launcher(api: FakeLauncherApi, launcher: CloudflareLauncher) -> None:
    launcher.prepare()
    sandbox_id = launcher.provision("managed-0123abcd")
    report = launcher.admission(sandbox_id)
    assert report is not None and report.status == "stopped" and report.admitting
    assert launcher.is_running(sandbox_id) is False
    launcher.resume(sandbox_id)
    assert launcher.is_running(sandbox_id) is True
    claim = launcher.claim_start(sandbox_id, operation_id=protocol.new_operation_id())
    assert claim == StartClaim(granted=True, attempt=1)
    stages: list[str] = []
    workspace = _start(launcher, sandbox_id, 1, host_config=None, on_stage=stages.append, repos=())
    assert workspace == "/home/omnigent/work" and stages == ["starting"]
    (sent,) = api.accepted("start_host")
    assert sent.body is not None and sent.body["hostConfig"] == {}
    refused = launcher.claim_start(sandbox_id, operation_id=protocol.new_operation_id())
    assert refused == StartClaim(granted=False, status="host_running")
    assert launcher.keep_alive(sandbox_id) is True


def test_admission_reports_carry_status_generation_and_reply_time(
    api: FakeLauncherApi, launcher: CloudflareLauncher
) -> None:
    computer = api.add_computer(status="host_running", generation=6, admitting=False)
    before = time.time()
    report = launcher.admission(computer.computer_id)
    assert report == AdmissionReport(
        admitting=False,
        reason="not_saved",
        message="The computer's files have not been saved for 35 minutes.",
        generation="6",
        status="host_running",
        observed_at=report.observed_at if report else None,
    )
    assert report is not None and before <= (report.observed_at or 0) <= time.time()


def test_unknown_reads_answer_none_never_a_refusal(
    api: FakeLauncherApi, launcher: CloudflareLauncher
) -> None:
    computer = api.add_computer(status="host_running")
    api.fault("admission", "drop_after", times=100)
    api.fault("status", "html502", times=100)
    assert launcher.admission(computer.computer_id) is None
    assert launcher.is_running(computer.computer_id) is None
    api.fault("keep_alive", "drop_after", times=100)
    assert launcher.keep_alive(computer.computer_id) is False


@pytest.mark.parametrize(
    "method", ["resume", "claim_start", "start_host", "provision", "terminate", "checkpoint"]
)
def test_unknown_effects_raise_a_lost_reply_never_a_refusal(
    api: FakeLauncherApi, launcher: CloudflareLauncher, method: str
) -> None:
    computer = api.add_computer(status="start_claimed", attempt=1)
    api.fault(method, "drop_after", times=100)
    calls = {
        "resume": lambda: launcher.resume(computer.computer_id),
        "claim_start": lambda: launcher.claim_start(
            computer.computer_id, operation_id=protocol.new_operation_id()
        ),
        "start_host": lambda: _start(launcher, computer.computer_id, 1),
        "provision": lambda: launcher.provision("managed-0123abcd"),
        "terminate": lambda: launcher.terminate(computer.computer_id),
        "checkpoint": lambda: launcher.checkpoint(computer.computer_id, reason="turn_completed"),
    }
    with pytest.raises(OutcomeUnknown) as caught:
        calls[method]()
    # Omnigent treats a ClickException as final; a lost reply must not look like one.
    assert not isinstance(caught.value, click.ClickException)
    assert not isinstance(caught.value, SandboxGoneError)


def test_a_lost_sleep_reply_is_unknown_and_repeating_it_learns_the_outcome(
    api: FakeLauncherApi, launcher: CloudflareLauncher
) -> None:
    computer = api.add_computer(status="host_running")
    operation_id = protocol.new_operation_id()
    api.fault("suspend", "drop_after", times=100)
    assert launcher.suspend(computer.computer_id, operation_id=operation_id) == SuspendResult(
        outcome="unknown"
    )
    api.faults.clear()
    result = launcher.suspend(computer.computer_id, operation_id=operation_id)
    assert result == SuspendResult(outcome="stopped")
    assert {r.operation_id for r in api.accepted("suspend")} == {operation_id}


def test_a_refused_sleep_says_why(api: FakeLauncherApi, launcher: CloudflareLauncher) -> None:
    api.suspend_refusal = "capture_running"
    computer = api.add_computer(status="host_running")
    result = launcher.suspend(computer.computer_id, operation_id=protocol.new_operation_id())
    assert result == SuspendResult(outcome="refused", reason="a save is running")


@pytest.mark.parametrize("code", ["unauthorized", "bad_request", "conflict", "unavailable"])
def test_any_failed_sleep_request_is_unknown_never_refused(
    api: FakeLauncherApi, launcher: CloudflareLauncher, code: str
) -> None:
    """An earlier call with the same operation may have started the stop."""
    computer = api.add_computer(status="host_running")
    api.fault("suspend", "error", code=code, times=100)
    result = launcher.suspend(computer.computer_id, operation_id=protocol.new_operation_id())
    assert result == SuspendResult(outcome="unknown")


def test_gone_is_sandbox_gone_and_only_gone(
    api: FakeLauncherApi, launcher: CloudflareLauncher
) -> None:
    removed = api.add_computer(status="host_running", removal=True)
    with pytest.raises(SandboxGoneError):
        launcher.resume(removed.computer_id)
    with pytest.raises(SandboxGoneError):
        launcher.claim_start(removed.computer_id, operation_id=protocol.new_operation_id())
    with pytest.raises(SandboxGoneError):
        launcher.checkpoint(removed.computer_id, reason="long_turn")
    launcher.terminate(removed.computer_id)  # already being removed: success
    live = api.add_computer(status="stopped")
    api.capacity = 0
    with pytest.raises(click.ClickException, match="All computers are busy") as caught:
        launcher.resume(live.computer_id)
    assert not isinstance(caught.value, SandboxGoneError)


def test_a_refused_checkpoint_is_an_ordinary_error_not_a_missing_capability(
    api: FakeLauncherApi, launcher: CloudflareLauncher
) -> None:
    computer = api.add_computer(status="stopped")
    with pytest.raises(click.ClickException, match="not running") as caught:
        launcher.checkpoint(computer.computer_id, reason="turn_completed")
    assert not isinstance(caught.value, SandboxCapabilityError)
    computer.status = "host_running"
    operation_id = launcher.checkpoint(computer.computer_id, reason="turn_completed")
    assert operation_id == api.accepted("checkpoint")[-1].operation_id


def test_terminate_succeeds_for_pending_resolved_and_absent(
    api: FakeLauncherApi, launcher: CloudflareLauncher
) -> None:
    computer = api.add_computer(status="host_running")
    launcher.terminate(computer.computer_id)
    api.removal_outcome = "resolved"
    launcher.terminate(computer.computer_id)
    launcher.terminate("cmp_" + "2" * 26)
    assert len(api.accepted("terminate")) == 3


# ── start_host's own checks ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"server_url": "https://example.test"}, "omnigent.internal"),
        ({"repos": ("repo",)}, "clone"),
        ({"start_attempt": None}, "claimed start attempt"),
        ({"host_id": "host_a1b2"}, "host ID"),
    ],
)
def test_start_host_refuses_what_a_computer_cannot_take_before_any_effect(
    api: FakeLauncherApi, launcher: CloudflareLauncher, fence: Fence, kwargs: dict, message: str
) -> None:
    computer = api.add_computer(status="start_claimed", attempt=1)
    attempt = kwargs.pop("start_attempt", 1)
    with pytest.raises(click.ClickException, match=message):
        _start(launcher, computer.computer_id, attempt, **kwargs)
    assert api.requests == [] and fence.calls == []


# ── The durability fence through the adapter ────────────────────────────────────────────


def test_blocked_replication_fails_a_start_visibly_with_no_token_sent(
    api: FakeLauncherApi, settings: LauncherSettings
) -> None:
    fence = Fence(api)
    fence.confirm = False
    launcher = _launcher(settings, fence)
    computer = api.add_computer(status="start_claimed", attempt=1)
    token = launch_token()
    with pytest.raises(click.ClickException, match="not yet replicated") as caught:
        _start(launcher, computer.computer_id, 1, token=token)
    assert token not in str(caught.value)
    with pytest.raises(click.ClickException, match="not yet replicated"):
        launcher.provision("managed-0123abcd")
    with pytest.raises(click.ClickException, match="not yet replicated"):
        launcher.terminate(computer.computer_id)
    sleep = launcher.suspend(computer.computer_id, operation_id=protocol.new_operation_id())
    assert sleep == SuspendResult(outcome="unknown")  # Omnigent repeats it once durable
    assert api.requests == [] and computer.tokens == []
    assert len(fence.calls) == 4
