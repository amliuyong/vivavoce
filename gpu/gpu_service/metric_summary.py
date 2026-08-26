"""Shared percentile summaries for runtime metrics and benchmark reports."""

from __future__ import annotations

from collections.abc import Iterable, Sequence


def percentile(sorted_values: Sequence[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    position = (len(sorted_values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def distribution(values: Iterable[float]) -> dict[str, float | int]:
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "p50": round(percentile(ordered, 0.50), 3),
        "p95": round(percentile(ordered, 0.95), 3),
        "p99": round(percentile(ordered, 0.99), 3),
        "max": round(ordered[-1], 3) if ordered else 0.0,
    }
