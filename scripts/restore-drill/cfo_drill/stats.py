"""Latency summaries: nearest-rank percentiles, as the barrier timeouts are set from them."""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence


def percentile(values: Sequence[float], p: float) -> float | None:
    """The nearest-rank ``p``-th percentile (0 < p <= 100), or ``None`` for no values.

    Nearest rank never interpolates: the answer is always an observed value, so a p99 of 100
    samples is the 99th smallest, and a p99 of fewer than 100 samples is the maximum.
    """
    if not 0 < p <= 100:
        raise ValueError("p must be in (0, 100]")
    if not values:
        return None
    ordered = sorted(values)
    rank = math.ceil(p / 100 * len(ordered))
    return ordered[max(rank, 1) - 1]


def summary(values: Iterable[float], *, digits: int = 1) -> dict[str, float | int | None]:
    """Count, min, p50, p95, p99, max and mean of ``values``, rounded to ``digits``."""
    data = [float(v) for v in values]

    def r(value: float | None) -> float | None:
        return None if value is None else round(value, digits)

    return {
        "n": len(data),
        "min": r(min(data)) if data else None,
        "p50": r(percentile(data, 50)),
        "p95": r(percentile(data, 95)),
        "p99": r(percentile(data, 99)),
        "max": r(max(data)) if data else None,
        "mean": r(sum(data) / len(data)) if data else None,
    }
