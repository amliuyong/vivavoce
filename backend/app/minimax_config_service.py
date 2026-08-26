"""MiniMax TTS provider 配置服务(design contract,控制面侧)。

系统级全局一套配置(一个账号供全系统共用),装在**单一 Secret 的 JSON**:
  { enabled, base_url, model, voice_map, api_key }
- 读 MUST 脱敏(仅回 has_key + 末 4 位),明文 key MUST NOT 出现在响应/日志/DDB。
- 写经 Secrets Manager(PutSecretValue);保留旧 key(PUT 不带 key 时不动 key)。
- 非密参数与 key 同载该 Secret(design contract:GPU 从单一来源读全部配置)。

纯逻辑可单测:校验 + 脱敏 + merge 在此;Secrets Manager I/O 经注入的 client(测试用 fake)。
"""
from __future__ import annotations

import json
import logging

logger = logging.getLogger("aim.minimax_config")

# 默认值(与 gpu/gpu_service/minimax_config.py 契约对齐;两侧默认一致避免漂移)。
DEFAULT_BASE_URL = "https://api.minimaxi.com/v1/t2a_v2"
DEFAULT_MODEL = "speech-2.8-turbo"
# voice_map:语义 key → MiniMax voice_id。裸 key = 默认中文音色;"<key>.<lang>"(male_std.en…)= 该语言
# 母语音色(修「英文用中文音色 → 口音重」,GPU voice_id_for 据会话 language 逐句选;与 OmniVoice 英文参考音
# 同一套 "<key>.<lang>" 约定 + 同一英文音色选型)。
DEFAULT_VOICE_MAP = {
    "male_std": "Chinese (Mandarin)_Gentleman",
    "female_std": "Chinese (Mandarin)_Kind-hearted_Antie",
    "male_std.en": "English_Trustworth_Man",
    "female_std.en": "English_Graceful_Lady",
}


class MiniMaxConfigError(ValueError):
    """配置校验失败(路由层转 400)。"""


def validate_config_patch(body: dict) -> dict:
    """校验 admin PUT 的**非密**参数(不含 key — key 单独走 set_api_key 路径)。

    返回规范化的非密参数 dict(enabled/base_url/model/voice_map)。非法抛 MiniMaxConfigError。
    - enabled:bool
    - base_url:非空字符串,须 https(整串可覆盖切备用域名/灰度)
    - model:非空字符串
    - voice_map:str→str 映射(至少含一个已知 key 也可空 = 用默认),值非空
    """
    out: dict = {}
    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            raise MiniMaxConfigError("enabled 须为布尔值")
        out["enabled"] = body["enabled"]
    if "base_url" in body and body["base_url"] is not None:
        bu = body["base_url"]
        if not isinstance(bu, str) or not bu.strip():
            raise MiniMaxConfigError("base_url 须为非空字符串")
        if not bu.startswith("https://"):
            raise MiniMaxConfigError("base_url 须为 https://(完整 endpoint URL)")
        out["base_url"] = bu.strip()
    if "model" in body and body["model"] is not None:
        m = body["model"]
        if not isinstance(m, str) or not m.strip():
            raise MiniMaxConfigError("model 须为非空字符串")
        out["model"] = m.strip()
    if "voice_map" in body and body["voice_map"] is not None:
        vm = body["voice_map"]
        if not isinstance(vm, dict):
            raise MiniMaxConfigError("voice_map 须为对象(语义 key→voice_id)")
        clean: dict[str, str] = {}
        for k, v in vm.items():
            if not isinstance(k, str) or not isinstance(v, str) or not v.strip():
                raise MiniMaxConfigError("voice_map 的 key/value 须为非空字符串")
            clean[k] = v.strip()
        out["voice_map"] = clean
    return out


def _mask_key(api_key: str) -> dict:
    """脱敏:仅回 has_key + 末 4 位(明文绝不回显)。"""
    if not api_key:
        return {"has_key": False, "last4": None}
    return {"has_key": True, "last4": api_key[-4:]}


def masked_view(raw: dict) -> dict:
    """把 Secret 里的原始配置 → 脱敏的对外视图(供 GET)。明文 key 不出现。"""
    return {
        "enabled": bool(raw.get("enabled", False)),
        "base_url": raw.get("base_url") or DEFAULT_BASE_URL,
        "model": raw.get("model") or DEFAULT_MODEL,
        "voice_map": raw.get("voice_map") or dict(DEFAULT_VOICE_MAP),
        **_mask_key(raw.get("api_key") or ""),
    }


def merge_config(current: dict, patch: dict, *, new_api_key: str | None = None) -> dict:
    """把校验过的非密 patch + 可选新 key 合进现有配置,产出要写回 Secret 的完整 JSON。

    - new_api_key=None:**保留旧 key**(改非密参数不动 key;空串在路由层已归一为 None);
    - new_api_key 非空:替换 key。
    清空 key 不走此路径(UI 不提供,避免误抹;需要时直接编辑/删 Secret)。
    """
    merged = dict(current or {})
    # voice_map 单独**深合并**(非整体替换):patch 只带要改的 key,其余保留 —— 否则部分更新(如只改
    # male_std)会静默丢掉 female_std 映射(review)。先合并 voice_map,再 update 其余键。
    patch = dict(patch)
    if "voice_map" in patch:
        vm = dict(merged.get("voice_map") or {})
        vm.update(patch.pop("voice_map"))
        merged["voice_map"] = vm
    merged.update(patch)
    if new_api_key is not None:
        merged["api_key"] = new_api_key
    # 兜底默认(首次配置时 current 为空)
    merged.setdefault("enabled", bool(patch.get("enabled", merged.get("enabled", False))))
    merged.setdefault("base_url", DEFAULT_BASE_URL)
    merged.setdefault("model", DEFAULT_MODEL)
    merged.setdefault("voice_map", dict(DEFAULT_VOICE_MAP))
    merged.setdefault("api_key", "")
    return merged


