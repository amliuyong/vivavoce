"""MiniMax TTS provider 配置 admin 路由(design contract)—— admin-only,fail-closed。

GET  /api/admin/tts-config   读非密参数 + key 脱敏(has_key + 末4位);明文 key 绝不回显
PUT  /api/admin/tts-config   写非密参数 + 可选 key → Secrets Manager;写完 best-effort 调 GPU
                             /reload-tts-config,把重载回执(self-probe 是否通过)透传前端

对齐 admin_capacity 模式(require_admin、读写分离)。MiniMax 无 GroupId,故配置不含该项。
key 写经 Secrets Manager(单一 Secret 承载 key + 非密参数 JSON),读 MUST 脱敏,不入 DDB/日志。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import Principal
from ..deps import require_admin
from ..minimax_config_service import (
    MiniMaxConfigError,
    MiniMaxConfigStore,
    VoiceListUnavailable,
    list_voice_ids,
    list_voices,
    masked_view,
    merge_config,
    validate_config_patch,
)

logger = logging.getLogger("aim.admin_tts")

router = APIRouter(prefix="/api/admin/tts-config", tags=["admin-tts"])


def _store(request: Request) -> MiniMaxConfigStore:
    return MiniMaxConfigStore(request.app.state.settings)


def _validate_voice_ids_best_effort(voice_map: dict, merged: dict) -> None:
    """校验用户填的 voice_id 在账号 get_voice 清单里;不在 → 400。get_voice 失败 → fail-open(跳过)。

    只校验本次 patch 真改的 voice_map 项(merged 里的 key/base_url 是生效值)。
    """
    try:
        available = list_voice_ids(merged.get("api_key") or "", merged.get("base_url") or "")
    except VoiceListUnavailable as exc:
        # MiniMax 不可达/限流:不阻塞保存(真机合成时仍会校验),仅告警。
        logger.warning("get_voice 校验不可用,跳过 voice_id 校验(配置照常保存): %s", exc)
        return
    bad = [vid for vid in voice_map.values() if vid not in available]
    if bad:
        raise HTTPException(
            status_code=400,
            detail=f"voice_id 在账号可用音色清单中不存在: {bad}。请用「查询可用音色」中的 voice_id。",
        )


@router.get("")
def get_tts_config(request: Request, _: Principal = Depends(require_admin)) -> dict:
    """读 MiniMax 配置(脱敏)。Secret 未配置(本地/未部署 019)→ fail-closed 503。"""
    store = _store(request)
    if not store.secret_id:
        raise HTTPException(status_code=503, detail="MiniMax 未启用(AIM_MINIMAX_SECRET_ID 未配置)")
    raw = store.read_raw()
    return {"config": masked_view(raw)}


@router.get("/voices")
def get_available_voices(request: Request, _: Principal = Depends(require_admin)) -> dict:
    """查账号下可用音色清单(MiniMax get_voice),供前端下拉选 voice_id。

    返回 {voices:[{voice_id,voice_name,category}], available:bool}。无 key / get_voice 不可达
    → available=false + 空列表(前端回退到手填,不报错)。明文 key 不回显。
    """
    store = _store(request)
    if not store.secret_id:
        raise HTTPException(status_code=503, detail="MiniMax 未启用(AIM_MINIMAX_SECRET_ID 未配置)")
    raw = store.read_raw()
    key = (raw.get("api_key") or "").strip()
    if not key:
        return {"voices": [], "available": False, "reason": "未配置 API Key"}
    try:
        voices = list_voices(key, raw.get("base_url") or "")
    except VoiceListUnavailable as exc:
        logger.info("get_voice 不可用,前端回退手填: %s", exc)
        return {"voices": [], "available": False, "reason": "查询音色失败,可手动填 voice_id"}
    return {"voices": voices, "available": True}


@router.put("")
def put_tts_config(body: dict, request: Request, _: Principal = Depends(require_admin)) -> dict:
    """改 MiniMax 配置。校验非密参数 → merge 现有(保留旧 key,除非 body 带 api_key)→ 写 Secret →
    best-effort 调 GPU /reload-tts-config,把重载回执透传前端("已生效"/"key 无效")。

    body:enabled/base_url/model/voice_map(非密)+ 可选 api_key(写后只脱敏回显)。
      - 不带 api_key / api_key="":保留现有 key(前端密码框留空即不改);
      - api_key 非空:替换。
    校验:enabled=true 但合并后无有效 key(既没现存、也没新填)→ 400(不让"启用却无 key"落库;
    关闭 enabled=false 时允许无 key,disable 态)。
    """
    store = _store(request)
    if not store.secret_id:
        raise HTTPException(status_code=503, detail="MiniMax 未启用(AIM_MINIMAX_SECRET_ID 未配置)")
    try:
        patch = validate_config_patch(body)
    except MiniMaxConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # api_key 处理(review:契约与唯一客户端对齐):
    #   - 不带 api_key 字段 / 带空串 → **保留现有 key**(前端密码框留空即不改;空串不再"清空",
    #     避免直接 API 误传空串静默抹掉生产 key——前端本就无法表达"清空");
    #   - 带非空字符串 → 替换 key。
    #   清空 key 不经此路径(需要时直接删/改 Secret;UI 不提供"清空"以免误操作)。
    new_key = None
    if "api_key" in body:
        ak = body.get("api_key")
        if ak is not None and not isinstance(ak, str):
            raise HTTPException(status_code=400, detail="api_key 须为字符串")
        new_key = ak if ak else None  # 空串/None → 不改

    # 读现有配置:瞬时读失败(非 NotFound)→ read_raw 抛错 → 这里 502,绝不拿空配置 merge 覆盖现有 key。
    try:
        current = store.read_raw()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读 MiniMax Secret 失败,拒绝写入以免覆盖现有配置: %s", exc)
        raise HTTPException(status_code=502, detail="读取现有配置失败,未写入(请重试,避免覆盖现有 key)") from exc
    merged = merge_config(current, patch, new_api_key=new_key)
    # 校验(defense-in-depth,与前端一致):enabled=true 必须有有效 key(合并后非空);关闭则允许无 key。
    if merged.get("enabled") and not (merged.get("api_key") or "").strip():
        raise HTTPException(status_code=400, detail="启用 MiniMax 需要配置 API Key(请填入 Key,或取消启用)")
    # 校验 voice_id 真实可用(用户填的 voice_map 拿 get_voice 清单比对,不在清单 → 400,
    # 避免等真机合成才 2013 失败)。仅当本次 PUT 改了 voice_map 且有 key 时校验;get_voice 调用失败
    # (网络/限流)→ **fail-open** 跳过校验、不阻塞保存(MiniMax 抖动不该让人配不了)。
    if "voice_map" in patch and (merged.get("api_key") or "").strip():
        _validate_voice_ids_best_effort(patch["voice_map"], merged)
    try:
        store.write_raw(merged)
    except MiniMaxConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — Secrets Manager 写失败:明确报错(不静默)
        logger.warning("写 MiniMax Secret 失败: %s", exc)
        raise HTTPException(status_code=502, detail="写配置失败,请重试") from exc

    # 热加载:best-effort 调 GPU /reload-tts-config(失败不阻塞保存,配置已落 Secret,GPU 下次启动/重载拿到)
    reload_result = _trigger_gpu_reload(request)
    return {"config": masked_view(merged), "reload": reload_result}


def _trigger_gpu_reload(request: Request) -> dict:
    """best-effort 调 GPU /reload-tts-config(design contract 热加载)。

    返回 {triggered, ok?, detail?}:
      - 未配 GPU 控制 URL/密钥 → triggered=false(只落 Secret,GPU 下次启动/重载兜底)
      - 调用成功 → triggered=true + GPU 回执(ok/per_voice/detail,据此告知前端"已生效"/"key 无效")
      - 调用失败(GPU 不可达/正忙) → triggered=true, ok=null(配置已保存,提示"已保存,正在下发")

    多实例 fan-out(design contract 多实例)为放量前开放项:MVP 单/少实例下调单一 control URL 即等价。
    """
    settings = request.app.state.settings
    base = settings.gpu_control_url
    secret = settings.gpu_control_secret
    if not base or not secret:
        return {"triggered": False, "detail": "未配置 GPU 热加载通路(配置已保存,GPU 下次启动/重载生效)"}
    try:
        import httpx  # noqa: PLC0415

        resp = httpx.post(
            f"{base.rstrip('/')}/reload-tts-config",
            headers={"X-Drain-Secret": secret},
            # self-probe 真调云端各 voice 试合成:N voice × MiniMax HTTP 超时(默认 ~5s/句)。给足余量
            # 覆盖最坏情形 + 网络/GC 抖动(2 voice × 5s ≈ 10s,留到 25s 不卡边);超时仅回执未确认,
            # 不阻塞保存(配置已落 Secret,GPU 下次启动/重载兜底)。
            timeout=25.0,
        )
        if resp.status_code == 200:
            body = resp.json()
            return {"triggered": True, "ok": bool(body.get("ok")), "detail": body.get("detail"),
                    "per_voice": body.get("per_voice")}
        return {"triggered": True, "ok": None,
                "detail": f"GPU 重载返回 {resp.status_code}(配置已保存,正在下发)"}
    except Exception as exc:  # noqa: BLE001 — GPU 不可达/正忙不阻塞保存
        logger.info("调 GPU /reload-tts-config 失败(不阻塞保存): %s", exc)
        return {"triggered": True, "ok": None, "detail": "已保存,正在下发(GPU 暂不可达)"}
