"""Deployment settings for the server image, parsed strictly from the environment.

The Worker forwards these as container environment variables (variables and secrets). Every
value is checked here, once, before anything starts. Two rules:

- **Unset means the restrictive default.** Sharing is off, public access is off, new sessions
  are never public by default, and no extra admins or domains are listed.
- **Malformed means refuse to start.** Omnigent's own parsers fail open (an unknown sharing
  mode becomes ``on``); this module never does. :class:`ConfigError` names the variable.

Some settings are pinned by the image and cannot be changed by the environment at all:
accounts mode, the release-feature set (``OMNIGENT_FEATURES``, which must never contain
``harness_install``), default-public sessions off, the database and data paths, and the
managed-sandbox reaper. Variables that would select integrations the image does not wire
(Databricks, the credential-store ciphers) are removed from the app's environment; the GitHub
App and the key-service cipher arrive with WP3.14.
"""

from __future__ import annotations

import math
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

# ── Fixed paths inside the image ─────────────────────────────────────────

DATA_DIR = Path("/data")
DB_PATH = DATA_DIR / "omnigent.db"
DATABASE_URL = f"sqlite:///{DB_PATH}"  # sqlite:////data/omnigent.db
ARTIFACT_DIR = DATA_DIR / "artifacts"
# Omnigent's "data dir" for its operator files (admins, allowed_domains, sharing overrides) is
# the parent of OMNIGENT_ADMIN_CREDENTIALS_PATH; no file is written at that path itself.
OMNIGENT_DATA_DIR = DATA_DIR / "omnigent"
OMNIGENT_CONFIG_PATH = OMNIGENT_DATA_DIR / "config.yaml"
RUN_DIR = Path("/run/cfo")
LITESTREAM_SOCKET = RUN_DIR / "litestream.sock"
LITESTREAM_CONFIG = RUN_DIR / "litestream.yml"
LITESTREAM_BIN = Path("/usr/local/bin/litestream")
APP_PORT = 8000

SharingModeValue = Literal["off", "restricted_read_only", "read_only", "on"]
MaxLevelValue = Literal["read", "edit"]

SHARING_MODES: tuple[str, ...] = ("off", "restricted_read_only", "read_only", "on")
MAX_LEVELS: tuple[str, ...] = ("read", "edit")
_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})

#: Litestream's sync interval unless ``CFO_SYNC_INTERVAL`` says otherwise (WP2.5's R2 runs).
DEFAULT_SYNC_INTERVAL = "200ms"

# The senders' acknowledgement timeouts the transcript barrier must stay below (core change
# 14): 5 s for a native forwarder's item POST, 30 s for the runner's ``event.ack``. One barrier
# serves both, so the smaller bound applies.
SENDER_ACK_TIMEOUT_S = 5.0
#: Omnigent's minimum password length at login (``accounts_auth._MIN_PASSWORD_LENGTH``).
MIN_PASSWORD_LENGTH = 8

