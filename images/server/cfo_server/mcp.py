"""Omnigent's MCP registry on the platform (WP5.10, WP8.14): the services administrators add on
Omnigent's own page, the shipped manifests as that page's presets, and the installation's choices,
checked, as the registry configuration Omnigent's ``McpRegistryConfig`` accepts.

**The page** (owner decision D57): Omnigent's Settings → MCP → Add MCP server, where an
administrator adds a service at run time with its URL, login type and tools; Omnigent keeps it in
its database (``McpServiceStore``) and its secrets in the credential store, and it is live without
a restart. The registry is built whenever the key service is on, so the page is there with or
without a chosen service; Omnigent's own ``OMNIGENT_MCP_ADMIN_SERVICES=0`` turns it off. Page
services are checked against the platform's destination rules
(:class:`PlatformDestinationPolicy`), which Omnigent applies when a service is saved and on every
connection it opens for one, and Omnigent refuses their redirects.

**Presets** are the shipped manifests the page can take (login type none, an API token or OAuth;
not GitHub's own link), offered as starting points in its Add form unless the installation's
choices already turn them on. ``${origin}`` becomes a placeholder the administrator replaces.

A **manifest** is one Omnigent registry entry (``McpService``) that ships in the image, under
``images/server/services/<id>.json`` in the repository and ``/opt/cfo/services`` in the image,
reviewed and released with the code. It adds one field of its own, ``asks``: what the installer
asks for when the service is turned on. Nothing in it is about approvals: writes go through
Omnigent's own policies as they are (owner decision D43). The format::

    {"manifest": 1,
     "asks": ["origin", "client_id", "client_secret"],   # any of them, or none
     "service": {"id": "tracker", "title": "...", "description": "...",
                 "url": "${origin}/mcp", "auth": "oauth", "tools": ["whoami"],
                 "oauth": {"authorize_url": "${origin}/authorize",
                           "token_url": "${origin}/token",
                           "client_id": "...", "scopes": ["..."]},
                 "timeout": 60}}

The **installation's choices** are server settings the installer stores as Worker secrets
(``SERVER_ENV_<NAME>``), never whole manifests:

- ``CFO_MCP_SERVICES``: the IDs of the services that are on, separated by commas;
- per service that asks for them (``<KEY>`` is the ID in capitals, ``-`` as ``_``):
  ``CFO_MCP_ORIGIN_<KEY>`` (the service's ``https://`` origin, which replaces ``${origin}``),
  ``CFO_MCP_CLIENT_ID_<KEY>`` and ``CFO_MCP_CLIENT_SECRET_<KEY>`` (its OAuth client). The client
  secret stays in the app's environment under that name, which the entry's
  ``client_secret_env`` names: Omnigent reads it there for each token request;
- ``OMNIGENT_MCP_OAUTH_STATE_SECRET``: Omnigent's own name, the key its OAuth state is signed
  with (at least 32 characters), made by the installer.

**Destination rules** (what remains of WP5.7), on every URL the server calls or sends a browser
to (``url``, ``authorize_url``, ``token_url``): ``https`` only; no user name, password, query or
fragment; a host name, never an IP literal; not ``localhost`` or under ``.localhost``,
``.internal`` or ``.local``; a top-level label that is a real one (letters, or ``xn--``), so no
numeric host like ``2130706433`` either. For a manifest and the installation's choices they are
checked here, at every start; Omnigent does not follow their redirects (the MCP SDK's same-origin
ones aside), and a name that resolves to a private address is not caught, since only the
installer chooses those origins. For a page service, Omnigent checks the same rules through
:class:`PlatformDestinationPolicy`, also every address the host resolves to (no loopback,
private, link-local or other non-public range), and refuses every redirect.

Every problem is a :class:`~cfo_server.config.ConfigError` that names the setting or the
manifest's field and never repeats a value: the start stops with exit 78. ``CFO_ALLOW_LOOPBACK_MCP``
allows ``http://127.0.0.1`` and ``http://localhost`` destinations instead, for tests only (the
entry then carries Omnigent's ``allow_http``, and the page's rules allow loopback addresses), as
``CFO_ALLOW_LOOPBACK_KEY_SERVICE`` does for the key service.
"""

