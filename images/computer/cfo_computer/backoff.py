"""Retry delays."""

from __future__ import annotations


def capped_backoff(failures: int, first_s: float, max_s: float) -> float:
    """``first_s`` doubling per failure (the first failure waits ``first_s``), up to ``max_s``.

    The exponent is capped before it is used, so no failure count, however long an outage
    lasts, can overflow it (Codex r1, finding 11: ``2 ** 1025`` ended three retry loops).
    """
    return min(max_s, first_s * 2.0 ** min(max(0, failures - 1), 30))
