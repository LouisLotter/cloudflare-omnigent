"""S4 spike: a durability barrier for Omnigent on SQLite + Litestream.

Throwaway spike code. It shows how a barrier can be packaged in the server
image without changing Omnigent's source, and lets the spike compare two
placements:

* ``response`` (recommended): SQLAlchemy engine events only *classify*
  commits that wrote security tables and attach them to the current HTTP
  request. An outermost ASGI middleware holds the response start, asks
  Litestream to convert the WAL to LTX (``POST /sync`` without ``wait``),
  then polls until ``replicated_txid`` covers the returned ``txid``. On
  timeout a 2xx response is replaced by a distinct
  ``durability_unconfirmed`` error. The wait is async, so the event loop
  keeps serving other requests.
* ``commit_hook``: the design as first written. A ``Session.after_commit``
  hook blocks the committing thread until the same condition holds, and
  raises on timeout. Kept to measure its side effects.
* ``off``: classification and logging only, no waiting.

Litestream's ``wait: true`` sync is never used (issue #1552): with a
request-scoped context it can drop Litestream's checkpoint guard.

Every barrier decision is logged to stderr as one ``S4BARRIER {json}`` line.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

SOCKET = os.environ.get("S4_LITESTREAM_SOCKET", "/run/litestream/litestream.sock")
DB_PATH = os.environ.get("S4_DB_PATH", "/data/db/omnigent.db")
MODE = os.environ.get("S4_BARRIER_MODE", "response")
TIMEOUT_S = float(os.environ.get("S4_BARRIER_TIMEOUT_S", "5"))
POLL_S = float(os.environ.get("S4_BARRIER_POLL_S", "0.1"))
TABLES = frozenset(
    t.strip().lower()
    for t in os.environ.get(
        "S4_BARRIER_TABLES",
        "users,device_grants,account_tokens,hosts,scheduled_tasks",
    ).split(",")
    if t.strip()
)
# Optional: stop the application's own SQLite auto-checkpoints so that only
# Litestream checkpoints (Litestream tips; see the #1540 notes in the report).
APP_AUTOCHECKPOINT = os.environ.get("S4_APP_WAL_AUTOCHECKPOINT") or None  # e.g. "0"

# 424: no Omnigent client retries it, it is not a 5xx "try again", and both
# the accounts UI (string ``error``) and the v1 UI (``error.message``) show
# the server's text. See the spike report.
UNCONFIRMED_STATUS = int(os.environ.get("S4_UNCONFIRMED_STATUS", "424"))
UNCONFIRMED_CODE = "durability_unconfirmed"
UNCONFIRMED_MESSAGE = (
    "The change was applied, but its durability is not yet confirmed. "
    "Check the current state before repeating it."
)

_WRITE_RE = re.compile(
    r"""^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)
        \s+["`\[]?(\w+)["`\]]?""",
    re.IGNORECASE | re.VERBOSE,
)
_SET_RE = re.compile(r"\bSET\s+(.*?)(?:\s+WHERE\s|\s+RETURNING\s|$)", re.IGNORECASE | re.DOTALL)
# Updates that touch only these columns are bookkeeping, not security changes:
# the login timestamp, and a host's heartbeat. Without this, every browser
# login would need the barrier, and fail while the replica is blocked.
IGNORED_UPDATE_COLUMNS = {
    "users": frozenset({"last_login_at"}),
    "hosts": frozenset({"updated_at"}),
}


def classify(statement: str, rowcount: int) -> str | None:
    """Return the security table an executed statement changed, if any."""
    m = _WRITE_RE.match(statement)
    if not m:
        return None
    verb, table = m.group(1).upper(), m.group(2).lower()
    if table not in TABLES:
        return None
    if not verb.startswith(("INSERT", "REPLACE")) and rowcount == 0:
        return None  # an UPDATE or DELETE that matched nothing changed nothing
    if verb.startswith("UPDATE") and table in IGNORED_UPDATE_COLUMNS:
        s = _SET_RE.search(statement)
        if s:
            cols = {part.split("=", 1)[0].strip().strip('"`[]').lower() for part in s.group(1).split(",")}
            if cols and cols <= IGNORED_UPDATE_COLUMNS[table]:
                return None
    return table


def log(event: str, **fields: Any) -> None:
    fields["event"] = event
    fields["t"] = round(time.time(), 4)
    sys.stderr.write("S4BARRIER " + json.dumps(fields, sort_keys=True) + "\n")
    sys.stderr.flush()


@dataclass
class RequestDurability:
    """Security commits made while serving one HTTP request."""

    tables: set[str] = field(default_factory=set)
    commits: int = 0


_current: contextvars.ContextVar[RequestDurability | None] = contextvars.ContextVar(
    "s4_request_durability", default=None
)
_thread = threading.local()
# Security commits made where no request context was visible: background
# work, or a thread that did not inherit the request's context (for example
# ``loop.run_in_executor``). A request during which this counter moves is
# held as well, so a lost context can only cost latency, never a false
# "confirmed".
_orphan_commits = 0
_orphan_lock = threading.Lock()


class DurabilityUnconfirmed(Exception):
    """Raised by the commit-hook variant when the barrier times out."""

    def __init__(self, info: dict[str, Any]) -> None:
        super().__init__(UNCONFIRMED_MESSAGE)
        self.info = info


# ── Litestream control socket ──────────────────────────────────────────


def _sync_body() -> dict[str, str]:
    # No "wait" and no "timeout": the handler then runs under the daemon's
    # own context, which avoids issue #1552.
    return {"path": DB_PATH}


async def _ls_sync_async(client: httpx.AsyncClient) -> dict[str, Any]:
    r = await client.post("http://litestream/sync", json=_sync_body())
    r.raise_for_status()
    return r.json()


def _ls_sync_blocking(client: httpx.Client) -> dict[str, Any]:
    r = client.post("http://litestream/sync", json=_sync_body())
    r.raise_for_status()
    return r.json()


async def wait_durable_async(reason: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    """Wait until the remote replica position covers every commit so far."""
    t0 = time.monotonic()
    deadline = t0 + TIMEOUT_S
    info: dict[str, Any] = {"polls": 0, **reason}
    transport = httpx.AsyncHTTPTransport(uds=SOCKET)
    async with httpx.AsyncClient(transport=transport, timeout=TIMEOUT_S) as client:
        try:
            first = await asyncio.wait_for(_ls_sync_async(client), timeout=TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001 - any failure is "unconfirmed"
            info.update(ok=False, error=f"sync: {type(exc).__name__}: {exc}")
            info["wait_ms"] = round((time.monotonic() - t0) * 1000, 1)
            return False, info
        target = int(first["txid"])
        replicated = int(first.get("replicated_txid") or 0)
        info.update(target_txid=target, first_status=first.get("status"))
        info["polls"] = 1
        while replicated < target:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                info.update(ok=False, replicated_txid=replicated, error="timeout")
                info["wait_ms"] = round((time.monotonic() - t0) * 1000, 1)
                return False, info
            await asyncio.sleep(min(POLL_S, remaining))
            try:
                cur = await asyncio.wait_for(
                    _ls_sync_async(client), timeout=max(0.05, deadline - time.monotonic())
                )
            except Exception as exc:  # noqa: BLE001
                info["last_error"] = f"{type(exc).__name__}: {exc}"
                continue
            finally:
                info["polls"] += 1
            replicated = int(cur.get("replicated_txid") or 0)
        info.update(ok=True, replicated_txid=replicated)
        info["wait_ms"] = round((time.monotonic() - t0) * 1000, 1)
        return True, info


def wait_durable_blocking(reason: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    """Blocking twin of :func:`wait_durable_async`, for the commit-hook variant."""
    t0 = time.monotonic()
    deadline = t0 + TIMEOUT_S
    info: dict[str, Any] = {"polls": 0, **reason}
    transport = httpx.HTTPTransport(uds=SOCKET)
    with httpx.Client(transport=transport, timeout=TIMEOUT_S) as client:
        try:
            first = _ls_sync_blocking(client)
        except Exception as exc:  # noqa: BLE001
            info.update(ok=False, error=f"sync: {type(exc).__name__}: {exc}")
            info["wait_ms"] = round((time.monotonic() - t0) * 1000, 1)
            return False, info
        target = int(first["txid"])
        replicated = int(first.get("replicated_txid") or 0)
        info.update(target_txid=target, polls=1)
        while replicated < target:
            if time.monotonic() >= deadline:
                info.update(ok=False, replicated_txid=replicated, error="timeout")
                info["wait_ms"] = round((time.monotonic() - t0) * 1000, 1)
                return False, info
            time.sleep(POLL_S)
            info["polls"] += 1
            try:
                replicated = int(_ls_sync_blocking(client).get("replicated_txid") or 0)
            except Exception as exc:  # noqa: BLE001
                info["last_error"] = f"{type(exc).__name__}: {exc}"
        info.update(ok=True, replicated_txid=replicated)
        info["wait_ms"] = round((time.monotonic() - t0) * 1000, 1)
        return True, info


# ── SQLAlchemy hooks ───────────────────────────────────────────────────


def install_sql_hooks() -> None:
    """Register engine-wide listeners. Must run before Omnigent builds engines."""
    from sqlalchemy import event
    from sqlalchemy.engine import Engine
    from sqlalchemy.orm import Session

    @event.listens_for(Engine, "connect")
    def _connect(dbapi_conn: Any, _record: Any) -> None:
        if APP_AUTOCHECKPOINT is None:
            return
        cur = dbapi_conn.cursor()
        try:
            cur.execute(f"PRAGMA wal_autocheckpoint={int(APP_AUTOCHECKPOINT)}")
        finally:
            cur.close()

    @event.listens_for(Engine, "after_cursor_execute")
    def _classify(conn, cursor, statement, _params, _context, _executemany) -> None:  # noqa: ANN001
        try:
            rowcount = cursor.rowcount
        except Exception:  # noqa: BLE001
            rowcount = -1
        table = classify(statement, rowcount)
        if table:
            conn.info.setdefault("s4_tables", set()).add(table)

    @event.listens_for(Engine, "commit")
    def _on_commit(conn) -> None:  # noqa: ANN001 - fires just before the DBAPI commit
        global _orphan_commits
        tables = conn.info.pop("s4_tables", None)
        if not tables:
            return
        req = _current.get()
        if req is not None:
            req.tables |= tables
            req.commits += 1
        else:
            with _orphan_lock:
                _orphan_commits += 1
            log("security_commit_outside_request", tables=sorted(tables))
        if MODE == "commit_hook":
            pending = getattr(_thread, "pending", set())
            _thread.pending = pending | tables

    @event.listens_for(Engine, "rollback")
    def _on_rollback(conn) -> None:  # noqa: ANN001
        conn.info.pop("s4_tables", None)

    @event.listens_for(Session, "after_commit")
    def _after_commit(_session) -> None:  # noqa: ANN001
        if MODE != "commit_hook":
            return
        pending = getattr(_thread, "pending", None)
        if not pending:
            return
        _thread.pending = set()
        ok, info = wait_durable_blocking(
            {"mode": "commit_hook", "tables": sorted(pending), "thread": threading.get_ident()}
        )
        log("barrier", **info)
        if not ok:
            raise DurabilityUnconfirmed(info)

    log("hooks_installed", mode=MODE, tables=sorted(TABLES), timeout_s=TIMEOUT_S)


# ── ASGI middleware (response variant) ─────────────────────────────────


def unconfirmed_payload(path: str | None) -> dict[str, Any]:
    """Match the error shape each route family's clients already parse."""
    if path and (path.startswith("/auth/") or path.startswith("/oauth/")):
        return {"error": UNCONFIRMED_MESSAGE, "code": UNCONFIRMED_CODE, "applied": True}
    return {"error": {"code": UNCONFIRMED_CODE, "message": UNCONFIRMED_MESSAGE}, "applied": True}


def _unconfirmed_body(path: str | None) -> bytes:
    return json.dumps(unconfirmed_payload(path)).encode()


class DurabilityBarrierMiddleware:
    """Hold a response until the security commits it acknowledges are remote."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        req = RequestDurability()
        token = _current.set(req)
        replaced = False
        method, path = scope.get("method"), scope.get("path")
        orphans_at_start = _orphan_commits

        async def send_wrapper(message: dict[str, Any]) -> None:
            nonlocal replaced
            if replaced:
                return  # drop the original body after a replacement
            orphaned = method not in ("GET", "HEAD", "OPTIONS") and _orphan_commits != orphans_at_start
            if message["type"] == "http.response.start" and (req.commits or orphaned):
                status = int(message["status"])
                reason = {"mode": MODE, "method": method, "path": path, "status": status,
                          "tables": sorted(req.tables), "commits": req.commits,
                          "why": "request" if req.commits else "orphan_commit_during_request"}
                if MODE == "response":
                    ok, info = await wait_durable_async(reason)
                else:
                    ok, info = True, {**reason, "skipped": True}
                log("barrier", **info)
                headers = [(k, v) for k, v in message.get("headers", [])]
                verdict = b"not-checked" if info.get("skipped") else (b"confirmed" if ok else b"unconfirmed")
                headers.append((b"x-cfo-durability", verdict))
                if not ok and 200 <= status < 300:
                    body = _unconfirmed_body(path)
                    # Keep cookies (a password change rotates the session),
                    # drop the original body and its framing headers.
                    kept = [(k, v) for k, v in headers if k.lower() in (b"set-cookie", b"x-cfo-durability")]
                    kept += [(b"content-type", b"application/json"),
                             (b"content-length", str(len(body)).encode()),
                             (b"cache-control", b"no-store")]
                    await send({"type": "http.response.start", "status": UNCONFIRMED_STATUS,
                                "headers": kept})
                    await send({"type": "http.response.body", "body": body, "more_body": False})
                    replaced = True
                    return
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            _current.reset(token)


def install_app(app: Any) -> None:
    """Attach the middleware and the commit-hook exception handler."""
    from fastapi.responses import JSONResponse

    async def _unconfirmed(request: Any, exc: DurabilityUnconfirmed) -> Any:
        return JSONResponse(
            status_code=UNCONFIRMED_STATUS,
            content=unconfirmed_payload(request.url.path),
            headers={"x-cfo-durability": "unconfirmed"},
        )

    app.add_exception_handler(DurabilityUnconfirmed, _unconfirmed)
    app.add_middleware(DurabilityBarrierMiddleware)
    log("app_installed", mode=MODE)
