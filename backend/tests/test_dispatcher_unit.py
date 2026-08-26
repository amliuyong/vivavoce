"""Dispatcher 单测(review)—— make_dispatcher 选型 + HttpDispatcher 真 POST 到实时会话服务
/sessions/{id}/ready(会话就绪指令,带 X-Bridge-Secret)。

不真起实时服务:monkeypatch httpx.post 断言 URL + body;验证 prompt/引擎随就绪指令下发。
"""
from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from app.config import Settings
from app.db import Db
from app.session_service import (
    HttpDispatcher,
    RecordingDispatcher,
    SessionService,
    make_dispatcher,
    resolve_launch_command,
)


def _settings(**kw) -> Settings:
    base = dict(
        region="us-east-1", user_pool_id="p", user_pool_client_id="c",
        agents_table="P", question_banks_table="QB", targets_table="T",
        sessions_table="S",
        results_table="R", session_events_table="aim-session-events",
        slot_pools_table="SP", integration_table="INT", system_config_table="SC", recording_bucket="B",
        default_engine_type="three_stage", dynamodb_endpoint_url=None, auth_mode="local",
        max_concurrency=8, gpu_capacity_static_fallback=8, staff_edit_lock_min=30,
        session_join_expire_min=30, bridge_dial_url=None,
        candidate_token_secret="test-secret", delegation_token_secret="test-secret", public_api_base=None,
        bridge_callback_secret="test-bridge-secret",
        minimax_secret_arn=None, gpu_control_url=None, gpu_control_secret=None,
        llm_secret_arn=None, mcp_client_id="mcpclient", cognito_hosted_ui_domain="aim-x-12345678",
    )
    base.update(kw)
    return Settings(**base)


