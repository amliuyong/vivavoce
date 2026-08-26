"""运行时诊断配置聚合端点(design contract)—— ``GET /api/admin/system-settings``,admin-only 只读。

把四段来源聚合成一页:

============  ==========================================  =========================
来源           内容                                        取法
============  ==========================================  =========================
``control``   ``config.py`` 生效值 + 各 Secret 配置状态      本进程直读
``media``     bridge ``AIM_*`` 钳制后生效值                  内网 ``GET {bridge}/config``
``gpu``       GPU ``AIM_*`` 生效值(**单实例采样**)          内网 ``GET {gpu}/config``
``iac``       CDK 注入的非密部署清单                          读注入的 manifest
============  ==========================================  =========================

设计要点(评审收敛后的硬约束)
------------------------------
* **并行 + 短超时**:各子系统 connect/read 各 ~2s,总预算有上限。**MUST NOT** 复用
  ``admin_tts.py`` 的 25s reload 超时 —— 那是「真调云端试合成」的量级,诊断页不该卡这么久。
* **结构化降级用固定枚举**:``status`` 取值固定(见 ``SubsystemStatus``),否则自动化测试只能
  断言「有个字符串」,验不了分类正确。且 401/503 时**服务是可达的**,故 ``transport_reachable``
  与 ``status`` 分开表达(review)。
* ``planned_stopped`` **MUST 有独立依据**:单凭「连不上」无法区分「admin 主动停机」与
  「DNS 抖动 / ECS 异常」。故以 design contract 的**容量意图**(DDB 里期望实例数 = 0)为判据 ——
  把故障显示成「正常停机」会掩盖事故,而那正是本页要防的(评审两方一致)。
* **单子系统失败不得让整页 500**:其余组照常返回,整体仍 200。
"""

from __future__ import annotations

import concurrent.futures
import logging
import os
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request, Response

