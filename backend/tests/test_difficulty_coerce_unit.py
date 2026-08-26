"""_coerce_difficulty 契约单测(design contract 核心归一函数 + CSV 上传暴露的 Decimal 路径)。

difficulty 契约:整数 [1,5],缺省/非整数语义 → 3。CSV 上传后 GET 暴露:DDB 读回的整数是 Decimal,
若不认它,题库经 response_model 二次校验时 difficulty 全被打回 3(真 bug)。故整数 Decimal 视作合法整数;
非整 Decimal / float / str / bool 仍兜底 3(非回归)。
"""
from __future__ import annotations

from decimal import Decimal

from app.models import Question


def _d(v) -> int:
    return Question(text="x", difficulty=v).difficulty


def test_real_int_in_range():
    assert _d(1) == 1
    assert _d(3) == 3
    assert _d(5) == 5


def test_real_int_out_of_range_clamped():
    assert _d(0) == 1
    assert _d(-9) == 1
    assert _d(9) == 5
    assert _d(99) == 5


def test_decimal_integer_from_ddb_is_valid():
    # DDB 读回的整数是 Decimal('3') —— 必须当合法整数,否则 GET 题库 difficulty 全打回 3
    assert _d(Decimal("1")) == 1
    assert _d(Decimal("3")) == 3
    assert _d(Decimal("5")) == 5
    assert _d(Decimal("3.0")) == 3  # 带 .0 仍是整数值
    # 越界整数 Decimal 照常钳
    assert _d(Decimal("9")) == 5
    assert _d(Decimal("0")) == 1


def test_decimal_non_integer_fallback_3():
    assert _d(Decimal("2.5")) == 3
    assert _d(Decimal("4.9")) == 3


def test_non_int_types_fallback_3():
    # 非回归:float / str / bool / None 仍兜底 3(design contract「只认真整数语义」)
    assert _d(3.0) == 3
    assert _d(4.7) == 3
    assert _d("4") == 3
    assert _d("高") == 3
    assert _d(True) == 3  # bool 是 int 子类,显式排除
    assert _d(False) == 3
    assert _d(None) == 3


def test_default_when_omitted():
    assert Question(text="x").difficulty == 3
