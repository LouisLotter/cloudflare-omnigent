"""Operation IDs and timestamps in the contract's forms (contracts/src/ids.ts)."""

from __future__ import annotations

import datetime
import secrets
import time

# Crockford base32, lowercase, as ULID-style generators produce it.
_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"


def _base32(value: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(out))


def new_ulid_body() -> str:
    """26 characters: 48 bits of milliseconds, then 80 random bits."""
    return _base32(int(time.time() * 1000), 10) + _base32(secrets.randbits(80), 16)


def new_operation_id() -> str:
    """``op_`` and 26 base32 characters (``OperationId``)."""
    return "op_" + new_ulid_body()


def iso_now() -> str:
    """A UTC instant as ``Date.prototype.toISOString`` writes it (``Timestamp``)."""
    return iso(time.time())


def iso(epoch_s: float) -> str:
    moment = datetime.datetime.fromtimestamp(epoch_s, tz=datetime.UTC)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")
