"""The launcher API's wire protocol, as 3.C fixed it in ``contracts/src/launcher.ts``.

Pure: request bodies, the HMAC envelope, strict parsing of every reply, and the rules per
operation and per error code. Nothing here does I/O or imports Omnigent, so it runs in the
plain ``python/`` test environment, which checks it against the contract's fixtures, JSON
Schemas and signing vectors.

Request bodies are compact JSON with sorted keys and ASCII escapes, the bytes the signature
covers. Replies are parsed strictly: an unknown field, a wrong type or a value outside the
contract makes the reply unreadable, and an unreadable reply is an unknown outcome, never a
success.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

# ── Constants (launcher.ts) ─────────────────────────────────────────────────────────────

PROTOCOL_VERSION = 1
SIGNING_PROTOCOL = "cfo-launcher-v1"
SIGNING_KEY_ID_HEADER = "X-Omnigent-Signing-Key-Id"
TIMESTAMP_HEADER = "X-Omnigent-Timestamp"
SIGNATURE_HEADER = "X-Omnigent-Signature"
MIN_SIGNING_KEY_BYTES = 32
#: The Worker refuses a timestamp further than this from its clock.
SIGNATURE_MAX_SKEW_S = 300
#: Larger bodies are refused by the Worker; larger replies are unreadable here.
MAX_BODY_BYTES = 128 * 1024
PLATFORM_INTERNAL_HOST = "platform.internal"
DEFAULT_BASE_URL = f"http://{PLATFORM_INTERNAL_HOST}/launcher"
#: Where every computer reaches the server; ``start_host`` checks Omnigent's ``server_url``.
COMPUTER_SERVER_URL = "http://omnigent.internal"

Operation = Literal[
    "prepare",
    "provision",
    "claim_start",
    "start_host",
    "resume",
    "keep_alive",
    "status",
    "admission",
    "checkpoint",
    "suspend",
    "terminate",
]
OPERATIONS: tuple[Operation, ...] = (
    "prepare",
    "provision",
    "claim_start",
    "start_host",
    "resume",
    "keep_alive",
    "status",
    "admission",
    "checkpoint",
    "suspend",
    "terminate",
)


@dataclass(frozen=True)
class OperationRule:
    """``LAUNCHER_OPERATIONS`` in launcher.ts, for one operation."""

    omnigent_method: str
    idempotency: Literal["operation_id", "semantic", "read_only"]
    operation_id_from_omnigent: bool
    durability_wait: bool
    on_computer: bool


OPERATION_RULES: Mapping[Operation, OperationRule] = {
    "prepare": OperationRule("prepare", "read_only", False, False, False),
    "provision": OperationRule("provision", "semantic", False, True, False),
    "claim_start": OperationRule("claim_start", "operation_id", True, False, True),
    "start_host": OperationRule("start_host", "operation_id", False, True, True),
    "resume": OperationRule("resume", "semantic", False, False, True),
    "keep_alive": OperationRule("keep_alive", "semantic", False, False, True),
    "status": OperationRule("is_running", "read_only", False, False, True),
    "admission": OperationRule("admission", "read_only", False, False, True),
    "checkpoint": OperationRule("checkpoint", "operation_id", False, False, True),
    "suspend": OperationRule("suspend", "operation_id", True, True, True),
    "terminate": OperationRule("terminate", "semantic", False, True, True),
}

ErrorClass = Literal["sandbox_gone", "readable_refusal", "unknown_outcome"]

#: ``LAUNCHER_ERROR_STATUS``: the HTTP status of each error code.
ERROR_STATUS: Mapping[str, int] = {
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

#: ``LAUNCHER_ERROR_CLASS``: how each error code reaches Omnigent.
ERROR_CLASS: Mapping[str, ErrorClass] = {
    "gone": "sandbox_gone",
    "at_capacity": "readable_refusal",
    "conflict": "readable_refusal",
    "forbidden": "readable_refusal",
    "bad_request": "readable_refusal",
    "unsupported_version": "readable_refusal",
    "unauthorized": "readable_refusal",
    "not_found": "readable_refusal",
    "stale_generation": "unknown_outcome",
    "unavailable": "unknown_outcome",
    "internal": "unknown_outcome",
}

HOST_SANDBOX_STATUSES = (
    "stopped",
    "started_no_host",
    "start_claimed",
    "host_running",
    "host_refused",
    "stopping",
)
ADMISSION_REASONS = ("not_saved", "needs_sign_in")
CHECKPOINT_REASONS = ("turn_completed", "long_turn")
SUSPEND_REFUSALS = (
    "restoring",
    "capture_running",
    "terminal_open",
    "runner_processes",
    "checkpoint_failed",
    "credentials_unpublished",
)
CHECKPOINT_REFUSALS = ("not_running", "restoring", "stopping")
CLAIM_REFUSAL_STATUSES = ("stopped", "host_running", "stopping")
RESUME_OUTCOMES = ("starting", "running", "after_stop")
REMOVALS = ("pending", "resolved", "absent")

# ── Identifier formats (ids.ts, launcher.ts) ────────────────────────────────────────────

MAX_SAFE_INTEGER = 2**53 - 1
OPERATION_ID_RE = re.compile(r"[0-9a-f]{32}")
COMPUTER_ID_RE = re.compile(r"cmp_[0-9a-hjkmnp-tv-z]{26}")
HOST_ID_RE = re.compile(r"[0-9a-f]{32}")
PROVISION_NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
LAUNCH_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{32,512}")
SIGNING_KEY_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,128}")
#: Host names: no C0 control character or DEL; no lone surrogate (it has no UTF-8 form).
_HOST_NAME_REFUSED_RE = re.compile(r"[\x00-\x1f\x7f\ud800-\udfff]")
#: ``AbsolutePath``: segments that are not empty, ``.`` or ``..``, without NUL or a lone
#: surrogate (a surrogate pair in the JSON has decoded into one code point here).
_ABSOLUTE_PATH_RE = re.compile(r"(?:/(?!\.\.?(?:/|$))[^/\x00\ud800-\udfff]+)+")
MAX_HOST_NAME_UNITS = 128
MAX_PATH_UNITS = 4096
MAX_HOST_CONFIG_CHARS = 64 * 1024
MAX_ADMISSION_MESSAGE_UNITS = 300


class ProtocolError(ValueError):
    """A request could not be built, or a reply does not follow the contract."""


def utf16_units(text: str) -> int:
    """String length as JavaScript counts it (UTF-16 code units), as zod's limits do."""
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def new_operation_id() -> str:
    """An operation ID in Omnigent's own form, ``uuid.uuid4().hex``."""
    return uuid.uuid4().hex