from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

#: Where the image keeps the shipped manifests: ``/opt/cfo/services``, beside
#: ``/opt/cfo/cfo_server``; ``images/server/services`` in a checkout.
MANIFESTS_DIR = Path(__file__).resolve().parent.parent / "services"
MANIFEST_VERSION = 1

#: The settings, as the server receives them.
SERVICES_ENV = "CFO_MCP_SERVICES"
ORIGIN_ENV = "CFO_MCP_ORIGIN_"
CLIENT_ID_ENV = "CFO_MCP_CLIENT_ID_"
CLIENT_SECRET_ENV = "CFO_MCP_CLIENT_SECRET_"
#: Omnigent's own names (``omnigent/server/mcp_registry.py``), pinned by the coupling tests.
STATE_SECRET_ENV = "OMNIGENT_MCP_OAUTH_STATE_SECRET"
REGISTRY_ENV = "OMNIGENT_MCP_REGISTRY"
#: Omnigent's minimum for the state secret (``McpRegistry.__init__``).
MIN_STATE_SECRET_CHARS = 32
#: Omnigent's own switch for its MCP page (``omnigent/server/mcp_registry.py``): ``0`` turns off
#: the services administrators add there. The app reads it too, so both decide alike.
ADMIN_SERVICES_ENV = "OMNIGENT_MCP_ADMIN_SERVICES"
#: Omnigent's switch that loosens its default destination rules
#: (``omnigent/server/mcp_destinations.py``). Removed from the app's environment: the image
#: passes the platform's rules, and nothing else may decide them.
ALLOW_PRIVATE_ENV = "OMNIGENT_MCP_ALLOW_PRIVATE_DESTINATIONS"
#: The test switch: loopback HTTP destinations allowed.
ALLOW_LOOPBACK_ENV = "CFO_ALLOW_LOOPBACK_MCP"

ASKS = ("origin", "client_id", "client_secret")
#: The auth modes a manifest may use: Omnigent's, without Databricks, which the image never wires.
AUTH_MODES = ("none", "bearer", "oauth", "github")
#: The auth modes Omnigent's page takes (``McpServicePreset``, ``AdminServiceSettings``). A
#: manifest with another (GitHub's own link) is offered only through the installer's ``services``.
PAGE_AUTH_MODES = ("none", "bearer", "oauth")
#: What ``${origin}`` becomes in a preset: a placeholder for the administrator to replace, which
#: the destination rules refuse until then.
PRESET_ORIGIN = "https://<your-host>"
#: A service ID: Omnigent's pattern without ``_``, so that ``<KEY>`` names one service only.
SERVICE_ID = re.compile(r"[a-z][a-z0-9-]{0,39}")
TOOL_NAME = re.compile(r"[A-Za-z0-9_.-]{1,128}")
SCOPE = re.compile(r"[!#-\[\]-~]{1,256}")  # printable ASCII without space, '"' or '\'
CLIENT_ID = re.compile(r"[!-~]{1,256}")
ORIGIN_PLACEHOLDER = "${origin}"
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_TLD = re.compile(r"(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})")
_REFUSED_SUFFIXES = ("localhost", "internal", "local")
_SERVICE_KEYS = frozenset(
    {"id", "title", "description", "url", "auth", "oauth", "tools", "timeout"}
)
_OAUTH_KEYS = frozenset({"authorize_url", "token_url", "client_id", "scopes", "resource"})
_URL_FIELDS = ("url",)
_OAUTH_URL_FIELDS = ("authorize_url", "token_url")


class ManifestError(ValueError):
    """A shipped manifest or a choice is not usable. The message names it, never a value."""


@dataclass(frozen=True)
class Manifest:
    """A shipped manifest, checked: its entry as written (placeholders kept), and its asks."""

    id: str
    asks: tuple[str, ...]
    service: Mapping[str, Any] = field(compare=False)