from ..auth import Principal
from ..deps import require_admin
from ..system_settings_meta import (
    SETTINGS_META,
    is_sensitive_name,
    redact,
    value_looks_sensitive,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/system-settings", tags=["admin-settings"])

#: 子系统状态**固定枚举**。前端按此渲染,测试按此断言分类正确。
SubsystemStatus = Literal[
    "ok",
    "planned_stopped",      # admin 主动停机(据 design contract 容量意图,**非**由连不上推断)
    "dns_unresolved",       # Cloud Map 无记录 / DNS 解析失败
    "connect_timeout",      # 连接或读取超时
    "unauthorized",         # 401:密钥错配(**不是**停机!显示成停机会掩盖事故)
    "endpoint_disabled",    # 503:子系统侧未配密钥,端点禁用
    "incompatible_schema",  # 响应 schema_version 不支持
    "upstream_error",       # 其它非 200 / 响应无法解析
    "not_configured",       # 控制面侧未配该子系统的 URL/密钥(压根没通路)
]

#: 各子系统 HTTP 超时(秒)。刻意远小于 admin_tts 的 25s —— 诊断页要快。
_SUBSYSTEM_TIMEOUT_S = 2.0
#: 聚合总预算(秒):并行下取最慢者 + 少量余量。
_TOTAL_BUDGET_S = 5.0

#: 本聚合器支持的子系统 schema 版本。子系统返回更高版本 → ``incompatible_schema``。
_SUPPORTED_SCHEMA_VERSIONS = frozenset({1})


def _fetch_subsystem(
    *, name: str, base: str | None, secret: str | None, header: str,
) -> dict[str, Any]:
    """拉一个子系统的 ``/config``,产出 ``{status, transport_reachable, entries, instance?}``。

    任何异常都收敛成结构化状态,**不抛** —— 单子系统故障不得让整页 500。
    """
    if not base or not secret:
        return {"status": "not_configured", "transport_reachable": False, "entries": [],
                "reason": f"控制面未配置 {name} 的内网地址或共享密钥"}
    try:
        import httpx  # noqa: PLC0415

        resp = httpx.get(
            f"{base.rstrip('/')}/config",
            headers={header: secret},
            timeout=_SUBSYSTEM_TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001 —— 逐类映射到固定枚举
        text = str(exc).lower()
        # DNS:Cloud Map 名不存在(GPU 缩到 0 时常见)
        if "name or service not known" in text or "nodename nor servname" in text \
                or "getaddrinfo" in text or "no address" in text:
            status = "dns_unresolved"
        elif "timeout" in text or "timed out" in text:
            status = "connect_timeout"
        else:
            status = "upstream_error"
        logger.info("聚合 %s /config 失败(%s): %s", name, status, exc)
        return {"status": status, "transport_reachable": False, "entries": [], "reason": str(exc)[:200]}

    # 服务**可达**,只是可能拒绝 —— transport_reachable=True
    if resp.status_code == 401:
        return {"status": "unauthorized", "transport_reachable": True, "entries": [],
                "http_status": 401, "reason": "共享密钥不匹配(**不是**停机,请核对密钥配置)"}
    if resp.status_code == 503:
        return {"status": "endpoint_disabled", "transport_reachable": True, "entries": [],
                "http_status": 503, "reason": "子系统侧未配置共享密钥,端点禁用"}
    if resp.status_code != 200:
        return {"status": "upstream_error", "transport_reachable": True, "entries": [],
                "http_status": resp.status_code, "reason": f"子系统返回 {resp.status_code}"}
    try:
        body = resp.json()
        entries = body["entries"]
        version = body.get("schema_version")
    except Exception as exc:  # noqa: BLE001 —— 格式损坏 ≠ 版本不兼容
        return {"status": "upstream_error", "transport_reachable": True, "entries": [],
                "reason": f"响应无法解析:{str(exc)[:120]}"}
    # ★ 结构校验(review):只查 `entries` 存在**不够** —— 若它不是 list[dict] 或元素缺 `key`,
    #   后续 `_shape_entry` 会在 try 之外抛(TypeError/KeyError)→ **整页 500**,
    #   而那恰好击穿「单子系统故障不得让整页挂」这条要求。故在此就地拒绝畸形结构。
    if not isinstance(entries, list) or not all(
        isinstance(e, dict) and isinstance(e.get("key"), str) and e["key"] for e in entries
    ):
        return {"status": "upstream_error", "transport_reachable": True, "entries": [],
                "reason": "响应 entries 结构非法(应为 list[{key: str, ...}])"}
    if version not in _SUPPORTED_SCHEMA_VERSIONS:
        return {"status": "incompatible_schema", "transport_reachable": True, "entries": [],
                "reason": f"子系统 schema_version={version},本聚合器支持 {sorted(_SUPPORTED_SCHEMA_VERSIONS)}"}
    out: dict[str, Any] = {"status": "ok", "transport_reachable": True, "entries": entries}
    if isinstance(body.get("instance"), dict):
        out["instance"] = body["instance"]
    return out


def _gpu_capacity_intent_is_zero(request: Request) -> bool:
    """design contract 的容量**意图**是否为「主动停机」(期望实例数 = 0)。

    这是 ``planned_stopped`` 的**独立依据** —— 不可由「连不上」推断。
    读不到配置(首次部署 reconciler 未写)→ 视为**非**主动停机(宁报故障不掩盖事故)。
    """
    try:
        config = request.app.state.db.get_gpu_capacity_config()
    except Exception:  # noqa: BLE001 —— 读 DDB 失败不影响聚合主流程
        return False
    if not config:
        return False
    return config.get("mode") == "fixed" and config.get("fixed_count") == 0


def _control_entries(request: Request) -> list[dict[str, Any]]:
    """控制面自身的生效值 + 各 Secret 「已配置/未配置」状态。

    Secret 一律**只回布尔**(名称 denylist 亦会兜底脱敏),MUST NOT 含明文或末 N 位。
    """
    s = request.app.state.settings

    def _attr(name: str) -> Any:
        return getattr(s, name, None)

    # (key, value, default, is_set)
    #
    # ⚠ ``is_set`` MUST 独立传入,**不可**用 ``value is not None`` 反推:
    #   布尔项(通路/凭据)传的是 ``bool(...)``,未配时是 ``False`` 而**非** ``None`` ——
    #   反推会把「压根没配」判成 ``valid`` → origin 显示「部署时 env 覆盖」,
    #   而这恰好会误导本页唯一的读者(运维)。
    items: list[tuple[str, Any, Any, bool]] = [
        # ⚠ env 真名是 `MAX_CONCURRENCY`(**无** AIM_ 前缀,见 config.py::_max_concurrency_ceiling)——
        #   写错前缀会让运维照着页面去设一个根本不存在的变量(review 实证)。
        ("MAX_CONCURRENCY", _attr("max_concurrency"), 3,
         os.getenv("MAX_CONCURRENCY") is not None),
        ("AIM_SESSION_JOIN_EXPIRE_MIN", _attr("session_join_expire_min"), 30,
         os.getenv("AIM_SESSION_JOIN_EXPIRE_MIN") is not None),
        ("AIM_ROLE_CLAIM", _attr("role_claim"), "cognito:groups",
         os.getenv("AIM_ROLE_CLAIM") is not None),
        ("AIM_AUTH_REGION", _attr("auth_region"), None,
         os.getenv("AIM_AUTH_REGION") is not None),
        # 通路配置(非凭据):布尔表「通路是否已建」;未配 = False 且 is_set=False
        ("AIM_BRIDGE_DIAL_URL", bool(_attr("bridge_dial_url")), False,
         os.getenv("AIM_BRIDGE_DIAL_URL") is not None),
        ("AIM_GPU_CONTROL_URL", bool(_attr("gpu_control_url")), False,
         os.getenv("AIM_GPU_CONTROL_URL") is not None),
        # 凭据:只回布尔(名称 denylist 亦兜底脱敏)
        ("AIM_BRIDGE_CALLBACK_SECRET", bool(_attr("bridge_callback_secret")), False,
         os.getenv("AIM_BRIDGE_CALLBACK_SECRET") is not None),
        ("AIM_REALTIME_CLIENT_SECRET", bool(_attr("realtime_client_secret")), False,
         os.getenv("AIM_REALTIME_CLIENT_SECRET") is not None),
        ("AIM_DRAIN_SECRET", bool(_attr("gpu_control_secret")), False,
         os.getenv("AIM_DRAIN_SECRET") is not None),
    ]
    return [{"key": k, "value": v, "default": d,
             "override_state": control_override_state(k, v, d, is_set)}
            for k, v, d, is_set in items]


def control_override_state(
    key: str, value: Any, default: Any, is_set: bool
) -> str:
    """三态:``absent`` / ``valid`` / ``ignored_invalid``。

    ⚠ **不能只看 env 是否存在**(review 实证):`MAX_CONCURRENCY=bogus` 时
    `config.py::_max_concurrency_ceiling` **容错回退默认 3 并告警**,而只看 env 存在会报
    `valid` + origin「部署时 env 覆盖」—— 运维以为自己的配置生效了,实际被丢弃。
    这与 GPU `AIM_GPU_LOG_LEVEL=bogus` 是同一类缺陷(端点报告 ≠ 业务实际)。

    判据:env 设了、但**生效值仍等于内建默认** → 极可能被 parser 丢弃 → `ignored_invalid`。
    已知假阴性(与媒体面 registry 同款,已在 spec 记录并接受):**显式把 env 设成恰好等于
    默认值**时也会报 `ignored_invalid`。此时行为与默认一致、运维无需被提示,
    代价可接受;反过来「设了却被静默丢弃」不提示才是真危害。
    """
    if not is_set:
        return "absent"
    # ★ **布尔化项**(通路 URL / 凭据)只看 env 是否存在,**不比对值**:
    #   它们的 `value` 是 `bool(Settings.xxx)`,而 `Settings` 是**进程启动时**构造并缓存的
    #   —— 运行中改 env 不会反映到 Settings。若对它们也用「值 == 默认 → ignored_invalid」,
    #   「env 设了但 Settings 尚未重载」会被误判成「设了被丢弃」(实测:既有用例
    #   `test_configured_control_items_are_valid` 立即转红)。
    #   这类项本就只表达「通路/凭据是否已建」,无「非法值被丢弃」的语义,故不做值比对。
    if isinstance(value, bool):
        return "valid"
    # 标量项(数值/字符串):env 设了却仍等于内建默认 → 极可能被 parser 容错丢弃。
    return "valid" if value != default else "ignored_invalid"


def _redact_manifest_value(
    key: str, value: Any
) -> tuple[Any, Any, str | None]:
    """部署清单项的安全轴 —— 返回 ``(effective_value, default, redacted_reason)``。

    清单项**不走 allowlist 隐藏**(它自带中文元数据,隐藏会让 17 项全成「未登记」),
    但 **MUST 仍过名称 denylist + 值形状**两道轴 —— 否则未来往 manifest 加敏感常量时
    后端零防线时,形似 `sk-examplevalue` 的值可能原样回出且 `redacted_reason=None`。

    脱敏优先级与 ``redact()`` 一致(**勿重排**):名称 denylist(布尔化)> 值形状(抹成 None)。
    清单项的 ``value`` 就是其 ``default``(部署时固化,无 env 覆盖概念),故两者同步处置。
    """
    if is_sensitive_name(key):
        # 名称命中 → 布尔化(只回「已配置/未配置」,与 redact() 同姿态)
        return bool(value), None, "敏感项仅显示配置状态"
    if value_looks_sensitive(value):
        # 名称不敏感但值像凭据 → 抹值保 key(排障仍知道这一项存在)
        return None, None, "值形状疑似凭据,已隐藏"
    return value, value, None


def _shape_entry(source: str, raw: dict[str, Any]) -> dict[str, Any]:
    """贴元数据 + 脱敏 + 计算 origin / differs_from_default。

    ⚠ **部署清单自带元数据**(`name_zh`/`group`/`unit`/`consumer` 由 CDK 生成时写入),
    故 `iac_manifest` 源不查 `SETTINGS_META` —— 否则 17 项清单会全显示「未登记(值已隐藏)」
    (评审两方一致指出的 M1/Major 2:整页功能为空)。清单是它自己那段的单一事实源,
    在 Python 再抄一份中文名反而违背本 spec 的核心原则。
    """
    key = raw["key"]
    red = redact(source, key, raw.get("value"), raw.get("default"))
    meta = SETTINGS_META.get((source, key))  # type: ignore[arg-type]
    override = raw.get("override_state", "absent")
    # 清单项:用自带元数据补齐,视作「已登记」(不走 metadata_missing 隐藏路径)
    manifest_meta = source == "iac_manifest" and bool(raw.get("name_zh"))

    # origin:仅当 env 被**有效**覆盖才算 deployment_env;
    #   ignored_invalid(设了但被丢弃)与 absent 均归 builtin —— 生效值确实来自内建默认。
    if source == "iac_manifest":
        origin = "iac_manifest"
    elif red.effective_value is not None and meta is not None \
            and meta.display_policy == "configured_only":
        origin = "secret"
    elif override == "valid":
        origin = "deployment_env"
    else:
        origin = "builtin"

    # 派生默认项:默认值是**算式**而非固定字面量 → 前端标 `derived`,不当成「可直接比对的字面量」。
    #
    # ⚠ 原实现把来源硬编码成 `AIM_SILENCE_VIOLATION_MS`(当时只有静默推进两项)。design contract 新增
    #   `AIM_EOU_CORRELATION_MS`(默认 = 生效判定超时 + 余量)后必须改成**逐 key 映射**,
    #   否则新项会指错来源、误导排障。
    derived_from_map: dict[str, list[dict[str, str]]] = {
        "AIM_ADVANCE_NUDGE_MS": [{"source": "media", "key": "AIM_SILENCE_VIOLATION_MS"}],
        "AIM_ADVANCE_AFTER_NUDGE_MS": [{"source": "media", "key": "AIM_SILENCE_VIOLATION_MS"}],
        # design contract:关联窗默认跟随生效判定超时(结构性保证不变式「关联窗 ≥ 判定超时」——
        #   若写死字面量,单边把超时调到合法上限会破坏不变式并 fail-fast 崩启动)。
        "AIM_EOU_CORRELATION_MS": [{"source": "media", "key": "AIM_EOU_VERDICT_TIMEOUT_MS"}],
    }
    default_kind = "derived" if key in derived_from_map else "literal"
    if default_kind == "derived" and origin == "builtin":
        origin = "derived"

    # ── design contract:differs 判定收敛为**二维**,不再裸比较 ──────────────────────
    #
    # 事故前的判据是 `effective != default`,于是只读页把线上**正确**配置渲染成「异于默认」——
    # 修好了被标成偏离标准(用户判决:「『只看异于默认』根本就不要存在」)。
    # 订正:只有「**默认值概念成立** 且 **已标定**」的项才参与判定。
    #
    #   - default_comparable=False(部署形态 / CDK 派生 / 拓扑地址 / 凭据 / 隐藏项):无「默认」可比。
    #   - calibration_status="pending"(C 类):与默认值不同是**预期状态**(标定期显式开启),
    #     前端据此显示「待标定」而非「异于默认」。
    #
    # 机械归类(无需逐项人工判断):`display_policy != "value"` 的项(凭据/隐藏)自动 comparable=False;
    # manifest 项与未登记项同理 —— 它们本就没有 SETTINGS_META 声明的默认语义。
    comparable = (
        meta is not None
        and meta.display_policy == "value"
        and meta.default_comparable
        and source != "iac_manifest"
    )
    # ★ review:`not comparable` 时 calibration MUST 统一为 "n/a" ——
    #   凭据项(display_policy=configured_only)在 SETTINGS_META 里继承字段默认 "stable",
    #   若原样输出就会自称「已标定」,与「凭据无默认值可比」自相矛盾(前端可能据此渲染错标签)。
    calibration = (
        meta.calibration_status if (meta is not None and comparable) else "n/a"
    )
    differs = (
        comparable
        and calibration == "stable"
        and red.effective_value is not None
        and red.default is not None
        and red.effective_value != red.default
    )
    # 清单项的展示值:manifest 自带中文元数据 → **不走 allowlist 隐藏**(否则 17 项全显示
    # 「未登记」= 功能为空,见review 第一轮)。但 **MUST 仍过两道安全轴**:
    #
    #   ① 名称 denylist(后缀锚定)② 值形状守门(sk-*/AKIA*/Secret ARN/user:pass@host)
    #
    # ⚠ 为什么不能只靠 CDK UT:原实现注释写「CDK UT 已断言清单只含非密项,故直接用原值」——
    #   这把守门**全押在另一个子系统的测试**上,后端零防线。实证缺口:构造 manifest 项
    #   `SOME_SIGNING_KEY = "sk-examplevalue1234"` → 原样回出且 `redacted_reason=None`
    #   (装作正常值)。当前 17 项确实非密(CDK UT 守着),但**未来新增项没有后端兜底** ——
    #   而「跨子系统的单点守门」正是本 spec 反复吃过的教训。故此处补上纵深防御。
    if manifest_meta:
        eff, dflt, manifest_redacted = _redact_manifest_value(key, raw.get("value"))
    else:
        eff, dflt, manifest_redacted = red.effective_value, red.default, None
    return {
        "source": source,
        "key": key,
        "name_zh": raw.get("name_zh") if manifest_meta else (meta.name_zh if meta else key),
        "desc_zh": (
            f"{raw.get('consumer', '')}" if manifest_meta else (meta.desc_zh if meta else "")
        ),
        "unit": raw.get("unit", "") if manifest_meta else (meta.unit if meta else ""),
        "group": raw.get("group") if manifest_meta else (meta.group if meta else "其他"),
        "effective_value": eff,
        "default": dflt,
        "default_kind": default_kind,
        "derived_from": derived_from_map.get(key, []),
        "origin": origin,
        "differs_from_default": differs,
        # design contract:二维语义显式下发,前端据此区分「异于默认」(真异常)与「待标定」(预期)。
        "default_comparable": comparable,
        "calibration_status": calibration,
        "override_state": override,
        "metadata_missing": False if manifest_meta else red.metadata_missing,
        "redacted_reason": manifest_redacted if manifest_meta else red.redacted_reason,
        # 布尔语义显式给出(switch=真开关渲染开/关;configured=脱敏后的已配置/未配置)
        "value_semantics": red.value_semantics,
    }


@router.get("")
def get_system_settings(
    request: Request, response: Response, _: Principal = Depends(require_admin),
) -> dict[str, Any]:
    """聚合四段来源(并行 + 短超时);单子系统故障不影响整体 200。"""
    # 管理端诊断数据不缓存(review):防中间层缓存住旧快照冒充现状
    response.headers["Cache-Control"] = "no-store"

    s = request.app.state.settings
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        fut_media = pool.submit(
            _fetch_subsystem, name="media", base=getattr(s, "bridge_dial_url", None),
            secret=getattr(s, "bridge_callback_secret", None), header="X-Bridge-Secret",
        )
        fut_gpu = pool.submit(
            _fetch_subsystem, name="gpu", base=getattr(s, "gpu_control_url", None),
            secret=getattr(s, "gpu_control_secret", None), header="X-Drain-Secret",
        )
        try:
            media = fut_media.result(timeout=_TOTAL_BUDGET_S)
        except Exception as exc:  # noqa: BLE001
            media = {"status": "connect_timeout", "transport_reachable": False, "entries": [],
                     "reason": f"聚合超预算:{str(exc)[:120]}"}
        try:
            gpu = fut_gpu.result(timeout=_TOTAL_BUDGET_S)
        except Exception as exc:  # noqa: BLE001
            gpu = {"status": "connect_timeout", "transport_reachable": False, "entries": [],
                   "reason": f"聚合超预算:{str(exc)[:120]}"}

    # GPU 不可达时,才看容量意图能否解释为「主动停机」。
    # ⚠ 只在**传输层不可达**时可能是停机;401/503 是「服务活着但拒绝」,绝不可改判 planned_stopped。
    if not gpu["transport_reachable"] and _gpu_capacity_intent_is_zero(request):
        gpu["status"] = "planned_stopped"
        gpu["reason"] = "GPU 容量配置为 0(admin 主动停机),非故障"

    sources: dict[str, dict[str, Any]] = {
        "control": {"status": "ok", "transport_reachable": True,
                    "entries": _control_entries(request)},
        "media": media,
        "gpu": gpu,
        "iac_manifest": _load_manifest(),
    }

    # 逐条贴元数据 + 脱敏;按 group 组织
    groups: dict[str, dict[str, Any]] = {}
    for source, payload in sources.items():
        for raw in payload.get("entries", []):
            shaped = _shape_entry(source, raw)
            g = groups.setdefault(
                shaped["group"], {"group": shaped["group"], "sources": [], "items": []})
            if source not in g["sources"]:
                g["sources"].append(source)
            g["items"].append(shaped)

    return {
        "schema_version": 1,
        "sources": {
            k: {kk: vv for kk, vv in v.items() if kk != "entries"} for k, v in sources.items()
        },
        # GPU 是**单实例采样**,不冒充集群一致值
        "gpu_scope": "sampled_instance",
        "groups": sorted(groups.values(), key=lambda g: g["group"]),
    }


def _load_manifest() -> dict[str, Any]:
    """读 CDK 注入的非密部署清单(Task 5 落地前返回 not_configured,不影响其余三段)。"""
    import json
    import os

    raw = os.getenv("AIM_DEPLOYMENT_MANIFEST", "").strip()
    if not raw:
        return {"status": "not_configured", "transport_reachable": True, "entries": [],
                "reason": "CDK 尚未注入部署清单(AIM_DEPLOYMENT_MANIFEST 未设)"}
    try:
        data = json.loads(raw)
        return {"status": "ok", "transport_reachable": True,
                "entries": data.get("entries", []),
                "generated_at": data.get("generated_at"),
                "region": data.get("region"), "stack_name": data.get("stack_name")}
    except Exception as exc:  # noqa: BLE001
        return {"status": "upstream_error", "transport_reachable": True, "entries": [],
                "reason": f"清单解析失败:{str(exc)[:120]}"}
