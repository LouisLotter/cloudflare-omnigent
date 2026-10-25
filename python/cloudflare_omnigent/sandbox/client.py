"""HTTP to the launcher API: one signed POST per attempt, repeated while the outcome is unknown.

Every operation is ``POST <base>/<operation>`` with the operation also in the body. Each attempt
opens its own connection, signs the same body bytes with a fresh timestamp, and has its own
deadline. A lost or unreadable reply is repeated with the same operation ID, which the platform
answers with its recorded outcome, until the call's budget runs out; then the outcome is
unknown. A refusal or ``gone`` ends the call at once.

Logs name the operation, its operation ID, the computer, HTTP statuses and error codes. Never a
body, a header, a token or the key.
"""

from __future__ import annotations

import contextlib
import http.client
import io
import json
import logging
import socket
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from cloudflare_omnigent.sandbox import protocol
from cloudflare_omnigent.sandbox.settings import LauncherSettings

logger = logging.getLogger("cloudflare_omnigent.sandbox")


class LauncherError(Exception):
    """Base of the launcher's failures. Messages are readable and never carry login material."""


class PlatformGone(LauncherError):
    """The platform answered ``gone``: the computer was removed or has a removal intent."""


class PlatformRefusal(LauncherError):
    """A final refusal the person should see, for example "All computers are busy"."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class OutcomeUnknown(LauncherError):
    """No readable answer within the call's budget: the effect may or may not have happened."""


@dataclass(frozen=True)
class CallPolicy:
    """How long one launcher call may take.

    :param attempt_timeout_s: Deadline of one HTTP attempt, connection to last byte.
    :param budget_s: Time within which a lost or unreadable reply is repeated.
    """

    attempt_timeout_s: float
    budget_s: float


@dataclass(frozen=True)
class Reply:
    """A readable answer, and when the attempt that got it was sent (wall clock)."""

    result: protocol.Result
    sent_at: float
    attempts: int


#: ``(url, headers, body, timeout_s) -> (status, body)``; raises ``OSError`` or
#: ``http.client.HTTPException`` when no complete reply arrives.
Post = Callable[[str, Mapping[str, str], bytes, float], tuple[int, bytes]]

#: The first wait before a lost reply is repeated, doubling up to the second.
BACKOFF_S = 0.25
MAX_BACKOFF_S = 4.0


class _DeadlineSocket:
    """A connected socket whose every blocking call ends by one absolute deadline.

    ``http.client`` reads the status line, the headers and the body through ``makefile``, one
    ``recv_into`` at a time. Each call here gets only the time left before the deadline, so a
    peer that trickles partial lines can never stretch the attempt (AT3-009); a per-read idle
    timeout would restart with every byte. :meth:`abort` unblocks a call in progress from
    another thread; closing stays with the thread that uses the socket, so a descriptor is
    never closed while a call on it is in flight.
    """

    def __init__(self, sock: socket.socket, deadline: float) -> None:
        self._sock = sock
        self._deadline = deadline
        self._io_refs = 0
        self._closed = False
        # Shutdown (another thread) and close never interleave, so a shutdown never reaches a
        # descriptor number the process has already reused.
        self._lock = threading.Lock()

    def _left(self) -> float:
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("the attempt's deadline passed")
        return remaining

    def sendall(self, data: bytes) -> None:
        self._sock.settimeout(self._left())
        self._sock.sendall(data)

    def recv_into(self, buffer: Any, nbytes: int = 0) -> int:
        self._sock.settimeout(self._left())
        return self._sock.recv_into(buffer, nbytes)

    def makefile(self, mode: str = "rb", *args: Any, **kwargs: Any) -> io.BufferedReader:
        if mode != "rb":
            raise ValueError("the launcher's socket is only read as bytes")
        self._io_refs += 1
        return io.BufferedReader(socket.SocketIO(self, "rb"))  # type: ignore[arg-type]

    def _decref_socketios(self) -> None:
        """Called by ``SocketIO.close``; the socket closes once nothing reads it."""
        self._io_refs = max(self._io_refs - 1, 0)
        if self._closed and self._io_refs == 0:
            self.force_close()

    def close(self) -> None:
        self._closed = True
        if self._io_refs == 0:
            self.force_close()

    def force_close(self) -> None:
        self._closed = True
        with self._lock:
            self._sock.close()

    def abort(self) -> None:
        """Make any call in progress return at once (from another thread)."""
        with self._lock, contextlib.suppress(OSError):
            if self._sock.fileno() != -1:
                self._sock.shutdown(socket.SHUT_RDWR)