@dataclass(frozen=True)
class McpRegistrySettings:
    """Omnigent's MCP registry, as the image turns it on. Holds no secret value."""

    enabled: bool = False
    #: Why it is off, for the start's log (names only); ``None`` when on.
    off_reason: str | None = "not configured"
    #: The installation's chosen services that are on, in the order chosen (the registry's
    #: ``services``, read-only on the page).
    services: tuple[str, ...] = ()
    #: Whether administrators may add services on Omnigent's MCP page: the registry gets a
    #: service store (WP8.14).
    admin_services: bool = False
    #: The test switch (``CFO_ALLOW_LOOPBACK_MCP``): the page's rules also allow the loopback.
    allow_loopback: bool = False
    #: Omnigent's ``McpRegistryConfig`` as data: ``public_url``, the entries and the page's
    #: presets. Client secrets appear only as the names of the variables that hold them.
    registry: Mapping[str, Any] | None = field(default=None, compare=False)
    #: The variables the app process must keep: the client secrets the entries name.
    secret_env: tuple[str, ...] = ()

    def summary(self) -> str:
        """For the start's log line: what is on, by name, or why it is off."""
        if not self.enabled:
            return f"off: {self.off_reason}"
        parts = [f"services {', '.join(self.services)}"] if self.services else []
        parts.append("the page" if self.admin_services else "no page")
        return f"on: {'; '.join(parts)}"


