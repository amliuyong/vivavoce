"""三段式对话 LLM 配置服务(design contract,控制面侧)。

系统级全局一套配置,装在**单一 Secret 的 JSON**:
  { host, models:[{id,label}], default_model, api_key }
- `host`:mantle 端点 base(https://…)。
- `models`:允许的模型清单(数据驱动;每项 id + 人读 label)。**路径由 id 前缀推断,不存**
  (`anthropic.` → /anthropic/v1/messages 原生;否则 → /v1/chat/completions OpenAI)。
- `default_model`:Agent 未指定 llm_model_id 时的兜底(须 ∈ models)。
- `api_key`:mantle Bearer token(**短期轮换**;仅控制面读,发起时逐通注入就绪指令,实时服务不持久)。

读 MUST 脱敏(仅回 has_key + 末 4 位);明文 token MUST NOT 进响应/日志/DDB。
写经 Secrets Manager(PutSecretValue);PUT 不带 key 时保留旧 key。

复刻 design contract minimax_config_service 的模式(纯逻辑可单测;Secrets Manager I/O 经注入 client)。
凭据模型的关键差别:LLM 跑在媒体面 Bridge(公网 EC2),故**仅控制面 backend 读此 Secret**,
Bridge 无 GetSecretValue、发起时逐通注入(见 session_service.resolve_launch_command)。
"""
from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta

logger = logging.getLogger("aim.llm_config")

# 默认值(与 design contract 实测 wire 对齐)。host 默认 us-east-1 mantle。
DEFAULT_HOST = "https://bedrock-mantle.us-east-1.api.aws"
# 默认模型:mantle 上验证可用的 GLM(便宜快)。仅在配了 token 且未显式设 default_model 时兜底;
# 未配 token 时根本不走 mantle(走 IAM BedrockStreamer + Haiku,见 session_service._resolve_llm_config)。
DEFAULT_MODEL = "zai.glm-4.7-flash"
# 打分(evaluator)默认模型:比对话模型更强的 MiniMax M2.5(设计决策)。evaluator 复用同一 mantle host+token,
# 仅模型不同。缺省时 evaluator 回退 default_model。中国区不能用 Anthropic(地域封锁),故默认选 MiniMax。
DEFAULT_EVALUATOR_MODEL = "minimax.minimax-m2.5"
# ASR 字幕修正(design contract)默认模型:Haiku 4.5(便宜快,旁路修字幕/转写错字)。**仅非中国区开箱默认**——
# 真实 seed 在 CDK(default-llm-config-seed.ts),中国区留空(初装时清单不含 Anthropic,经代理配好后 admin 再选)。
# backend masked_view **不**用它做缺省回退(空 = 不修,区别于 evaluator_model 回退 default_model);此常量仅供
# 文档/推荐/测试引用。可空=不修:未配 → bridge 不下发 fixer → 字幕/转写走 ASR 原文(回退现状)。
DEFAULT_FIXER_MODEL = "anthropic.claude-haiku-4-5"
# design contract:调用方式(全局单选)。默认 mantle(现状 design contract,向后兼容:旧配置无此字段即 mantle)。
# bedrock_converse = 传统 Bedrock Runtime Converse API(拿 mantle 没有的模型如 Sonnet 4.6),经 mantle-proxy 绕封锁。
DEFAULT_CALL_METHOD = "mantle"
# design contract:converse 的 ?region= 上游 Bedrock region(mantle-proxy 路由参数)。默认 us-east-1;探活确认可用 region。
DEFAULT_BEDROCK_REGION = "us-east-1"
# 前端预填的推荐清单(design contract;**非 backend 硬编码枚举** —— Secret 空时 catalog 为空,admin 必须先配置)。
# **仅列实测 200 可用的 provider**(已确认的设计决策:MiniMax + Z.AI 即可)。Anthropic 走 IAM 回退无需入 mantle 清单;
# xAI Grok / Google Gemma 等 Marketplace 模型账号未开通,开通后 admin 在配置页加一行即可(数据驱动,不改代码)。
RECOMMENDED_MODELS = [
    {"id": "zai.glm-4.7-flash", "label": "GLM 4.7 Flash(最便宜)"},
    {"id": "minimax.minimax-m2.5", "label": "MiniMax M2.5"},
    # Anthropic 仅非中国可用(中国区经 mantle 被地域封锁 → BUG-2 守卫拦截;seed 时中国区清单不含)。
    {"id": "anthropic.claude-sonnet-5", "label": "Claude Sonnet 5"},
    {"id": "anthropic.claude-haiku-4-5", "label": "Claude Haiku 4.5"},
]


