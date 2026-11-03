"""Tests that pin the image's coupling points to Omnigent and Litestream.

The image calls Omnigent only through interfaces, but some of those are not documented
contracts (design, "Omnigent changes by stage": the image is coupled to the Docker
entrypoint's structure and to the barrier's table names). A fork bump or a Litestream bump
that moves any of them fails here, so the image is reviewed before it ships.
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from cfo_server import app as image_app
from cfo_server import config as image_config
from cfo_server.barrier import IGNORED_UPDATE_COLUMNS, SECURITY_TABLES
from cfo_server.dbcheck import INITIALIZED_SQL, check_database

from conftest import DOCKER_ENTRYPOINT, IMAGE_DIR, base_env, requires_omnigent

#: SHA-256 of the functions of Omnigent's ``deploy/docker/entrypoint.py`` that
#: ``cfo_server.app`` mirrors, at the pinned fork commit ``af3e49de2``. When this changes,
#: compare the new source with ``cfo_server.app.build_app`` and ``main``, then update it.
MIRRORED_FUNCTIONS = {
    "build_app": "2cbeb381ab22bf37d6fa82d90455a34188dd953a1a4dceec8a62a4324078df1f",
    "main": "4ed86ded57c1096d3b4530b347b6c0242601d3025799a23c639d64df1aa2f0de",
}
#: Helpers the image calls, with the parameters it passes.
USED_HELPERS = {
    "_resolve_config": [],
    "run_migrations": ["database_url"],
    "_select_artifact_store": ["resolved_config"],
    "_build_routing": ["cfg", "server_llm"],
    "_resolve_execution_timeout": ["cfg"],
    "log_capabilities": ["sandbox_config", "github_config", "github_store"],
}
#: Keyword arguments the image passes to create_app beyond those Omnigent's build_app passes.
PLATFORM_KWARGS = {
    "sharing_mode",
    "public_sharing",
    "public_sharing_max_level",
    "default_public_sessions",
    "feature_flags",
    "durability_barrier",
    # Omnigent's own server command passes it; its Docker entrypoint does not (WP5.10).
    "mcp_registry",
}
LITESTREAM_VERSION = "0.5.17"


def _create_app_kwargs(source: str, function: str) -> set[str]:
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == function:
            for call in ast.walk(node):
                if (
                    isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Name)
                    and call.func.id == "create_app"
                ):
                    return {kw.arg for kw in call.keywords if kw.arg}
    raise AssertionError(f"no create_app call in {function}")


@requires_omnigent
def test_mirrored_docker_entrypoint_functions_are_unchanged() -> None:
    ep = image_app.load_docker_entrypoint(DOCKER_ENTRYPOINT)
    for name, digest in MIRRORED_FUNCTIONS.items():
        source = inspect.getsource(getattr(ep, name))
        assert hashlib.sha256(source.encode()).hexdigest() == digest, (
            f"Omnigent's Docker entrypoint changed {name}; review cfo_server.app against it"
        )


@requires_omnigent
def test_used_docker_entrypoint_helpers_exist_with_their_parameters() -> None:
    ep = image_app.load_docker_entrypoint(DOCKER_ENTRYPOINT)
    for name, params in USED_HELPERS.items():
        signature = inspect.signature(getattr(ep, name))
        assert list(signature.parameters)[: len(params)] == params, name


@requires_omnigent
def test_image_passes_everything_omnigents_build_app_passes_plus_the_platform_kwargs() -> None:
    upstream = _create_app_kwargs(DOCKER_ENTRYPOINT.read_text(), "build_app")
    ours = _create_app_kwargs(inspect.getsource(image_app), "build_app")
    assert upstream <= ours, f"missing: {sorted(upstream - ours)}"
    assert ours - upstream == PLATFORM_KWARGS


@requires_omnigent
def test_create_app_accepts_every_keyword_the_image_passes() -> None:
    from omnigent.server.app import create_app

    parameters = inspect.signature(create_app).parameters
    for name in _create_app_kwargs(inspect.getsource(image_app), "build_app"):
        assert name in parameters, name


@requires_omnigent
def test_omnigent_takes_the_pinned_runner_grace(monkeypatch: pytest.MonkeyPatch) -> None:
    # Omnigent ignores, with only a warning, a value outside its lease and its ceiling.
    from omnigent.server.routes._sessions import common

    name = common.RUNNER_DISCONNECT_GRACE_ENV_VAR
    monkeypatch.setenv(name, image_config.PINNED_ENV[name])
    common.resolve_runner_disconnect_grace_s.cache_clear()
    try:
        grace = common.resolve_runner_disconnect_grace_s()
    finally:
        common.resolve_runner_disconnect_grace_s.cache_clear()
    assert grace == float(image_config.RUNNER_DISCONNECT_GRACE_S)
    assert grace > 100  # RC-21's bound for a reconnect that overlaps a capture pause


#: What Omnigent's server does with its product analytics at start (``create_app``'s lifespan
#: calls ``init_client``), in a process of its own: the opt-out is read once and cached.
_ANALYTICS_PROBE = (
    "import json\n"
    "from omnigent.telemetry import client\n"
    "client.init_client(config={})\n"
    "started = client.get_client() is not None\n"
    "print(json.dumps({'disabled': client.is_disabled(), 'started': started}))\n"
)


def _analytics_at_start(env: dict[str, str]) -> dict[str, bool]:
    out = subprocess.run(
        [sys.executable, "-I", "-c", _ANALYTICS_PROBE],
        env=env,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    ).stdout
    return json.loads(out.strip().splitlines()[-1])


@requires_omnigent
def test_omnigents_analytics_never_start_with_the_app_environment(tmp_path: Path) -> None:
    """D49: with the environment the image gives the app, Omnigent's own analytics client never
    starts (so it neither fetches the vendor's configuration nor sends an event) and writes no
    installation ID. Without the pinned opt-out the same environment would start it: the check
    is not vacuous. The clean environment holds none of the CI markers Omnigent also obeys."""
    home = tmp_path / "home"
    home.mkdir()
    container = {"PATH": "/opt/venv/bin:/usr/bin:/bin", "HOME": str(home), **base_env(tmp_path)}
    # An installation that asks for analytics still gets them off.
    container["OMNIGENT_ANALYTICS"] = "1"
    app_env = image_config.app_environment(image_config.load(container), container)
    assert app_env["OMNIGENT_ANALYTICS"] == "0"
    assert not set(app_env) & {"CI", "PYTEST_CURRENT_TEST", "DO_NOT_TRACK", "DISABLE_TELEMETRY"}

    assert _analytics_at_start(app_env) == {"disabled": True, "started": False}
    assert list(tmp_path.rglob("telemetry.json")) == []

    # The control: the same environment without the opt-out starts the client. Its configuration
    # fetch goes to a closed local port, never to the vendor.
    control = {k: v for k, v in app_env.items() if k != "OMNIGENT_ANALYTICS"}
    control["OMNIGENT_TELEMETRY_CONFIG_URL"] = "http://127.0.0.1:9"
    assert _analytics_at_start(control) == {"disabled": False, "started": True}


@requires_omnigent
def test_durability_hook_is_the_one_core_change_14_documents() -> None:
    from omnigent.server import durability

    assert set(inspect.signature(durability.durability_barrier).parameters) == {"app"}
    assert inspect.iscoroutinefunction(durability.commits_durable)
    from omnigent.server.app import create_app

    assert "durability_barrier" in inspect.signature(create_app).parameters


@requires_omnigent
def test_barrier_tables_and_columns_exist_in_omnigents_schema() -> None:
    from omnigent.db.db_models import OmnigentBase

    tables = OmnigentBase.metadata.tables
    for table in SECURITY_TABLES:
        assert table in tables, table
    for table, columns in IGNORED_UPDATE_COLUMNS.items():
        for column in columns:
            assert column in tables[table].columns, f"{table}.{column}"
    # The launch-token re-arm writes these; they must stay in a barriered table.
    for column in ("token_hash", "token_expires_at", "deleted_at", "launch_token_only"):
        assert column in tables["hosts"].columns
    for column in ("workspace_id", "id", "deleted_at", "password_hash"):
        assert column in tables["users"].columns


@requires_omnigent
def test_initialized_check_agrees_with_omnigents_bootstrap(tmp_path: Path) -> None:
    """The entrypoint's read-only check matches ``bootstrap_admin``'s own signal."""
    import sqlite3

    from omnigent.server.accounts_store import SqlAlchemyAccountStore
    from omnigent.server.passwords import hash_password

    ep = image_app.load_docker_entrypoint(DOCKER_ENTRYPOINT)
    db = tmp_path / "omnigent.db"
    url = f"sqlite:///{db}"
    ep.run_migrations(url)
    store = SqlAlchemyAccountStore(url)

    def agree(expected: bool) -> None:
        omnigent_says = any(user.has_password for user in store.list_users())
        assert omnigent_says is expected
        assert check_database(db).initialized is expected

    agree(False)  # migrated, no owner yet
    with sqlite3.connect(db) as conn:  # a passwordless member, as session creation adds
        conn.execute("INSERT INTO users (id, is_admin) VALUES ('member', 0)")
    agree(False)
    store.create_user_with_password(
        "owner", hash_password("synthetic-password-0001"), is_admin=True
    )
    agree(True)
    store.create_user_with_password(
        "second", hash_password("synthetic-password-0002"), is_admin=True
    )
    assert store.delete_user("owner")
    agree(True)


def test_the_app_never_checks_the_whole_database_again() -> None:
    """The entrypoint's integrity check is the start's only full read of the file (WP2.5: a
    second one in the app took 275 s of a 1 GB start on basic). The app asks for the owner."""
    tree = ast.parse((IMAGE_DIR / "cfo_server" / "app.py").read_text())
    called = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "has_owner" in called
    assert "check_database" not in called


def test_owner_check_runs_only_the_initialized_query(tmp_path: Path) -> None:
    import sqlite3

    from cfo_server.dbcheck import has_owner

    db = tmp_path / "omnigent.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE users (workspace_id, id, deleted_at, password_hash)")
        conn.execute("INSERT INTO users VALUES (0, 'local', NULL, NULL)")
    assert has_owner(db) is False
    with sqlite3.connect(db) as conn:
        conn.execute("INSERT INTO users VALUES (0, 'owner', NULL, 'synthetic-hash')")
    assert has_owner(db) is True
    assert has_owner(tmp_path / "missing.db") is False
    (tmp_path / "garbage.db").write_bytes(b"not a database" * 100)
    assert has_owner(tmp_path / "garbage.db") is False


def test_initialized_query_names_only_the_pinned_columns() -> None:
    assert re.findall(r"\b(workspace_id|id|deleted_at|password_hash)\b", INITIALIZED_SQL)


def test_the_page_count_reads_omnigents_service_table() -> None:
    """The entrypoint counts the page's MCP servers in Omnigent's own table (WP8.14)."""
    from omnigent.db.db_models import OmnigentBase, SqlMcpRegistryService
    from omnigent.stores import mcp_service_store

    from cfo_server.dbcheck import ADMIN_SERVICES_SQL, ADMIN_SERVICES_TABLE

    assert SqlMcpRegistryService.__tablename__ == ADMIN_SERVICES_TABLE
    columns = OmnigentBase.metadata.tables[ADMIN_SERVICES_TABLE].columns
    for column in ("workspace_id", "deleted_at"):
        assert column in columns
    assert set(re.findall(r"\b(workspace_id|deleted_at)\b", ADMIN_SERVICES_SQL)) == {
        "workspace_id",
        "deleted_at",
    }
    # Omnigent's own reading of a live service: a row without ``deleted_at``.
    assert "row.deleted_at is None" in inspect.getsource(mcp_service_store.McpServiceStore.scan)


#: Omnigent's head revision at the previous pin (``0116b9f53``), and the MCP page's migration
#: after it at this pin (WP8.14, docs/compatibility.md).
PREVIOUS_HEAD = "c0201a2b3c4d"
PAGE_MIGRATION = "mr1a2b3c4d5e"
#: The head at this pin: the team model's migrations after the page's (WP8.11, compatibility.md).
HEAD = "ti1a2b3c4d5e"


@requires_omnigent
def test_a_database_of_the_previous_pin_is_upgraded_at_start_with_the_page_tables(
    tmp_path: Path,
) -> None:
    """The first start on this pin runs the page's migration and the team model's, additive,
    after the previous head; a database at the new head is the one an earlier server refuses as
    newer."""
    from alembic import command
    from omnigent.db.utils import _build_alembic_config, _create_engine, _get_current_db_heads

    from cfo_server.dbcheck import count_admin_services

    ep = image_app.load_docker_entrypoint(DOCKER_ENTRYPOINT)
    db = tmp_path / "omnigent.db"
    url = f"sqlite:///{db}"
    command.upgrade(_build_alembic_config(url), PREVIOUS_HEAD)
    engine = _create_engine(url)
    try:
        assert _get_current_db_heads(engine) == (PREVIOUS_HEAD,)
        assert count_admin_services(db) == 0  # no table yet
        ep.run_migrations(url)
        assert _get_current_db_heads(engine) == (HEAD,)
    finally:
        engine.dispose()
    import sqlite3

    with sqlite3.connect(db) as conn:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master")}
    assert {"mcp_registry_services", "mcp_registry_service_tools"} <= tables
    assert {"teams", "team_members", "team_identity_bindings", "team_invitations"} <= tables
    assert count_admin_services(db) == 0


@requires_omnigent
def test_the_page_count_agrees_with_omnigents_store(tmp_path: Path) -> None:
    from omnigent.db.db_models import workspace_scope
    from omnigent.stores.mcp_service_store import McpServiceSettings, McpServiceStore

    from cfo_server.dbcheck import admin_service_ids, count_admin_services

    ep = image_app.load_docker_entrypoint(DOCKER_ENTRYPOINT)
    db = tmp_path / "omnigent.db"
    url = f"sqlite:///{db}"
    assert count_admin_services(db) is None  # no file
    ep.run_migrations(url)
    assert count_admin_services(db) == 0
    store = McpServiceStore(url)
    settings = McpServiceSettings(
        title="A", url="https://mcp.example.com/mcp", auth="none", timeout=60
    )
    for service_id in ("one", "two", "three"):
        store.create(service_id, settings, created_by="owner")
    with workspace_scope(7):  # another workspace's: not this installation's page
        store.create("elsewhere", settings, created_by="owner")
    assert count_admin_services(db) == 3
    assert store.delete("two")
    assert count_admin_services(db) == 2 == len(store.scan()[0])
    assert (
        admin_service_ids(db) == ["one", "three"] == sorted(r.service_id for r in store.scan()[0])
    )
    (tmp_path / "garbage.db").write_bytes(b"not a database" * 100)
    assert count_admin_services(tmp_path / "garbage.db") is None


@requires_omnigent
def test_cloudflare_launcher_implements_omnigents_launcher_interface() -> None:
    from cfo_server.launcher import PROVIDER, CloudflareLauncher

    launcher = CloudflareLauncher(None, None)  # abstract methods missing would raise TypeError
    assert launcher.provider == PROVIDER == "cloudflare"
    assert launcher.can_resume is True
    capabilities = launcher.capabilities
    assert capabilities.admission and capabilities.start_claims and capabilities.suspend
    assert capabilities.checkpoint and capabilities.programmatic_terminate


def test_pinned_litestream_binary_is_the_tested_release() -> None:
    binary = Path(os.environ.get("CFO_TEST_LITESTREAM_BIN", "/usr/local/bin/litestream"))
    if not binary.exists():
        pytest.skip("no Litestream binary here")
    version = subprocess.run([str(binary), "version"], capture_output=True, text=True, check=True)
    assert version.stdout.strip() == LITESTREAM_VERSION


def test_dockerfile_pins_the_same_litestream_release() -> None:
    dockerfile = (IMAGE_DIR / "Dockerfile").read_text()
    assert f"ARG LITESTREAM_VERSION={LITESTREAM_VERSION}" in dockerfile
    assert re.search(r"ARG LITESTREAM_SHA256=[0-9a-f]{64}", dockerfile)


# ── No wait sync, no application checkpoint ───────────────────────────────────────────

_IMAGE_SOURCES = sorted(
    [
        *IMAGE_DIR.glob("cfo_server/*.py"),
        IMAGE_DIR / "Dockerfile",
    ]
)


def test_image_code_never_checkpoints_the_database() -> None:
    """Litestream alone checkpoints: an application checkpoint can drop committed rows from
    the replica once the checkpoint guard is gone (Litestream #1540)."""
    for path in _IMAGE_SOURCES:
        text = path.read_text().lower()
        assert "wal_checkpoint" not in text.replace("no `wal_checkpoint`", ""), path
        assert "wal_autocheckpoint" not in text, path


def test_image_code_never_sends_a_wait_sync() -> None:
    """``wait: true`` can drop Litestream's checkpoint guard (Litestream #1552)."""
    for path in IMAGE_DIR.glob("cfo_server/*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                keys = {k.value for k in node.keys if isinstance(k, ast.Constant)}
                assert "wait" not in keys, f"{path}: a dict with a 'wait' key"
            if isinstance(node, ast.keyword) and node.arg == "wait":
                assert not isinstance(node.value, ast.Constant), f"{path}: wait={node.value}"
        assert '"wait"' not in path.read_text() and "'wait'" not in path.read_text(), path


def test_the_only_sync_body_is_path_only() -> None:
    from cfo_server.litestream import sync_request_body

    assert sync_request_body("/data/omnigent.db") == {"path": "/data/omnigent.db"}


@requires_omnigent
def test_bootstrap_password_minimum_is_omnigents_login_minimum() -> None:
    from omnigent.server.routes import accounts_auth

    from cfo_server.config import MIN_PASSWORD_LENGTH

    assert accounts_auth._MIN_PASSWORD_LENGTH == MIN_PASSWORD_LENGTH


def test_a_build_without_a_target_is_the_server() -> None:
    """Wrangler builds the Dockerfile without --target, so the last stage must be the server."""
    stages = re.findall(
        r"^FROM\s+(\S+)(?:\s+AS\s+(\S+))?", (IMAGE_DIR / "Dockerfile").read_text(), re.M
    )
    base, name = stages[-1]
    assert base == "runtime" and name == "server"


# ── The artifact store (G2-DUR-001) ───────────────────────────────────────────────────


@requires_omnigent
def test_omnigent_selects_its_s3_store_from_the_uri_the_image_pins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The image sets ``OMNIGENT_ARTIFACT_URI``; Omnigent's Docker entrypoint must read it and
    build its S3 store against the endpoint and region in the app's environment, the variables
    ``boto3`` reads (``AWS_ENDPOINT_URL_S3``, ``AWS_REGION``). No request is made."""
    from omnigent.stores.artifact_store.s3 import S3ArtifactStore

    config_path = tmp_path / "config.yaml"
    config_path.write_text("{}\n")
    for key in list(os.environ):
        if key.startswith(("OMNIGENT_", "AWS_", "ARTIFACT_")):
            monkeypatch.delenv(key)
    for key, value in {
        "DATABASE_URL": f"sqlite:///{tmp_path / 'omnigent.db'}",
        "ARTIFACT_DIR": str(tmp_path / "artifacts"),
        "OMNIGENT_CONFIG": str(config_path),
        "OMNIGENT_AUTH_PROVIDER": "accounts",
        "OMNIGENT_AUTH_ENABLED": "1",
        "OMNIGENT_ACCOUNTS_COOKIE_SECRET": "ab" * 32,  # synthetic
        "OMNIGENT_ACCOUNTS_BASE_URL": "http://testserver",
        "OMNIGENT_ARTIFACT_URI": "s3://cfo-test-artifacts/omnigent",
        "AWS_ACCESS_KEY_ID": "synthetic-artifacts-id",
        "AWS_SECRET_ACCESS_KEY": "synthetic-artifacts-secret",
        "AWS_ENDPOINT_URL_S3": "https://r2.example.test",
        "AWS_REGION": "auto",
    }.items():
        monkeypatch.setenv(key, value)
    ep = image_app.load_docker_entrypoint(DOCKER_ENTRYPOINT)
    resolved = ep._resolve_config()
    assert resolved.artifact_store_uri == "s3://cfo-test-artifacts/omnigent"
    store = ep._select_artifact_store(resolved)
    assert isinstance(store, S3ArtifactStore)
    assert (store._bucket, store._prefix) == ("cfo-test-artifacts", "omnigent")
    assert store._client.meta.endpoint_url == "https://r2.example.test"
    assert store._client.meta.region_name == "auto"
    # Without the URI, Omnigent would silently use the local disk: why the image refuses that.
    monkeypatch.delenv("OMNIGENT_ARTIFACT_URI")
    assert ep._resolve_config().artifact_store_uri is None


@requires_omnigent
def test_every_artifact_uri_the_image_accepts_omnigent_reads_alike() -> None:
    """The image checks the string Omnigent splits; a URI it accepts must give Omnigent's own
    parser the same bucket, and one Omnigent cannot use must be refused (Codex G2-DUR-001 r1-2)."""
    from omnigent.stores.artifact_store.s3 import _parse_s3_uri

    env = base_env(Path("/nonexistent"))
    del env["CFO_ALLOW_LOCAL_ARTIFACTS"]
    env.update({"AWS_ACCESS_KEY_ID": "synthetic-id", "AWS_SECRET_ACCESS_KEY": "synthetic-key"})
    corpus = [
        "s3://cfo-artifacts",
        "s3://cfo-artifacts/",
        "s3://cfo-artifacts/omnigent",
        "s3://cfo.artifacts/a/b",
        "S3://cfo-artifacts",
        "s3://cfo-artifacts?",
        "s3://cfo-artifacts#x",
        "s3://cfo-artifacts/x?y",
        "s3://user@cfo-artifacts",
        "s3://cfo-artifacts:9000/x",
        "s3://[broken",
        "s3://",
        "s3:///x",
    ]
    for uri in corpus:
        try:
            accepted = image_config.load({**env, "OMNIGENT_ARTIFACT_URI": uri}).artifacts
        except image_config.ConfigError:
            continue
        bucket, prefix = _parse_s3_uri(uri)
        assert bucket == accepted.bucket, uri
        assert "?" not in bucket + prefix and "#" not in bucket + prefix, uri


@requires_omnigent
def test_the_s3_store_built_in_the_apps_environment_asks_checksums_only_where_required(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """botocore reads the image's checksum settings: a plain PutObject over HTTPS too."""
    from omnigent.stores.artifact_store.s3 import S3ArtifactStore

    env = base_env(tmp_path)
    del env["CFO_ALLOW_LOCAL_ARTIFACTS"]
    env.update(
        {
            "OMNIGENT_ARTIFACT_URI": "s3://cfo-test-artifacts",
            "AWS_ACCESS_KEY_ID": "synthetic-id",
            "AWS_SECRET_ACCESS_KEY": "synthetic-key",
            "AWS_ENDPOINT_URL_S3": "https://r2.example.test",
        }
    )
    app_env = image_config.app_environment(image_config.load(env), env)
    for key in list(os.environ):
        if key.startswith("AWS_"):
            monkeypatch.delenv(key)
    for key, value in app_env.items():
        if key.startswith("AWS_"):
            monkeypatch.setenv(key, value)
    store = S3ArtifactStore(app_env["OMNIGENT_ARTIFACT_URI"])
    assert store._client.meta.config.request_checksum_calculation == "when_required"
    assert store._client.meta.config.response_checksum_validation == "when_required"


@requires_omnigent
def test_the_image_installs_boto3_at_the_fork_locks_version() -> None:
    """boto3 comes from the fork's ``s3`` extra, at its uv.lock's exact version."""
    import tomllib

    import boto3
    import botocore
    import omnigent

    lock_path = Path(omnigent.__file__).resolve().parents[1] / "uv.lock"
    if not lock_path.exists():
        pytest.skip(f"the fork's uv.lock is not next to the installed Omnigent ({lock_path})")
    locked = {p["name"]: p["version"] for p in tomllib.loads(lock_path.read_text())["package"]}
    assert boto3.__version__ == locked["boto3"]
    assert botocore.__version__ == locked["botocore"]


def test_the_dockerfile_installs_the_s3_extra_from_the_lock() -> None:
    dockerfile = (IMAGE_DIR / "Dockerfile").read_text()
    assert re.search(r"uv export --frozen --no-dev --extra s3 ", dockerfile)
    assert 'python -c "import cfo_server.entrypoint, cfo_server.app, boto3"' in dockerfile
