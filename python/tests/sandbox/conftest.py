"""Fixtures for the Cloudflare launcher's tests: a fake launcher API over real HTTP, a
recording durability fence, and short budgets so lost replies resolve in about a second.

Every key, token and canary here is made at run time; none is a committed value.
"""

from __future__ import annotations

import logging
import secrets
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_platform import FakeLauncherApi  # noqa: E402

from cloudflare_omnigent.sandbox.client import CallPolicy, LauncherClient  # noqa: E402
from cloudflare_omnigent.sandbox.core import LauncherCore  # noqa: E402
from cloudflare_omnigent.sandbox.protocol import OPERATIONS  # noqa: E402
from cloudflare_omnigent.sandbox.settings import LauncherSettings  # noqa: E402

FAST_POLICIES = {op: CallPolicy(attempt_timeout_s=1.0, budget_s=2.0) for op in OPERATIONS}
FAST_POLICIES["suspend"] = CallPolicy(attempt_timeout_s=1.0, budget_s=2.5)
FAST_BACKOFF = (0.05, 0.2)
SUSPEND_POLL_S = 0.05


def canary(length: int = 32) -> str:
    """A canary the repository's scanner recognises, built at run time."""
    return "CFO_" + "CANARY_" + secrets.token_hex(length // 2)


def launch_token() -> str:
    """A launch token in Omnigent's alphabet that is also a canary."""
    return canary(40)


class Fence:
    """A durability fence that records each wait and answers as told.

    ``requests_seen`` keeps how many requests had reached the API when each wait ran, so a test
    can prove the wait came before the effect.
    """

    def __init__(self, api: FakeLauncherApi | None = None) -> None:
        self.api = api
        self.confirm = True
        self.raises: Exception | None = None
        self.calls: list[float] = []
        self.requests_seen: list[int] = []

    def __call__(self, timeout_s: float) -> bool:
        self.calls.append(timeout_s)
        if self.api is not None:
            self.requests_seen.append(len(self.api.requests))
        if self.raises is not None:
            raise self.raises
        return self.confirm


@pytest.fixture
def api() -> Iterator[FakeLauncherApi]:
    fake = FakeLauncherApi().start()
    try:
        yield fake
    finally:
        fake.stop()


@pytest.fixture
def settings(api: FakeLauncherApi) -> LauncherSettings:
    return LauncherSettings(signing_key=api.key, signing_key_id=api.key_id, base_url=api.base_url)


@pytest.fixture
def fence(api: FakeLauncherApi) -> Fence:
    return Fence(api)


def make_core(settings: LauncherSettings | None, fence: Fence | None) -> LauncherCore:
    client = None if settings is None else LauncherClient(settings, backoff_s=FAST_BACKOFF)
    return LauncherCore(
        settings,
        fence,
        client=client,
        policies=FAST_POLICIES,
        suspend_poll_s=SUSPEND_POLL_S,
    )


@pytest.fixture
def core(settings: LauncherSettings, fence: Fence) -> LauncherCore:
    return make_core(settings, fence)


@pytest.fixture
def launcher_logs(caplog: pytest.LogCaptureFixture) -> pytest.LogCaptureFixture:
    caplog.set_level(logging.DEBUG, logger="cloudflare_omnigent.sandbox")
    return caplog
