"""The provider entry the server registers for cloud computers (needs the fork's Omnigent)."""

from __future__ import annotations

import pytest

pytest.importorskip("omnigent.server.managed_hosts")

from conftest import Fence  # noqa: E402
from omnigent.server import persistent_hosts  # noqa: E402
from omnigent.server.managed_hosts import ManagedSandboxDeployment  # noqa: E402
from omnigent.stores.host_store import Host  # noqa: E402

from cloudflare_omnigent.sandbox.launcher import CloudflareLauncher  # noqa: E402
from cloudflare_omnigent.sandbox.registration import (  # noqa: E402
    cloudflare_sandbox_config,
    manage_url_template,
)
from cloudflare_omnigent.sandbox.settings import LauncherSettings  # noqa: E402

SETTINGS = LauncherSettings(signing_key=b"k" * 32, signing_key_id="k1")


def _entry(**kwargs: object):  # type: ignore[no-untyped-def]
    return cloudflare_sandbox_config(
        settings=SETTINGS,
        durability_wait=Fence(),
        manage_url=manage_url_template("https://computers.example.test"),
        **kwargs,  # type: ignore[arg-type]
    )


def test_the_entry_sets_what_omnigent_requires_for_cloud_computers() -> None:
    entry = _entry()
    assert entry.provider == "cloudflare"
    assert entry.server_url == "http://omnigent.internal"
    assert entry.token_ttl_s == 30 * 24 * 3600
    assert entry.online_timeout_s == 240.0 == entry.host_online_timeout_s
    assert entry.keepalive_interval_s == 600.0
    assert entry.host_config == {"runner": {"idle_timeout_s": 600}}
    assert entry.checkpoint.enabled and entry.checkpoint.max_interval_s == 600.0
    policy = entry.persistent
    assert policy is not None
    assert policy.idle_sleep_s == 300.0
    assert policy.admission_max_age_s == 60.0
    assert policy.sweep_interval_s == 30.0
    assert policy.token_refresh_margin_s == 24 * 3600.0
    assert policy.manage_url == "https://computers.example.test/platform/computers/{sandbox_id}"
    # The token outlives the one-day margin by far, so a live host renews it at an idle moment.
    assert entry.token_ttl_s > policy.token_refresh_margin_s * 7


def test_it_is_persistent_only() -> None:
    deployment = ManagedSandboxDeployment.single(_entry())
    assert deployment.persistent_providers() == ("cloudflare",)
    assert deployment.managed_launch_supported is False
    assert _entry().session_launch_supported is False


def test_each_launch_gets_a_cloudflare_launcher() -> None:
    entry = _entry()
    first, second = entry.launcher_factory(), entry.launcher_factory()
    assert isinstance(first, CloudflareLauncher) and first is not second


def test_omnigent_renders_the_setup_link_per_computer() -> None:
    entry = _entry()
    deployment = ManagedSandboxDeployment.single(entry)
    persistent_hosts.configure(None, None, deployment)
    try:
        host = Host(
            host_id="7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f",
            name="Work computer",
            user_id="owner",
            sandbox_provider="cloudflare",
            sandbox_id="cmp_01hzy3m8k6q4t2v9w7x5r0s1n3",
            status="offline",
            created_at=0,
            updated_at=0,
            lifecycle=persistent_hosts.PERSISTENT,
        )
        assert persistent_hosts.manage_url(host) == (
            "https://computers.example.test/platform/computers/cmp_01hzy3m8k6q4t2v9w7x5r0s1n3"
        )
    finally:
        persistent_hosts.configure(None, None, None)


def test_computers_must_reach_the_server_on_omnigent_internal() -> None:
    with pytest.raises(ValueError, match="omnigent.internal"):
        _entry(server_url="https://omnigent.example.test")
    assert _entry(server_url="http://omnigent.internal/").server_url == "http://omnigent.internal"


@pytest.mark.parametrize("base", ["ftp://x.test", "https://user@x.test", "not a url"])
def test_the_setup_link_needs_an_http_origin(base: str) -> None:
    with pytest.raises(ValueError):
        manage_url_template(base)


def test_the_setup_link_keeps_only_the_origin() -> None:
    assert manage_url_template("https://x.test:8443/some/path/") == (
        "https://x.test:8443/platform/computers/{sandbox_id}"
    )
