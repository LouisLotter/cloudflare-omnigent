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
            "OMNIGENT_RUNNER_DISCONNECT_GRACE_S": "90",
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
    assert app_env["OMNIGENT_RUNNER_DISCONNECT_GRACE_S"] == "150"
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


# ── The artifact store (G2-DUR-001) ───────────────────────────────────────────────────


def _s3_artifacts(env: dict[str, str]) -> dict[str, str]:
    """``env`` with an S3 replica and an S3 artifact store in a bucket of its own."""
    del env["CFO_ALLOW_LOCAL_ARTIFACTS"]
    env.update(
        {
            "CFO_REPLICA_URL": "s3://cfo-db/omnigent",
            "LITESTREAM_ACCESS_KEY_ID": "synthetic-replica-id",
            "LITESTREAM_SECRET_ACCESS_KEY": "synthetic-replica-secret",
            "OMNIGENT_ARTIFACT_URI": "s3://cfo-artifacts",
            "AWS_ACCESS_KEY_ID": "synthetic-artifacts-id",
            "AWS_SECRET_ACCESS_KEY": "synthetic-artifacts-secret",
            "AWS_ENDPOINT_URL_S3": "https://r2.example.test",
            "AWS_REGION": "auto",
        }
    )
    return env


def test_artifacts_never_fall_back_to_the_containers_disk(env: dict[str, str]) -> None:
    """Unset is a refusal, initialized or not: files on the disk die at every restart."""
    del env["CFO_ALLOW_LOCAL_ARTIFACTS"]
    for initialized in ("false", "true"):
        env["CFO_INSTALLATION_INITIALIZED"] = initialized
        with pytest.raises(ConfigError, match="OMNIGENT_ARTIFACT_URI is required"):
            load(env)
        with pytest.raises(ConfigError, match="OMNIGENT_ARTIFACT_URI is required"):
            load({**env, "OMNIGENT_ARTIFACT_URI": "  "})
        with pytest.raises(ConfigError, match="CFO_ALLOW_LOCAL_ARTIFACTS must be true or false"):
            load({**env, "CFO_ALLOW_LOCAL_ARTIFACTS": "sure"})
        with pytest.raises(ConfigError, match="OMNIGENT_ARTIFACT_URI is required"):
            load({**env, "CFO_ALLOW_LOCAL_ARTIFACTS": "false"})


def test_local_artifacts_only_with_the_test_switch_and_a_warning(env: dict[str, str]) -> None:
    config = load(env)
    assert config.artifacts.uri is None and config.artifacts.bucket is None
    assert any("CFO_ALLOW_LOCAL_ARTIFACTS" in w for w in config.warnings)
    # A blank or stale value never reaches Omnigent, which would read it as a store.
    app_env = app_environment(config, {**env, "OMNIGENT_ARTIFACT_URI": " "})
    assert "OMNIGENT_ARTIFACT_URI" not in app_env


@pytest.mark.parametrize(
    ("value", "fragment"),
    [
        ("gs://cfo-artifacts", "must be s3://"),
        ("/data/artifacts", "must be s3://"),
        ("s3://", "valid bucket name"),
        ("s3:///prefix", "valid bucket name"),
        ("s3://Cfo_Artifacts", "valid bucket name"),
        ("s3://ab", "valid bucket name"),
        ("s3://cfo-artifacts?x=1", "nothing else"),
        ("s3://cfo-artifacts#x", "nothing else"),
        ("s3://key:secret@cfo-artifacts", "nothing else"),
        ("s3://cfo-artifacts:9000", "nothing else"),
        ("s3://cfo-artifacts/../replica", "plain path"),
        ("s3://cfo-artifacts/a/./b", "plain path"),
        ("s3://cfo-db/artifacts", "bucket of its own"),
        # Codex G2-DUR-001 r1-2: values a URL parser accepts and Omnigent's own parser does not.
        ("S3://cfo-artifacts", "must be s3://"),
        ("s3://cfo-artifacts?", "nothing else"),
        ("s3://cfo-artifacts#", "nothing else"),
        ("s3://cfo-artifacts/x?", "plain path"),
        ("s3://cfo-artifacts/x#y", "plain path"),
        ("s3://cfo-artifacts/a b", "plain path"),
        ("s3://cfo-artifacts/a\\b", "plain path"),
        ("s3://[broken", "nothing else"),
        ("s3:/cfo-artifacts", "must be s3://"),
    ],
)
def test_malformed_artifact_uris_refuse_to_start(
    env: dict[str, str], value: str, fragment: str
) -> None:
    env = _s3_artifacts(env)
    env["OMNIGENT_ARTIFACT_URI"] = value
    with pytest.raises(ConfigError) as excinfo:
        load(env)
    assert fragment in str(excinfo.value)


