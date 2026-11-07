"""Durability barriers: nothing is acknowledged before Litestream has replicated it.

**The response barrier** (security writes, design "Durability barrier for security changes",
spike S4):

- Engine-wide SQLAlchemy events only *mark* a request that committed an effective write to a
  security table (:data:`SECURITY_TABLES`), ignoring updates that touch only bookkeeping
  columns (:data:`IGNORED_UPDATE_COLUMNS`) and inserts that only add
  (:data:`ADDITIVE_INSERT_TABLES`). Nothing blocks in a commit hook: S4 showed that
  freezes Omnigent's event loop and that Omnigent swallows or masks the hook's error.
- :class:`ResponseBarrierMiddleware`, the outermost ASGI middleware, holds such a request's
  response until Litestream's ``replicated_txid`` covers the commit. On timeout a 2xx or 3xx
  answer becomes 424 ``durability_unconfirmed`` with ``"applied": true``, in the error shape each
  route family already parses (``contracts/src/durability.ts``), keeping ``Set-Cookie``.

**The transcript barrier** (core change 14, WP3.9 part 2): :func:`make_transcript_barrier`
returns the async callable passed as ``create_app(durability_barrier=...)``. Omnigent awaits it
before acknowledging transcript items and turn-end status edges; on ``False`` it answers 503
``durability_unconfirmed`` (HTTP) or a retryable ``durability_unconfirmed`` (runner tunnel),
and the sender sends the outcome again. One deadline covers the whole wait, below the senders'
acknowledgement timeouts.
"""

from __future__ import annotations

import contextvars
import json
import os
import re
import threading
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

from cfo_server.events import log
from cfo_server.litestream import ReplicationWaiter, WaitOutcome

#: Tables whose writes are security changes: accounts and passwords, login grants and their
#: revocation, API tokens, hosts (creation, removal, launch-token re-arming), schedules, and
#: the credential store's connections (GitHub linking, WP5.9): linking, relinking (an update
#: that can replace the linked GitHub identity) and, above all, unlinking, none of which may
#: come back undone with a restore. A token refresh writes the same columns as a relink, so it
#: is held too: a git command that needs one (about every 8 hours) waits for the replica, and
#: while the replica is blocked that one request is answered 424 and the next one succeeds.
#: And the MCP servers administrators add on Omnigent's page with their tool allowlists
#: (WP8.14): where agents' tool calls may go and which tools they may call. A removed server, a
#: changed address or a narrowed allowlist must not come back undone with a restore either; their
#: logins are in ``connections``, removed in the same transaction.
#: And what a team takes away (WP3.56). A table belongs here when a person is told a change took
#: effect and losing it would give back access, a credential or a permission someone took away,
#: or undo a narrowing: a revoked invitation, whose link a restore made work again; a lowered role;
#: a removed approver; self-approval turned off; a rule added or tightened; a share revoked. Each
#: table makes its writes wait for the replica and answer 424 while it is blocked, so ordinary
#: work stays out: ``team_identity_bindings`` (a first sign-in writes it), ``approval_verdicts``
#: (every protected action does) and the removal records (committed with ``users``).
SECURITY_TABLES: frozenset[str] = frozenset(
    {
        "users",
        "device_grants",
        "account_tokens",
        "hosts",
        "scheduled_tasks",
        "connections",
        "mcp_registry_services",
        "mcp_registry_service_tools",
        "team_invitations",
        "team_members",
        "approver_grants",
        "approval_resources",
        "protected_policies",
        "policies",
        "session_permissions",
    }
)
#: Updates that touch only these columns are bookkeeping, not security changes: the login
#: timestamp and a host's heartbeat. Without this, every browser login would wait for the
#: replica and fail while it is blocked. The team, approval, policy and sharing tables need no
#: entry: none has a last-seen stamp, and their ``updated_at`` moves only with a real change.
IGNORED_UPDATE_COLUMNS: dict[str, frozenset[str]] = {
    "users": frozenset({"last_login_at"}),
    "hosts": frozenset({"updated_at"}),
}
#: Tables where a new row only adds, and taking one away is the security change: every new thread
#: inserts its owner's grant, which must not wait for the replica, and a lost grant gives back
#: nothing anyone took away. Their updates and deletes still count.
ADDITIVE_INSERT_TABLES: frozenset[str] = frozenset({"session_permissions"})


