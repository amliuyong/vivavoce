"""DB 工具单元测试 —— float→Decimal 转换 + 非有限值拒绝。"""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.db import _to_ddb


def test_float_to_decimal_no_binary_drift():
    out = _to_ddb({"temperature": 0.4, "weight": 1.0})
    assert out["temperature"] == Decimal("0.4")
    assert out["weight"] == Decimal("1.0")


def test_nested_structures_converted():
    out = _to_ddb({"engine": {"temperature": 0.7}, "list": [0.1, 0.2]})
    assert out["engine"]["temperature"] == Decimal("0.7")
    assert out["list"] == [Decimal("0.1"), Decimal("0.2")]


def test_non_float_untouched():
    out = _to_ddb({"name": "x", "n": 5, "ok": True, "none": None})
    assert out == {"name": "x", "n": 5, "ok": True, "none": None}


@pytest.mark.parametrize("bad", [float("inf"), float("-inf"), float("nan")])
def test_non_finite_float_rejected(bad):
    with pytest.raises(ValueError):
        _to_ddb({"temperature": bad})
