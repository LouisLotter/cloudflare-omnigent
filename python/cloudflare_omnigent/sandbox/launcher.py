"""The Cloudflare launcher: Omnigent's ``SandboxHostLauncher`` for cloud computers.

Each method is one launcher API call on ``platform.internal`` (see :mod:`.core`). A computer's
``sandbox_id`` is the platform's computer ID, so one WorkspaceDO serves one host row. The
methods are synchronous: Omnigent calls them in worker threads.

How the platform's answers reach Omnigent (core change 13; ``LAUNCHER_ERROR_CLASS``):

- ``gone`` raises :class:`SandboxGoneError`, and nothing else does: upstream answers that error
  by giving up on the sandbox, so a computer that still exists never raises it.
- A final refusal raises :class:`click.ClickException` with the platform's message, which
  Omnigent shows, for example "All computers are busy". So does a durability fence that did not
  confirm in time: the effect was never sent.
- An unknown outcome (a lost reply, a timeout, the platform unavailable) raises an ordinary
  exception, which Omnigent treats as a lost reply and repeats; the read-only methods answer
  ``None`` ("cannot tell") instead, and ``suspend`` answers ``unknown``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import ClassVar

import click
from omnigent.onboarding.sandboxes.base import SandboxGoneError, SandboxHostLauncher
from omnigent.onboarding.sandboxes.types import (
    AdmissionReport,
    CheckpointReason,
    RepoWorkspace,
    StartClaim,
    SuspendResult,
)

from cloudflare_omnigent.sandbox import protocol
from cloudflare_omnigent.sandbox.client import OutcomeUnknown, PlatformGone, PlatformRefusal
from cloudflare_omnigent.sandbox.core import (
    DurabilityUnconfirmed,
    DurabilityWait,
    InvalidCall,
    LauncherCore,
    NotConfigured,
)
from cloudflare_omnigent.sandbox.settings import LauncherSettings

logger = logging.getLogger("cloudflare_omnigent.sandbox")

PROVIDER = "cloudflare"

#: Person-readable reasons for a refused sleep (``SuspendRefusal``); Omnigent logs them.
SUSPEND_REFUSAL_TEXT = {
    "restoring": "the computer is still restoring",
    "capture_running": "a save is running",
    "terminal_open": "the setup terminal is open",
    "runner_processes": "agent processes are still running",
    "checkpoint_failed": "the sleep's save failed",
    "credentials_unpublished": "the sign-ins could not be saved",
}
CHECKPOINT_REFUSAL_TEXT = {
    "not_running": "the computer is not running",
    "restoring": "the computer is still restoring",
    "stopping": "the computer is going to sleep",
}


@contextmanager
def _omnigent_errors() -> Iterator[None]:
    """Raise the launcher's failures as the exceptions Omnigent expects."""
    try:
        yield
    except PlatformGone as exc:
        raise SandboxGoneError(str(exc)) from None
    except (PlatformRefusal, DurabilityUnconfirmed, NotConfigured, InvalidCall) as exc:
        raise click.ClickException(str(exc)) from None