class _DeadlineConnection(http.client.HTTPConnection):
    """``HTTPConnection`` over a :class:`_DeadlineSocket`."""

    def __init__(self, host: str, port: int | None, deadline: float) -> None:
        super().__init__(host, port)
        self._deadline = deadline
        self.deadline_socket: _DeadlineSocket | None = None
        self.aborted = False

    def connect(self) -> None:
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("the attempt's deadline passed")
        raw = socket.create_connection((self.host, self.port), timeout=remaining)
        wrapped = _DeadlineSocket(raw, self._deadline)
        self.deadline_socket = wrapped
        self.sock = wrapped  # type: ignore[assignment]
        if self.aborted:  # cancelled while resolving or connecting
            wrapped.force_close()
            raise TimeoutError("the attempt's deadline passed")


class _Exchange:
    """One request and its whole reply, run in a worker thread."""

    def __init__(self, url: str, headers: Mapping[str, str], body: bytes, deadline: float):
        parts = urlsplit(url)
        if parts.scheme != "http" or not parts.hostname:
            raise ValueError("the launcher API is reached over plain http")
        self._path = parts.path or "/"
        self._headers = dict(headers)
        self._body = body
        self.connection = _DeadlineConnection(parts.hostname, parts.port, deadline)
        self.result: tuple[int, bytes] | None = None
        self.error: BaseException | None = None

    def run(self) -> None:
        connection = self.connection
        try:
            connection.connect()
            connection.request("POST", self._path, body=self._body, headers=self._headers)
            response = connection.getresponse()
            try:
                chunks: list[bytes] = []
                size = 0
                while size <= protocol.MAX_BODY_BYTES:
                    chunk = response.read1(16 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                if size <= protocol.MAX_BODY_BYTES and response.length:
                    # The peer closed before the Content-Length it announced: truncated.
                    raise http.client.IncompleteRead(b"".join(chunks), response.length)
                self.result = (response.status, b"".join(chunks))
            finally:
                response.close()
        except BaseException as exc:  # noqa: BLE001 - handed to the waiting thread
            self.error = exc
        finally:
            connection.close()
            if connection.deadline_socket is not None:
                connection.deadline_socket.force_close()

    def abort(self) -> None:
        self.connection.aborted = True
        if self.connection.deadline_socket is not None:
            self.connection.deadline_socket.abort()


def http_post(
    url: str, headers: Mapping[str, str], body: bytes, timeout_s: float
) -> tuple[int, bytes]:
    """One POST under one absolute deadline: name lookup, connect, send, headers and body.

    The exchange runs in a worker thread, and every socket call in it is bounded by the
    deadline. The caller waits at most until the deadline; if the exchange is still running
    (for example in a name lookup, which no socket timeout covers), its socket is shut down,
    the worker cleans up by itself, and the caller gets ``TimeoutError``: an unknown outcome,
    repeated under the same operation ID.
    """
    deadline = time.monotonic() + timeout_s
    exchange = _Exchange(url, headers, body, deadline)
    worker = threading.Thread(target=exchange.run, name="cfo-launcher-http", daemon=True)
    worker.start()
    worker.join(max(deadline - time.monotonic(), 0.0))
    if worker.is_alive():
        exchange.abort()
        raise TimeoutError("the attempt's deadline passed")
    if exchange.error is not None:
        raise exchange.error
    assert exchange.result is not None
    return exchange.result


class LauncherClient:
    """Signs and sends launcher API requests for one settings value."""

    def __init__(
        self,
        settings: LauncherSettings,
        *,
        post: Post = http_post,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        backoff_s: tuple[float, float] | None = None,
    ) -> None:
        self._settings = settings
        self._post = post
        self._clock = clock
        self._monotonic = monotonic
        self._sleep = sleep
        self._first_backoff_s, self._max_backoff_s = backoff_s or (BACKOFF_S, MAX_BACKOFF_S)

    def call(self, request: Mapping[str, Any], policy: CallPolicy) -> Reply:
        """Send *request* until a readable answer arrives or the budget runs out.

        :raises PlatformGone: The platform answered ``gone``.
        :raises PlatformRefusal: A final refusal (``LAUNCHER_ERROR_CLASS``: readable).
        :raises OutcomeUnknown: No readable answer within the budget.
        """
        operation: protocol.Operation = request["operation"]
        operation_id = request["operationId"]
        computer = request.get("computerId", "-")
        body = protocol.encode_body(request)
        url = f"{self._settings.base_url}/{operation}"
        deadline = self._monotonic() + policy.budget_s
        backoff = self._first_backoff_s
        attempts = 0
        while True:
            attempts += 1
            timeout = min(policy.attempt_timeout_s, max(deadline - self._monotonic(), 0.5))
            sent_at = self._clock()
            headers = {
                "Content-Type": "application/json",
                "Connection": "close",
                **protocol.sign_request(
                    key=self._settings.signing_key,
                    key_id=self._settings.signing_key_id,
                    operation=operation,
                    timestamp=int(sent_at),
                    body=body,
                ),
            }
            try:
                status, payload = self._post(url, headers, body, timeout)
            except (OSError, http.client.HTTPException) as exc:
                reason = f"no reply ({type(exc).__name__})"
            else:
                reason = self._outcome(operation, operation_id, computer, status, payload)
                if not isinstance(reason, str):
                    logger.debug(
                        "launcher %s %s for %s: %s after %d attempt(s)",
                        operation,
                        operation_id,
                        computer,
                        status,
                        attempts,
                    )
                    return Reply(result=reason, sent_at=sent_at, attempts=attempts)
            logger.warning(
                "launcher %s %s for %s: %s (attempt %d)",
                operation,
                operation_id,
                computer,
                reason,
                attempts,
            )
            wait = min(backoff, max(deadline - self._monotonic(), 0.0))
            if self._monotonic() + wait >= deadline:
                raise OutcomeUnknown(
                    f"The platform gave no readable answer to {operation} "
                    f"({reason}); its outcome is unknown."
                )
            self._sleep(wait)
            backoff = min(backoff * 2, self._max_backoff_s)

    @staticmethod
    def _outcome(
        operation: protocol.Operation,
        operation_id: str,
        computer: str,
        status: int,
        payload: bytes,
    ) -> protocol.Result | str:
        """The parsed result, or why the outcome is still unknown; raises a final answer."""
        if len(payload) > protocol.MAX_BODY_BYTES:
            return f"HTTP {status}, reply too large"
        try:
            decoded: object = json.loads(payload)
        except ValueError:
            return f"HTTP {status}, not JSON"
        if status == 200:
            try:
                return protocol.parse_result(operation, decoded)
            except protocol.ProtocolError as exc:
                return f"HTTP 200, unreadable reply: {exc}"
        if not 400 <= status <= 599:
            return f"HTTP {status}"
        try:
            error = protocol.parse_error(decoded)
        except protocol.ProtocolError:
            return f"HTTP {status}, no error body"
        if error.error_class == "sandbox_gone":
            logger.info("launcher %s %s for %s: gone", operation, operation_id, computer)
            raise PlatformGone(protocol.readable(error.message))
        if error.error_class == "readable_refusal":
            logger.warning(
                "launcher %s %s for %s: refused (%s, HTTP %d)",
                operation,
                operation_id,
                computer,
                error.code,
                status,
            )
            raise PlatformRefusal(error.code, protocol.readable(error.message))
        return f"HTTP {status}, {error.code}"
