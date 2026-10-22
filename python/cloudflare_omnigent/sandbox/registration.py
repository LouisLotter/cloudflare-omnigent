"""The provider entry an embedding server registers through ``create_app(sandbox_config=…)``.

It carries the settings Omnigent needs per provider for cloud computers (design, "The Cloudflare
launcher"; Timing budget):

- the launch-token lifetime, which Omnigent requires per provider: 30 days, above any awake
  span, and a host within a day of expiry sleeps at its next idle moment;
- persistent-only: hosts are created through ``POST /v1/hosts`` and one-conversation launches
  are refused (core change 13);
- the 240 s online wait, the length of Omnigent's message hold;
- a 600 s runner idle timeout, through the host configuration installed before the host starts
  (Omnigent's default is 3600 s);
- the computers' ``manage_url``, the platform's setup page for each computer;
- the 600 s keep-alive cadence and turn-aligned checkpoints (core change 15's defaults).
"""

from __future__ import annotations

from omnigent.server.managed_hosts import (
    ManagedSandboxConfig,
    PersistentHostPolicy,
    SandboxCheckpointPolicy,
)

from cloudflare_omnigent.sandbox import protocol
from cloudflare_omnigent.sandbox.core import DurabilityWait
from cloudflare_omnigent.sandbox.launcher import PROVIDER, CloudflareLauncher
from cloudflare_omnigent.sandbox.settings import LauncherSettings, check_base_url

LAUNCH_TOKEN_TTL_S = 30 * 24 * 3600
ONLINE_TIMEOUT_S = 240.0
RUNNER_IDLE_TIMEOUT_S = 600
KEEPALIVE_INTERVAL_S = 600.0
IDLE_SLEEP_S = 300.0
ADMISSION_MAX_AGE_S = 60.0
SWEEP_INTERVAL_S = 30.0
TOKEN_REFRESH_MARGIN_S = 24 * 3600.0
#: The platform's page for one computer, on the installation's own origin (WP3.5's pages).
MANAGE_PATH = "/platform/computers/{sandbox_id}"


def host_config() -> dict[str, object]:
    """``~/.omnigent/config.yaml`` content every computer's host starts with."""
    return {"runner": {"idle_timeout_s": RUNNER_IDLE_TIMEOUT_S}}


def manage_url_template(base_url: str) -> str:
    """The setup page link Omnigent shows per computer, from the installation's origin."""
    return check_base_url(base_url, "the installation's base URL") + MANAGE_PATH


def cloudflare_sandbox_config(
    *,
    settings: LauncherSettings | None,
    durability_wait: DurabilityWait | None,
    manage_url: str,
    server_url: str = protocol.COMPUTER_SERVER_URL,
) -> ManagedSandboxConfig:
    """The persistent-only provider entry for cloud computers.

    :param settings: The launcher's settings, or ``None`` when it is not configured.
    :param durability_wait: The replication fence for lifecycle effects.
    :param manage_url: The per-computer setup page template (``{sandbox_id}``).
    :param server_url: Where computers reach this server; must be ``http://omnigent.internal``.
    :raises ValueError: When *server_url* is anything else.
    """
    if server_url.rstrip("/") != protocol.COMPUTER_SERVER_URL:
        raise ValueError(
            f"cloud computers reach the server at {protocol.COMPUTER_SERVER_URL}, "
            "so the sandbox server URL must be that"
        )
    return ManagedSandboxConfig(
        server_url=protocol.COMPUTER_SERVER_URL,
        launcher_factory=lambda: CloudflareLauncher(settings, durability_wait),
        token_ttl_s=LAUNCH_TOKEN_TTL_S,
        provider=PROVIDER,
        host_config=host_config(),
        checkpoint=SandboxCheckpointPolicy(),
        persistent=PersistentHostPolicy(
            idle_sleep_s=IDLE_SLEEP_S,
            admission_max_age_s=ADMISSION_MAX_AGE_S,
            sweep_interval_s=SWEEP_INTERVAL_S,
            token_refresh_margin_s=TOKEN_REFRESH_MARGIN_S,
            manage_url=manage_url,
        ),
        online_timeout_s=ONLINE_TIMEOUT_S,
        keepalive_interval_s=KEEPALIVE_INTERVAL_S,
    )