def _mk_events_table(ddb):
    ddb.create_table(
        TableName="aim-session-events",
        KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"},
                   {"AttributeName": "sk", "KeyType": "RANGE"}],
        AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"},
                              {"AttributeName": "sk", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


def test_make_dispatcher_selects_by_config():
    db = Db(_settings())
    assert isinstance(make_dispatcher(db, None), RecordingDispatcher)
    assert isinstance(make_dispatcher(db, "http://10.0.0.5:3001"), HttpDispatcher)


def test_make_dispatcher_passes_secret():
    db = Db(_settings())
    disp = make_dispatcher(db, "http://10.0.0.5:3001", secret="s3cret")
    assert isinstance(disp, HttpDispatcher) and disp.secret == "s3cret"


def test_resolve_launch_command_flattens_engine():
    """review:实时服务读顶层 engine_type/llm_model_id/language/voice。
    design contract:questions 来自 session.resolved_questions(已固化),Agent 提供 prompt/engine。"""
    session = {"session_id": "s1", "meeting_end": "x",
               "resolved_questions": [{"text": "Q1"}]}
    agent = {
        "agent_id": "a1", "name": "线上e2e-check", "system_prompt": "你是考官",
        "engine": {"engine_type": "three_stage", "language": "zh-CN", "voice": "male_std",
                   "llm_model_id": "us.anthropic.claude-haiku-4-5-20251001-v1:0"},
    }
    cmd = resolve_launch_command(session, agent)
    assert cmd["session_id"] == "s1"
    assert cmd["system_prompt"] == "你是考官"
    assert cmd["questions"] == [{"text": "Q1"}]  # 来自 session 固化题目
    assert cmd["engine_type"] == "three_stage"  # 顶层(契约对齐)
    assert cmd["language"] == "zh-CN"
    assert cmd["voice"] == "male_std"  # 语义音色 key 下发实时会话服务(→ GPU voice clone)
    assert cmd["llm_model_id"].endswith("haiku-4-5-20251001-v1:0")
    # 电话字段已删(B3):就绪指令不再携带 platform/dial_in_number/conference_id/caller_id_name
    for gone in ("platform", "dial_in_number", "conference_id", "caller_id_name"):
        assert gone not in cmd


def test_resolve_launch_command_voice_defaults_male_std():
    """Agent 未设 voice(旧数据/API 建的存 null)→ cmd["voice"]=male_std,与前端下拉框默认一致
    (所见即所播)。不兜底会透传 null,GPU 终极 fallback 成 female_std → 设男音却出女音。"""
    session = {"session_id": "s2"}
    agent = {"agent_id": "a2", "name": "n", "system_prompt": "x",
             "engine": {"engine_type": "three_stage", "language": "zh-CN"}}
    cmd = resolve_launch_command(session, agent)
    assert cmd["voice"] == "male_std"


def test_resolve_launch_command_tts_provider_flattened():
    """design contract:Agent.engine.tts_provider 顶层下发(照 voice/llm_model_id 同路径)。"""
    session = {"session_id": "s3", "meeting_end": "x"}
    agent = {
        "agent_id": "a3", "name": "n", "system_prompt": "x",
        "engine": {"engine_type": "three_stage", "language": "zh-CN", "tts_provider": "minimax"},
    }
    cmd = resolve_launch_command(session, agent)
    assert cmd["tts_provider"] == "minimax"  # 顶层透传(实时服务 → GPU start 帧)


def test_resolve_launch_command_tts_provider_defaults_none():
    """Agent 未设 tts_provider → cmd["tts_provider"]=None(GPU 回退默认 gpu_omnivoice)。"""
    cmd = resolve_launch_command(
        {"session_id": "s4"},
        {"agent_id": "a4", "name": "n", "system_prompt": "x",
         "engine": {"engine_type": "three_stage"}},
    )
    assert cmd["tts_provider"] is None


def test_resolve_launch_command_show_subtitles_explicit_false():
    """design contract:Agent **顶层** show_subtitles=False → cmd["show_subtitles"]=False(唯一关字幕的情形)。
    经 ready 帧下发前端;呈现语义,不进 engine 嵌套。"""
    cmd = resolve_launch_command(
        {"session_id": "s5"},
        {"agent_id": "a5", "name": "n", "system_prompt": "x", "show_subtitles": False,
         "engine": {"engine_type": "three_stage"}},
    )
    assert cmd["show_subtitles"] is False


def test_resolve_launch_command_show_subtitles_defaults_true():
    """design contract:Agent 未配 show_subtitles(老数据/新建未改)/ None / True → cmd["show_subtitles"]=True
    (默认开,向后兼容 design contract)。逐跳「唯字面 False 才关」不变式的 backend 跳。"""
    # 缺省(键不存在):默认开
    cmd_missing = resolve_launch_command(
        {"session_id": "s6"},
        {"agent_id": "a6", "name": "n", "system_prompt": "x", "engine": {"engine_type": "three_stage"}},
    )
    assert cmd_missing["show_subtitles"] is True
    # 显式 None(API client 传 null):默认开
    cmd_none = resolve_launch_command(
        {"session_id": "s7"},
        {"agent_id": "a7", "name": "n", "system_prompt": "x", "show_subtitles": None,
         "engine": {"engine_type": "three_stage"}},
    )
    assert cmd_none["show_subtitles"] is True
    # 显式 True:开
    cmd_true = resolve_launch_command(
        {"session_id": "s8"},
        {"agent_id": "a8", "name": "n", "system_prompt": "x", "show_subtitles": True,
         "engine": {"engine_type": "three_stage"}},
    )
    assert cmd_true["show_subtitles"] is True


def test_resolve_launch_command_avatar_style_valid_and_failsafe():
    """design contract:Agent 顶层 avatar_style 下发。合法四枚举透传;None/缺省/脏值 → None(前端兜底 minimal),
    不透传脏值污染 ready 帧(字符串枚举须 fail-safe,不同 bool 的 show_subtitles)。"""
    base = {"agent_id": "av", "name": "n", "system_prompt": "x", "engine": {"engine_type": "three_stage"}}
    # 合法四值透传
    for style in ("minimal", "round", "tech", "waveform"):
        cmd = resolve_launch_command({"session_id": "s"}, {**base, "avatar_style": style})
        assert cmd["avatar_style"] == style
    # 缺省(键不存在)→ None
    assert resolve_launch_command({"session_id": "s"}, base)["avatar_style"] is None
    # 显式 None → None
    assert resolve_launch_command({"session_id": "s"}, {**base, "avatar_style": None})["avatar_style"] is None
    # 脏值(旧数据/人工 DDB 改)→ None(fail-safe,不透传脏值)
    assert resolve_launch_command({"session_id": "s"}, {**base, "avatar_style": "bogus"})["avatar_style"] is None


def test_resolve_launch_command_speaker_lock_explicit_false():
    """design contract:Agent **顶层** speaker_lock=False → cmd["speaker_lock"]=False(唯一关声纹锁的情形)。
    经 ready 预创建 payload 下发 bridge;会话行为语义,不进 engine 嵌套。"""
    cmd = resolve_launch_command(
        {"session_id": "sl1"},
        {"agent_id": "al1", "name": "n", "system_prompt": "x", "speaker_lock": False,
         "engine": {"engine_type": "three_stage"}},
    )
    assert cmd["speaker_lock"] is False


def test_resolve_launch_command_speaker_lock_defaults_true():
    """design contract:Agent 未配 speaker_lock(老数据/新建未改)/ None / True → cmd["speaker_lock"]=True
    (默认锁定,设计决策默认开)。逐跳「唯字面 False 才关」不变式的 backend 跳。"""
    # 缺省(键不存在):默认开
    cmd_missing = resolve_launch_command(
        {"session_id": "sl2"},
        {"agent_id": "al2", "name": "n", "system_prompt": "x", "engine": {"engine_type": "three_stage"}},
    )
    assert cmd_missing["speaker_lock"] is True
    # 显式 None(API client 传 null):默认开
    cmd_none = resolve_launch_command(
        {"session_id": "sl3"},
        {"agent_id": "al3", "name": "n", "system_prompt": "x", "speaker_lock": None,
         "engine": {"engine_type": "three_stage"}},
    )
    assert cmd_none["speaker_lock"] is True
    # 显式 True:开
    cmd_true = resolve_launch_command(
        {"session_id": "sl4"},
        {"agent_id": "al4", "name": "n", "system_prompt": "x", "speaker_lock": True,
         "engine": {"engine_type": "three_stage"}},
    )
    assert cmd_true["speaker_lock"] is True


def test_resolve_launch_command_carries_window_fields():
    """即时开始:下发会话最大时长 max_duration_s(取 engine.max_duration_s,默认 1800);
    meeting_end / hangup_reminder_min 已删除,不再下发。"""
    cmd = resolve_launch_command(
        {"session_id": "s5"},
        {"agent_id": "a5", "system_prompt": "x", "engine": {"max_duration_s": 1200}},
    )
    assert cmd["max_duration_s"] == 1200


def test_resolve_launch_command_moderation_model(monkeypatch):
    """design contract:配了 llm_config(three_stage)→ 下发 llm_moderation_model_id = effective_evaluator_model
    (evaluator_model||default_model||DEFAULT,用 effective 求值不直读 raw,review)。复用同通 token/host。"""
    session = {"session_id": "sm"}
    agent = {"agent_id": "am", "system_prompt": "x", "engine": {"engine_type": "three_stage"}}
    # ① 配了 evaluator_model → 直接用它
    cmd = resolve_launch_command(session, agent, llm_config={
        "host": "https://h", "api_key": "tok", "default_model": "zai.glm-4.7-flash",
        "evaluator_model": "minimax.minimax-m2.5"})
    assert cmd["llm_moderation_model_id"] == "minimax.minimax-m2.5"
    # ② 无 evaluator_model → 回退 default_model(effective 求值,不因 raw 缺键下发空)
    cmd2 = resolve_launch_command(session, agent, llm_config={
        "host": "https://h", "api_key": "tok", "default_model": "zai.glm-4.7-flash"})
    assert cmd2["llm_moderation_model_id"] == "zai.glm-4.7-flash"
    # ③ 无 llm_config → 不下发(纯 env 回退,不注入裁判)
    cmd3 = resolve_launch_command(session, agent)
    assert "llm_moderation_model_id" not in cmd3
    # 时间窗字段已删(即时开始模型):就绪指令不再携带 meeting_end/hangup_reminder_min
    for gone in ("meeting_end", "hangup_reminder_min"):
        assert gone not in cmd


def test_resolve_launch_command_max_duration_default():
    """Agent 未设 max_duration_s → 默认 1800。"""
    cmd = resolve_launch_command(
        {"session_id": "s6"},
        {"agent_id": "a6", "system_prompt": "x", "engine": {}},
    )
    assert cmd["max_duration_s"] == 1800


def test_make_ready_anchors_in_progress_deadline_to_started_at_and_max_duration():
    class CaptureDispatcher:
        command = None

        def dispatch(self, command):
            self.command = command

        def hangup(self, session_id):
            return True

    dispatcher = CaptureDispatcher()
    service = SessionService(object(), dispatcher=dispatcher, session_join_expire_min=30)
    agent = {"agent_id": "a1", "engine": {"max_duration_s": 1200}}
    service.make_ready(
        {
            "session_id": "s1",
            "status": "in_progress",
            "created_at": "2026-08-02T08:00:00+00:00",
            "started_at": "2026-08-02T10:00:00+00:00",
            "agent_snapshot": agent,
        },
        agent,
    )

    assert dispatcher.command["connect_deadline"] == "2026-08-02T10:20:00+00:00"


def test_http_dispatcher_posts_ready(monkeypatch):
    """HttpDispatcher.dispatch → POST {base}/sessions/{id}/ready(携带完整就绪指令 + X-Bridge-Secret)
    + 落库留痕。含 Decimal 字段(来自 DDB)必须能序列化(真机根因:Decimal not JSON serializable)。"""
    import json as _json
    from decimal import Decimal
    posted = {}

    class _Resp:
        status_code = 202

    def fake_post(url, content=None, headers=None, timeout=None):
        posted["url"] = url
        posted["headers"] = headers
        posted["body"] = _json.loads(content)  # content 是 bytes(Decimal-aware 编码后)
        return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "post", fake_post)

    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        _mk_events_table(ddb)
        db = Db(_settings(), resource=ddb)
        db.put_session_meta("s1", {"status": "scheduled", "agent_id": "p1"})
        disp = HttpDispatcher(db, "http://10.0.0.5:3001", secret="sh4red")
        # hangup_reminder_min/weight 等从 DDB 读出是 Decimal —— 必须能序列化下发
        disp.dispatch({"session_id": "s1",
                       "system_prompt": "你是考官", "engine_type": "three_stage",
                       "hangup_reminder_min": Decimal("5"), "questions": [{"weight": Decimal("1.5")}]})
        # 预创建不推进状态:meta.status 保持 scheduled(等 connected 事件)
        meta = db.get_session_meta("s1")
        assert meta["status"] == "scheduled"
        assert meta["dispatch_http_ok"] is True

    assert posted["url"] == "http://10.0.0.5:3001/sessions/s1/ready"
    assert posted["headers"]["X-Bridge-Secret"] == "sh4red"  # 复用 bridge callback secret
    assert posted["body"]["session_id"] == "s1"
    assert posted["body"]["system_prompt"] == "你是考官"
    assert posted["body"]["hangup_reminder_min"] == 5  # Decimal→int
    assert posted["body"]["questions"][0]["weight"] == 1.5  # Decimal→float(关键:Decimal 能序列化下发)