#: Environment variables the image removes before starting Omnigent. They would select
#: integrations this image does not wire: Databricks Connect and the credential-store ciphers
#: (AWS KMS, Vault, the HTTP key service). WP3.14 adds the key-service cipher for GitHub
#: linking through :func:`cfo_server.app.github_linking`.
SCRUBBED_ENV_PREFIXES: tuple[str, ...] = (
    "OMNIGENT_DATABRICKS_",
    "OMNIGENT_CREDENTIAL_",
    "OMNIGENT_GITHUB_APP_",
    "VAULT_",
)
#: Variables the image sets itself; a value from the environment is replaced.
PINNED_ENV: Mapping[str, str] = {
    "OMNIGENT_AUTH_PROVIDER": "accounts",
    "OMNIGENT_AUTH_ENABLED": "1",
    "OMNIGENT_ACCOUNTS_AUTO_OPEN": "0",
    "OMNIGENT_FEATURES": "",
    "DATABASE_URL": DATABASE_URL,
    "ARTIFACT_DIR": str(ARTIFACT_DIR),
    "OMNIGENT_CONFIG": str(OMNIGENT_CONFIG_PATH),
    "OMNIGENT_ADMIN_CREDENTIALS_PATH": str(OMNIGENT_DATA_DIR / "admin-credentials"),
    "HOST": "0.0.0.0",
    "PORT": str(APP_PORT),
}
#: Variables removed from the app's environment: a removed Omnigent switch, a path override
#: that would move the admin list off the image's data directory, and the replica credentials,
#: which only Litestream needs. (``AWS_*`` stays: Omnigent's S3 artifact store reads it.)
REMOVED_APP_ENV: tuple[str, ...] = (
    "OMNIGENT_HARNESS_INSTALL_ENABLED",
    "OMNIGENT_ADMIN_LIST_PATH",
    "LITESTREAM_ACCESS_KEY_ID",
    "LITESTREAM_SECRET_ACCESS_KEY",
)
#: Variables removed from Litestream's environment: the artifact store's credentials.
REMOVED_LITESTREAM_ENV: tuple[str, ...] = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
)


class ConfigError(ValueError):
    """A deployment setting is missing or malformed. The message names the variable."""


@dataclass(frozen=True)
class SharingSettings:
    """Omnigent's sharing settings, passed to ``create_app`` as static (authoritative) values."""

    sharing_mode: SharingModeValue = "off"
    public_sharing: bool = False
    public_sharing_max_level: MaxLevelValue = "read"
    # Pinned: computers are managed sandboxes, and Omnigent's "sandbox" default would make
    # their sessions public.
    default_public_sessions: Literal["off"] = "off"


@dataclass(frozen=True)
class ReplicaSettings:
    """Where Litestream replicates the database."""

    url: str
    endpoint: str | None
    region: str
    force_path_style: bool
    sync_interval: str


@dataclass(frozen=True)
class ServerImageConfig:
    """Everything the entrypoint and the app read from the environment."""

    #: The deployment's "this installation has an owner" expectation, kept outside the
    #: database. With it, an empty replica or a database without an owner is recovery mode,
    #: never a fresh installation.
    installation_initialized: bool
    #: ``None`` only in the app process (see :func:`load`).
    replica: ReplicaSettings | None
    base_url: str
    ws_allowed_origins: tuple[str, ...]
    sharing: SharingSettings = field(default_factory=SharingSettings)
    admins: tuple[str, ...] = ()
    allowed_domains: tuple[str, ...] = ()
    sandbox_server_url: str = "http://omnigent.internal"
    response_barrier_timeout_s: float = 10.0
    transcript_barrier_timeout_s: float = 3.0
    restore_deadline_s: float = 300.0
    final_sync_timeout_s: float = 300.0
    litestream_ready_timeout_s: float = 60.0
    #: The installation this server belongs to (``CFO_INSTALLATION_ID``, set by the Worker).
    installation_id: str | None = None
    #: Whether the bootstrap owner's username and password are set, so Omnigent creates the
    #: owner on a database without one instead of offering first-visitor setup.
    bootstrap_credentials: bool = False
    #: Warnings to log at start: settings the image ignored or removed.
    warnings: tuple[str, ...] = ()


