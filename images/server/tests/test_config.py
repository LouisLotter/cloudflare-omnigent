"""Deployment settings: restrictive defaults, strict parsing, pinned values."""

from __future__ import annotations

from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from cfo_server import config as image_config
from cfo_server.config import (
    LITESTREAM_ENV,
    ConfigError,
    app_environment,
    litestream_environment,
    load,
)

from conftest import base_env


@pytest.fixture
def env(tmp_path: Path) -> dict[str, str]:
    return base_env(tmp_path)


def test_unset_settings_are_the_restrictive_defaults(env: dict[str, str]) -> None:
    config = load(env)
    assert config.sharing.sharing_mode == "off"
    assert config.sharing.public_sharing is False
    assert config.sharing.public_sharing_max_level == "read"
    assert config.sharing.default_public_sessions == "off"
    assert config.admins == () and config.allowed_domains == ()
    assert config.ws_allowed_origins == ("http://testserver",)
    assert config.sandbox_server_url == "http://omnigent.internal"
    assert config.transcript_barrier_timeout_s < image_config.SENDER_ACK_TIMEOUT_S
    assert config.final_sync_timeout_s > 30  # raised above Litestream's 30 s default


def test_sync_interval_defaults_to_200ms_and_can_be_set(env: dict[str, str]) -> None:
    # WP2.5 on R2: 200 ms halves the barrier wait's p95 and p99 and adds no idle request.
    assert load(env).replica.sync_interval == "200ms"
    assert load({**env, "CFO_SYNC_INTERVAL": "1s"}).replica.sync_interval == "1s"


@pytest.mark.parametrize(
    ("name", "value", "fragment"),
    [
        ("CFO_INSTALLATION_INITIALIZED", "", "CFO_INSTALLATION_INITIALIZED is required"),
        ("CFO_INSTALLATION_INITIALIZED", "maybe", "true or false"),
        ("OMNIGENT_SHARING_MODE", "everyone", "OMNIGENT_SHARING_MODE"),
        ("OMNIGENT_PUBLIC_SHARING", "yes please", "OMNIGENT_PUBLIC_SHARING"),
        ("OMNIGENT_PUBLIC_SHARING_MAX_LEVEL", "manage", "OMNIGENT_PUBLIC_SHARING_MAX_LEVEL"),
        ("OMNIGENT_DEFAULT_PUBLIC_SESSIONS", "sandbox", "pinned to off"),
        ("OMNIGENT_DEFAULT_PUBLIC_SESSIONS", "all", "pinned to off"),
        ("OMNIGENT_AUTH_PROVIDER", "header", "pinned to accounts"),
        ("OMNIGENT_AUTH_ENABLED", "0", "cannot turn authentication off"),
        ("OMNIGENT_ACCOUNTS_BASE_URL", "", "OMNIGENT_ACCOUNTS_BASE_URL is required"),
        ("OMNIGENT_ACCOUNTS_BASE_URL", "ftp://x", "http or https"),
        ("OMNIGENT_ACCOUNTS_COOKIE_SECRET", "", "OMNIGENT_ACCOUNTS_COOKIE_SECRET"),
        ("OMNIGENT_ACCOUNTS_COOKIE_SECRET", "ab" * 31, "64 hex"),
        ("OMNIGENT_ACCOUNTS_COOKIE_SECRET", "zz" * 40, "64 hex"),
        ("OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME", "", "INIT_ADMIN_USERNAME is required"),
        ("OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD", "short", "at least 8 characters"),
        ("CFO_REPLICA_URL", "", "CFO_REPLICA_URL is required"),
        ("CFO_REPLICA_URL", "gs://bucket/x", "s3://"),
        ("CFO_REPLICA_URL", "s3:///no-bucket", "name a bucket"),
        ("CFO_ALLOW_FILE_REPLICA", "0", "tests only"),
        ("CFO_SYNC_INTERVAL", "fast", "CFO_SYNC_INTERVAL"),
        ("CFO_SYNC_INTERVAL", "0s", "CFO_SYNC_INTERVAL"),
        ("CFO_TRANSCRIPT_BARRIER_TIMEOUT_S", "5", "less than 5"),
        ("CFO_TRANSCRIPT_BARRIER_TIMEOUT_S", "0", "more than 0"),
        ("CFO_RESPONSE_BARRIER_TIMEOUT_S", "nan", "more than 0"),
        ("CFO_RESTORE_DEADLINE_S", "-1", "more than 0"),
        ("CFO_INSTALLATION_ID", "installation-1", "not an installation ID"),
        ("CFO_INSTALLATION_ID", "ins_0123456789abcdefghjkmnpqrsU", "not an installation ID"),
        ("OMNIGENT_WS_ALLOWED_ORIGINS", "javascript:alert(1)", "http or https"),
        ("CFO_OMNIGENT_ADMINS", "a b", "invalid entry"),
    ],
)
def test_malformed_settings_refuse_to_start(
    env: dict[str, str], name: str, value: str, fragment: str
) -> None:
    env[name] = value
    with pytest.raises(ConfigError) as excinfo:
        load(env)
    assert fragment in str(excinfo.value)


