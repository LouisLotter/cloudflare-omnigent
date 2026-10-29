"""Deployment settings for the server image, parsed strictly from the environment.

The Worker forwards these as container environment variables (variables and secrets). Every
value is checked here, once, before anything starts. Two rules:

- **Unset means the restrictive default.** Sharing is off, public access is off, new sessions
  are never public by default, and no extra admins or domains are listed.
- **Malformed means refuse to start.** Omnigent's own parsers fail open (an unknown sharing
  mode becomes ``on``); this module never does. :class:`ConfigError` names the variable. An
  error never repeats a URL-valued setting: a mistaken one may carry credentials.

Omnigent's artifacts (uploaded files, agent bundles, session resources) live in their own S3
bucket, an R2 bucket on Cloudflare (``OMNIGENT_ARTIFACT_URI``, with the ``AWS_*`` credentials
only the app receives). The container's disk does not survive a replacement or a release's
restart, so an image without that setting refuses to start; ``CFO_ALLOW_LOCAL_ARTIFACTS``
allows the disk in tests and local runs only (G2-DUR-001).

Some settings are pinned by the image and cannot be changed by the environment at all:
accounts mode, the release-feature set (``OMNIGENT_FEATURES``, which must never contain
``harness_install``), default-public sessions off, the database and data paths, and the
managed-sandbox reaper. Variables that would select integrations the image does not wire
(Databricks, AWS KMS, Vault) are removed from the app's environment.

**GitHub linking** (D22, WP5.9) is Omnigent's own, with its credential store encrypted by the
platform Worker's key service on ``platform.internal`` (core change 19). It is on when, and only
when, the GitHub App's client ID, client secret and redirect URI and the key service's signing
key and key ID are all set (:func:`parse_github_linking`). Then exactly those settings, the
App's optional ID and slug, and the key service's URL reach the app, with the credential cipher
pinned to ``http``; nothing else under ``OMNIGENT_GITHUB_APP_`` or ``OMNIGENT_CREDENTIAL_``
does. The App's private key in particular never does: Omnigent's linking does not use it, and it
would let the server act as the App on every repository the App is installed on.
"""

from __future__ import annotations

import math
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from urllib.parse import SplitResult, urlsplit

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

