"""运行时诊断配置的**中文元数据字典 + 安全脱敏**(design contract)。

单一事实源
----------
每项的中文名/说明/单位/分组 **只**在本文件登记。bridge/GPU 的 ``/config`` **MUST NOT** 承载中文
解释;前端 i18n **MUST NOT** 硬编码逐项说明(只承载页面框架文案)。改说明只需动本文件。

安全模型:三层,判定顺序固定
----------------------------
=========================  ======================  ==================
条目类别                   ``effective_value``     ``default``
=========================  ======================  ==================
**未登记**(不在 META)     ``None`` + 标记          ``None``
**已登记但敏感/命中 denylist**  布尔「已配置/未配置」  ``None``
**已登记非敏感**            实际生效值(过形状守门)  实际默认值
=========================  ======================  ==================

判定顺序 MUST 为 **名称 denylist(布尔化)> allowlist 缺失(置 None)> 正常展示** ——
此序系 AIM 侧 ``system_settings_meta.py:486`` 已实测固化并通过真机验收,勿重排。

⚠ 两条易踩的坑(均为实测教训,勿"简化"):

1. **denylist MUST 用后缀锚定,不用子串**。子串形式(``SECRET|TOKEN|KEY|…``)会把
   ``MCP_REFRESH_TOKEN_VALIDITY_DAYS``(值 = 90)脱敏成「已配置」,而那正是本页要给运维看的
   运营值。AIM 实施期发现该自相矛盾并经裁定收窄。
2. **``default`` 也要管**。只脱敏 ``effective_value`` 会让敏感项的 ``default`` 仍然泄漏
   (review)。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

#: 展示策略。``value`` 展示实际值;``configured_only`` 只回「已配置/未配置」布尔;``hidden`` 完全隐藏。
DisplayPolicy = Literal["value", "configured_only", "hidden"]

#: 条目来源(复合身份 ``(source, key)`` 的前半;同名 key 可跨运行时并存,MUST 分别成条目)。
Source = Literal["control", "media", "gpu", "iac_manifest"]

#: 标定状态(design contract)。
#:
#: - ``stable``:已标定/已定论 —— **默认值就是最佳值**。生效值 ≠ 默认值 = 真异常,值得标「异于默认」。
#: - ``pending``:**确实未标定** —— 与默认值不同是**预期状态**(标定期显式开启),显示「待标定」而非「异于默认」。
#: - ``n/a``:没有「标定」这个概念(部署形态 / 派生值 / 拓扑地址 / 凭据)。
CalibrationStatus = Literal["stable", "pending", "n/a"]


@dataclass(frozen=True)
class SettingMeta:
    """单项的中文元数据。"""

    name_zh: str
    desc_zh: str
    #: 单位(``ms`` / ``次`` / ``倍`` / ``Hz`` / 空串表示无单位)。
    unit: str
    #: 分组(前端按此渲染卡片)。
    group: str
    display_policy: DisplayPolicy = "value"
    #: **「默认值」这个概念对本项是否成立**(design contract)。
    #:
    #: ``False`` 的四族(它们没有「默认 vs 覆盖」的语义,裸比较 ``effective != default`` 对它们无意义):
    #:
    #: 1. **部署形态**:``AIM_GPU_BACKEND=funasr`` vs ``stub`` —— 有无 GPU 的部署事实,不是调优。
    #: 2. **派生值**:``MAX_CONCURRENCY`` = ``GPU_HARD_MAX × 每实例``,由 CDK 算出。
    #: 3. **拓扑地址**:``AIM_BRIDGE_DIAL_URL`` 等 —— 只有「配了/没配」。
    #: 4. **凭据 / 隐藏项**:无默认值可比(``display_policy`` 非 ``value`` 时自动归此族)。
    #:
    #: ⚠ 为什么需要它(design contract §动机):事故前只读页把线上**正确**配置渲染成「异于默认」——
    #: 修好了被标成偏离标准。订正后 ``differs_from_default`` 仅对
    #: ``default_comparable and calibration_status == "stable"`` 成立。
    default_comparable: bool = True
    calibration_status: CalibrationStatus = "stable"


#: **名称级 denylist**(兜底):命中即强制脱敏,无论是否登记。
#:
#: ⚠ **后缀锚定**(``$``)而非子串 —— 见模块 docstring 坑 1。
#: ``PASSWORD`` / ``CREDENTIAL`` / ``SIGNING`` 也锚定后缀,避免误伤
#: ``PASSWORD_RESET_LINK_TTL`` 这类运营值(review)。
_DENYLIST_RE = re.compile(
    r"(_SECRET|_TOKEN|_API_KEY|_KEY|_PASSWORD|_CREDENTIALS?|_SIGNING_KEY|_PRIVATE_KEY)$",
    re.IGNORECASE,
)


def is_sensitive_name(key: str) -> bool:
    """key 名是否命中敏感 denylist(大小写不敏感,后缀锚定)。"""
    return _DENYLIST_RE.search(key) is not None


#: **值形状守门**(第二道轴):即便名称不敏感,值长得像凭据也要拦。
#: 覆盖 Secret ARN 前缀 / 常见 API key 前缀 / URL 内嵌 ``user:pass@host`` / 超长值。
_VALUE_SHAPE_PATTERNS = (
    re.compile(r"^arn:aws[a-z-]*:secretsmanager:", re.IGNORECASE),
    re.compile(r"^(sk|pk|rk)-[A-Za-z0-9_-]{8,}"),
    re.compile(r"^AKIA[0-9A-Z]{12,}"),
    re.compile(r"^ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"^[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@"),  # user:pass@host
)

#: 超长值一律不展示(可能是整段凭据/证书)。
_MAX_VALUE_LEN = 512


def value_looks_sensitive(value: Any) -> bool:
    """值的**形状**是否像凭据(与名称 denylist 正交的第二道轴)。"""
    if not isinstance(value, str):
        return False
    if len(value) > _MAX_VALUE_LEN:
        return True
    return any(p.search(value) for p in _VALUE_SHAPE_PATTERNS)


# ── 元数据登记表 ────────────────────────────────────────────────────────────
# 以 (source, key) 为键。**未登记项不会被丢弃**(仍列出,但值置 None + metadata_missing),
# 故此表可渐进补全;但登记越全,页面越有用。

SETTINGS_META: dict[tuple[Source, str], SettingMeta] = {
    # ══ 媒体面:端点看门狗(bridge 兜底 turn_end)══
    ("media", "AIM_ENDPOINT_RMS_THRESHOLD"): SettingMeta(
        "端点检测能量阈值", "入向音频 RMS 低于此值视为静音,用于兜底判定考生说完。"
        "MUST ≥ GPU 侧 VAD 阈值(跨面不变式),否则 bridge 会比 GPU 先判静音。", "RMS", "端点看门狗"),
    ("media", "AIM_ENDPOINT_SILENCE_GAP_MS"): SettingMeta(
        "端点静音间隔", "连续静音超过此时长即主动结束当前轮(GPU VAD 不出 turn_end 时的兜底)。",
        "ms", "端点看门狗"),
    ("media", "AIM_ENDPOINT_MIN_SPEECH_MS"): SettingMeta(
        "端点最短语音", "本轮累计语音短于此时长不触发结轮(防咳嗽/噪声脉冲误判)。", "ms", "端点看门狗"),
    ("media", "AIM_VAD_ENERGY_THRESHOLD"): SettingMeta(
        "VAD 能量阈值(媒体面副本)",
        "⚠ bridge 侧**仅用于跨面不变式校验**(endpoint ≥ vad),**不驱动** VAD;"
        "真正驱动 VAD 的是 GPU 侧同名开关。两值不同即为部署漂移。", "RMS", "端点看门狗"),
    # ══ 媒体面:打断(barge-in)══
    ("media", "AIM_BARGE_RMS_THRESHOLD"): SettingMeta(
        "打断能量阈值", "考生插话被认定为「打断」的能量门槛。", "RMS", "打断检测"),
    ("media", "AIM_BARGE_CONFIRM_MS"): SettingMeta(
        "打断确认时长", "高能量需连续维持此时长才判打断(防瞬时噪声误打断)。", "ms", "打断检测"),
    ("media", "AIM_BARGE_HANGOVER_MS"): SettingMeta(
        "打断能量保持窗", "字间停顿不超过此时长仍算同一次连续说话(防真人停顿清零计数)。", "ms", "打断检测"),
    ("media", "AIM_INTERRUPTION_MIN_WORDS"): SettingMeta(
        "打断最少字数", "识别文本少于此字数不算有效打断(0=不设门槛)。", "字", "打断检测"),
    ("media", "AIM_BARGE_DTD"): SettingMeta(
        "双讲检测(DTD)", "开启后用双讲检测识别「AI 在说时考生插话」;关闭则回退固定能量阈值。",
        "", "打断检测"),
    ("media", "AIM_BARGE_DTD_FLOOR"): SettingMeta(
        "双讲能量地板", "AI 静默时入向超过此值即判有人声(须高于环境底噪)。", "RMS", "打断检测"),
    ("media", "AIM_BARGE_DTD_ECHO_GAIN"): SettingMeta(
        "双讲回声增益", "入向须超过「此系数 × AI 参考能量」才判双讲(压过回声)。真机标定值,勿随意改。",
        "倍", "打断检测"),
    ("media", "AIM_BARGE_DTD_WINDOW_MS"): SettingMeta(
        "双讲参考窗", "计算 AI 参考能量的滑动窗口长度。", "ms", "打断检测"),
    ("media", "AIM_BARGE_DYN_FLOOR"): SettingMeta(
        "动态噪声地板", "开启后按近期底噪自适应抬高打断门槛,治高底噪环境误打断。", "", "打断检测"),
    ("media", "AIM_BARGE_DYN_FLOOR_WINDOW_MS"): SettingMeta(
        "动态地板窗口", "统计底噪分位数的时间窗。", "ms", "打断检测"),
    ("media", "AIM_BARGE_DYN_FLOOR_K"): SettingMeta(
        "动态地板系数", "地板 = 窗内低分位能量 × 此系数。", "倍", "打断检测"),
    # design contract C 类:**确实未标定**(台账明写「500/1.5 是保守起点非标定终值,grid search 未做」)
    #   → calibration_status="pending":与默认值不同是**预期**(标定期显式开启),显示「待标定」非「异于默认」。
    ("media", "AIM_BARGE_OPEN_COOLDOWN_MS"): SettingMeta(
        "AI 开口冷却窗", "AI 刚开口的这段时间内抬高打断门槛(0=关)。**待标定**:离线扫参未做。",
        "ms", "打断检测", calibration_status="pending"),
    ("media", "AIM_BARGE_OPEN_COOLDOWN_MULT"): SettingMeta(
        "开口冷却倍数", "冷却窗内门槛放大倍数。**待标定**:与冷却窗同批。",
        "倍", "打断检测", calibration_status="pending"),
    # ══ 媒体面:误打断恢复 ══
    ("media", "AIM_FALSE_INTERRUPTION_RECOVERY"): SettingMeta(
        "误打断恢复", "疑似误打断先暂停不销毁,短窗内无真接管则续播,治「随便有点背景音就打断」。**默认开**(design contract;`=0` 关作 kill switch)。也是 EOU 纠偏与声纹锁定的前置门。", "", "误打断恢复"),
    ("media", "AIM_FALSE_INTERRUPTION_WINDOW_MS"): SettingMeta(
        "误打断判定窗", "打断后这段时间内若无持续人声,判为误打断并恢复。", "ms", "误打断恢复"),
    ("media", "AIM_FALSE_INTERRUPTION_TAKEOVER_MS"): SettingMeta(
        "真打断接管时长", "持续高能量达此时长即确认真打断,不再恢复。", "ms", "误打断恢复"),
    ("media", "AIM_RECOVERY_TAKEOVER_DECAY"): SettingMeta(
        "接管计数衰减", "字间停顿时接管计数的衰减系数(防真人停顿反复清零)。", "倍", "误打断恢复"),
    ("media", "AIM_FALSE_INTERRUPTION_MAX_HOLD_MS"): SettingMeta(
        "恢复窗硬上限", "误打断顺延的最长时间(0=关)。", "ms", "误打断恢复"),
    # ══ 媒体面:主动开场 / 有效输入 ══
    ("media", "AIM_PROACTIVE_OPENING"): SettingMeta(
        "主动开场", "开启后考生久不开口时 AI 主动开场;关闭则被动等待。", "", "开场与输入"),
    ("media", "AIM_PROACTIVE_OPENING_SILENCE_MS"): SettingMeta(
        "主动开场静默阈值", "连接后静默超过此时长即由 AI 主动开场。", "ms", "开场与输入"),
    ("media", "AIM_MIN_INPUT_CHARS"): SettingMeta(
        "有效输入最少字数", "识别文本有效字数低于此值不触发 LLM(挡空/纯标点/单残字)。", "字", "开场与输入"),
    ("media", "AIM_KICKOFF_WAKE_TEXT"): SettingMeta(
        "开场唤醒文本", "主动开场时喂给 LLM 的中性唤醒语(**不写入对话历史**)。", "", "开场与输入"),
    # ══ 媒体面:出题推进 ══
    ("media", "AIM_QUESTION_MIN_ANSWER_CHARS"): SettingMeta(
        "作答最少字数", "低于此字数不算有效作答,游标不推进。", "字", "出题推进"),
    ("media", "AIM_QUESTION_MAX_RETRY"): SettingMeta(
        "同题最多重试", "同一题重问上限,到顶强制推进(防死循环)。已钳制为至少 1。", "次", "出题推进"),
    ("media", "AIM_QUESTION_MAX_FOLLOW_UPS"): SettingMeta(
        "单题追问预算", "同一题最多追问次数(模型违约与听不清澄清的纵深上限)。", "次", "出题推进"),
    ("media", "AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS"): SettingMeta(
        "末题强制收尾超时", "末题后等待模型收尾的上限,超时由服务端强制收尾。", "ms", "出题推进"),
    ("media", "AIM_ANSWER_GRACE_MS"): SettingMeta(
        "答完补充宽限", "判定已作答后再等这段时间收补充内容才推进。", "ms", "出题推进"),
    ("media", "AIM_AUTO_NEXT_GRACE_MS"): SettingMeta(
        "自动下题宽限", "自动推进到下一题前的等待时间。", "ms", "出题推进"),
    # design contract C 类:**确实未标定** —— validation rationale 记真机 stall 发生率 **1/3**(本场 3 轮触发 1 次)
    #   且明写「默认开启前应调 questionVoiced 阈值或多轮观察」→ 最佳值尚未找到,保持默认关。
    #   (评审 曾主张「可删」,该设计约束 驳回:删开关等于把「未标定」伪装成「已定论」。)
    ("media", "AIM_CURSOR_VOICED_GATE"): SettingMeta(
        "游标念出闭环", "开启后推进额外要求「AI 已把当前题念出」(默认关 = 现状开环推进)。"
        "**待标定**:真机 stall 发生率约 1/3,须先调 questionVoiced 阈值。",
        "", "出题推进", calibration_status="pending"),
    ("media", "AIM_CURSOR_VOICED_MAX_STALL"): SettingMeta(
        "念出兜底轮数", "同题连续这么多轮仍未判「已念出」即强制推进(防永久卡题)。", "轮", "出题推进"),
    ("media", "AIM_STALE_ANSWER_MAX"): SettingMeta(
        "陈货兜底轮数", "排水陈货连续判「不驱动推进」达此轮数即强制推进。", "轮", "出题推进"),
    # ══ 媒体面:播放时钟(design contract)══
    ("media", "AIM_MAX_PLAYBACK_LEAD_MS"): SettingMeta(
        "播放超前量上限", "服务端估算「客户端播完」时刻的最大超前量(防队尾虚高致长时间不推进)。",
        "ms", "播放结算"),
    ("media", "AIM_PLAYBACK_LEAD_MARGIN_MS"): SettingMeta(
        "播放余量", "估算播完之上再等的固定余量(覆盖传输/缓冲抖动)。", "ms", "播放结算"),
    # ★ design contract A 类:`AIM_PLAYBACK_ACK_MODE` 条目**已删** —— 开关不存在了,bridge 不再上报此 key。
    #   若留着,只读页会把它显示成「未登记(值已隐藏)」的幽灵项。MUST NOT 加回。
    ("media", "AIM_PLAYBACK_ACK_GRACE_MS"): SettingMeta(
        "ACK 宽限", "估算播完后额外等待客户端 ACK 的余量。", "ms", "播放结算"),
    ("media", "AIM_PLAYBACK_ACK_MAX_WAIT_MS"): SettingMeta(
        "ACK 硬上限", "从下发完音频起等 ACK 的硬上限。MUST ≥ 播放超前量上限 + ACK 宽限(跨参数不变量)。",
        "ms", "播放结算"),
    ("media", "AIM_PLAYBACK_ACK_INPUT_GRACE_MS"): SettingMeta(
        "ACK 输入宽限", "等 ACK 期间收到考生实质输入后,再等 aborted ACK 的宽限。", "ms", "播放结算"),
    # ══ 媒体面:告别挂断 ══
    ("media", "AIM_SEMANTIC_END"): SettingMeta(
        "LLM 语义挂断", "开启则挂断只由 LLM 的两步确认信号驱动;关闭则正则告别词兜底挂断。"
        "⚠ 产品铁律:AI 说要挂后须考生明确确认才挂。", "", "收尾与挂断"),
    ("media", "AIM_FAREWELL_HANGUP"): SettingMeta(
        "告别后主动收尾", "检测到告别语义后主动结束会话(防空挂)。", "", "收尾与挂断"),
    ("media", "AIM_FAREWELL_HANGUP_DELAY_MS"): SettingMeta(
        "告别收尾延迟", "AI 说完告别后延迟这段时间才真正挂断。", "ms", "收尾与挂断"),
    # ★ design contract A 类:`AIM_FAREWELL_TTS_DRAIN_ENABLED` 条目**已删**(同上,开关已无条件化)。
    ("media", "AIM_FAREWELL_TAIL_MS"): SettingMeta(
        "告别尾音余量", "推算播完之上再等的传输/缓冲余量。", "ms", "收尾与挂断"),
    ("media", "AIM_FAREWELL_DRAIN_MAX_MS"): SettingMeta(
        "告别排水硬上限", "推算值过大时的硬上限,到点强制收尾(防永不挂断)。", "ms", "收尾与挂断"),
    # ══ 媒体面:违规检测(design contract)══
    ("media", "AIM_VIOLATION_ENFORCEMENT"): SettingMeta(
        "违规处置启用", "关闭时只记日志(shadow);开启才产生警告/强制结束等考生可感知动作。**默认开**(design contract);⚠ 这是 **kill switch 不是调优参数** —— 会改变会话终态(写 `failed`),误判率异常时设 `=0` 紧急降级。",
        "", "违规检测"),
    ("media", "AIM_MODERATION_TIMEOUT_MS"): SettingMeta(
        "违规裁判超时", "旁路裁判 LLM 的超时。⚠ 跨境部署(北京→美东)TTFT 抖动 1.2~9.3s,勿调小。",
        "ms", "违规检测"),
    ("media", "AIM_MODERATION_CONFIDENCE_THRESHOLD"): SettingMeta(
        "违规高置信门槛", "裁判置信度超过此值才判违规(宁漏勿误)。取值 (0,1]。", "", "违规检测"),
    ("media", "AIM_SILENCE_VIOLATION_MS"): SettingMeta(
        "沉默违规阈值", "等待作答期连续无有效语音超过此时长计一次消极对抗。", "ms", "违规检测"),
    ("media", "AIM_SILENCE_WARN_MAX"): SettingMeta(
        "沉默警告次数", "前 N 次警告,第 N+1 次强制结束。", "次", "违规检测"),
    ("media", "AIM_SEVERE_VIOLATION_MAX"): SettingMeta(
        "严重违规上限", "严重违规(色情/暴力/威胁)达此次数即强制结束。与消极对抗计数**独立**。",
        "次", "违规检测"),
    ("media", "AIM_IDLE_CHATTER_MIN_TURNS"): SettingMeta(
        "离题连续轮数", "高置信离题需连续跨这么多轮才计一次违规(防单轮偶发误伤)。", "轮", "违规检测"),
    ("media", "AIM_FORCED_END_MAX_WAIT_MS"): SettingMeta(
        "强制结束等待上限", "「先说明原因再挂」的原因句播放上限,超时强制结束(防卡死)。", "ms", "违规检测"),
    ("media", "AIM_NO_FRAME_MS"): SettingMeta(
        "断流判定", "入向无音频帧超过此时长判物理断流(**不**计入沉默违规)。", "ms", "违规检测"),
    # ══ 媒体面:静默推进兜底(design contract)══
    ("media", "AIM_R3_SILENCE_ADVANCE"): SettingMeta(
        "静默推进兜底", "已作答后的善意静默先追问再推进(防模型漏发推进信号致卡死)。默认开。",
        "", "静默推进"),
    ("media", "AIM_ADVANCE_NUDGE_MS"): SettingMeta(
        "追问触发静默", "已作答后静默达此时长即追问「还有补充吗」。"
        "**默认值派生自沉默违规阈值 × 40%**(非固定值),保证兜底总时长恒小于违规阈值。",
        "ms", "静默推进"),
    ("media", "AIM_ADVANCE_AFTER_NUDGE_MS"): SettingMeta(
        "追问后推进静默", "追问播完后再静默此时长即服务端主动推进。"
        "**默认值同样派生自沉默违规阈值 × 40%**。", "ms", "静默推进"),
    # ══ 媒体面:EOU 纠偏(design contract)══
    ("media", "AIM_EOU_CORRECTION_ENABLED"): SettingMeta(
        "EOU 纠偏", "用旁路 LLM 判「考生说完没」,治思考停顿被抢话。**默认开**(design contract;`=0` 关)。前置门 = 误打断恢复(关掉前置门则本项实际不生效,启动日志会告警)。", "", "EOU 纠偏"),
    ("media", "AIM_EOU_CORRELATION_MS"): SettingMeta(
        "EOU 关联窗", "旁路判定结果需在此窗内返回才**算数**(判定回来太晚即作废)。由跨境 TTFT 支配。"
        "MUST ≥ 判定超时且留余量,违反则**启动期 fail-fast**(design contract:原先只 warn 带病运行 = L3 静默失效)。",
        "ms", "EOU 纠偏"),
    ("media", "AIM_EOU_SUB_THRESHOLD_WINDOW_MS"): SettingMeta(
        "EOU 降门槛窗", "判「未说完」后,考生**「反悔接话」的宽容期**有多长 —— 窗内降低让位门槛,"
        "让亚阈续说也能打断 AI。**与跨境延迟无关**(design contract:此前误与关联窗共用一个值,"
        "致「为跨境调超时」顺带把宽容期拉长 2.4 倍)。", "ms", "EOU 纠偏"),
    ("media", "AIM_EOU_SUB_THRESHOLD_MULT"): SettingMeta(
        "EOU 亚阈系数", "判「未说完」后降低让位门槛的系数(有绝对下限防噪声冤杀)。", "倍", "EOU 纠偏"),
    ("media", "AIM_EOU_VERDICT_TIMEOUT_MS"): SettingMeta(
        "EOU 判定超时", "旁路判定 LLM 超时,夹在 [500, 8000]。**默认 6000**(design contract:跨境标定值已回落为"
        "代码默认值)—— 原默认 2000 在跨境(北京→美东 TTFT 抖动 1.2~9.3s)几乎必超时,致纠偏静默失效。"
        "⚠ 调它须同步调大关联窗(有 fail-fast 守门)。", "ms", "EOU 纠偏"),
    # ══ 媒体面:提示词注入开关 ══
    ("media", "AIM_CALM_TONE"): SettingMeta(
        "语气克制注入", "注入「平稳克制、不夸张」的语气硬约束。默认开。", "", "提示词"),
    ("media", "AIM_INTERACTION_STYLE"): SettingMeta(
        "应答方式注入", "**仅有题时**注入「像专业中立考官那样应答」。默认开。", "", "提示词"),
    ("media", "AIM_OPEN_CHAT_DIRECTIVE"): SettingMeta(
        "自由交流注入", "**仅无题时**注入「持续聊下去、不主动结束」。默认开。", "", "提示词"),
    # ══ 媒体面:TTS 抗混叠(design contract)══
    ("media", "AIM_TTS_ANTIALIAS"): SettingMeta(
        "TTS 抗混叠低通", "24k→16k 降采样前的抗混叠滤波(关闭会让 >8kHz 混叠折回带内成杂音)。默认开。",
        "", "音频处理"),
    ("media", "AIM_TTS_ANTIALIAS_FC_HZ"): SettingMeta(
        "抗混叠截止频率", "低通截止频率。真机标定值(7200 兼顾齿音保留与折叠抑制)。", "Hz", "音频处理"),
    ("media", "AIM_TTS_ANTIALIAS_TAPS"): SettingMeta(
        "抗混叠阶数", "FIR 阶数(自动奇数化)。越大过渡带越窄、群延迟越长。", "阶", "音频处理"),
    # ══ 媒体面:声纹锁定(design contract)══
    ("media", "AIM_SPEAKER_LOCK_ENABLED"): SettingMeta(
        "声纹锁定全局开关", "一键回滚开关(盖过 Agent 配置)。治「旁边有人说话 AI 被误打断」。默认开。",
        "", "声纹锁定"),
    ("media", "AIM_SPEAKER_LOCK_THRESHOLD_HIGH"): SettingMeta(
        "声纹高置信阈值", "余弦相似度 ≥ 此值判定为目标考生。须满足 -1 ≤ low < high ≤ 1,否则声纹门禁用。",
        "", "声纹锁定"),
    ("media", "AIM_SPEAKER_LOCK_THRESHOLD_LOW"): SettingMeta(
        "声纹低置信阈值", "余弦相似度 ≤ 此值判定为旁人(才抑制打断);两阈之间为不确定 → 放行。",
        "", "声纹锁定"),
    ("media", "AIM_SPEAKER_LOCK_ENROLL_MS"): SettingMeta(
        "声纹注册时长", "开场累计多少有效语音后注册参考声纹。", "ms", "声纹锁定"),
    ("media", "AIM_SPEAKER_LOCK_ENROLL_GAP_MS"): SettingMeta(
        "注册段静音容忍", "超过此静音判为段结束(防跨长静音拼出假连续段)。", "ms", "声纹锁定"),
    ("media", "AIM_SPEAKER_LOCK_ENROLL_CONSISTENCY"): SettingMeta(
        "注册一致性阈值", "多段声纹相似度需 ≥ 此值才认同一人(防旁人污染注册)。", "", "声纹锁定"),
    ("media", "AIM_SPEAKER_LOCK_TIMEOUT_MS"): SettingMeta(
        "声纹验证超时", "GPU 声纹比对超时;超时按「不确定」放行(宁漏判旁人不误判考生)。", "ms", "声纹锁定"),
    ("media", "AIM_SPEAKER_LOCK_EMA"): SettingMeta(
        "声纹滑动更新系数", "对高置信目标帧更新参考声纹的系数(0=不更新)。", "", "声纹锁定"),
    ("media", "AIM_SPEAKER_LOCK_MIN_VERIFY_MS"): SettingMeta(
        "声纹最短验证窗", "短于此时长的候选窗强制判「不确定」(短音频比对不可靠)。", "ms", "声纹锁定"),
    ("media", "AIM_SPEAKER_LOCK_VERIFY_WINDOW_MS"): SettingMeta(
        "声纹验证窗上限", "送去比对的最近音频窗长度上限。", "ms", "声纹锁定"),
    # ══ 媒体面:LLM 通路 / 诊断 ══
    ("media", "AIM_TTS_TIMEOUT_MS"): SettingMeta(
        "TTS 看门狗", "GPU 既无音频也无完成信号时,引擎自行终结本轮的超时。"
        "⚠ **设为 0 会禁用该看门狗**(GPU 一帧不回时本轮永久哑)。", "ms", "LLM 与超时"),
    ("media", "AIM_LLM_TTFT_TIMEOUT_MS"): SettingMeta(
        "LLM 首字节超时", "超过此时长无首 token 判本轮 LLM 失败。"
        "⚠ 跨境 TTFT 实测抖动 1.2~9.3s,调小会把正常轮误判致 AI 频繁哑。0=禁用。", "ms", "LLM 与超时"),
    ("media", "AIM_LLM_FALLBACK_ATTEMPT_MS"): SettingMeta(
        "LLM 备用尝试超时", "主备切换时单次尝试的首 token 超时。", "ms", "LLM 与超时"),
    ("media", "AIM_MANTLE_KEEPALIVE_MS"): SettingMeta(
        "跨境连接保活", "mantle 连接的 TCP keepalive 间隔(连接复用降 TTFT)。", "ms", "LLM 与超时"),
    ("media", "AIM_CONVERSE_KEEPALIVE_MS"): SettingMeta(
        "Converse 连接保活", "Bedrock Converse 通路的 keepalive 间隔。", "ms", "LLM 与超时"),
    ("media", "AIM_TRANSCRIPT_FIXER_TIMEOUT_MS"): SettingMeta(
        "字幕修正超时", "旁路修正错字的 LLM 超时,夹在 [1000, 15000]。旁路慢不拖垮体感。",
        "ms", "LLM 与超时"),
    ("media", "AIM_CANCEL_ACK_TIMEOUT_MS"): SettingMeta(
        "取消回执超时", "打断后未在此窗内收到 GPU 取消回执则记指标(仅计量,不阻塞新轮)。",
        "ms", "LLM 与超时"),
    ("media", "AIM_AI_SPEAKING_MAX_IDLE_MS"): SettingMeta(
        "AI 说话空闲看门狗", "AI 说话态下无音频推进超过此时长即兜底终结本轮。", "ms", "LLM 与超时"),
    ("media", "AIM_RMS_DIAG"): SettingMeta(
        "RMS 诊断日志", "开启后周期打印入向能量分布(标定阈值用)。生产默认关,防日志爆量。",
        "", "诊断"),
    ("media", "AIM_RMS_DIAG_EVERY"): SettingMeta(
        "RMS 打印周期", "每 N 帧打印一次(1 帧 ≈ 20ms)。", "帧", "诊断"),
    # ══ 控制面(source=control):本进程直读的生效值 + 各 Secret 配置状态 ══
    #   ⚠ 凭据类一律 display_policy="configured_only"(只回「已配置/未配置」布尔);
    #     名称 denylist 亦会兜底,双保险。
    ("control", "MAX_CONCURRENCY"): SettingMeta(
        "全局会话闸门(硬顶)", "⚠ env 真名 **`MAX_CONCURRENCY`**(无 AIM_ 前缀)。同时进行的会话数上限硬顶,由 CDK 按 GPU_HARD_MAX×每实例注入;"
        "admin 可经 GPU 容量页调整,此处显示进程当前生效值。", "路", "控制面 · 容量",
        # design contract D 类:**CDK 派生值**(GPU_HARD_MAX × 每实例),不是「默认 vs 覆盖」语义。
        default_comparable=False, calibration_status="n/a"),
    ("control", "AIM_SESSION_JOIN_EXPIRE_MIN"): SettingMeta(
        "会话连入过期", "创建会话后多久未连入即判 no_show。", "分钟", "控制面 · 会话"),
    ("control", "AIM_ROLE_CLAIM"): SettingMeta(
        "角色来源 claim", "从 OIDC token 的哪个 claim 取角色(design contract 认证外置)。"
        "默认 `cognito:groups`;换 IdP 时改此项而非改代码。", "", "控制面 · 认证"),
    ("control", "AIM_AUTH_REGION"): SettingMeta(
        "认证池 region", "Cognito user pool 所在 region。中国区跨境复用美东池(VISION §2)。",
        "", "控制面 · 认证"),
    # design contract D 类:**拓扑地址** —— 只有「配了/没配」,无「默认值」概念。
    ("control", "AIM_BRIDGE_DIAL_URL"): SettingMeta(
        "媒体面内网通路", "是否已配置到实时会话服务的内网地址(Cloud Map)。"
        "未配则诊断页的媒体面段不可用,且会话预创建会退回本地 dispatcher。", "", "控制面 · 通路",
        default_comparable=False, calibration_status="n/a"),
    ("control", "AIM_GPU_CONTROL_URL"): SettingMeta(
        "GPU 内网通路", "是否已配置到 GPU 服务的内网控制地址(drain / 热加载 / 诊断)。",
        "", "控制面 · 通路", default_comparable=False, calibration_status="n/a"),
    ("control", "AIM_BRIDGE_CALLBACK_SECRET"): SettingMeta(
        "媒体面共享密钥", "X-Bridge-Secret:控制面↔实时会话服务双向鉴权 + join token HMAC 签发。"
        "**仅显示是否已配置**,绝不回明文。", "", "控制面 · 凭据",
        display_policy="configured_only"),
    ("control", "AIM_REALTIME_CLIENT_SECRET"): SettingMeta(
        "Realtime 客户端密钥", "OpenAI Realtime SDK-compatible WebSocket client secret 的独立 HMAC key。"
        "**仅显示是否已配置**,绝不回明文。", "", "控制面 · 凭据",
        display_policy="configured_only"),
    ("control", "AIM_DRAIN_SECRET"): SettingMeta(
        "GPU 共享密钥", "X-Drain-Secret:GPU 的 /drain·/reload-tts-config·/config 三处共用。"
        "**仅显示是否已配置**,绝不回明文。", "", "控制面 · 凭据",
        display_policy="configured_only"),

    # ══ GPU:VAD ══
    ("gpu", "AIM_VAD_ENERGY_THRESHOLD"): SettingMeta(
        "VAD 能量阈值(GPU 真驱动)",
        "**真正驱动 VAD** 的阈值:低于此值视为静音。底噪顶住阈值会导致永不出结轮信号→AI 不回话。"
        "媒体面同名开关仅作跨面校验,两值不同即为部署漂移。", "RMS", "GPU · VAD"),
    ("gpu", "AIM_VAD_HANGOVER_MS"): SettingMeta(
        "VAD 尾静音", "语音结束后需静音此时长才判定一轮结束。", "ms", "GPU · VAD"),
    ("gpu", "AIM_VAD_MIN_SPEECH_MS"): SettingMeta(
        "VAD 最短语音", "短于此时长的声音不算一轮语音(防噪声脉冲)。", "ms", "GPU · VAD"),
    ("gpu", "AIM_VAD_DEBUG"): SettingMeta(
        "VAD 调试日志", "开启后打印 VAD 判定细节。仅 ``1`` 生效。", "", "GPU · 诊断"),
    # ══ GPU:ASR ══
    ("gpu", "AIM_ASR_FINAL_LANGUAGE"): SettingMeta(
        "ASR 识别语言", "``auto`` 自动检测;也可锁定具体语言提升准确率。", "", "GPU · ASR"),
    ("gpu", "AIM_ASR_MIN_FINAL_CHARS"): SettingMeta(
        "ASR 最少成句字数", "少于此字数的识别结果不作为最终文本(挡单字残识)。", "字", "GPU · ASR"),
    ("gpu", "AIM_ASR_SHORT_ALLOWLIST"): SettingMeta(
        "短词白名单(中文)", "逗号分隔;这些短词即便低于最少字数也放行(如「对」「嗯」)。"
        "**是追加项**,与内建集合并而非替换。", "", "GPU · ASR"),
    ("gpu", "AIM_ASR_SHORT_ALLOWLIST_EN"): SettingMeta(
        "短词白名单(英文)", "同上,英文侧(大小写不敏感)。", "", "GPU · ASR"),
    # ══ GPU:TTS ══
    ("gpu", "AIM_TTS_VOICE"): SettingMeta(
        "默认音色", "未指定时使用的音色 key(Agent 配置会覆盖)。", "", "GPU · TTS"),
    ("gpu", "AIM_TTS_POSITION_TEMPERATURE"): SettingMeta(
        "TTS 位置温度", "OmniVoice 韵律采样温度。改动影响听感,勿随意调。", "", "GPU · TTS"),
    ("gpu", "AIM_TTS_GUIDANCE_SCALE"): SettingMeta(
        "TTS 引导强度", "越大越贴合参考音、越小越自由。真机标定值。", "", "GPU · TTS"),
    ("gpu", "AIM_MINIMAX_FALLBACK_COOLDOWN_S"): SettingMeta(
        "MiniMax 回退冷却", "MiniMax 失败后暂停使用它的冷却时长(期间直接用本地 OmniVoice)。",
        "秒", "GPU · TTS"),
    ("gpu", "AIM_MINIMAX_STARTUP_PROBE"): SettingMeta(
        "MiniMax 启动探测", "启动时试合成校验 MiniMax 凭据(不影响整体就绪判定)。", "", "GPU · TTS"),
    # ══ GPU:后端 / 容量 / 声纹 ══
    # design contract D 类:**部署形态**(有无 GPU 的部署事实),不是调优参数。
    ("gpu", "AIM_GPU_BACKEND"): SettingMeta(
        "GPU 后端", "``funasr`` 真实语音模型 / ``stub`` 占位(无 GPU 环境用)。", "", "GPU · 运行",
        default_comparable=False, calibration_status="n/a"),
    ("gpu", "AIM_MODEL_ROOT"): SettingMeta(
        "模型根目录", "镜像内模型权重路径(build 期烘入,运行时不触网)。", "", "GPU · 运行"),
    ("gpu", "AIM_FORCE_CPU"): SettingMeta(
        "强制 CPU", "⚠ **仅字面 ``1`` 生效**(``true`` 不生效)。设为 1 会让语音模型跑 CPU,极慢。",
        "", "GPU · 运行"),
    ("gpu", "AIM_GPU_LOG_LEVEL"): SettingMeta(
        "GPU 日志级别", "``DEBUG``/``INFO``/``WARNING``…", "", "GPU · 诊断"),
    ("gpu", "AIM_GPU_MAX_SESSIONS"): SettingMeta(
        "单实例最大会话", "本实例可同时服务的会话数上限(护栏)。集群期望实例数见 GPU 容量页。",
        "路", "GPU · 容量"),
    ("gpu", "AIM_GPU_MAX_DRAIN_MIN"): SettingMeta(
        "最长排空时长", "标记 drain 后等待在途会话结束的上限。", "分钟", "GPU · 容量"),
    ("gpu", "AIM_GPU_PROTECT_RENEW_MIN"): SettingMeta(
        "任务保护续期", "ECS task protection 的续期周期(防在途会话被缩容腰斩)。已钳制为至少 1。",
        "分钟", "GPU · 容量"),
    ("gpu", "AIM_PROTECT_FAIL_CLOSED"): SettingMeta(
        "保护失败即拒新", "task protection 调用失败时是否拒接新会话。接受 ``1``/``true``/``True``。",
        "", "GPU · 容量"),
    ("gpu", "AIM_EMBEDDING_MAX_INFLIGHT"): SettingMeta(
        "声纹并发上限", "同时处理的声纹比对请求数上限(防打爆 GPU)。", "个", "GPU · 声纹"),
    ("gpu", "AIM_EMBEDDING_MIN_MS"): SettingMeta(
        "声纹最短音频", "短于此时长的音频拒绝比对(结果不可靠)。", "ms", "GPU · 声纹"),
}


def get_meta(source: str, key: str) -> SettingMeta | None:
    """查 ``(source, key)`` 的元数据;未登记返回 ``None``。"""
    return SETTINGS_META.get((source, key))  # type: ignore[arg-type]


@dataclass(frozen=True)
class Redacted:
    """脱敏后的一条目值。"""

    #: 展示值:实际值 / 布尔「已配置」/ ``None``
    effective_value: Any
    #: 默认值(敏感或未登记时为 ``None``)
    default: Any
    #: 是否因未登记而隐藏(前端显示「未登记(值已隐藏)」)
    metadata_missing: bool
    #: 脱敏原因(``None`` = 未脱敏);供前端/排障说明为何看不到值
    redacted_reason: str | None
    #: **布尔值的语义**(显式给出,不让前端从 ``redacted_reason`` 反推):
    #:   ``switch`` = 真开关(渲染「开/关」);``configured`` = 脱敏后的「已配置/未配置」;
    #:   ``none`` = 非布尔值。
    #: 反推目前能 work,但属隐式耦合:一旦将来给正常项也填 reason(如「已钳制到上限」),
    #: 前端就会把真开关误渲染成「已配置」。故在契约里显式表达。
    value_semantics: Literal["switch", "configured", "none"] = "none"


def redact(source: str, key: str, value: Any, default: Any) -> Redacted:
    """按**固定优先级**产出可展示的值。

    顺序(勿重排,AIM 已实测固化):
      1. 名称 denylist / 已登记为 ``configured_only`` → 布尔「已配置/未配置」,``default`` 置 None
      2. 未登记(``SETTINGS_META`` 无此 ``(source,key)``) → 值与默认**双 None** + ``metadata_missing``
      3. 已登记为 ``hidden`` → 双 None
      4. 正常 → 原值;但仍过**值形状守门**(名称不敏感而值像凭据时也拦)
    """
    meta = get_meta(source, key)

    # 1. 敏感名 / 显式 configured_only → 只回布尔
    if is_sensitive_name(key) or (meta is not None and meta.display_policy == "configured_only"):
        configured = bool(value) if not isinstance(value, str) else value.strip() != ""
        return Redacted(configured, None, False, "名称命中敏感模式(仅显示是否已配置)",
                        value_semantics="configured")

    # 2. 未登记 → 双 None(不漏项,但不透值)
    if meta is None:
        return Redacted(None, None, True, "未在元数据字典登记(值已隐藏)")

    # 3. 显式隐藏
    if meta.display_policy == "hidden":
        return Redacted(None, None, False, "该项按策略不展示")

    # 4. 值形状守门(第二道轴)—— **value 与 default 都要过**(review)。
    #    只查 value 会漏:名称不敏感 + value 干净 + **default 是凭据形状**时,default 原样泄漏。
    #    实证:`redact('media','AIM_KICKOFF_WAKE_TEXT','(请开始)','sk-examplevalue…')`
    #    曾原样回出那个 `sk-` 默认值。
    if value_looks_sensitive(value):
        return Redacted(None, None, False, "值形状疑似凭据(已隐藏)")
    if value_looks_sensitive(default):
        # value 本身干净 → 仍可展示;只把可疑的 default 抹掉(不牵连生效值,便于运维照常排障)
        return Redacted(value, None, False, "默认值形状疑似凭据(默认值已隐藏)",
                        value_semantics="switch" if isinstance(value, bool) else "none")

    return Redacted(value, default, False, None,
                    value_semantics="switch" if isinstance(value, bool) else "none")
