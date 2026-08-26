"""Evaluator Lambda 单测 —— 真打 moto DDB + 注入 fake Bedrock(不真调模型)。

覆盖 design contract:
  - Streams 事件过滤(只 SK=meta 且 status=completed 触发);
  - 两种 rubric 形态统一打分(per_question_check 通过线 / dimension_score 加权);
  - 拉转写 + rubric → 结构化打分 → 写 Results;
  - 仅处理本系统会话(无 agent_id 跳过);
  - 幂等:已人工复核的 Results 不被覆盖。

evaluator handler 在 infrastructure/lambda/evaluator/,经 sys.path 注入导入。
"""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

_EVAL_DIR = Path(__file__).resolve().parents[2] / "infrastructure" / "lambda" / "evaluator"

REGION = "us-east-1"
EVENTS_TABLE = "aim-session-events"
RESULTS_TABLE = "aim-results"


@pytest.fixture
def handler_mod(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    monkeypatch.setenv("AWS_REGION", REGION)
    monkeypatch.setenv("SESSION_EVENTS_TABLE_NAME", EVENTS_TABLE)
    monkeypatch.setenv("RESULTS_TABLE_NAME", RESULTS_TABLE)
    monkeypatch.setenv("AIM_EVALUATOR_MODEL_ID", "us.anthropic.claude-sonnet-4-6")
    sys.path.insert(0, str(_EVAL_DIR))
    mod = importlib.import_module("handler")
    mod = importlib.reload(mod)
    # 模块级常量从 env 读,reload 后已更新
    mod.SESSION_EVENTS_TABLE_NAME = EVENTS_TABLE
    mod.RESULTS_TABLE_NAME = RESULTS_TABLE
    yield mod
    sys.path.remove(str(_EVAL_DIR))


class FakeBedrock:
    """模拟 Bedrock invoke_model:返回固定 tool_use 结构。记录最后一次请求供断言。"""

    def __init__(self, tool_input: dict):
        self._tool_input = tool_input
        self.last_body = None

    def invoke_model(self, *, modelId, contentType, accept, body):  # noqa: N803
        self.last_body = json.loads(body)
        payload = {
            "content": [
                {"type": "tool_use", "name": "submit_evaluation", "input": self._tool_input}
            ]
        }

        class _Body:
            def __init__(self, data):
                self._data = json.dumps(data).encode()

            def read(self):
                return self._data

        return {"body": _Body(payload)}


def _create_tables(ddb):
    ddb.create_table(
        TableName=EVENTS_TABLE,
        KeySchema=[
            {"AttributeName": "session_id", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "session_id", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName=RESULTS_TABLE,
        KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


def _to_decimal(value):
    """float → Decimal(DynamoDB 不接受 float),与生产 handler._to_ddb 同语义,供测试 seed。"""
    from decimal import Decimal

    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_decimal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_decimal(v) for v in value]
    return value


def _seed_session(ddb, session_id, meta, transcript):
    t = ddb.Table(EVENTS_TABLE)
    t.put_item(Item=_to_decimal({"session_id": session_id, "sk": "meta", **meta}))
    for i, (sp, txt) in enumerate(transcript):
        t.put_item(Item={"session_id": session_id, "sk": f"event#{i:04d}", "speaker": sp, "text": txt})


# ── Streams 事件过滤 ──
def test_filter_only_completed_meta(handler_mod):
    h = handler_mod
    # 非 meta SK → 不触发
    assert h._is_completed_meta({
        "eventName": "MODIFY",
        "dynamodb": {"Keys": {"session_id": {"S": "s1"}, "sk": {"S": "event#0001"}},
                     "NewImage": {"sk": {"S": "event#0001"}, "status": {"S": "completed"}}},
    }) is None
    # meta 但非 completed → 不触发
    assert h._is_completed_meta({
        "eventName": "MODIFY",
        "dynamodb": {"Keys": {"session_id": {"S": "s1"}, "sk": {"S": "meta"}},
                     "NewImage": {"sk": {"S": "meta"}, "status": {"S": "in_progress"}}},
    }) is None
    # meta + completed → 返回 session_id
    assert h._is_completed_meta({
        "eventName": "MODIFY",
        "dynamodb": {"Keys": {"session_id": {"S": "s1"}, "sk": {"S": "meta"}},
                     "NewImage": {"sk": {"S": "meta"}, "status": {"S": "completed"}}},
    }) == "s1"
    # REMOVE 事件 → 不触发
    assert h._is_completed_meta({
        "eventName": "REMOVE",
        "dynamodb": {"Keys": {"session_id": {"S": "s1"}, "sk": {"S": "meta"}}},
    }) is None


# ── per_question_check 打分 + 通过线 ──
def test_score_per_question_check_pass(handler_mod):
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_pqc",
            "agent_id": "prof_1",
            "agent_version": "v1",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [
                {"text": "Q1", "weight": 1},
                {"text": "Q2", "weight": 1},
            ],
        }
        _seed_session(ddb, "s_pqc", meta, [("ai", "问 Q1"), ("user", "答1"), ("ai", "问 Q2"), ("user", "答2")])

        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Q1", "passed": True, "evidence": "答对"},
                {"index": 2, "question": "Q2", "passed": False, "evidence": "答错"},
            ],
            "summary": "一对一错",
            "excerpts": [{"text": "答1", "audio_offset_s": 1.2}],
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_pqc")
        assert result["rubric_mode"] == "per_question_check"
        assert result["pass_ratio"] == 0.5
        assert result["passed"] is True  # 0.5 >= 0.5 通过线
        # 写进 Results
        stored = ddb.Table(RESULTS_TABLE).get_item(Key={"session_id": "s_pqc"}).get("Item")
        assert stored["passed"] is True
        assert stored["review_status"] == "pending"
        # tool_choice 强约束 + 工具定义传入
        assert fake.last_body["tool_choice"]["name"] == "submit_evaluation"


def test_question_checks_backfill_question_text(handler_mod):
    """LLM 只回 index+passed(省略 question 题面)→ evaluator 按 index 从 meta.questions 回填题面
    (真机根因 deployment validation:否则报告侧 ResultOut.question 缺失会 500)。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_bf", "agent_id": "p", "agent_version": "v1",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [{"text": "你叫什么名字?", "weight": 1}, {"text": "做个自我介绍", "weight": 1}],
        }
        _seed_session(ddb, "s_bf", meta, [("ai", "问"), ("user", "答")])
        fake = FakeBedrock({
            # LLM 省略了 question 字段
            "question_checks": [{"index": 1, "passed": True}, {"index": 2, "passed": False}],
            "summary": "一对一错",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_bf")
        checks = {c["index"]: c for c in result["question_checks"]}
        assert checks[1]["question"] == "你叫什么名字?"  # 回填
        assert checks[2]["question"] == "做个自我介绍"
        assert checks[1]["passed"] is True


def test_build_prompt_includes_asr_awareness(handler_mod):
    """design contract 洞见 a:两种 rubric 形态的 system prompt 都 MUST 含转写感知说明
    (「按口语意图非拼写判」),降低 ASR 同音字误判。仅改 prompt 文本,不动数据结构。"""
    ev = handler_mod.Evaluator(bedrock=object(), ddb=object(), model_id="m")
    # per_question_check
    meta_pqc = {
        "session_id": "s", "agent_id": "p",
        "rubric": {"mode": "per_question_check", "pass_threshold": 0.8},
        "questions": [{"text": "Q1", "weight": 1}],
    }
    sys_pqc, _ = ev.build_prompt(meta_pqc, [("ai", "问"), ("user", "答")] and [
        {"speaker": "ai", "text": "问"}, {"speaker": "user", "text": "答"}])
    assert "口语意图" in sys_pqc and "语音识别" in sys_pqc
    # dimension_score
    meta_dim = {
        "session_id": "s", "agent_id": "p",
        "rubric": {"mode": "dimension_score", "dimensions": [{"name": "流利度", "max_score": 5, "weight": 1}]},
        "questions": [],
    }
    sys_dim, _ = ev.build_prompt(meta_dim, [{"speaker": "user", "text": "答"}])
    assert "口语意图" in sys_dim


def test_score_per_question_check_fail_below_threshold(handler_mod):
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_fail", "agent_id": "p", "rubric": {"mode": "per_question_check", "pass_threshold": 0.8},
            "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1}],
        }
        _seed_session(ddb, "s_fail", meta, [("user", "x")])
        fake = FakeBedrock({
            "question_checks": [{"index": 1, "question": "Q1", "passed": True},
                                {"index": 2, "question": "Q2", "passed": False}],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_fail")
        assert result["pass_ratio"] == 0.5
        assert result["passed"] is False  # 0.5 < 0.8


# ── design contract:归因标注「疑似系统漏问」vs「考生答错」(只标注 + review_status,MUST NOT 改 pass_ratio)──
def test_r2_skip_suspected_flags_unvoiced_failed_question(handler_mod):
    """passed=false 的题,若 AI 转写里从没独立念出该题(揉合/吞题)→ 标 skip_suspected + review_status=needs_review。
    pass_ratio/passed MUST 不变(不擅自改分,防启发式误判把真未作答误转通过,评审 F6)。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_skip", "agent_id": "p",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [
                {"text": "Amazon Quick Sight 这个功能是做什么的", "weight": 1},
                {"text": "什么是 Space 空间它的作用是什么", "weight": 1},
            ],
        }
        # 转写:AI 念了第1题(含 Quick Sight),第2题(Space)从没独立念出 → 考生也没答。
        _seed_session(ddb, "s_skip", meta, [
            ("ai", "好,Amazon Quick Sight 这个功能是做什么的?"),
            ("user", "提供数据可视化和商业智能"),
            ("ai", "好的,我们来看下一题。"),  # 揉合/跳过,没念 Space
        ])
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Amazon Quick Sight 这个功能是做什么的", "passed": True, "evidence": "答对"},
                {"index": 2, "question": "什么是 Space 空间它的作用是什么", "passed": False, "evidence": "未作答"},
            ],
            "summary": "第2题未作答",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_skip")
        checks = {c["index"]: c for c in result["question_checks"]}
        assert checks[2].get("skip_suspected") is True  # 第2题:AI 没念出 → 疑似系统漏问
        assert checks[1].get("skip_suspected") is not True  # 第1题:AI 念了 → 不标
        assert result["review_status"] == "needs_review"  # 有疑似漏问 → 提示人工复核
        # ★ pass_ratio / passed MUST 不变(1/2=0.5,>=0.5 通过)——不擅自改分
        assert result["pass_ratio"] == 0.5
        assert result["passed"] is True


