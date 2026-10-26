"""Each launcher operation against the fake launcher API, over real HTTP.

Request signing (the fake verifies every signature as the Worker would), operation IDs,
timeouts, lost replies, ``gone`` only for a removed computer, readable refusals, the
durability fence before every lifecycle effect, the sleep's polling, and no login material in
the logs.
"""

from __future__ import annotations

import time
from typing import Any

import pytest
from conftest import Fence, launch_token, make_core
from fake_platform import FakeLauncherApi

from cloudflare_omnigent.sandbox import protocol
from cloudflare_omnigent.sandbox.client import OutcomeUnknown, PlatformGone, PlatformRefusal
from cloudflare_omnigent.sandbox.core import (
    DurabilityUnconfirmed,
    InvalidCall,
    LauncherCore,
    NotConfigured,
)
from cloudflare_omnigent.sandbox.settings import LauncherSettings

HOST_ID = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f"
EFFECTS = ("provision", "start_host", "suspend", "terminate")


def _claimed(api: FakeLauncherApi, core: LauncherCore) -> tuple[str, int]:
    """A computer that is up with no host yet, and a granted claim on it."""
    computer = api.add_computer(status="started_no_host", generation=1)
    claim = core.claim_start(computer.computer_id, protocol.new_operation_id())
    assert claim.granted and claim.start_attempt is not None
    return computer.computer_id, claim.start_attempt


def _start(core: LauncherCore, computer_id: str, attempt: int, token: str | None = None) -> str:
    return core.start_host(
        computer_id,
        start_attempt=attempt,
        host_id=HOST_ID,
        host_name="Work computer",
        token=token or launch_token(),
        host_config={"runner": {"idle_timeout_s": 600}},
    )


def _invoke(api: FakeLauncherApi, core: LauncherCore, operation: str) -> Any:
    """Call *operation* on a computer in a state where it succeeds."""
    if operation == "prepare":
        return core.prepare()
    if operation == "provision":
        return core.provision("managed-0123abcd")
    if operation == "start_host":
        computer_id, attempt = _claimed(api, core)
        return _start(core, computer_id, attempt)
    if operation == "claim_start":
        computer = api.add_computer(status="started_no_host")
        return core.claim_start(computer.computer_id, protocol.new_operation_id())
    computer = api.add_computer(status="host_running", generation=2)
    cid = computer.computer_id
    if operation == "checkpoint":
        return core.checkpoint(cid, "turn_completed")
    if operation == "suspend":
        return core.suspend(cid, protocol.new_operation_id())
    return getattr(core, operation)(cid)


# ── Signing and operation IDs ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("operation", protocol.OPERATIONS)
def test_every_operation_is_signed_and_accepted_by_the_receiver(
    api: FakeLauncherApi, core: LauncherCore, operation: str
) -> None:
    _invoke(api, core, operation)
    sent = [r for r in api.requests if r.operation == operation]
    assert sent and all(r.status == 200 for r in sent)
    assert all(r.key_id == api.key_id for r in sent)
    for record in sent:
        assert protocol.is_operation_id(record.operation_id)
        assert record.body is not None and record.body["protocolVersion"] == 1


def test_a_wrong_key_is_a_readable_refusal_never_repeated(api: FakeLauncherApi) -> None:
    settings = LauncherSettings(
        signing_key=b"w" * 32, signing_key_id=api.key_id, base_url=api.base_url
    )
    core = make_core(settings, Fence())
    with pytest.raises(PlatformRefusal) as caught:
        core.resume(api.add_computer().computer_id)
    assert caught.value.code == "unauthorized"
    assert len(api.requests) == 1 and api.requests[0].status == 401


def test_an_unknown_key_id_is_refused_too(api: FakeLauncherApi) -> None:
    settings = LauncherSettings(signing_key=api.key, signing_key_id="old", base_url=api.base_url)
    with pytest.raises(PlatformRefusal):
        make_core(settings, Fence()).prepare()


