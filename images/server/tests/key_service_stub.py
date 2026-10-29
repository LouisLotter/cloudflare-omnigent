"""A loopback stand-in for the platform Worker's key service, for the image's in-process tests.

Not a test module, and not the authority on the protocol: the Worker's own module
(``worker/src/internal/key-service.ts``) is tested against the fork's vectors in workerd, and the
end-to-end test (``tests/integration/github_linking``) runs Omnigent against that Worker. This
stub implements the same protocol (designs/CREDENTIAL_STORE.md in the fork, "HTTP key service")
just far enough to let the image's own wiring be tested: it checks signatures and the clock,
and seals records with the suggested construction, so stored records are real ciphertext.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

BASE_PATH = "/key-service/v1"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class KeyServiceStub:
    """One signing key, one record key; every request served is counted by operation."""

    def __init__(self, signing_key: str, signing_key_id: str) -> None:
        self.signing_key = signing_key.encode("utf-8")
        self.signing_key_id = signing_key_id
        self.record_key_id = "cfo-test-records"
        self.root = os.urandom(32)
        self.served: list[tuple[str, int]] = []
        #: When set, every request is answered with this status (a store-wide fault).
        self.fail_with: int | None = None

    def _key(self, context: dict[str, str]) -> bytes:
        info = json.dumps(
            {
                "context": context,
                "key_id": self.record_key_id,
                "key_version": 1,
                "purpose": "omnigent-credential-record",
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(self.root)

    def respond(self, operation: str, headers: dict[str, str], body: bytes) -> tuple[int, Any]:
        if self.fail_with is not None:
            return self.fail_with, {"error": {"code": "unavailable", "message": "down"}}
        key_id = headers.get("x-omnigent-signing-key-id", "")
        timestamp = headers.get("x-omnigent-timestamp", "")
        signature = headers.get("x-omnigent-signature", "")
        message = "\n".join(
            (
                "omnigent-key-service-v1",
                operation,
                key_id,
                timestamp,
                hashlib.sha256(body).hexdigest(),
            )
        )
        expected = hmac.new(self.signing_key, message.encode(), hashlib.sha256).hexdigest()
        if key_id != self.signing_key_id or not hmac.compare_digest(expected, signature):
            return 401, {"error": {"code": "unauthenticated", "message": "unsigned"}}
        if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > 300:
            return 401, {"error": {"code": "stale_request", "message": "stale"}}
        request = json.loads(body)
        context = request["context"]
        if operation == "encrypt":
            iv = os.urandom(12)
            sealed = AESGCM(self._key(context)).encrypt(iv, request["plaintext"].encode(), None)
            return 200, {
                "key_id": self.record_key_id,
                "key_version": 1,
                "ciphertext": _b64(iv + sealed),
            }
        if request.get("key_id") != self.record_key_id or request.get("key_version") != 1:
            return 409, {"error": {"code": "key_unavailable", "message": "not held"}}
        raw = _unb64(request["ciphertext"])
        try:
            plaintext = AESGCM(self._key(context)).decrypt(raw[:12], raw[12:], None).decode()
        except (InvalidTag, ValueError):
            return 422, {"error": {"code": "unusable", "message": "does not open"}}
        return 200, {"plaintext": plaintext}

    @contextmanager
    def serve(self) -> Iterator[str]:
        """Serve on loopback; yields the base URL."""
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                operation = self.path.removeprefix(f"{BASE_PATH}/")
                status, payload = stub.respond(
                    operation, {k.lower(): v for k, v in self.headers.items()}, body
                )
                stub.served.append((operation, status))
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_address[1]}{BASE_PATH}"
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
