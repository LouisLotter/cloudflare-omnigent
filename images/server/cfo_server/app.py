"""The Omnigent app in this image: one ``create_app`` call, then uvicorn.

Run by the entrypoint as ``python -m cfo_server.app``, once Litestream is replicating. It:

1. installs the response barrier's SQLAlchemy listeners before any engine exists;
2. resolves Omnigent's configuration and runs its migrations through Omnigent's own Docker
   entrypoint module (``/app/entrypoint.py``, importable without side effects), and checks that
   Omnigent selected the artifact store the image configured (an S3 bucket; the container's
   disk only in tests);
3. wires the stores exactly as that module's ``build_app`` does, and calls ``create_app``
   itself with what the platform adds: static sharing values (Omnigent's sharing settings
   become authoritative, D4), the launcher registration through ``sandbox_config``, the
   pinned release features, the transcript barrier (``durability_barrier``), and Omnigent's
   MCP registry with its logins in the credential store, through the key service (WP5.10);
4. adds the owner's password handler (``POST /_cfo/owner-password``, WP3.34) outside Omnigent's
   own middleware, and the response barrier outside it as the outermost middleware, and serves
   the app the way that module's ``main`` does.

It never replaces an Omnigent module attribute. The coupling to the Docker entrypoint's
helpers and to ``build_app``'s wiring is pinned by ``tests/test_coupling.py``: a fork bump that
changes either fails that test until this module is reviewed.

After uvicorn stops, nothing more is written; the entrypoint then checks the final sync.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys
import time
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Any

from cfo_server import config as image_config
from cfo_server import logfilter
from cfo_server.barrier import ResponseBarrierMiddleware, install_sql_hooks, make_transcript_barrier
from cfo_server.dbcheck import has_owner
from cfo_server.events import log
from cfo_server.launcher import litestream_durability_wait, sandbox_deployment
from cfo_server.litestream import ReplicationWaiter
from cfo_server.owner_password import OwnerPasswordMiddleware, owner_username

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi import FastAPI
    from omnigent.onboarding.sandboxes.base import SandboxHostLauncher

logger = logging.getLogger("cfo-server")

#: Omnigent's own Docker entrypoint, copied into the image by Omnigent's Dockerfile stage.
DOCKER_ENTRYPOINT = Path(os.environ.get("CFO_OMNIGENT_DOCKER_ENTRYPOINT", "/app/entrypoint.py"))
_MODULE_NAME = "omnigent_docker_entrypoint"


def load_docker_entrypoint(path: Path = DOCKER_ENTRYPOINT) -> ModuleType:
    """Import Omnigent's Docker entrypoint as a module. Importing it has no side effects."""
    existing = sys.modules.get(_MODULE_NAME)
    if existing is not None and getattr(existing, "__file__", None) == str(path):
        return existing
    spec = importlib.util.spec_from_file_location(_MODULE_NAME, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load Omnigent's Docker entrypoint from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_MODULE_NAME] = module  # its dataclasses look themselves up here
    spec.loader.exec_module(module)
    return module


def pinned_feature_flags() -> Any:
    """Omnigent's release defaults, whatever ``OMNIGENT_FEATURES`` says.

    Since 0.20.0 an empty setting means each feature's release default rather than every
    feature off: 0.20.0 turns on only ``claude_osc_status``, a runner feature the server does not
    read. Everything a release ships off stays off, ``automations_v2`` (0.20.0's scheduler, D38)
    among them. ``harness_install`` must stay off: its harness-credential route could redirect
    another computer's model traffic (design, "Trust inside a cloud computer"). Should a release
    turn it on by default, the app refuses to start.
    """
    from omnigent.server.feature_flags import Feature, resolve_feature_flags

    flags = resolve_feature_flags({})
    if flags.enabled(Feature.HARNESS_INSTALL):
        raise RuntimeError("Omnigent turns harness_install on by default; the image refuses it")
    return flags


def github_linking(config: image_config.ServerImageConfig, database_url: str) -> tuple[Any, Any]:
    """Omnigent's GitHub linking (D22, WP5.9): ``(github_config, github_store)``, or
    ``(None, None)`` while it is off.

    Built the way Omnigent's own Docker entrypoint builds it, from the app's environment, which
    :func:`cfo_server.config.app_environment` restricted to the installation's GitHub App and the
    platform Worker's key service, with ``OMNIGENT_CREDENTIAL_CIPHER=http``. Then checked: the
    App Omnigent read is the one the image checked, it carries no private key, and the store's
    cipher is core change 19's key service, never another backend. Anything else stops the app:
    tokens are never stored under a cipher the platform did not choose.
    """
    if not config.github.enabled:
        return None, None
    from omnigent.connections.github import GithubConnectionStore
    from omnigent.server.github_app import GitHubAppConfig
    from omnigent.stores.credential_store import build_secret_cipher
    from omnigent.stores.credential_store.http_cipher import HttpSecretCipher

    github_config = GitHubAppConfig.from_env()
    if (
        github_config is None
        or github_config.client_id != config.github.client_id
        or github_config.redirect_uri != config.github.redirect_uri
        or github_config.private_key is not None
    ):
        raise RuntimeError("Omnigent did not read the GitHub App the image configured")
    cipher = build_secret_cipher()
    if not isinstance(cipher, HttpSecretCipher):
        raise RuntimeError("the credential store's cipher is not the platform's key service")
    return github_config, GithubConnectionStore(database_url, cipher)


def mcp_registry(config: image_config.ServerImageConfig, database_url: str) -> Any:
    """Omnigent's MCP registry (WP5.10), or ``None`` while no service is on.

    Built as Omnigent's own server command builds it (``omnigent/cli.py``: ``McpRegistry`` over a
    ``CredentialStore`` with the deployment's cipher), from the configuration the image checked
    (:mod:`cfo_server.mcp`) rather than a file. Omnigent's own model checks it again; a refusal
    there is a configuration error (exit 78) whose words never repeat a value. The store's cipher
    must be core change 19's key service, never another backend: logins are never stored under a
    cipher the platform did not choose.
    """
    if not config.mcp.enabled:
        return None
    from omnigent.server.mcp_registry import McpRegistry, McpRegistryConfig
    from omnigent.stores.credential_store import build_secret_cipher
    from omnigent.stores.credential_store.http_cipher import HttpSecretCipher
    from omnigent.stores.credential_store.sqlalchemy_store import CredentialStore
    from pydantic import ValidationError

    try:
        registry_config = McpRegistryConfig.model_validate(config.mcp.registry)
    except ValidationError:
        # Pydantic's message repeats the input: never logged.
        raise image_config.ConfigError(
            "Omnigent refused the MCP services' configuration (check the manifests and the "
            "CFO_MCP_ settings)"
        ) from None
    cipher = None
    if config.key_service is not None:
        cipher = build_secret_cipher()
        if not isinstance(cipher, HttpSecretCipher):
            raise RuntimeError("the credential store's cipher is not the platform's key service")
    try:
        return McpRegistry(
            registry_config, None if cipher is None else CredentialStore(database_url, cipher)
        )
    except ValueError:
        raise image_config.ConfigError(
            "Omnigent refused the MCP registry: the key service or "
            "OMNIGENT_MCP_OAUTH_STATE_SECRET is not as it needs them"
        ) from None


def build_app(
    config: image_config.ServerImageConfig,
    resolved_config: Any,
    *,
    waiter: ReplicationWaiter,
    launcher_factory: Callable[[], SandboxHostLauncher] | None = None,
    docker_entrypoint: ModuleType | None = None,
) -> FastAPI:
    """Wire Omnigent's stores and build the app with the platform's additions.

    The store wiring mirrors ``build_app`` in Omnigent's ``deploy/docker/entrypoint.py`` at
    the pinned fork commit; ``tests/test_coupling.py`` pins that function's source.
    """
    ep = docker_entrypoint or load_docker_entrypoint()

    from omnigent.runtime import init as init_runtime
    from omnigent.runtime import telemetry
    from omnigent.runtime.agent_cache import AgentCache
    from omnigent.runtime.caps import RuntimeCaps
    from omnigent.server.app import create_app
    from omnigent.server.auth import SharingMode, create_auth_provider
    from omnigent.server.auth import UnifiedAuthProvider as _UAP
    from omnigent.spec import parse_default_policies, parse_server_llm
    from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
    from omnigent.stores.comment_store.sqlalchemy_store import SqlAlchemyCommentStore
    from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
    from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
    from omnigent.stores.host_store import HostStore
    from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore
    from omnigent.stores.policy_store.sqlalchemy_store import SqlAlchemyPolicyStore
    from omnigent.stores.project_store.sqlalchemy_store import SqlAlchemyProjectStore
    from omnigent.stores.scheduled_task_store.sqlalchemy_store import (
        SqlAlchemyScheduledTaskStore,
    )

    cfg = resolved_config.cfg
    database_url = resolved_config.database_url
    artifact_dir = resolved_config.artifact_dir

    telemetry.init()

    agent_store = SqlAlchemyAgentStore(database_url)
    file_store = SqlAlchemyFileStore(database_url)
    conversation_store = SqlAlchemyConversationStore(database_url)
    comment_store = SqlAlchemyCommentStore(database_url)
    permission_store = SqlAlchemyPermissionStore(database_url)
    host_store = HostStore(database_url)
    policy_store = SqlAlchemyPolicyStore(database_url)
    scheduled_task_store = SqlAlchemyScheduledTaskStore(database_url)
    project_store = SqlAlchemyProjectStore(database_url)
    artifact_store = ep._select_artifact_store(resolved_config)
    agent_cache = AgentCache(artifact_store=artifact_store, cache_dir=artifact_dir / ".cache")

    server_llm = parse_server_llm(cfg.get("llm"))
    routing_client, routing_settings = ep._build_routing(cfg, server_llm)
    caps = RuntimeCaps(
        execution_timeout=ep._resolve_execution_timeout(cfg),
        default_policies=parse_default_policies(cfg.get("policies")),
        llm=server_llm,
        routing_client=routing_client,
        routing_settings=routing_settings,
    )
    init_runtime(
        agent_cache=agent_cache,
        caps=caps,
        agent_store=agent_store,
        file_store=file_store,
        conversation_store=conversation_store,
        artifact_store=artifact_store,
        comment_store=comment_store,
        policy_store=policy_store,
    )

    auth_provider = create_auth_provider()
    account_store = None
    if isinstance(auth_provider, _UAP) and auth_provider._source == "accounts":
        from omnigent.server.accounts_store import SqlAlchemyAccountStore

        account_store = SqlAlchemyAccountStore(database_url)
    if account_store is None:
        # The image pins accounts mode; anything else is a broken environment.
        raise RuntimeError("accounts mode did not resolve; refusing to start without it")

    github_config, github_store = github_linking(config, database_url)
    registry = mcp_registry(config, database_url)
    # The launcher's own durability fence reads the same Litestream position as the barriers.
    sandbox_config = sandbox_deployment(
        config,
        durability_wait=litestream_durability_wait(waiter.socket_path, waiter.db_path),
        launcher_factory=launcher_factory,
    )

    app = create_app(
        agent_store=agent_store,
        file_store=file_store,
        conversation_store=conversation_store,
        artifact_store=artifact_store,
        agent_cache=agent_cache,
        comment_store=comment_store,
        permission_store=permission_store,
        policy_store=policy_store,
        host_store=host_store,
        # An update's read-only window (WP3.41): no scheduler, so no scheduled task fires (and
        # no computer starts) until the update is accepted, which restarts the server with it.
        scheduled_task_store=None if config.maintenance else scheduled_task_store,
        project_store=project_store,
        auth_provider=auth_provider,
        account_store=account_store,
        admins=list(config.admins),
        allowed_domains=list(config.allowed_domains),
        sandbox_config=sandbox_config,
        server_config=cfg,
        github_config=github_config,
        github_store=github_store,
        databricks_config=None,
        databricks_store=None,
        mcp_registry=registry,
        # The platform's additions:
        sharing_mode=SharingMode(config.sharing.sharing_mode),
        public_sharing=config.sharing.public_sharing,
        public_sharing_max_level=config.sharing.public_sharing_max_level,
        default_public_sessions=config.sharing.default_public_sessions,
        feature_flags=pinned_feature_flags(),
        durability_barrier=make_transcript_barrier(waiter, config.transcript_barrier_timeout_s),
    )
    # The owner's password, set by the platform (WP3.34): outside everything create_app added, so
    # no Omnigent middleware sees the request, and inside the barrier, which holds its answer
    # until the change is replicated. Keyed by the cookie secret the image was given (the image's
    # configuration requires one), and only for the owner the installation names.
    from omnigent.server.passwords import hash_password

    app.add_middleware(
        OwnerPasswordMiddleware,
        cookie_secret=os.environ.get("OMNIGENT_ACCOUNTS_COOKIE_SECRET") or None,
        username=owner_username(),
        account_store=account_store,
        auth_provider=auth_provider,
        hash_password=hash_password,
    )
    # Outermost user middleware: added last, so it wraps everything create_app added.
    app.add_middleware(
        ResponseBarrierMiddleware, wait=waiter.wait, timeout_s=config.response_barrier_timeout_s
    )
    ep.log_capabilities(sandbox_config, github_config, github_store)
    return app


def main() -> None:
    """Resolve, migrate, build and serve. Run by the entrypoint, never directly.

    The entrypoint passes the database path and Litestream's socket in ``CFO_DB_PATH`` and
    ``CFO_LITESTREAM_SOCKET``; the database URL must name the same file Litestream replicates.
    """
    # Each stage of the start is logged with its time, so a slow start shows where it went
    # (WP2.5's diagnosis needed py-spy for that); the entrypoint logs ``app.ready``.
    started = time.monotonic()
    install_sql_hooks()
    try:
        config = image_config.load(for_app=True)
    except image_config.ConfigError as exc:
        # The entrypoint checked the same settings; any difference is still a setting (exit 78).
        log("config.error", message=str(exc))
        sys.exit(78)
    db_path = os.environ.get("CFO_DB_PATH", str(image_config.DB_PATH))
    socket_path = os.environ.get("CFO_LITESTREAM_SOCKET", str(image_config.LITESTREAM_SOCKET))
    ep = load_docker_entrypoint()
    resolved = ep._resolve_config()
    if resolved.database_url != f"sqlite:///{db_path}":
        raise RuntimeError("the database URL does not name the file Litestream replicates")
    # Omnigent selects its artifact store from this value: it must be the one the image checked,
    # so a missing setting is the configuration error above, never a silent fall back to the
    # container's disk (G2-DUR-001).
    if resolved.artifact_store_uri != config.artifacts.uri:
        raise RuntimeError("Omnigent's artifact store is not the one the image configured")
    log(
        "app.configured",
        artifacts="local" if config.artifacts.uri is None else "s3",
        seconds=round(time.monotonic() - started, 2),
    )
    ep.run_migrations(resolved.database_url)
    log("app.migrated", seconds=round(time.monotonic() - started, 2))

    waiter = ReplicationWaiter(socket_path, db_path)
    try:
        app = build_app(config, resolved, waiter=waiter, docker_entrypoint=ep)
    except image_config.ConfigError as exc:
        # As the entrypoint's own refusal: the watchdog holds the configuration (exit 78).
        log("config.error", message=str(exc))
        sys.exit(78)
    # create_app ran Omnigent's bootstrap. Without an owner, Omnigent would offer
    # first-visitor setup; the entrypoint already refuses that case, and this checks it with
    # the owner query alone: the entrypoint's full integrity check of the same file came just
    # before (a second one took 275 s of a 1 GB start on basic, WP2.5).
    if not has_owner(Path(db_path)):
        raise RuntimeError("no owner after Omnigent's bootstrap; refusing to serve setup")
    log(
        "app.built",
        sharing_mode=config.sharing.sharing_mode,
        seconds=round(time.monotonic() - started, 2),
    )

    import uvicorn
    from omnigent.server.graceful_shutdown import SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_S, serve
    from omnigent.util.tunnel_limits import uvicorn_tunnel_kwargs

    uvicorn_config = uvicorn.Config(
        app,
        host=resolved.host,
        port=resolved.port,
        **uvicorn_tunnel_kwargs(),
        timeout_graceful_shutdown=SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_S,
    )
    # uvicorn.Config configured logging; keep query strings (magic-link tokens) out of it.
    logfilter.install()
    serve(uvicorn_config)


if __name__ == "__main__":
    main()
