"""017 MCP 端点 e2e —— 符合 MCP Streamable HTTP transport(JSON-RPC 2.0 over POST /api/mcp)。

覆盖:委托 token 鉴权、initialize 握手、tools/list、tools/call(各工具)、继承 staff 边界、
协议版本头、通知 202、JSON-RPC 错误。agent 用标准 MCP client 即可接入。
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

# dimension_score rubric:纯人设(无题)Agent 也可预约(per_question_check 无题会 422,design contract)
_DIMENSION_RUBRIC = {"mode": "dimension_score",
                     "dimensions": [{"name": "综合", "max_score": 5, "weight": 1}]}


def _seed_agent(client, admin: dict, *, name: str, self_bookable: bool = True) -> str:
    body = {"name": name, "self_bookable": self_bookable, "rubric": _DIMENSION_RUBRIC}
    return client.post("/api/agents", json=body, headers=admin).json()["agent_id"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _future(minutes: int) -> str:
    return (datetime.now(UTC) + timedelta(minutes=minutes)).isoformat()


def _delegation_token(client, make_token, username="zhang@corp.com") -> str:
    staff = _auth(make_token(groups=["staff"], username=username))
    return client.post("/api/me/delegations", json={"label": "agent"}, headers=staff).json()["token"]


def _mcp(client, token, method, params=None, req_id=1) -> dict:
    body = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        body["params"] = params
    r = client.post("/api/mcp", json=body,
                    headers={"X-Delegation-Token": token, "MCP-Protocol-Version": "2025-06-18"})
    return r


# ── 鉴权 ──
def test_mcp_requires_delegation_token(client):
    r = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    assert r.status_code == 401


def test_mcp_bad_token(client):
    r = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                    headers={"X-Delegation-Token": "garbage"})
    assert r.status_code == 401


def test_mcp_bad_protocol_version(client, make_token):
    tok = _delegation_token(client, make_token)
    r = client.post("/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                    headers={"X-Delegation-Token": tok, "MCP-Protocol-Version": "1999-01-01"})
    assert r.status_code == 400


# ── initialize 握手 ──
def test_mcp_initialize(client, make_token):
    tok = _delegation_token(client, make_token)
    r = _mcp(client, tok, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    assert r.status_code == 200
    res = r.json()["result"]
    assert res["protocolVersion"] == "2025-06-18"
    assert res["serverInfo"]["name"] == "aim-meeting-agent"
    assert "tools" in res["capabilities"]


def test_mcp_initialized_notification_202(client, make_token):
    tok = _delegation_token(client, make_token)
    # 通知(无 id)→ 202 无 body
    r = client.post("/api/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                    headers={"X-Delegation-Token": tok})
    assert r.status_code == 202


# ── tools/list ──
def test_mcp_tools_list(client, make_token):
    """即时开始转向后 5 个工具(reschedule_meeting 已删——无预约窗可改)。"""
    tok = _delegation_token(client, make_token)
    r = _mcp(client, tok, "tools/list")
    tools = {t["name"] for t in r.json()["result"]["tools"]}
    assert tools == {"book_meeting", "cancel_meeting", "list_my_meetings",
                     "get_meeting_status", "list_self_bookable_agents"}
    assert "reschedule_meeting" not in tools
    # design contract 边界:MCP 继承 staff 预约边界,建 Agent/题库是 admin 操作,MUST NOT 经 MCP 暴露。
    for admin_tool in ("create_agent", "create_question_bank", "delete_agent", "update_agent"):
        assert admin_tool not in tools


# ── tools/call:完整预约流程 ──
def test_mcp_book_and_list_and_cancel(client, make_token, app_and_db):
    import json
    _, db = app_and_db
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin, name="MCP可约")
    tok = _delegation_token(client, make_token, username="mcp-user@corp.com")

    # book_meeting(即时开始:只传 agent_id,无时间窗)
    r = _mcp(client, tok, "tools/call", {
        "name": "book_meeting",
        "arguments": {"agent_id": pid},
    })
    assert r.status_code == 200, r.text
    booked = json.loads(r.json()["result"]["content"][0]["text"])
    sid = booked["session_id"]
    assert booked["status"] == "scheduled"
    # 落库 booked_by = 被代理 staff
    assert db.get_session(sid)["booked_by"] == "mcp-user@corp.com"

    # list_my_meetings 含刚约的
    r2 = _mcp(client, tok, "tools/call", {"name": "list_my_meetings", "arguments": {}})
    mine = json.loads(r2.json()["result"]["content"][0]["text"])
    assert any(m["session_id"] == sid for m in mine)

    # get_meeting_status
    r3 = _mcp(client, tok, "tools/call", {"name": "get_meeting_status", "arguments": {"session_id": sid}})
    assert json.loads(r3.json()["result"]["content"][0]["text"])["status"] == "scheduled"

    # cancel_meeting(无锁:scheduled 即可取消)
    r4 = _mcp(client, tok, "tools/call", {"name": "cancel_meeting", "arguments": {"session_id": sid}})
    assert json.loads(r4.json()["result"]["content"][0]["text"])["cancelled"] is True


# ── 继承 staff 边界:不可用非 self_bookable Profile ──
def test_mcp_book_rejects_non_bookable(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    pid = _seed_agent(client, admin, name="面试", self_bookable=False)
    tok = _delegation_token(client, make_token, username="u2@corp.com")
    r = _mcp(client, tok, "tools/call", {
        "name": "book_meeting",
        "arguments": {"agent_id": pid, "meeting_start": _future(120), "meeting_end": _future(180)},
    })
    # tools/call 业务错 → JSON-RPC error(INVALID_PARAMS)
    assert "error" in r.json()
    assert "自助" in r.json()["error"]["message"]


# ── 边界隔离:agent 看不到他人会话 ──
def test_mcp_cannot_access_others_session(client, make_token, app_and_db):
    _, db = app_and_db
    # 他人会话
    db.put_session({"session_id": "other-1", "booked_by": "someone-else@corp.com",
                    "status": "scheduled", "trigger": "manual", "origin": "staff",
                    "meeting_start": _future(120)})
    tok = _delegation_token(client, make_token, username="me@corp.com")
    r = _mcp(client, tok, "tools/call", {"name": "get_meeting_status", "arguments": {"session_id": "other-1"}})
    assert "error" in r.json()  # 不属于该 staff → INVALID_PARAMS「会话不存在」


# ── 未知方法 / 未知工具 ──
def test_mcp_unknown_method(client, make_token):
    tok = _delegation_token(client, make_token)
    r = _mcp(client, tok, "no/such/method")
    assert r.json()["error"]["code"] == -32601  # METHOD_NOT_FOUND


def test_mcp_unknown_tool(client, make_token):
    tok = _delegation_token(client, make_token)
    r = _mcp(client, tok, "tools/call", {"name": "frobnicate", "arguments": {}})
    assert "error" in r.json()