def test_s3_replica_needs_its_bucket_credentials(env: dict[str, str]) -> None:
    env["CFO_REPLICA_URL"] = "s3://cfo-db/omnigent"
    with pytest.raises(ConfigError, match="LITESTREAM_ACCESS_KEY_ID"):
        load(env)
    env["LITESTREAM_ACCESS_KEY_ID"] = "synthetic-id"
    env["LITESTREAM_SECRET_ACCESS_KEY"] = "synthetic-secret"
    env["CFO_REPLICA_ENDPOINT"] = "https://r2.example.test"
    replica = load(env).replica
    assert replica.url == "s3://cfo-db/omnigent" and replica.region == "auto"


@settings(deadline=None)
@given(
    mode=st.sampled_from(["off", "OFF", " read_only ", "Restricted_Read_Only", "on"]),
    public=st.sampled_from(["0", "false", "no", "OFF", "1", "true", "Yes", "on"]),
)
def test_sharing_values_parse_case_insensitively(mode: str, public: str) -> None:
    env = base_env(Path("/nonexistent"))
    env["OMNIGENT_SHARING_MODE"] = mode
    env["OMNIGENT_PUBLIC_SHARING"] = public
    sharing = load(env).sharing
    assert sharing.sharing_mode == mode.strip().lower()
    assert sharing.public_sharing is (public.lower() in {"1", "true", "yes", "on"})


def test_app_environment_pins_and_scrubs(env: dict[str, str]) -> None:
    env.update(
        {
            "OMNIGENT_FEATURES": "harness_install,usage_page",
            "OMNIGENT_HARNESS_INSTALL_ENABLED": "1",
            "OMNIGENT_DATABRICKS_CLIENT_ID": "synthetic",
            "OMNIGENT_CREDENTIAL_CIPHER": "kms",
            "OMNIGENT_CREDENTIAL_KMS_KEY_ID": "synthetic",
            "OMNIGENT_CREDENTIAL_VAULT_KEY": "synthetic",
            "VAULT_TOKEN": "synthetic",
            "OMNIGENT_GITHUB_APP_CLIENT_ID": "synthetic",
            "OMNIGENT_ADMIN_LIST_PATH": "/tmp/elsewhere",
            "LITESTREAM_ACCESS_KEY_ID": "synthetic-id",
            "LITESTREAM_SECRET_ACCESS_KEY": "synthetic-secret",
            "AWS_ACCESS_KEY_ID": "synthetic-artifacts-id",
            "DATABASE_URL": "postgresql://elsewhere",
            "OMNIGENT_AUTH_PROVIDER": "accounts",
        }
    )
    config = load(env)
    assert any("OMNIGENT_FEATURES" in w for w in config.warnings)
    assert any("OMNIGENT_DATABRICKS_CLIENT_ID" in w for w in config.warnings)
    app_env = app_environment(config, env)
    assert app_env["OMNIGENT_FEATURES"] == ""
    assert app_env["OMNIGENT_AUTH_PROVIDER"] == "accounts"
    assert app_env["DATABASE_URL"] == "sqlite:////data/omnigent.db"
    assert app_env["OMNIGENT_DEFAULT_PUBLIC_SESSIONS"] == "off"
    for removed in (
        "OMNIGENT_HARNESS_INSTALL_ENABLED",
        "OMNIGENT_DATABRICKS_CLIENT_ID",
        "OMNIGENT_CREDENTIAL_CIPHER",
        "OMNIGENT_CREDENTIAL_KMS_KEY_ID",
        "OMNIGENT_CREDENTIAL_VAULT_KEY",
        "VAULT_TOKEN",
        "OMNIGENT_GITHUB_APP_CLIENT_ID",
        "OMNIGENT_ADMIN_LIST_PATH",
        "LITESTREAM_ACCESS_KEY_ID",
        "LITESTREAM_SECRET_ACCESS_KEY",
    ):
        assert removed not in app_env, removed
    assert app_env["AWS_ACCESS_KEY_ID"] == "synthetic-artifacts-id"  # the artifact store's
    ls_env = litestream_environment(env)
    assert "AWS_ACCESS_KEY_ID" not in ls_env
    assert ls_env["LITESTREAM_SECRET_ACCESS_KEY"] == "synthetic-secret"