@dataclass(frozen=True)
class HeldRoute:
    """A request held when it succeeds, whatever it wrote, matched on the path Omnigent routes.

    :param fields: Held only when the JSON body sets one of these fields, whatever their value
        (presence is the signal, as in Omnigent's own permission tiers); ``None`` holds every
        successful request.
    :param label_keys: Also held when the body's ``labels`` sets one of these keys.
    """

    method: str
    path: re.Pattern[str]
    fields: frozenset[str] | None = None
    label_keys: frozenset[str] = frozenset()

    def holds(self, body: dict[str, Any] | None) -> bool:
        """Whether a successful request with this JSON body is held; ``None`` is a body too
        large, unread or not a JSON object, which is held to be safe."""
        if self.fields is None or body is None:
            return True
        if self.fields & body.keys():
            return True
        labels = body.get("labels")
        return isinstance(labels, dict) and bool(self.label_keys & labels.keys())


#: Requests held whenever they succeed, whatever they wrote:
#: - sharing a thread, which can lower a level through the same upsert as a new thread's owner
#:   grant, so the statement cannot tell them apart;
#: - a thread's settings that decide who may see or do what in it (Omnigent's manage and owner
#:   tiers in ``PATCH /v1/sessions/{id}``): ``share_workspace_files`` (view-level collaborators
#:   browse the workspace), and the permission and approval modes, launch arguments and Codex
#:   sandbox bypass (what the agent may do without asking). They live in ``conversations``,
#:   labels and launch metadata with a thread's ordinary state, so the request is held instead
#:   of a table. A title, archive or model change is not.
HELD_ROUTES: tuple[HeldRoute, ...] = (
    HeldRoute("PUT", re.compile(r"^/v1/sessions/[^/]+/permissions$")),
    HeldRoute(
        "PATCH",
        re.compile(r"^/v1/sessions/[^/]+$"),
        fields=frozenset(
            {"share_workspace_files", "permission_mode", "approval_mode", "terminal_launch_args"}
        ),
        label_keys=frozenset({"omnigent.codex_native.bypass_sandbox"}),
    ),
)
#: A held route's body is kept up to this size; a larger one is held without reading it.
HELD_BODY_LIMIT = 64 * 1024

UNCONFIRMED_STATUS = 424
UNCONFIRMED_CODE = "durability_unconfirmed"
UNCONFIRMED_MESSAGE = (
    "The change was applied, but its durability is not yet confirmed. "
    "Check the current state before repeating it."
)
DURABILITY_HEADER = b"x-cfo-durability"

_WRITE_RE = re.compile(
    r"""^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)
        \s+["`\[]?(\w+)["`\]]?""",
    re.IGNORECASE | re.VERBOSE,
)
_SET_RE = re.compile(r"\bSET\s+(.*?)(?:\s+WHERE\s|\s+RETURNING\s|$)", re.IGNORECASE | re.DOTALL)


def classify(statement: str, rowcount: int) -> str | None:
    """Return the security table an executed statement changed, or ``None``.

    :param statement: The SQL text SQLAlchemy sent to the driver.
    :param rowcount: The cursor's row count; ``-1`` when unknown.
    """
    match = _WRITE_RE.match(statement)
    if not match:
        return None
    verb, table = match.group(1).upper(), match.group(2).lower()
    if table not in SECURITY_TABLES:
        return None
    if table in ADDITIVE_INSERT_TABLES and re.fullmatch(r"INSERT\s+INTO", verb):
        # A plain insert (``ON CONFLICT`` included); ``INSERT OR REPLACE`` can take away.
        return None
    if rowcount == 0:
        # An UPDATE or DELETE that matched nothing, or an INSERT that a conflict clause
        # ignored, changed nothing. An unknown count (-1) counts as a change.
        return None
    if verb.startswith("UPDATE") and table in IGNORED_UPDATE_COLUMNS:
        set_clause = _SET_RE.search(statement)
        if set_clause:
            columns = {
                part.split("=", 1)[0].strip().strip('"`[]').lower()
                for part in _split_assignments(set_clause.group(1))
            }
            if columns and columns <= IGNORED_UPDATE_COLUMNS[table]:
                return None
    return table


def normalize_base_path(value: str | None) -> str:
    """``OMNIGENT_WEB_BASE_PATH`` as Omnigent normalizes it: ``"/prefix"``, or ``""`` for none.
    (Omnigent refuses to start on an invalid one, so only valid values reach a request.)"""
    trimmed = (value or "").strip()
    if trimmed in ("", "/"):
        return ""
    return ("/" + trimmed.lstrip("/")).rstrip("/")