class LlmConfigError(ValueError):
    """配置校验失败(路由层转 400)。"""


def _parse_bedrock_expiry(value: object) -> datetime:
    """解析带时区的 Bedrock Key 到期时间，并规范化到 UTC。"""
    if not isinstance(value, str) or not value.strip():
        raise LlmConfigError("bedrock_api_key_expires_at 须为带时区的 ISO 8601 时间")
    try:
        expires_at = datetime.fromisoformat(value.strip())
    except ValueError as exc:
        raise LlmConfigError("bedrock_api_key_expires_at 须为带时区的 ISO 8601 时间") from exc
    if expires_at.tzinfo is None or expires_at.utcoffset() is None:
        raise LlmConfigError("bedrock_api_key_expires_at 必须包含时区")
    return expires_at.astimezone(UTC)


def validate_config_patch(body: dict, *, now: datetime | None = None) -> dict:
    """校验 admin PUT 的**非密**参数(不含 api_key — key 单独走路径)。

    返回规范化的非密 dict(host/models/default_model)。非法抛 LlmConfigError。
    - host:非空字符串,须 https://
    - models:list[{id:str, label?:str}],id 非空且形如 `<provider>.<model>`;至少校验结构
    - default_model:非空字符串(是否 ∈ models 在 merge 后统一校验,因 models 可能本次未带)
    """
    out: dict = {}
    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            raise LlmConfigError("enabled 须为布尔值")
        out["enabled"] = body["enabled"]
    if "host" in body and body["host"] is not None:
        h = body["host"]
        if not isinstance(h, str) or not h.strip():
            raise LlmConfigError("host 须为非空字符串")
        if not h.strip().startswith("https://"):
            raise LlmConfigError("host 须为 https://(完整 mantle endpoint base)")
        out["host"] = h.strip().rstrip("/")
    if "models" in body and body["models"] is not None:
        models = body["models"]
        if not isinstance(models, list) or not models:
            raise LlmConfigError("models 须为非空列表")
        clean: list[dict] = []
        seen: set[str] = set()
        for m in models:
            if not isinstance(m, dict):
                raise LlmConfigError("models 每项须为对象 {id, label}")
            mid = m.get("id")
            if not isinstance(mid, str) or not mid.strip():
                raise LlmConfigError("model.id 须为非空字符串")
            mid = mid.strip()
            if "." not in mid:
                raise LlmConfigError(f"model.id 须形如 <provider>.<model>(如 anthropic.claude-haiku-4-5),得到 {mid!r}")
            if mid in seen:
                raise LlmConfigError(f"model.id 重复: {mid}")
            seen.add(mid)
            label = m.get("label")
            clean.append({"id": mid, "label": (label.strip() if isinstance(label, str) and label.strip() else mid)})
        out["models"] = clean
    if "default_model" in body and body["default_model"] is not None:
        dm = body["default_model"]
        if not isinstance(dm, str) or not dm.strip():
            raise LlmConfigError("default_model 须为非空字符串")
        out["default_model"] = dm.strip()
    if "evaluator_model" in body and body["evaluator_model"] is not None:
        em = body["evaluator_model"]
        if not isinstance(em, str) or not em.strip():
            raise LlmConfigError("evaluator_model 须为非空字符串")
        out["evaluator_model"] = em.strip()
    # design contract:调用方式(全局单选)。mantle(现状 design contract)/ bedrock_converse(传统 Bedrock Converse API)。
    # 缺省/未带 = mantle(向后兼容,现状逐字节不变)。
    if "call_method" in body and body["call_method"] is not None:
        cm = body["call_method"]
        if cm not in ("mantle", "bedrock_converse"):
            raise LlmConfigError("call_method 须为 'mantle' 或 'bedrock_converse'")
        out["call_method"] = cm
    # design contract:converse 的 ?region= 上游 Bedrock region(mantle-proxy 路由参数)。默认 us-east-1。
    if "bedrock_region" in body and body["bedrock_region"] is not None:
        br = body["bedrock_region"]
        if not isinstance(br, str) or not br.strip():
            raise LlmConfigError("bedrock_region 须为非空字符串")
        out["bedrock_region"] = br.strip()
    if "bedrock_api_key_expires_at" in body:
        expires_utc = _parse_bedrock_expiry(body["bedrock_api_key_expires_at"])
        now_utc = (now or datetime.now(UTC)).astimezone(UTC)
        if expires_utc <= now_utc:
            raise LlmConfigError("bedrock_api_key_expires_at 必须晚于当前时间")
        out["bedrock_api_key_expires_at"] = expires_utc.isoformat().replace("+00:00", "Z")
    # 注:model id **不强校验前缀**(设计决策自负)——converse 需 inference profile 格式(global.anthropic.*)、
    # mantle 用裸短名,但填错只在运行时 fail-fast,配置层不拦(前端给格式提示)。故此处不按 call_method 加 model 校验。
    # design contract:ASR 字幕修正模型。**校验放宽为「可空=不修」**——区别于 evaluator_model 的强制非空:
    # 空串 / null 都合法(= 不修,bridge 不下发 fixer,字幕/转写走原文);非空时才要求 ∈ models(merge 后统一校验)。
    if "transcript_fixer_model" in body:
        tfm = body["transcript_fixer_model"]
        if tfm is None or (isinstance(tfm, str) and not tfm.strip()):
            out["transcript_fixer_model"] = ""  # 归一化「不修」为空串
        elif isinstance(tfm, str):
            out["transcript_fixer_model"] = tfm.strip()
        else:
            raise LlmConfigError("transcript_fixer_model 须为字符串或 null(空 = 不修)")
    # design contract:主备 fallback 备用模型序(有序 list[str],去空/去重;是否 ∈ models 在 merge 后统一校验)。
    # 对话发起时:主模型(Agent.llm_model_id 或 default_model)出首 token 前失败/超时 → 依次切这些备用重跑本轮。
    # 空列表 = 关闭 fallback(单模型,行为回退 design contract)。
    if "fallback_models" in body and body["fallback_models"] is not None:
        fbs = body["fallback_models"]
        if not isinstance(fbs, list):
            raise LlmConfigError("fallback_models 须为列表(model id 字符串)")
        clean_fb: list[str] = []
        for m in fbs:
            if not isinstance(m, str) or not m.strip():
                raise LlmConfigError("fallback_models 每项须为非空字符串")
            mid = m.strip()
            if mid not in clean_fb:  # 去重,保序
                clean_fb.append(mid)
        out["fallback_models"] = clean_fb
    return out