class CloudflareLauncher(SandboxHostLauncher):
    """Omnigent's provider plugin for cloud computers on Cloudflare.

    :param settings: From :func:`~cloudflare_omnigent.sandbox.settings.settings_from_env`;
        ``None`` registers a launcher whose every call fails with a readable error.
    :param durability_wait: The replication fence for lifecycle effects (the server image
        passes Litestream's ``wait_replicated_blocking``).
    :param core: For tests: a prepared :class:`LauncherCore`.
    """

    provider: ClassVar[str] = PROVIDER
    can_resume: ClassVar[bool] = True
    supports_cli_bootstrap: ClassVar[bool] = False
    supports_managed_launch: ClassVar[bool] = True

    def __init__(
        self,
        settings: LauncherSettings | None,
        durability_wait: DurabilityWait | None,
        *,
        core: LauncherCore | None = None,
    ) -> None:
        self._core = core if core is not None else LauncherCore(settings, durability_wait)

    def __repr__(self) -> str:
        return f"{type(self).__name__}(provider={self.provider!r})"

    # ── lifecycle ───────────────────────────────────────────────────────────────────────

    def prepare(self) -> None:
        """Preflight: the key is accepted and the platform supports this protocol version."""
        with _omnigent_errors():
            self._core.prepare()

    def provision(self, name: str) -> str:
        """Record the computer for Omnigent's stable host name; idempotent by that name."""
        with _omnigent_errors():
            return self._core.provision(name)

    def claim_start(self, sandbox_id: str, *, operation_id: str) -> StartClaim:
        with _omnigent_errors():
            result = self._core.claim_start(sandbox_id, operation_id)
        if result.granted:
            return StartClaim(granted=True, attempt=result.start_attempt)
        return StartClaim(granted=False, status=result.status)  # type: ignore[arg-type]

    def start_host(
        self,
        sandbox_id: str,
        *,
        token: str,
        host_id: str,
        host_name: str,
        server_url: str,
        repos: Sequence[RepoWorkspace] = (),
        host_config: dict[str, object] | None = None,
        on_stage: Callable[[str], None] | None = None,
        start_attempt: int | None = None,
    ) -> str:
        """Hand a claimed attempt's start parameters to the computer; return its workspace.

        The platform starts the host once both restores are confirmed. Persistent hosts
        clone nothing, and a computer always reaches the server at ``http://omnigent.internal``.
        """
        if server_url.rstrip("/") != protocol.COMPUTER_SERVER_URL:
            raise click.ClickException(
                "This server's sandbox registration must point computers at "
                f"{protocol.COMPUTER_SERVER_URL}; nothing was started."
            )
        if repos:
            raise click.ClickException("Cloud computers do not clone repositories at start.")
        if start_attempt is None:
            raise click.ClickException(
                "A cloud computer starts its host only for a claimed start attempt."
            )
        if on_stage is not None:
            on_stage("starting")
        with _omnigent_errors():
            return self._core.start_host(
                sandbox_id,
                start_attempt=start_attempt,
                host_id=host_id,
                host_name=host_name,
                token=token,
                host_config=host_config if host_config is not None else {},
            )

    def resume(self, sandbox_id: str) -> None:
        """Start the computer, or nothing if it is starting or up. At the limit, refused."""
        with _omnigent_errors():
            result = self._core.resume(sandbox_id)
        logger.info("resume of %s: %s (generation %d)", sandbox_id, result.outcome, result.generation)

    def keep_alive(self, sandbox_id: str) -> bool | None:
        """Renew the activity lease. Soft-fails: ``False`` when not confirmed, never raises."""
        try:
            with _omnigent_errors():
                result = self._core.keep_alive(sandbox_id)
        except Exception as exc:  # noqa: BLE001 - keep_alive must never fail a caller
            logger.warning("keep_alive of %s not confirmed: %s", sandbox_id, exc)
            return False
        if not result.renewed:
            logger.info("keep_alive of %s: the computer is not running", sandbox_id)
        return result.renewed

    def is_running(self, sandbox_id: str) -> bool | None:
        """Whether a container runs (``stopping`` included); ``None`` when unknown."""
        try:
            with _omnigent_errors():
                return self._core.status(sandbox_id).running
        except OutcomeUnknown:
            return None

    def admission(self, sandbox_id: str) -> AdmissionReport | None:
        """The typed status and admission, fresh from the platform; ``None`` when unknown.

        Never cached here, so a failed refresh is never remembered; Omnigent asks again
        within its readiness deadline and refuses work only on an explicit refusal.
        """
        try:
            with _omnigent_errors():
                answer = self._core.admission(sandbox_id)
        except OutcomeUnknown:
            return None
        result = answer.result
        return AdmissionReport(
            admitting=result.admitting,
            reason=result.reason,
            message=result.message,
            generation=str(result.generation),
            status=result.status,  # type: ignore[arg-type]
            observed_at=answer.observed_at,
        )

    def checkpoint(self, sandbox_id: str, *, reason: CheckpointReason) -> str | None:
        """Ask for a save; return once the platform has recorded the request.

        A refusal (nothing can be saved now) is an ordinary error, which Omnigent logs and
        does not repeat; it is never a missing capability.
        """
        with _omnigent_errors():
            result, operation_id = self._core.checkpoint(sandbox_id, reason)
        if result.outcome == "refused":
            detail = CHECKPOINT_REFUSAL_TEXT.get(result.reason or "", result.reason)
            raise click.ClickException(f"The computer cannot save now: {detail}.")
        return operation_id

    def suspend(self, sandbox_id: str, *, operation_id: str) -> SuspendResult:
        """Stop a quiescent computer for a sleep, under Omnigent's operation ID.

        ``refused`` before any stop, ``stopped`` once confirmed, and ``unknown`` whenever the
        stop may have begun but its outcome is not known: Omnigent repeats the same operation.
        A fence that did not confirm, or a refusal of the request itself, is ``unknown`` too:
        an earlier call with this operation ID may have started the sleep.
        """
        try:
            with _omnigent_errors():
                result = self._core.suspend(sandbox_id, operation_id)
        except SandboxGoneError:
            raise
        except Exception as exc:  # noqa: BLE001 - every other failure is "unknown"
            logger.warning("suspend %s of %s: outcome unknown (%s)", operation_id, sandbox_id, exc)
            return SuspendResult(outcome="unknown")
        if result.outcome == "refused":
            detail = SUSPEND_REFUSAL_TEXT.get(result.reason or "", result.reason)
            return SuspendResult(outcome="refused", reason=detail)
        return SuspendResult(outcome="stopped")

    def terminate(self, sandbox_id: str) -> None:
        """Record the removal intent; succeed once it is durable on the platform.

        Omnigent calls this only to delete a computer, without an operation ID; repeating it
        is the same intent. An absent or already removed computer is a success.
        """
        try:
            with _omnigent_errors():
                result = self._core.terminate(sandbox_id)
        except SandboxGoneError:
            logger.info("terminate of %s: already removed or being removed", sandbox_id)
            return
        logger.info("terminate of %s: removal %s", sandbox_id, result.removal)