def test_litestream_gets_the_replica_credentials_and_nothing_else(env: dict[str, str]) -> None:
    """An allowlist (G2-SEC-001): the bootstrap password, the cookie secret, the launcher's key
    and the artifact store's credentials never reach Litestream's processes."""
    secrets = {
        "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD": "synthetic-bootstrap-password",
        "OMNIGENT_ACCOUNTS_COOKIE_SECRET": "ab" * 32,
        "CFO_LAUNCHER_SIGNING_KEY": "k" * 40,
        "CFO_LAUNCHER_SIGNING_KEY_ID": "k-test",
        "AWS_ACCESS_KEY_ID": "synthetic-artifacts-id",
        "AWS_SECRET_ACCESS_KEY": "synthetic-artifacts-secret",
        "AWS_SESSION_TOKEN": "synthetic-artifacts-token",
        "VAULT_TOKEN": "synthetic-vault",
        "SOMETHING_NEW_SECRET": "synthetic-future-secret",
    }
    env.update(secrets)
    env.update(
        {
            "LITESTREAM_ACCESS_KEY_ID": "synthetic-id",
            "LITESTREAM_SECRET_ACCESS_KEY": "synthetic-secret",
            "PATH": "/usr/bin:/bin",
            "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
        }
    )
    ls_env = litestream_environment(env)
    assert set(ls_env) <= set(LITESTREAM_ENV)
    assert ls_env == {
        "LITESTREAM_ACCESS_KEY_ID": "synthetic-id",
        "LITESTREAM_SECRET_ACCESS_KEY": "synthetic-secret",
        "PATH": "/usr/bin:/bin",
        "SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
    }
    for value in secrets.values():
        assert value not in ls_env.values()
    # The app keeps what it needs, and never the replica's credentials.
    app_env = app_environment(load(env), env)
    assert app_env["OMNIGENT_ACCOUNTS_COOKIE_SECRET"] == "ab" * 32
    assert app_env["CFO_LAUNCHER_SIGNING_KEY"] == "k" * 40
    assert "LITESTREAM_SECRET_ACCESS_KEY" not in app_env


def test_the_app_process_parses_without_the_replica_credentials(env: dict[str, str]) -> None:
    env["CFO_REPLICA_URL"] = "s3://cfo-db/omnigent"
    env["LITESTREAM_ACCESS_KEY_ID"] = "synthetic-id"
    env["LITESTREAM_SECRET_ACCESS_KEY"] = "synthetic-secret"
    config = load(env)
    app_env = app_environment(config, env)
    app_config = load(app_env, for_app=True)
    assert app_config.replica is None
    assert app_config.sharing == config.sharing
    assert app_config.transcript_barrier_timeout_s == config.transcript_barrier_timeout_s


def test_installation_id_is_optional_and_checked(env: dict[str, str]) -> None:
    assert load(env).installation_id is None
    env["CFO_INSTALLATION_ID"] = "ins_0123456789abcdefghjkmnpqrs"
    assert load(env).installation_id == "ins_0123456789abcdefghjkmnpqrs"


def test_bootstrap_credentials_are_reported(env: dict[str, str]) -> None:
    assert load(env).bootstrap_credentials is True
    del env["OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD"]
    del env["OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME"]
    assert load(env).bootstrap_credentials is False  # allowed: the database may have an owner