def _mask_key(api_key: str) -> dict:
    if not api_key:
        return {"has_key": False, "last4": None}
    return {"has_key": True, "last4": api_key[-4:]}


def _mask_bedrock_key(bedrock_api_key: str) -> dict:
    """design contract:Bedrock API Key 脱敏(converse 凭据,与 mantle token 分开脱敏)。"""
    if not bedrock_api_key:
        return {"has_bedrock_key": False, "bedrock_last4": None}
    return {"has_bedrock_key": True, "bedrock_last4": bedrock_api_key[-4:]}


def masked_view(raw: dict) -> dict:
    """Secret 原始配置 → 脱敏对外视图(供 GET)。明文 token 不出现。"""
    return {
        "enabled": bool(raw.get("enabled", False)),  # 启用自定义(mantle);关=走 Haiku/IAM 回退
        "host": raw.get("host") or DEFAULT_HOST,
        "models": raw.get("models") or [],
        "default_model": raw.get("default_model") or DEFAULT_MODEL,
        # 打分模型(evaluator 跨境):缺省回退 default_model(而非硬默认),让「只配对话模型」也能打分。
        # 单一事实源 effective_evaluator_model(design contract:与发起下发 llm_moderation_model_id 同口径)。
        "evaluator_model": effective_evaluator_model(raw),
        # design contract:ASR 字幕修正模型。**空=不修**,MUST NOT 回退 default_model(区别于 evaluator_model)——
        # 没显式配就是不修(bridge 不下发 fixer,字幕/转写走 ASR 原文)。seed 默认由 CDK 分区感知下发(非中国区 Haiku)。
        "transcript_fixer_model": raw.get("transcript_fixer_model") or "",
        # design contract:主备 fallback 备用模型序(对外可见,非密)。缺省空 = 关闭 fallback。
        "fallback_models": raw.get("fallback_models") or [],
        # design contract:调用方式(全局单选)+ converse 上游 region。缺省 mantle(向后兼容)/ us-east-1。
        "call_method": raw.get("call_method") or DEFAULT_CALL_METHOD,
        "bedrock_region": raw.get("bedrock_region") or DEFAULT_BEDROCK_REGION,
        "bedrock_api_key_expires_at": raw.get("bedrock_api_key_expires_at") or None,
        **_mask_key(raw.get("api_key") or ""),
        **_mask_bedrock_key(raw.get("bedrock_api_key") or ""),  # design contract:Bedrock API Key 脱敏(converse 凭据)
    }


