"""三段式 LLM 配置 admin 路由(design contract)—— admin-only,fail-closed。

GET  /api/admin/llm-config   读非密参数(host/models/default_model)+ key 脱敏(has_key+末4);明文 token 绝不回显
PUT  /api/admin/llm-config   写非密参数 + 可选 token → Secrets Manager

对齐 design contract admin_tts 模式(require_admin、读写分离、瞬时读失败 fail-closed 不覆盖)。
key 写经 Secrets Manager(单一 Secret 承载 token + 非密参数 JSON),读 MUST 脱敏,不入 DDB/日志。
凭据模型:仅控制面读此 Secret;发起时逐通注入就绪指令(见 session_service),实时服务不持久(design contract)。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import Principal
from ..deps import require_admin
from ..llm_config_service import (
    RECOMMENDED_MODELS,
    LlmConfigError,
    LlmConfigStore,
    masked_view,
    merge_config,
    validate_config_patch,
    validate_default_in_models,
)

logger = logging.getLogger("aim.admin_llm")

router = APIRouter(prefix="/api/admin/llm-config", tags=["admin-llm"])


def _store(request: Request) -> LlmConfigStore:
    return LlmConfigStore(request.app.state.settings)


@router.get("")
def get_llm_config(request: Request, _: Principal = Depends(require_admin)) -> dict:
    """读 LLM 配置(脱敏)。Secret 未配置(本地/未部署 025)→ fail-closed 503。
    附 recommended(前端预填推荐清单;非强制)。"""
    store = _store(request)
    if not store.secret_id:
        raise HTTPException(status_code=503, detail="LLM 配置未启用(AIM_LLM_CONFIG_SECRET_ID 未配置)")
    raw = store.read_raw()
    return {"config": masked_view(raw), "recommended": RECOMMENDED_MODELS}


@router.put("")
def put_llm_config(body: dict, request: Request, _: Principal = Depends(require_admin)) -> dict:
    """改 LLM 配置。校验非密参数 → merge 现有(保留旧 token,除非 body 带 api_key)→ 写 Secret。

    body:host/models/default_model(非密)+ 可选 api_key(写后只脱敏回显)。
      - 不带 api_key / api_key="":保留现有 token(前端密码框留空即不改);
      - api_key 非空:替换。
    校验:host https、models 结构、default_model ∈ models(合并后)。
    """
    store = _store(request)
    if not store.secret_id:
        raise HTTPException(status_code=503, detail="LLM 配置未启用(AIM_LLM_CONFIG_SECRET_ID 未配置)")
    try:
        patch = validate_config_patch(body)
    except LlmConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # api_key 处理(对齐 minimax:空串/None → 不改,避免误传空串抹掉生产 token;清空需直接改 Secret)。
    new_key = None
    if "api_key" in body:
        ak = body.get("api_key")
        if ak is not None and not isinstance(ak, str):
            raise HTTPException(status_code=400, detail="api_key 须为字符串")
        new_key = ak if ak else None
    # design contract:bedrock_api_key 处理(converse 凭据,同 api_key 语义:空/None 不改)。
    new_bedrock_key = None
    if "bedrock_api_key" in body:
        bak = body.get("bedrock_api_key")
        if bak is not None and not isinstance(bak, str):
            raise HTTPException(status_code=400, detail="bedrock_api_key 须为字符串")
        new_bedrock_key = bak if bak else None
    if new_bedrock_key is not None and "bedrock_api_key_expires_at" not in body:
        raise HTTPException(status_code=400, detail="更换 Bedrock API Key 时必须填写到期时间")

    # 读现有:瞬时读失败(非 NotFound)→ read_raw 抛错 → 502,绝不拿空配置 merge 覆盖现有 token。
    try:
        current = store.read_raw()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读 LLM Secret 失败,拒绝写入以免覆盖现有配置: %s", exc)
        raise HTTPException(status_code=502, detail="读取现有配置失败,未写入(请重试,避免覆盖现有 token)") from exc

    merged = merge_config(current, patch, new_api_key=new_key, new_bedrock_api_key=new_bedrock_key)
    try:
        validate_default_in_models(merged)
    except LlmConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 启用自定义必须有**当前 call_method 对应的**凭据(现存或本次填);关闭时允许无凭据(走 Haiku/IAM,disable 态)。
    # design contract:mantle → api_key;bedrock_converse → bedrock_api_key(按方式校验,不混用)。
    from ..llm_config_service import active_credential, call_method  # noqa: PLC0415
    if merged.get("enabled") and not active_credential(merged):
        need = "Bedrock API Key" if call_method(merged) == "bedrock_converse" else "mantle Bearer token"
        raise HTTPException(status_code=400,
                            detail=f"启用自定义 LLM(call_method={call_method(merged)})需要配置 {need}(请填入,或关闭自定义用默认 Haiku)")

    try:
        store.write_raw(merged)
    except LlmConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — Secrets Manager 写失败:明确报错(不静默,不打含 token 的 raw)
        logger.warning("写 LLM Secret 失败: %s", exc)
        raise HTTPException(status_code=502, detail="写配置失败,请重试") from exc

    return {"config": masked_view(merged)}
