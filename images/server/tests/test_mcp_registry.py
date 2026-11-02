"""Omnigent's MCP registry in the server image (WP5.10, WP8.14).

- **The key service** is on whenever its signing pair is set, with or without GitHub, and is
  then the credential store's only cipher.
- **The page** (WP8.14): the registry is built whenever the key service is on, with Omnigent's
  service store, so administrators add MCP servers on its page with no service chosen;
  ``OMNIGENT_MCP_ADMIN_SERVICES=0`` turns the page off. The shipped manifests the page can take
  are its presets, unless chosen.
- **Manifests and choices.** The shipped manifests load; the installation's choices
  (``CFO_MCP_SERVICES`` and each service's asked values) become Omnigent's registry
  configuration, with the destination rules; a malformed one stops the start (exit 78) without
  repeating a value; a missing prerequisite turns MCP off, the page too, with a warning.
- **Destination rules for the page** (``PlatformDestinationPolicy``): the platform's rules and
  Omnigent's default ones on every URL, public addresses only, at save and on every connection.
- **Coupling.** The names are the pinned Omnigent's own, and Omnigent accepts what the image
  builds; the image's destination rules are never looser than Omnigent's.
- **The app.** Built by the image's ``build_app`` with a loopback key service and Omnigent's demo
  OAuth MCP service: connect, the login only as ciphertext, a runner's call through the gateway,
  a refresh, disconnect and the call failing at once; every login write held by the barrier. And
  a server added on the page: OAuth discovery and client registration, the client secret and the
  login sealed, the tool allowlist, a runner's call, its redirects refused, private destinations
  refused, the count the update compares, and a chosen service of the same name hiding it.

The end-to-end test with the real key service, the images and HTTPS is
``tests/integration/mcp_registry``.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tarfile
import time
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from cfo_server import config as image_config
from cfo_server import mcp
from cfo_server.config import (
    CREDENTIAL_CIPHER_ENV,
    ConfigError,
    app_environment,
    litestream_environment,
    load,
)

from conftest import BASE_URL, OWNER, OWNER_PASSWORD, base_env, requires_omnigent, serve_app
from key_service_stub import KeyServiceStub

HERE = Path(__file__).resolve().parent
VECTORS = json.loads((HERE / "destination_vectors.json").read_text())
DEMO_SERVICE = Path(
    os.environ.get("CFO_OMNIGENT_DEMO_MCP", "/build/examples/mcp-registry/demo_service.py")
)

# Synthetic values only.
SIGNING_KEY = "cfo-test-key-service-signing-key-000000000"
SIGNING_KEY_ID = "ks-test-1"
STATE_SECRET = "cfo-test-mcp-oauth-state-secret-0000000000"
ORIGIN = "https://mcp-demo.example.test"
#: The installation's URL: https, as Omnigent requires for OAuth callbacks (the shared tests'
#: ``BASE_URL`` is plain http); the app's tests use the loopback, which Omnigent also allows.
PUBLIC_URL = "https://omnigent.example.test"
LOOPBACK_URL = "http://localhost"
CLIENT_SECRET = "cfo-test-mcp-client-secret-0000"
STATE_SECRET_NAME = "OMNIGENT_MCP_OAUTH_STATE_SECRET"


def key_service_env(**over: str) -> dict[str, str]:
    env = {
        "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY": SIGNING_KEY,
        "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID": SIGNING_KEY_ID,
    }
    env.update(over)
    return env


def tracker_env(**over: str) -> dict[str, str]:
    """The settings the installer stores for the shipped test service (as the server gets them)."""
    env = {
        **key_service_env(),
        "OMNIGENT_ACCOUNTS_BASE_URL": PUBLIC_URL,
        "CFO_MCP_SERVICES": "tracker",
        "CFO_MCP_ORIGIN_TRACKER": ORIGIN,
        "OMNIGENT_MCP_OAUTH_STATE_SECRET": STATE_SECRET,
    }
    env.update(over)
    return env


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return base_env(tmp_path)


def manifest(service_id: str = "svc", *, asks: list[str] | None = None, **service: object) -> dict:
    entry: dict[str, object] = {
        "id": service_id,
        "title": "A service",
        "url": "https://mcp.example.com/mcp",
        "auth": "bearer",
        "tools": ["read"],
    }
    entry.update(service)
    return {"manifest": 1, "asks": asks or [], "service": entry}


def write_manifests(directory: Path, *manifests: dict) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for data in manifests:
        (directory / f"{data['service']['id']}.json").write_text(json.dumps(data))
    return directory


# ── The key service, independent of GitHub ──────────────────────────────────────────────


def test_the_key_service_is_on_whenever_its_pair_is_set(env: dict[str, str]) -> None:
    env.update(key_service_env())
    config = load(env)
    assert config.key_service is not None and not config.github.enabled
    assert config.key_service.url == image_config.DEFAULT_KEY_SERVICE_URL
    assert SIGNING_KEY not in repr(config)
    app_env = app_environment(config, env)
    assert app_env[CREDENTIAL_CIPHER_ENV] == "http"
    assert app_env["OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY"] == SIGNING_KEY
    assert app_env["OMNIGENT_CREDENTIAL_HTTP_URL"] == "http://platform.internal/key-service/v1"
    assert "platform.internal" in app_env["NO_PROXY"].split(",")
    assert SIGNING_KEY not in litestream_environment(env).values()
    assert load(app_env, for_app=True).key_service == config.key_service


def test_half_a_signing_pair_is_off_with_a_warning(env: dict[str, str]) -> None:
    env["OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY"] = SIGNING_KEY
    config = load(env)
    assert config.key_service is None
    (warning,) = [w for w in config.warnings if "key service is off" in w]
    assert "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID" in warning and SIGNING_KEY not in warning
    assert CREDENTIAL_CIPHER_ENV not in app_environment(config, env)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY", "too-short-0000"),
        ("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID", "bad id"),
        ("OMNIGENT_CREDENTIAL_HTTP_URL", "http://elsewhere.example/key-service/v1"),
    ],
)
def test_a_malformed_key_service_stops_the_start_without_github(
    env: dict[str, str], name: str, value: str
) -> None:
    env.update(key_service_env(**{name: value}))
    with pytest.raises(ConfigError) as caught:
        load(env)
    assert name in str(caught.value) and value not in str(caught.value)


# ── Manifests and choices ────────────────────────────────────────────────────────────────


def test_the_shipped_manifests_load() -> None:
    shipped = mcp.load_manifests()
    assert set(shipped) == {"tracker", "github", "openrouter"}
    assert shipped["tracker"].asks == ("origin",)
    assert shipped["tracker"].service["auth"] == "oauth"
    assert shipped["github"].asks == () and shipped["github"].service["auth"] == "github"
    # A personal API key pasted in Settings → MCP: nothing to ask at install.
    assert shipped["openrouter"].asks == () and shipped["openrouter"].service["auth"] == "bearer"
    assert shipped["openrouter"].service["url"] == "https://mcp.openrouter.ai/mcp"
    # Ori's install and eval instructions are for a person's own machine, not a gateway tool.
    tools = set(shipped["openrouter"].service["tools"])
    assert not {"install-ori-harness", "spawn-ori-eval"} & tools
    # Media come back as files beside the agent (the fork's gateway, cc24).
    assert {"generate-image", "generate-speech"} <= tools


def test_off_without_the_key_service_or_choices_and_nothing_mcp_reaches_the_app(
    env: dict[str, str],
) -> None:
    env.update(
        OMNIGENT_MCP_REGISTRY="/tmp/registry.yaml",
        OMNIGENT_MCP_OAUTH_STATE_SECRET=STATE_SECRET,
        OMNIGENT_MCP_ALLOW_PRIVATE_DESTINATIONS="1",
        CFO_MCP_CLIENT_SECRET_TRACKER=CLIENT_SECRET,
    )
    config = load(env)
    assert config.mcp.enabled is False
    assert config.mcp.off_reason == "no key service and no services chosen"
    assert config.mcp.summary() == "off: no key service and no services chosen"
    app_env = app_environment(config, env)
    for name in (
        "OMNIGENT_MCP_REGISTRY",
        "OMNIGENT_MCP_OAUTH_STATE_SECRET",
        "OMNIGENT_MCP_ALLOW_PRIVATE_DESTINATIONS",
        "CFO_MCP_CLIENT_SECRET_TRACKER",
    ):
        assert name not in app_env, name
    assert any("OMNIGENT_MCP_REGISTRY removed" in w for w in config.warnings)
    assert any("OMNIGENT_MCP_ALLOW_PRIVATE_DESTINATIONS removed" in w for w in config.warnings)


def test_the_page_is_on_with_the_key_service_and_no_choice(env: dict[str, str]) -> None:
    """D57: administrators add MCP servers on Omnigent's page; no service needs choosing."""
    env.update(
        key_service_env(
            OMNIGENT_ACCOUNTS_BASE_URL=PUBLIC_URL,
            OMNIGENT_MCP_OAUTH_STATE_SECRET=STATE_SECRET,
            OMNIGENT_MCP_ALLOW_PRIVATE_DESTINATIONS="1",
            CFO_MCP_CLIENT_SECRET_TRACKER=CLIENT_SECRET,
        )
    )
    config = load(env)
    assert config.mcp.enabled and config.mcp.admin_services and config.mcp.services == ()
    assert config.mcp.summary() == "on: the page"
    registry = config.mcp.registry
    assert registry is not None
    assert registry["public_url"] == PUBLIC_URL and registry["services"] == []
    # The shipped manifests the page can take, as starting points; not GitHub's own link.
    assert [p["id"] for p in registry["presets"]] == ["openrouter", "tracker"]
    app_env = app_environment(config, env)
    # The page's OAuth sign-ins are signed with Omnigent's state secret.
    assert app_env["OMNIGENT_MCP_OAUTH_STATE_SECRET"] == STATE_SECRET
    for name in (
        "CFO_MCP_SERVICES",
        "CFO_MCP_CLIENT_SECRET_TRACKER",
        "OMNIGENT_MCP_ALLOW_PRIVATE_DESTINATIONS",
        "OMNIGENT_MCP_REGISTRY",
    ):
        assert name not in app_env, name
    again = load(app_env, for_app=True)
    assert again.mcp == config.mcp and again.mcp.registry == config.mcp.registry


