"""Omnigent's GitHub linking in the server image (D22, WP5.9).

- **Settings.** On when, and only when, the GitHub App's three required settings and the key
  service's signing pair are all set; then exactly those (plus the App's ID and slug, and the key
  service's URL) reach the app, with the cipher pinned to ``http``. A half-configured App is off
  with a warning; a malformed value stops the start. The App's private key never reaches the app.
- **Coupling.** The names are the pinned Omnigent's own, and Omnigent reads what the image passes.
- **The app.** Built by the image's ``build_app`` against a loopback stand-in for the key
  service: the connect redirect, records stored only as ciphertext, the host broker's vend to a
  managed host's launch token, and unlinking.

The real key service (the platform Worker) is tested in workerd against the fork's vectors, and
end to end with this image's real Omnigent in ``tests/integration/github_linking``.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from cfo_server import config as image_config
from cfo_server.config import (
    CREDENTIAL_CIPHER_ENV,
    DEFAULT_KEY_SERVICE_URL,
    GITHUB_APP_ENV,
    KEY_SERVICE_ENV,
    ConfigError,
    app_environment,
    litestream_environment,
    load,
)

from conftest import BASE_URL, OWNER, OWNER_PASSWORD, base_env, requires_omnigent, serve_app
from key_service_stub import KeyServiceStub

# Synthetic values only.
CLIENT_ID = "Iv23liCfoTestClient0"
CLIENT_SECRET = "cfo-test-github-client-secret-0000000000"
SIGNING_KEY = "cfo-test-key-service-signing-key-000000000"
SIGNING_KEY_ID = "ks-test-1"
PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----cfo-test-----END RSA PRIVATE KEY-----"
CALLBACK = f"{BASE_URL}/v1/connections/github/callback"


def linking_env(**over: str) -> dict[str, str]:
    """The settings the installer sets for GitHub linking (as the container receives them)."""
    env = {
        "OMNIGENT_GITHUB_APP_CLIENT_ID": CLIENT_ID,
        "OMNIGENT_GITHUB_APP_CLIENT_SECRET": CLIENT_SECRET,
        "OMNIGENT_GITHUB_APP_REDIRECT_URI": CALLBACK,
        "OMNIGENT_GITHUB_APP_ID": "123456",
        "OMNIGENT_GITHUB_APP_SLUG": "omnigent-cfotest",
        "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY": SIGNING_KEY,
        "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID": SIGNING_KEY_ID,
    }
    env.update(over)
    return env


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return base_env(tmp_path)


# ── Settings ─────────────────────────────────────────────────────────────────────────────


def test_off_without_settings_and_every_integration_variable_removed(env: dict[str, str]) -> None:
    env.update(
        {
            "OMNIGENT_CREDENTIAL_HTTP_URL": "http://elsewhere.example/ks",
            "OMNIGENT_CREDENTIAL_CIPHER": "kms",
            "OMNIGENT_DATABRICKS_CLIENT_ID": "synthetic",
        }
    )
    config = load(env)
    assert config.github.enabled is False
    assert config.github.off_reason == "not configured"
    app_env = app_environment(config, env)
    for name in ("OMNIGENT_CREDENTIAL_HTTP_URL", "OMNIGENT_CREDENTIAL_CIPHER"):
        assert name not in app_env
        assert any(name in w for w in config.warnings)


def test_on_passes_exactly_the_app_and_key_service_settings(env: dict[str, str]) -> None:
    env.update(linking_env())
    env.update(
        {
            "OMNIGENT_GITHUB_APP_PRIVATE_KEY": PRIVATE_KEY,
            "OMNIGENT_GITHUB_APP_PRIVATE_KEY_PATH": "/etc/somewhere.pem",
            "OMNIGENT_GITHUB_APP_WEBHOOK_SECRET": "cfo-test-webhook",
            "OMNIGENT_CREDENTIAL_CIPHER": "kms",
            "OMNIGENT_CREDENTIAL_KMS_KEY_ID": "synthetic",
            "VAULT_TOKEN": "synthetic",
            "OMNIGENT_DATABRICKS_CLIENT_ID": "synthetic",
            "NO_PROXY": "localhost",
        }
    )
    config = load(env)
    assert config.github.enabled and config.github.off_reason is None
    assert config.github.key_service_url == DEFAULT_KEY_SERVICE_URL
    assert SIGNING_KEY not in repr(config) and CLIENT_SECRET not in repr(config)
    app_env = app_environment(config, env)
    for name in GITHUB_APP_ENV:
        assert app_env[name] == env[name], name
    assert app_env["OMNIGENT_CREDENTIAL_HTTP_URL"] == "http://platform.internal/key-service/v1"
    assert app_env["OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY"] == SIGNING_KEY
    assert app_env["OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID"] == SIGNING_KEY_ID
    assert app_env[CREDENTIAL_CIPHER_ENV] == "http"
    for removed in (
        "OMNIGENT_GITHUB_APP_PRIVATE_KEY",
        "OMNIGENT_GITHUB_APP_PRIVATE_KEY_PATH",
        "OMNIGENT_GITHUB_APP_WEBHOOK_SECRET",
        "OMNIGENT_CREDENTIAL_KMS_KEY_ID",
        "VAULT_TOKEN",
        "OMNIGENT_DATABRICKS_CLIENT_ID",
    ):
        assert removed not in app_env, removed
        assert any(removed in w for w in config.warnings), removed
    assert PRIVATE_KEY not in app_env.values()
    # The key service is reached directly, never through a proxy.
    assert app_env["NO_PROXY"] == "localhost,platform.internal"
    assert app_env["no_proxy"] == "platform.internal"
    # Litestream never receives any of it.
    ls_env = litestream_environment(env)
    for value in (CLIENT_SECRET, SIGNING_KEY, PRIVATE_KEY):
        assert value not in ls_env.values()
    # The app process reads the same settings back from its own environment.
    again = load(app_env, for_app=True)
    assert again.github == config.github


@pytest.mark.parametrize(
    "missing",
    [
        ("OMNIGENT_GITHUB_APP_CLIENT_SECRET",),
        ("OMNIGENT_GITHUB_APP_REDIRECT_URI",),
        ("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY",),
        ("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY", "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID"),
    ],
)
def test_half_configured_is_off_with_a_warning_naming_what_is_missing(
    env: dict[str, str], missing: tuple[str, ...]
) -> None:
    linking = linking_env()
    for name in missing:
        del linking[name]
    env.update(linking)
    config = load(env)
    assert config.github.enabled is False
    assert config.github.off_reason == "incomplete"
    (warning,) = [w for w in config.warnings if w.startswith("GitHub linking is off")]
    for name in missing:
        assert name in warning
    app_env = app_environment(config, env)
    for name in (*GITHUB_APP_ENV, *KEY_SERVICE_ENV, CREDENTIAL_CIPHER_ENV):
        assert name not in app_env, name
    for value in linking.values():
        assert value not in warning


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("OMNIGENT_GITHUB_APP_CLIENT_ID", "has space"),
        ("OMNIGENT_GITHUB_APP_CLIENT_SECRET", "has\x01control"),
        ("OMNIGENT_GITHUB_APP_REDIRECT_URI", "https://evil.example/v1/connections/github/callback"),
        ("OMNIGENT_GITHUB_APP_REDIRECT_URI", f"{BASE_URL}/v1/connections/github/callback/"),
        ("OMNIGENT_GITHUB_APP_REDIRECT_URI", f"{BASE_URL}/elsewhere"),
        ("OMNIGENT_GITHUB_APP_ID", "12a"),
        ("OMNIGENT_GITHUB_APP_SLUG", "Not_A_Slug"),
        ("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY", "too-short-0000"),
        ("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY", f"{SIGNING_KEY} with spaces"),
        ("OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID", "bad id"),
        ("OMNIGENT_CREDENTIAL_HTTP_URL", "http://elsewhere.example/key-service/v1"),
        ("OMNIGENT_CREDENTIAL_HTTP_URL", "http://127.0.0.1:8787/key-service/v1"),
        ("OMNIGENT_CREDENTIAL_HTTP_URL", "http://user:pw@platform.internal/key-service/v1"),
        ("OMNIGENT_CREDENTIAL_HTTP_URL", "http://platform.internal/key-service/v1?x=1"),
        ("OMNIGENT_CREDENTIAL_HTTP_URL", "ftp://platform.internal/key-service/v1"),
        ("OMNIGENT_CREDENTIAL_HTTP_URL", "http://platform.internal:0/key-service/v1"),
        ("OMNIGENT_CREDENTIAL_HTTP_URL", "http://[broken/"),
    ],
)
def test_a_malformed_value_stops_the_start_without_repeating_it(
    env: dict[str, str], name: str, value: str
) -> None:
    env.update(linking_env(**{name: value}))
    with pytest.raises(ConfigError) as caught:
        load(env)
    assert name in str(caught.value)
    for secret in (CLIENT_SECRET, SIGNING_KEY, "pw@"):
        assert secret not in str(caught.value)


def test_the_callback_follows_omnigents_base_path_and_a_loopback_service_is_for_tests(
    env: dict[str, str],
) -> None:
    env.update(
        linking_env(
            OMNIGENT_WEB_BASE_PATH="/omnigent/",
            OMNIGENT_GITHUB_APP_REDIRECT_URI=f"{BASE_URL}/omnigent/v1/connections/github/callback",
            OMNIGENT_CREDENTIAL_HTTP_URL="http://127.0.0.1:8787/key-service/v1/",
            CFO_ALLOW_LOOPBACK_KEY_SERVICE="1",
        )
    )
    config = load(env)
    assert config.github.enabled
    assert config.github.key_service_url == "http://127.0.0.1:8787/key-service/v1"
    env["OMNIGENT_CREDENTIAL_HTTP_URL"] = "https://platform.internal:8443/ks"
    assert load(env).github.key_service_url == "https://platform.internal:8443/ks"


# ── Coupling to the pinned Omnigent ──────────────────────────────────────────────────────


@requires_omnigent
def test_the_names_are_omnigents_own() -> None:
    from omnigent.stores.credential_store import http_cipher, secret_cipher

    assert http_cipher.CREDENTIAL_HTTP_URL_ENV_VAR == image_config.KEY_SERVICE_URL_ENV
    assert (
        http_cipher.CREDENTIAL_HTTP_SIGNING_KEY_ENV_VAR == image_config.KEY_SERVICE_SIGNING_KEY_ENV
    )
    assert (
        http_cipher.CREDENTIAL_HTTP_SIGNING_KEY_ID_ENV_VAR
        == image_config.KEY_SERVICE_SIGNING_KEY_ID_ENV
    )
    assert http_cipher.MIN_SIGNING_KEY_BYTES == image_config.MIN_KEY_SERVICE_SIGNING_KEY_BYTES
    assert http_cipher.PROTOCOL == "omnigent-key-service-v1"
    assert secret_cipher.CREDENTIAL_CIPHER_ENV_VAR == CREDENTIAL_CIPHER_ENV
    assert "http" in secret_cipher._cipher_builders()


@requires_omnigent
def test_omnigent_reads_the_app_the_image_passes(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.server.github_app import GitHubAppConfig
    from omnigent.stores.credential_store import build_secret_cipher
    from omnigent.stores.credential_store.http_cipher import HttpSecretCipher

    env.update(linking_env(OMNIGENT_GITHUB_APP_PRIVATE_KEY=PRIVATE_KEY))
    config = load(env)
    app_env = app_environment(config, env)
    import os

    for key in list(os.environ):
        if key.startswith(("OMNIGENT_", "VAULT_", "AWS_KMS")):
            monkeypatch.delenv(key)
    for key, value in app_env.items():
        monkeypatch.setenv(key, value)
    github = GitHubAppConfig.from_env()
    assert github is not None
    assert (github.client_id, github.client_secret, github.redirect_uri) == (
        CLIENT_ID,
        CLIENT_SECRET,
        CALLBACK,
    )
    assert github.app_id == "123456" and github.slug == "omnigent-cfotest"
    assert github.private_key is None
    assert github.install_url == "https://github.com/apps/omnigent-cfotest/installations/new"
    cipher = build_secret_cipher()
    assert isinstance(cipher, HttpSecretCipher)
    assert SIGNING_KEY not in repr(cipher)


# ── The app, with a loopback key service ─────────────────────────────────────────────────


@requires_omnigent
def test_the_app_links_github_through_the_key_service(tmp_path: Path) -> None:
    from omnigent.server.github_app import GitHubTokenSet
    from omnigent.stores.host_store import HostStore

    stub = KeyServiceStub(SIGNING_KEY, SIGNING_KEY_ID)
    access = "cfo-test-ghu-" + "a" * 24
    refresh = "cfo-test-ghr-" + "b" * 24
    with stub.serve() as url:
        overrides = linking_env(
            OMNIGENT_CREDENTIAL_HTTP_URL=url, CFO_ALLOW_LOOPBACK_KEY_SERVICE="1"
        )
        with serve_app(tmp_path, overrides) as h:
            client = h.client
            assert h.app.state.github_store is not None
            info = client.get("/v1/info").json()
            assert "github" in info["enabled_connections"]
            signed_in = client.post(
                "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
            )
            assert signed_in.status_code == 200
            # Connect: Omnigent's redirect to GitHub, with this App and its callback.
            started = client.get("/v1/connections/github/connect", follow_redirects=False)
            assert started.status_code == 302
            location = urlsplit(started.headers["location"])
            assert (location.scheme, location.netloc, location.path) == (
                "https",
                "github.com",
                "/login/oauth/authorize",
            )
            query = parse_qs(location.query)
            assert query["client_id"] == [CLIENT_ID]
            assert query["redirect_uri"] == [CALLBACK]
            assert query["state"]
            # A completed callback stores the token set; stored here directly, since the
            # exchange with GitHub is the end-to-end test's.
            h.app.state.github_store.upsert(
                OWNER,
                github_login="octo-cfotest",
                github_user_id=4242,
                tokens=GitHubTokenSet(
                    access_token=access,
                    refresh_token=refresh,
                    expires_at=int(time.time()) + 8 * 3600,
                    refresh_token_expires_at=int(time.time()) + 180 * 86400,
                    scopes="",
                ),
            )
            assert ("encrypt", 200) in stub.served
            status = client.get("/v1/connections/github/status").json()
            assert status["connected"] is True and status["login"] == "octo-cfotest"
            # Only ciphertext at rest: the database and its WAL.
            for path in h.db_path.parent.glob(f"{h.db_path.name}*"):
                data = path.read_bytes()
                assert access.encode() not in data and refresh.encode() not in data, path
            with sqlite3.connect(h.db_path) as conn:
                (stored,) = conn.execute("SELECT secret_enc FROM connections").fetchone()
            assert stored.startswith("oshttp1:cfo-test-records:1:")
            # The host broker vends the access token to a managed host's launch token only.
            host_id = "host_" + "c" * 32
            launch = "cfo-test-launch-" + "d" * 32
            HostStore(f"sqlite:///{h.db_path}").register_managed_host(
                host_id=host_id,
                name="managed-cfotest",
                user_id=OWNER,
                token=launch,
                provider="cloudflare",
                sandbox_id="sb-cfotest",
                token_expires_at=int(time.time()) + 3600,
            )
            route = f"/v1/hosts/{host_id}/credentials/github"
            client.cookies.clear()
            assert client.get(route).status_code == 401
            assert client.get(route, headers={"X-Omnigent-Host-Token": "wrong"}).status_code == 401
            vend = client.get(route, headers={"X-Omnigent-Host-Token": launch})
            assert vend.headers["cache-control"] == "no-store"
            body = vend.json()
            assert body["connected"] is True and body["token"] == access
            assert refresh not in vend.text, "the refresh token stays on the server"
            # A key-service outage is not "unlinked" for the record: it is kept.
            stub.fail_with = 503
            assert client.get(route, headers={"X-Omnigent-Host-Token": launch}).json() == {
                "connected": False
            }
            stub.fail_with = None
            assert (
                client.get(route, headers={"X-Omnigent-Host-Token": launch}).json()["token"]
                == access
            )
            # Unlinking stops the vend.
            signed_in = client.post(
                "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
            )
            assert signed_in.status_code == 200
            # Unlinking is a security write: answered only once the replica holds it.
            unlinked = client.post("/v1/connections/github/disconnect")
            assert unlinked.status_code == 200
            assert unlinked.headers["x-cfo-durability"] == "confirmed"
            client.cookies.clear()
            after = client.get(route, headers={"X-Omnigent-Host-Token": launch}).json()
            assert after == {"connected": False}


@requires_omnigent
def test_the_app_without_linking_offers_no_github(tmp_path: Path) -> None:
    with serve_app(tmp_path) as h:
        assert getattr(h.app.state, "github_store", None) is None
        assert "github" not in h.client.get("/v1/info").json()["enabled_connections"]


@requires_omnigent
def test_every_write_omnigents_store_makes_to_a_link_is_held_by_the_barrier(
    tmp_path: Path,
) -> None:
    """Linking, relinking (another GitHub identity), a token refresh and unlinking, as the real
    store issues them: each is a security write the response barrier holds (Codex WP5.9 r1-1)."""
    from omnigent.server.github_app import GitHubTokenSet
    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    from cfo_server.barrier import classify

    seen: list[tuple[str, int]] = []

    def record(conn, cursor, statement, params, context, executemany) -> None:  # noqa: ANN001
        del conn, params, context, executemany
        if "connections" in statement.lower():
            seen.append((statement, cursor.rowcount))

    def tokens(n: int) -> GitHubTokenSet:
        return GitHubTokenSet(
            access_token=f"cfo-test-ghu-{n}",
            refresh_token=f"cfo-test-ghr-{n}",
            expires_at=int(time.time()) + 3600,
            refresh_token_expires_at=None,
            scopes="",
        )

    stub = KeyServiceStub(SIGNING_KEY, SIGNING_KEY_ID)
    with stub.serve() as url:
        overrides = linking_env(
            OMNIGENT_CREDENTIAL_HTTP_URL=url, CFO_ALLOW_LOOPBACK_KEY_SERVICE="1"
        )
        with serve_app(tmp_path, overrides) as h:
            store = h.app.state.github_store
            event.listen(Engine, "after_cursor_execute", record)
            try:
                store.upsert(OWNER, github_login="first", github_user_id=1, tokens=tokens(1))
                store.upsert(OWNER, github_login="second", github_user_id=2, tokens=tokens(2))
                store.update_tokens(OWNER, tokens(3))
                assert (
                    h.client.post(
                        "/auth/login", json={"username": OWNER, "password": OWNER_PASSWORD}
                    ).status_code
                    == 200
                )
                assert h.client.post("/v1/connections/github/disconnect").status_code == 200
            finally:
                event.remove(Engine, "after_cursor_execute", record)
    writes = [
        (s.split()[0].upper(), classify(s, n))
        for s, n in seen
        if s.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
    ]
    assert [verb for verb, _ in writes] == ["INSERT", "UPDATE", "UPDATE", "DELETE"], writes
    assert all(table == "connections" for _, table in writes), writes
