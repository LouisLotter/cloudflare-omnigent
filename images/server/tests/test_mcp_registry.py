"""Omnigent's MCP registry in the server image (WP5.10).

- **The key service** is on whenever its signing pair is set, with or without GitHub, and is
  then the credential store's only cipher.
- **Manifests and choices.** The shipped manifests load; the installation's choices
  (``CFO_MCP_SERVICES`` and each service's asked values) become Omnigent's registry
  configuration, with the destination rules; a malformed one stops the start (exit 78) without
  repeating a value; a missing prerequisite turns MCP off with a warning.
- **Coupling.** The names are the pinned Omnigent's own, and Omnigent accepts what the image
  builds; the image's destination rules are never looser than Omnigent's.
- **The app.** Built by the image's ``build_app`` with a loopback key service and Omnigent's demo
  OAuth MCP service: connect, the login only as ciphertext, a runner's call through the gateway,
  a refresh, disconnect and the call failing at once; every login write held by the barrier.

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
    assert set(shipped) == {"tracker", "github"}
    assert shipped["tracker"].asks == ("origin",)
    assert shipped["tracker"].service["auth"] == "oauth"
    assert shipped["github"].asks == () and shipped["github"].service["auth"] == "github"


def test_off_without_choices_and_nothing_mcp_reaches_the_app(env: dict[str, str]) -> None:
    env.update(
        key_service_env(
            OMNIGENT_MCP_REGISTRY="/tmp/registry.yaml",
            OMNIGENT_MCP_OAUTH_STATE_SECRET=STATE_SECRET,
            CFO_MCP_CLIENT_SECRET_TRACKER=CLIENT_SECRET,
        )
    )
    config = load(env)
    assert config.mcp.enabled is False and config.mcp.off_reason == "no services chosen"
    app_env = app_environment(config, env)
    for name in (
        "OMNIGENT_MCP_REGISTRY",
        "OMNIGENT_MCP_OAUTH_STATE_SECRET",
        "CFO_MCP_CLIENT_SECRET_TRACKER",
    ):
        assert name not in app_env, name
    assert any("OMNIGENT_MCP_REGISTRY removed" in w for w in config.warnings)


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
    settings_ = tracker_env()
    for name in drop:
        del settings_[name]
    env.update(settings_)
    config = load(env)
    assert config.mcp.enabled is False and config.mcp.off_reason == "incomplete"
    (warning,) = [w for w in config.warnings if w.startswith("MCP services are off")]
    assert named in warning and STATE_SECRET not in warning
    assert "OMNIGENT_MCP_OAUTH_STATE_SECRET" not in app_environment(config, env)


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
    environment again without the secrets the image removed (Codex WP5.10 r1-2)."""
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
    for name in ("CFO_MCP_SERVICES", "CFO_MCP_CLIENT_SECRET_MAIL", STATE_SECRET_NAME):
        assert name not in app_env, name
    again = load(app_env, for_app=True, manifests_dir=directory)
    assert again.mcp.enabled is False


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


def test_the_loopback_switch_is_for_tests_and_marks_the_entry(env: dict[str, str]) -> None:
    env.update(tracker_env(CFO_MCP_ORIGIN_TRACKER="http://127.0.0.1:18782"))
    with pytest.raises(ConfigError):
        load(env)
    env[mcp.ALLOW_LOOPBACK_ENV] = "1"
    entry = load(env).mcp.registry["services"][0]
    assert entry["url"] == "http://127.0.0.1:18782/mcp" and entry["allow_http"] is True


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
    assert set(McpRegistryConfig.model_fields) == {"public_url", "services"}
    assert list(inspect.signature(McpRegistry).parameters) == ["config", "store"]
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
def test_the_app_without_services_offers_no_mcp(tmp_path: Path) -> None:
    with serve_app(tmp_path, key_service_env()) as h:
        assert getattr(h.app.state, "mcp_registry", None) is None
        assert "mcp" not in h.client.get("/v1/info").json()["enabled_connections"]


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