def call_method(raw: dict) -> str:
    """design contract:当前调用方式(全局单选)。缺省 mantle(向后兼容)。"""
    cm = raw.get("call_method")
    return cm if cm in ("mantle", "bedrock_converse") else DEFAULT_CALL_METHOD


def llm_credential_status(raw: dict, *, now: datetime | None = None) -> dict:
    """返回 Voice Chat 可读取的非密凭据状态；到期边界统一按服务端 UTC 计算。"""
    if not raw.get("enabled") or call_method(raw) != "bedrock_converse":
        return {"status": "not_applicable", "expires_at": None}

    raw_expiry = raw.get("bedrock_api_key_expires_at")
    if not (raw.get("bedrock_api_key") or "").strip() or not isinstance(raw_expiry, str):
        return {"status": "not_configured", "expires_at": raw_expiry if isinstance(raw_expiry, str) else None}
    try:
        expires_utc = _parse_bedrock_expiry(raw_expiry)
    except LlmConfigError:
        return {"status": "not_configured", "expires_at": None}

    normalized_expiry = expires_utc.isoformat().replace("+00:00", "Z")
    now_utc = (now or datetime.now(UTC)).astimezone(UTC)
    if expires_utc <= now_utc:
        status = "expired"
    elif expires_utc <= now_utc + timedelta(days=7):
        status = "expiring"
    else:
        status = "ok"
    return {"status": status, "expires_at": normalized_expiry}


def effective_evaluator_model(raw: dict) -> str:
    """design contract(review):打分/裁判模型的**统一求值**——evaluator_model → default_model → 硬默认。
    raw 是 LlmConfigSecret 原 dict(可能没有 evaluator_model 键,缺省只在 masked_view 兜底)。发起时下发
    llm_moderation_model_id 与 evaluator 读侧 MUST 同口径,故都调此函数,不直读 raw['evaluator_model'](可能 None)。"""
    return (raw.get("evaluator_model") or raw.get("default_model") or DEFAULT_EVALUATOR_MODEL).strip()


def active_credential(raw: dict) -> str:
    """design contract:按 call_method 取当前生效凭据(evaluator 直读 + 发起注入都用此,避免拿错)。
    mantle → api_key(mantle Bearer token);bedrock_converse → bedrock_api_key(Bedrock API Key)。"""
    if call_method(raw) == "bedrock_converse":
        return (raw.get("bedrock_api_key") or "").strip()
    return (raw.get("api_key") or "").strip()


def is_enabled(raw: dict) -> bool:
    """自定义 LLM 是否启用:须显式 enabled=true 且**当前 call_method 对应的凭据**已配。否则走 IAM Haiku 回退。
    design contract:mantle 看 api_key、bedrock_converse 看 bedrock_api_key(按方式取,不混用)。"""
    return bool(raw.get("enabled")) and bool(active_credential(raw))


def catalog_ids(raw: dict) -> list[str]:
    """当前允许的 model id 集合(供发起时权威校验 / Agent 编辑预校验)。"""
    return [m["id"] for m in (raw.get("models") or []) if isinstance(m, dict) and m.get("id")]


def merge_config(current: dict, patch: dict, *, new_api_key: str | None = None,
                 new_bedrock_api_key: str | None = None) -> dict:
    """把校验过的非密 patch + 可选新 key 合进现有配置,产出写回 Secret 的完整 JSON。

    - models 为**整体替换**(不同于 minimax voice_map 的深合并:清单增删是整体操作,更直观);
    - new_api_key=None → 保留旧 key;非空 → 替换。
    - design contract:new_bedrock_api_key 同理(converse 凭据,与 mantle token 分开存)。
    """
    merged = dict(current or {})
    merged.update(patch)
    if new_api_key is not None:
        merged["api_key"] = new_api_key
    if new_bedrock_api_key is not None:
        merged["bedrock_api_key"] = new_bedrock_api_key  # design contract:converse 凭据
    merged.setdefault("enabled", False)
    merged.setdefault("host", DEFAULT_HOST)
    merged.setdefault("models", [])
    merged.setdefault("default_model", DEFAULT_MODEL)
    merged.setdefault("api_key", "")
    merged.setdefault("fallback_models", [])  # design contract:缺省空 = 关闭 fallback
    # design contract:call_method / bedrock_region / bedrock_api_key 不设硬默认写死(缺省时读侧 masked_view 回退 mantle/us-east-1;
    # 凭据缺省空)。避免把 mantle 写死进 Secret 影响「旧配置无 call_method 即 mantle」的向后兼容语义。
    # evaluator_model 不设硬默认(缺省时读侧 masked_view 回退 default_model),避免把 default 写死进 Secret。
    # transcript_fixer_model(design contract):不设硬默认(空 = 不修)。seed 由 CDK 分区感知(非中国区 Haiku);
    # 此处不 setdefault 任何值,避免非空写死进 Secret 影响「可空=不修」语义。
    return merged


