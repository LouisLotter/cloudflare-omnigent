"""The Omnigent app in this image: one ``create_app`` call, then uvicorn.

Run by the entrypoint as ``python -m cfo_server.app``, once Litestream is replicating. It:

1. installs the response barrier's SQLAlchemy listeners before any engine exists;
2. resolves Omnigent's configuration and runs its migrations through Omnigent's own Docker
   entrypoint module (``/app/entrypoint.py``, importable without side effects);
3. wires the stores exactly as that module's ``build_app`` does, and calls ``create_app``
   itself with what the platform adds: static sharing values (Omnigent's sharing settings
   become authoritative, D4), the launcher registration through ``sandbox_config``, the
   pinned release features, and the transcript barrier (``durability_barrier``);
4. adds the response barrier as the outermost middleware, and serves the app the way that
   module's ``main`` does.

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
from cfo_server.dbcheck import check_database
from cfo_server.events import log
from cfo_server.launcher import sandbox_deployment
from cfo_server.litestream import ReplicationWaiter

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
    """Every release feature off, whatever ``OMNIGENT_FEATURES`` says.

    ``harness_install`` in particular stays off: its harness-credential route could redirect
    another computer's model traffic (design, "Trust inside a cloud computer").
    """
    from omnigent.server.feature_flags import resolve_feature_flags

    return resolve_feature_flags({})


def github_linking(database_url: str) -> tuple[Any, Any]:
    """Omnigent's GitHub linking (D22): ``(github_config, github_store)``.

    Off in this version of the image. WP3.14 sets the installation's GitHub App client ID,
    client secret and redirect URI from Worker secrets here, and selects core change 19's
    key-service cipher for the credential store. The entrypoint removes the
    ``OMNIGENT_GITHUB_APP_*`` and ``OMNIGENT_CREDENTIAL_*`` variables until then.
    """
    del database_url
    return None, None


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

    github_config, github_store = github_linking(database_url)
    sandbox_config = (
        sandbox_deployment(config)
        if launcher_factory is None
        else sandbox_deployment(config, launcher_factory)
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
        scheduled_task_store=scheduled_task_store,
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
        # The platform's additions:
        sharing_mode=SharingMode(config.sharing.sharing_mode),
        public_sharing=config.sharing.public_sharing,
        public_sharing_max_level=config.sharing.public_sharing_max_level,
        default_public_sessions=config.sharing.default_public_sessions,
        feature_flags=pinned_feature_flags(),
        durability_barrier=make_transcript_barrier(waiter, config.transcript_barrier_timeout_s),
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
    config = image_config.load(for_app=True)
    db_path = os.environ.get("CFO_DB_PATH", str(image_config.DB_PATH))
    socket_path = os.environ.get("CFO_LITESTREAM_SOCKET", str(image_config.LITESTREAM_SOCKET))
    ep = load_docker_entrypoint()
    resolved = ep._resolve_config()
    if resolved.database_url != f"sqlite:///{db_path}":
        raise RuntimeError("the database URL does not name the file Litestream replicates")
    log("app.configured", seconds=round(time.monotonic() - started, 2))
    ep.run_migrations(resolved.database_url)
    log("app.migrated", seconds=round(time.monotonic() - started, 2))

    waiter = ReplicationWaiter(socket_path, db_path)
    app = build_app(config, resolved, waiter=waiter, docker_entrypoint=ep)
    # create_app ran Omnigent's bootstrap. Without an owner, Omnigent would offer
    # first-visitor setup; the entrypoint already refuses that case, and this checks it.
    if not check_database(Path(db_path)).initialized:
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