def test_http_dispatcher_hangup_posts(monkeypatch):
    posted = {}

    class _Resp:
        status_code = 200

    def fake_post(url, content=None, headers=None, timeout=None):
        posted["url"] = url
        return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "post", fake_post)
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        _mk_events_table(ddb)
        db = Db(_settings(), resource=ddb)
        db.put_session_meta("s1", {"status": "in_progress"})
        HttpDispatcher(db, "http://10.0.0.5:3001").hangup("s1")
    assert posted["url"] == "http://10.0.0.5:3001/sessions/s1/hangup"


def test_http_dispatcher_swallows_unreachable(monkeypatch):
    """实时服务不可达:落库留痕 dispatch_http_ok=False,不抛(失败旁路)。"""
    def boom(*a, **k):
        raise RuntimeError("connection refused")

    import httpx

    monkeypatch.setattr(httpx, "post", boom)
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        _mk_events_table(ddb)
        db = Db(_settings(), resource=ddb)
        db.put_session_meta("s1", {"status": "scheduled"})
        disp = HttpDispatcher(db, "http://10.0.0.5:3001")
        disp.dispatch({"session_id": "s1"})  # 不抛
        meta = db.get_session_meta("s1")
        assert meta["dispatch_http_ok"] is False


def test_session_hangup_raises_when_rt_unconfirmed(monkeypatch):
    """review 返回 False(实时服务失联)→ SessionService.hangup 抛错,
    不静默标 completed(会话保持 in_progress 可重试)。"""
    from app.session_service import SessionService

    def boom(*a, **k):
        raise RuntimeError("connection refused")

    import httpx

    monkeypatch.setattr(httpx, "post", boom)
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="S",
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        _mk_events_table(ddb)
        db = Db(_settings(), resource=ddb)
        db.put_session_meta("s1", {"status": "in_progress"})
        svc = SessionService(db, HttpDispatcher(db, "http://10.0.0.5:3001"), max_concurrency=8)
        session = {"session_id": "s1", "status": "in_progress"}
        with pytest.raises(RuntimeError):
            svc.hangup(session)
        # 会话未被标 completed(保持 in_progress 可重试)
        assert session["status"] == "in_progress"


def test_recording_dispatcher_hangup_ok():
    """RecordingDispatcher.hangup 返回 True(落库即视为 OK),SessionService.hangup 正常完成。"""
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        _mk_events_table(ddb)
        db = Db(_settings(), resource=ddb)
        db.put_session_meta("s1", {"status": "in_progress"})
        assert RecordingDispatcher(db).hangup("s1") is True