def validate_default_in_models(merged: dict) -> None:
    """校验 default_model / evaluator_model / fallback_models ∈ models(合并后统一校验)。models 非空时须在其中。"""
    ids = catalog_ids(merged)
    dm = merged.get("default_model")
    if ids and dm and dm not in ids:
        raise LlmConfigError(f"default_model={dm!r} 不在 models 清单中(须为清单内某 id)")
    em = merged.get("evaluator_model")
    if ids and em and em not in ids:
        raise LlmConfigError(f"evaluator_model={em!r} 不在 models 清单中(须为清单内某 id)")
    # design contract:transcript_fixer_model **可空**(空=不修,跳过校验);**非空**时才要求 ∈ 清单(与 default/evaluator 同口径)。
    tfm = merged.get("transcript_fixer_model")
    if ids and tfm and tfm not in ids:
        raise LlmConfigError(f"transcript_fixer_model={tfm!r} 不在 models 清单中(须为清单内某 id,或留空=不修)")
    # design contract:每个备用模型也须 ∈ 清单(与 default_model 同口径 TOCTOU 静态校验)。
    if ids:
        for fb in (merged.get("fallback_models") or []):
            if fb not in ids:
                raise LlmConfigError(f"fallback_models 含 {fb!r} 不在 models 清单中(须为清单内某 id)")


class LlmConfigStore:
    """Secrets Manager 读写封装(懒加载 client;测试注入 fake)。

    单一 Secret 承载 api_key + 非密参数 JSON。明文 token 绝不进日志/DDB/响应(masked_view 把关)。
    """

    def __init__(self, settings, *, client=None):
        self.settings = settings
        self._client = client

    @property
    def secret_id(self) -> str | None:
        return getattr(self.settings, "llm_secret_arn", None)

    def _sm(self):
        if self._client is None:
            import boto3  # noqa: PLC0415

            self._client = boto3.client("secretsmanager", region_name=self.settings.region)
        return self._client

    def read_raw(self) -> dict:
        """读 Secret 原始 JSON(含明文 token,仅服务端内部用,绝不直接回前端 / 打日志)。

        区分两类"读不到"(对齐 minimax:瞬时读失败若返 {} → merge 会默认写 api_key:"" 覆盖生产 key):
          - Secret 不存在(ResourceNotFoundException)/ SecretString 空 → 合法"首次未配置",返 {};
          - 其它读失败(限流/网络/权限)→ **抛错**,让 PUT 路径 fail-closed(502)。
        """
        if not self.secret_id:
            return {}
        try:
            resp = self._sm().get_secret_value(SecretId=self.secret_id)
        except Exception as exc:  # noqa: BLE001
            from botocore.exceptions import ClientError  # noqa: PLC0415

            if isinstance(exc, ClientError) and \
                    exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                return {}
            logger.warning("读 LLM Secret 失败(非 NotFound,不静默返空以免覆盖现有 key): %s", exc)
            raise
        body = resp.get("SecretString")
        if not body:
            return {}
        try:
            obj = json.loads(body)
        except (ValueError, TypeError):
            logger.warning("LLM Secret JSON 解析失败(拒绝以空配置覆盖)")
            raise
        return obj if isinstance(obj, dict) else {}

    def write_raw(self, raw: dict) -> None:
        """写回 Secret(PutSecretValue)。raw 含明文 token —— 不打日志。"""
        if not self.secret_id:
            raise LlmConfigError("LLM Secret 未配置(AIM_LLM_CONFIG_SECRET_ID)")
        self._sm().put_secret_value(
            SecretId=self.secret_id,
            SecretString=json.dumps(raw, ensure_ascii=False),
        )