def is_operation_id(value: object) -> bool:
    return isinstance(value, str) and OPERATION_ID_RE.fullmatch(value) is not None


def is_computer_id(value: object) -> bool:
    return isinstance(value, str) and COMPUTER_ID_RE.fullmatch(value) is not None


# ── Requests ────────────────────────────────────────────────────────────────────────────


def _require(ok: bool, message: str) -> None:
    if not ok:
        raise ProtocolError(message)


def _call(operation: Operation, operation_id: str) -> dict[str, Any]:
    _require(is_operation_id(operation_id), "an operation ID is 32 lowercase hex digits")
    return {
        "operation": operation,
        "operationId": operation_id,
        "protocolVersion": PROTOCOL_VERSION,
    }


def _on_computer(operation: Operation, operation_id: str, computer_id: str) -> dict[str, Any]:
    _require(is_computer_id(computer_id), "the sandbox ID is not a computer ID")
    return {**_call(operation, operation_id), "computerId": computer_id}


def prepare_request(operation_id: str) -> dict[str, Any]:
    return _call("prepare", operation_id)


def provision_request(operation_id: str, name: str) -> dict[str, Any]:
    _require(
        isinstance(name, str) and PROVISION_NAME_RE.fullmatch(name) is not None,
        "a computer's name is 1 to 63 lowercase letters, digits and hyphens",
    )
    return {**_call("provision", operation_id), "name": name}


def claim_start_request(operation_id: str, computer_id: str) -> dict[str, Any]:
    return _on_computer("claim_start", operation_id, computer_id)