def test_r2_genuine_wrong_answer_not_flagged(handler_mod):
    """passed=false 但 AI 确实念出了该题(考生真答错/没答上)→ 不标 skip_suspected、review_status 保持 pending。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_wrong", "agent_id": "p",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [
                {"text": "Amazon Quick Sight 这个功能是做什么的", "weight": 1},
                {"text": "什么是 Space 空间它的作用是什么", "weight": 1},
            ],
        }
        # 两题 AI 都念出了;考生第2题答错。
        _seed_session(ddb, "s_wrong", meta, [
            ("ai", "Amazon Quick Sight 这个功能是做什么的?"),
            ("user", "数据可视化"),
            ("ai", "什么是 Space 空间它的作用是什么?"),
            ("user", "我不知道"),
        ])
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Amazon Quick Sight 这个功能是做什么的", "passed": True},
                {"index": 2, "question": "什么是 Space 空间它的作用是什么", "passed": False, "evidence": "答不知道"},
            ],
            "summary": "第2题答错",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_wrong")
        checks = {c["index"]: c for c in result["question_checks"]}
        assert checks[2].get("skip_suspected") is not True  # AI 念了、考生真答错 → 不标漏问
        assert result["review_status"] == "pending"  # 无疑似漏问 → 正常 pending


def test_score_per_question_check_weighted_by_index(handler_mod):
    """L2:权重按题号 index 匹配 —— 高权重题答对应主导通过比例,与 LLM 文本措辞无关。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_wt", "agent_id": "p",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.6},
            "questions": [{"text": "Q1", "weight": 3}, {"text": "Q2", "weight": 1}],  # 总权重 4
        }
        _seed_session(ddb, "s_wt", meta, [("user", "x")])
        # LLM 把题文改写了(措辞不同),但 index 对得上:Q1(权重3)对、Q2(权重1)错
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "第一题(改写措辞)", "passed": True},
                {"index": 2, "question": "第二题(改写措辞)", "passed": False},
            ],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_wt")
        assert result["pass_ratio"] == 0.75  # 3/4(按 index 匹配权重,非文本)
        assert result["passed"] is True  # 0.75 >= 0.6


