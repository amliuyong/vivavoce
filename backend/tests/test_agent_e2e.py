"""Agent e2e(design contract)—— CRUD + strategy_n 校验 + self_bookable 门控 + default_question_bank_id。

经真实 HTTP(TestClient)打鉴权 + 路由 + DDB(moto)。
"""
from __future__ import annotations

_DIM_RUBRIC = {"mode": "dimension_score", "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _admin(make_token) -> dict:
    return _auth(make_token(groups=["admin"]))


def _staff(make_token) -> dict:
    return _auth(make_token(groups=["staff"]))


# ── strategy_n 校验:random 类策略必须 > 0 ──
def test_random_n_requires_strategy_n(client, make_token):
    """question_strategy=random_n 但缺 strategy_n → 422(脏 Agent 不入库,design contract)。"""
    r = client.post("/api/agents", json={
        "name": "随机抽题", "rubric": _DIM_RUBRIC, "question_strategy": "random_n",
    }, headers=_admin(make_token))
    assert r.status_code == 422


def test_random_n_zero_strategy_n_rejected(client, make_token):
    r = client.post("/api/agents", json={
        "name": "随机抽题", "rubric": _DIM_RUBRIC, "question_strategy": "random_n", "strategy_n": 0,
    }, headers=_admin(make_token))
    assert r.status_code == 422


def test_random_n_valid_strategy_n_ok(client, make_token):
    r = client.post("/api/agents", json={
        "name": "随机抽题", "rubric": _DIM_RUBRIC, "question_strategy": "random_n", "strategy_n": 5,
    }, headers=_admin(make_token))
    assert r.status_code == 201
    assert r.json()["question_strategy"] == "random_n"
    assert r.json()["strategy_n"] == 5


def test_sequential_ignores_strategy_n(client, make_token):
    """非 random 策略 strategy_n 可缺省(被忽略,不报错)。"""
    r = client.post("/api/agents", json={
        "name": "顺序", "rubric": _DIM_RUBRIC, "question_strategy": "sequential",
    }, headers=_admin(make_token))
    assert r.status_code == 201
    assert r.json()["question_strategy"] == "sequential"


def test_random_n_easy_to_hard_requires_strategy_n(client, make_token):
    r = client.post("/api/agents", json={
        "name": "混合", "rubric": _DIM_RUBRIC, "question_strategy": "random_n_easy_to_hard",
    }, headers=_admin(make_token))
    assert r.status_code == 422


# ── self_bookable 门控:staff 只见可自助的 Agent ──
def test_staff_only_sees_self_bookable(client, make_token):
    client.post("/api/agents", json={"name": "面试官", "rubric": _DIM_RUBRIC, "self_bookable": False},
                headers=_admin(make_token))
    client.post("/api/agents", json={"name": "培训check", "rubric": _DIM_RUBRIC, "self_bookable": True},
                headers=_admin(make_token))
    r = client.get("/api/agents", headers=_staff(make_token))
    assert r.status_code == 200
    names = {a["name"] for a in r.json()}
    assert "培训check" in names
    assert "面试官" not in names  # 非自助不暴露给 staff


def test_staff_cannot_get_non_self_bookable_agent(client, make_token):
    aid = client.post("/api/agents", json={"name": "面试官", "rubric": _DIM_RUBRIC, "self_bookable": False},
                      headers=_admin(make_token)).json()["agent_id"]
    r = client.get(f"/api/agents/{aid}", headers=_staff(make_token))
    assert r.status_code == 403


# ── default_question_bank_id ──
def test_agent_default_question_bank_persisted(client, make_token):
    qb = client.post("/api/question-banks", json={
        "name": "安全题库", "questions": [{"text": "Q1"}],
    }, headers=_admin(make_token)).json()
    r = client.post("/api/agents", json={
        "name": "带默认题库", "rubric": _DIM_RUBRIC,
        "default_question_bank_id": qb["question_bank_id"],
    }, headers=_admin(make_token))
    assert r.status_code == 201
    assert r.json()["default_question_bank_id"] == qb["question_bank_id"]


# ── design contract:show_subtitles 顶层字段(默认开)round-trip ──
def test_agent_show_subtitles_defaults_none_and_persists(client, make_token):
    """未配 show_subtitles → 存 None(= 默认开,向后兼容 design contract);显式 false 持久化。"""
    # 缺省:None(默认开)
    r_default = client.post("/api/agents", json={"name": "默认字幕", "rubric": _DIM_RUBRIC},
                            headers=_admin(make_token))
    assert r_default.status_code == 201
    assert r_default.json()["show_subtitles"] is None  # 缺省 = None = 默认开
    # 显式关:false 持久化(顶层字段,非 engine 嵌套)
    r_off = client.post("/api/agents", json={
        "name": "无字幕Agent", "rubric": _DIM_RUBRIC, "show_subtitles": False,
    }, headers=_admin(make_token))
    assert r_off.status_code == 201
    aid = r_off.json()["agent_id"]
    assert r_off.json()["show_subtitles"] is False
    # GET 回读一致
    got = client.get(f"/api/agents/{aid}", headers=_admin(make_token)).json()
    assert got["show_subtitles"] is False


# ── design contract:avatar_style 顶层字段(Literal 守门 + round-trip)──
def test_agent_avatar_style_literal_and_roundtrip(client, make_token):
    """design contract:avatar_style 合法四枚举 round-trip;缺省 None(前端兜底 minimal);非法值 Pydantic Literal 422。"""
    # 缺省:None(前端兜底 minimal)
    r_default = client.post("/api/agents", json={"name": "默认头像", "rubric": _DIM_RUBRIC},
                            headers=_admin(make_token))
    assert r_default.status_code == 201
    assert r_default.json()["avatar_style"] is None
    # 合法四值 round-trip
    for style in ("minimal", "round", "tech", "waveform"):
        r = client.post("/api/agents", json={"name": f"头像{style}", "rubric": _DIM_RUBRIC, "avatar_style": style},
                        headers=_admin(make_token))
        assert r.status_code == 201, r.text
        aid = r.json()["agent_id"]
        assert r.json()["avatar_style"] == style
        assert client.get(f"/api/agents/{aid}", headers=_admin(make_token)).json()["avatar_style"] == style
    # 非法值:Pydantic Literal 天然 422 守门(不静默入库脏值)
    r_bad = client.post("/api/agents", json={"name": "脏头像", "rubric": _DIM_RUBRIC, "avatar_style": "bogus"},
                        headers=_admin(make_token))
    assert r_bad.status_code == 422


# ── 版本快照:改版不覆盖历史 ──
def test_agent_version_bump_and_history(client, make_token):
    aid = client.post("/api/agents", json={"name": "v1名", "rubric": _DIM_RUBRIC},
                      headers=_admin(make_token)).json()["agent_id"]
    r = client.put(f"/api/agents/{aid}", json={"name": "v2名", "rubric": _DIM_RUBRIC},
                   headers=_admin(make_token))
    assert r.status_code == 200
    assert r.json()["version"] == "v2"
    versions = client.get(f"/api/agents/{aid}/versions", headers=_admin(make_token)).json()
    assert versions["current_version"] == "v2"
    assert len(versions["versions"]) == 2


# ── 删除被引用 409(活动会话) ──
def test_delete_agent_blocked_by_active_session(client, make_token, app_and_db):
    _, db = app_and_db
    aid = client.post("/api/agents", json={"name": "占用中", "rubric": _DIM_RUBRIC, "self_bookable": True},
                      headers=_admin(make_token)).json()["agent_id"]
    # 直接落一条活动会话引用该 agent
    db.put_session({"session_id": "sess_x", "agent_id": aid, "status": "in_progress"})
    r = client.delete(f"/api/agents/{aid}", headers=_admin(make_token))
    assert r.status_code == 409


def test_delete_agent_blocked_by_slot(client, make_token, app_and_db):
    """Agent 被招聘时段引用 → 409(review:删 Agent 会让时段认领时拿不到 Agent)。"""
    _, db = app_and_db
    aid = client.post("/api/agents", json={"name": "面试官", "rubric": _DIM_RUBRIC},
                      headers=_admin(make_token)).json()["agent_id"]
    db.put_slot({"slot_id": "slot_x", "engagement_id": "eng1", "agent_id": aid, "status": "open"})
    r = client.delete(f"/api/agents/{aid}", headers=_admin(make_token))
    assert r.status_code == 409


# ── 预置「自由对话」Agent 恒排第一(scan 无序,list_agents 稳定置顶)──
def test_freechat_agent_sorted_first(client, make_token, app_and_db):
    _, db = app_and_db
    for n in ("其它A", "其它B", "其它C"):  # 先落若干普通 Agent
        client.post("/api/agents", json={"name": n, "rubric": _DIM_RUBRIC, "self_bookable": True},
                    headers=_admin(make_token))
    # 预置默认自由对话 Agent(固定 id,直接落库,模拟 seed)
    db.put_agent({"agent_id": "agent_freechat_default", "name": "自由对话",
                  "rubric": _DIM_RUBRIC, "self_bookable": True, "status": "active", "version": "v1"})

    for hdr in (_admin(make_token), _staff(make_token)):  # admin 与 staff(self_bookable_only)两路径都置顶
        items = client.get("/api/agents", headers=hdr).json()
        assert items[0]["agent_id"] == "agent_freechat_default", [a["agent_id"] for a in items]


# ── 其余 Agent 按 created_at 倒序(最新在前);无 created_at 的老数据垫底且顺序确定 ──
def test_agents_sorted_by_created_at_desc(client, make_token, app_and_db):
    _, db = app_and_db
    # 关键:混用两种时间戳格式 —— 生产写 `+00:00`(datetime.now(UTC).isoformat()),
    # 但遗留/导入数据可能是 `Z`。排序须对格式免疫(_created_at_key 归一化),否则同刻不同格式字典序错乱。
    db.put_agent({"agent_id": "agent_new", "name": "新", "created_at": "2026-07-08T00:00:00+00:00",
                  "rubric": _DIM_RUBRIC, "self_bookable": True, "status": "active", "version": "v1"})
    db.put_agent({"agent_id": "agent_mid", "name": "中", "created_at": "2026-07-05T00:00:00Z",  # Z 格式
                  "rubric": _DIM_RUBRIC, "self_bookable": True, "status": "active", "version": "v1"})
    db.put_agent({"agent_id": "agent_old", "name": "旧", "created_at": "2026-07-01T00:00:00+00:00",
                  "rubric": _DIM_RUBRIC, "self_bookable": True, "status": "active", "version": "v1"})
    db.put_agent({"agent_id": "agent_legacy_b", "name": "无时间B",
                  "rubric": _DIM_RUBRIC, "self_bookable": True, "status": "active", "version": "v1"})
    db.put_agent({"agent_id": "agent_legacy_a", "name": "无时间A",
                  "rubric": _DIM_RUBRIC, "self_bookable": True, "status": "active", "version": "v1"})
    db.put_agent({"agent_id": "agent_freechat_default", "name": "自由对话", "created_at": "2020-01-01T00:00:00Z",
                  "rubric": _DIM_RUBRIC, "self_bookable": True, "status": "active", "version": "v1"})

    ids = [a["agent_id"] for a in client.get("/api/agents", headers=_admin(make_token)).json()]
    # ① 自由对话置顶(即便 created_at 最老)
    assert ids[0] == "agent_freechat_default", ids
    # ② 有 created_at 的按倒序(跨 Z/+00:00 格式):新(7-08) > 中(7-05,Z) > 旧(7-01)
    assert ids.index("agent_new") < ids.index("agent_mid") < ids.index("agent_old"), ids
    # ③ 无 created_at 的老数据排在有时间的之后
    assert ids.index("agent_old") < ids.index("agent_legacy_a"), ids
    # ④ 无 created_at 的彼此按 agent_id 升序(确定性,不随 scan 漂移)
    assert ids.index("agent_legacy_a") < ids.index("agent_legacy_b"), ids


# ── created_at 排序对时间戳格式免疫(Z vs +00:00 同刻不乱序;回归 review 发现)──
def test_created_at_key_format_agnostic():
    from datetime import datetime

    from app.db import _created_at_key
    # 同一时刻,Z 与 +00:00 两种写法 → 归一化后相等(字典序会误判 Z > +)
    assert _created_at_key("2026-07-08T00:00:00Z") == _created_at_key("2026-07-08T00:00:00+00:00")
    # Z 格式的更晚时刻 > +00:00 的更早时刻(按真实时间,非字典序)
    assert _created_at_key("2026-07-08T00:00:00Z") > _created_at_key("2026-07-01T00:00:00+00:00")
    # 缺失/非法 → datetime.min(排最后)
    assert _created_at_key(None) == datetime.min
    assert _created_at_key("") == datetime.min
    assert _created_at_key("not-a-date") == datetime.min