#: Environment variables the image removes before starting Omnigent: Databricks Connect, the
#: credential-store ciphers (AWS KMS, Vault, the HTTP key service) and the GitHub App. GitHub
#: linking adds back only :data:`GITHUB_APP_ENV` and :data:`KEY_SERVICE_ENV`, when it is on.
SCRUBBED_ENV_PREFIXES: tuple[str, ...] = (
    "OMNIGENT_DATABRICKS_",
    "OMNIGENT_CREDENTIAL_",
    "OMNIGENT_GITHUB_APP_",
    "VAULT_",
)
#: GitHub linking's required App settings: Omnigent's ``GitHubAppConfig.from_env`` names.
GITHUB_APP_REQUIRED: tuple[str, ...] = (
    "OMNIGENT_GITHUB_APP_CLIENT_ID",
    "OMNIGENT_GITHUB_APP_CLIENT_SECRET",
    "OMNIGENT_GITHUB_APP_REDIRECT_URI",
)
#: Every App setting that reaches the app: the required ones, the App's numeric ID and its slug
#: (Omnigent's "Install" link). Not the private key or its path.
GITHUB_APP_ENV: tuple[str, ...] = (
    *GITHUB_APP_REQUIRED,
    "OMNIGENT_GITHUB_APP_ID",
    "OMNIGENT_GITHUB_APP_SLUG",
)
#: The key service's settings (core change 19's ``http`` cipher), as Omnigent names them.
KEY_SERVICE_URL_ENV = "OMNIGENT_CREDENTIAL_HTTP_URL"
KEY_SERVICE_SIGNING_KEY_ENV = "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY"
KEY_SERVICE_SIGNING_KEY_ID_ENV = "OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID"
KEY_SERVICE_ENV: tuple[str, ...] = (
    KEY_SERVICE_URL_ENV,
    KEY_SERVICE_SIGNING_KEY_ENV,
    KEY_SERVICE_SIGNING_KEY_ID_ENV,
)
#: Omnigent's cipher selector, pinned to the key service while GitHub linking is on.
CREDENTIAL_CIPHER_ENV = "OMNIGENT_CREDENTIAL_CIPHER"
CREDENTIAL_CIPHER = "http"
#: The platform Worker's key service, on the server container's private intercept.
KEY_SERVICE_HOST = "platform.internal"
DEFAULT_KEY_SERVICE_URL = f"http://{KEY_SERVICE_HOST}/key-service/v1"
#: Omnigent's GitHub callback, on the installation's own origin.
GITHUB_CALLBACK_PATH = "/v1/connections/github/callback"
#: Omnigent's limits for the signing key (``http_cipher.MIN_SIGNING_KEY_BYTES``, ``_KEY_ID_RE``).
MIN_KEY_SERVICE_SIGNING_KEY_BYTES = 32
_KEY_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")
#: GitHub's identifiers: a client ID (``Iv1.…``, ``Iv23…``), an App ID and an App slug.
_GITHUB_CLIENT_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")
_GITHUB_APP_ID = re.compile(r"[0-9]{1,20}")
_GITHUB_SLUG = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?")
#: How long Omnigent waits for a dropped runner to reconnect before failing its session
#: (``OMNIGENT_RUNNER_DISCONNECT_GRACE_S``; its default is the 90 s liveness lease). A computer's
#: tunnel may drop while a capture pauses it, and RC-21 allows such a reconnect 100 s, so the
#: design's timing budget sets 150 s (core change 12).
RUNNER_DISCONNECT_GRACE_S = "150"
#: Variables the image sets itself; a value from the environment is replaced.
PINNED_ENV: Mapping[str, str] = {
    "OMNIGENT_RUNNER_DISCONNECT_GRACE_S": RUNNER_DISCONNECT_GRACE_S,
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
#: ``OMNIGENT_ARTIFACT_URI`` is set again from the checked value, or left out for local disk.
REMOVED_APP_ENV: tuple[str, ...] = (
    "OMNIGENT_HARNESS_INSTALL_ENABLED",
    "OMNIGENT_ADMIN_LIST_PATH",
    "LITESTREAM_ACCESS_KEY_ID",
    "LITESTREAM_SECRET_ACCESS_KEY",
    "OMNIGENT_ARTIFACT_URI",
)
#: The artifact store's credentials, read by ``boto3`` in the app process only.
ARTIFACT_CREDENTIALS: tuple[str, ...] = ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")
#: The S3 store's checksum settings unless the environment names others: checksums only where
#: S3 requires them. botocore's default since 1.36 (``when_supported``) sends CRC32 checksums,
#: as an ``aws-chunked`` trailer over HTTPS, which R2 must accept; ``when_required`` sends a
#: plain ``PutObject``, the same request over HTTPS as over the tests' HTTP (Codex G2-DUR-001).
ARTIFACT_CHECKSUM_DEFAULTS: Mapping[str, str] = {
    "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
    "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required",
}
_S3 = "s3://"
#: An S3 bucket name as S3 and R2 accept it (lowercase letters, digits, dots and hyphens).
_BUCKET = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")
#: The only variables Litestream's processes (``restore`` and ``replicate``) receive: the
#: replica's credentials, and what any process needs to run and to make TLS connections. Its
#: settings come from its configuration file, read with ``-no-expand-env``. An allowlist, so no
#: other credential the container holds reaches it: not the bootstrap password, the cookie
#: secret, the launcher's signing key or the artifact store's credentials (G2-SEC-001).
LITESTREAM_ENV: tuple[str, ...] = (
    "LITESTREAM_ACCESS_KEY_ID",
    "LITESTREAM_SECRET_ACCESS_KEY",
    "PATH",
    "HOME",
    "TZ",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
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
class ArtifactSettings:
    """Where Omnigent keeps its artifacts."""

    #: ``s3://<bucket>[/<prefix>]``, or ``None`` for the container's disk (tests only).
    uri: str | None

    @property
    def bucket(self) -> str | None:
        return None if self.uri is None else self.uri[len(_S3) :].partition("/")[0]


@dataclass(frozen=True)
class GitHubLinking:
    """Omnigent's GitHub linking (D22): on only with the App and the key service both set.

    Secret values are not kept here: :func:`app_environment` copies them from the environment.
    """

    enabled: bool = False
    #: Why it is off, for the start's log (names only); ``None`` when on.
    off_reason: str | None = "not configured"
    client_id: str | None = None
    redirect_uri: str | None = None
    key_service_url: str | None = None
    signing_key_id: str | None = None


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
    #: The artifact store; the container's disk only with ``CFO_ALLOW_LOCAL_ARTIFACTS``.
    artifacts: ArtifactSettings = field(default_factory=lambda: ArtifactSettings(uri=None))
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
    #: Omnigent's GitHub linking and its key service (D22, WP5.9).
    github: GitHubLinking = field(default_factory=GitHubLinking)
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


def _split(url: str, name: str) -> SplitResult:
    """``urlsplit``, whose ``ValueError`` (an unclosed ``[``, a bad port) is a refusal too."""
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 - raises for a malformed port
    except ValueError:
        raise ConfigError(f"{name} is not a well-formed URL") from None
    return parts


def _origin(url: str, name: str) -> str:
    parts = _split(url, name)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConfigError(f"{name} must be an http or https URL with a host")
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
    parts = _split(url, "CFO_REPLICA_URL")
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
        raise ConfigError("CFO_REPLICA_URL must be s3://<bucket>/<path> (or file:// in tests)")
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


def _key_service_url(env: Mapping[str, str]) -> str:
    """The key service's base URL: ``platform.internal`` by default, and only there.

    Plaintext credentials travel in its request and reply bodies, so it must stay on the server
    container's private intercept. ``CFO_ALLOW_LOOPBACK_KEY_SERVICE`` also allows a loopback host,
    for tests only. Errors never repeat the value.
    """
    url = _get(env, KEY_SERVICE_URL_ENV) or DEFAULT_KEY_SERVICE_URL
    parts = _split(url, KEY_SERVICE_URL_ENV)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ConfigError(f"{KEY_SERVICE_URL_ENV} must be an http or https URL with a host")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise ConfigError(
            f"{KEY_SERVICE_URL_ENV} must not carry credentials, a query or a fragment"
        )
    if parts.port == 0:
        raise ConfigError(f"{KEY_SERVICE_URL_ENV} must not use port 0")
    allowed = {KEY_SERVICE_HOST}
    if parse_bool(env, "CFO_ALLOW_LOOPBACK_KEY_SERVICE", False):
        allowed |= {"127.0.0.1", "localhost", "::1"}
    if parts.hostname.lower() not in allowed:
        raise ConfigError(
            f"{KEY_SERVICE_URL_ENV} must name the platform's key service on {KEY_SERVICE_HOST}"
        )
    return url.rstrip("/")


def _secret_value(env: Mapping[str, str], name: str, *, max_length: int = 4096) -> None:
    """A secret's value: printable, without whitespace inside. Errors never repeat it."""
    value = _get(env, name) or ""
    if len(value) > max_length or any(ch.isspace() or not ch.isprintable() for ch in value):
        raise ConfigError(f"{name} is malformed")


def parse_github_linking(
    env: Mapping[str, str], base_origin: str, warnings: list[str]
) -> GitHubLinking:
    """Omnigent's GitHub linking (D22): on when, and only when, the App and the key service are
    both fully set.

    - None of the App's required settings: off, quietly.
    - Some of them, or the App without the key service: off, with a warning that names what is
      missing (never a value). A half-configured optional feature does not stop the server.
    - All of them: every value is checked, and a malformed one stops the start (exit 78), as
      every other malformed setting does. The redirect URI must be Omnigent's callback on this
      installation's own origin, and the key service must be on ``platform.internal``.
    """
    app_set = [name for name in GITHUB_APP_REQUIRED if _get(env, name) is not None]
    service_set = [
        name
        for name in (KEY_SERVICE_SIGNING_KEY_ENV, KEY_SERVICE_SIGNING_KEY_ID_ENV)
        if _get(env, name) is not None
    ]
    if not app_set:
        return GitHubLinking(off_reason="not configured")
    missing = [name for name in GITHUB_APP_REQUIRED if name not in app_set] + [
        name
        for name in (KEY_SERVICE_SIGNING_KEY_ENV, KEY_SERVICE_SIGNING_KEY_ID_ENV)
        if name not in service_set
    ]
    if missing:
        warnings.append(f"GitHub linking is off: {', '.join(missing)} not set")
        return GitHubLinking(off_reason="incomplete")

    client_id = _get(env, "OMNIGENT_GITHUB_APP_CLIENT_ID") or ""
    if not _GITHUB_CLIENT_ID.fullmatch(client_id):
        raise ConfigError("OMNIGENT_GITHUB_APP_CLIENT_ID is not a GitHub App client ID")
    _secret_value(env, "OMNIGENT_GITHUB_APP_CLIENT_SECRET", max_length=256)
    redirect_uri = _get(env, "OMNIGENT_GITHUB_APP_REDIRECT_URI") or ""
    # Omnigent serves under its base path, when one is set (``OMNIGENT_WEB_BASE_PATH``).
    base_path = (_get(env, "OMNIGENT_WEB_BASE_PATH") or "").strip("/")
    expected = f"{base_origin}{'/' + base_path if base_path else ''}{GITHUB_CALLBACK_PATH}"
    if redirect_uri != expected:
        raise ConfigError(
            "OMNIGENT_GITHUB_APP_REDIRECT_URI must be Omnigent's GitHub callback on "
            f"OMNIGENT_ACCOUNTS_BASE_URL's origin: {expected}"
        )
    app_id = _get(env, "OMNIGENT_GITHUB_APP_ID")
    if app_id is not None and not _GITHUB_APP_ID.fullmatch(app_id):
        raise ConfigError("OMNIGENT_GITHUB_APP_ID must be the App's numeric ID")
    slug = _get(env, "OMNIGENT_GITHUB_APP_SLUG")
    if slug is not None and not _GITHUB_SLUG.fullmatch(slug):
        raise ConfigError("OMNIGENT_GITHUB_APP_SLUG must be the App's slug")

    signing_key = _get(env, KEY_SERVICE_SIGNING_KEY_ENV) or ""
    if len(signing_key.encode("utf-8")) < MIN_KEY_SERVICE_SIGNING_KEY_BYTES:
        raise ConfigError(
            f"{KEY_SERVICE_SIGNING_KEY_ENV} must be at least "
            f"{MIN_KEY_SERVICE_SIGNING_KEY_BYTES} bytes"
        )
    _secret_value(env, KEY_SERVICE_SIGNING_KEY_ENV)
    signing_key_id = _get(env, KEY_SERVICE_SIGNING_KEY_ID_ENV) or ""
    if not _KEY_ID.fullmatch(signing_key_id):
        raise ConfigError(
            f"{KEY_SERVICE_SIGNING_KEY_ID_ENV} must be 1-128 letters, digits, '.', '_' or '-'"
        )
    return GitHubLinking(
        enabled=True,
        off_reason=None,
        client_id=client_id,
        redirect_uri=redirect_uri,
        key_service_url=_key_service_url(env),
        signing_key_id=signing_key_id,
    )


def parse_artifacts(
    env: Mapping[str, str], replica: ReplicaSettings | None, warnings: list[str]
) -> ArtifactSettings:
    """Parse the artifact store. Unset is a refusal, never the container's disk, unless
    ``CFO_ALLOW_LOCAL_ARTIFACTS`` says this is a test or a local run."""
    uri = _get(env, "OMNIGENT_ARTIFACT_URI")
    if uri is None:
        if not parse_bool(env, "CFO_ALLOW_LOCAL_ARTIFACTS", False):
            raise ConfigError(
                "OMNIGENT_ARTIFACT_URI is required: s3://<bucket>[/<prefix>], a bucket of its "
                "own. On the container's disk, uploaded files are lost at every restart "
                "(CFO_ALLOW_LOCAL_ARTIFACTS allows that in tests only)"
            )
        warnings.append(
            "artifacts are on the container's disk (CFO_ALLOW_LOCAL_ARTIFACTS): uploaded files "
            "are lost at every restart; for tests only"
        )
        return ArtifactSettings(uri=None)
    # Checked as the string Omnigent's own parser splits (``_parse_s3_uri``: the literal
    # ``s3://`` prefix, then the bucket up to the first ``/``), never through a URL parser that
    # would read it differently. No error repeats the value.
    if not uri.startswith(_S3):
        raise ConfigError("OMNIGENT_ARTIFACT_URI must be s3://<bucket>[/<prefix>]")
    bucket, _, prefix = uri[len(_S3) :].partition("/")
    if not _BUCKET.fullmatch(bucket):
        raise ConfigError(
            "OMNIGENT_ARTIFACT_URI must be s3://<bucket>[/<prefix>] with a valid bucket name "
            "and nothing else"
        )
    if any(ch in "?#\\" or ch.isspace() or not ch.isprintable() for ch in prefix) or any(
        s in (".", "..") for s in prefix.split("/")
    ):
        raise ConfigError("OMNIGENT_ARTIFACT_URI's prefix must be a plain path")
    for name in ARTIFACT_CREDENTIALS:
        if _get(env, name) is None:
            raise ConfigError(f"{name} is required for the artifact store")
    # Omnigent's store takes AWS_ENDPOINT_URL_S3, else AWS_ENDPOINT_URL: both are checked, so a
    # malformed one is exit 78, never botocore's error at the first request, which would print it
    # whole (Codex G2-DUR-001 r2-1).
    for name in ("AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL"):
        endpoint = _get(env, name)
        if endpoint is not None:
            _origin(endpoint, name)
    if (
        replica is not None
        and replica.url.startswith("s3:")
        and urlsplit(replica.url).netloc == bucket
    ):
        raise ConfigError("OMNIGENT_ARTIFACT_URI must name a bucket of its own, not the replica's")
    return ArtifactSettings(uri=uri)


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
    github = parse_github_linking(env, base_origin, warnings)
    for name in sorted(env):
        if name.startswith(SCRUBBED_ENV_PREFIXES) and name not in _linking_env(github):
            warnings.append(f"{name} removed: this image does not wire that integration")

    sandbox_server_url = _get(env, "CFO_SANDBOX_SERVER_URL") or "http://omnigent.internal"
    _origin(sandbox_server_url, "CFO_SANDBOX_SERVER_URL")

    installation_id = _get(env, "CFO_INSTALLATION_ID")
    if installation_id is not None and not re.fullmatch(
        r"ins_[0-9a-hjkmnp-tv-z]{26}", installation_id
    ):
        raise ConfigError(f"CFO_INSTALLATION_ID is not an installation ID: {installation_id!r}")

    initialized = parse_bool(env, "CFO_INSTALLATION_INITIALIZED", None)
    replica = None if for_app else parse_replica(env)
    artifacts = parse_artifacts(env, replica, warnings)
    return ServerImageConfig(
        installation_initialized=initialized,
        replica=replica,
        base_url=base_url,
        ws_allowed_origins=origins,
        artifacts=artifacts,
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
        github=github,
        warnings=tuple(warnings),
    )


def _linking_env(github: GitHubLinking) -> frozenset[str]:
    """The scrubbed-prefix variables GitHub linking passes to the app: none while it is off."""
    if not github.enabled:
        return frozenset()
    return frozenset((*GITHUB_APP_ENV, *KEY_SERVICE_ENV, CREDENTIAL_CIPHER_ENV))


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
    if config.github.enabled:
        # Exactly the App's settings Omnigent reads, the key service's, and the pinned cipher.
        for name in GITHUB_APP_ENV:
            value = _get(env, name)
            if value is not None:
                out[name] = value
        out[KEY_SERVICE_URL_ENV] = config.github.key_service_url or DEFAULT_KEY_SERVICE_URL
        for name in (KEY_SERVICE_SIGNING_KEY_ENV, KEY_SERVICE_SIGNING_KEY_ID_ENV):
            out[name] = _get(env, name) or ""
        out[CREDENTIAL_CIPHER_ENV] = CREDENTIAL_CIPHER
        # The key service is reached directly, never through a proxy (httpx honours these).
        for name in ("NO_PROXY", "no_proxy"):
            hosts = [h for h in out.get(name, "").split(",") if h.strip()]
            if KEY_SERVICE_HOST not in hosts:
                out[name] = ",".join([*hosts, KEY_SERVICE_HOST])
    if config.artifacts.uri is not None:
        out["OMNIGENT_ARTIFACT_URI"] = config.artifacts.uri
        for name, value in ARTIFACT_CHECKSUM_DEFAULTS.items():
            out.setdefault(name, value)
    out["OMNIGENT_WS_ALLOWED_ORIGINS"] = ",".join(config.ws_allowed_origins)
    # Omnigent reads these only when create_app gets no static value; the app passes static
    # values, so they are set for consistency with GET /v1/info, never as the authority.
    out["OMNIGENT_SHARING_MODE"] = config.sharing.sharing_mode
    out["OMNIGENT_PUBLIC_SHARING"] = "on" if config.sharing.public_sharing else "off"
    out["OMNIGENT_PUBLIC_SHARING_MAX_LEVEL"] = config.sharing.public_sharing_max_level
    out["OMNIGENT_DEFAULT_PUBLIC_SESSIONS"] = config.sharing.default_public_sessions
    return out


def litestream_environment(env: Mapping[str, str]) -> dict[str, str]:
    """The environment Litestream runs with: the replica's credentials and the process basics in
    :data:`LITESTREAM_ENV`, nothing else from the container's."""
    return {k: env[k] for k in LITESTREAM_ENV if k in env}