def routed_path(scope: dict[str, Any], base_path: str) -> str:
    """The path Omnigent routes a request on: its ``BasePathMiddleware`` strips the base path when
    the request carries it and makes it the ``root_path``; Starlette's router then matches the
    path below the ``root_path``."""
    path = scope.get("path") or ""
    root_path = scope.get("root_path") or ""
    if base_path and (path == base_path or path.startswith(f"{base_path}/")):
        path, root_path = path[len(base_path) :] or "/", base_path
    if root_path and path.startswith(root_path) and path[len(root_path) :][:1] in ("", "/"):
        path = path[len(root_path) :] or "/"
    return path


def held_route(method: str | None, path: str) -> HeldRoute | None:
    """The held route this request is on, if any (``path`` as Omnigent routes it)."""
    return next((r for r in HELD_ROUTES if method == r.method and r.path.match(path)), None)


class _BodyTap:
    """The request body as the app pulls it through ``receive``: every message passes unchanged
    and nothing is read twice. Kept up to :data:`HELD_BODY_LIMIT`."""

    def __init__(self, receive: Any) -> None:
        self._receive = receive
        self._chunks: list[bytes] = []
        self._size = 0
        self._complete = False
        self._overflowed = False

    async def __call__(self) -> Any:
        message = await self._receive()
        if message.get("type") == "http.request":
            body = message.get("body", b"")
            if not self._overflowed:
                self._size += len(body)
                if self._size > HELD_BODY_LIMIT:
                    self._overflowed = True
                    self._chunks.clear()
                else:
                    self._chunks.append(body)
            if not message.get("more_body", False):
                self._complete = True
        return message

    def json_object(self) -> dict[str, Any] | None:
        """The body as a JSON object; ``None`` when it was too large, not read to its end, or
        not a JSON object."""
        if self._overflowed or not self._complete:
            return None
        try:
            data = json.loads(b"".join(self._chunks))
        except ValueError:  # UnicodeDecodeError included
            return None
        return data if isinstance(data, dict) else None


def _split_assignments(text: str) -> Iterable[str]:
    """Split ``a=?, b=coalesce(c, ?)`` on top-level commas only."""
    depth = 0
    start = 0
    for index, char in enumerate(text):
        if char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif char == "," and depth == 0:
            yield text[start:index]
            start = index + 1
    yield text[start:]


@dataclass
class ScopeDurability:
    """Security commits made while serving one HTTP request or WebSocket connection."""

    kind: str
    tables: set[str] = field(default_factory=set)
    commits: int = 0
    response_started: bool = False


_current: contextvars.ContextVar[ScopeDurability | None] = contextvars.ContextVar(
    "cfo_scope_durability", default=None
)
_orphan_lock = threading.Lock()
_orphan_commits = 0


def orphan_commits() -> int:
    """Security commits seen outside any request or connection, since start."""
    return _orphan_commits


def record_commit(tables: set[str]) -> None:
    """Attribute one committed transaction's security tables to the current scope.

    A commit with no scope (background work, or a thread that did not inherit the request's
    context) is an *orphan*: every non-GET request in flight while it happens is held too, so
    a lost context can only cost latency, never a false "confirmed" (S4).
    """
    global _orphan_commits
    scope = _current.get()
    if scope is not None:
        scope.tables |= tables
        scope.commits += 1
        if scope.response_started and scope.kind == "http":
            log("barrier.late_commit", tables=sorted(tables))
        return
    with _orphan_lock:
        _orphan_commits += 1
    log("barrier.orphan_commit", tables=sorted(tables))


_hooks_installed = False
_DEBUG_SQL = os.environ.get("CFO_BARRIER_DEBUG_SQL") == "1"


def install_sql_hooks() -> None:
    """Register the engine-wide listeners. Call before Omnigent creates any engine."""
    global _hooks_installed
    if _hooks_installed:
        return
    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    @event.listens_for(Engine, "after_cursor_execute")
    def _classify(conn, cursor, statement, _params, _context, _executemany) -> None:  # noqa: ANN001
        try:
            rowcount = cursor.rowcount
        except Exception:  # noqa: BLE001 - a driver without a row count: assume it changed
            rowcount = -1
        table = classify(statement, rowcount)
        if table:
            conn.info.setdefault("cfo_tables", set()).add(table)
            if _DEBUG_SQL:
                # Statement text only: parameters can hold credentials and are never logged.
                log("barrier.classified", table=table, rowcount=rowcount, sql=statement[:300])

    @event.listens_for(Engine, "commit")
    def _on_commit(conn) -> None:  # noqa: ANN001 - fires just before the DBAPI commit
        tables = conn.info.pop("cfo_tables", None)
        if tables:
            record_commit(tables)

    @event.listens_for(Engine, "rollback")
    def _on_rollback(conn) -> None:  # noqa: ANN001
        conn.info.pop("cfo_tables", None)

    _hooks_installed = True


