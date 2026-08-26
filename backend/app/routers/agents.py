"""Agent 路由(design contract,取代 003 的 Profile 路由)。

Agent = 人设 + rubric + engine + 出题策略 + self_bookable + 版本(不再内嵌题目;题库见 questionbanks.py)。

角色门控:
  - admin:列全部 / 建 / 改 / 看版本历史 / 删(全权)
  - staff:只能列 self_bookable=true 的 Agent(用于自助预约下拉,design contract)

rubric 形态/strategy_n 校验由 models 的 model_validator 强制(非法 body → FastAPI 422)。
版本快照:改版不覆盖历史(db.update_agent)。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .. import state_machine as sm
from ..auth import Principal
from ..deps import require_admin, require_user
from ..models import AgentIn, AgentOut, AgentVersionsOut

router = APIRouter(prefix="/api/agents", tags=["agents"])


def _db(request: Request):
    return request.app.state.db


def validate_default_bank(db, agent_in: AgentIn) -> None:
    """default_question_bank_id 存在性校验(design contract review;design contract 机器端点复用,故去下划线)。

    Agent 入库前确认默认题库真实存在,否则 staff 自助一选该 Agent 就拿到悬挂引用 → 发起时 404。
    在 API 层早拒(422),不让悬挂默认入库。
    """
    bank_id = agent_in.default_question_bank_id
    if bank_id and db.get_question_bank(bank_id) is None:
        raise HTTPException(status_code=422, detail=f"默认题库 {bank_id} 不存在")


def assert_agent_deletable(db, agent_id: str) -> None:
    """Agent 删除引用完整性检查(design contract;design contract 机器端点复用)。不满足 → 409,满足 → 返回。

    2 类引用挡删:① 活动会话(scheduled/in_progress)——删了会让进行中会话拿不到 Agent;
    ② 招聘时段 Slot——删了候选人认领时拿不到 Agent。终态/历史会话不挡(已快照版本)。
    调用方须先确认 agent 存在(本函数只查引用,不查存在性)。
    """
    active = [
        s for s in db.list_sessions()
        if s.get("agent_id") == agent_id and s.get("status") in sm.ACTIVE_STATES
    ]
    if active:
        raise HTTPException(
            status_code=409,
            detail=f"该 Agent 仍被 {len(active)} 个进行中的会话引用,无法删除(请先结束这些会话)",
        )
    slots = [s for s in db.list_slots() if s.get("agent_id") == agent_id]
    if slots:
        raise HTTPException(
            status_code=409,
            detail=f"该 Agent 仍被 {len(slots)} 个招聘时段引用,无法删除(请先处理这些时段)",
        )


@router.get("", response_model=list[AgentOut])
def list_agents(
    request: Request, principal: Principal = Depends(require_user)
) -> list[dict]:
    # staff 只看可自助预约的;admin 看全部
    self_only = not principal.is_admin
    return _db(request).list_agents(self_bookable_only=self_only)


@router.post("", response_model=AgentOut, status_code=201)
def create_agent(
    body: AgentIn, request: Request, _: Principal = Depends(require_admin)
) -> dict:
    db = _db(request)
    validate_default_bank(db, body)
    agent = body.model_dump()
    agent.update({"agent_id": f"agent_{uuid.uuid4().hex[:12]}", "version": "v1", "status": "active",
                  # created_at:列表按它倒序(最新在前,见 db.list_agents);admin Web 建的也享受排序。
                  "created_at": datetime.now(UTC).isoformat()})
    return db.put_agent(agent)


@router.get("/{agent_id}", response_model=AgentOut)
def get_agent(
    agent_id: str, request: Request, principal: Principal = Depends(require_user)
) -> dict:
    agent = _db(request).get_agent(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    # staff 不能看非自助 Agent(防越权拿面试官 Agent)
    if not principal.is_admin and not agent.get("self_bookable"):
        raise HTTPException(status_code=403, detail="无权访问该 Agent")
    return agent


@router.put("/{agent_id}", response_model=AgentOut)
def update_agent(
    agent_id: str, body: AgentIn, request: Request, _: Principal = Depends(require_admin)
) -> dict:
    """改版不覆盖历史(design contract):当前版本入 version_history、version bump。"""
    db = _db(request)
    validate_default_bank(db, body)
    updated = db.update_agent(agent_id, body.model_dump())
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    return updated


@router.get("/{agent_id}/versions", response_model=AgentVersionsOut)
def get_agent_versions(
    agent_id: str, request: Request, _: Principal = Depends(require_admin)
) -> dict:
    """版本历史(design contract):当前版本 + 历史快照,供报告按发起时版本回溯依据。"""
    agent = _db(request).get_agent(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    history = list(agent.get("version_history", []))
    current = {k: v for k, v in agent.items() if k != "version_history"}
    versions = [*history, current]
    return {
        "agent_id": agent_id,
        "current_version": agent.get("version", "v1"),
        "versions": versions,
    }


@router.delete("/{agent_id}", status_code=204)
def delete_agent(
    agent_id: str, request: Request, _: Principal = Depends(require_admin)
) -> Response:
    """删除 Agent(design contract,仅 admin)。

    不存在 → 404;仍被**活动会话**(scheduled/in_progress)或**招聘时段 Slot**引用 → 409
    (先处理引用再删,避免悬挂引用)。终态/历史会话不挡(已快照版本)。
    """
    db = _db(request)
    if db.get_agent(agent_id) is None:
        raise HTTPException(status_code=404, detail="Agent 不存在")
    assert_agent_deletable(db, agent_id)  # 活动会话 / 时段 Slot 引用 → 409(design contract 与机器端点共用)
    db.delete_agent(agent_id)
    return Response(status_code=204)
