"""GPU 容量管理 admin 路由(design contract)—— admin-only。

GET  /api/admin/gpu-capacity        读期望配置 + 运行时实况(看板)
PUT  /api/admin/gpu-capacity        改容量配置(fixed N / auto / 0 停机);乐观锁冲突 409
GET  /api/admin/gpu-capacity/instances  逐实例用量(代理读健康 GPU /metrics;MVP 可空)

backend 只读写 DDB,绝不调 AWS 控制面(由 capacity-reconciler Lambda 据期望对账,design contract)。
"""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import Principal
from ..capacity_service import GPU_HARD_MAX, CapacityConfigError, validate_config
from ..db import ConfigVersionConflict
from ..deps import require_admin

router = APIRouter(prefix="/api/admin/gpu-capacity", tags=["admin-capacity"])


def _db(request: Request):
    return request.app.state.db


def _now_iso() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()


@router.get("")
def get_capacity(request: Request, _: Principal = Depends(require_admin)) -> dict:
    """读容量期望配置 + 运行时实况。两者都可能缺失(首次部署 reconciler 尚未写)。"""
    db = _db(request)
    config = db.get_gpu_capacity_config()
    live = db.get_gpu_capacity_live()
    return {
        "config": config,  # None = 尚未配置(用部署期静态默认)
        "live": live,      # None = reconciler 尚未回写实况
        "hard_max": GPU_HARD_MAX,
    }


@router.put("")
def put_capacity(body: dict, request: Request, principal: Principal = Depends(require_admin)) -> dict:
    """改容量配置。校验(mode/count/min/max/util、硬上限)→ 乐观锁条件写(并发 admin 防覆盖)。

    body 须含 expected_version(GET 时读到的 config_version;首次配置传 null/省略)。
    校验失败 400;版本冲突/首次已存在 409。
    """
    try:
        normalized = validate_config(body, hard_max=GPU_HARD_MAX)
    except CapacityConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    db = _db(request)
    current = db.get_gpu_capacity_config()
    # expected_version 来自前端 GET 回显(乐观锁);首次配置(无记录)传 None,条件 = 记录不存在
    expected = body.get("expected_version")
    if current is not None and expected is None:
        # 已有配置但未带版本 → 拒绝盲写(强制前端先 GET 再改,避免覆盖他人)
        raise HTTPException(status_code=409, detail="配置已存在,请先读取当前版本再修改(缺 expected_version)")
    if current is not None and not isinstance(expected, int):
        raise HTTPException(status_code=400, detail="expected_version 须为整数")

    normalized.update({
        "config_version": int(current.get("config_version", 0)) if current else 0,
        "updated_by": principal.username or principal.sub,
        "updated_at": _now_iso(),
    })
    try:
        saved = db.put_gpu_capacity_config(
            normalized,
            expected_version=expected if current is not None else None,
        )
    except ConfigVersionConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return saved


@router.get("/instances")
def get_instances(request: Request, _: Principal = Depends(require_admin)) -> dict:
    """逐实例用量(展示用)。MVP **无逐实例明细**(需 NLB target→IP 反查后并发读各实例 /metrics,留 v1);
    本端点返回聚合实况 + `per_instance_source` 标签明示明细数据源状态(review:不返空数组冒充有数据)。"""
    db = _db(request)
    live = db.get_gpu_capacity_live() or {}
    return {
        # MVP 无逐实例明细 → null(非空数组,前端据此显示"逐实例明细 v1");v1 接 NLB 后回填
        "instances": live.get("instances") or None,
        "per_instance_source": "v1_pending",  # 明示明细数据源未接(诚实)
        "active_sessions_total": live.get("active_sessions_total", 0),
        "running_instances": live.get("running_instances", 0),
        "healthy_instances": live.get("healthy_instances", 0),
        "draining_instances": live.get("draining_instances", 0),
        "gpu_ws_endpoint": os.getenv("AIM_GPU_WS_URL", ""),
    }
