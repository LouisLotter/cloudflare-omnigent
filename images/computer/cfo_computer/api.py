"""The supervisor's side of the computer API: messages to its WorkspaceDO.

``POST http://computer.internal/v1/messages`` (intercepted; the props name the computer and
its generation). Every message carries an operation ID and is repeated unchanged, with the same
ID, after "Network connection lost." or any unanswered request (S3, WP2.2); nothing is repeated
once answered. A refusal is an ``ErrorBody``: ``unavailable`` (or a server error) is retried,
anything else is final.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from .backoff import capped_backoff
from .contract import MAX_BODY_BYTES, Contract, ContractError

REQUEST_TIMEOUT_S = 15.0


class Refused(Exception):
    """WorkspaceDO refused the message with a final error code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


class Unanswered(Exception):
    """No usable answer: the message may or may not have been applied; repeat it."""


class ComputerApi:
    def __init__(self, url: str, contract: Contract, *, timeout: float = REQUEST_TIMEOUT_S) -> None:
        self.url = url
        self.contract = contract
        self.timeout = timeout
        # No proxy, whatever the environment says: the intercept is the only route.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def send_once(self, message: dict[str, Any]) -> dict[str, Any]:
        """One attempt. Returns the parsed reply; raises Refused or Unanswered."""
        self.contract.check_outbound("SupervisorMessage", message)
        body = json.dumps(message, separators=(",", ":")).encode()
        request = urllib.request.Request(
            self.url, data=body, method="POST", headers={"content-type": "application/json"}
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_BODY_BYTES + 1)
                status = response.status
        except urllib.error.HTTPError as exc:
            raw = exc.read(MAX_BODY_BYTES + 1)
            status = exc.code
        except (OSError, ValueError) as exc:
            raise Unanswered(type(exc).__name__) from exc
        if len(raw) > MAX_BODY_BYTES:
            raise Unanswered("reply too large")
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise Unanswered("reply is not JSON") from exc
        if 200 <= status < 300:
            try:
                reply = self.contract.parse_supervisor_reply(data)
            except ContractError as exc:
                raise Unanswered("reply does not parse") from exc
            if reply["type"] != message["type"]:
                raise Unanswered("reply for another message type")
            return reply
        try:
            error = self.contract.parse_error_body(data)["error"]
        except ContractError as exc:
            raise Unanswered(f"HTTP {status}") from exc
        if error["retryable"] or error["code"] in ("unavailable", "internal") or status >= 500:
            raise Unanswered(error["code"])
        raise Refused(error["code"], error["message"])

    def send(
        self,
        message: dict[str, Any],
        *,
        attempts: int | None = None,
        stop: Callable[[], bool] = lambda: False,
        backoff: Callable[[int], float] = lambda n: capped_backoff(n + 1, 0.5, 30.0),
        sleep: Callable[[float], None] = time.sleep,
    ) -> dict[str, Any]:
        """Repeat ``message`` unchanged until it is answered (or ``attempts`` run out)."""
        n = 0
        while True:
            try:
                return self.send_once(message)
            except Unanswered:
                n += 1
                if (attempts is not None and n >= attempts) or stop():
                    raise
                sleep(backoff(n))
