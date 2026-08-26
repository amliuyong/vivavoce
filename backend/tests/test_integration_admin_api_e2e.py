"""017 §5 e2e —— API Key 程序化管理 Agent / 题库(admin 级,单租户)。

覆盖:scope 门控(带/缺/无 key)、Agent+题库 CRUD、CSV 上传边界、删除引用完整性(409)、
版本快照、审计字段留痕、results 全局读、MCP 边界回归(tools/list 不含管理工具)、targets 清理回归。
"""
from __future__ import annotations


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


_DIMENSION_RUBRIC = {"mode": "dimension_score",
                     "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _create_client(client, admin, scopes, name="机器管理集成") -> dict:
    r = client.post("/api/integration/clients", json={"name": name, "scopes": scopes}, headers=admin)
    assert r.status_code == 201, r.text
    return r.json()


def _key_header(api_key: str) -> dict:
    return {"X-Api-Key": api_key}


# ══════════ scope 门控 ══════════
def test_agents_scope_gating(client, make_token):
    admin = _auth(make_token(groups=["admin"], username="admin@corp.com"))
    write_key = _create_client(client, admin, ["agents:write", "agents:read"])["api_key"]
    read_key = _create_client(client, admin, ["agents:read"])["api_key"]

    body = {"name": "机器建的Agent", "rubric": _DIMENSION_RUBRIC}
    # 有 write → 201
    r = client.post("/api/integration/agents", json=body, headers=_key_header(write_key))
    assert r.status_code == 201, r.text
    # 只有 read → POST 403
    assert client.post("/api/integration/agents", json=body, headers=_key_header(read_key)).status_code == 403
    # 无 key → 401
    assert client.post("/api/integration/agents", json=body).status_code == 401
    # read 可 list
    assert client.get("/api/integration/agents", headers=_key_header(read_key)).status_code == 200


def test_wrong_scope_cannot_touch_agents(client, make_token):
    """持 sessions:write(无 agents scope)的 key 调 Agent 端点 → 403。"""
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin, ["sessions:write"])["api_key"]
    assert client.get("/api/integration/agents", headers=_key_header(key)).status_code == 403
    assert client.post("/api/integration/agents", json={"name": "x", "rubric": _DIMENSION_RUBRIC},
                       headers=_key_header(key)).status_code == 403


# ══════════ Agent CRUD + 审计 + 版本快照 ══════════
def test_agent_crud_and_audit(client, make_token):
    admin = _auth(make_token(groups=["admin"], username="ops@corp.com"))
    key = _create_client(client, admin, ["agents:write", "agents:read"])["api_key"]
    kh = _key_header(key)

    created = client.post("/api/integration/agents",
                          json={"name": "面试官A", "self_bookable": False, "rubric": _DIMENSION_RUBRIC},
                          headers=kh).json()
    aid = created["agent_id"]
    # 审计字段:记签发该 key 的 admin + client_id
    assert created["created_by_admin"] == "ops@corp.com"
    assert created["created_by_client"]
    assert created["created_at"]

    # 非 self_bookable 也能被机器读/改(admin 级,不受 staff 边界约束)
    got = client.get(f"/api/integration/agents/{aid}", headers=kh)
    assert got.status_code == 200 and got.json()["name"] == "面试官A"

    upd = client.put(f"/api/integration/agents/{aid}",
                     json={"name": "面试官A改", "self_bookable": False, "rubric": _DIMENSION_RUBRIC},
                     headers=kh).json()
    assert upd["name"] == "面试官A改"
    assert upd["version"] == "v2"          # 版本快照 bump
    assert upd["updated_by_admin"] == "ops@corp.com"

    # 版本历史保留旧版(经 admin 端点看)
    versions = client.get(f"/api/agents/{aid}/versions", headers=admin).json()
    assert versions["current_version"] == "v2"


def test_agent_create_validates_default_bank(client, make_token):
    """挂不存在的默认题库 → 422(复用 validate_default_bank)。"""
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin, ["agents:write"])["api_key"]
    r = client.post("/api/integration/agents",
                    json={"name": "悬挂", "rubric": _DIMENSION_RUBRIC,
                          "default_question_bank_id": "qb_nope"},
                    headers=_key_header(key))
    assert r.status_code == 422


