"""出题策略解析单测(design contract 核心)—— resolve_questions 的 4 策略 + 随机稳定性 + 边界。

纯函数,不依赖 app 装配。覆盖契约:
  - sequential / random_n / easy_to_hard / random_n_easy_to_hard 行为
  - seed 稳定性(同 seed 两次同结果 → 重拨问同一批题)
  - 空题库 → [];N≥题数取全部仍打乱;difficulty 越界归一/非整数兜底
  - per_question_check 无题 fail-fast(assert_resolvable)
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from app.session_service import (
    PerQuestionCheckRequiresQuestions,
    assert_resolvable,
    resolve_questions,
)


def _bank(n: int) -> dict:
    return {"question_bank_id": "qb1", "version": "v1",
            "questions": [{"text": f"Q{i}", "weight": 1.0, "difficulty": i % 5 + 1} for i in range(n)]}


def _agent(strategy: str, n: int | None = None) -> dict:
    a = {"agent_id": "a1", "question_strategy": strategy}
    if n is not None:
        a["strategy_n"] = n
    return a


# ── sequential:全部按原序 ──
def test_sequential_keeps_all_in_order():
    bank = _bank(5)
    out = resolve_questions(_agent("sequential"), bank, seed="s1")
    assert [q["text"] for q in out] == ["Q0", "Q1", "Q2", "Q3", "Q4"]


# ── 空/无题库 → [] ──
def test_no_bank_returns_empty():
    assert resolve_questions(_agent("sequential"), None, seed="s1") == []


def test_empty_bank_returns_empty():
    assert resolve_questions(_agent("random_n", 3), {"questions": []}, seed="s1") == []


# ── random_n:抽 N 题,seed 稳定 ──
def test_random_n_picks_n():
    out = resolve_questions(_agent("random_n", 3), _bank(10), seed="sess_abc")
    assert len(out) == 3
    # 都来自题库
    texts = {q["text"] for q in out}
    assert texts <= {f"Q{i}" for i in range(10)}


def test_random_n_stable_across_redial():
    """同一 session_id(seed)解析两次 → 完全相同(重拨问同一批题,design contract 铁律)。"""
    bank = _bank(20)
    a = _agent("random_n", 5)
    first = resolve_questions(a, bank, seed="sess_xyz")
    second = resolve_questions(a, bank, seed="sess_xyz")
    assert first == second
    assert len(first) == 5


def test_random_n_different_seed_likely_differs():
    """不同 seed 大概率抽到不同题(非严格,但 20 选 5 两次全同概率极低)。"""
    bank = _bank(20)
    a = _agent("random_n", 5)
    s1 = [q["text"] for q in resolve_questions(a, bank, seed="sessA")]
    s2 = [q["text"] for q in resolve_questions(a, bank, seed="sessB")]
    assert s1 != s2  # 不同种子 → 不同抽样/顺序


def test_random_n_ge_count_takes_all_shuffled():
    """N≥题数 → 取全部(不报错),仍打乱顺序。"""
    bank = _bank(8)
    out = resolve_questions(_agent("random_n", 50), bank, seed="sess1")
    assert len(out) == 8  # 全部
    assert {q["text"] for q in out} == {f"Q{i}" for i in range(8)}


# ── easy_to_hard:按 difficulty 升序,稳定 ──
def test_easy_to_hard_sorts_ascending():
    bank = {"questions": [
        {"text": "hard", "difficulty": 5},
        {"text": "easy", "difficulty": 1},
        {"text": "mid", "difficulty": 3},
    ]}
    out = resolve_questions(_agent("easy_to_hard"), bank, seed="s")
    assert [q["text"] for q in out] == ["easy", "mid", "hard"]


def test_easy_to_hard_stable_for_equal_difficulty():
    """等难度保持题库原序(稳定排序)。"""
    bank = {"questions": [
        {"text": "a", "difficulty": 2},
        {"text": "b", "difficulty": 2},
        {"text": "c", "difficulty": 1},
    ]}
    out = resolve_questions(_agent("easy_to_hard"), bank, seed="s")
    assert [q["text"] for q in out] == ["c", "a", "b"]  # c(1) 在前;a/b 同为 2 保持原序


def test_easy_to_hard_difficulty_missing_defaults_mid():
    """缺 difficulty 兜底中等 3:介于 1 和 5 之间。"""
    bank = {"questions": [
        {"text": "no_diff"},  # 缺失 → 3
        {"text": "d1", "difficulty": 1},
        {"text": "d5", "difficulty": 5},
    ]}
    out = resolve_questions(_agent("easy_to_hard"), bank, seed="s")
    assert [q["text"] for q in out] == ["d1", "no_diff", "d5"]


def test_easy_to_hard_difficulty_out_of_range_clamped():
    """越界整数归一([1,5]):0→1、99→5。"""
    bank = {"questions": [
        {"text": "huge", "difficulty": 99},   # → 5
        {"text": "tiny", "difficulty": 0},    # → 1
        {"text": "mid", "difficulty": 3},
    ]}
    out = resolve_questions(_agent("easy_to_hard"), bank, seed="s")
    assert [q["text"] for q in out] == ["tiny", "mid", "huge"]


def test_easy_to_hard_difficulty_non_integer_defaults_mid():
    """非整数(字符串/None / DDB 残留)兜底 3,不抛错。"""
    bank = {"questions": [
        {"text": "bad", "difficulty": "high"},  # 非整数 → 3
        {"text": "d1", "difficulty": 1},
        {"text": "decimal4", "difficulty": Decimal("4")},  # Decimal 整数 OK → 4
    ]}
    out = resolve_questions(_agent("easy_to_hard"), bank, seed="s")
    assert [q["text"] for q in out] == ["d1", "bad", "decimal4"]


# ── random_n_easy_to_hard:先抽 N 再按难度升序 ──
def test_random_n_easy_to_hard_picks_then_sorts():
    bank = {"questions": [
        {"text": f"Q{i}", "difficulty": (i * 7) % 5 + 1} for i in range(15)
    ]}
    out = resolve_questions(_agent("random_n_easy_to_hard", 6), bank, seed="sess_k")
    assert len(out) == 6
    diffs = [q["difficulty"] for q in out]
    assert diffs == sorted(diffs)  # 抽中的 6 题按 difficulty 升序


def test_random_n_easy_to_hard_stable():
    bank = {"questions": [{"text": f"Q{i}", "difficulty": (i % 5) + 1} for i in range(15)]}
    a = _agent("random_n_easy_to_hard", 6)
    assert resolve_questions(a, bank, seed="ssX") == resolve_questions(a, bank, seed="ssX")


# ── assert_resolvable:per_question_check 无题 fail-fast ──
def test_assert_resolvable_per_question_check_no_questions_raises():
    agent = {"rubric": {"mode": "per_question_check", "pass_threshold": 0.8}}
    with pytest.raises(PerQuestionCheckRequiresQuestions):
        assert_resolvable(agent, [])


def test_assert_resolvable_per_question_check_with_questions_ok():
    agent = {"rubric": {"mode": "per_question_check", "pass_threshold": 0.8}}
    assert_resolvable(agent, [{"text": "Q1"}])  # 不抛


def test_assert_resolvable_dimension_score_no_questions_ok():
    """dimension_score 无题合法(纯人设对话)。"""
    agent = {"rubric": {"mode": "dimension_score", "dimensions": [{"name": "x", "weight": 1, "max_score": 5}]}}
    assert_resolvable(agent, [])  # 不抛


def test_assert_resolvable_default_mode_no_questions_raises():
    """rubric 缺省 mode = per_question_check → 无题也拒。"""
    with pytest.raises(PerQuestionCheckRequiresQuestions):
        assert_resolvable({}, [])
