"""The launcher's operations, without Omnigent: operation IDs, the durability fence, budgets.

:class:`LauncherCore` makes one launcher API call per Omnigent call (``suspend`` polls while the
sleep is in progress) and returns the contract's results or raises the client's errors. The
Omnigent adapter (:mod:`cloudflare_omnigent.sandbox.launcher`) maps both onto Omnigent's types
and exceptions. Keeping the logic here lets the plain test environment exercise every method
against a fake launcher API, without an Omnigent build.

**Operation IDs.** ``claim_start`` and ``suspend`` use the ID Omnigent passes. Every other call
gets a fresh ``uuid4().hex`` here, one per Omnigent call, reused for every retry of that call.

**The durability fence** (design, "Lifecycle effects wait for durability in the launcher").
Before ``provision``, ``start_host``, ``suspend`` and ``terminate`` send anything, the core
waits until the database as it stood when the call began is replicated, through the
``durability_wait`` the embedding application supplies (the server image passes Litestream's
``wait_replicated_blocking``). If it is not confirmed in time, the call fails before any
request: no computer is created or removed, no sleep starts, and no launch token is published
on a write that could still be lost (FH-25, FH-29, R-23). Without a fence, these calls refuse.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from cloudflare_omnigent.sandbox import protocol
from cloudflare_omnigent.sandbox.client import (
    CallPolicy,
    LauncherClient,
    LauncherError,
    OutcomeUnknown,
    PlatformRefusal,
    Reply,
)
from cloudflare_omnigent.sandbox.settings import LauncherSettings

logger = logging.getLogger("cloudflare_omnigent.sandbox")

#: ``durability_wait(timeout_s)``: True once every commit made before the call is replicated.
DurabilityWait = Callable[[float], bool]


class NotConfigured(LauncherError):
    """The launcher has no signing key, or no durability fence for a lifecycle effect."""


class DurabilityUnconfirmed(LauncherError):
    """The database did not replicate in time; the call made no platform effect."""


class InvalidCall(LauncherError):
    """Omnigent passed something the launcher API cannot carry; nothing was sent."""


#: Per-operation budgets. Reads are short (Omnigent asks again); effects get more room for
#: lost replies, inside Omnigent's 240 s online wait.
POLICIES: Mapping[protocol.Operation, CallPolicy] = {
    "prepare": CallPolicy(attempt_timeout_s=10.0, budget_s=20.0),
    "provision": CallPolicy(attempt_timeout_s=10.0, budget_s=30.0),
    "claim_start": CallPolicy(attempt_timeout_s=10.0, budget_s=20.0),
    "start_host": CallPolicy(attempt_timeout_s=10.0, budget_s=30.0),
    "resume": CallPolicy(attempt_timeout_s=30.0, budget_s=60.0),
    "keep_alive": CallPolicy(attempt_timeout_s=10.0, budget_s=15.0),
    "status": CallPolicy(attempt_timeout_s=10.0, budget_s=10.0),
    "admission": CallPolicy(attempt_timeout_s=10.0, budget_s=10.0),
    "checkpoint": CallPolicy(attempt_timeout_s=10.0, budget_s=20.0),
    "suspend": CallPolicy(attempt_timeout_s=15.0, budget_s=60.0),
    "terminate": CallPolicy(attempt_timeout_s=10.0, budget_s=30.0),
}
#: How often an ``in_progress`` sleep is asked again.
SUSPEND_POLL_S = 2.0

_NOT_CONFIGURED = (
    "Cloud computers are not configured on this server: the launcher's signing key "
    "(CFO_LAUNCHER_SIGNING_KEY and CFO_LAUNCHER_SIGNING_KEY_ID) is not set."
)


@dataclass(frozen=True)
class Admission:
    """An admission answer and the wall-clock time its request was sent."""

    result: protocol.AdmissionResult
    observed_at: float


class LauncherCore:
    """The eleven launcher API operations, one method each.

    :param settings: The launcher's settings, or ``None`` when it is not configured.
    :param durability_wait: The replication fence for lifecycle effects, or ``None``.
    """

    def __init__(
        self,
        settings: LauncherSettings | None,
        durability_wait: DurabilityWait | None,
        *,
        client: LauncherClient | None = None,
        policies: Mapping[protocol.Operation, CallPolicy] | None = None,
        suspend_poll_s: float | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._settings = settings
        self._durability_wait = durability_wait
        if client is None and settings is not None:
            client = LauncherClient(settings)
        self._client = client
        self._policies = policies if policies is not None else POLICIES
        self._suspend_poll_s = suspend_poll_s if suspend_poll_s is not None else SUSPEND_POLL_S
        self._monotonic = monotonic
        self._sleep = sleep

    # ── plumbing ────────────────────────────────────────────────────────────────────────

    def _send(self, request: Mapping[str, Any], *, budget_s: float | None = None) -> Reply:
        if self._client is None:
            raise NotConfigured(_NOT_CONFIGURED)
        policy = self._policies[request["operation"]]
        if budget_s is not None:
            policy = CallPolicy(policy.attempt_timeout_s, budget_s)
        return self._client.call(request, policy)

    def _build(self, builder: Callable[..., dict[str, Any]], *args: Any, **kwargs: Any) -> dict:
        if self._client is None:
            raise NotConfigured(_NOT_CONFIGURED)
        try:
            return builder(*args, **kwargs)
        except protocol.ProtocolError as exc:
            raise InvalidCall(f"The launcher cannot send this request: {exc}.") from None

    def _fence(self, operation: protocol.Operation) -> None:
        """Wait for the database to replicate before *operation* has any platform effect."""
        assert protocol.OPERATION_RULES[operation].durability_wait
        if self._durability_wait is None:
            raise NotConfigured(
                f"The launcher has no durability fence, so it never sends {operation}."
            )
        timeout = self._settings.durability_timeout_s if self._settings is not None else 10.0
        started = self._monotonic()
        try:
            confirmed = bool(self._durability_wait(timeout))
        except Exception as exc:  # noqa: BLE001 - an unanswered wait is "not confirmed"
            logger.warning("durability wait before %s failed: %s", operation, type(exc).__name__)
            confirmed = False
        elapsed_ms = round((self._monotonic() - started) * 1000)
        if not confirmed:
            logger.warning(
                "durability not confirmed within %gs before %s; nothing sent", timeout, operation
            )
            raise DurabilityUnconfirmed(
                f"The server's latest changes are not yet replicated, so {operation} was not "
                "sent. Try again shortly."
            )
        logger.debug("durability confirmed before %s in %d ms", operation, elapsed_ms)

    # ── operations ──────────────────────────────────────────────────────────────────────

    def prepare(self) -> protocol.PrepareResult:
        """Check the key and the protocol version: the platform must support ours."""
        request = self._build(protocol.prepare_request, protocol.new_operation_id())
        result = self._send(request).result
        assert isinstance(result, protocol.PrepareResult)
        if protocol.PROTOCOL_VERSION not in result.supported_protocol_versions:
            raise _unsupported(result.supported_protocol_versions)
        return result

    def provision(self, name: str) -> str:
        """Record a computer for Omnigent's stable host name; return its computer ID."""
        request = self._build(protocol.provision_request, protocol.new_operation_id(), name)
        self._fence("provision")
        result = self._send(request).result
        assert isinstance(result, protocol.ProvisionResult)
        return result.computer_id

    def claim_start(self, computer_id: str, operation_id: str) -> protocol.ClaimStartResult:
        """The fence before any re-arm, under Omnigent's operation ID."""
        request = self._build(protocol.claim_start_request, operation_id, computer_id)
        result = self._send(request).result
        assert isinstance(result, protocol.ClaimStartResult)
        return result

    def start_host(
        self,
        computer_id: str,
        *,
        start_attempt: int,
        host_id: str,
        host_name: str,
        token: str,
        host_config: Mapping[str, object],
    ) -> str:
        """Hand attempt N's start parameters to the platform; return the workspace path.

        The token leaves the server only after the fence: its re-arm is durable first.
        """
        request = self._build(
            protocol.start_host_request,
            protocol.new_operation_id(),
            computer_id,
            start_attempt=start_attempt,
            host_id=host_id,
            host_name=host_name,
            token=token,
            host_config=host_config,
        )
        self._fence("start_host")
        result = self._send(request).result
        assert isinstance(result, protocol.StartHostResult)
        return result.workspace_path

    def resume(self, computer_id: str) -> protocol.ResumeResult:
        request = self._build(protocol.resume_request, protocol.new_operation_id(), computer_id)
        result = self._send(request).result
        assert isinstance(result, protocol.ResumeResult)
        return result

    def keep_alive(self, computer_id: str) -> protocol.KeepAliveResult:
        request = self._build(protocol.keep_alive_request, protocol.new_operation_id(), computer_id)
        result = self._send(request).result
        assert isinstance(result, protocol.KeepAliveResult)
        return result

    def status(self, computer_id: str) -> protocol.StatusResult:
        request = self._build(protocol.status_request, protocol.new_operation_id(), computer_id)
        result = self._send(request).result
        assert isinstance(result, protocol.StatusResult)
        return result

    def admission(self, computer_id: str) -> Admission:
        """The typed status and admission, never cached here.

        ``observed_at`` is when the request that got the answer was sent: the state it reports
        is at least that recent, so Omnigent's 60 s age limit is never overstated.
        """
        request = self._build(protocol.admission_request, protocol.new_operation_id(), computer_id)
        reply = self._send(request)
        assert isinstance(reply.result, protocol.AdmissionResult)
        return Admission(result=reply.result, observed_at=reply.sent_at)

    def checkpoint(self, computer_id: str, reason: str) -> tuple[protocol.CheckpointResult, str]:
        """Ask for a save; return the answer and the operation ID it is recorded under."""
        operation_id = protocol.new_operation_id()
        request = self._build(protocol.checkpoint_request, operation_id, computer_id, reason)
        result = self._send(request).result
        assert isinstance(result, protocol.CheckpointResult)
        return result, operation_id

    def suspend(self, computer_id: str, operation_id: str) -> protocol.SuspendResult:
        """Start the sleep under Omnigent's operation ID, and follow it while it runs.

        Returns ``refused`` or ``stopped``. While the platform answers ``in_progress`` the same
        operation is asked again, until the suspend budget runs out.

        :raises OutcomeUnknown: Still in progress, or no readable answer, within the budget.
        """
        request = self._build(protocol.suspend_request, operation_id, computer_id)
        self._fence("suspend")
        deadline = self._monotonic() + self._policies["suspend"].budget_s
        while True:
            remaining = deadline - self._monotonic()
            result = self._send(request, budget_s=max(remaining, 0.0)).result
            assert isinstance(result, protocol.SuspendResult)
            if result.outcome != "in_progress":
                logger.info(
                    "launcher suspend %s for %s: %s%s",
                    operation_id,
                    computer_id,
                    result.outcome,
                    f" ({result.reason})" if result.reason else "",
                )
                return result
            if self._monotonic() + self._suspend_poll_s >= deadline:
                raise OutcomeUnknown(
                    "The computer is still going to sleep; its outcome is not known yet."
                )
            self._sleep(self._suspend_poll_s)

    def terminate(self, computer_id: str) -> protocol.TerminateResult:
        """Record the removal intent. Idempotent by meaning: each call has its own ID."""
        request = self._build(protocol.terminate_request, protocol.new_operation_id(), computer_id)
        self._fence("terminate")
        result = self._send(request).result
        assert isinstance(result, protocol.TerminateResult)
        return result


def _unsupported(versions: tuple[int, ...]) -> PlatformRefusal:
    listed = ", ".join(str(v) for v in versions)
    return PlatformRefusal(
        "unsupported_version",
        f"The platform supports launcher protocol versions {listed}, not "
        f"{protocol.PROTOCOL_VERSION}: deploy matching versions of the server and the platform.",
    )