# ── dimension_score 打分 ──
def test_score_dimension(handler_mod):
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_dim", "agent_id": "p",
            "rubric": {"mode": "dimension_score", "dimensions": [
                {"name": "沟通", "max_score": 5, "weight": 1},
                {"name": "专业", "max_score": 5, "weight": 1},
            ]},
            "questions": [],
        }
        _seed_session(ddb, "s_dim", meta, [("user", "聊了很多")])
        fake = FakeBedrock({
            "dimension_scores": [
                {"name": "沟通", "score": 4, "max_score": 5},
                {"name": "专业", "score": 3, "max_score": 5},
            ],
            "summary": "整体不错",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_dim")
        assert result["rubric_mode"] == "dimension_score"
        # 等权:Σ(w·score/max)/Σw = (1·0.8 + 1·0.6)/2 = 0.7
        assert result["overall_score"] == 0.7


def test_score_dimension_respects_weights(handler_mod):
    """M1:维度加权聚合 —— 高权重维度的分数主导综合分(非等权平均)。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_dimw", "agent_id": "p",
            "rubric": {"mode": "dimension_score", "dimensions": [
                {"name": "专业", "max_score": 5, "weight": 3},  # 高权重
                {"name": "沟通", "max_score": 5, "weight": 1},
            ]},
            "questions": [],
        }
        _seed_session(ddb, "s_dimw", meta, [("user", "x")])
        fake = FakeBedrock({
            "dimension_scores": [
                {"name": "专业", "score": 5, "max_score": 5},  # 满分,权重 3
                {"name": "沟通", "score": 1, "max_score": 5},  # 低分,权重 1
            ],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_dimw")
        # 加权:(3·1.0 + 1·0.2)/(3+1) = 3.2/4 = 0.8;等权会是 (1.0+0.2)/2=0.6
        assert result["overall_score"] == 0.8


def test_score_per_question_dedup_and_clamp(handler_mod):
    """review 加固:LLM 重复返回同一 index 不重复计分,且 pass_ratio 钳到 ≤1。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_dup", "agent_id": "p",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1}],
        }
        _seed_session(ddb, "s_dup", meta, [("user", "x")])
        # LLM 把 index=1 返回了两次(都 passed)+ index=2 漏返 → 不应让 ratio 超 1 或重复计 Q1
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Q1", "passed": True},
                {"index": 1, "question": "Q1(重复)", "passed": True},
            ],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_dup")
        assert result["pass_ratio"] == 0.5  # 只算一次 Q1(权重1)/ 总权重2,不是 1.0


