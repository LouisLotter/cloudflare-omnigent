"""The Cloudflare launcher's registration through ``sandbox_config`` (WP3.6).

The launcher itself is ``cloudflare_omnigent.sandbox`` (``python/`` in the repository, copied to
``/opt/cfo`` in the image). This module wires it into the app:

- its settings from the container's environment (``CFO_LAUNCHER_SIGNING_KEY`` and
  ``CFO_LAUNCHER_SIGNING_KEY_ID``, the launcher's own key). Neither set registers a launcher
  whose every call fails with a readable error; a malformed or partial setting stops the app;
- its durability fence: :func:`cfo_server.litestream.wait_replicated_blocking` on the same
  Litestream position the response barrier reads, before every ``provision``, ``start_host``,
  ``suspend`` and ``terminate`` (design, "Lifecycle effects wait for durability in the
  launcher"). Omnigent calls the launcher in worker threads, so the wait never blocks its
  event loop;
- the provider entry (``cloudflare_omnigent.sandbox.registration``): persistent-only, the
  30-day launch-token lifetime, the 240 s online wait, the 600 s runner idle timeout through
  the host configuration, and each computer's ``manage_url`` on the installation's origin;
- Omnigent's managed-sandbox reaper, which retries ``terminate`` for deleted computers (R-11).
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING

from cloudflare_omnigent.sandbox.launcher import PROVIDER, CloudflareLauncher
from cloudflare_omnigent.sandbox.registration import (
    cloudflare_sandbox_config,
    manage_url_template,
)
from cloudflare_omnigent.sandbox.settings import settings_from_env
from omnigent.server.managed_hosts import ManagedSandboxDeployment, ManagedSandboxReaperConfig

from cfo_server.events import log
from cfo_server.litestream import wait_replicated_blocking

if TYPE_CHECKING:
    from omnigent.onboarding.sandboxes.base import SandboxHostLauncher

    from cfo_server.config import ServerImageConfig

__all__ = ["PROVIDER", "CloudflareLauncher", "litestream_durability_wait", "sandbox_deployment"]


def litestream_durability_wait(socket_path: str, db_path: str) -> Callable[[float], bool]:
    """The launcher's fence: True once every commit made before the call is replicated."""

    def wait(timeout_s: float) -> bool:
        outcome = wait_replicated_blocking(socket_path, db_path, timeout_s)
        if not outcome.ok:
            log("launcher.durability_unconfirmed", **outcome.log_fields())
        return outcome.ok

    return wait


def sandbox_deployment(
    config: ServerImageConfig,
    *,
    durability_wait: Callable[[float], bool] | None,
    env: Mapping[str, str] | None = None,
    launcher_factory: Callable[[], SandboxHostLauncher] | None = None,
) -> ManagedSandboxDeployment:
    """The ``sandbox_config`` the app passes to ``create_app``.

    :param durability_wait: The replication fence; ``None`` makes every lifecycle effect refuse.
    :param env: The environment to read the launcher's settings from (default: the process's).
    :param launcher_factory: For tests: another launcher under the same provider entry.
    :raises cloudflare_omnigent.sandbox.settings.LauncherConfigError: A malformed setting.
    """
    settings = settings_from_env(os.environ if env is None else env)
    if settings is None:
        log("launcher.not_configured", reason="CFO_LAUNCHER_SIGNING_KEY is not set")
    entry = cloudflare_sandbox_config(
        settings=settings,
        durability_wait=durability_wait,
        manage_url=manage_url_template(config.base_url),
        server_url=config.sandbox_server_url,
    )
    if launcher_factory is not None:
        entry.launcher_factory = launcher_factory
    return ManagedSandboxDeployment.single(entry, reaper=ManagedSandboxReaperConfig(enabled=True))
