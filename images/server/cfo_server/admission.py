"""Who Cloudflare Access admits, told to the platform after every membership change (WP8.3).

Omnigent's ``omnigent.server.team_admission`` calls :meth:`PlatformAdmission.apply` with the
team's admission snapshot (active members' verified addresses and pending invitations, and which
of them are the current active owners) after it commits a change, at the next invitation expiry
and hourly, at an unchanged revision too, so the platform can repair drift. This sends it to the
platform Worker's private route,
``POST http://platform.internal/access/v1/admission`` (``contracts/src/team.ts``), which only
this container's intercept reaches. The body is compact JSON with sorted keys; it is signed with
the launcher's key (``CFO_LAUNCHER_SIGNING_KEY`` and its ID) under the admission call's own
protocol line, so no launcher signature is valid there and no admission signature is valid on
the launcher API.

``applied`` and ``stale`` answers are success; anything else raises, and Omnigent retries with
backoff. Addresses are never logged.
"""

from __future__ import annotations

import contextlib
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

from cfo_server.events import log

PROTOCOL = "cfo-access-admission/v1"
URL = "http://platform.internal/access/v1/admission"
TIMEOUT_S = 15.0
KEY_ENV = "CFO_LAUNCHER_SIGNING_KEY"
KEY_ID_ENV = "CFO_LAUNCHER_SIGNING_KEY_ID"
MIN_KEY_BYTES = 32


class AdmissionNotApplied(RuntimeError):
    """The platform did not confirm the admission list; Omnigent retries."""


def string_to_sign(key_id: str, timestamp: str, body: bytes) -> str:
    """The four lines the signature covers (``admissionStringToSign`` in team.ts)."""
    return "\n".join((PROTOCOL, key_id, timestamp, hashlib.sha256(body).hexdigest()))


def encode_body(revision: int, emails: list[str], owners: list[str]) -> bytes:
    """The exact bytes sent and signed."""
    return json.dumps(
        {"emails": emails, "owners": owners, "revision": revision},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


Post = Callable[[str, bytes, Mapping[str, str]], tuple[int, bytes]]


def _post(url: str, body: bytes, headers: Mapping[str, str]) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
    # platform.internal is reached directly, never through a proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=TIMEOUT_S) as response:
            return response.status, response.read(65536)
    except urllib.error.HTTPError as error:
        return error.code, error.read(65536)


class PlatformAdmission:
    """Omnigent's ``MembershipAdmission`` for the platform's member group.

    :param key: The launcher's signing key, its UTF-8 bytes.
    :param key_id: The launcher's signing key ID.
    """

    def __init__(
        self,
        *,
        key: bytes,
        key_id: str,
        url: str = URL,
        post: Post = _post,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if len(key) < MIN_KEY_BYTES:
            raise ValueError("the launcher's signing key has at least 32 bytes")
        self._key = key
        self._key_id = key_id
        self._url = url
        self._post = post
        self._clock = clock

    def apply(self, snapshot: Any) -> None:
        """Send the snapshot; return once the platform answered ``applied`` or ``stale``."""
        # A snapshot without owners (an Omnigent before them) is sent with none; the platform
        # refuses it (`owner_missing`) and writes nothing.
        owners = list(getattr(snapshot, "owners", ()))
        body = encode_body(int(snapshot.revision), list(snapshot.emails), owners)
        timestamp = str(int(self._clock()))
        signature = hmac.new(
            self._key, string_to_sign(self._key_id, timestamp, body).encode("ascii"), hashlib.sha256
        ).hexdigest()
        headers = {
            "content-type": "application/json",
            "X-Omnigent-Signing-Key-Id": self._key_id,
            "X-Omnigent-Timestamp": timestamp,
            "X-Omnigent-Signature": signature,
        }
        status, answer = self._post(self._url, body, headers)
        outcome = None
        with contextlib.suppress(UnicodeDecodeError, ValueError, AttributeError):
            outcome = json.loads(answer.decode("utf-8")).get("outcome")
        log("access_admission.answer", status=status, outcome=outcome, revision=snapshot.revision)
        if status == 200 and outcome in ("applied", "stale"):
            return
        raise AdmissionNotApplied(f"the platform answered {status} ({outcome})")


def from_env(env: Mapping[str, str]) -> PlatformAdmission | None:
    """The adapter, or ``None`` when the launcher's key is not set."""
    key, key_id = env.get(KEY_ENV), env.get(KEY_ID_ENV)
    if not key or not key_id:
        return None
    return PlatformAdmission(key=key.encode("utf-8"), key_id=key_id)
