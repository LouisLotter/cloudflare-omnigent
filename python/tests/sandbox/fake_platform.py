"""A fake launcher API: the platform Worker's ``platform.internal`` route and a WorkspaceDO.

It serves real HTTP on a loopback port, checks every request the way 3.C says the Worker does,
in the Worker's order and before any effect (FH-28): the signature headers, a known key ID and a
constant-time signature match (401), the timestamp within 300 s (401), the path's operation
equal to the body's and the body valid against the exported ``LauncherRequest`` schema (400),
and the protocol version (400). Every reply it sends is checked against ``LauncherResult`` or
``ErrorBody``, so the fake cannot drift from the contract either.

Behind that sits a small WorkspaceDO following the lifecycle table's launcher replies: typed
status, start claims and attempt-bound starts, outcomes recorded by operation ID, a sleep that
stays ``in_progress`` for a few polls, removal intents, and an awake limit.

Faults are injected per operation: a reply lost before or after the effect, a delay past the
client's deadline, an error code, an unreadable reply, an HTML 502 from in front of the Worker.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import jsonschema

ROOT = Path(__file__).resolve().parents[3]
SCHEMAS = ROOT / "contracts" / "schema"

KEY_ID = "k-test-1"
_CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"
WORKSPACE_PATH = "/home/omnigent/work"


def synthetic_key() -> bytes:
    """A signing key made at run time; never a committed value."""
    return secrets.token_hex(24).encode()


def new_computer_id() -> str:
    return "cmp_" + "".join(secrets.choice(_CROCKFORD) for _ in range(26))


def _validator(name: str) -> jsonschema.protocols.Validator:
    schema = json.loads((SCHEMAS / f"{name}.schema.json").read_text())
    cls = jsonschema.validators.validator_for(schema)
    return cls(schema)


REQUEST_SCHEMA = _validator("LauncherRequest")
RESULT_SCHEMA = _validator("LauncherResult")
ERROR_SCHEMA = _validator("ErrorBody")


@dataclass
class Fault:
    """One injected fault for the next ``times`` requests of ``operation`` that pass the checks.

    ``kind``: ``drop_before`` (no effect, no reply), ``drop_after`` (effect, no reply),
    ``delay`` (effect, then the reply after ``delay_s``), ``error`` (no effect, an error reply
    with ``code``), ``garbage`` (effect, a 200 that is not JSON), ``html502`` (no effect, a 502
    page from in front of the Worker), ``extra_field`` (effect, a reply with an unknown field).
    """

    operation: str
    kind: str
    times: int = 1
    code: str = "unavailable"
    message: str = "The platform is restarting."
    delay_s: float = 0.0
    #: For ``error``: an HTTP status other than the code's own (a contract-inconsistent reply).
    status: int | None = None
    #: For ``extra_field``: the unknown field's name.
    field: str = "surprise"


@dataclass
class Recorded:
    """A request that reached the API, whether or not it was accepted."""

    operation: str | None
    status: int
    body: dict[str, Any] | None
    key_id: str | None
    fault: str | None = None
    at: float = field(default_factory=time.time)

    @property
    def operation_id(self) -> str | None:
        return None if self.body is None else self.body.get("operationId")

    @property
    def computer_id(self) -> str | None:
        return None if self.body is None else self.body.get("computerId")


@dataclass
class Computer:
    """WorkspaceDO's state, as far as the launcher can see it."""

    computer_id: str
    name: str
    status: str = "stopped"
    generation: int = 0
    attempt: int = 0
    host_id: str | None = None
    removal: bool = False
    admitting: bool = True
    capture_running: bool = False
    stop_op: str | None = None
    stop_polls_left: int = 0
    keep_alives: int = 0
    claims: dict[str, dict[str, Any]] = field(default_factory=dict)
    starts: dict[str, dict[str, Any]] = field(default_factory=dict)
    saves: dict[str, dict[str, Any]] = field(default_factory=dict)
    sleeps: dict[str, dict[str, Any]] = field(default_factory=dict)
    tokens: list[str] = field(default_factory=list)


ERROR_STATUS = {
    "bad_request": 400,
    "unsupported_version": 400,
    "unauthorized": 401,
    "forbidden": 403,
    "not_found": 404,
    "conflict": 409,
    "stale_generation": 409,
    "gone": 410,
    "at_capacity": 429,
    "internal": 500,
    "unavailable": 503,
}