@pytest.mark.parametrize(
    ("name", "value", "fragment"),
    [
        ("AWS_ACCESS_KEY_ID", "", "AWS_ACCESS_KEY_ID is required"),
        ("AWS_SECRET_ACCESS_KEY", " ", "AWS_SECRET_ACCESS_KEY is required"),
        ("AWS_ENDPOINT_URL_S3", "r2.example.test", "http or https"),
        ("AWS_ENDPOINT_URL_S3", "https://id:key@r2.example.test", "must not carry credentials"),
    ],
)
def test_the_s3_artifact_store_needs_its_credentials_and_a_sound_endpoint(
    env: dict[str, str], name: str, value: str, fragment: str
) -> None:
    env = _s3_artifacts(env)
    env[name] = value
    with pytest.raises(ConfigError) as excinfo:
        load(env)
    assert fragment in str(excinfo.value)
    assert "id:key" not in str(excinfo.value)  # a credential in the endpoint is never echoed


def test_s3_artifacts_reach_the_app_only_and_the_app_reads_them_alike(
    env: dict[str, str],
) -> None:
    """Custody (G2-SEC-001): the artifact credentials reach the app, never Litestream; the
    replica's reach Litestream, never the app. One R2 token may cover both buckets, but each
    use has its own variables."""
    env = _s3_artifacts(env)
    env["OMNIGENT_ARTIFACT_URI"] = "s3://cfo-artifacts/omnigent"
    env["CFO_ALLOW_LOCAL_ARTIFACTS"] = "true"  # the store, when named, wins over the switch
    config = load(env)
    assert config.artifacts.uri == "s3://cfo-artifacts/omnigent"
    assert config.artifacts.bucket == "cfo-artifacts"
    assert not any("CFO_ALLOW_LOCAL_ARTIFACTS" in w for w in config.warnings)
    app_env = app_environment(config, env)
    assert app_env["OMNIGENT_ARTIFACT_URI"] == "s3://cfo-artifacts/omnigent"
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "AWS_REGION"):
        assert app_env[name] == env[name], name
    assert not {"LITESTREAM_ACCESS_KEY_ID", "LITESTREAM_SECRET_ACCESS_KEY"} & set(app_env)
    ls_env = litestream_environment(env)
    assert not {n for n in ls_env if n.startswith("AWS_") or n.startswith("OMNIGENT_")}
    assert ls_env["LITESTREAM_SECRET_ACCESS_KEY"] == "synthetic-replica-secret"
    assert "synthetic-artifacts-secret" not in ls_env.values()
    app_config = load(app_env, for_app=True)
    assert app_config.artifacts == config.artifacts
    # Equal values in both pairs (one token for both buckets) change nothing of that.
    same = {
        **env,
        "AWS_ACCESS_KEY_ID": "synthetic-one",
        "LITESTREAM_ACCESS_KEY_ID": "synthetic-one",
    }
    assert "AWS_ACCESS_KEY_ID" not in litestream_environment(same)
    assert "LITESTREAM_ACCESS_KEY_ID" not in app_environment(load(same), same)


SECRET = "synthetic-url-secret"