def test_a_clock_more_than_300_s_off_is_refused(api: FakeLauncherApi, core: LauncherCore) -> None:
    api.clock = lambda: time.time() + 301
    with pytest.raises(PlatformRefusal) as caught:
        core.prepare()
    assert caught.value.code == "unauthorized"


def test_launcher_minted_ids_are_fresh_per_call(api: FakeLauncherApi, core: LauncherCore) -> None:
    computer = api.add_computer(status="host_running")
    for _ in range(3):
        core.keep_alive(computer.computer_id)
    ids = [r.operation_id for r in api.accepted("keep_alive")]
    assert len(set(ids)) == 3


def test_omnigents_ids_are_passed_through(api: FakeLauncherApi, core: LauncherCore) -> None:
    computer = api.add_computer(status="started_no_host")
    claim_id, sleep_id = protocol.new_operation_id(), protocol.new_operation_id()
    core.claim_start(computer.computer_id, claim_id)
    computer.status = "host_running"
    core.suspend(computer.computer_id, sleep_id)
    assert [r.operation_id for r in api.accepted("claim_start")] == [claim_id]
    assert {r.operation_id for r in api.accepted("suspend")} == {sleep_id}


# ── Lost replies and timeouts ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("operation", protocol.OPERATIONS)
def test_a_lost_reply_is_repeated_with_the_same_operation_and_one_effect(
    api: FakeLauncherApi, core: LauncherCore, operation: str
) -> None:
    api.fault(operation, "drop_after")
    first = _invoke(api, core, operation)
    sent = [r for r in api.requests if r.operation == operation]
    assert [r.fault for r in sent] == ["drop_after", None]
    assert sent[0].body == sent[1].body  # same operation ID, same bytes
    if operation == "claim_start":
        # The repeat returned the recorded claim, not a second one.
        assert first.start_attempt == 1 == api.computer(sent[0].computer_id).attempt
    if operation == "provision":
        assert len(api.computers) == 1


@pytest.mark.parametrize("operation", protocol.OPERATIONS)
def test_replies_that_never_come_end_in_an_unknown_outcome(
    api: FakeLauncherApi, core: LauncherCore, operation: str
) -> None:
    api.fault(operation, "drop_after", times=100)
    started = time.monotonic()
    with pytest.raises(OutcomeUnknown):
        _invoke(api, core, operation)
    assert time.monotonic() - started < 4
    sent = [r for r in api.requests if r.operation == operation]
    assert len(sent) >= 2 and len({r.operation_id for r in sent}) == 1


