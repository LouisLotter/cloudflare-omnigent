"""The launcher's durability fence, and a stub launcher that records platform effects.

The design ("Lifecycle effects wait for durability in the launcher", FH-29): before
``provision``, ``start_host``, ``suspend`` or ``terminate`` makes any platform effect, the
Cloudflare launcher waits until Litestream has replicated the database as it stood when the
call began, and on timeout the call fails before its effect. WP3.6 builds that launcher; this
module is the reference the durability suite runs with Omnigent's real routes until then
(FH-29's stub-launcher part), and the shape WP3.6's tests can reuse:

- :class:`ReplicationFence` is the wait itself: one ``cfo_server.litestream`` durability wait
  (a sync without ``wait``, then polling ``replicated_txid``), in the calling thread. Omnigent
  calls launcher methods in worker threads, so its event loop never waits.
- A failed wait must fail the call **before** the effect, in the form Omnigent treats as a
  refusal rather than a lost reply: ``click.ClickException`` for ``provision``,
  ``start_host`` and ``terminate`` (a wake then fails visibly with the message, a first start
  records it on the host, a removal stays tombstoned for the reaper), and
  ``SuspendResult("refused")`` for ``suspend`` (Omnigent then restores the token the sleep
  revoked; raising would read as "unknown" and keep admission closed).
- :class:`RecordingStubLauncher` makes no platform effect at all: it records each one, with
  the replicated position at that moment, and keeps only a digest of a launch token.
"""

from __future__ import annotations

import hashlib
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import click
from omnigent.onboarding.sandboxes.base import SandboxHostLauncher
from omnigent.onboarding.sandboxes.types import SuspendResult

from cfo_server.litestream import BlockingClient, WaitOutcome, wait_replicated_blocking

#: The methods the design fences: each one's effect depends on a write made before it.
FENCED = ("provision", "start_host", "suspend", "terminate")

REFUSAL = (
    "{method} was not started: the server could not confirm that its database is saved "
    "({reason}). Nothing was changed; try again shortly."
)


@dataclass
class ReplicationFence:
    """Waits until every commit made before the call is replicated, within one deadline."""

    socket_path: str
    db_path: str
    timeout_s: float
    enabled: bool = True
    log: list[dict[str, Any]] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def wait(self, method: str) -> WaitOutcome | None:
        if not self.enabled:
            return None
        outcome = wait_replicated_blocking(self.socket_path, self.db_path, self.timeout_s)
        with self._lock:
            self.log.append({"method": method, **outcome.log_fields()})
        return outcome

    def check(self, method: str) -> None:
        """Raise the refusal Omnigent shows when the wait failed; return when it held."""
        outcome = self.wait(method)
        if outcome is not None and not outcome.ok:
            raise click.ClickException(
                REFUSAL.format(method=method, reason=outcome.reason or "unknown")
            )


@dataclass
class Effect:
    method: str
    sandbox_id: str
    at: float
    #: SHA-256 of the launch token ``start_host`` would publish (``hosts.token_hash``).
    token_sha256: str | None = None
    #: The local and replicated positions when the effect happened.
    txid: int | None = None
    replicated_txid: int | None = None


@dataclass
class EffectLog:
    effects: list[Effect] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, effect: Effect) -> None:
        with self._lock:
            self.effects.append(effect)

    def of(self, method: str, sandbox_id: str | None = None) -> list[Effect]:
        with self._lock:
            return [
                e
                for e in self.effects
                if e.method == method and (sandbox_id is None or e.sandbox_id == sandbox_id)
            ]


class RecordingStubLauncher(SandboxHostLauncher):
    """A persistent-host launcher with the fence in front and no platform behind it.

    It reports a provisioned sandbox as stopped (so a wake resumes it, re-arms a token and
    starts its host) and keeps no state of its own. ``status_gate``, when given, makes
    ``is_running`` answer "unknown" until the gate is set, which holds a wake between its
    provision and its start for as long as a test needs.
    """

    provider = "cloudflare"
    can_resume = True

    def __init__(
        self,
        fence: ReplicationFence,
        effects: EffectLog,
        *,
        status_gate: threading.Event | None = None,
    ) -> None:
        self._fence = fence
        self._effects = effects
        self._gate = status_gate

    @classmethod
    def factory(
        cls, fence: ReplicationFence, effects: EffectLog, **kw: Any
    ) -> Callable[[], RecordingStubLauncher]:
        return lambda: cls(fence, effects, **kw)

    def _record(self, method: str, sandbox_id: str, token: str | None = None) -> None:
        txid = replicated = None
        try:
            with BlockingClient(self._fence.socket_path, self._fence.db_path) as client:
                position = client.sync(timeout_s=5.0)
            txid, replicated = position.txid, position.replicated_txid
        except Exception:  # noqa: BLE001 - the position is evidence, not a precondition
            pass
        self._effects.add(
            Effect(
                method,
                sandbox_id,
                time.time(),
                hashlib.sha256(token.encode()).hexdigest() if token is not None else None,
                txid,
                replicated,
            )
        )

    def prepare(self) -> None:
        """Nothing to prepare."""

    def provision(self, name: str) -> str:
        self._fence.check("provision")
        sandbox_id = f"sb-{uuid.uuid4().hex[:12]}"
        self._record("provision", sandbox_id)
        return sandbox_id

    def is_running(self, sandbox_id: str) -> bool | None:
        if self._gate is not None and not self._gate.is_set():
            return None
        return False

    def resume(self, sandbox_id: str) -> None:
        # Not fenced in the design: it starts the computer without a host or a token.
        self._record("resume", sandbox_id)

    def start_host(
        self,
        sandbox_id: str,
        *,
        token: str,
        host_id: str,
        host_name: str,
        server_url: str,
        repos: Sequence[Any] = (),
        host_config: dict[str, object] | None = None,
        on_stage: Callable[[str], None] | None = None,
    ) -> str:
        self._fence.check("start_host")
        self._record("start_host", sandbox_id, token)
        return host_id

    def suspend(self, sandbox_id: str, *, operation_id: str) -> SuspendResult:
        outcome = self._fence.wait("suspend")
        if outcome is not None and not outcome.ok:
            return SuspendResult(outcome="refused", reason="durability not confirmed")
        self._record("suspend", sandbox_id)
        return SuspendResult(outcome="stopped")

    def terminate(self, sandbox_id: str) -> None:
        self._fence.check("terminate")
        self._record("terminate", sandbox_id)

    def keep_alive(self, sandbox_id: str) -> bool | None:
        return None