def _get(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def parse_bool(env: Mapping[str, str], name: str, default: bool | None) -> bool:
    """Parse a boolean variable strictly; ``default=None`` makes it required."""
    raw = _get(env, name)
    if raw is None:
        if default is None:
            raise ConfigError(f"{name} is required: set it to true or false")
        return default
    lowered = raw.lower()
    if lowered in _TRUE:
        return True
    if lowered in _FALSE:
        return False
    raise ConfigError(f"{name} must be true or false, not {raw!r}")


def parse_seconds(
    env: Mapping[str, str],
    name: str,
    default: float,
    *,
    minimum: float = 0.0,
    below: float | None = None,
) -> float:
    """Parse a positive number of seconds, strictly above ``minimum`` and below ``below``."""
    raw = _get(env, name)
    if raw is None:
        value = default
    else:
        try:
            value = float(raw)
        except ValueError:
            raise ConfigError(f"{name} must be a number of seconds, not {raw!r}") from None
    if not math.isfinite(value) or value <= minimum:
        raise ConfigError(f"{name} must be more than {minimum:g} seconds, not {value:g}")
    if below is not None and value >= below:
        raise ConfigError(f"{name} must be less than {below:g} seconds, not {value:g}")
    return value


def parse_list(env: Mapping[str, str], name: str) -> tuple[str, ...]:
    """A comma-separated list of identities or domains, lower-cased, without blanks."""
    raw = _get(env, name)
    if raw is None:
        return ()
    items: list[str] = []
    for part in raw.split(","):
        item = part.strip().lower()
        if not item:
            continue
        if any(ch.isspace() or ch == "#" or not ch.isprintable() for ch in item):
            raise ConfigError(f"{name} has an invalid entry {item!r}")
        items.append(item)
    return tuple(dict.fromkeys(items))


def _origin(url: str, name: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConfigError(f"{name} must be an http or https URL, not {url!r}")
    if parts.username or parts.password:
        raise ConfigError(f"{name} must not carry credentials")
    return f"{parts.scheme}://{parts.netloc.lower()}"


def parse_sharing(env: Mapping[str, str]) -> SharingSettings:
    """Parse the sharing settings; unset values are the restrictive defaults."""
    mode = (_get(env, "OMNIGENT_SHARING_MODE") or "off").lower()
    if mode not in SHARING_MODES:
        raise ConfigError(
            f"OMNIGENT_SHARING_MODE must be one of {', '.join(SHARING_MODES)}, not {mode!r}"
        )
    level = (_get(env, "OMNIGENT_PUBLIC_SHARING_MAX_LEVEL") or "read").lower()
    if level not in MAX_LEVELS:
        raise ConfigError(f"OMNIGENT_PUBLIC_SHARING_MAX_LEVEL must be read or edit, not {level!r}")
    default_public = (_get(env, "OMNIGENT_DEFAULT_PUBLIC_SESSIONS") or "off").lower()
    if default_public != "off":
        raise ConfigError(
            "OMNIGENT_DEFAULT_PUBLIC_SESSIONS is pinned to off in this image "
            f"(default-public sharing stays off), not {default_public!r}"
        )
    return SharingSettings(
        sharing_mode=mode,  # type: ignore[arg-type]
        public_sharing=parse_bool(env, "OMNIGENT_PUBLIC_SHARING", False),
        public_sharing_max_level=level,  # type: ignore[arg-type]
    )


def parse_replica(env: Mapping[str, str]) -> ReplicaSettings:
    """Parse the replica location. ``file://`` replicas are for tests only."""
    url = _get(env, "CFO_REPLICA_URL")
    if url is None:
        raise ConfigError("CFO_REPLICA_URL is required, for example s3://<bucket>/omnigent")
    parts = urlsplit(url)
    if parts.scheme == "s3":
        if not parts.netloc:
            raise ConfigError("CFO_REPLICA_URL must name a bucket: s3://<bucket>/<path>")
        if parts.query or parts.fragment or parts.username:
            raise ConfigError("CFO_REPLICA_URL must be s3://<bucket>/<path> with nothing else")
        for name in ("LITESTREAM_ACCESS_KEY_ID", "LITESTREAM_SECRET_ACCESS_KEY"):
            if _get(env, name) is None:
                raise ConfigError(f"{name} is required for an s3 replica")
    elif parts.scheme == "file":
        if not parse_bool(env, "CFO_ALLOW_FILE_REPLICA", False):
            raise ConfigError("a file:// replica is for tests only (CFO_ALLOW_FILE_REPLICA)")
        if not parts.path.startswith("/"):
            raise ConfigError("CFO_REPLICA_URL must be an absolute file:// path")
    else:
        raise ConfigError(f"CFO_REPLICA_URL must be s3:// (or file:// in tests), not {url!r}")
    endpoint = _get(env, "CFO_REPLICA_ENDPOINT")
    if endpoint is not None:
        _origin(endpoint, "CFO_REPLICA_ENDPOINT")
    # 200 ms: on R2 it halves the barrier wait's p95 and p99 against 1 s (0.54 and 0.59 s
    # against 1.23 and 1.33 s) and adds no request while idle (WP2.5).
    interval = _get(env, "CFO_SYNC_INTERVAL") or DEFAULT_SYNC_INTERVAL
    if not re.fullmatch(r"[1-9][0-9]*(ms|s)", interval):
        raise ConfigError(f"CFO_SYNC_INTERVAL must look like 1s or 200ms, not {interval!r}")
    return ReplicaSettings(
        url=url,
        endpoint=endpoint,
        region=_get(env, "CFO_REPLICA_REGION") or "auto",
        force_path_style=parse_bool(env, "CFO_REPLICA_FORCE_PATH_STYLE", True),
        sync_interval=interval,
    )


def load(env: Mapping[str, str] | None = None, *, for_app: bool = False) -> ServerImageConfig:
    """Parse and check every setting; raise :class:`ConfigError` on the first problem.

    :param for_app: Parse for the Omnigent app process, whose environment no longer holds the
        replica's credentials (only Litestream gets them); the replica is then not parsed.
    """
    env = os.environ if env is None else env
    warnings: list[str] = []

    provider = _get(env, "OMNIGENT_AUTH_PROVIDER")
    if provider is not None and provider.lower() != "accounts":
        raise ConfigError(f"OMNIGENT_AUTH_PROVIDER is pinned to accounts, not {provider!r}")
    if not parse_bool(env, "OMNIGENT_AUTH_ENABLED", True):
        raise ConfigError("OMNIGENT_AUTH_ENABLED cannot turn authentication off in this image")

    base_url = _get(env, "OMNIGENT_ACCOUNTS_BASE_URL")
    if base_url is None:
        raise ConfigError("OMNIGENT_ACCOUNTS_BASE_URL is required: the installation's UI origin")
    base_origin = _origin(base_url, "OMNIGENT_ACCOUNTS_BASE_URL")

    secret = _get(env, "OMNIGENT_ACCOUNTS_COOKIE_SECRET")
    # Without it Omnigent generates one on the container's ephemeral disk, and every
    # replacement would sign everyone out. Omnigent wants hex, at least 32 bytes.
    if secret is None or len(secret) < 64 or not re.fullmatch(r"(?:[0-9a-fA-F]{2})+", secret):
        raise ConfigError("OMNIGENT_ACCOUNTS_COOKIE_SECRET is required: at least 64 hex characters")

    bootstrap_password = _get(env, "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD")
    bootstrap_username = _get(env, "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME")
    if bootstrap_password is not None and bootstrap_username is None:
        # Otherwise the container's OS user, root, becomes the owner.
        raise ConfigError(
            "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME is required with the bootstrap password"
        )
    if bootstrap_password is not None and len(bootstrap_password) < MIN_PASSWORD_LENGTH:
        # Omnigent would create an owner who can never sign in.
        raise ConfigError(
            "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD must be at least "
            f"{MIN_PASSWORD_LENGTH} characters"
        )

    origins_raw = _get(env, "OMNIGENT_WS_ALLOWED_ORIGINS")
    if origins_raw is None:
        origins: tuple[str, ...] = (base_origin,)
    else:
        origins = tuple(
            _origin(o.strip(), "OMNIGENT_WS_ALLOWED_ORIGINS")
            for o in origins_raw.split(",")
            if o.strip()
        )
        if not origins:
            raise ConfigError("OMNIGENT_WS_ALLOWED_ORIGINS must list at least one origin")

    features = _get(env, "OMNIGENT_FEATURES")
    if features is not None:
        warnings.append(f"OMNIGENT_FEATURES={features!r} ignored: the image pins every feature off")
    for name in sorted(env):
        if name.startswith(SCRUBBED_ENV_PREFIXES):
            warnings.append(f"{name} removed: this image does not wire that integration")

    sandbox_server_url = _get(env, "CFO_SANDBOX_SERVER_URL") or "http://omnigent.internal"
    _origin(sandbox_server_url, "CFO_SANDBOX_SERVER_URL")

    installation_id = _get(env, "CFO_INSTALLATION_ID")
    if installation_id is not None and not re.fullmatch(
        r"ins_[0-9a-hjkmnp-tv-z]{26}", installation_id
    ):
        raise ConfigError(f"CFO_INSTALLATION_ID is not an installation ID: {installation_id!r}")

    return ServerImageConfig(
        installation_initialized=parse_bool(env, "CFO_INSTALLATION_INITIALIZED", None),
        replica=None if for_app else parse_replica(env),
        base_url=base_url,
        ws_allowed_origins=origins,
        sharing=parse_sharing(env),
        admins=parse_list(env, "CFO_OMNIGENT_ADMINS"),
        allowed_domains=parse_list(env, "CFO_OMNIGENT_ALLOWED_DOMAINS"),
        sandbox_server_url=sandbox_server_url,
        response_barrier_timeout_s=parse_seconds(env, "CFO_RESPONSE_BARRIER_TIMEOUT_S", 10.0),
        transcript_barrier_timeout_s=parse_seconds(
            env, "CFO_TRANSCRIPT_BARRIER_TIMEOUT_S", 3.0, below=SENDER_ACK_TIMEOUT_S
        ),
        restore_deadline_s=parse_seconds(env, "CFO_RESTORE_DEADLINE_S", 300.0),
        final_sync_timeout_s=parse_seconds(env, "CFO_FINAL_SYNC_TIMEOUT_S", 300.0),
        litestream_ready_timeout_s=parse_seconds(env, "CFO_LITESTREAM_READY_TIMEOUT_S", 60.0),
        installation_id=installation_id,
        bootstrap_credentials=bootstrap_password is not None,
        warnings=tuple(warnings),
    )


def app_environment(config: ServerImageConfig, env: Mapping[str, str]) -> dict[str, str]:
    """The environment the Omnigent app process runs with.

    Starts from the container's environment, removes the variables of integrations the image
    does not wire, and applies the pinned values.
    """
    out = {
        k: v
        for k, v in env.items()
        if not k.startswith(SCRUBBED_ENV_PREFIXES) and k not in REMOVED_APP_ENV
    }
    out.update(PINNED_ENV)
    out["OMNIGENT_WS_ALLOWED_ORIGINS"] = ",".join(config.ws_allowed_origins)
    # Omnigent reads these only when create_app gets no static value; the app passes static
    # values, so they are set for consistency with GET /v1/info, never as the authority.
    out["OMNIGENT_SHARING_MODE"] = config.sharing.sharing_mode
    out["OMNIGENT_PUBLIC_SHARING"] = "on" if config.sharing.public_sharing else "off"
    out["OMNIGENT_PUBLIC_SHARING_MAX_LEVEL"] = config.sharing.public_sharing_max_level
    out["OMNIGENT_DEFAULT_PUBLIC_SESSIONS"] = config.sharing.default_public_sessions
    return out


def litestream_environment(env: Mapping[str, str]) -> dict[str, str]:
    """The environment Litestream runs with: the container's, without the artifact token."""
    return {k: v for k, v in env.items() if k not in REMOVED_LITESTREAM_ENV}