def test_omnigents_own_switch_turns_the_page_off(env: dict[str, str]) -> None:
    env.update(key_service_env(OMNIGENT_MCP_ADMIN_SERVICES="0"))
    config = load(env)
    assert config.mcp.enabled and not config.mcp.admin_services
    assert config.mcp.registry["presets"] == []
    assert config.mcp.summary() == "on: no page"
    # The app reads the same switch, and decides alike.
    app_env = app_environment(config, env)
    assert app_env["OMNIGENT_MCP_ADMIN_SERVICES"] == "0"
    assert load(app_env, for_app=True).mcp == config.mcp
    # Any other value leaves the page on, as in Omnigent.
    env["OMNIGENT_MCP_ADMIN_SERVICES"] = "1"
    assert load(env).mcp.admin_services


def test_the_presets_are_the_shipped_manifests_the_page_can_take() -> None:
    shipped = mcp.load_manifests()
    presets = {p["id"]: p for p in mcp.presets(shipped)}
    assert set(presets) == {"openrouter", "tracker"}
    openrouter = presets["openrouter"]
    service = shipped["openrouter"].service
    assert openrouter == {
        "id": "openrouter",
        "title": service["title"],
        "description": service["description"],
        "url": "https://mcp.openrouter.ai/mcp",
        "auth": "bearer",
        "tools": service["tools"],
        "timeout": 300,
    }
    tracker = presets["tracker"]
    # The origin is a placeholder for the administrator, which the rules refuse until replaced;
    # the endpoints that used it are discovered from the URL entered.
    assert tracker["url"] == "https://<your-host>/mcp"
    assert mcp.destination_problem(tracker["url"]) is not None
    assert tracker["oauth"] == {
        "scopes": ["tickets:read", "offline_access"],
        "client_id": "omnigent-local-demo",
    }
    # A chosen service is a registry entry, read-only on the page: no preset for it.
    assert [p["id"] for p in mcp.presets(shipped, ("openrouter",))] == ["tracker"]


def test_a_preset_never_carries_a_client_secret_or_an_asked_client(tmp_path: Path) -> None:
    directory = write_manifests(
        tmp_path / "services",
        manifest(
            "mail",
            asks=["client_id", "client_secret"],
            auth="oauth",
            oauth={
                "authorize_url": "https://login.example.com/authorize",
                "token_url": "https://login.example.com/token",
                "scopes": ["mail.read"],
                "resource": "https://mail.example.com/",
            },
        ),
        manifest("none-svc", auth="none"),
    )
    (mail, plain) = mcp.presets(mcp.load_manifests(directory))
    assert mail["id"] == "mail" and plain["id"] == "none-svc" and "oauth" not in plain
    # Fixed endpoints are offered; the client is the administrator's to enter (or registered).
    assert mail["oauth"] == {
        "scopes": ["mail.read"],
        "resource": "https://mail.example.com/",
        "authorize_url": "https://login.example.com/authorize",
        "token_url": "https://login.example.com/token",
    }


def test_the_test_service_with_its_origin(env: dict[str, str]) -> None:
    env.update(tracker_env())
    config = load(env)
    assert config.mcp.enabled and config.mcp.services == ("tracker",)
    registry = config.mcp.registry
    assert registry is not None
    assert registry["public_url"] == PUBLIC_URL
    (entry,) = registry["services"]
    assert entry["url"] == f"{ORIGIN}/mcp"
    assert entry["oauth"]["authorize_url"] == f"{ORIGIN}/authorize"
    assert entry["oauth"]["token_url"] == f"{ORIGIN}/token"
    assert "allow_http" not in entry and "client_secret_env" not in entry["oauth"]
    app_env = app_environment(config, env)
    assert app_env["OMNIGENT_MCP_OAUTH_STATE_SECRET"] == STATE_SECRET
    assert "OMNIGENT_MCP_REGISTRY" not in app_env
    assert STATE_SECRET not in litestream_environment(env).values()
    again = load(app_env, for_app=True)
    assert again.mcp == config.mcp and again.mcp.registry == config.mcp.registry