@pytest.mark.parametrize(
    "name",
    [
        "OMNIGENT_ARTIFACT_URI",
        "AWS_ENDPOINT_URL_S3",
        "AWS_ENDPOINT_URL",
        "CFO_REPLICA_URL",
        "CFO_REPLICA_ENDPOINT",
        "OMNIGENT_ACCOUNTS_BASE_URL",
        "OMNIGENT_WS_ALLOWED_ORIGINS",
        "CFO_SANDBOX_SERVER_URL",
    ],
)
@pytest.mark.parametrize(
    "value",
    [
        f"https://synthetic-id:{SECRET}@cfo-artifacts.example.test",
        f"ftp://synthetic-id:{SECRET}@cfo-artifacts.example.test",
        f"s3://synthetic-id:{SECRET}@cfo-artifacts",
        f"http://[{SECRET}",
        f"http://host.example.test:{SECRET}",
    ],
)
def test_a_url_setting_is_refused_without_repeating_it(
    env: dict[str, str], name: str, value: str
) -> None:
    """A mistaken URL may carry credentials: the refusal names the variable, never the value,
    and a URL the parser cannot read is a refusal (exit 78), not a crash (Codex G2-DUR-001 r1-3)."""
    env = _s3_artifacts(env)
    env[name] = value
    with pytest.raises(ConfigError) as excinfo:
        load(env)
    assert name in str(excinfo.value)
    assert SECRET not in str(excinfo.value)


def test_the_fallback_endpoint_is_checked_too(env: dict[str, str]) -> None:
    """Without AWS_ENDPOINT_URL_S3, Omnigent's store uses AWS_ENDPOINT_URL (Codex r2-1)."""
    env = _s3_artifacts(env)
    del env["AWS_ENDPOINT_URL_S3"]
    assert load({**env, "AWS_ENDPOINT_URL": "https://r2.example.test"}).artifacts.uri
    with pytest.raises(ConfigError, match="AWS_ENDPOINT_URL must be an http or https URL"):
        load({**env, "AWS_ENDPOINT_URL": f"ftp://synthetic-id:{SECRET}@host.example.test"})
    # The test switch's disk store reads no endpoint: nothing to check there.
    local = base_env(Path("/nonexistent"))
    assert load({**local, "AWS_ENDPOINT_URL": "not a url"}).artifacts.uri is None


def test_omnigents_parser_reads_every_accepted_uri_as_the_image_does(env: dict[str, str]) -> None:
    """The image's acceptance against Omnigent's ``_parse_s3_uri`` rule (the literal ``s3://``,
    then the bucket up to the first ``/``), restated here and pinned to the source by
    ``test_coupling.py``."""
    env = _s3_artifacts(env)
    for uri in ("s3://cfo-artifacts", "s3://cfo-artifacts/", "s3://cfo.artifacts/a/b-c_d"):
        config = load({**env, "OMNIGENT_ARTIFACT_URI": uri})
        bucket, _, prefix = uri[len("s3://") :].partition("/")
        assert config.artifacts.bucket == bucket and config.artifacts.uri == uri
        assert "?" not in prefix and "#" not in prefix


def test_the_store_asks_checksums_only_where_s3_requires_them(env: dict[str, str]) -> None:
    env = _s3_artifacts(env)
    app_env = app_environment(load(env), env)
    assert app_env["AWS_REQUEST_CHECKSUM_CALCULATION"] == "when_required"
    assert app_env["AWS_RESPONSE_CHECKSUM_VALIDATION"] == "when_required"
    # A deployment may name others; the disk never gets them.
    named = {**env, "AWS_REQUEST_CHECKSUM_CALCULATION": "when_supported"}
    assert app_environment(load(named), named)["AWS_REQUEST_CHECKSUM_CALCULATION"] == (
        "when_supported"
    )
    local = base_env(Path("/nonexistent"))
    assert "AWS_REQUEST_CHECKSUM_CALCULATION" not in app_environment(load(local), local)


def test_the_app_process_checks_the_artifacts_without_the_replica(env: dict[str, str]) -> None:
    env = _s3_artifacts(env)
    app_env = app_environment(load(env), env)
    del app_env["AWS_SECRET_ACCESS_KEY"]
    with pytest.raises(ConfigError, match="AWS_SECRET_ACCESS_KEY is required"):
        load(app_env, for_app=True)
