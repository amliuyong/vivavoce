"""题库(QuestionBank)e2e(design contract)—— admin-only CRUD + 版本 + 删除引用完整性 409。
"""
from __future__ import annotations

_DIM_RUBRIC = {"mode": "dimension_score", "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _admin(make_token) -> dict:
    return _auth(make_token(groups=["admin"]))


def _staff(make_token) -> dict:
    return _auth(make_token(groups=["staff"]))


# ── admin-only ──
def test_question_bank_crud_admin_only(client, make_token):
    # staff 不可建/列
    assert client.post("/api/question-banks", json={"name": "x"}, headers=_staff(make_token)).status_code == 403
    assert client.get("/api/question-banks", headers=_staff(make_token)).status_code == 403


def test_create_question_bank(client, make_token):
    r = client.post("/api/question-banks", json={
        "name": "安全知识", "labels": ["安全"],
        "questions": [
            {"text": "什么是钓鱼邮件?", "reference_answer": "伪装可信来源诱导泄密", "weight": 2.0, "difficulty": 2},
            {"text": "密码多久换一次?", "difficulty": 1},
        ],
    }, headers=_admin(make_token))
    assert r.status_code == 201
    body = r.json()
    assert body["question_bank_id"].startswith("qb_")
    assert body["version"] == "v1"
    assert len(body["questions"]) == 2
    assert body["questions"][0]["difficulty"] == 2
    assert body["questions"][1]["difficulty"] == 1  # 显式
    # difficulty 缺省 → 3
    r2 = client.post("/api/question-banks", json={"name": "x", "questions": [{"text": "无难度"}]},
                     headers=_admin(make_token))
    assert r2.json()["questions"][0]["difficulty"] == 3


def test_question_bank_weight_validation(client, make_token):
    """题目 weight ≤ 0 → 422(承继 003 校验)。"""
    r = client.post("/api/question-banks", json={
        "name": "坏权重", "questions": [{"text": "Q", "weight": 0}],
    }, headers=_admin(make_token))
    assert r.status_code == 422


# ── 版本快照 ──
def test_question_bank_version_bump(client, make_token):
    qid = client.post("/api/question-banks", json={"name": "v1", "questions": [{"text": "Q1"}]},
                      headers=_admin(make_token)).json()["question_bank_id"]
    r = client.put(f"/api/question-banks/{qid}", json={"name": "v2", "questions": [{"text": "Q1"}, {"text": "Q2"}]},
                   headers=_admin(make_token))
    assert r.status_code == 200
    assert r.json()["version"] == "v2"
    assert len(r.json()["questions"]) == 2
    versions = client.get(f"/api/question-banks/{qid}/versions", headers=_admin(make_token)).json()
    assert versions["current_version"] == "v2"
    assert len(versions["versions"]) == 2


# ── 删除引用完整性(409) ──
def test_delete_bank_blocked_by_agent_default(client, make_token):
    """被某 Agent 设为 default_question_bank_id → 409(避免悬挂默认,design contract)。"""
    qid = client.post("/api/question-banks", json={"name": "默认库", "questions": [{"text": "Q1"}]},
                      headers=_admin(make_token)).json()["question_bank_id"]
    client.post("/api/agents", json={
        "name": "用它", "rubric": _DIM_RUBRIC, "default_question_bank_id": qid,
    }, headers=_admin(make_token))
    r = client.delete(f"/api/question-banks/{qid}", headers=_admin(make_token))
    assert r.status_code == 409
    assert "默认" in r.json()["detail"]


def test_delete_bank_blocked_by_active_session(client, make_token, app_and_db):
    _, db = app_and_db
    qid = client.post("/api/question-banks", json={"name": "占用库", "questions": [{"text": "Q1"}]},
                      headers=_admin(make_token)).json()["question_bank_id"]
    db.put_session({"session_id": "sess_q", "agent_id": "a", "question_bank_id": qid, "status": "scheduled"})
    r = client.delete(f"/api/question-banks/{qid}", headers=_admin(make_token))
    assert r.status_code == 409


def test_delete_bank_ok_when_unreferenced(client, make_token):
    qid = client.post("/api/question-banks", json={"name": "孤立库", "questions": [{"text": "Q1"}]},
                      headers=_admin(make_token)).json()["question_bank_id"]
    r = client.delete(f"/api/question-banks/{qid}", headers=_admin(make_token))
    assert r.status_code == 204
    assert client.get(f"/api/question-banks/{qid}", headers=_admin(make_token)).status_code == 404


# ── 终态会话(已固化)不算引用,不挡删 ──
def test_delete_bank_not_blocked_by_terminal_session(client, make_token, app_and_db):
    _, db = app_and_db
    qid = client.post("/api/question-banks", json={"name": "历史库", "questions": [{"text": "Q1"}]},
                      headers=_admin(make_token)).json()["question_bank_id"]
    # 终态会话(completed)已固化 resolved_questions,题库可删
    db.put_session({"session_id": "sess_done", "agent_id": "a", "question_bank_id": qid,
                    "status": "completed"})
    r = client.delete(f"/api/question-banks/{qid}", headers=_admin(make_token))
    assert r.status_code == 204


# ── CSV 批量上传(免逐题手加)──
_CSV_HDR = {"Content-Type": "text/csv"}


def _new_bank(client, make_token, questions=None) -> str:
    return client.post("/api/question-banks", json={"name": "csv库", "questions": questions or []},
                       headers=_admin(make_token)).json()["question_bank_id"]


def test_csv_template_download_admin_only(client, make_token):
    assert client.get("/api/question-banks/csv-template", headers=_staff(make_token)).status_code == 403
    r = client.get("/api/question-banks/csv-template", headers=_admin(make_token))
    assert r.status_code == 200
    assert "text/csv" in r.headers["content-type"]
    # design contract:题目级 follow_up 已废弃(追问=Agent 人设行为)——CSV 模板不再含该列。
    assert "text,reference_answer,weight,difficulty" in r.text
    assert "follow_up" not in r.text


def test_csv_upload_append(client, make_token):
    qid = _new_bank(client, make_token, [{"text": "原有题"}])
    # design contract:CSV 无 follow_up 列。历史 CSV 若仍带该列,多余列被忽略(向后兼容)——此处用新格式。
    csv = ("text,reference_answer,weight,difficulty\r\n"
           "新题一,参考答案,2.0,2\r\n"
           "新题二,,1.0,4\r\n")
    r = client.post(f"/api/question-banks/{qid}/upload-csv?mode=append",
                    content=csv.encode("utf-8"), headers={**_admin(make_token), **_CSV_HDR})
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "append"
    assert body["imported"] == 2
    assert body["rejected"] == 0
    assert body["total_questions"] == 3  # 1 原有 + 2 新
    # 入库校验:题目不再含 follow_up 字段(design contract)。
    bank = client.get(f"/api/question-banks/{qid}", headers=_admin(make_token)).json()
    assert len(bank["questions"]) == 3
    assert bank["questions"][1]["text"] == "新题一"
    assert "follow_up" not in bank["questions"][1]
    assert bank["questions"][1]["difficulty"] == 2


def test_csv_upload_replace(client, make_token):
    qid = _new_bank(client, make_token, [{"text": "旧题1"}, {"text": "旧题2"}])
    csv = "text\r\n全新题\r\n"
    r = client.post(f"/api/question-banks/{qid}/upload-csv?mode=replace",
                    content=csv.encode("utf-8"), headers={**_admin(make_token), **_CSV_HDR})
    assert r.status_code == 200
    assert r.json()["total_questions"] == 1  # 整替,旧题清掉
    bank = client.get(f"/api/question-banks/{qid}", headers=_admin(make_token)).json()
    assert [q["text"] for q in bank["questions"]] == ["全新题"]
    # 仅 text 列 → 其余用默认
    assert bank["questions"][0]["difficulty"] == 3
    assert bank["questions"][0]["weight"] == 1.0


def test_csv_upload_partial_errors(client, make_token):
    qid = _new_bank(client, make_token)
    csv = ("text,weight,difficulty\r\n"
           "好题,1.0,2\r\n"
           ",空题干,3\r\n"          # text 空 → 拒
           "weight坏,abc,3\r\n"      # weight 非数字 → 拒
           "难度越界,1.0,99\r\n")     # difficulty 越界 → 钳到 5,不拒
    r = client.post(f"/api/question-banks/{qid}/upload-csv?mode=append",
                    content=csv.encode("utf-8"), headers={**_admin(make_token), **_CSV_HDR})
    body = r.json()
    assert body["total_rows"] == 4
    assert body["imported"] == 2  # 好题 + 难度越界(钳5)
    assert body["rejected"] == 2
    assert {e["line"] for e in body["errors"]} == {3, 4}  # 数据行从 2 起
    bank = client.get(f"/api/question-banks/{qid}", headers=_admin(make_token)).json()
    assert bank["questions"][-1]["difficulty"] == 5  # 越界钳到 5


def test_csv_upload_default_mode_is_append(client, make_token):
    qid = _new_bank(client, make_token, [{"text": "原题"}])
    r = client.post(f"/api/question-banks/{qid}/upload-csv",  # 不带 mode
                    content="text\r\n追加题\r\n".encode(), headers={**_admin(make_token), **_CSV_HDR})
    assert r.status_code == 200
    assert r.json()["mode"] == "append"
    assert r.json()["total_questions"] == 2


def test_csv_upload_invalid_mode_422(client, make_token):
    qid = _new_bank(client, make_token)
    r = client.post(f"/api/question-banks/{qid}/upload-csv?mode=wipe",
                    content=b"text\r\nx\r\n", headers={**_admin(make_token), **_CSV_HDR})
    assert r.status_code == 422


def test_csv_upload_404_bank(client, make_token):
    r = client.post("/api/question-banks/qb_nope/upload-csv",
                    content=b"text\r\nx\r\n", headers={**_admin(make_token), **_CSV_HDR})
    assert r.status_code == 404


def test_csv_upload_admin_only(client, make_token):
    qid = _new_bank(client, make_token)
    r = client.post(f"/api/question-banks/{qid}/upload-csv",
                    content=b"text\r\nx\r\n", headers={**_staff(make_token), **_CSV_HDR})
    assert r.status_code == 403


def test_csv_upload_missing_text_column(client, make_token):
    qid = _new_bank(client, make_token)
    r = client.post(f"/api/question-banks/{qid}/upload-csv",
                    content="question,difficulty\r\n问题,3\r\n".encode(),
                    headers={**_admin(make_token), **_CSV_HDR})
    assert r.status_code == 200
    body = r.json()
    assert body["imported"] == 0
    assert body["rejected"] >= 1
    assert "text" in body["errors"][0]["reason"]


def test_csv_replace_all_bad_rows_rejected_not_wiped(client, make_token):
    """replace 模式 + CSV 全坏行 → 422 拒绝,题库**不被清空**(数据保护,review 必修)。"""
    qid = _new_bank(client, make_token, [{"text": "宝贵的旧题1"}, {"text": "宝贵的旧题2"}])
    bad_csv = "text\r\n\r\n\r\n"  # 全空 text 行
    r = client.post(f"/api/question-banks/{qid}/upload-csv?mode=replace",
                    content=bad_csv.encode("utf-8"), headers={**_admin(make_token), **_CSV_HDR})
    assert r.status_code == 422
    # 题库原题完好(未被清空)
    bank = client.get(f"/api/question-banks/{qid}", headers=_admin(make_token)).json()
    assert len(bank["questions"]) == 2


def test_csv_append_all_bad_rows_no_op(client, make_token):
    """append 模式 + 全坏行 → 不报 422(追加 0 题 = 无操作),题库原题保留。"""
    qid = _new_bank(client, make_token, [{"text": "旧题"}])
    r = client.post(f"/api/question-banks/{qid}/upload-csv?mode=append",
                    content=b"text\r\n\r\n", headers={**_admin(make_token), **_CSV_HDR})
    assert r.status_code == 200
    assert r.json()["imported"] == 0
    assert r.json()["total_questions"] == 1  # 旧题仍在


def test_csv_weight_negative_rejected(client, make_token):
    """weight ≤ 0 超域 → 该行被拒(weight 是计分依据,严格;走 Question 模型校验)。"""
    qid = _new_bank(client, make_token)
    csv = "text,weight\r\n好题,1.0\r\n负权题,-1.0\r\n零权题,0\r\n"
    r = client.post(f"/api/question-banks/{qid}/upload-csv?mode=append",
                    content=csv.encode("utf-8"), headers={**_admin(make_token), **_CSV_HDR})
    body = r.json()
    assert body["imported"] == 1  # 仅好题
    assert body["rejected"] == 2  # 负权 + 零权
    assert any("weight" in e["reason"].lower() for e in body["errors"])


def test_csv_duplicate_column_rejected(client, make_token):
    """规整后重复列名(如 Text 与 text)→ 明确报错,不静默丢列(review)。"""
    qid = _new_bank(client, make_token)
    r = client.post(f"/api/question-banks/{qid}/upload-csv?mode=append",
                    content=b"Text,text\r\na,b\r\n", headers={**_admin(make_token), **_CSV_HDR})
    body = r.json()
    assert body["imported"] == 0
    assert any("重复" in e["reason"] for e in body["errors"])


def test_csv_utf8_bom_tolerated(client, make_token):
    """Excel 导出的 UTF-8 BOM 被容忍(utf-8-sig),首列名不被 BOM 污染。"""
    qid = _new_bank(client, make_token)
    csv = "﻿text,difficulty\r\nBOM题,2\r\n"
    r = client.post(f"/api/question-banks/{qid}/upload-csv?mode=append",
                    content=csv.encode("utf-8"), headers={**_admin(make_token), **_CSV_HDR})
    assert r.json()["imported"] == 1
    bank = client.get(f"/api/question-banks/{qid}", headers=_admin(make_token)).json()
    assert bank["questions"][0]["text"] == "BOM题"
    assert bank["questions"][0]["difficulty"] == 2