class ApiError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class FakeLauncherApi:
    """The launcher API on ``http://127.0.0.1:<port>/launcher``."""

    def __init__(self, keys: dict[str, bytes] | None = None) -> None:
        self.keys = keys if keys is not None else {KEY_ID: synthetic_key()}
        self.lock = threading.RLock()
        self.requests: list[Recorded] = []
        self.faults: list[Fault] = []
        self.computers: dict[str, Computer] = {}
        self.by_name: dict[str, str] = {}
        self.capacity = 10
        self.supported_versions = [1]
        self.suspend_polls = 0
        self.suspend_refusal: str | None = None
        self.removal_outcome = "pending"
        self.clock: Callable[[], float] = time.time
        #: Called (outside the lock) when a start's parameters are accepted: (computer, token).
        self.on_start_host: Callable[[Computer, str], None] | None = None
        #: Called (outside the lock) when a sleep stops the computer.
        self.on_stopped: Callable[[Computer], None] | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # ── lifecycle of the fake ─────────────────────────────────────────────────────────

    @property
    def key_id(self) -> str:
        return next(iter(self.keys))

    @property
    def key(self) -> bytes:
        return self.keys[self.key_id]

    @property
    def base_url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/launcher"

    def start(self) -> FakeLauncherApi:
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: Any) -> None:
                pass

            def do_POST(self) -> None:  # noqa: N802
                api._handle(self)

            def do_GET(self) -> None:  # noqa: N802
                self.send_error(405)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    # ── queries for tests ─────────────────────────────────────────────────────────────

    def accepted(self, operation: str | None = None) -> list[Recorded]:
        with self.lock:
            return [
                r
                for r in self.requests
                if r.status != 401 and (operation is None or r.operation == operation)
            ]

    def computer(self, computer_id: str | None = None) -> Computer:
        with self.lock:
            if computer_id is None:
                (only,) = self.computers.values()
                return only
            return self.computers[computer_id]

    def add_computer(self, name: str = "managed-0123abcd", **state: Any) -> Computer:
        with self.lock:
            computer = Computer(computer_id=new_computer_id(), name=name, **state)
            self.computers[computer.computer_id] = computer
            self.by_name[name] = computer.computer_id
            return computer

    def fault(self, operation: str, kind: str, **kwargs: Any) -> Fault:
        fault = Fault(operation=operation, kind=kind, **kwargs)
        with self.lock:
            self.faults.append(fault)
        return fault

    # ── HTTP ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _send_status(handler: BaseHTTPRequestHandler, status: int) -> None:
        # Recorded before the reply is written: the client can return, and its test read
        # `requests`, before this thread gets back to `_handle`.
        record = getattr(handler, "cfo_record", None)
        if record is not None:
            record.status = status
        handler.send_response(status)

    def _reply(self, handler: BaseHTTPRequestHandler, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode()
        self._send_status(handler, status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

    def _error(
        self,
        handler: BaseHTTPRequestHandler,
        code: str,
        message: str,
        status: int | None = None,
    ) -> int:
        body = {"error": {"code": code, "message": message, "retryable": code == "unavailable"}}
        ERROR_SCHEMA.validate(body)
        status = status if status is not None else ERROR_STATUS[code]
        self._reply(handler, status, body)
        return status

    def _take_fault(self, operation: str) -> Fault | None:
        with self.lock:
            for fault in self.faults:
                if fault.operation == operation and fault.times > 0:
                    fault.times -= 1
                    return fault
        return None

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(length) if length else b""
        key_id = handler.headers.get("X-Omnigent-Signing-Key-Id")
        record = Recorded(operation=None, status=0, body=None, key_id=key_id)
        with self.lock:
            self.requests.append(record)
        handler.cfo_record = record  # type: ignore[attr-defined]
        record.status = self._check_and_serve(handler, raw, record)

    def _check_and_serve(
        self, handler: BaseHTTPRequestHandler, raw: bytes, record: Recorded
    ) -> int:
        # 1. Headers, key and signature, in constant time.
        key_id = handler.headers.get("X-Omnigent-Signing-Key-Id")
        timestamp = handler.headers.get("X-Omnigent-Timestamp")
        signature = handler.headers.get("X-Omnigent-Signature")
        path_operation = handler.path.removeprefix("/launcher/")
        if len(raw) > 128 * 1024:
            return self._error(handler, "bad_request", "The request body is too large.")
        if not key_id or not timestamp or not signature or key_id not in self.keys:
            return self._error(handler, "unauthorized", "The request is not signed.")
        message = "\n".join(
            ("cfo-launcher-v1", path_operation, key_id, timestamp, hashlib.sha256(raw).hexdigest())
        )
        expected = hmac.new(self.keys[key_id], message.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return self._error(handler, "unauthorized", "The signature does not match.")
        # 2. The timestamp.
        if not timestamp.isdigit() or abs(self.clock() - int(timestamp)) > 300:
            return self._error(handler, "unauthorized", "The request's timestamp is stale.")
        # 3. Path, body and schema.
        try:
            body = json.loads(raw)
        except ValueError:
            return self._error(handler, "bad_request", "The body is not JSON.")
        record.body = body if isinstance(body, dict) else None
        record.operation = body.get("operation") if isinstance(body, dict) else None
        if record.operation != path_operation:
            return self._error(handler, "bad_request", "The path and the body disagree.")
        try:
            REQUEST_SCHEMA.validate(body)
        except jsonschema.ValidationError:
            return self._error(handler, "bad_request", "The request does not match the contract.")
        # 4. The protocol version.
        if body["protocolVersion"] not in self.supported_versions:
            return self._error(handler, "unsupported_version", "Unsupported protocol version.")

        fault = self._take_fault(path_operation)
        record.fault = fault.kind if fault is not None else None
        if fault is not None and fault.kind == "drop_before":
            handler.close_connection = True
            return 0
        if fault is not None and fault.kind == "error":
            return self._error(handler, fault.code, fault.message, fault.status)
        if fault is not None and fault.kind == "html502":
            page = b"<html><body>502 Bad Gateway</body></html>"
            self._send_status(handler, 502)
            handler.send_header("Content-Type", "text/html")
            handler.send_header("Content-Length", str(len(page)))
            handler.end_headers()
            handler.wfile.write(page)
            return 502
        try:
            result, hooks = self._apply(body)
        except ApiError as exc:
            return self._error(handler, exc.code, exc.message)
        RESULT_SCHEMA.validate(result)
        for hook in hooks:
            hook()
        if fault is not None and fault.kind == "drop_after":
            handler.close_connection = True
            return 0
        if fault is not None and fault.kind == "delay":
            time.sleep(fault.delay_s)
        if fault is not None and fault.kind == "garbage":
            data = b"{not json"
            self._send_status(handler, 200)
            handler.send_header("Content-Length", str(len(data)))
            handler.end_headers()
            handler.wfile.write(data)
            return 200
        if fault is not None and fault.kind == "extra_field":
            result = {**result, fault.field: True}
        try:
            self._reply(handler, 200, result)
        except OSError:
            return 0  # the client gave up first
        return 200

    # ── WorkspaceDO ───────────────────────────────────────────────────────────────────

    def _apply(self, body: dict[str, Any]) -> tuple[dict[str, Any], list[Callable[[], None]]]:
        op = body["operation"]
        hooks: list[Callable[[], None]] = []
        with self.lock:
            if op == "prepare":
                return {"operation": op, "supportedProtocolVersions": self.supported_versions}, []
            if op == "provision":
                computer_id = self.by_name.get(body["name"])
                if computer_id is None:
                    computer_id = self.add_computer(body["name"]).computer_id
                return {"operation": op, "computerId": computer_id}, []
            c = self.computers.get(body["computerId"])
            if c is None:
                if op == "terminate":
                    return {"operation": op, "removal": "absent"}, []
                raise ApiError("not_found", "No such computer.")
            if c.removal and op in ("resume", "claim_start", "start_host", "checkpoint", "suspend"):
                raise ApiError("gone", "This computer is being removed.")
            result = getattr(self, f"_{op}")(c, body, hooks)
            return {"operation": op, **result}, hooks

    def _claim_start(self, c: Computer, body: dict, hooks: list) -> dict[str, Any]:
        recorded = c.claims.get(body["operationId"])
        if recorded is not None:
            return recorded
        if c.status in ("started_no_host", "start_claimed", "host_refused"):
            c.attempt += 1
            c.status = "start_claimed"
            outcome: dict[str, Any] = {"granted": True, "startAttempt": c.attempt}
        else:
            refused = c.status if c.status in ("stopped", "host_running", "stopping") else "stopped"
            outcome = {"granted": False, "status": refused}
        c.claims[body["operationId"]] = outcome
        return outcome

    def _start_host(self, c: Computer, body: dict, hooks: list) -> dict[str, Any]:
        recorded = c.starts.get(body["operationId"])
        if recorded is not None:
            return recorded
        if c.host_id is not None and c.host_id != body["hostId"]:
            raise ApiError("conflict", "This computer belongs to another host.")
        if body["startAttempt"] != c.attempt or c.status != "start_claimed":
            raise ApiError("conflict", "That start attempt is no longer current.")
        c.host_id = body["hostId"]
        c.status = "host_running"
        c.tokens.append(body["token"])
        outcome = {"workspacePath": WORKSPACE_PATH}
        c.starts[body["operationId"]] = outcome
        if self.on_start_host is not None:
            start, token = self.on_start_host, body["token"]
            hooks.append(lambda: start(c, token))
        return outcome

    def _resume(self, c: Computer, body: dict, hooks: list) -> dict[str, Any]:
        if c.status == "stopped":
            awake = sum(1 for o in self.computers.values() if o.status != "stopped")
            if awake >= self.capacity:
                raise ApiError("at_capacity", "All computers are busy. Try again later.")
            c.generation += 1
            c.status = "started_no_host"
            outcome = "starting"
        elif c.status == "stopping":
            outcome = "after_stop"
        else:
            outcome = "running"
        return {"outcome": outcome, "generation": c.generation}

    def _keep_alive(self, c: Computer, body: dict, hooks: list) -> dict[str, Any]:
        renewed = c.status != "stopped"
        c.keep_alives += int(renewed)
        return {"renewed": renewed}

    def _status(self, c: Computer, body: dict, hooks: list) -> dict[str, Any]:
        return {"running": c.status != "stopped", "status": c.status, "generation": c.generation}

    def _admission(self, c: Computer, body: dict, hooks: list) -> dict[str, Any]:
        common = {"status": c.status, "generation": c.generation}
        if c.admitting:
            return {"admitting": True, **common}
        return {
            "admitting": False,
            "reason": "not_saved",
            "message": "The computer's files have not been saved for 35 minutes.",
            **common,
        }

    def _checkpoint(self, c: Computer, body: dict, hooks: list) -> dict[str, Any]:
        recorded = c.saves.get(body["operationId"])
        if recorded is not None:
            return recorded
        if c.status == "stopping":
            outcome: dict[str, Any] = {"outcome": "refused", "reason": "stopping"}
        elif c.status != "host_running":
            outcome = {"outcome": "refused", "reason": "not_running"}
        else:
            outcome = {"outcome": "accepted", "folded": c.capture_running}
            c.capture_running = True
        c.saves[body["operationId"]] = outcome
        return outcome

    def _suspend(self, c: Computer, body: dict, hooks: list) -> dict[str, Any]:
        op = body["operationId"]
        recorded = c.sleeps.get(op)
        if recorded is not None:
            return recorded
        if c.stop_op is None and c.status == "stopped":
            c.sleeps[op] = {"outcome": "stopped"}
            return c.sleeps[op]
        if c.stop_op is None:
            if self.suspend_refusal is not None:
                outcome = {"outcome": "refused", "reason": self.suspend_refusal}
                c.sleeps[op] = outcome
                return outcome
            c.stop_op = op
            c.status = "stopping"
            c.stop_polls_left = self.suspend_polls
        if c.stop_polls_left > 0:
            c.stop_polls_left -= 1
            return {"outcome": "in_progress"}
        # The stop is confirmed: every sleep operation that joined it shares the outcome.
        c.status = "stopped"
        c.capture_running = False
        c.sleeps[c.stop_op] = c.sleeps[op] = {"outcome": "stopped"}
        c.stop_op = None
        if self.on_stopped is not None:
            stopped = self.on_stopped
            hooks.append(lambda: stopped(c))
        return {"outcome": "stopped"}

    def _terminate(self, c: Computer, body: dict, hooks: list) -> dict[str, Any]:
        c.removal = True
        return {"removal": self.removal_outcome}