@dataclass(frozen=True)
class PlatformDestinationPolicy:
    """The platform's destination rules as Omnigent's ``McpDestinationPolicy``, for the services
    administrators add on Omnigent's page (WP8.14). Omnigent checks them when a service is saved
    (its URLs, and every address the host resolves to), on every connection it opens for one (the
    address again, the connection pinned to it, so a name that later resolves elsewhere is
    refused), and on the URLs its OAuth discovery and client registration read; it never follows a
    redirect for these services.

    A URL must pass the platform's rules (:func:`destination_problem`) and Omnigent's own default
    ones (``DefaultMcpDestinationPolicy``: at most 2048 ASCII characters, and no ``.localdomain``
    or ``.home.arpa`` host either). An address must be public (Omnigent's ``globally_routable``:
    no loopback, private, link-local, shared, reserved or multicast range, nor an IPv4 address of
    one inside an IPv6 address). With ``allow_loopback`` (``CFO_ALLOW_LOOPBACK_MCP``, tests only),
    ``http://127.0.0.1`` and ``http://localhost`` and loopback addresses are allowed too.
    """

    allow_loopback: bool = False

    def url_problem(self, url: str) -> str | None:
        """Why *url* is refused, in words that never repeat it; ``None`` if allowed."""
        from omnigent.server.mcp_destinations import DefaultMcpDestinationPolicy

        problem = destination_problem(url, allow_loopback=self.allow_loopback)
        if problem is not None:
            return problem
        # Only the loopback names pass the platform's rules over http (the test switch), which
        # Omnigent's default refuses unless it allows private destinations.
        loopback = self.allow_loopback and url.lower().startswith("http:")
        return DefaultMcpDestinationPolicy(allow_private=loopback).url_problem(url)

    def address_allowed(self, address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
        """Whether the server may connect to *address*."""
        from omnigent.server.mcp_destinations import globally_routable

        if self.allow_loopback and address.is_loopback:
            return True
        return globally_routable(address)


def env_key(service_id: str) -> str:
    """``<KEY>`` of a service's settings: its ID in capitals, ``-`` as ``_``."""
    return service_id.upper().replace("-", "_")


def destination_problem(url: str, *, allow_loopback: bool = False) -> str | None:
    """Why ``url`` breaks a destination rule, in words that never repeat it; ``None`` if not."""
    if any(ch.isspace() or ch == "\\" or not ch.isprintable() for ch in url):
        return "it must be a plain URL"
    try:
        parts = urlsplit(url)
        # At most five digits, as the installer reads them (Codex WP5.10 r1-3).
        host_port = parts.netloc.rpartition("@")[2]
        if ":" in host_port and "]" not in host_port and len(host_port.rpartition(":")[2]) > 5:
            return "it must be a well-formed URL"
        port = parts.port
    except ValueError:
        return "it must be a well-formed URL"
    host = (parts.hostname or "").rstrip(".")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        return "it must not carry credentials"
    if parts.query or parts.fragment or url.endswith(("?", "#")):
        return "it must not carry a query or a fragment"
    if port == 0:
        return "it must not use port 0"
    if allow_loopback and parts.scheme == "http" and host in ("127.0.0.1", "localhost"):
        return None
    if parts.scheme != "https":
        return "it must be https"
    if not host:
        return "it must name a host"
    if host.startswith("[") or _is_ip(host):
        return "it must name a host, not an IP address"
    labels = host.split(".")
    if len(host) > 253 or not all(_LABEL.fullmatch(label) for label in labels):
        return "it must name a host in lower case letters, digits and hyphens"
    if len(labels) < 2 or not _TLD.fullmatch(labels[-1]):
        return "it must name a public host (a name with a real top-level domain)"
    if labels[-1] in _REFUSED_SUFFIXES or host == "localhost":
        return f"it must not be a {labels[-1]} host"
    return None


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def _text(entry: Mapping[str, Any], key: str, where: str, *, limit: int, required: bool) -> None:
    value = entry.get(key)
    if value is None and not required:
        return
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ManifestError(f"{where}'s {key} must be text of at most {limit} characters")


def check_manifest(data: object, name: str) -> Manifest:
    """One manifest file's content, checked against the format; ``name`` is the file's stem."""
    where = f"the manifest {name}"
    if not isinstance(data, dict) or set(data) != {"manifest", "asks", "service"}:
        raise ManifestError(f"{where} must hold exactly manifest, asks and service")
    if data["manifest"] != MANIFEST_VERSION:
        raise ManifestError(f"{where} has an unknown manifest version")
    asks = data["asks"]
    if (
        not isinstance(asks, list)
        or not all(isinstance(a, str) and a in ASKS for a in asks)
        or len(set(asks)) != len(asks)
    ):
        raise ManifestError(f"{where}'s asks must list some of {', '.join(ASKS)}, once each")
    service = data["service"]
    if not isinstance(service, dict) or not set(service) <= _SERVICE_KEYS:
        raise ManifestError(f"{where}'s service may hold only {', '.join(sorted(_SERVICE_KEYS))}")
    service_id = service.get("id")
    if not isinstance(service_id, str) or not SERVICE_ID.fullmatch(service_id):
        raise ManifestError(f"{where}'s service id must be 1-40 lower case letters, digits or -")
    if service_id != name:
        raise ManifestError(f"{where}'s service id must be the file's name")
    _text(service, "title", where, limit=120, required=True)
    _text(service, "description", where, limit=1000, required=False)
    auth = service.get("auth")
    if auth not in AUTH_MODES:
        raise ManifestError(f"{where}'s auth must be one of {', '.join(AUTH_MODES)}")
    tools = service.get("tools")
    if (
        not isinstance(tools, list)
        or not tools
        or len(tools) > 200
        or not all(isinstance(t, str) and TOOL_NAME.fullmatch(t) for t in tools)
        or len(set(tools)) != len(tools)
    ):
        raise ManifestError(f"{where}'s tools must list 1-200 distinct tool names")
    timeout = service.get("timeout", 60)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 300:
        raise ManifestError(f"{where}'s timeout must be 1-300 seconds")
    oauth = service.get("oauth")
    if (auth == "oauth") != (oauth is not None):
        raise ManifestError(f"{where} has oauth settings exactly when its auth is oauth")
    urls: list[tuple[str, object]] = [("url", service.get("url"))]
    if oauth is not None:
        if not isinstance(oauth, dict) or not set(oauth) <= _OAUTH_KEYS:
            raise ManifestError(f"{where}'s oauth may hold only {', '.join(sorted(_OAUTH_KEYS))}")
        urls += [(f"oauth.{k}", oauth.get(k)) for k in _OAUTH_URL_FIELDS]
        scopes = oauth.get("scopes", [])
        if not isinstance(scopes, list) or not all(
            isinstance(s, str) and SCOPE.fullmatch(s) for s in scopes
        ):
            raise ManifestError(f"{where}'s oauth.scopes must list scope names")
        resource = oauth.get("resource")
        if resource is not None and (not isinstance(resource, str) or not resource):
            raise ManifestError(f"{where}'s oauth.resource must be text")
        has_id = "client_id" in oauth
        if has_id == ("client_id" in asks):
            raise ManifestError(
                f"{where} must give oauth.client_id itself or ask for it, not both or neither"
            )
        if has_id and not (
            isinstance(oauth["client_id"], str) and CLIENT_ID.fullmatch(oauth["client_id"])
        ):
            raise ManifestError(f"{where}'s oauth.client_id must be printable text")
    elif "client_id" in asks or "client_secret" in asks:
        raise ManifestError(f"{where} asks for an OAuth client but its auth is not oauth")
    uses_origin = False
    for key, url in urls:
        if not isinstance(url, str):
            raise ManifestError(f"{where}'s {key} must be a URL")
        rest = url
        if url.startswith(ORIGIN_PLACEHOLDER):
            uses_origin = True
            rest = "https://origin.example" + url[len(ORIGIN_PLACEHOLDER) :]
        if ORIGIN_PLACEHOLDER in rest or "$" in rest:
            raise ManifestError(f"{where}'s {key} may use ${{origin}} only at its start")
        problem = destination_problem(rest)
        if problem is not None:
            raise ManifestError(f"{where}'s {key} breaks a destination rule: {problem}")
        if url.startswith(ORIGIN_PLACEHOLDER) and not url[len(ORIGIN_PLACEHOLDER) :].startswith(
            "/"
        ):
            raise ManifestError(f"{where}'s {key} must go on with a path after ${{origin}}")
    if uses_origin != ("origin" in asks):
        raise ManifestError(f"{where} must ask for origin exactly when its URLs use ${{origin}}")
    return Manifest(id=service_id, asks=tuple(asks), service=service)


def load_manifests(directory: Path = MANIFESTS_DIR) -> dict[str, Manifest]:
    """Every shipped manifest, by ID. A broken one is a :class:`ManifestError` (a build fault)."""
    manifests: dict[str, Manifest] = {}
    for path in sorted(directory.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise ManifestError(f"the manifest {path.stem} is not readable JSON") from None
        manifest = check_manifest(data, path.stem)
        manifests[manifest.id] = manifest
    return manifests


def parse_services(raw: str | None) -> tuple[str, ...]:
    """``CFO_MCP_SERVICES``: IDs separated by commas, each once. Unset or blank: none."""
    if raw is None:
        return ()
    items = [part.strip() for part in raw.split(",")]
    items = [item for item in items if item]
    for item in items:
        if not SERVICE_ID.fullmatch(item):
            raise ManifestError(f"{SERVICES_ENV} lists something that is not a service ID")
    if len(set(items)) != len(items):
        raise ManifestError(f"{SERVICES_ENV} lists a service twice")
    return tuple(items)


def _secret_text(env: Mapping[str, str], name: str, *, limit: int) -> str:
    value = (env.get(name) or "").strip()
    if not value:
        raise ManifestError(f"{name} is required: the service it names asks for it")
    if len(value) > limit or any(ch.isspace() or not ch.isprintable() for ch in value):
        raise ManifestError(f"{name} is malformed")
    return value


def _origin(env: Mapping[str, str], name: str, *, allow_loopback: bool) -> str:
    value = (env.get(name) or "").strip()
    if not value:
        raise ManifestError(f"{name} is required: the service it names asks for it")
    problem = destination_problem(value, allow_loopback=allow_loopback)
    if problem is not None:
        raise ManifestError(f"{name} breaks a destination rule: {problem}")
    parts = urlsplit(value)
    if parts.path not in ("", "/"):
        raise ManifestError(f"{name} must be an origin, with no path")
    return f"{parts.scheme}://{parts.netloc.lower()}"


def registry_entry(
    manifest: Manifest, env: Mapping[str, str], *, allow_loopback: bool = False
) -> tuple[dict[str, Any], tuple[str, ...]]:
    """One manifest with the installation's choices: Omnigent's entry, and the secret variables
    it names. Checks the choices and the destination rules on the URLs that result."""
    key = env_key(manifest.id)
    entry: dict[str, Any] = json.loads(json.dumps(dict(manifest.service)))
    origin = None
    if "origin" in manifest.asks:
        origin = _origin(env, ORIGIN_ENV + key, allow_loopback=allow_loopback)
    secret_env: tuple[str, ...] = ()
    oauth = entry.get("oauth")
    if oauth is not None:
        if "client_id" in manifest.asks:
            client_id = _secret_text(env, CLIENT_ID_ENV + key, limit=256)
            if not CLIENT_ID.fullmatch(client_id):
                raise ManifestError(f"{CLIENT_ID_ENV + key} is malformed")
            oauth["client_id"] = client_id
        if "client_secret" in manifest.asks:
            _secret_text(env, CLIENT_SECRET_ENV + key, limit=1024)
            oauth["client_secret_env"] = CLIENT_SECRET_ENV + key
            secret_env = (CLIENT_SECRET_ENV + key,)
    loopback = False
    targets: list[tuple[dict[str, Any], str]] = [(entry, "url")]
    if oauth is not None:
        targets += [(oauth, k) for k in _OAUTH_URL_FIELDS]
    for holder, name in targets:
        url = holder[name]
        if origin is not None and url.startswith(ORIGIN_PLACEHOLDER):
            url = origin + url[len(ORIGIN_PLACEHOLDER) :]
            holder[name] = url
        problem = destination_problem(url, allow_loopback=allow_loopback)
        if problem is not None:
            raise ManifestError(f"{manifest.id}'s {name} breaks a destination rule: {problem}")
        loopback = loopback or url.startswith("http:")
    if loopback:
        entry["allow_http"] = True  # tests only: CFO_ALLOW_LOOPBACK_MCP
    return entry, secret_env


def presets(
    manifests: Mapping[str, Manifest], chosen: Collection[str] = ()
) -> list[dict[str, Any]]:
    """Omnigent's presets for its page's Add form (``McpServicePreset``), from the shipped
    manifests: each the page can take (:data:`PAGE_AUTH_MODES`) and the installation's choices do
    not already turn on (a registry entry with that ID would hide a page service of it), by ID.

    ``${origin}`` becomes :data:`PRESET_ORIGIN`; OAuth endpoints with it are left out, so the
    page discovers them from the URL the administrator enters. Never a secret: a manifest that
    asks for an OAuth client gives no client ID either.
    """

    def url(value: str) -> str:
        if value.startswith(ORIGIN_PLACEHOLDER):
            return PRESET_ORIGIN + value[len(ORIGIN_PLACEHOLDER) :]
        return value

    out: list[dict[str, Any]] = []
    for service_id in sorted(manifests):
        service = manifests[service_id].service
        if service["auth"] not in PAGE_AUTH_MODES or service_id in chosen:
            continue
        preset: dict[str, Any] = {
            "id": service_id,
            "title": service["title"],
            "description": service.get("description", ""),
            "url": url(service["url"]),
            "auth": service["auth"],
            "tools": list(service["tools"]),
            "timeout": service.get("timeout", 60),
        }
        oauth = service.get("oauth")
        if oauth is not None:
            hints: dict[str, Any] = {"scopes": list(oauth.get("scopes", []))}
            if "client_id" in oauth:
                hints["client_id"] = oauth["client_id"]
            if oauth.get("resource"):
                hints["resource"] = url(oauth["resource"])
            if not any(oauth[k].startswith(ORIGIN_PLACEHOLDER) for k in _OAUTH_URL_FIELDS):
                hints.update({k: oauth[k] for k in _OAUTH_URL_FIELDS})
            preset["oauth"] = hints
        out.append(preset)
    return out


def _callback_base_ok(public_url: str) -> bool:
    """Omnigent's own rule for its OAuth callbacks (``McpRegistryConfig``): https, or http on the
    loopback only."""
    parts = urlsplit(public_url)
    return parts.scheme == "https" or (
        parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")
    )


def build_settings(
    env: Mapping[str, str],
    *,
    public_url: str,
    key_service: bool,
    github_linking: bool,
    warnings: list[str],
    manifests: Mapping[str, Manifest] | None = None,
    allow_loopback: bool = False,
) -> McpRegistrySettings:
    """The registry from the installation's choices and Omnigent's page (WP8.14).

    - On whenever the key service is on, which Omnigent needs to seal the logins of the services
      administrators add on its page, or when a service is chosen; off, quietly, with neither.
    - The page is on with the registry, unless ``OMNIGENT_MCP_ADMIN_SERVICES=0``. Its presets
      are the shipped manifests it can take that no choice turns on.
    - A chosen service the image does not ship, or a malformed choice: :class:`ManifestError`
      (exit 78).
    - A chosen service's prerequisite missing: the chosen services are off, with a warning
      naming it (never a value), as a half-configured GitHub App is (WP5.9); the page stays on
      with the key service. Logins (``oauth``, ``bearer``) need the key service; OAuth needs the
      state secret.
    - ``github`` services with GitHub linking off: on, with a warning; Omnigent then asks the
      owner to connect GitHub.
    """
    chosen = parse_services(env.get(SERVICES_ENV))
    if not chosen and not key_service:
        return McpRegistrySettings(off_reason="no key service and no services chosen")
    shipped = load_manifests() if manifests is None else manifests
    unknown = [s for s in chosen if s not in shipped]
    if unknown:
        raise ManifestError(f"{SERVICES_ENV} names a service this image does not ship")
    picked = [shipped[s] for s in chosen]
    if any(m.service.get("auth") == "oauth" for m in picked) and not _callback_base_ok(public_url):
        raise ManifestError("OMNIGENT_ACCOUNTS_BASE_URL must be https for an MCP service's sign-in")
    missing: list[str] = []
    if not key_service and any(m.service.get("auth") in ("oauth", "bearer") for m in picked):
        missing.append("the key service's signing pair (OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY[_ID])")
    if any(m.service.get("auth") == "oauth" for m in picked):
        state = (env.get(STATE_SECRET_ENV) or "").strip()
        if not state:
            missing.append(STATE_SECRET_ENV)
        elif (
            len(state) < MIN_STATE_SECRET_CHARS
            or len(state) > 4096
            or any(ch.isspace() or not ch.isprintable() for ch in state)
        ):
            raise ManifestError(
                f"{STATE_SECRET_ENV} must be {MIN_STATE_SECRET_CHARS}-4096 printable characters"
            )
    entries: list[dict[str, Any]] = []
    secret_env: list[str] = []
    for manifest in picked:
        entry, names = registry_entry(manifest, env, allow_loopback=allow_loopback)
        entries.append(entry)
        secret_env.extend(names)
    if missing:
        warnings.append(f"the chosen MCP services are off: {', '.join(missing)} not set")
        chosen, entries, secret_env = (), [], []
        if not key_service:
            return McpRegistrySettings(off_reason="incomplete")
    if not github_linking and any(m.service.get("auth") == "github" for m in picked) and chosen:
        warnings.append(
            "an MCP service uses GitHub linking, which is off: it asks to connect GitHub"
        )
    admin_services = (env.get(ADMIN_SERVICES_ENV) or "").strip() != "0"
    return McpRegistrySettings(
        enabled=True,
        off_reason=None,
        services=chosen,
        admin_services=admin_services,
        allow_loopback=allow_loopback,
        registry={
            # Omnigent refuses a callback base it would not use; the page's OAuth services then
            # say the public URL is missing (a test's plain-http installation only).
            "public_url": public_url if _callback_base_ok(public_url) else None,
            "services": entries,
            "presets": presets(shipped, chosen) if admin_services else [],
        },
        secret_env=tuple(secret_env),
    )