def test_an_oauth_client_the_manifest_asks_for(env: dict[str, str], tmp_path: Path) -> None:
    directory = write_manifests(
        tmp_path / "services",
        manifest(
            "mail",
            asks=["client_id", "client_secret"],
            auth="oauth",
            oauth={
                "authorize_url": "https://login.example.com/authorize",
                "token_url": "https://login.example.com/token",
                "scopes": ["mail.read"],
            },
        ),
        manifest("files", url="https://files.example.com/mcp"),
    )
    env.update(
        tracker_env(
            CFO_MCP_SERVICES=" mail , files ",
            CFO_MCP_CLIENT_ID_MAIL="client-123.apps.example",
            CFO_MCP_CLIENT_SECRET_MAIL=CLIENT_SECRET,
            CFO_MCP_CLIENT_SECRET_FILES="left-over-secret-0000",
        )
    )
    config = load(env, manifests_dir=directory)
    assert config.mcp.services == ("mail", "files")
    assert config.mcp.secret_env == ("CFO_MCP_CLIENT_SECRET_MAIL",)
    entry = config.mcp.registry["services"][0]
    assert entry["oauth"]["client_id"] == "client-123.apps.example"
    assert entry["oauth"]["client_secret_env"] == "CFO_MCP_CLIENT_SECRET_MAIL"
    assert CLIENT_SECRET not in json.dumps(config.mcp.registry) and CLIENT_SECRET not in repr(
        config
    )
    app_env = app_environment(config, env)
    assert app_env["CFO_MCP_CLIENT_SECRET_MAIL"] == CLIENT_SECRET
    # A service that asks for no secret never gets one, whatever is set.
    assert "CFO_MCP_CLIENT_SECRET_FILES" not in app_env


@pytest.mark.parametrize(
    ("over", "named"),
    [
        ({"CFO_MCP_SERVICES": "nonesuch"}, "CFO_MCP_SERVICES"),
        ({"CFO_MCP_SERVICES": "Tracker"}, "CFO_MCP_SERVICES"),
        ({"CFO_MCP_SERVICES": "tracker,tracker"}, "CFO_MCP_SERVICES"),
        ({"CFO_MCP_SERVICES": "tracker;rm -rf"}, "CFO_MCP_SERVICES"),
        ({"CFO_MCP_ORIGIN_TRACKER": ""}, "CFO_MCP_ORIGIN_TRACKER"),
        ({"CFO_MCP_ORIGIN_TRACKER": "http://mcp-demo.example.test"}, "CFO_MCP_ORIGIN_TRACKER"),
        ({"CFO_MCP_ORIGIN_TRACKER": "https://mcp-demo.example.test/x"}, "CFO_MCP_ORIGIN_TRACKER"),
        ({"CFO_MCP_ORIGIN_TRACKER": "https://10.1.2.3"}, "CFO_MCP_ORIGIN_TRACKER"),
        ({"CFO_MCP_ORIGIN_TRACKER": "https://localhost:8443"}, "CFO_MCP_ORIGIN_TRACKER"),
        ({"CFO_MCP_ORIGIN_TRACKER": "https://platform.internal"}, "CFO_MCP_ORIGIN_TRACKER"),
        ({"CFO_MCP_ORIGIN_TRACKER": "https://u:p@mcp.example.com"}, "CFO_MCP_ORIGIN_TRACKER"),
        ({"CFO_MCP_ORIGIN_TRACKER": "https://mcp.example.com?k=v"}, "CFO_MCP_ORIGIN_TRACKER"),
        ({"CFO_MCP_ORIGIN_TRACKER": "http://127.0.0.1:9"}, "CFO_MCP_ORIGIN_TRACKER"),
        ({"OMNIGENT_MCP_OAUTH_STATE_SECRET": "short"}, "OMNIGENT_MCP_OAUTH_STATE_SECRET"),
        (
            {"OMNIGENT_MCP_OAUTH_STATE_SECRET": STATE_SECRET + " with space"},
            "OMNIGENT_MCP_OAUTH_STATE_SECRET",
        ),
    ],
)
def test_a_malformed_choice_stops_the_start_without_repeating_it(
    env: dict[str, str], over: dict[str, str], named: str
) -> None:
    env.update(tracker_env(**over))
    with pytest.raises(ConfigError) as caught:
        load(env)
    message = str(caught.value)
    assert named in message
    for value in over.values():
        if value:
            assert value not in message
    assert STATE_SECRET not in message


@pytest.mark.parametrize(
    ("drop", "named"),
    [
        (("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY",), "signing pair"),
        (
            ("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY", "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID"),
            "signing pair",
        ),
        (("OMNIGENT_MCP_OAUTH_STATE_SECRET",), "OMNIGENT_MCP_OAUTH_STATE_SECRET"),
    ],
)
def test_a_missing_prerequisite_is_off_with_a_warning(
    env: dict[str, str], drop: tuple[str, ...], named: str
) -> None:
    """The page goes off too, so that Omnigent listing MCP always means every chosen service is
    on, which is what the installer's step and the update read (Codex WP8.14 r1-2)."""
    settings_ = tracker_env()
    for name in drop:
        del settings_[name]
    env.update(settings_)
    config = load(env)
    assert config.mcp.enabled is False and config.mcp.off_reason == "incomplete"
    assert config.mcp.summary() == "off: incomplete"
    (warning,) = [w for w in config.warnings if w.startswith("MCP services are off")]
    assert named in warning and STATE_SECRET not in warning and "page" in warning
    app_env = app_environment(config, env)
    assert "OMNIGENT_MCP_OAUTH_STATE_SECRET" not in app_env
    # The choice stays where the app reads it, so its own parse is off as well.
    assert app_env["CFO_MCP_SERVICES"] == "tracker"
    assert load(app_env, for_app=True).mcp.enabled is False


@pytest.mark.parametrize(
    "drop",
    [
        ("OMNIGENT_MCP_OAUTH_STATE_SECRET",),
        ("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY", "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID"),
    ],
)
def test_off_survives_the_app_process_own_parse(
    env: dict[str, str], tmp_path: Path, drop: tuple[str, ...]
) -> None:
    """MCP off for a missing prerequisite stays off in the app process, which parses the
    environment again without the secrets the image removed (Codex WP5.10 r1-2), the page with
    it (Codex WP8.14 r1-2)."""
    directory = write_manifests(
        tmp_path / "services",
        manifest(
            "mail",
            asks=["client_id", "client_secret"],
            auth="oauth",
            oauth={
                "authorize_url": "https://login.example.com/authorize",
                "token_url": "https://login.example.com/token",
            },
        ),
    )
    settings_ = tracker_env(
        CFO_MCP_SERVICES="mail",
        CFO_MCP_CLIENT_ID_MAIL="client-123",
        CFO_MCP_CLIENT_SECRET_MAIL=CLIENT_SECRET,
    )
    for name in drop:
        del settings_[name]
    env.update(settings_)
    config = load(env, manifests_dir=directory)
    assert config.mcp.enabled is False and config.mcp.off_reason == "incomplete"
    app_env = app_environment(config, env)
    for name in ("CFO_MCP_CLIENT_SECRET_MAIL", STATE_SECRET_NAME):
        assert name not in app_env, name
    # Without the client secret the app is never asked for it: the prerequisite is missing
    # first, and its parse is off too, not on for the page.
    again = load(app_env, for_app=True, manifests_dir=directory)
    assert again.mcp.enabled is False and again.mcp.off_reason == "incomplete"