def test_a_reply_slower_than_the_attempt_is_repeated(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    computer = api.add_computer(status="started_no_host")
    api.fault("claim_start", "delay", delay_s=1.3)
    claim = core.claim_start(computer.computer_id, protocol.new_operation_id())
    assert claim.granted and claim.start_attempt == 1
    assert computer.attempt == 1  # the late first attempt and the repeat are one claim


@pytest.mark.parametrize("kind", ["garbage", "html502", "extra_field", "drop_before"])
def test_unreadable_answers_are_repeated_until_readable(
    api: FakeLauncherApi, core: LauncherCore, kind: str
) -> None:
    computer = api.add_computer(status="host_running", generation=4)
    api.fault("status", kind)
    assert core.status(computer.computer_id) == protocol.StatusResult(True, "host_running", 4)
    assert len(api.accepted("status")) == 2


# ── Error codes ─────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("code", sorted(protocol.ERROR_CLASS))
def test_each_error_code_is_handled_by_its_class(
    api: FakeLauncherApi, core: LauncherCore, code: str
) -> None:
    computer = api.add_computer(status="stopped")
    api.fault("resume", "error", code=code, message="Synthetic refusal.", times=100)
    expected = {
        "sandbox_gone": PlatformGone,
        "readable_refusal": PlatformRefusal,
        "unknown_outcome": OutcomeUnknown,
    }[protocol.ERROR_CLASS[code]]
    with pytest.raises(expected):
        core.resume(computer.computer_id)
    sent = [r for r in api.requests if r.operation == "resume"]
    if expected is OutcomeUnknown:
        assert len(sent) >= 2  # repeated with the same operation
    else:
        assert len(sent) == 1  # final: never repeated
    assert computer.generation == 0  # no effect happened


def test_at_capacity_is_a_readable_refusal_with_the_platforms_words(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    api.capacity = 1
    api.add_computer(status="host_running")
    sleeping = api.add_computer(status="stopped")
    with pytest.raises(PlatformRefusal, match="All computers are busy") as caught:
        core.resume(sleeping.computer_id)
    assert caught.value.code == "at_capacity"
    assert sleeping.status == "stopped"


@pytest.mark.parametrize(
    "operation", ["resume", "claim_start", "start_host", "checkpoint", "suspend"]
)
def test_gone_only_for_a_computer_with_a_removal_intent(
    api: FakeLauncherApi, core: LauncherCore, operation: str
) -> None:
    computer = api.add_computer(status="started_no_host", removal=True)
    cid = computer.computer_id
    calls = {
        "resume": lambda: core.resume(cid),
        "claim_start": lambda: core.claim_start(cid, protocol.new_operation_id()),
        "start_host": lambda: _start(core, cid, 1),
        "checkpoint": lambda: core.checkpoint(cid, "long_turn"),
        "suspend": lambda: core.suspend(cid, protocol.new_operation_id()),
    }
    with pytest.raises(PlatformGone):
        calls[operation]()


def test_a_computer_that_exists_never_answers_gone(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    """Every other answer, including refusals, leaves a live computer alone."""
    computer = api.add_computer(status="host_running")
    cid = computer.computer_id
    assert core.status(cid).running
    assert core.admission(cid).result.admitting
    assert core.keep_alive(cid).renewed
    assert core.claim_start(cid, protocol.new_operation_id()) == protocol.ClaimStartResult(
        granted=False, status="host_running"
    )
    with pytest.raises(PlatformRefusal):  # a superseded start is a conflict, never gone
        _start(core, cid, 7)


def test_an_unknown_computer_is_not_found_never_gone(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    with pytest.raises(PlatformRefusal) as caught:
        core.resume("cmp_" + "0" * 26)
    assert caught.value.code == "not_found"


# ── The durability fence (FH-25, FH-29, R-23) ───────────────────────────────────────────


@pytest.mark.parametrize("operation", EFFECTS)
@pytest.mark.parametrize("mode", ["unconfirmed", "raises", "missing"])
def test_without_durability_nothing_is_sent_and_no_token_published(
    api: FakeLauncherApi, settings: LauncherSettings, operation: str, mode: str
) -> None:
    computer = api.add_computer(status="start_claimed", attempt=1)
    fence = None if mode == "missing" else Fence(api)
    if fence is not None:
        fence.confirm = False
        if mode == "raises":
            fence.raises = TimeoutError("the socket hung")
    core = make_core(settings, fence)
    token = launch_token()
    calls = {
        "provision": lambda: core.provision("managed-0123abcd"),
        "start_host": lambda: _start(core, computer.computer_id, 1, token),
        "suspend": lambda: core.suspend(computer.computer_id, protocol.new_operation_id()),
        "terminate": lambda: core.terminate(computer.computer_id),
    }
    expected = NotConfigured if mode == "missing" else DurabilityUnconfirmed
    with pytest.raises(expected):
        calls[operation]()
    assert api.requests == []
    assert computer.tokens == [] and not computer.removal and computer.status == "start_claimed"


@pytest.mark.parametrize("operation", EFFECTS)
def test_the_fence_runs_before_the_first_request_with_its_timeout(
    api: FakeLauncherApi, core: LauncherCore, fence: Fence, operation: str
) -> None:
    _invoke(api, core, operation)
    sent = [r for r in api.requests if r.operation == operation]
    # The fence ran once for the effect, before the effect's own request.
    fenced_at = fence.requests_seen[-1]
    assert api.requests.index(sent[0]) == fenced_at
    assert fence.calls[-1] == 10.0


@pytest.mark.parametrize(
    "operation",
    ["prepare", "claim_start", "resume", "keep_alive", "status", "admission", "checkpoint"],
)
def test_other_operations_never_wait_for_durability(
    api: FakeLauncherApi, core: LauncherCore, fence: Fence, operation: str
) -> None:
    _invoke(api, core, operation)
    assert fence.calls == []


def test_a_retried_effect_waits_once(
    api: FakeLauncherApi, core: LauncherCore, fence: Fence
) -> None:
    api.fault("terminate", "drop_after")
    computer = api.add_computer(status="host_running")
    core.terminate(computer.computer_id)
    assert len(fence.calls) == 1 and len(api.accepted("terminate")) == 2


# ── Operation semantics ─────────────────────────────────────────────────────────────────


def test_provision_is_idempotent_by_name(api: FakeLauncherApi, core: LauncherCore) -> None:
    first = core.provision("managed-0123abcd")
    assert core.provision("managed-0123abcd") == first
    assert core.provision("managed-89abcdef") != first
    assert protocol.is_computer_id(first)


def test_start_host_carries_the_attempt_identity_token_and_config(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    computer_id, attempt = _claimed(api, core)
    token = launch_token()
    assert _start(core, computer_id, attempt, token) == "/home/omnigent/work"
    (sent,) = api.accepted("start_host")
    assert sent.body is not None
    assert sent.body["startAttempt"] == attempt
    assert sent.body["hostId"] == HOST_ID
    assert sent.body["token"] == token
    assert sent.body["hostConfig"] == {"runner": {"idle_timeout_s": 600}}
    assert api.computer(computer_id).status == "host_running"


def test_a_start_for_a_superseded_attempt_is_refused(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    computer_id, first = _claimed(api, core)
    second = core.claim_start(computer_id, protocol.new_operation_id())
    assert second.start_attempt == first + 1
    with pytest.raises(PlatformRefusal) as caught:
        _start(core, computer_id, first)
    assert caught.value.code == "conflict"
    assert api.computer(computer_id).tokens == []


def test_resume_reports_its_outcome_and_generation(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    computer = api.add_computer(status="stopped", generation=4)
    assert core.resume(computer.computer_id) == protocol.ResumeResult("starting", 5)
    assert core.resume(computer.computer_id) == protocol.ResumeResult("running", 5)


def test_admission_is_never_cached_and_dated_when_asked(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    computer = api.add_computer(status="host_running", generation=3)
    before = time.time()
    first = core.admission(computer.computer_id)
    after = time.time()
    assert first.result == protocol.AdmissionResult(True, "host_running", 3)
    assert before <= first.observed_at <= after
    assert first.observed_at <= api.accepted("admission")[0].at
    computer.admitting = False
    second = core.admission(computer.computer_id)
    assert second.result.admitting is False and second.result.reason == "not_saved"
    assert len(api.accepted("admission")) == 2


def test_a_failed_admission_refresh_is_unknown_and_the_next_one_asks_again(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    computer = api.add_computer(status="host_running")
    api.fault("admission", "html502", times=100)
    with pytest.raises(OutcomeUnknown):
        core.admission(computer.computer_id)
    api.faults.clear()
    assert core.admission(computer.computer_id).result.admitting


def test_checkpoint_returns_the_operation_it_is_recorded_under(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    computer = api.add_computer(status="host_running")
    result, operation_id = core.checkpoint(computer.computer_id, "turn_completed")
    assert result == protocol.CheckpointResult("accepted", folded=False)
    assert api.accepted("checkpoint")[0].operation_id == operation_id
    folded, _ = core.checkpoint(computer.computer_id, "long_turn")
    assert folded.folded is True
    computer.status = "stopped"
    refused, _ = core.checkpoint(computer.computer_id, "turn_completed")
    assert refused == protocol.CheckpointResult("refused", reason="not_running")


def test_suspend_follows_the_sleep_until_it_is_stopped(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    api.suspend_polls = 3
    computer = api.add_computer(status="host_running")
    operation_id = protocol.new_operation_id()
    assert core.suspend(computer.computer_id, operation_id) == protocol.SuspendResult("stopped")
    sent = api.accepted("suspend")
    assert len(sent) == 4 and {r.operation_id for r in sent} == {operation_id}
    assert computer.status == "stopped"


def test_suspend_past_its_budget_is_unknown_and_a_repeat_learns_the_outcome(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    api.suspend_polls = 1000
    computer = api.add_computer(status="host_running")
    operation_id = protocol.new_operation_id()
    with pytest.raises(OutcomeUnknown):
        core.suspend(computer.computer_id, operation_id)
    assert computer.status == "stopping"
    computer.stop_polls_left = 0
    assert core.suspend(computer.computer_id, operation_id).outcome == "stopped"


def test_a_refused_sleep_stops_nothing(api: FakeLauncherApi, core: LauncherCore) -> None:
    api.suspend_refusal = "terminal_open"
    computer = api.add_computer(status="host_running")
    result = core.suspend(computer.computer_id, protocol.new_operation_id())
    assert result == protocol.SuspendResult("refused", reason="terminal_open")
    assert computer.status == "host_running"


def test_terminate_is_idempotent_without_an_operation_id(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    computer = api.add_computer(status="host_running")
    assert core.terminate(computer.computer_id).removal == "pending"
    assert core.terminate(computer.computer_id).removal == "pending"
    sent = api.accepted("terminate")
    assert len({r.operation_id for r in sent}) == 2 and computer.removal
    assert core.terminate("cmp_" + "1" * 26).removal == "absent"


def test_prepare_refuses_a_platform_without_our_protocol_version(
    api: FakeLauncherApi, core: LauncherCore
) -> None:
    assert core.prepare().supported_protocol_versions == (1,)
    api.supported_versions = [2]  # the request's version 1 is refused before any effect
    with pytest.raises(PlatformRefusal) as caught:
        core.prepare()
    assert caught.value.code == "unsupported_version"


def test_prepare_refuses_an_answer_that_omits_our_version(
    api: FakeLauncherApi, core: LauncherCore, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = api._apply

    def answer(body: dict[str, Any]) -> Any:
        result, hooks = original(body)
        return ({**result, "supportedProtocolVersions": [2, 3]}, hooks)

    monkeypatch.setattr(api, "_apply", answer)
    with pytest.raises(PlatformRefusal, match="2, 3"):
        core.prepare()


# ── Configuration and inputs ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("operation", protocol.OPERATIONS)
def test_an_unconfigured_launcher_refuses_everything_and_sends_nothing(
    api: FakeLauncherApi, operation: str
) -> None:
    core = make_core(None, Fence(api))
    with pytest.raises(NotConfigured, match="CFO_LAUNCHER_SIGNING_KEY"):
        _invoke(api, core, operation)
    assert api.requests == []


@pytest.mark.parametrize(
    "call",
    [
        lambda core: core.provision("Managed_Host"),
        lambda core: core.claim_start("cmp_01hzy3m8k6q4t2v9w7x5r0s1n3", "op_1"),
        lambda core: core.resume("sb-not-ours"),
        lambda core: core.checkpoint("cmp_01hzy3m8k6q4t2v9w7x5r0s1n3", "whenever"),
        lambda core: _start(core, "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3", 0),
        lambda core: core.start_host(
            "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3",
            start_attempt=1,
            host_id="host_a1b2",
            host_name="x",
            token=launch_token(),
            host_config={},
        ),
        lambda core: core.start_host(
            "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3",
            start_attempt=1,
            host_id=HOST_ID,
            host_name="x",
            token="short",
            host_config={},
        ),
    ],
)
def test_inputs_the_contract_cannot_carry_are_refused_before_sending(
    api: FakeLauncherApi, core: LauncherCore, fence: Fence, call: Any
) -> None:
    with pytest.raises(InvalidCall):
        call(core)
    assert api.requests == [] and fence.calls == []


# ── No login material in logs or errors (RC-22) ─────────────────────────────────────────


def test_no_token_key_or_signature_reaches_the_logs(
    api: FakeLauncherApi, settings: LauncherSettings, launcher_logs: pytest.LogCaptureFixture
) -> None:
    core = make_core(settings, Fence(api))
    token = launch_token()
    computer_id, attempt = _claimed(api, core)
    api.fault("start_host", "drop_after")
    _start(core, computer_id, attempt, token)
    api.fault("start_host", "error", code="conflict", message="Refused.")
    with pytest.raises(PlatformRefusal) as caught:
        _start(core, computer_id, attempt, token)
    text = launcher_logs.text + str(caught.value)
    assert launcher_logs.records
    assert token not in text
    assert settings.signing_key.decode() not in text
    signatures = {r.body and r.body.get("token") for r in api.requests}
    assert token in signatures  # it did reach the platform, and only there


# ── Codex review r1: reflected secrets, status/code pairs, integral numbers, the budget ─


def test_a_reply_reflecting_the_token_never_puts_it_in_logs_or_errors(
    api: FakeLauncherApi, settings: LauncherSettings, launcher_logs: pytest.LogCaptureFixture
) -> None:
    core = make_core(settings, Fence(api))
    token = launch_token()
    computer_id, attempt = _claimed(api, core)
    api.fault("start_host", "extra_field", field=token, times=100)
    with pytest.raises(OutcomeUnknown) as unknown:
        _start(core, computer_id, attempt, token)
    api.faults.clear()
    api.fault("start_host", "error", code="conflict", message=f"Refused start for {token}.")
    with pytest.raises(PlatformRefusal) as refused:
        _start(core, computer_id, attempt, token)
    assert "[redacted]" in str(refused.value)
    text = launcher_logs.text + str(unknown.value) + str(refused.value)
    assert token not in text


@pytest.mark.parametrize(
    ("code", "status"),
    [("gone", 503), ("gone", 200), ("at_capacity", 500), ("unauthorized", 503), ("gone", 409)],
)
def test_an_error_code_with_the_wrong_status_is_never_final(
    api: FakeLauncherApi, core: LauncherCore, code: str, status: int
) -> None:
    computer = api.add_computer(status="host_running")
    api.fault("terminate", "error", code=code, status=status, times=100)
    with pytest.raises(OutcomeUnknown):
        core.terminate(computer.computer_id)
    assert len([r for r in api.requests if r.operation == "terminate"]) >= 2


def test_the_declared_status_makes_gone_final(api: FakeLauncherApi, core: LauncherCore) -> None:
    computer = api.add_computer(status="host_running")
    api.fault("terminate", "error", code="gone", message="Removed.")
    with pytest.raises(PlatformGone):
        core.terminate(computer.computer_id)
    assert len([r for r in api.requests if r.operation == "terminate"]) == 1


def test_no_attempt_runs_past_the_call_budget() -> None:
    """Deterministic clock: each attempt times out after exactly the time it was given."""
    from cloudflare_omnigent.sandbox.client import CallPolicy, LauncherClient

    now = [1000.0]
    given: list[float] = []

    def post(url: str, headers: Any, body: bytes, timeout: float) -> tuple[int, bytes]:
        given.append(timeout)
        now[0] += timeout
        raise TimeoutError("no reply")

    def sleep(seconds: float) -> None:
        now[0] += seconds

    settings = LauncherSettings(signing_key=b"k" * 32, signing_key_id="k1")
    client = LauncherClient(
        settings, post=post, clock=lambda: now[0], monotonic=lambda: now[0], sleep=sleep
    )
    for budget in (1.3, 0.3, 2.0, 5.0):
        given.clear()
        started = now[0]
        with pytest.raises(OutcomeUnknown):
            client.call(
                protocol.status_request("0" * 31 + "1", "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3"),
                CallPolicy(attempt_timeout_s=1.0, budget_s=budget),
            )
        assert now[0] - started <= budget + 1e-9, (budget, given)
        assert given and all(t > 0 for t in given)


# ── Codex review r2: the budget holds through oversleeping backoffs and suspend polls ──


class _Clock:
    """A deterministic clock whose sleeps can oversleep, and a post that uses its timeout."""

    def __init__(self, oversleep_s: float = 0.0, reply: bytes | None = None) -> None:
        self.now = 1000.0
        self.oversleep_s = oversleep_s
        self.reply = reply
        self.starts: list[tuple[float, float]] = []  # (when, timeout) of each attempt

    def sleep(self, seconds: float) -> None:
        self.now += seconds + self.oversleep_s

    def post(self, url: str, headers: Any, body: bytes, timeout: float) -> tuple[int, bytes]:
        self.starts.append((self.now, timeout))
        if self.reply is None:
            self.now += timeout
            raise TimeoutError("no reply")
        self.now += 0.01
        return 200, self.reply


@pytest.mark.parametrize("oversleep_s", [0.0, 0.2, 0.9])
@pytest.mark.parametrize("budget_s", [0.3, 1.03, 1.4, 3.0])
def test_no_attempt_starts_or_runs_after_the_deadline_even_when_backoff_oversleeps(
    oversleep_s: float, budget_s: float
) -> None:
    from cloudflare_omnigent.sandbox.client import CallPolicy, LauncherClient

    clock = _Clock(oversleep_s)
    settings = LauncherSettings(signing_key=b"k" * 32, signing_key_id="k1")
    client = LauncherClient(
        settings,
        post=clock.post,
        clock=lambda: clock.now,
        monotonic=lambda: clock.now,
        sleep=clock.sleep,
    )
    started = clock.now
    with pytest.raises(OutcomeUnknown):
        client.call(
            protocol.status_request("0" * 31 + "1", "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3"),
            CallPolicy(attempt_timeout_s=1.0, budget_s=budget_s),
        )
    deadline = started + budget_s
    assert clock.starts
    for when, timeout in clock.starts:
        assert when < deadline and when + timeout <= deadline + 1e-9


def test_suspend_polls_never_run_past_the_suspend_budget() -> None:
    from cloudflare_omnigent.sandbox.client import CallPolicy, LauncherClient

    clock = _Clock(reply=b'{"operation":"suspend","outcome":"in_progress"}')
    settings = LauncherSettings(signing_key=b"k" * 32, signing_key_id="k1")
    client = LauncherClient(
        settings,
        post=clock.post,
        clock=lambda: clock.now,
        monotonic=lambda: clock.now,
        sleep=clock.sleep,
    )
    policies = {op: CallPolicy(1.0, 1.03) for op in protocol.OPERATIONS}
    core = LauncherCore(
        settings,
        lambda _t: True,
        client=client,
        policies=policies,
        suspend_poll_s=0.25,
        monotonic=lambda: clock.now,
        sleep=clock.sleep,
    )
    started = clock.now
    with pytest.raises(OutcomeUnknown):
        core.suspend("cmp_01hzy3m8k6q4t2v9w7x5r0s1n3", "0" * 31 + "3")
    assert clock.now - started <= 1.03 + 1e-9
    assert all(when + timeout <= started + 1.03 + 1e-9 for when, timeout in clock.starts)