class MiniMaxConfigStore:
    """Secrets Manager 读写封装(懒加载 client;测试注入 fake)。

    单一 Secret 承载 key + 非密参数 JSON。明文 key 绝不进日志/DDB/响应(masked_view 把关)。
    """

    def __init__(self, settings, *, client=None):
        self.settings = settings
        self._client = client

    @property
    def secret_id(self) -> str | None:
        return self.settings.minimax_secret_arn

    def _sm(self):
        if self._client is None:
            import boto3  # noqa: PLC0415

            self._client = boto3.client("secretsmanager", region_name=self.settings.region)
        return self._client

    def read_raw(self) -> dict:
        """读 Secret 的原始 JSON(含明文 key,仅服务端内部用,绝不直接回前端)。

        ★ 区分两类"读不到"(review:瞬时读失败若一律返 {} → PUT 的 merge_config 会默认写
          api_key:"" → 一次抖动就把生产 key 覆盖掉):
          - Secret 不存在(ResourceNotFoundException)/ SecretString 为空 → **合法的"首次未配置"**,返 {};
          - 其它读失败(限流/网络/权限抖动)→ **抛错**,让 PUT 路径 fail-closed(502),绝不拿 {} 继续 merge 写回。
        """
        if not self.secret_id:
            return {}
        try:
            resp = self._sm().get_secret_value(SecretId=self.secret_id)
        except Exception as exc:  # noqa: BLE001
            from botocore.exceptions import ClientError  # noqa: PLC0415
            # 仅"Secret 不存在"视作首次未配置(返 {});其余(限流/网络/权限)抛错,不污染写路径。
            if isinstance(exc, ClientError) and \
                    exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
                return {}
            logger.warning("读 MiniMax Secret 失败(非 NotFound,不静默返空以免覆盖现有 key): %s", exc)
            raise
        body = resp.get("SecretString")
        if not body:
            return {}  # SecretString 空 = 首次未写,合法
        try:
            obj = json.loads(body)
        except (ValueError, TypeError):
            # JSON 坏(不该发生)→ 抛错而非返空,避免 merge 覆盖
            logger.warning("MiniMax Secret JSON 解析失败(拒绝以空配置覆盖)")
            raise
        return obj if isinstance(obj, dict) else {}

    def write_raw(self, raw: dict) -> None:
        """写回 Secret(PutSecretValue)。raw 含明文 key —— 不打日志。"""
        if not self.secret_id:
            raise MiniMaxConfigError("MiniMax Secret 未配置(AIM_MINIMAX_SECRET_ID)")
        self._sm().put_secret_value(
            SecretId=self.secret_id,
            SecretString=json.dumps(raw, ensure_ascii=False),
        )


def _voice_api_url(base_url: str) -> str:
    """据 t2a base_url 推出 get_voice 端点(同源,路径换成 /v1/get_voice)。
    base_url 形如 https://api.minimaxi.com/v1/t2a_v2 → https://api.minimaxi.com/v1/get_voice。"""
    from urllib.parse import urlparse  # noqa: PLC0415
    p = urlparse(base_url or DEFAULT_BASE_URL)
    origin = f"{p.scheme}://{p.netloc}" if p.scheme and p.netloc else "https://api.minimaxi.com"
    return f"{origin}/v1/get_voice"


class VoiceListUnavailable(RuntimeError):
    """get_voice 调用失败(网络/限流/鉴权)。校验路径据此 fail-open(跳过校验,不阻塞保存)。"""


def list_voice_ids(api_key: str, base_url: str, *, timeout_s: float = 8.0) -> set[str]:
    """账号可用 voice_id 集合(供校验)。复用 list_voices(含 base_resp.status_code 校验)。
    失败(网络/限流/鉴权 1004/坏响应)抛 VoiceListUnavailable —— 调用方 fail-open(跳过校验)。"""
    return {v["voice_id"] for v in list_voices(api_key, base_url, timeout_s=timeout_s)}


def list_voices(api_key: str, base_url: str, *, timeout_s: float = 8.0) -> list[dict]:
    """调 get_voice 返回结构化清单(voice_id + voice_name + category),供前端下拉选。
    失败抛 VoiceListUnavailable(路由层 fail-open)。"""
    import urllib.error  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415

    if not api_key:
        raise VoiceListUnavailable("无 API key")
    req = urllib.request.Request(
        _voice_api_url(base_url), data=json.dumps({"voice_type": "all"}).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            obj = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise VoiceListUnavailable(f"get_voice 调用失败: {exc}") from exc
    base = obj.get("base_resp") or {}
    try:
        status = int(base.get("status_code"))
    except (TypeError, ValueError):
        status = -1
    if status != 0:
        raise VoiceListUnavailable(f"get_voice base_resp.status_code={base.get('status_code')}")
    return _parse_voice_list(obj)


def _parse_voice_list(obj: dict) -> list[dict]:
    """从 get_voice 响应抽 [{voice_id, voice_name, category}]。系统音色有 voice_name,克隆/文生用 id 兜底。"""
    out: list[dict] = []
    for key, cat in (("system_voice", "system"), ("voice_cloning", "cloning"),
                     ("voice_generation", "generation")):
        for item in obj.get(key) or []:
            if not isinstance(item, dict):
                continue
            vid = item.get("voice_id")
            if not isinstance(vid, str) or not vid:
                continue
            name = item.get("voice_name") if isinstance(item.get("voice_name"), str) else None
            out.append({"voice_id": vid, "voice_name": name or vid, "category": cat})
    return out