def test_the_app_process_exits_78_on_a_setting_it_refuses(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from cfo_server import app as image_app

    for key in list(os.environ):
        if key.startswith(("OMNIGENT_", "CFO_")):
            monkeypatch.delenv(key)
    env.update(tracker_env(CFO_MCP_ORIGIN_TRACKER="http://10.0.0.1"))
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(SystemExit) as caught:
        image_app.main()
    assert caught.value.code == 78


def test_a_github_service_needs_no_key_service_and_warns_while_linking_is_off(
    env: dict[str, str],
) -> None:
    env["CFO_MCP_SERVICES"] = "github"
    config = load(env)
    assert config.mcp.enabled and config.key_service is None
    assert any("GitHub linking, which is off" in w for w in config.warnings)
    (entry,) = config.mcp.registry["services"]
    assert entry["auth"] == "github" and entry["url"] == "https://api.githubcopilot.com/mcp/"
    # GitHub's own link is no preset: the page cannot add it.
    assert "github" not in [p["id"] for p in config.mcp.registry["presets"]]
    assert config.mcp.summary() == "on: services github; the page"


def test_the_loopback_switch_is_for_tests_and_marks_the_entry(env: dict[str, str]) -> None:
    env.update(tracker_env(CFO_MCP_ORIGIN_TRACKER="http://127.0.0.1:18782"))
    with pytest.raises(ConfigError):
        load(env)
    env[mcp.ALLOW_LOOPBACK_ENV] = "1"
    config = load(env)
    entry = config.mcp.registry["services"][0]
    assert entry["url"] == "http://127.0.0.1:18782/mcp" and entry["allow_http"] is True
    assert config.mcp.allow_loopback


def test_a_plain_http_installation_gives_omnigent_no_callback_base(env: dict[str, str]) -> None:
    """A test's plain-http installation: the page's OAuth servers are refused by Omnigent itself
    (no public URL), and nothing else stops."""
    env.update(key_service_env())
    assert load(env).mcp.registry["public_url"] is None
    env["OMNIGENT_ACCOUNTS_BASE_URL"] = LOOPBACK_URL
    assert load(env).mcp.registry["public_url"] == LOOPBACK_URL


def test_an_oauth_service_needs_an_https_installation(env: dict[str, str]) -> None:
    env.update(tracker_env(OMNIGENT_ACCOUNTS_BASE_URL="http://omnigent.example.test"))
    with pytest.raises(ConfigError, match="OMNIGENT_ACCOUNTS_BASE_URL"):
        load(env)
    env["OMNIGENT_ACCOUNTS_BASE_URL"] = "http://127.0.0.1:8000"
    assert load(env).mcp.enabled


def test_omnigents_base_path_is_in_the_callbacks(env: dict[str, str]) -> None:
    env.update(tracker_env(OMNIGENT_WEB_BASE_PATH="/omnigent/"))
    assert load(env).mcp.registry["public_url"] == f"{PUBLIC_URL}/omnigent"


@pytest.mark.parametrize("url", VECTORS["allowed"])
def test_destination_rules_allow(url: str) -> None:
    assert mcp.destination_problem(url) is None


@pytest.mark.parametrize("url", VECTORS["refused"])
def test_destination_rules_refuse(url: str) -> None:
    problem = mcp.destination_problem(url)
    assert problem is not None
    if url:
        assert url not in problem


@pytest.mark.parametrize(
    ("data", "words"),
    [
        ({**manifest(), "extra": 1}, "exactly manifest, asks and service"),
        ({**manifest(), "manifest": 2}, "unknown manifest version"),
        (manifest(asks=["password"]), "asks"),
        (manifest(asks=["origin", "origin"]), "asks"),
        (manifest(allow_http=True), "may hold only"),
        (manifest(allowed_users=["x"]), "may hold only"),
        (manifest("other"), "the file's name"),
        (manifest("Bad_ID"), "service id"),
        (manifest(title=""), "title"),
        (manifest(auth="databricks"), "auth"),
        (manifest(tools=[]), "tools"),
        (manifest(tools=["a", "a"]), "tools"),
        (manifest(tools=["has space"]), "tools"),
        (manifest(timeout=0), "timeout"),
        (manifest(timeout=True), "timeout"),
        (manifest(url="http://mcp.example.com/mcp"), "destination rule"),
        (manifest(url="https://10.0.0.1/mcp"), "destination rule"),
        (manifest(url="${origin}/mcp"), "ask for origin"),
        (manifest(asks=["origin"]), "ask for origin"),
        (manifest(asks=["origin"], url="https://a.example/${origin}"), "only at its start"),
        (manifest(asks=["origin"], url="${origin}mcp"), "path after"),
        (manifest(asks=["client_id"]), "auth is not oauth"),
        (manifest(auth="oauth"), "exactly when its auth is oauth"),
        (
            manifest(
                auth="oauth",
                oauth={
                    "authorize_url": "https://a.example.com/a",
                    "token_url": "https://a.example.com/t",
                },
            ),
            "or ask for it",
        ),
        (
            manifest(
                auth="oauth",
                asks=["client_id"],
                oauth={
                    "authorize_url": "https://a.example.com/a",
                    "token_url": "https://a.example.com/t",
                    "client_id": "x",
                },
            ),
            "or ask for it",
        ),
        (
            manifest(
                auth="oauth",
                oauth={
                    "authorize_url": "https://a.example.com/a",
                    "token_url": "https://a.example.com/t",
                    "client_id": "x",
                    "client_secret_env": "AWS_SECRET_ACCESS_KEY",
                },
            ),
            "may hold only",
        ),
        (
            manifest(
                auth="oauth",
                oauth={
                    "authorize_url": "https://a.example.com/a",
                    "token_url": "https://127.0.0.1/t",
                    "client_id": "x",
                },
            ),
            "oauth.token_url breaks",
        ),
    ],
)
def test_a_broken_manifest_is_refused(data: dict, words: str) -> None:
    with pytest.raises(mcp.ManifestError) as caught:
        mcp.check_manifest(data, "svc")
    assert words in str(caught.value)


def test_a_broken_manifest_file_stops_the_start(env: dict[str, str], tmp_path: Path) -> None:
    directory = tmp_path / "services"
    directory.mkdir()
    (directory / "svc.json").write_text("{not json")
    env["CFO_MCP_SERVICES"] = "svc"
    with pytest.raises(ConfigError, match="not readable JSON"):
        load(env, manifests_dir=directory)


# ── Coupling to the pinned Omnigent ──────────────────────────────────────────────────────


@requires_omnigent
def test_the_names_are_omnigents_own(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import inspect

    from omnigent.server import mcp_registry as registry_module
    from omnigent.server.mcp_registry import (
        McpConnectionStore,
        McpOAuthHooks,
        McpRegistry,
        McpRegistryConfig,
        McpService,
        OAuthConfig,
    )

    source = inspect.getsource(registry_module)
    assert f'os.environ.get("{mcp.REGISTRY_ENV}")' in source
    assert f'os.environ.get("{mcp.STATE_SECRET_ENV}", "")' in source
    assert f"len(self.state_secret) < {mcp.MIN_STATE_SECRET_CHARS}" in source
    # The manifest's fields are McpService's, and the image's modes and IDs are among its own.
    assert set(McpService.model_fields) >= mcp._SERVICE_KEYS
    assert mcp._OAUTH_KEYS | {"client_secret_env"} <= set(OAuthConfig.model_fields)
    assert set(mcp.AUTH_MODES) <= set(McpService.model_fields["auth"].annotation.__args__)
    assert set(McpRegistryConfig.model_fields) == {"public_url", "services", "presets"}
    assert list(inspect.signature(McpRegistry).parameters) == [
        "config",
        "store",
        "service_store",
        "destination_policy",
        "refresh_seconds",
    ]
    # The page's switches are Omnigent's own names.
    from omnigent.server import mcp_destinations
    from omnigent.server.mcp_registry import McpServicePreset

    assert registry_module.ADMIN_SERVICES_ENV == mcp.ADMIN_SERVICES_ENV
    assert mcp_destinations.ALLOW_PRIVATE_DESTINATIONS_ENV == mcp.ALLOW_PRIVATE_ENV
    assert set(mcp.PAGE_AUTH_MODES) == set(
        McpServicePreset.model_fields["auth"].annotation.__args__
    )
    # Omnigent's page takes every preset the image offers.
    for preset in mcp.presets(mcp.load_manifests()):
        McpServicePreset.model_validate(preset)
    # Logins are the `connections` rows of provider mcp:<id>; pending flows mcp-pending:<id>.
    assert McpConnectionStore(object(), "tracker").provider == "mcp:tracker"  # type: ignore[arg-type]
    assert 'f"mcp-pending:{self.service.id}"' in source
    monkeypatch.setenv(mcp.STATE_SECRET_ENV, STATE_SECRET)
    config = McpRegistryConfig.model_validate(
        load({**base_env(tmp_path), **tracker_env()}).mcp.registry
    )
    hooks = McpOAuthHooks(McpRegistry(config, object()), config.services[0])  # type: ignore[arg-type]
    assert hooks.redirect_uri() == f"{PUBLIC_URL}/v1/connections/mcp-tracker/callback"


@requires_omnigent
def test_omnigent_accepts_what_the_image_builds_from_every_shipped_manifest(
    tmp_path: Path,
) -> None:
    from omnigent.server.mcp_registry import McpRegistryConfig

    env = {
        **base_env(tmp_path),
        **tracker_env(CFO_MCP_SERVICES=",".join(sorted(mcp.load_manifests()))),
    }
    config = load(env)
    parsed = McpRegistryConfig.model_validate(config.mcp.registry)
    assert [s.id for s in parsed.services] == list(config.mcp.services)
    assert all(not s.allow_http for s in parsed.services)


@requires_omnigent
@settings(max_examples=300, deadline=None)
@given(
    st.text(
        alphabet=st.sampled_from("abcxyz019-.:/@?#[]%_ \\HTPShtps"),
        min_size=0,
        max_size=40,
    ).map(lambda s: "https://" + s)
)
def test_the_image_never_allows_a_destination_omnigent_refuses(url: str) -> None:
    """The image's rules are at least Omnigent's own (``McpService.validate_service``)."""
    from omnigent.server.mcp_registry import McpService

    if mcp.destination_problem(url) is not None:
        return
    McpService(id="x", title="x", url=url, auth="none", tools=["t"])


# ── The page's destination rules (WP8.14) ───────────────────────────────────────────────


@requires_omnigent
@pytest.mark.parametrize("url", VECTORS["refused"])
def test_the_page_refuses_every_destination_the_platform_refuses(url: str) -> None:
    problem = mcp.PlatformDestinationPolicy().url_problem(url)
    assert problem is not None
    if url:
        assert url not in problem


@requires_omnigent
@pytest.mark.parametrize("url", VECTORS["allowed"])
def test_the_page_allows_what_the_platform_allows(url: str) -> None:
    assert mcp.PlatformDestinationPolicy().url_problem(url) is None


@requires_omnigent
@pytest.mark.parametrize(
    "url",
    [
        "https://router.home.arpa/mcp",
        "https://nas.localdomain/mcp",
        "https://mcp.example.com/" + "a" * 2048,
    ],
    ids=["home-arpa", "localdomain", "longer-than-2048"],
)
def test_the_page_also_keeps_omnigents_own_rules(url: str) -> None:
    """Hosts the platform's rules let through and Omnigent's default refuses: refused."""
    assert mcp.destination_problem(url) is None
    assert mcp.PlatformDestinationPolicy().url_problem(url) is not None


@requires_omnigent
@settings(max_examples=300, deadline=None)
@given(
    st.text(
        alphabet=st.sampled_from("abcxyz019-.:/@?#[]%_ \\HTPShtps"),
        min_size=0,
        max_size=40,
    ).map(lambda s: "https://" + s)
)
def test_the_page_rules_are_never_looser_than_either(url: str) -> None:
    from omnigent.server.mcp_destinations import DefaultMcpDestinationPolicy

    if mcp.PlatformDestinationPolicy().url_problem(url) is not None:
        return
    assert mcp.destination_problem(url) is None
    assert DefaultMcpDestinationPolicy().url_problem(url) is None


@requires_omnigent
@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "::1",
        "10.0.0.5",
        "172.16.3.4",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "fe80::1",
        "fc00::1",
        "::ffff:10.0.0.1",
        "64:ff9b::a00:1",
        "224.0.0.1",
    ],
)
def test_the_page_never_connects_to_a_private_address(address: str) -> None:
    import ipaddress

    assert not mcp.PlatformDestinationPolicy().address_allowed(ipaddress.ip_address(address))