def test_score_dimension_missing_dim_counts_as_zero(handler_mod):
    """review 漏返某维度 → 该维度按 0 计入分母,不虚高综合分。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_miss", "agent_id": "p",
            "rubric": {"mode": "dimension_score", "dimensions": [
                {"name": "专业", "max_score": 5, "weight": 1},
                {"name": "沟通", "max_score": 5, "weight": 1},
            ]},
            "questions": [],
        }
        _seed_session(ddb, "s_miss", meta, [("user", "x")])
        # LLM 只返回「专业」满分,漏了「沟通」
        fake = FakeBedrock({
            "dimension_scores": [{"name": "专业", "score": 5, "max_score": 5}],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_miss")
        # (1·1.0 + 1·0)/(1+1) = 0.5 —— 缺失维度按 0 计入分母,而非只算返回的 1 个维度(否则会是 1.0)
        assert result["overall_score"] == 0.5


# ── design contract:逐题评测报告 ──
def test_score_dimension_includes_question_analyses(handler_mod):
    """design contract:dimension_score 模式并列产出逐题分析(题目/回答/点评/得分),与维度分独立。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_qa", "agent_id": "p",
            "rubric": {"mode": "dimension_score", "dimensions": [{"name": "专业", "max_score": 5, "weight": 1}]},
            "questions": [{"text": "25+37=?", "weight": 1}, {"text": "84-46=?", "weight": 1}],
        }
        _seed_session(ddb, "s_qa", meta, [("user", "62")])
        fake = FakeBedrock({
            "dimension_scores": [{"name": "专业", "score": 4, "max_score": 5}],
            "question_analyses": [
                {"index": 1, "question": "25+37=?", "user_answer": "62", "comment": "正确", "score": 5, "max_score": 5},
                {"index": 2, "user_answer": "38", "comment": "正确", "score": 5, "max_score": 5},  # 缺 question → 回填
            ],
            "summary": "整体不错",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_qa")
        qa = result["question_analyses"]
        assert len(qa) == 2
        assert qa[0]["user_answer"] == "62" and qa[0]["comment"] == "正确"
        assert qa[1]["question"] == "84-46=?"  # 缺 question 按 index 回填题面
        # 逐题独立于维度分:维度分照算(4/5=0.8),逐题不参与 overall
        assert result["overall_score"] == 0.8


def test_score_question_analyses_tolerates_shortfall(handler_mod):
    """review 逐题数组不足题数(只返回部分)→ 容错保留有效项、越界/缺 index 丢弃,不崩不索引错。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_short", "agent_id": "p",
            "rubric": {"mode": "dimension_score", "dimensions": [{"name": "专业", "max_score": 5, "weight": 1}]},
            "questions": [{"text": f"Q{i}"} for i in range(1, 11)],  # 10 题
        }
        _seed_session(ddb, "s_short", meta, [("user", "x")])
        # LLM 只返回 3 项(其中一项 index 越界 99 应丢弃,一项非 dict 应过滤)
        fake = FakeBedrock({
            "dimension_scores": [{"name": "专业", "score": 3, "max_score": 5}],
            "question_analyses": [
                {"index": 1, "user_answer": "a"},
                {"index": 99, "user_answer": "越界"},  # 丢弃
                {"index": 2, "user_answer": "b"},
            ],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_short")
        qa = result["question_analyses"]
        assert [x["index"] for x in qa] == [1, 2]  # 越界丢弃、按 index 排序;不足 10 题不补占位


def test_score_per_question_check_carries_user_answer_comment(handler_mod):
    """design contract:per_question_check 模式的 user_answer/comment 透传落库(三字段区分)。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_uac", "agent_id": "p",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [{"text": "25+37=?", "weight": 1}],
        }
        _seed_session(ddb, "s_uac", meta, [("user", "62")])
        fake = FakeBedrock({
            "question_checks": [{"index": 1, "question": "25+37=?", "passed": True,
                                 "evidence": "答 62,正确答案 62", "user_answer": "62", "comment": "反应快"}],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_uac")
        c = result["question_checks"][0]
        assert c["user_answer"] == "62" and c["comment"] == "反应快" and c["evidence"].startswith("答 62")


def test_dimension_prompt_asks_per_question_when_has_questions(handler_mod):
    """design contract:dimension 模式**有题**时 prompt 引导逐题分析;无题时不含(避免给无题会话强凑)。"""
    ev = handler_mod.Evaluator(bedrock=object(), ddb=object(), model_id="m")
    meta_q = {
        "session_id": "s", "agent_id": "p",
        "rubric": {"mode": "dimension_score", "dimensions": [{"name": "流利度", "max_score": 5, "weight": 1}]},
        "questions": [{"text": "Q1"}],
    }
    sys_q, _ = ev.build_prompt(meta_q, [{"speaker": "user", "text": "答"}])
    assert "question_analyses" in sys_q
    meta_noq = {**meta_q, "questions": []}
    sys_noq, _ = ev.build_prompt(meta_noq, [{"speaker": "user", "text": "答"}])
    assert "question_analyses" not in sys_noq


def test_normalize_stringified_array(handler_mod):
    """线上实测:Bedrock 偶把 question_checks 序列化成 JSON 字符串 → 必须 json.loads 还原,不能当字符迭代。"""
    import json as _json
    h = handler_mod
    raw = {
        "question_checks": _json.dumps([
            {"index": 1, "question": "Q1", "passed": True},
            {"index": 2, "question": "Q2", "passed": False},
        ]),
        "summary": "s",
    }
    norm = h._normalize_tool_input(raw)
    assert isinstance(norm["question_checks"], list)
    assert len(norm["question_checks"]) == 2
    assert norm["question_checks"][0]["index"] == 1


def test_normalize_malformed_json_unescaped_quotes(handler_mod):
    """线上实测最毒的一种:数组是字符串且 evidence 含**未转义引号**致 json.loads 失败 →
    宽松抽取必须仍能救回 index/passed 这类计分关键键。"""
    h = handler_mod
    bad = '[{"index": 1, "question": "Q1", "passed": true, "evidence": "用户回答"S3"，正确。"}, ' \
          '{"index": 2, "question": "Q2", "passed": false, "evidence": "答"错"了"}]'
    norm = h._normalize_tool_input({"question_checks": bad, "summary": "s"})
    qc = norm["question_checks"]
    assert len(qc) == 2
    assert qc[0]["index"] == 1 and qc[0]["passed"] is True
    assert qc[1]["index"] == 2 and qc[1]["passed"] is False


def test_score_stringified_checks_e2e(handler_mod):
    """stringified question_checks 经 score 全链路:还原 + 计分正确(不再 0%)。"""
    with mock_aws():
        import json as _json
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {"session_id": "s_str", "agent_id": "p",
                "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
                "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1}]}
        _seed_session(ddb, "s_str", meta, [("user", "x")])
        fake = FakeBedrock({
            "question_checks": _json.dumps([
                {"index": 1, "question": "Q1", "passed": True},
                {"index": 2, "question": "Q2", "passed": True},
            ]),
            "summary": "两题都对",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_str")
        assert result["pass_ratio"] == 1.0
        assert result["passed"] is True


def test_score_tolerates_non_dict_llm_items(handler_mod):
    """线上实测发现:LLM tool 输出偶尔把数组元素返成字符串 → 不能让 .get 抛 AttributeError。

    question_checks / excerpts 含非 dict 项时应被过滤,不崩。
    """
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_robust", "agent_id": "p",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [{"text": "Q1", "weight": 1}],
        }
        _seed_session(ddb, "s_robust", meta, [("user", "x")])
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Q1", "passed": True},
                "意外的字符串项",  # 脏数据:不应导致崩溃
            ],
            "excerpts": ["纯字符串摘录", {"text": "正常摘录"}],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_robust")  # 不抛异常
        assert result["passed"] is True
        assert len(result["question_checks"]) == 1  # 字符串项被过滤
        assert len(result["excerpts"]) == 1


# ── 只处理本系统会话 ──
def test_skip_orphan_no_agent(handler_mod):
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        # meta 无 agent_id
        ddb.Table(EVENTS_TABLE).put_item(Item={"session_id": "orphan", "sk": "meta", "status": "completed"})
        ev = handler_mod.Evaluator(bedrock=FakeBedrock({"summary": "x"}), ddb=ddb)
        assert ev.evaluate_session("orphan") is None
        assert ddb.Table(RESULTS_TABLE).get_item(Key={"session_id": "orphan"}).get("Item") is None


# ── 幂等:已人工复核不覆盖 ──
def test_idempotent_no_overwrite_reviewed(handler_mod):
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {"session_id": "s_rev", "agent_id": "p",
                "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
                "questions": [{"text": "Q1", "weight": 1}]}
        _seed_session(ddb, "s_rev", meta, [("user", "x")])
        # 已有被人工 override 的 Results
        ddb.Table(RESULTS_TABLE).put_item(Item={
            "session_id": "s_rev", "review_status": "overridden", "review_passed": True, "passed": False,
        })
        fake = FakeBedrock({"question_checks": [{"index": 1, "question": "Q1", "passed": True}], "summary": "重算"})
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        ev.evaluate_session("s_rev")
        stored = ddb.Table(RESULTS_TABLE).get_item(Key={"session_id": "s_rev"}).get("Item")
        # 没被覆盖:仍是人工复核结果
        assert stored["review_status"] == "overridden"
        assert "summary" not in stored or stored.get("summary") != "重算"


# ── on_event 端到端(Streams → 打分) ──
def test_on_event_end_to_end(handler_mod, monkeypatch):
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {"session_id": "s_e2e", "agent_id": "p",
                "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
                "questions": [{"text": "Q1", "weight": 1}]}
        _seed_session(ddb, "s_e2e", meta, [("user", "答")])
        fake = FakeBedrock({"question_checks": [{"index": 1, "question": "Q1", "passed": True}], "summary": "ok"})

        # 让 on_event 内部 new 的 Evaluator 用我们的 fake bedrock + moto ddb
        orig = handler_mod.Evaluator

        def _factory(*a, **k):
            return orig(bedrock=fake, ddb=ddb)

        monkeypatch.setattr(handler_mod, "Evaluator", _factory)

        event = {"Records": [
            {"eventName": "MODIFY", "dynamodb": {
                "Keys": {"session_id": {"S": "s_e2e"}, "sk": {"S": "meta"}},
                "NewImage": {"sk": {"S": "meta"}, "status": {"S": "completed"}},
            }},
            # 一条无关 event# 记录:不应触发
            {"eventName": "INSERT", "dynamodb": {
                "Keys": {"session_id": {"S": "s_e2e"}, "sk": {"S": "event#0001"}},
                "NewImage": {"sk": {"S": "event#0001"}},
            }},
        ]}
        out = handler_mod.on_event(event, None)
        assert out["processed"] == 1 and out["received"] == 2
        assert ddb.Table(RESULTS_TABLE).get_item(Key={"session_id": "s_e2e"}).get("Item")["passed"] is True


# ── 跨境打分(BUG-1 回归):mantle HTTP 路径,而非本区 bedrock-runtime ──
# 这些用例正是之前漏掉的:注入 mantle 配置,断言走 HTTP mantle(不构造 bedrock client),
# 按模型前缀选 anthropic/openai wire。若 handler 回退本区 Bedrock,这里会因未 mock bedrock 而暴露。

def _dim_meta():
    return {"session_id": "s_mantle", "agent_id": "a1", "rubric": {
        "mode": "dimension_score",
        "dimensions": [{"name": "流畅度", "description": "x", "weight": 1.0, "max_score": 5.0}]}}


def test_invoke_llm_mantle_openai_path(handler_mod, monkeypatch):
    """minimax 模型 → mantle /v1/chat/completions(OpenAI function-calling),不碰 bedrock。"""
    captured = {}

    def fake_post(self, path, body):
        captured["path"] = path
        captured["body"] = body
        return {"choices": [{"message": {"tool_calls": [
            {"function": {"name": "submit_evaluation",
                          "arguments": json.dumps({"dimension_scores": [{"name": "流畅度", "score": 4}],
                                                    "summary": "ok"})}}]}}]}
    monkeypatch.setattr(handler_mod.Evaluator, "_mantle_post", fake_post)
    ev = handler_mod.Evaluator(
        mantle={"host": "https://bedrock-mantle.us-east-1.api.aws", "api_key": "sk-x",
                "evaluator_model": "minimax.minimax-m2.5"})
    # 绝不构造 bedrock client(_bedrock 保持 None):访问会触发 boto3,若被调到说明走错路
    out = ev.invoke_llm("sys", "user", mode="dimension_score")
    assert captured["path"] == "/v1/chat/completions"
    assert captured["body"]["model"] == "minimax.minimax-m2.5"
    assert captured["body"]["tools"][0]["type"] == "function"  # OpenAI function-calling 格式
    assert out["summary"] == "ok"
    assert ev._bedrock is None  # 从未构造本区 bedrock client


def test_invoke_llm_mantle_anthropic_path(handler_mod, monkeypatch):
    """anthropic 模型 → mantle /anthropic/v1/messages(tool_use)。"""
    captured = {}

    def fake_post(self, path, body):
        captured["path"] = path
        return {"content": [{"type": "tool_use", "name": "submit_evaluation",
                             "input": {"dimension_scores": [{"name": "流畅度", "score": 5}], "summary": "good"}}]}
    monkeypatch.setattr(handler_mod.Evaluator, "_mantle_post", fake_post)
    ev = handler_mod.Evaluator(
        mantle={"host": "https://bedrock-mantle.us-east-1.api.aws", "api_key": "sk-x",
                "evaluator_model": "us.anthropic.claude-sonnet-4-6"})
    out = ev.invoke_llm("sys", "user", mode="dimension_score")
    assert captured["path"] == "/anthropic/v1/messages"
    assert out["summary"] == "good"
    assert ev._bedrock is None


def test_iam_fallback_region_is_us_east_1_never_cn(handler_mod, monkeypatch):
    """IAM 回退分支(未配 mantle):bedrock client 的 region 恒 us-east-1,绝不用本区 —— 防 BUG-1 回归
    (中国区若用本区 AWS_REGION 会连 bedrock-runtime.cn-north-1.amazonaws.com.cn 必挂)。"""
    # 即便把运行时 AWS_REGION 设成中国区,回退 client 仍须 us-east-1
    monkeypatch.setattr(handler_mod, "AWS_REGION", "cn-north-1")
    monkeypatch.setattr(handler_mod, "BEDROCK_FALLBACK_REGION", "us-east-1")
    created = {}

    def fake_boto3_client(svc, region_name=None):  # noqa: ARG001
        created["region"] = region_name
        class _C:
            def invoke_model(self, **kw):  # noqa: ANN003
                return {"body": type("B", (), {"read": lambda self: json.dumps(
                    {"content": [{"type": "tool_use", "name": "submit_evaluation",
                                  "input": {"dimension_scores": [], "summary": "s"}}]}).encode()})()}
        return _C()
    monkeypatch.setattr(handler_mod.boto3, "client", fake_boto3_client)
    ev = handler_mod.Evaluator(mantle=None, model_id="us.anthropic.claude-sonnet-4-6")
    ev.invoke_llm("sys", "user", mode="dimension_score")
    assert created["region"] == "us-east-1"  # 绝不是 cn-north-1


# ── mantle 有界重试(实测偶发 500 → 一次失败整场报告空的健壮性修复)──

def test_mantle_post_retries_on_5xx(handler_mod, monkeypatch):
    """mantle 5xx 有界重试:前两次 500、第三次成功 → 最终拿到结果(不因偶发 5xx 放弃打分)。"""
    import urllib.error
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        calls["n"] += 1
        if calls["n"] < 3:
            raise urllib.error.HTTPError(req.full_url, 500, "Internal Server Error", {}, None)
        class _Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return json.dumps({"ok": True}).encode()
        return _Resp()
    monkeypatch.setattr(handler_mod, "boto3", handler_mod.boto3)  # keep
    import urllib.request as ur
    monkeypatch.setattr(ur, "urlopen", fake_urlopen)
    import time as _t
    monkeypatch.setattr(_t, "sleep", lambda *_: None)  # 免真等退避
    ev = handler_mod.Evaluator(mantle={"host": "https://x", "api_key": "k", "evaluator_model": "minimax.minimax-m2.5"})
    out = ev._mantle_post("/v1/chat/completions", {"a": 1})
    assert out == {"ok": True} and calls["n"] == 3  # 重试到第 3 次成功


def test_mantle_post_no_retry_on_4xx(handler_mod, monkeypatch):
    """4xx(鉴权/参数)不重试:直接抛(重试无益,快速失败)。"""
    import urllib.error
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):  # noqa: ARG001
        calls["n"] += 1
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)
    import urllib.request as ur
    monkeypatch.setattr(ur, "urlopen", fake_urlopen)
    ev = handler_mod.Evaluator(mantle={"host": "https://x", "api_key": "k", "evaluator_model": "minimax.minimax-m2.5"})
    try:
        ev._mantle_post("/v1/chat/completions", {"a": 1})
        assert False, "should have raised"
    except urllib.error.HTTPError as e:
        assert e.code == 401 and calls["n"] == 1  # 只调一次,不重试


# ── design contract:webhook 数据主权(result.ready 只发摘要,不含逐题细节)──
def test_result_ready_webhook_excludes_per_question_detail(handler_mod, monkeypatch):
    """design contract:逐题字段(user_answer/comment/question_analyses/question_checks)MUST NOT 进 webhook payload。
    只发 summary 摘要(passed/overall_score/session/agent/result_url)。守数据主权。"""
    monkeypatch.setenv("INTEGRATION_TABLE_NAME", "aim-integration")
    handler_mod.INTEGRATION_TABLE_NAME = "aim-integration"
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        ddb.create_table(
            TableName="aim-integration",
            KeySchema=[{"AttributeName": "client_id", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "client_id", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        ddb.Table("aim-integration").put_item(Item={
            "client_id": "c1", "sk": "webhook#w1",
            "url": "https://hook.example.com/x", "secret": "s", "events": ["result.ready"],
        })
        # 捕获发出的 webhook body;放行 SSRF 校验
        sent = {}
        def fake_urlopen(req, timeout=None):  # noqa: ARG001
            sent["body"] = req.data.decode("utf-8")
            class _R:
                status = 200
                def read(self): return b"ok"
                def __enter__(self): return self
                def __exit__(self, *a): return False
            return _R()
        import urllib.request as ur
        monkeypatch.setattr(ur, "urlopen", fake_urlopen)
        monkeypatch.setattr(handler_mod, "_result_safe_ips", lambda host: True)

        result = {
            "session_id": "s_wh", "agent_id": "p", "rubric_mode": "dimension_score",
            "overall_score": 0.8, "dimension_scores": [{"name": "专业", "score": 4, "max_score": 5}],
            "question_analyses": [{"index": 1, "user_answer": "机密回答", "comment": "机密点评", "score": 5}],
            "summary": "摘要",
        }
        meta = {"session_id": "s_wh", "agent_id": "p"}
        handler_mod._dispatch_result_ready(ddb, "s_wh", result, meta)
        assert "body" in sent, "webhook 未发出"
        body = sent["body"]
        # 逐题细节 MUST NOT 出现在 payload
        assert "机密回答" not in body and "机密点评" not in body
        assert "question_analyses" not in body and "question_checks" not in body
        assert "user_answer" not in body and "evidence" not in body
        # 摘要字段 MUST 在
        assert "overall_score" in body and "s_wh" in body


# ── design contract:传统 Bedrock Converse 调用方式(evaluator)──
def test_load_mantle_config_converse_method(handler_mod, monkeypatch):
    """_load_mantle_config 识别 call_method=bedrock_converse → 取 bedrock_api_key + host + region。"""
    secret = {
        "enabled": True,
        "call_method": "bedrock_converse",
        "host": "https://proxy-mantle.example.com",
        "bedrock_api_key": "bedrock-key-123",
        "bedrock_region": "us-east-1",
        "evaluator_model": "global.anthropic.claude-opus-4-7",
        "api_key": "",  # 无 mantle token
    }

    class _SM:
        def get_secret_value(self, SecretId):  # noqa: N803
            return {"SecretString": json.dumps(secret)}
    monkeypatch.setattr(handler_mod, "LLM_CONFIG_SECRET_ID", "arn:fake")
    monkeypatch.setattr(handler_mod.boto3, "client", lambda *a, **k: _SM())
    cfg = handler_mod._load_mantle_config()
    assert cfg["call_method"] == "bedrock_converse"
    assert cfg["bedrock_api_key"] == "bedrock-key-123"
    assert cfg["bedrock_region"] == "us-east-1"
    assert cfg["evaluator_model"] == "global.anthropic.claude-opus-4-7"


def test_load_mantle_config_converse_no_key_returns_none(handler_mod, monkeypatch):
    """converse 但无 bedrock_api_key → 返 None(回退 IAM;中国区 invoke 时 fail-fast)。"""
    secret = {"enabled": True, "call_method": "bedrock_converse", "host": "https://p", "bedrock_api_key": ""}

    class _SM:
        def get_secret_value(self, SecretId):  # noqa: N803
            return {"SecretString": json.dumps(secret)}
    monkeypatch.setattr(handler_mod, "LLM_CONFIG_SECRET_ID", "arn:fake")
    monkeypatch.setattr(handler_mod.boto3, "client", lambda *a, **k: _SM())
    assert handler_mod._load_mantle_config() is None


def test_invoke_llm_converse_path(handler_mod, monkeypatch):
    """call_method=bedrock_converse → /model/<id>/converse?mantle=false&region=,toolConfig/toolUse 契约。"""
    captured = {}

    def fake_converse_post(self, path, body):
        captured["path"] = path
        captured["body"] = body
        # Converse 响应:output.message.content[] 里 toolUse.input
        return {"output": {"message": {"content": [
            {"toolUse": {"name": "submit_evaluation",
                         "input": {"dimension_scores": [{"name": "流畅度", "score": 5}], "summary": "converse-ok"}}}
        ]}}}
    monkeypatch.setattr(handler_mod.Evaluator, "_converse_post", fake_converse_post)
    ev = handler_mod.Evaluator(mantle={
        "call_method": "bedrock_converse",
        "host": "https://proxy-mantle.example.com",
        "bedrock_api_key": "bk-x",
        "bedrock_region": "us-east-1",
        "evaluator_model": "global.anthropic.claude-opus-4-7",
    })
    out = ev.invoke_llm("sys", "user", mode="dimension_score")
    # URL 带 mantle-proxy 路由参数 + converse 端点
    assert captured["path"] == "/model/global.anthropic.claude-opus-4-7/converse?mantle=false&region=us-east-1"
    # Converse toolConfig 契约(与 anthropic tools / openai function 不同)
    assert captured["body"]["toolConfig"]["toolChoice"] == {"tool": {"name": "submit_evaluation"}}
    assert captured["body"]["toolConfig"]["tools"][0]["toolSpec"]["name"] == "submit_evaluation"
    assert captured["body"]["messages"] == [{"role": "user", "content": [{"text": "user"}]}]
    assert captured["body"]["system"] == [{"text": "sys"}]
    assert out["summary"] == "converse-ok"
    assert ev._bedrock is None  # 从未构造本区 bedrock client


def test_evaluate_session_writes_error_marker_on_failure(handler_mod, monkeypatch):
    """design contract(review):打分失败 → 写带 evaluation_error 的 Results(前端显示评测失败)+ re-raise。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {"session_id": "s_err", "agent_id": "p", "agent_version": "v1",
                "rubric": {"mode": "dimension_score"}, "questions": [{"text": "Q1"}]}
        _seed_session(ddb, "s_err", meta, [("ai", "问"), ("user", "答")])
        ev = handler_mod.Evaluator(bedrock=object(), ddb=ddb)
        # 让 score 抛错(模拟 converse 经代理不可达)
        monkeypatch.setattr(ev, "score", lambda m: (_ for _ in ()).throw(RuntimeError("proxy unreachable")))
        import pytest as _pytest
        with _pytest.raises(RuntimeError, match="proxy unreachable"):
            ev.evaluate_session("s_err")
        # 失败仍写了带 evaluation_error 的 Results(供前端显示评测失败,非静默空转)
        item = ddb.Table(RESULTS_TABLE).get_item(Key={"session_id": "s_err"}).get("Item")
        assert item is not None and item.get("evaluation_error")
        assert "proxy unreachable" in item["evaluation_error"]


# ── design contract:逐题 10 分制 + passed 由 score 折算 + 非法数值归一化 ──
def test_048_score_folds_passed_high_and_low(handler_mod):
    """有合法 score:高分(>=6/10)折算 passed=True、低分折算 False;覆盖 LLM 直给的 passed。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_048a", "agent_id": "p", "agent_version": "v1",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1}],
        }
        _seed_session(ddb, "s_048a", meta, [("ai", "问Q1"), ("user", "答1"), ("ai", "问Q2"), ("user", "答2")])
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Q1", "score": 9, "max_score": 10, "passed": True},
                {"index": 2, "question": "Q2", "score": 3, "max_score": 10, "passed": True},  # LLM 说 True 但只 3 分
            ],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_048a")
        checks = {c["index"]: c for c in result["question_checks"]}
        assert checks[1]["passed"] is True   # 9/10=0.9 >= 0.6
        assert checks[2]["passed"] is False  # 3/10=0.3 < 0.6 —— 折算覆盖 LLM 的 True(消矛盾)
        assert checks[1]["score"] == 9 and checks[1]["max_score"] == 10
        # 整场 pass_ratio 按折算后 passed 加权:1 对 1 错 → 0.5
        assert result["pass_ratio"] == 0.5


def test_048_missing_score_keeps_llm_passed(handler_mod):
    """无 score 但有 LLM passed → 保留 passed,仍计入通过(不因缺 score 低估 pass_ratio)。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_048b", "agent_id": "p", "agent_version": "v1",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1}],
        }
        _seed_session(ddb, "s_048b", meta, [("ai", "问"), ("user", "答")])
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Q1", "score": 8, "max_score": 10, "passed": True},
                {"index": 2, "question": "Q2", "passed": True},  # 无 score,LLM 说 True(截断/漏返)
            ],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_048b")
        checks = {c["index"]: c for c in result["question_checks"]}
        assert checks[2]["passed"] is True   # 保留 LLM passed(不被误判未通过)
        assert "score" not in checks[2]       # 无合法 score → 删 score 键(前端回退 ✓/✗)
        assert result["pass_ratio"] == 1.0    # 两题都通过(第 2 题缺 score 仍计入,不低估)


def test_048_illegal_values_no_crash_no_nan(handler_mod):
    """非法数值(max_score=0 / score 负 / score 超 max / NaN)归一化:不除零/不 NaN/不越界。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_048c", "agent_id": "p", "agent_version": "v1",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1},
                          {"text": "Q3", "weight": 1}, {"text": "Q4", "weight": 1}],
        }
        _seed_session(ddb, "s_048c", meta, [("ai", "问"), ("user", "答")])
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Q1", "score": 8, "max_score": 0, "passed": True},   # max=0 除零风险
                {"index": 2, "question": "Q2", "score": -5, "max_score": 10, "passed": True},  # 负分
                {"index": 3, "question": "Q3", "score": 99, "max_score": 10, "passed": False}, # 超 max
                {"index": 4, "question": "Q4", "score": float("nan"), "max_score": 10, "passed": True},  # NaN
            ],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_048c")  # MUST NOT 抛
        checks = {c["index"]: c for c in result["question_checks"]}
        # 1: max=0 → 视同缺 score(max 回填10但 score 8 合法?score=8<=10 合法 → 其实 max 回填后 8/10=0.8 通过)
        #   —— max_score 非正回填 10,score=8 合法 → 折算 0.8>=0.6 → True
        assert checks[1]["passed"] is True and checks[1]["max_score"] == 10
        # 2/3/4:非法 score(负/超/NaN)→ 视同缺 score,删 score 键,保留 LLM passed
        assert "score" not in checks[2] and checks[2]["passed"] is True
        assert "score" not in checks[3] and checks[3]["passed"] is False
        assert "score" not in checks[4]
        # 落库不含 NaN(DDB 不接受);能取回即证明未抛
        stored = ddb.Table(RESULTS_TABLE).get_item(Key={"session_id": "s_048c"}).get("Item")
        assert stored is not None