def unconfirmed_payload(path: str | None) -> dict[str, Any]:
    """The 424 body, in the error shape the route family's clients already parse."""
    if path and (path.startswith("/auth/") or path.startswith("/oauth/")):
        return {"error": UNCONFIRMED_MESSAGE, "code": UNCONFIRMED_CODE, "applied": True}
    return {"error": {"code": UNCONFIRMED_CODE, "message": UNCONFIRMED_MESSAGE}, "applied": True}


Wait = Callable[[float], Awaitable[WaitOutcome]]


class ResponseBarrierMiddleware:
    """Hold a response until the security commits it acknowledges are replicated.

    Installed as the outermost user middleware. WebSocket connections get their own scope
    record, so a host tunnel's own writes are never orphans that hold other requests; nothing
    on a WebSocket is held.
    """

    def __init__(self, app: Any, *, wait: Wait, timeout_s: float, base_path: str = "") -> None:
        self.app = app
        self._wait = wait
        self._timeout_s = timeout_s
        self._base_path = normalize_base_path(base_path)

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        kind = scope.get("type")
        if kind == "websocket":
            token = _current.set(ScopeDurability("websocket"))
            try:
                await self.app(scope, receive, send)
            finally:
                _current.reset(token)
            return
        if kind != "http":
            await self.app(scope, receive, send)
            return

        record = ScopeDurability("http")
        token = _current.set(record)
        method = scope.get("method")
        path = scope.get("path")
        route_path = routed_path(scope, self._base_path)
        route = held_route(method, route_path)
        tap = _BodyTap(receive) if route is not None and route.fields is not None else None
        orphans_at_start = orphan_commits()
        replaced = False

        async def send_wrapper(message: dict[str, Any]) -> None:
            nonlocal replaced
            if replaced:
                return  # the original body is dropped after a replacement
            if message["type"] != "http.response.start":
                await send(message)
                return
            record.response_started = True
            orphaned = method not in ("GET", "HEAD", "OPTIONS") and (
                orphan_commits() != orphans_at_start
            )
            status = int(message["status"])
            held = (
                status < 400
                and route is not None
                and route.holds(tap.json_object() if tap is not None else None)
            )
            if not (record.commits or orphaned or held):
                await send(message)
                return
            outcome = await self._wait(self._timeout_s)
            log(
                "barrier.response",
                method=method,
                path=path,
                status=status,
                tables=sorted(record.tables),
                commits=record.commits,
                why=(
                    "request"
                    if record.commits
                    else "route"
                    if held
                    else "orphan_commit_during_request"
                ),
                **outcome.log_fields(),
            )
            headers = list(message.get("headers", []))
            verdict = b"confirmed" if outcome.ok else b"unconfirmed"
            # Every success, a redirect included (a magic-link redemption answers 302 with a
            # session cookie), acknowledges the change; only an error passes through.
            if outcome.ok or status >= 400:
                headers.append((DURABILITY_HEADER, verdict))
                await send({**message, "headers": headers})
                return
            body = json.dumps(unconfirmed_payload(route_path)).encode()
            # Keep cookies (a password change rotates the session); drop the original body
            # and its framing headers.
            kept = [(k, v) for k, v in headers if k.lower() == b"set-cookie"]
            kept += [
                (DURABILITY_HEADER, verdict),
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"cache-control", b"no-store"),
            ]
            await send(
                {"type": "http.response.start", "status": UNCONFIRMED_STATUS, "headers": kept}
            )
            await send({"type": "http.response.body", "body": body, "more_body": False})
            replaced = True

        try:
            await self.app(scope, tap if tap is not None else receive, send_wrapper)
        finally:
            _current.reset(token)


def make_transcript_barrier(
    waiter: ReplicationWaiter, timeout_s: float
) -> Callable[[], Awaitable[bool]]:
    """The ``create_app(durability_barrier=...)`` callable for core change 14.

    Returns ``True`` once every commit made before the call is replicated, ``False`` on
    timeout or any error. One deadline covers the whole wait; it never raises and never
    blocks the event loop.
    """

    async def litestream_durability_barrier() -> bool:
        try:
            outcome = await waiter.wait(timeout_s)
        except Exception as exc:  # noqa: BLE001 - never raise into Omnigent
            log("barrier.transcript", ok=False, reason=f"error: {type(exc).__name__}")
            return False
        if not outcome.ok:
            log("barrier.transcript", **outcome.log_fields())
        return outcome.ok

    return litestream_durability_barrier
