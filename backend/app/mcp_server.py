"""AIM MCP Server(design contract)—— 符合 MCP 协议的 endpoint,让第三方 agent 标准接入。

实现 MCP Streamable HTTP transport(2025-06-18)的服务端:JSON-RPC 2.0 over HTTP POST,
单端点 `/api/mcp`,返回 application/json(单响应,不做 SSE —— AIM 工具皆请求/响应式)。

鉴权:委托 token(X-Delegation-Token,staff 授权第三方 agent 代理自己)。每个工具调用都映射到
该 staff 本人的业务操作,继承 staff 边界(只能用 self_bookable Agent、只见自己的会议)。

支持方法:initialize / notifications/initialized / tools/list / tools/call / ping。
工具:list_self_bookable_agents / book_meeting(即时创建)/ list_my_meetings / get_meeting_status / cancel_meeting。
(reschedule_meeting 随即时开始转向删除——无预约窗可改。)
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from . import state_machine as sm
from .db import Db
from .session_service import (
    PerQuestionCheckRequiresQuestions,
    SessionService,
    assert_resolvable,
    build_session_record,
    make_dispatcher,
)

PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "aim-meeting-agent", "version": "1.0.0"}

# JSON-RPC 2.0 标准错误码
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


class McpError(Exception):
    """映射为 JSON-RPC error 的业务错误(code + message)。"""

    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def _rpc_result(req_id: Any, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _rpc_error(req_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


# ── 工具定义(tools/list 返回的 inputSchema)──
TOOLS = [
    {
        "name": "list_self_bookable_agents",
        "description": "列出可自助预约的 Agent(面试/培训 check 等,design contract),返回 agent_id 与名称。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "book_meeting",
        "description": ("代员工发起一场 AI 语音会话(考试/面试/练习),即时创建、立即可连入。"
                        "只需 agent_id;无需时间(即时开始模型无预约窗)。题库用 Agent 预设(不在此选)。"),
        "inputSchema": {
            "type": "object",
            "properties": {
                "agent_id": {"type": "string"},
            },
            "required": ["agent_id"],
        },
    },
    {
        "name": "list_my_meetings",
        "description": "列出该员工自己的会话(状态/时间)。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_meeting_status",
        "description": "查该员工某场会话的状态。",
        "inputSchema": {"type": "object", "properties": {"session_id": {"type": "string"}},
                        "required": ["session_id"]},
    },
    {
        "name": "cancel_meeting",
        "description": "取消该员工某场待连入的会话。",
        "inputSchema": {"type": "object", "properties": {"session_id": {"type": "string"}},
                        "required": ["session_id"]},
    },
]


class McpServer:
    """处理一条 JSON-RPC 消息。staff = 委托 token 解析出的被代理员工 identity。

    db / settings / dispatcher 由 router 注入(复用控制面同一套服务,不另起业务逻辑)。
    """

    def __init__(self, db: Db, settings, dispatcher=None):
        self.db = db
        self.settings = settings
        self.dispatcher = dispatcher

    def handle(self, msg: dict, *, staff: str) -> dict | None:
        """处理单条 JSON-RPC 消息。通知(无 id)返回 None(HTTP 202);请求返回 result/error 对象。"""
        if msg.get("jsonrpc") != "2.0":
            return _rpc_error(msg.get("id"), INVALID_REQUEST, "jsonrpc 必须为 2.0")
        method = msg.get("method")
        req_id = msg.get("id")
        is_notification = "id" not in msg

        # 通知:notifications/initialized 等 → 无响应(202)
        if is_notification:
            return None

        try:
            if method == "initialize":
                return _rpc_result(req_id, self._initialize())
            if method == "ping":
                return _rpc_result(req_id, {})
            if method == "tools/list":
                return _rpc_result(req_id, {"tools": TOOLS})
            if method == "tools/call":
                params = msg.get("params") or {}
                return _rpc_result(req_id, self._call_tool(
                    params.get("name", ""), params.get("arguments") or {}, staff=staff))
            return _rpc_error(req_id, METHOD_NOT_FOUND, f"未知方法: {method}")
        except McpError as exc:
            return _rpc_error(req_id, exc.code, exc.message)
        except Exception as exc:  # noqa: BLE001
            return _rpc_error(req_id, INTERNAL_ERROR, f"内部错误: {exc}")

    def _initialize(self) -> dict:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": "VivaVoce 助手:代员工预约/查询 AI 语音会话(考试/面试/练习)。",
        }

    # ── 工具调用 → 复用控制面业务 ──
    def _tool_content(self, data: Any) -> dict:
        """MCP tools/call 结果:content 数组(text 类型,JSON 文本)。"""
        import json
        return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}]}

    def _svc(self) -> SessionService:
        disp = self.dispatcher or make_dispatcher(self.db, self.settings.bridge_dial_url,
                                                  secret=self.settings.bridge_callback_secret)
        # design contract review:注入 webhook_emitter,否则 MCP agent 预约的会话终态不触发 webhook。
        from .events import make_webhook_emitter
        from .session_service import make_llm_config_store
        return SessionService(self.db, disp, max_concurrency=self.settings.max_concurrency,
                              webhook_emitter=make_webhook_emitter(self.db, self.settings),
                              llm_config_store=make_llm_config_store(self.settings),  # design contract
                              session_join_expire_min=self.settings.session_join_expire_min)

    def _call_tool(self, name: str, args: dict, *, staff: str) -> dict:
        if name == "list_self_bookable_agents":
            agents = self.db.list_agents(self_bookable_only=True)
            return self._tool_content([{"agent_id": a["agent_id"], "name": a.get("name", "")}
                                       for a in agents])

        if name == "book_meeting":
            return self._tool_content(self._book(staff, args))

        if name == "list_my_meetings":
            mine = self.db.list_sessions(owner=staff, trigger="manual", exclude_origin="candidate")
            return self._tool_content([{"session_id": s["session_id"], "status": s.get("status"),
                                        "meeting_start": s.get("meeting_start"),
                                        "agent_id": s.get("agent_id")} for s in mine])

        if name == "get_meeting_status":
            s = self.db.get_session(args.get("session_id", ""))
            if s is None or s.get("booked_by") != staff:
                raise McpError(INVALID_PARAMS, "会话不存在")
            return self._tool_content({"session_id": s["session_id"], "status": s.get("status"),
                                       "fail_reason": s.get("fail_reason"), "meeting_start": s.get("meeting_start")})

        if name == "cancel_meeting":
            return self._tool_content(self._cancel(staff, args.get("session_id", "")))

        raise McpError(METHOD_NOT_FOUND, f"未知工具: {name}")

    def _book(self, staff: str, args: dict) -> dict:
        agent_id = args.get("agent_id", "")
        agent = self.db.get_agent(agent_id)
        if agent is None:
            raise McpError(INVALID_PARAMS, "Agent 不存在")
        # 委托继承 staff 边界:只能用 self_bookable Agent
        if not agent.get("self_bookable"):
            raise McpError(INVALID_PARAMS, "该 Agent 不可自助预约")
        # 即时开始:无预约窗校验(创建即可连)
        # 题库:staff 自助不选,用 Agent 默认(design contract);不存在则纯人设对话
        bank_id = agent.get("default_question_bank_id")
        bank = self.db.get_question_bank(bank_id) if bank_id else None
        # 按 staff email upsert Target(source=self),与 011 自助一致
        target = self.db.upsert_target_by_external_id(staff, {"source": "self", "name": staff})
        session = build_session_record(
            agent=agent, bank=bank,
            booked_by=staff, origin="staff", target_id=target["target_id"],
            status=sm.SCHEDULED,  # 即时开始:创建即可连入(connected 事件推进)
        )
        # per_question_check 无题 fail-fast(design contract)
        try:
            assert_resolvable(agent, session.get("resolved_questions", []))
        except PerQuestionCheckRequiresQuestions as exc:
            raise McpError(INVALID_PARAMS, str(exc)) from exc
        self.db.put_session(session)
        self._svc().launch(session, agent)
        return {"session_id": session["session_id"], "status": session["status"]}

    def _cancel(self, staff: str, session_id: str) -> dict:
        s = self.db.get_session(session_id)
        if s is None or s.get("booked_by") != staff:
            raise McpError(INVALID_PARAMS, "会话不存在")
        if s.get("status") != sm.SCHEDULED:
            raise McpError(INVALID_PARAMS, "仅待连入(scheduled)的会话可取消")
        s.update({"status": sm.FAILED, "fail_reason": "cancelled", "ended_at": datetime.now(UTC).isoformat()})
        self.db.put_session(s)
        return {"session_id": session_id, "cancelled": True}
