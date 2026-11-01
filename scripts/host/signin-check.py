"""Whether this machine's Omnigent command line is signed in to the installation (WP3.43).

Run by scripts/host/omnigent-host.sh with the pinned build's own Python, isolated (``-I``), and
the build's ``OMNIGENT_DATA_DIR``: ``python -I signin-check.py https://<host>``. Prints one word:

- ``ok``: the installation accepts the stored sign-in;
- ``absent``, ``expired`` or ``rejected``: sign in again (``omnigent-cfo login``);
- ``unknown <why>``: the installation, or its token endpoint, did not answer; do not guess.

It asks the installation (``GET /v1/me`` with the stored bearer), because a password change
revokes a token that still looks valid locally. A failed renewal is told apart through
Omnigent's own log record of it: a refusal (HTTP 4xx) means the grant is gone; a transport error
or a server error is ``unknown``. The token never leaves this process and is never printed.
"""

from __future__ import annotations

import logging
import re
import sys

import httpx

from omnigent import cli_auth

# Answers to a renewal that say the grant itself is refused, not that the server is unwell.
_RETRYABLE = {404, 408, 425, 429}


class _Records(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.DEBUG)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


def _renew(url: str, records: _Records) -> str:
    """A fresh access token, or ``rejected`` / ``unknown ...`` for why there is none."""
    records.messages.clear()
    token = cli_auth.refresh_stored_token(url)
    if token:
        return token
    if not records.messages:
        # Nothing to renew with (no refresh grant stored): sign in again.
        return "rejected"
    for message in records.messages:
        refused = re.search(r"refused \(HTTP (\d{3})\)", message)
        if refused and 400 <= int(refused.group(1)) < 500 and int(refused.group(1)) not in _RETRYABLE:
            return "rejected"
    return "unknown renewal"


def _answer(url: str, token: str) -> int:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    return httpx.get(f"{url}/v1/me", headers=headers, timeout=20).status_code


def check(url: str) -> str:
    records = _Records()
    logger = logging.getLogger(cli_auth.__name__)
    logger.addHandler(records)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    if cli_auth.stored_token_status(url) == "absent":
        return "absent"
    # Any token not yet expired is good enough to ask with.
    token = cli_auth.load_token(url)
    if token is None:
        token = _renew(url, records)
        if token == "rejected":
            return "expired"
        if token.startswith("unknown"):
            return token
    try:
        status = _answer(url, token)
        if status == 401:
            # Revoked, for instance by a password change; the refresh grant may still be good.
            token = _renew(url, records)
            if token.startswith("unknown"):
                return token
            status = 401 if token == "rejected" else _answer(url, token)
    except httpx.HTTPError as error:
        return f"unknown {type(error).__name__}"
    if status == 200:
        return "ok"
    return "rejected" if status == 401 else f"unknown {status}"


if __name__ == "__main__":
    print(check(sys.argv[1]))
