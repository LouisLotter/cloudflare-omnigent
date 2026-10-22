"""The launcher's settings, from the server container's environment.

The Worker passes them as container variables (``SERVER_ENV_<NAME>``, docs/secrets.md):

- ``CFO_LAUNCHER_SIGNING_KEY``: the launcher API's HMAC key, its UTF-8 bytes, at least 32 of
  them. Its own key, separate from the credential key service's (3.C, the lead's answer to Q7).
- ``CFO_LAUNCHER_SIGNING_KEY_ID``: that key's ID, so the Worker can rotate keys.
- ``CFO_LAUNCHER_URL``: optional; the launcher API's base URL, ``http://platform.internal/launcher``
  unless set (tests point it at a fake).
- ``CFO_LAUNCHER_DURABILITY_TIMEOUT_S``: optional; how long a lifecycle effect waits for the
  database to replicate before it fails, 10 s unless set.

Neither key setting means the launcher is not configured: it is still registered, and every
call fails with a readable error. Only one of them, or a malformed value, is a configuration
error, as core change 19's key-service settings are.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from cloudflare_omnigent.sandbox import protocol

SIGNING_KEY_ENV = "CFO_LAUNCHER_SIGNING_KEY"
SIGNING_KEY_ID_ENV = "CFO_LAUNCHER_SIGNING_KEY_ID"
URL_ENV = "CFO_LAUNCHER_URL"
DURABILITY_TIMEOUT_ENV = "CFO_LAUNCHER_DURABILITY_TIMEOUT_S"

DEFAULT_DURABILITY_TIMEOUT_S = 10.0
#: The replication wait counts against Omnigent's 240 s online wait (Timing budget).
MAX_DURABILITY_TIMEOUT_S = 60.0


class LauncherConfigError(ValueError):
    """A launcher setting is missing or malformed. The message names the variable, never a value."""


def check_base_url(url: str, name: str = URL_ENV) -> str:
    """An ``http(s)`` URL with a host and no credentials, query or fragment; no trailing slash."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise LauncherConfigError(f"{name} is not a URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise LauncherConfigError(f"{name} must be an http or https URL with a host")
    if parts.username or parts.password or parts.query or parts.fragment or port == 0:
        raise LauncherConfigError(f"{name} must not carry credentials, a query or a fragment")
    return url.rstrip("/")


@dataclass(frozen=True)
class LauncherSettings:
    """Everything the launcher needs to reach the launcher API. The key is never printed."""

    signing_key: bytes = field(repr=False)
    signing_key_id: str
    base_url: str = protocol.DEFAULT_BASE_URL
    durability_timeout_s: float = DEFAULT_DURABILITY_TIMEOUT_S

    def __post_init__(self) -> None:
        if len(self.signing_key) < protocol.MIN_SIGNING_KEY_BYTES:
            raise LauncherConfigError(
                f"{SIGNING_KEY_ENV} must be at least {protocol.MIN_SIGNING_KEY_BYTES} bytes"
            )
        if protocol.SIGNING_KEY_ID_RE.fullmatch(self.signing_key_id) is None:
            raise LauncherConfigError(
                f"{SIGNING_KEY_ID_ENV} must be 1 to 128 letters, digits, '.', '_' or '-'"
            )
        object.__setattr__(self, "base_url", check_base_url(self.base_url))
        timeout = self.durability_timeout_s
        if not protocol.finite_seconds(timeout) or not 0 < timeout <= MAX_DURABILITY_TIMEOUT_S:
            raise LauncherConfigError(
                f"{DURABILITY_TIMEOUT_ENV} must be more than 0 and at most "
                f"{MAX_DURABILITY_TIMEOUT_S:g} seconds"
            )


def _get(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def settings_from_env(env: Mapping[str, str]) -> LauncherSettings | None:
    """The launcher's settings, or ``None`` when neither key setting is set.

    :raises LauncherConfigError: When only one key setting is set, or any value is malformed.
    """
    key = _get(env, SIGNING_KEY_ENV)
    key_id = _get(env, SIGNING_KEY_ID_ENV)
    if key is None and key_id is None:
        return None
    if key is None or key_id is None:
        missing = SIGNING_KEY_ENV if key is None else SIGNING_KEY_ID_ENV
        raise LauncherConfigError(f"the launcher is only partly configured: also set {missing}")
    timeout_raw = _get(env, DURABILITY_TIMEOUT_ENV)
    if timeout_raw is None:
        timeout = DEFAULT_DURABILITY_TIMEOUT_S
    else:
        try:
            timeout = float(timeout_raw)
        except ValueError:
            raise LauncherConfigError(f"{DURABILITY_TIMEOUT_ENV} must be a number") from None
    return LauncherSettings(
        signing_key=key.encode("utf-8"),
        signing_key_id=key_id,
        base_url=_get(env, URL_ENV) or protocol.DEFAULT_BASE_URL,
        durability_timeout_s=timeout,
    )
