"""The entrypoint's two small HTTP servers: the control port and the recovery responder.

**Control port** (8001, ``REPLICATION_POSITION_PORT`` in ``contracts/src/replication.ts``).
Only the OmnigentServer Durable Object reaches it, over the container port (``getTcpPort``);
the forwarding path and the computers reach port 8000 alone.

- ``GET /position`` answers 200 with a ``ReplicationPosition``: ``protocolVersion``, the
  entrypoint's random ``bootId``, and the ``txid`` and ``replicatedTxid`` of one Litestream
  ``POST /sync`` sent without ``wait`` (the call the barriers use). It answers 503 while
  Litestream cannot say: before it runs, in recovery mode, after it stopped, or when the call
  fails. WP2.2's watchdog counts the owner as durable once a ``replicatedTxid`` of the same
  boot reaches a ``txid`` read after ``/v1/info`` first showed the owner (G1BR-002).
- ``GET /status`` is for the watchdog and the platform page: the phase, recovery mode with its
  reason, the app's start and first health answer, the final sync's outcome, and the
  replication lag. The phases, in order: ``starting``; ``restoring`` (the restore, the
  database check and Litestream's start); ``initializing`` (the app starts: imports,
  migrations, ``create_app``, the owner check) until the app answers ``GET /health``;
  ``running``; or ``recovery`` instead of a start; then ``stopping`` and ``stopped``.

**Recovery responder** (port 8000, only in recovery mode): every request gets 503
``recovery_mode``. Omnigent is not started, so no public setup page, no login and no
replication of a wrong database can happen.
"""

from __future__ import annotations

import json
import secrets
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from cfo_server.litestream import BlockingClient

REPLICATION_POSITION_PORT = 8001
POSITION_PROTOCOL_VERSION = 1
STATUS_PROTOCOL_VERSION = 1
MAX_SAFE_INTEGER = 2**53 - 1

RECOVERY_MESSAGE = (
    "This installation's database could not be restored safely, so the server is in "
    "recovery mode and does not serve Omnigent. See the platform page for the reason."
)
POSITION_UNAVAILABLE = {
    "error": {
        "code": "unavailable",
        "message": "Litestream cannot report the replication position now.",
        "retryable": True,
    }
}


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class StatusBoard:
    """The entrypoint's state, shared with the control port's threads."""

    def __init__(
        self,
        *,
        initialized_expected: bool | None,
        installation_id: str | None = None,
        boot_id: str | None = None,
    ) -> None:
        self.boot_id = boot_id or secrets.token_hex(16)
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {
            "phase": "starting",
            "installationId": installation_id,
            "installationInitializedExpected": initialized_expected,
            "recovery": None,
            "app": None,
            "finalSync": None,
        }
        #: Opens a control-socket client while Litestream runs; ``None`` otherwise.
        self.litestream: Callable[[], BlockingClient] | None = None

    def update(self, **fields: Any) -> None:
        with self._lock:
            self._state.update(fields)

    def get(self, key: str) -> Any:
        with self._lock:
            return self._state.get(key)

    def position(self) -> dict[str, Any] | None:
        """A ``ReplicationPosition``, or ``None`` while Litestream cannot say."""
        factory = self.litestream
        if factory is None:
            return None
        try:
            with factory() as client:
                result = client.sync()
        except Exception:  # noqa: BLE001 - any failure is "cannot say"
            return None
        if max(result.txid, result.replicated_txid) > MAX_SAFE_INTEGER:
            return None
        return {
            "protocolVersion": POSITION_PROTOCOL_VERSION,
            "bootId": self.boot_id,
            "txid": result.txid,
            "replicatedTxid": result.replicated_txid,
        }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            state = dict(self._state)
        replication: dict[str, Any] | None = None
        factory = self.litestream
        if factory is not None:
            try:
                with factory() as client:
                    result = client.sync()
                    last_sync = next(
                        (d.get("last_sync_at") for d in client.databases() if d.get("path")),
                        None,
                    )
                replication = {
                    "txid": result.txid,
                    "replicatedTxid": result.replicated_txid,
                    "caughtUp": result.replicated_txid >= result.txid,
                    "lastSyncAt": last_sync,
                }
            except Exception as exc:  # noqa: BLE001 - reported, never raised
                replication = {"error": f"{type(exc).__name__}: {exc}"[:200]}
        return {
            "protocolVersion": STATUS_PROTOCOL_VERSION,
            "bootId": self.boot_id,
            **state,
            "replication": replication,
            "checkedAt": now_iso(),
        }


def _json(
    handler: BaseHTTPRequestHandler, status: int, payload: Any, *, head: bool = False
) -> None:
    body = json.dumps(payload).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    if not head:
        handler.wfile.write(body)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_control_server(board: StatusBoard, port: int, host: str = "0.0.0.0") -> _Server:
    """Serve ``GET /position`` and ``GET /status`` on a daemon thread."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/position":
                position = board.position()
                if position is None:
                    _json(self, 503, POSITION_UNAVAILABLE)
                else:
                    _json(self, 200, position)
            elif path == "/status":
                _json(self, 200, board.snapshot())
            else:
                _json(
                    self,
                    404,
                    {"error": {"code": "not_found", "message": "not found", "retryable": False}},
                )

    server = _Server((host, port), Handler)
    threading.Thread(target=server.serve_forever, name="cfo-control", daemon=True).start()
    return server


def start_recovery_responder(reason: str, port: int, host: str = "0.0.0.0") -> _Server:
    """Answer every request on the app's port with 503 ``recovery_mode``."""
    payload = {"error": {"code": "recovery_mode", "message": RECOVERY_MESSAGE, "reason": reason}}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def _refuse(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            if 0 < length <= 1 << 16:
                self.rfile.read(length)
            _json(self, 503, payload, head=self.command == "HEAD")

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = _refuse  # noqa: N815

    server = _Server((host, port), Handler)
    threading.Thread(target=server.serve_forever, name="cfo-recovery", daemon=True).start()
    return server