def check_host_config(host_config: Mapping[str, object]) -> dict[str, object]:
    """Omnigent's ``host_config`` as the contract's ``HostConfig``: a JSON object, ≤ 64 KiB."""
    _require(isinstance(host_config, Mapping), "the host configuration must be a mapping")
    _require(
        all(isinstance(key, str) for key in host_config),
        "the host configuration's keys must be strings",
    )
    try:
        # ASCII escapes are never shorter than JavaScript's own stringify, so this bound holds
        # wherever the Worker measures it.
        text = json.dumps(dict(host_config), separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ProtocolError(f"the host configuration is not JSON: {type(exc).__name__}") from None
    _require(len(text) <= MAX_HOST_CONFIG_CHARS, "the host configuration is larger than 64 KiB")
    loaded = json.loads(text)
    assert isinstance(loaded, dict)
    return loaded


def check_host_name(host_name: str) -> str:
    _require(isinstance(host_name, str), "a host name is text")
    _require(
        1 <= utf16_units(host_name) <= MAX_HOST_NAME_UNITS,
        "a host name is 1 to 128 characters",
    )
    _require(
        _HOST_NAME_REFUSED_RE.search(host_name) is None,
        "a host name has no control characters",
    )
    return host_name


def start_host_request(
    operation_id: str,
    computer_id: str,
    *,
    start_attempt: int,
    host_id: str,
    host_name: str,
    token: str,
    host_config: Mapping[str, object],
) -> dict[str, Any]:
    _require(
        _is_int(start_attempt) and 1 <= start_attempt <= MAX_SAFE_INTEGER,
        "a start attempt is a positive whole number",
    )
    _require(
        isinstance(host_id, str) and HOST_ID_RE.fullmatch(host_id) is not None,
        "a host ID is 32 lowercase hex digits",
    )
    # The token is never part of a message: it is login material.
    _require(
        isinstance(token, str) and LAUNCH_TOKEN_RE.fullmatch(token) is not None,
        "the launch token does not have the expected form",
    )
    return {
        **_on_computer("start_host", operation_id, computer_id),
        "startAttempt": start_attempt,
        "hostId": host_id,
        "hostName": check_host_name(host_name),
        "token": token,
        "hostConfig": check_host_config(host_config),
    }


def resume_request(operation_id: str, computer_id: str) -> dict[str, Any]:
    return _on_computer("resume", operation_id, computer_id)


def keep_alive_request(operation_id: str, computer_id: str) -> dict[str, Any]:
    return _on_computer("keep_alive", operation_id, computer_id)


def status_request(operation_id: str, computer_id: str) -> dict[str, Any]:
    return _on_computer("status", operation_id, computer_id)


def admission_request(operation_id: str, computer_id: str) -> dict[str, Any]:
    return _on_computer("admission", operation_id, computer_id)


def checkpoint_request(operation_id: str, computer_id: str, reason: str) -> dict[str, Any]:
    _require(reason in CHECKPOINT_REASONS, "a checkpoint reason is turn_completed or long_turn")
    return {**_on_computer("checkpoint", operation_id, computer_id), "reason": reason}


def suspend_request(operation_id: str, computer_id: str) -> dict[str, Any]:
    return _on_computer("suspend", operation_id, computer_id)


def terminate_request(operation_id: str, computer_id: str) -> dict[str, Any]:
    return _on_computer("terminate", operation_id, computer_id)


def encode_body(request: Mapping[str, Any]) -> bytes:
    """The exact bytes sent and signed: compact JSON, sorted keys, ASCII only."""
    return json.dumps(request, sort_keys=True, separators=(",", ":"), allow_nan=False).encode(
        "ascii"
    )


# ── The HMAC envelope ───────────────────────────────────────────────────────────────────


def string_to_sign(*, operation: str, key_id: str, timestamp: int, body: bytes) -> str:
    """The five lines a signature covers (launcher.ts, ``launcherStringToSign``)."""
    return "\n".join(
        (SIGNING_PROTOCOL, operation, key_id, str(timestamp), hashlib.sha256(body).hexdigest())
    )


def sign_request(
    *, key: bytes, key_id: str, operation: str, timestamp: int, body: bytes
) -> dict[str, str]:
    """The three signature headers for one request."""
    _require(len(key) >= MIN_SIGNING_KEY_BYTES, "a signing key has at least 32 bytes")
    _require(SIGNING_KEY_ID_RE.fullmatch(key_id) is not None, "malformed signing key ID")
    _require(_is_int(timestamp) and 0 <= timestamp < 10**16, "malformed timestamp")
    message = string_to_sign(operation=operation, key_id=key_id, timestamp=timestamp, body=body)
    signature = hmac.new(key, message.encode("ascii"), hashlib.sha256).hexdigest()
    return {
        SIGNING_KEY_ID_HEADER: key_id,
        TIMESTAMP_HEADER: str(timestamp),
        SIGNATURE_HEADER: signature,
    }


# ── Replies ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PrepareResult:
    supported_protocol_versions: tuple[int, ...]


@dataclass(frozen=True)
class ProvisionResult:
    computer_id: str


@dataclass(frozen=True)
class ClaimStartResult:
    granted: bool
    start_attempt: int | None = None
    #: The status that refused the claim: ``stopped``, ``host_running`` or ``stopping``.
    status: str | None = None


@dataclass(frozen=True)
class StartHostResult:
    workspace_path: str


@dataclass(frozen=True)
class ResumeResult:
    outcome: str
    generation: int


@dataclass(frozen=True)
class KeepAliveResult:
    renewed: bool


@dataclass(frozen=True)
class StatusResult:
    running: bool
    status: str
    generation: int


@dataclass(frozen=True)
class AdmissionResult:
    admitting: bool
    status: str
    generation: int
    reason: str | None = None
    message: str | None = None


@dataclass(frozen=True)
class CheckpointResult:
    outcome: Literal["accepted", "refused"]
    folded: bool | None = None
    reason: str | None = None


@dataclass(frozen=True)
class SuspendResult:
    outcome: Literal["refused", "stopped", "in_progress"]
    reason: str | None = None


@dataclass(frozen=True)
class TerminateResult:
    removal: str


Result = (
    PrepareResult
    | ProvisionResult
    | ClaimStartResult
    | StartHostResult
    | ResumeResult
    | KeepAliveResult
    | StatusResult
    | AdmissionResult
    | CheckpointResult
    | SuspendResult
    | TerminateResult
)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _json_int(value: object) -> int | None:
    """A JSON number that is a whole number (``3``, ``3.0``, ``3e0``), else ``None``.

    JSON Schema's ``integer`` accepts any mathematically integral number; booleans are not
    numbers here.
    """
    if _is_int(value):
        return value  # type: ignore[return-value]
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return None


def _fields(payload: object, required: set[str], optional: frozenset[str] = frozenset()) -> dict:
    _require(isinstance(payload, dict), "a reply is a JSON object")
    assert isinstance(payload, dict)
    keys = set(payload)
    # Fixed messages: a reply's own keys or values never reach a log or an error.
    _require(required <= keys, "the reply lacks a required field")
    _require(keys <= required | optional, "the reply has a field outside the contract")
    return payload


def _bool(value: object) -> bool:
    _require(isinstance(value, bool), "expected true or false")
    assert isinstance(value, bool)
    return value


def _enum(value: object, allowed: tuple[str, ...]) -> str:
    _require(isinstance(value, str) and value in allowed, "a value outside the contract")
    assert isinstance(value, str)
    return value


def _generation(value: object) -> int:
    number = _json_int(value)
    _require(number is not None and 0 <= number <= MAX_SAFE_INTEGER, "malformed generation")
    assert number is not None
    return number


def _attempt(value: object) -> int:
    number = _json_int(value)
    _require(number is not None and 1 <= number <= MAX_SAFE_INTEGER, "malformed start attempt")
    assert number is not None
    return number


def _absolute_path(value: object) -> str:
    _require(
        isinstance(value, str)
        and utf16_units(value) <= MAX_PATH_UNITS
        and _ABSOLUTE_PATH_RE.fullmatch(value) is not None,
        "malformed workspace path",
    )
    assert isinstance(value, str)
    return value


def _parse_prepare(p: dict) -> PrepareResult:
    versions = p["supportedProtocolVersions"]
    _require(isinstance(versions, list) and len(versions) >= 1, "no protocol versions")
    parsed = tuple(_attempt(v) for v in versions)
    return PrepareResult(supported_protocol_versions=parsed)


def _parse_claim(p: dict) -> ClaimStartResult:
    if p.get("granted") is True:
        _fields(p, {"operation", "granted", "startAttempt"})
        return ClaimStartResult(granted=True, start_attempt=_attempt(p["startAttempt"]))
    _fields(p, {"operation", "granted", "status"})
    _require(p["granted"] is False, "granted is true or false")
    return ClaimStartResult(granted=False, status=_enum(p["status"], CLAIM_REFUSAL_STATUSES))


def _parse_admission(p: dict) -> AdmissionResult:
    if p.get("admitting") is True:
        _fields(p, {"operation", "admitting", "status", "generation"})
        return AdmissionResult(
            admitting=True,
            status=_enum(p["status"], HOST_SANDBOX_STATUSES),
            generation=_generation(p["generation"]),
        )
    _fields(p, {"operation", "admitting", "reason", "status", "generation"}, frozenset({"message"}))
    _require(p["admitting"] is False, "admitting is true or false")
    message = p.get("message")
    if message is not None or "message" in p:
        _require(
            isinstance(message, str) and 1 <= utf16_units(message) <= MAX_ADMISSION_MESSAGE_UNITS,
            "malformed admission message",
        )
    return AdmissionResult(
        admitting=False,
        reason=_enum(p["reason"], ADMISSION_REASONS),
        message=message,
        status=_enum(p["status"], HOST_SANDBOX_STATUSES),
        generation=_generation(p["generation"]),
    )


def _parse_checkpoint(p: dict) -> CheckpointResult:
    if p.get("outcome") == "accepted":
        _fields(p, {"operation", "outcome", "folded"})
        return CheckpointResult(outcome="accepted", folded=_bool(p["folded"]))
    _fields(p, {"operation", "outcome", "reason"})
    _require(p["outcome"] == "refused", "a checkpoint is accepted or refused")
    return CheckpointResult(outcome="refused", reason=_enum(p["reason"], CHECKPOINT_REFUSALS))


def _parse_suspend(p: dict) -> SuspendResult:
    if p.get("outcome") == "refused":
        _fields(p, {"operation", "outcome", "reason"})
        return SuspendResult(outcome="refused", reason=_enum(p["reason"], SUSPEND_REFUSALS))
    _fields(p, {"operation", "outcome"})
    outcome = _enum(p["outcome"], ("stopped", "in_progress"))
    return SuspendResult(outcome=outcome)  # type: ignore[arg-type]


def parse_result(operation: Operation, payload: object) -> Result:
    """Parse a 200 reply to *operation* strictly; raise :class:`ProtocolError` otherwise."""
    _require(isinstance(payload, dict), "a reply is a JSON object")
    assert isinstance(payload, dict)
    _require(payload.get("operation") == operation, "the reply is for another operation")
    p = payload
    if operation == "prepare":
        return _parse_prepare(_fields(p, {"operation", "supportedProtocolVersions"}))
    if operation == "provision":
        _fields(p, {"operation", "computerId"})
        _require(is_computer_id(p["computerId"]), "malformed computer ID")
        return ProvisionResult(computer_id=p["computerId"])
    if operation == "claim_start":
        return _parse_claim(p)
    if operation == "start_host":
        _fields(p, {"operation", "workspacePath"})
        return StartHostResult(workspace_path=_absolute_path(p["workspacePath"]))
    if operation == "resume":
        _fields(p, {"operation", "outcome", "generation"})
        return ResumeResult(
            outcome=_enum(p["outcome"], RESUME_OUTCOMES), generation=_generation(p["generation"])
        )
    if operation == "keep_alive":
        _fields(p, {"operation", "renewed"})
        return KeepAliveResult(renewed=_bool(p["renewed"]))
    if operation == "status":
        _fields(p, {"operation", "running", "status", "generation"})
        return StatusResult(
            running=_bool(p["running"]),
            status=_enum(p["status"], HOST_SANDBOX_STATUSES),
            generation=_generation(p["generation"]),
        )
    if operation == "admission":
        return _parse_admission(p)
    if operation == "checkpoint":
        return _parse_checkpoint(p)
    if operation == "suspend":
        return _parse_suspend(p)
    if operation == "terminate":
        _fields(p, {"operation", "removal"})
        return TerminateResult(removal=_enum(p["removal"], REMOVALS))
    raise ProtocolError(f"unknown operation {operation!r}")


@dataclass(frozen=True)
class ErrorReply:
    """An ``ErrorBody`` reply. An unknown code reads as ``internal`` (errors.ts: additive)."""

    code: str
    message: str
    retryable: bool

    @property
    def error_class(self) -> ErrorClass:
        return ERROR_CLASS.get(self.code, "unknown_outcome")


def parse_error(payload: object) -> ErrorReply:
    """Parse an ``ErrorBody``; raise :class:`ProtocolError` when it is not one."""
    outer = _fields(payload, {"error"})
    inner = _fields(outer["error"], {"code", "message", "retryable"})
    code, message = inner["code"], inner["message"]
    _require(isinstance(code, str), "an error code is text")
    _require(
        isinstance(message, str) and 1 <= utf16_units(message) <= 500,
        "malformed error message",
    )
    return ErrorReply(
        code=code if code in ERROR_CLASS else "internal",
        message=message,
        retryable=_bool(inner["retryable"]),
    )


def readable(text: str, limit: int = 300, *, redact: tuple[str, ...] = ()) -> str:
    """Text from the platform made safe to show: one line, no control characters, bounded,
    and without any of the *redact* values (login material the request carried)."""
    for secret in redact:
        if secret:
            text = text.replace(secret, "[redacted]")
    cleaned = "".join(ch if ch.isprintable() else " " for ch in text).strip()
    return cleaned[:limit] if cleaned else "no detail given"


def finite_seconds(value: float) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)
