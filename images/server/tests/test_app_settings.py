"""The app as the image builds it: authoritative sharing, pinned features, the launcher
registration and the reaper. In process, against the pinned Omnigent build."""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from conftest import AppHarness, omnigent_available, requires_omnigent, serve_app

pytestmark = requires_omnigent

EDITABLE_KEYS = (
    "editable",
    "public_sharing_editable",
    "public_sharing_max_level_editable",
    "default_public_sessions_editable",
)


def test_sharing_settings_are_reported_managed_and_never_public(app_harness: AppHarness) -> None:
    response = app_harness.client.get("/v1/sharing", headers=app_harness.bearer())
    assert response.status_code == 200, response.text
    body = response.json()
    editable = {k: v for k, v in body.items() if k == "editable" or k.endswith("_editable")}
    assert set(editable) == set(EDITABLE_KEYS)
    assert not any(editable.values())
    assert body["sharing_mode"] == "on"
    assert body["public_sharing_enabled"] is False
    # A public grant stored before gives nobody access while public sharing is off.
    assert app_harness.app.state.public_grants_honoured() is False
    assert body["public_sharing_max_level"] == "read"
    assert body["default_public_sessions"] == "off"


@pytest.mark.parametrize(
    "payload",
    [
        {"public_sharing": True},
        {"public_sharing": "yes"},
        {"sharing_mode": "off"},
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


#: The release features the app runs with at the pinned commit, written out here on purpose: a
#: fork bump that moves a default fails until someone reviews the feature and changes this line
#: and ``REVIEWED_FEATURES``. ``claude_osc_status`` is a runner feature; ``/v1/info`` lists only
#: what the web app reads.
ENABLED_FEATURES = ("claude_osc_status", "codex_plan_at_launch")
ENABLED_IN_INFO = {"codex_plan_at_launch"}


def test_info_reports_pinned_features_and_sharing(app_harness: AppHarness) -> None:
    info = app_harness.client.get("/v1/info").json()
    assert info["sharing_mode"] == "on"
    assert info["public_sharing_enabled"] is False
    assert {name for name, on in info["features"].items() if on} == ENABLED_IN_INFO
    assert info["features"]["harness_install"] is False
    assert info["features"]["session_orchestration"] is False
    assert info["features"]["sandbox_profiles"] is False
    assert info["features"]["automations_v2"] is False
    # create_app's 0.21.0 arguments the image leaves alone: nothing new is on.
    assert info["harness_install_enabled"] is False
    assert info["installable_harnesses"] == []
    assert info["automations_enabled"] is True
    assert info["picker"] == {"restrict_to_agent_names": [], "default_agent_name": None}


def test_the_app_runs_with_exactly_the_reviewed_features(
    app_harness: AppHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Omnigent's release defaults less ``session_orchestration`` (D63), and nothing else."""
    from omnigent.server.feature_flags import FEATURE_DEFINITIONS, Feature

    from cfo_server.app import pinned_feature_flags

    flags = app_harness.app.state.feature_flags
    assert flags.enabled_names() == ENABLED_FEATURES
    defaults = {d.feature for d in FEATURE_DEFINITIONS if d.default_enabled}
    assert {f for f in Feature if flags.enabled(f)} == defaults - {Feature.SESSION_ORCHESTRATION}
    # The environment never changes it.
    monkeypatch.setenv("OMNIGENT_FEATURES", "harness_install,automations_v2,session_orchestration")
    assert pinned_feature_flags() == flags


def _release_with(monkeypatch: pytest.MonkeyPatch, **defaults: bool) -> None:
    """Omnigent's feature table with these release defaults changed, as a release would."""
    from omnigent.server import feature_flags

    monkeypatch.setattr(
        feature_flags,
        "FEATURE_DEFINITIONS",
        tuple(
            dataclasses.replace(d, default_enabled=defaults.get(d.feature.value, d.default_enabled))
            for d in feature_flags.FEATURE_DEFINITIONS
        ),
    )


def test_a_release_that_turns_harness_install_on_stops_the_app(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cfo_server.app import pinned_feature_flags

    _release_with(monkeypatch, harness_install=True)
    with pytest.raises(RuntimeError, match="harness_install"):
        pinned_feature_flags()


def _unreviewed_features() -> list[str]:
    from omnigent.server.feature_flags import Feature

    return sorted(set(Feature) - set(ENABLED_FEATURES) - {"session_orchestration"})


@pytest.mark.parametrize("feature", _unreviewed_features() if omnigent_available() else [])
def test_a_release_that_turns_on_any_other_feature_stops_the_app(
    monkeypatch: pytest.MonkeyPatch, feature: str
) -> None:
    from cfo_server.app import pinned_feature_flags

    _release_with(monkeypatch, **{feature: True})
    with pytest.raises(RuntimeError, match=feature):
        pinned_feature_flags()


@pytest.mark.parametrize("feature", ENABLED_FEATURES)
def test_a_release_that_turns_a_reviewed_feature_off_stops_the_app(
    monkeypatch: pytest.MonkeyPatch, feature: str
) -> None:
    from cfo_server.app import pinned_feature_flags

    _release_with(monkeypatch, **{feature: False})
    with pytest.raises(RuntimeError, match=feature):
        pinned_feature_flags()


def test_session_orchestration_stays_off_whatever_its_release_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cfo_server.app import pinned_feature_flags

    _release_with(monkeypatch, session_orchestration=False)
    assert pinned_feature_flags().enabled_names() == ENABLED_FEATURES


def test_an_agents_session_message_is_refused_while_orchestration_is_off(
    app_harness: AppHarness,
) -> None:
    """What the pin is for, at the gate every orchestration route goes through."""
    from omnigent.errors import OmnigentError
    from omnigent.server.session_orchestration import require_orchestration_source
    from starlette.requests import Request

    request = Request({"type": "http", "headers": [], "app": app_harness.app})
    with pytest.raises(OmnigentError, match="Session orchestration is disabled"):
        require_orchestration_source(request, "owner", None, None)


def test_every_policy_hook_asks_the_server(app_harness: AppHarness) -> None:
    """No allow window: a policy someone adds mid-session reaches the next hook, not one up to
    300 s later. The answer a hook gets carries no window."""
    from omnigent.native.policy_allow_cache import ALLOW_CACHE_FIELD
    from omnigent.runtime import get_caps, get_policy_store
    from omnigent.server.routes.sessions.routes_hooks import _no_policy_allow_body

    caps = get_caps()
    assert caps.native_hook_allow_cache_seconds is None
    body = _no_policy_allow_body(caps, "conv_cfo", get_policy_store())
    assert ALLOW_CACHE_FIELD not in body


def test_a_policy_allow_window_stops_the_app(tmp_path: Path) -> None:
    """If a release turned the window on, or the image passed one, the app would not start."""
    from functools import partial

    from omnigent.runtime import caps as runtime_caps

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            runtime_caps,
            "RuntimeCaps",
            partial(runtime_caps.RuntimeCaps, native_hook_allow_cache_seconds=lambda: 60.0),
        )
        with (
            pytest.raises(RuntimeError, match="native_hook_allow_cache_seconds"),
            serve_app(tmp_path),
        ):
            pass


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
    # Administrators find other people's computers on the platform's computers page.
    assert config.persistent.overview_url == "/platform/computers"
    info = app_harness.client.get("/v1/info").json()
    assert info["persistent_host_overview_urls"] == {PROVIDER: "/platform/computers"}
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