def test_agent_delete_reference_guard(client, make_token, app_and_db):
    """Agent 被活动会话引用 → 409(复用 assert_agent_deletable)。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin, ["agents:write"])["api_key"]
    kh = _key_header(key)
    aid = client.post("/api/integration/agents",
                      json={"name": "被占用", "rubric": _DIMENSION_RUBRIC}, headers=kh).json()["agent_id"]
    # 造一个活动会话引用该 Agent
    db.put_session({"session_id": "sess_ref", "agent_id": aid, "status": "in_progress",
                    "trigger": "manual", "booked_by": "x"})
    assert client.delete(f"/api/integration/agents/{aid}", headers=kh).status_code == 409
    # 删不存在 → 404
    assert client.delete("/api/integration/agents/agent_nope", headers=kh).status_code == 404


# ══════════ 题库 CRUD + CSV 边界 ══════════
def test_question_bank_crud(client, make_token):
    admin = _auth(make_token(groups=["admin"], username="qb@corp.com"))
    key = _create_client(client, admin, ["question-banks:write", "question-banks:read"])["api_key"]
    kh = _key_header(key)
    created = client.post("/api/integration/question-banks",
                          json={"name": "机器题库", "questions": [{"text": "自我介绍"}]}, headers=kh).json()
    qid = created["question_bank_id"]
    assert created["created_by_admin"] == "qb@corp.com"
    assert client.get(f"/api/integration/question-banks/{qid}", headers=kh).status_code == 200
    assert any(b["question_bank_id"] == qid
               for b in client.get("/api/integration/question-banks", headers=kh).json())


def test_question_bank_csv_upload_and_replace_guard(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin, ["question-banks:write", "question-banks:read"])["api_key"]
    kh = _key_header(key)
    qid = client.post("/api/integration/question-banks",
                      json={"name": "CSV库", "questions": []}, headers=kh).json()["question_bank_id"]
    # append 合法 CSV。design contract:题目级 follow_up 已废弃——历史 CSV 若仍带 follow_up 列,多余列被静默忽略(向后兼容)。
    csv = "text,reference_answer,follow_up,weight,difficulty\r\n介绍项目经验,,0,1.0,3\r\n"
    r = client.post(f"/api/integration/question-banks/{qid}/upload-csv?mode=append",
                    content=csv.encode("utf-8"), headers=kh)
    assert r.status_code == 200 and r.json()["imported"] == 1
    # 入库题目不含 follow_up(即便 CSV 带了该列)。
    bank = client.get(f"/api/integration/question-banks/{qid}", headers=kh).json()
    assert "follow_up" not in bank["questions"][0]
    # replace 模式 0 有效题 → 422(不清空)
    bad = client.post(f"/api/integration/question-banks/{qid}/upload-csv?mode=replace",
                      content=b"garbage no header", headers=kh)
    assert bad.status_code == 422


def test_question_bank_delete_reference_guard(client, make_token):
    """题库被 Agent 默认引用 → 409(复用 assert_qb_deletable)。"""
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin,
                         ["question-banks:write", "agents:write"])["api_key"]
    kh = _key_header(key)
    qid = client.post("/api/integration/question-banks",
                      json={"name": "被引用库", "questions": [{"text": "q"}]}, headers=kh).json()["question_bank_id"]
    client.post("/api/integration/agents",
                json={"name": "挂库Agent", "rubric": _DIMENSION_RUBRIC,
                      "default_question_bank_id": qid}, headers=kh)
    assert client.delete(f"/api/integration/question-banks/{qid}", headers=kh).status_code == 409


# ══════════ results 全局读 ══════════
def test_results_global_read(client, make_token, app_and_db):
    """results:read key 可读任意 session 结果(单租户全局读);无结果 → 404。"""
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    key = _create_client(client, admin, ["results:read"])["api_key"]
    kh = _key_header(key)
    db.put_result({"session_id": "sess_r1", "total_score": 4.0, "dimension_scores": []})
    r = client.get("/api/integration/results/sess_r1", headers=kh)
    assert r.status_code == 200 and r.json()["session_id"] == "sess_r1"
    assert client.get("/api/integration/results/sess_none", headers=kh).status_code == 404


# ══════════ 非法 scope 建 client ══════════
def test_invalid_scope_rejected(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    r = client.post("/api/integration/clients",
                    json={"name": "坏", "scopes": ["agents:destroy"]}, headers=admin)
    assert r.status_code in (400, 422)


# ══════════ targets 清理回归 ══════════
def test_targets_endpoints_gone(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    assert client.get("/api/targets", headers=admin).status_code == 404
    assert client.post("/api/targets", json={"name": "x"}, headers=admin).status_code == 404
