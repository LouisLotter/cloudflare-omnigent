"""The Cloudflare launcher's registration through ``sandbox_config``, with a stub launcher.

WP3.6 delivers the real launcher (``cloudflare_omnigent.sandbox``) and replaces
:class:`StubLauncher` in :func:`sandbox_deployment`. Until then the provider is registered so
the rest of the image (persistent-host routes, the reaper, ``GET /v1/info``) runs as it will
in production, and every platform effect fails with a readable error.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING, Any

import click
from omnigent.onboarding.sandboxes.base import SandboxHostLauncher
from omnigent.server.managed_hosts import (
    ManagedSandboxConfig,
    ManagedSandboxDeployment,
    ManagedSandboxReaperConfig,
    PersistentHostPolicy,
)

if TYPE_CHECKING:
    from cfo_server.config import ServerImageConfig

PROVIDER = "cloudflare"
#: Launch-token lifetime. A placeholder until WP3.6 sets the provider's value; it must exceed
#: the one-day margin after which a host is put to sleep to renew its token (core change 13 k).
LAUNCH_TOKEN_TTL_S = 7 * 24 * 3600
#: How long a launch or wake waits for the host to come online (code-structure plan).
ONLINE_TIMEOUT_S = 240.0

_NOT_INSTALLED = (
    "Cloud computers are not available yet: this server image registers a placeholder for "
    "the Cloudflare launcher."
)


class StubLauncher(SandboxHostLauncher):
    """A launcher that refuses every platform effect. Replaced by WP3.6's launcher."""

    provider = PROVIDER
    can_resume = True

    def prepare(self) -> None:
        """Nothing to prepare."""

    def provision(self, name: str) -> str:
        raise click.ClickException(_NOT_INSTALLED)

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
        raise click.ClickException(_NOT_INSTALLED)

    def resume(self, sandbox_id: str) -> None:
        raise click.ClickException(_NOT_INSTALLED)

    def terminate(self, sandbox_id: str) -> None:
        raise click.ClickException(_NOT_INSTALLED)

    def keep_alive(self, sandbox_id: str) -> bool | None:
        return None

    def is_running(self, sandbox_id: str) -> bool | None:
        return None

    def admission(self, sandbox_id: str) -> Any:
        return None

    def claim_start(self, sandbox_id: str, *, operation_id: str) -> Any:
        raise click.ClickException(_NOT_INSTALLED)

    def suspend(self, sandbox_id: str, *, operation_id: str) -> Any:
        raise click.ClickException(_NOT_INSTALLED)


def sandbox_deployment(
    config: ServerImageConfig,
    launcher_factory: Callable[[], SandboxHostLauncher] = StubLauncher,
) -> ManagedSandboxDeployment:
    """The ``sandbox_config`` the app passes to ``create_app``.

    One persistent-only provider, and the managed-sandbox reaper enabled: with core change 13
    the reaper retries ``terminate`` only for deleted (tombstoned) persistent hosts, which is
    upstream's only retry for a removal whose ``terminate`` failed (R-11).
    """
    return ManagedSandboxDeployment.single(
        ManagedSandboxConfig(
            server_url=config.sandbox_server_url,
            launcher_factory=launcher_factory,
            token_ttl_s=LAUNCH_TOKEN_TTL_S,
            provider=PROVIDER,
            persistent=PersistentHostPolicy(),
            online_timeout_s=ONLINE_TIMEOUT_S,
        ),
        reaper=ManagedSandboxReaperConfig(enabled=True),
    )
