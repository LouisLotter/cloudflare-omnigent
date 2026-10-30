"""The app as the image builds it: authoritative sharing, pinned features, the launcher
registration and the reaper. In process, against the pinned Omnigent build."""

from __future__ import annotations

import dataclasses

import pytest

from conftest import AppHarness, requires_omnigent

pytestmark = requires_omnigent

EDITABLE_KEYS = (
    "editable",
    "public_sharing_editable",
    "public_sharing_max_level_editable",
    "default_public_sessions_editable",
)


def test_sharing_settings_are_reported_managed_and_restrictive(app_harness: AppHarness) -> None:
    response = app_harness.client.get("/v1/sharing", headers=app_harness.bearer())
    assert response.status_code == 200, response.text
    body = response.json()
    editable = {k: v for k, v in body.items() if k == "editable" or k.endswith("_editable")}
    assert set(editable) == set(EDITABLE_KEYS)
    assert not any(editable.values())
    assert body["sharing_mode"] == "off"
    assert body["public_sharing_enabled"] is False
    assert body["public_sharing_max_level"] == "read"
    assert body["default_public_sessions"] == "off"


@pytest.mark.parametrize(
    "payload",
    [
        {"public_sharing": True},
        {"public_sharing": "yes"},
        {"sharing_mode": "on"},
        {"sharing_mode": " ON "},
        {"default_public_sessions": "all"},
        {"public_sharing_max_level": "edit"},
        {"public_sharing": False},
    ],
)
def test_sharing_writes_are_refused_by_omnigent_itself(
    app_harness: AppHarness, payload: dict[str, object]
) -> None:
    response = app_harness.client.put("/v1/sharing", json=payload, headers=app_harness.bearer())
    assert response.status_code == 403, response.text
    data_dir = app_harness.db_path.parent / "data"
    for name in (
        "sharing_mode",
        "public_sharing",
        "public_sharing_max_level",
        "default_public_sessions",
    ):
        assert not (data_dir / name).exists()


def test_info_reports_pinned_features_and_sharing(app_harness: AppHarness) -> None:
    info = app_harness.client.get("/v1/info").json()
    assert info["sharing_mode"] == "off"
    assert info["public_sharing_enabled"] is False
    assert not any(info.get("features", {}).values())
    assert info["features"].get("harness_install") is False


def test_the_app_runs_with_omnigents_release_defaults(
    app_harness: AppHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Since 0.20.0 an empty ``OMNIGENT_FEATURES`` means each feature's release default. The app
    gets exactly those, never ``harness_install`` and never 0.20.0's scheduler (D38)."""
    from omnigent.server.feature_flags import FEATURE_DEFINITIONS, Feature

    from cfo_server.app import pinned_feature_flags

    defaults = {d.feature for d in FEATURE_DEFINITIONS if d.default_enabled}
    flags = app_harness.app.state.feature_flags
    assert {f for f in Feature if flags.enabled(f)} == defaults
    assert not flags.enabled(Feature.HARNESS_INSTALL)
    assert not flags.enabled(Feature.AUTOMATIONS_V2)
    # The environment never changes it.
    monkeypatch.setenv("OMNIGENT_FEATURES", "harness_install,automations_v2")
    assert pinned_feature_flags() == flags


def test_a_release_that_turns_harness_install_on_stops_the_app(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from omnigent.server import feature_flags

    from cfo_server.app import pinned_feature_flags

    monkeypatch.setattr(
        feature_flags,
        "FEATURE_DEFINITIONS",
        tuple(
            dataclasses.replace(d, default_enabled=True)
            if d.feature == feature_flags.Feature.HARNESS_INSTALL
            else d
            for d in feature_flags.FEATURE_DEFINITIONS
        ),
    )
    with pytest.raises(RuntimeError, match="harness_install"):
        pinned_feature_flags()


def test_launcher_is_registered_through_sandbox_config_with_the_reaper(
    app_harness: AppHarness,
) -> None:
    from cfo_server.launcher import PROVIDER, CloudflareLauncher

    deployment = app_harness.app.state.sandbox_config
    assert deployment.reaper.enabled is True
    assert deployment.persistent_providers() == (PROVIDER,)
    config = deployment.for_provider(PROVIDER)
    assert config is not None
    assert config.online_timeout_s == 240.0
    assert config.token_ttl_s == 30 * 24 * 3600
    assert config.server_url == "http://omnigent.internal"
    assert config.host_config == {"runner": {"idle_timeout_s": 600}}
    assert config.persistent is not None
    assert config.persistent.manage_url == "http://testserver/platform/computers/{sandbox_id}"
    assert isinstance(config.launcher_factory(), CloudflareLauncher)
    # Persistent-only: never offered for one-conversation launches.
    assert deployment.launchable_providers() == ()


def test_transcript_barrier_is_installed_through_the_create_app_hook(
    app_harness: AppHarness,
) -> None:
    from omnigent.server.durability import durability_barrier

    barrier = durability_barrier(app_harness.app)
    assert barrier is not None
    assert barrier.__name__ == "litestream_durability_barrier"