@requires_omnigent
def test_the_page_connects_to_public_addresses_and_the_loopback_only_in_tests() -> None:
    import ipaddress

    policy, testing = mcp.PlatformDestinationPolicy(), mcp.PlatformDestinationPolicy(True)
    for address in ("1.1.1.1", "2606:4700:4700::1111"):
        assert policy.address_allowed(ipaddress.ip_address(address))
    assert not policy.address_allowed(ipaddress.ip_address("127.0.0.1"))
    assert testing.address_allowed(ipaddress.ip_address("127.0.0.1"))
    assert testing.address_allowed(ipaddress.ip_address("::1"))
    # The test switch is the loopback, nothing else private.
    assert not testing.address_allowed(ipaddress.ip_address("10.0.0.5"))
    assert testing.url_problem("http://127.0.0.1:8080/mcp") is None
    assert testing.url_problem("http://10.0.0.5/mcp") is not None
    assert policy.url_problem("http://127.0.0.1:8080/mcp") is not None


@requires_omnigent
def test_a_name_that_resolves_to_a_private_address_is_refused_at_save_and_at_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A public-looking name that resolves to a private address (or later rebinds to one)."""
    import ipaddress

    import httpx
    from omnigent.server import mcp_destinations

    async def private(host: str, port: int) -> list[object]:
        return [ipaddress.ip_address("10.0.0.5")]

    monkeypatch.setattr(mcp_destinations, "resolve", private)
    policy = mcp.PlatformDestinationPolicy()
    url = "https://mcp.example.com/mcp"
    assert policy.url_problem(url) is None
    with pytest.raises(mcp_destinations.McpDestinationError, match="resolves to an address"):
        asyncio.run(mcp_destinations.check_destination(policy, url, what="The server URL"))

    async def connect() -> None:
        async with mcp_destinations.guarded_client(policy) as client:
            await client.get(url)

    with pytest.raises(httpx.ConnectError) as caught:
        asyncio.run(connect())
    assert mcp_destinations.destination_refused(caught.value)


# ── The app, with a loopback key service and Omnigent's demo service ─────────────────────


@pytest.fixture
def demo_service(tmp_path: Path) -> Iterator[str]:
    if not DEMO_SERVICE.exists():
        pytest.skip("needs Omnigent's demo MCP service (examples/mcp-registry)")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    log = (tmp_path / "demo.log").open("w+")
    process = subprocess.Popen(
        [
            sys.executable,
            "-I",
            str(DEMO_SERVICE),
            "--port",
            str(port),
            "--redirect-uri",
            f"{LOOPBACK_URL}/v1/connections/mcp-tracker/callback",
        ],
        stdout=log,
        stderr=log,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        import httpx

        for _ in range(200):
            try:
                if httpx.get(url + "/health", timeout=0.5).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            assert process.poll() is None, "the demo service exited"
            time.sleep(0.05)
        yield url
    finally:
        process.terminate()
        process.wait(timeout=10)
        log.close()


def agent_bundle(name: str) -> bytes:
    """A minimal agent bundle: one ``config.yaml``."""
    body = (
        f"spec_version: 1\nname: {name}\n"
        "executor:\n  type: omnigent\n  config:\n    harness: codex\n"
    ).encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        info = tarfile.TarInfo("config.yaml")
        info.size = len(body)
        tar.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


def mint_runner_token(app: object, session_token: str) -> str:
    """A runner's delegated owner token, as Omnigent mints one for a runner it binds: under the
    owner's account generation (read here from the owner's own session token)."""
    import base64

    from omnigent.db.account_authority import account_authority_scope

    payload = session_token.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    with account_authority_scope(OWNER, claims["account_generation"]):
        token = app.state.mcp_registry_auth.mint_runner_token(OWNER, 600)  # type: ignore[attr-defined]
    assert token is not None
    return token


@requires_omnigent
def test_the_app_connects_calls_and_disconnects_through_the_key_service(
    tmp_path: Path, demo_service: str
) -> None:
    import httpx
    from omnigent.runner.proxy_mcp_manager import ProxyMcpManager
    from omnigent.spec.types import AgentSpec, MCPServerConfig

    stub = KeyServiceStub(SIGNING_KEY, SIGNING_KEY_ID)
    with stub.serve() as url:
        overrides = tracker_env(
            OMNIGENT_CREDENTIAL_HTTP_URL=url,
            CFO_ALLOW_LOOPBACK_KEY_SERVICE="1",
            CFO_MCP_ORIGIN_TRACKER=demo_service,
            CFO_ALLOW_LOOPBACK_MCP="1",
            OMNIGENT_ACCOUNTS_BASE_URL=LOOPBACK_URL,
        )
        with serve_app(tmp_path, overrides) as h:
            client = h.client
            registry = h.app.state.mcp_registry
            assert registry is not None and list(registry.services) == ["tracker"]
            info = client.get("/v1/info").json()
            assert info["enabled_connections"] == ["mcp"]
            assert (
                client.post(
                    "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
                ).status_code
                == 200
            )
            catalog = client.get("/v1/mcp-registry/services").json()["data"]
            assert [(s["id"], s["connected"]) for s in catalog] == [("tracker", False)]

            # Connect: Omnigent's redirect with PKCE, the provider's consent, the callback.
            started = client.get("/v1/connections/mcp-tracker/connect", follow_redirects=False)
            assert started.status_code in (302, 307), started.text
            location = urlsplit(started.headers["location"])
            assert f"{location.scheme}://{location.netloc}" == demo_service
            fields = {k: v[0] for k, v in parse_qs(location.query).items()}
            assert fields["code_challenge_method"] == "S256"
            assert fields["redirect_uri"] == f"{LOOPBACK_URL}/v1/connections/mcp-tracker/callback"
            consent = httpx.post(
                f"{demo_service}/authorize",
                data={**fields, "user": "alice@example.test"},
                follow_redirects=False,
            )
            assert consent.status_code == 303
            back = urlsplit(consent.headers["location"])
            done = client.get(f"{back.path}?{back.query}", follow_redirects=False)
            assert (
                done.status_code in (302, 307)
                and "mcp-tracker=connected" in done.headers["location"]
            ), done.headers
            # The login write was answered only once the replica held it.
            assert done.headers["x-cfo-durability"] == "confirmed"
            assert ("encrypt", 200) in stub.served
            catalog = client.get("/v1/mcp-registry/services").json()["data"]
            assert catalog[0]["connected"] is True
            tested = client.post("/v1/mcp-registry/services/tracker/test")
            assert tested.json() == {"tools": ["whoami", "read_ticket"]}, tested.text

            # Only ciphertext at rest, under this installation's record key.
            grant = registry.store.get(OWNER, "mcp:tracker", with_secret=True)
            access, refresh = grant.secret["access_token"], grant.secret["refresh_token"]
            for path in h.db_path.parent.glob(f"{h.db_path.name}*"):
                data = path.read_bytes()
                assert access.encode() not in data and refresh.encode() not in data, path
            with sqlite3.connect(h.db_path) as conn:
                rows = conn.execute(
                    "SELECT provider, secret_enc FROM connections ORDER BY provider"
                ).fetchall()
            assert [p for p, _ in rows] == ["mcp:tracker"]
            assert rows[0][1].startswith("oshttp1:cfo-test-records:1:")

            # A session with the service selected, and a runner's delegated token for it.
            created = client.post(
                "/v1/sessions",
                data={"metadata": json.dumps({"mcp_registry_services": ["tracker"]})},
                files={"bundle": ("agent.tar.gz", agent_bundle("mcp-test"), "application/gzip")},
            )
            assert created.status_code == 201, created.text
            sid = created.json()["session_id"]
            runner_token = mint_runner_token(h.app, h.login()["token"])
            client.cookies.clear()
            runner = {"Authorization": f"Bearer {runner_token}"}
            # A runner's token reaches the catalog too (Omnigent refuses delegated tokens only
            # under /auth and /oauth), and no answer ever carries the login.
            listed = client.get("/v1/mcp-registry/services", headers=runner)
            assert listed.status_code == 200
            assert access not in listed.text and refresh not in listed.text
            assert client.get("/auth/me", headers=runner).status_code in (401, 403, 404)

            spec = AgentSpec(
                spec_version=1,
                name="mcp-test",
                mcp_servers=[MCPServerConfig(name="tracker", transport="registry")],
            )

            async def runner_calls(*calls: tuple[str, dict], listed: bool = True) -> list[str]:
                """The runner's own client (ProxyMcpManager) with the runner's token."""
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=h.app), base_url=BASE_URL, headers=runner
                ) as http:
                    proxy = ProxyMcpManager(sid, http)
                    schemas = await proxy.schemas_for(spec)
                    # The allowlist: delete_ticket exists upstream and is never offered.
                    expected = {"tracker__whoami", "tracker__read_ticket"} if listed else set()
                    assert schemas.tool_names == expected
                    return [await proxy.call_tool(spec, name, args) for name, args in calls]

            whoami, ticket = asyncio.run(
                runner_calls(
                    ("tracker__whoami", {}),
                    ("tracker__read_ticket", {"ticket_id": "TEST-123"}),
                )
            )
            assert "alice@example.test" in whoami and "TEST-123" in ticket

            # A refresh, as when the access token expires: rotated, stored, still ciphertext.
            assert registry.store.update_secret(
                OWNER, "mcp:tracker", secret=grant.secret, metadata={"expires_at": 0}
            )
            check = registry.store.get(OWNER, "mcp:tracker", with_secret=True)
            assert check is not None and check.secret is not None, (check, stub.served[-3:])
            (refreshed,) = asyncio.run(runner_calls(("tracker__whoami", {})))
            assert '"refresh_count":1' in refreshed.replace(" ", "")
            after = registry.store.get(OWNER, "mcp:tracker", with_secret=True)
            assert after.secret["refresh_token"] != refresh

            # Disconnect, durably; the next call from the runner fails at once.
            assert (
                client.post(
                    "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
                ).status_code
                == 200
            )
            gone = client.delete("/v1/mcp-registry/services/tracker/connection")
            assert gone.status_code == 200 and gone.headers["x-cfo-durability"] == "confirmed"
            started_at = time.monotonic()
            (failed,) = asyncio.run(runner_calls(("tracker__whoami", {}), listed=False))
            assert "Connect this MCP account" in failed
            assert time.monotonic() - started_at < 5
            with sqlite3.connect(h.db_path) as conn:
                assert conn.execute("SELECT COUNT(*) FROM connections").fetchone() == (0,)


@requires_omnigent
def test_the_app_without_the_key_service_or_services_offers_no_mcp(tmp_path: Path) -> None:
    from cfo_server import app as image_app

    with serve_app(tmp_path) as h:
        assert getattr(h.app.state, "mcp_registry", None) is None
        assert "mcp" not in h.client.get("/v1/info").json()["enabled_connections"]
        assert image_app.admin_services_served(None) == []


def _admin_login(h: object) -> None:
    response = h.client.post(  # type: ignore[attr-defined]
        "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
    )
    assert response.status_code == 200, response.text


@requires_omnigent
def test_the_app_offers_the_page_with_the_platforms_rules_and_no_service_chosen(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import ipaddress

    from omnigent.server import mcp_destinations

    from cfo_server import app as image_app

    stub = KeyServiceStub(SIGNING_KEY, SIGNING_KEY_ID)
    with stub.serve() as url:
        overrides = key_service_env(
            OMNIGENT_CREDENTIAL_HTTP_URL=url,
            CFO_ALLOW_LOOPBACK_KEY_SERVICE="1",
            OMNIGENT_ACCOUNTS_BASE_URL=LOOPBACK_URL,
            OMNIGENT_MCP_OAUTH_STATE_SECRET=STATE_SECRET,
        )
        with serve_app(tmp_path, overrides) as h:
            registry = h.app.state.mcp_registry
            assert registry is not None and registry.services == {}
            assert registry.service_store is not None
            assert registry.destination_policy == mcp.PlatformDestinationPolicy()
            assert "mcp" in h.client.get("/v1/info").json()["enabled_connections"]
            _admin_login(h)
            presets = h.client.get("/v1/mcp-registry/admin/presets").json()["data"]
            assert [p["id"] for p in presets] == ["openrouter", "tracker"]
            assert presets[1]["url"] == "https://<your-host>/mcp"

            def create(service_url: str, **over: object) -> object:
                body = {"id": "svc", "title": "A server", "url": service_url, "auth": "none"}
                return h.client.post("/v1/mcp-registry/admin/services", json={**body, **over})

            # The platform's rules, before anything is stored, in words that never repeat it.
            for refused, words in [
                ("https://10.0.0.5/mcp", "not an IP address"),
                ("http://mcp.example.com/mcp", "https"),
                ("https://mcp.example.com/mcp?key=v", "query"),
                ("https://u:p@mcp.example.com/mcp", "credentials"),
                ("https://platform.internal/mcp", "internal"),
                ("https://router.home.arpa/mcp", "local or internal"),
                ("http://127.0.0.1:9/mcp", "https"),
                ("https://<your-host>/mcp", "host"),
            ]:
                answer = create(refused)
                assert answer.status_code == 400, (refused, answer.text)
                assert words in answer.json()["detail"], (refused, answer.text)
                assert refused not in answer.text

            # A public-looking name that resolves to a private address.
            async def private(host: str, port: int) -> list[object]:
                return [ipaddress.ip_address("192.168.1.10")]

            monkeypatch.setattr(mcp_destinations, "resolve", private)
            answer = create("https://mcp.example.com/mcp")
            assert answer.status_code == 400 and "resolves to an address" in answer.text
            assert image_app.admin_services_served(registry) == []


class _RedirectingService:
    """An MCP server that answers every request with a redirect to the same origin."""

    def __enter__(self) -> str:
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def _redirect(self) -> None:
                self.send_response(307)
                self.send_header("Location", "/mcp/")
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = do_POST = do_DELETE = _redirect  # noqa: N815

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __exit__(self, *exc: object) -> None:
        self.server.shutdown()
        self.server.server_close()


@requires_omnigent
def test_a_page_server_signs_in_calls_and_is_counted_and_a_chosen_one_hides_it(
    tmp_path: Path, demo_service: str
) -> None:
    """Omnigent's demo OAuth MCP service added on the page, as the owner would: discovery and
    dynamic client registration, the sign-in, the tools, a runner's call; every secret sealed
    by the key service; the count the update compares; then a chosen service of the same name."""
    import httpx
    from omnigent.runner.proxy_mcp_manager import ProxyMcpManager
    from omnigent.spec.types import AgentSpec, MCPServerConfig
    from omnigent.stores.mcp_service_store import SERVICE_PRINCIPAL

    from cfo_server import app as image_app
    from cfo_server.dbcheck import count_admin_services

    stub = KeyServiceStub(SIGNING_KEY, SIGNING_KEY_ID)
    with stub.serve() as url, _RedirectingService() as redirecting:
        overrides = key_service_env(
            OMNIGENT_CREDENTIAL_HTTP_URL=url,
            CFO_ALLOW_LOOPBACK_KEY_SERVICE="1",
            CFO_ALLOW_LOOPBACK_MCP="1",
            OMNIGENT_ACCOUNTS_BASE_URL=LOOPBACK_URL,
            OMNIGENT_MCP_OAUTH_STATE_SECRET=STATE_SECRET,
        )
        oauth = {"scopes": ["tickets:read", "offline_access"]}
        with serve_app(tmp_path, overrides) as h:
            client = h.client
            registry = h.app.state.mcp_registry
            _admin_login(h)
            created = client.post(
                "/v1/mcp-registry/admin/services",
                json={
                    "id": "tracker",
                    "title": "Demo work tracker",
                    "url": f"{demo_service}/mcp",
                    "auth": "oauth",
                    "oauth": oauth,
                },
            )
            assert created.status_code == 201, created.text
            # Stored only once the replica held it, with the registered client's secret.
            assert created.headers["x-cfo-durability"] == "confirmed"
            view = created.json()
            assert view["source"] == "admin" and view["draft"] is True
            assert view["oauth"]["registration"] == "dynamic"
            assert view["oauth"]["has_client_secret"] is True
            assert view["oauth"]["authorize_url"] == f"{demo_service}/authorize"

            # The sign-in: Omnigent's redirect with PKCE, the provider's consent, the callback.
            started = client.get("/v1/connections/mcp-tracker/connect", follow_redirects=False)
            assert started.status_code in (302, 307), started.text
            location = urlsplit(started.headers["location"])
            fields = {k: v[0] for k, v in parse_qs(location.query).items()}
            assert fields["redirect_uri"] == f"{LOOPBACK_URL}/v1/connections/mcp-tracker/callback"
            consent = httpx.post(
                f"{demo_service}/authorize",
                data={**fields, "user": "alice@example.test"},
                follow_redirects=False,
            )
            assert consent.status_code == 303, consent.text
            back = urlsplit(consent.headers["location"])
            done = client.get(f"{back.path}?{back.query}", follow_redirects=False)
            assert "mcp-tracker=connected" in done.headers["location"], done.headers
            assert done.headers["x-cfo-durability"] == "confirmed"

            # Every tool the server offers, with the administrator's login; agents get two.
            found = client.post("/v1/mcp-registry/admin/services/tracker/discover")
            assert found.status_code == 200, found.text
            names = {t["name"] for t in found.json()["tools"]}
            assert {"whoami", "read_ticket"} <= names
            saved = client.put(
                "/v1/mcp-registry/admin/services/tracker",
                json={
                    "title": "Demo work tracker",
                    "url": f"{demo_service}/mcp",
                    "auth": "oauth",
                    "oauth": oauth,
                    "tools": ["whoami", "read_ticket"],
                },
            )
            assert saved.status_code == 200, saved.text
            assert saved.json()["credentials_reset"] is False and saved.json()["draft"] is False
            assert saved.headers["x-cfo-durability"] == "confirmed"

            # Only ciphertext at rest, the client secret and the login alike.
            grant = registry.store.get(OWNER, "mcp:tracker", with_secret=True)
            secret = registry.store.get(SERVICE_PRINCIPAL, "mcp-client:tracker", with_secret=True)
            plaintexts = [
                grant.secret["access_token"],
                grant.secret["refresh_token"],
                secret.secret["client_secret"],
            ]
            # No answer carries the client secret either.
            listing = client.get("/v1/mcp-registry/admin/services")
            for answer in (created, saved, listing):
                assert secret.secret["client_secret"] not in answer.text
            for path in h.db_path.parent.glob(f"{h.db_path.name}*"):
                data = path.read_bytes()
                for plaintext in plaintexts:
                    assert plaintext.encode() not in data, path
            with sqlite3.connect(h.db_path) as conn:
                rows = conn.execute(
                    "SELECT provider, secret_enc FROM connections ORDER BY provider"
                ).fetchall()
            assert [p for p, _ in rows] == ["mcp-client:tracker", "mcp:tracker"]
            assert all(enc.startswith("oshttp1:cfo-test-records:1:") for _, enc in rows)

            # A runner's call through the gateway, with the page's allowlist.
            created_session = client.post(
                "/v1/sessions",
                data={"metadata": json.dumps({"mcp_registry_services": ["tracker"]})},
                files={"bundle": ("agent.tar.gz", agent_bundle("mcp-page"), "application/gzip")},
            )
            assert created_session.status_code == 201, created_session.text
            sid = created_session.json()["session_id"]
            runner = {"Authorization": f"Bearer {mint_runner_token(h.app, h.login()['token'])}"}
            # A runner's delegated token cannot manage the page's servers.
            refused = client.get("/v1/mcp-registry/admin/services", headers=runner)
            assert refused.status_code == 403
            spec = AgentSpec(
                spec_version=1,
                name="mcp-page",
                mcp_servers=[MCPServerConfig(name="tracker", transport="registry")],
            )

            async def whoami() -> tuple[set[str], str]:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=h.app), base_url=BASE_URL, headers=runner
                ) as http:
                    proxy = ProxyMcpManager(sid, http)
                    schemas = await proxy.schemas_for(spec)
                    return set(schemas.tool_names), await proxy.call_tool(
                        spec, "tracker__whoami", {}
                    )

            tools, answer = asyncio.run(whoami())
            assert tools == {"tracker__whoami", "tracker__read_ticket"}
            assert "alice@example.test" in answer

            # A server that redirects: Omnigent never follows it for a page server.
            _admin_login(h)
            moved = client.post(
                "/v1/mcp-registry/admin/services",
                json={
                    "id": "moved",
                    "title": "Moved",
                    "url": f"{redirecting}/mcp",
                    "auth": "none",
                    "tools": ["anything"],
                },
            )
            assert moved.status_code == 201, moved.text
            # No login to seal, yet held until the replica has it: a page server is a security
            # change (where agents' calls may go), as is its allowlist.
            assert moved.headers["x-cfo-durability"] == "confirmed"
            tested = client.post("/v1/mcp-registry/services/moved/test")
            assert tested.status_code == 502 and "redirect" in tested.text, tested.text

            # What the update compares: the database's count and what Omnigent serves.
            assert count_admin_services(h.db_path) == 2
            assert image_app.admin_services_served(registry) == ["moved", "tracker"]
            report = tmp_path / "report.json"
            image_app.write_mcp_report(report, registry)
            assert json.loads(report.read_text()) == {"served": ["moved", "tracker"]}
            removed = client.delete("/v1/mcp-registry/admin/services/moved")
            assert removed.status_code == 200 and removed.headers["x-cfo-durability"] == "confirmed"
            assert count_admin_services(h.db_path) == 1

        # A restart that turns on the shipped service of the same name: Omnigent hides the page's
        # server, and the count says the restart serves one fewer than the database holds.
        chosen = {
            **overrides,
            "CFO_MCP_SERVICES": "tracker",
            "CFO_MCP_ORIGIN_TRACKER": demo_service,
        }
        with serve_app(tmp_path, chosen) as h:
            registry = h.app.state.mcp_registry
            assert list(registry.services) == ["tracker"]
            assert count_admin_services(h.db_path) == 1
            assert image_app.admin_services_served(registry) == []
            _admin_login(h)
            (listed,) = h.client.get("/v1/mcp-registry/admin/services").json()["data"]
            assert listed["source"] == "config" and listed["editable"] is False
            # The page's login is never sent to the chosen service: it is not connected.
            catalog = h.client.get("/v1/mcp-registry/services").json()["data"]
            assert [(s["id"], s["connected"]) for s in catalog] == [("tracker", False)]


@requires_omnigent
def test_the_app_refuses_a_registry_omnigent_refuses(tmp_path: Path) -> None:
    from cfo_server import app as image_app

    config = load({**base_env(tmp_path), **tracker_env()})
    broken = image_config.ServerImageConfig(
        **{
            **config.__dict__,
            "mcp": mcp.McpRegistrySettings(
                enabled=True,
                off_reason=None,
                services=("tracker",),
                registry={"public_url": PUBLIC_URL, "services": [{"id": "tracker"}]},
            ),
        }
    )
    with pytest.raises(ConfigError) as caught:
        image_app.mcp_registry(broken, f"sqlite:///{tmp_path / 'x.db'}")
    assert "https://" not in str(caught.value) and "{" not in str(caught.value)
