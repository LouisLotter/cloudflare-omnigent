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
import os
import re
import subprocess
from pathlib import Path

import pytest

from cfo_server import app as image_app
from cfo_server.barrier import IGNORED_UPDATE_COLUMNS, SECURITY_TABLES
from cfo_server.dbcheck import INITIALIZED_SQL, check_database

from conftest import DOCKER_ENTRYPOINT, IMAGE_DIR, requires_omnigent

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