def test_048_pass_threshold_unchanged(handler_mod):
    """整场 pass_threshold(默认 0.8)语义不变:单题及格比例 0.6 只影响每题 passed 折算,不改整场线。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_048d", "agent_id": "p", "agent_version": "v1",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.8},  # 整场线 0.8
            "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1}],
        }
        _seed_session(ddb, "s_048d", meta, [("ai", "问"), ("user", "答")])
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Q1", "score": 7, "max_score": 10, "passed": True},  # 0.7>=0.6 → 单题过
                {"index": 2, "question": "Q2", "score": 3, "max_score": 10, "passed": False}, # 单题不过
            ],
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_048d")
        assert result["pass_ratio"] == 0.5      # 1 过 1 不过
        assert result["passed"] is False        # 0.5 < 0.8 整场线(未被单题 0.6 影响)


def test_048_question_checks_lenient_parse_string_array(handler_mod):
    """question_checks 被序列化成字符串时,_normalize_tool_input 仍能解析(坏 JSON 兜底覆盖)。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_048e", "agent_id": "p", "agent_version": "v1",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [{"text": "Q1", "weight": 1}],
        }
        _seed_session(ddb, "s_048e", meta, [("ai", "问"), ("user", "答")])
        # question_checks 是 JSON 字符串(Bedrock 偶发畸形)
        fake = FakeBedrock({
            "question_checks": '[{"index":1,"question":"Q1","score":9,"max_score":10,"passed":true}]',
            "summary": "s",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_048e")
        checks = {c["index"]: c for c in result["question_checks"]}
        assert checks[1]["passed"] is True  # 字符串被 normalize 解析、score 折算


# ── design contract:转写题号确定性分段(build_prompt 渲染 [Qn] + 0/1-based +1 转换 + 老会话回退)──
def test_052_build_prompt_renders_1based_question_markers(handler_mod):
    """转写行带 question_index(0-based)→ 渲染 [Q{n+1}](1-based,与 question_checks index 对齐);
    user + AI 都标;system prompt 含题号标注说明。★off-by-one 变异自证:0-based 0/1 → [Q1]/[Q2]。"""
    ev = handler_mod.Evaluator(bedrock=object(), ddb=object(), model_id="m")
    meta = {
        "session_id": "s", "agent_id": "p",
        "rubric": {"mode": "per_question_check", "pass_threshold": 0.8},
        "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1}],
    }
    transcript = [
        {"speaker": "ai", "text": "第一道题", "question_index": 0},
        {"speaker": "user", "text": "答一", "question_index": 0},
        {"speaker": "ai", "text": "第二道题", "question_index": 1},
        {"speaker": "user", "text": "答二", "question_index": 1},
    ]
    system, user = ev.build_prompt(meta, transcript)
    # 0-based +1 → 1-based:index 0 → [Q1], index 1 → [Q2]。MUST 不是 [Q0]/[Q1](那是漏 +1 的 off-by-one)。
    assert "[Q1] ai: 第一道题" in user
    assert "[Q1] user: 答一" in user   # AI 与 user 都标(不对称缺失会失去一半锚点)
    assert "[Q2] ai: 第二道题" in user
    assert "[Q2] user: 答二" in user
    assert "[Q0]" not in user           # ★off-by-one 变异自证:绝不出现 0-based [Q0]
    assert "题号标注" in system          # 含题号分段说明


def test_052_old_session_no_marker_falls_back_to_semantic(handler_mod):
    """老会话:整场转写行都无 question_index → **完全回退纯 `speaker: text`**(不加 [--] 前缀,逐字节现状)+
    system 不含题号标注说明(评审 Minor review:老会话不应误加 [--])。"""
    ev = handler_mod.Evaluator(bedrock=object(), ddb=object(), model_id="m")
    meta = {
        "session_id": "s", "agent_id": "p",
        "rubric": {"mode": "per_question_check", "pass_threshold": 0.8},
        "questions": [{"text": "Q1", "weight": 1}],
    }
    transcript = [  # 无 question_index 字段(老会话)
        {"speaker": "ai", "text": "问一"},
        {"speaker": "user", "text": "答一"},
    ]
    system, user = ev.build_prompt(meta, transcript)
    assert "ai: 问一" in user              # 纯 speaker: text(现状格式)
    assert "user: 答一" in user
    assert "[--]" not in user              # ★ 老会话完全回退:不加 [--] 前缀(评审 Minor)
    assert "[Q" not in user                # 无任何题号标注
    assert "题号标注" not in system         # 无题号 → 不加说明 → 纯语义回退(现状行为)


def test_052_sparse_markers_mixed(handler_mod):
    """稀疏行:同场部分行有题号、部分无(开场/收尾/越界轮)→ 有题号确定归位([Qn])、无题号标 [--]、含说明。"""
    ev = handler_mod.Evaluator(bedrock=object(), ddb=object(), model_id="m")
    meta = {
        "session_id": "s", "agent_id": "p",
        "rubric": {"mode": "per_question_check", "pass_threshold": 0.8},
        "questions": [{"text": "Q1", "weight": 1}],
    }
    transcript = [
        {"speaker": "ai", "text": "开场白"},                       # 无题号(开场)→ [--]
        {"speaker": "ai", "text": "唯一的题", "question_index": 0},  # 有题号 → [Q1]
        {"speaker": "user", "text": "作答", "question_index": 0},
        {"speaker": "ai", "text": "收尾语"},                       # 无题号(越界收尾)→ [--]
    ]
    system, user = ev.build_prompt(meta, transcript)
    assert "[--] ai: 开场白" in user
    assert "[Q1] ai: 唯一的题" in user
    assert "[Q1] user: 作答" in user
    assert "[--] ai: 收尾语" in user
    assert "题号标注" in system            # 有题号行 → 加说明(混合处理)


def test_052_dimension_mode_also_renders_markers(handler_mod):
    """dimension_score 模式同样渲染题号标注(+1 转 1-based)+ 含说明(两形态共用 convo 渲染)。"""
    ev = handler_mod.Evaluator(bedrock=object(), ddb=object(), model_id="m")
    meta = {
        "session_id": "s", "agent_id": "p",
        "rubric": {"mode": "dimension_score", "dimensions": [{"name": "流利度", "max_score": 5, "weight": 1}]},
        "questions": [{"text": "Q1"}, {"text": "Q2"}, {"text": "Q3"}],
    }
    transcript = [{"speaker": "user", "text": "答第三题", "question_index": 2}]  # 0-based 2 → [Q3]
    system, user = ev.build_prompt(meta, transcript)
    assert "[Q3] user: 答第三题" in user   # +1 转 1-based
    assert "题号标注" in system


def test_052_decimal_question_index_from_ddb(handler_mod):
    """DDB 落库数值可能是 Decimal(_to_ddb 把数字转 Decimal)→ 渲染时 int() 后 +1 不崩、正确。"""
    from decimal import Decimal
    ev = handler_mod.Evaluator(bedrock=object(), ddb=object(), model_id="m")
    meta = {
        "session_id": "s", "agent_id": "p",
        "rubric": {"mode": "per_question_check", "pass_threshold": 0.8},
        "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1}],
    }
    transcript = [{"speaker": "user", "text": "答", "question_index": Decimal("1")}]  # Decimal 1 → [Q2]
    _system, user = ev.build_prompt(meta, transcript)
    assert "[Q2] user: 答" in user


def test_052_score_schema_unchanged_with_markers(handler_mod):
    """打分输出 schema 不变:带题号转写全链路 score,question_checks/pass_ratio/passed 契约与现状一致。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name=REGION)
        _create_tables(ddb)
        meta = {
            "session_id": "s_052", "agent_id": "p",
            "rubric": {"mode": "per_question_check", "pass_threshold": 0.5},
            "questions": [{"text": "Q1", "weight": 1}, {"text": "Q2", "weight": 1}],
        }
        # 转写带 question_index(0-based),seed 时写进 event 行。
        t = ddb.Table(EVENTS_TABLE)
        t.put_item(Item=_to_decimal({"session_id": "s_052", "sk": "meta", **meta}))
        rows = [
            ("ai", "第一题", 0), ("user", "答一", 0),
            ("ai", "第二题", 1), ("user", "答二", 1),
        ]
        for i, (sp, txt, qi) in enumerate(rows):
            t.put_item(Item=_to_decimal(
                {"session_id": "s_052", "sk": f"event#{i:04d}", "speaker": sp, "text": txt, "question_index": qi}))
        fake = FakeBedrock({
            "question_checks": [
                {"index": 1, "question": "Q1", "passed": True},
                {"index": 2, "question": "Q2", "passed": True},
            ],
            "summary": "都对",
        })
        ev = handler_mod.Evaluator(bedrock=fake, ddb=ddb)
        result = ev.evaluate_session("s_052")
        # schema 不变:仍是 question_checks + pass_ratio + passed(题号标注只强化分段,不改输出结构)。
        assert result["pass_ratio"] == 1.0
        assert result["passed"] is True
        assert {c["index"] for c in result["question_checks"]} == {1, 2}
