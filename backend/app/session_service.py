"""会话编排服务(控制面)—— design contract 缩水版的业务逻辑落点。

控制面职责(VISION §1):写 Sessions → 向实时会话服务下发「会话就绪指令」(携带 session_id +
解析好的 prompt/questions/引擎参数),客户端凭 session_id 自行连入实时服务开始考试。
本服务把「就绪/挂断」编排成可单测的纯服务,下发经 Dispatcher 抽象注入 ——
本地/测试用 RecordingDispatcher 把指令落库(SessionEvents meta)。

状态推进:预创建成功**不改状态**(留 scheduled);客户端连入后实时服务回报 connected 事件
→ in_progress(见 routers/sessions.py media_event)。

时间策略全部委托 state_machine(design contract 缩水版权威实现)。
"""
from __future__ import annotations

import logging
import random
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Protocol

from . import state_machine as sm
from .db import Db

logger = logging.getLogger(__name__)

# 难度档归一边界(design contract):difficulty 域 [1,5],越界归一、非整数兜底中等 3。
_DIFFICULTY_MIN = 1
_DIFFICULTY_MAX = 5
_DIFFICULTY_DEFAULT = 3


class LaunchError(ValueError):
    """发起会话前的 fail-fast 拒绝(design contract:LLM 凭据未配置 / 模型不在清单)。

    ValueError 子类 → 路由层与既有校验一样映射 4xx(明确错误,不产生静默呼叫)。
    """


def _redact_command(command: dict) -> dict:
    """落 DDB / 日志前脱敏逐通注入的 LLM 凭据。"""
    secret_fields = ("llm_bearer_token", "llm_bedrock_api_key")
    if not any(field in command for field in secret_fields):
        return command
    red = dict(command)
    for field in secret_fields:
        if field in red:
            red[field] = "***redacted***"
    return red


def _redact_token(text: str) -> str:
    """兜底:异常/回执文本里若混入 mantle token 形态串,脱敏(防第三方库异常带上 body)。"""
    import re  # noqa: PLC0415

    return re.sub(r"(ABSK|sk-)[A-Za-z0-9_\-\.=/+]{8,}", "***redacted***", text or "")


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def connect_deadline_for_session(session: dict, session_join_expire_min: int) -> str | None:
    if session.get("status") == sm.IN_PROGRESS:
        started_at = session.get("started_at")
        if not started_at:
            logger.error("in_progress 会话缺 started_at,拒绝生成 connect_deadline session=%s",
                         session.get("session_id"))
            raise LaunchError("in_progress 会话缺 started_at")
        snapshot = session.get("agent_snapshot") or {}
        engine = snapshot.get("engine") or {}
        max_duration_s = int(engine.get("max_duration_s", 1800))
        return (sm.parse_iso(started_at) + timedelta(seconds=max_duration_s)).isoformat()
    meeting_end = session.get("meeting_end")
    if meeting_end:
        return meeting_end
    created_at = session.get("created_at")
    if not created_at:
        return None
    return (sm.parse_iso(created_at) + timedelta(minutes=session_join_expire_min)).isoformat()


def _difficulty_key(q: dict) -> int:
    """easy_to_hard 排序键:把 difficulty fail-safe 归一到 [1,5](design contract)。

    design contract 字面契约:**只接受真整数语义**。缺失 / null / 字符串(含 "4")/ 小数(含 4.0 来自 DDB
    Decimal('4.0')、4.5)→ 中等 3;越界整数 → 钳到 [1,5]。排序提示而非计分依据,绝不抛。

    Decimal 来自 DDB 读路径:Decimal('3') 是整数语义(to_integral_value() == self)→ 转 int;
    Decimal('3.5') 或 float 4.5 是小数 → 3。bool 是 int 子类,显式排除。
    """
    raw = q.get("difficulty", _DIFFICULTY_DEFAULT)
    if isinstance(raw, bool):
        return _DIFFICULTY_DEFAULT
    if isinstance(raw, int):
        d = raw
    elif isinstance(raw, Decimal):
        # DDB 读出整数语义的 Decimal(如 Decimal('3'))视作真整数;非整数小数 → 3
        if raw == raw.to_integral_value():
            d = int(raw)
        else:
            return _DIFFICULTY_DEFAULT
    else:
        # float / str / None / 其它 → 一律视作非整数语义
        return _DIFFICULTY_DEFAULT
    return max(_DIFFICULTY_MIN, min(_DIFFICULTY_MAX, d))


def resolve_questions(agent: dict, bank: dict | None, *, seed: str) -> list[dict]:
    """把 Agent.question_strategy 应用到题库题目,产出这场最终的题目列表(design contract 控制面合成)。

    - 空/无题库 → [](纯人设对话;media/evaluator 据空 questions 走无题路径)。
    - random_n / random_n_easy_to_hard:以 seed(= session_id)为种子 deterministic 抽样 ——
      同一会话多次解析得同一批题(重拨稳定);N≥题数时取全部仍打乱。
    - easy_to_hard / random_n_easy_to_hard:按 difficulty 升序(稳定排序,等难度保持原序)。
    seed 固定 → 输出固定,故只需在创建会话时解析一次、固化进 session,重拨/重约复用即可。
    """
    questions = list((bank or {}).get("questions", []) or [])
    if not questions:
        return []
    strategy = agent.get("question_strategy", "sequential")
    n = agent.get("strategy_n")
    try:
        n = int(n) if n is not None else 0
    except (TypeError, ValueError):
        n = 0

    if strategy in ("random_n", "random_n_easy_to_hard"):
        rng = random.Random(seed)  # noqa: S311 — 非加密用途,要的是可复现(seed=session_id)
        k = min(n, len(questions)) if n > 0 else len(questions)
        questions = rng.sample(questions, k)  # N≥题数 → k=全部,仍是打乱序
    if strategy in ("easy_to_hard", "random_n_easy_to_hard"):
        questions = sorted(questions, key=_difficulty_key)  # 稳定升序
    return questions


def _within_minutes(earlier_iso: str, now_iso: str, minutes: int) -> bool:
    """earlier_iso 是否在 now 的 minutes 分钟内(新鲜度判定,design contract)。

    空/解析失败视作不新鲜(过期),保守走 fail-safe;但**记 WARNING 留痕**——避免坏时戳静默
    把健康 reconciler 的实况误判过期(review)。
    """
    if not earlier_iso or not now_iso:
        return False
    try:
        earlier = sm.parse_iso(earlier_iso)
        now = sm.parse_iso(now_iso)
    except Exception as exc:  # noqa: BLE001
        logger.warning("容量实况新鲜度时戳解析失败(observed_at=%r now=%r): %s —— 保守按过期处理",
                       earlier_iso, now_iso, exc)
        return False
    return (now - earlier) <= timedelta(minutes=minutes)


def resolve_launch_command(session: dict, agent: dict, llm_config: dict | None = None,
                           connect_deadline: str | None = None) -> dict:
    """把 Session + Agent 解析成实时会话服务可直接执行的「会话就绪指令」(控制面下发内容)。

    join key = session_id 贯穿全链路(预创建即注入,客户端凭它连入,无反查)。

    题目来自 **session 已固化的 resolved_questions**(design contract:创建会话时按 Agent 策略 + 绑定题库
    解析一次并固化,重约复用同一批题,不重新随机)。实时服务/evaluator 对题库与策略零感知。

    design contract:`llm_config`(控制面读 `LlmConfigSecret` 得到的原始 dict,含 host + 明文 token)非空且
    engine_type==three_stage 时,**逐通注入** `llm_bearer_token` + `llm_mantle_host`(实时服务不持系统级
    token)。校验(模型 ∈ 清单、token 存在)由调用方 SessionService 在读 Secret 后做(见 _resolve_llm_config)。
    ⚠ 返回 dict 含明文 token,调用方(dispatcher /sessions/{id}/ready body)MUST NOT 打印整体 command/body
    (见 HttpDispatcher)。
    """
    engine = dict(agent.get("engine", {}))
    # 顶层 + 嵌套都给:实时服务读顶层 engine_type/llm_model_id/language/voice(契约对齐,review);
    # engine 嵌套保留供观测/未来扩展。
    command = {
        "session_id": session["session_id"],
        "system_prompt": agent.get("system_prompt", ""),
        "questions": session.get("resolved_questions", []),
        "engine": engine,
        "engine_type": engine.get("engine_type", "three_stage"),
        "language": engine.get("language", "zh-CN"),
        "llm_model_id": engine.get("llm_model_id"),
        # 语义音色 key(male_std/female_std…);实时会话服务据此 → GPU voice clone。
        # Agent 未配 voice(旧数据/API 建的存 null)→ 兜底 male_std,与前端下拉框默认一致
        # (所见即所播)。不兜底会一路透传 null,GPU 终极 fallback 成 female_std(女声)→ 设男音却出女音。
        "voice": engine.get("voice") or "male_std",
        # TTS provider 段级维度(design contract):three_stage 的 TTS 由哪家合成(gpu_omnivoice|minimax)。
        # 实时服务仅透传 → GPU start 帧;凭据/voice_id 映射由 GPU 直读 Secret,不经此下发。None=GPU 回退默认。
        "tts_provider": engine.get("tts_provider"),
        # 实时字幕显示开关(design contract):Agent **顶层**字段(非 engine 嵌套——纯呈现语义,不流向引擎/GPU)。
        # None/缺省 → True(默认开,向后兼容);只有显式 False 才关。实时服务经 ready 帧回显给前端,自身不据此改行为。
        "show_subtitles": agent.get("show_subtitles") is not False,
        # 头像风格(design contract):Agent 顶层字段(纯呈现,不流向引擎/GPU)。**字符串枚举需 fail-safe**(不同 bool 的
        # show_subtitles):非四合法枚举(None / 旧数据 / 脏值)→ 传 None,前端兜底 minimal,不透传脏值污染 ready 帧。
        "avatar_style": (
            agent.get("avatar_style")
            if agent.get("avatar_style") in ("minimal", "round", "tech", "waveform")
            else None
        ),
        # 声纹锁定说话人(design contract):Agent **顶层**字段(会话行为语义,非 engine 嵌套)。**默认开**——
        # None/缺省/老数据 → True(设计决策默认锁定、上线即生效);只有显式 False 才关。bridge 收到后再与
        # recovery/kill-switch 求 effective_speaker_lock 裁定是否真启用(见 design contract D7)。
        "speaker_lock": agent.get("speaker_lock") is not False,
        # 即时开始:下发会话最大时长上限(秒),实时服务可据此 arm timer 自收尾;控制面调度器仍作 backstop。
        "max_duration_s": engine.get("max_duration_s", 1800),
        # 硬连接截止(review):实时服务 MUST 拒绝晚于此刻的 WS 连入,即便 join token(4h TTL)仍有效——
        # 否则「T+29min 取 token → 调度器 T+30min 判 failed → T+31min 连入」会让已判死的会话照常对话。
        # 即时会话 = created_at + join_expire_min;候选人 slot = meeting_end。None = 不设(实时服务不拦,兜底靠 backstop)。
        "connect_deadline": connect_deadline,
    }
    # design contract:三段式 LLM 凭据逐通注入(仅 three_stage;历史脏数据带其它 engine_type 不注入,服务侧 fail-fast)。
    # token/host 不进 Agent 记录、不落 DDB Sessions —— 仅在此发起指令瞬时携带。
    if llm_config and cmd_engine_type(engine) == "three_stage":
        # design contract:调用方式(全局单选)逐通下发。mantle(现状)/ bedrock_converse(传统 Bedrock Converse)。
        from .llm_config_service import call_method as _call_method  # noqa: PLC0415
        method = _call_method(llm_config)
        command["llm_call_method"] = method
        host = (llm_config.get("host") or "").strip()
        if host:
            command["llm_mantle_host"] = host  # 两方式共用 host 字段(mantle host 或 converse 代理域名)
        if method == "bedrock_converse":
            # converse:下发 Bedrock API Key(逐通,不落 DDB/日志)+ 上游 region(?region=)。
            bkey = (llm_config.get("bedrock_api_key") or "").strip()
            if bkey:
                command["llm_bedrock_api_key"] = bkey
            command["llm_bedrock_region"] = (llm_config.get("bedrock_region") or "us-east-1").strip()
        else:
            # mantle(现状 design contract):下发 mantle Bearer token。
            token = (llm_config.get("api_key") or "").strip()
            if token:
                command["llm_bearer_token"] = token
        # ★ Agent 未指定 llm_model_id 时,下发 LlmConfig 的 default_model(design contract:default_model =
        #   "Agent 未指定时的兜底")。否则 llm_model_id=None → 实时服务用自己的 IAM env 默认
        #   (us.anthropic.claude-*),在中国区无 IAM Bedrock + Claude 地域封锁 → 死路(浏览器 e2e 实测暴露)。
        if not command.get("llm_model_id"):
            default_model = (llm_config.get("default_model") or "").strip()
            if default_model:
                command["llm_model_id"] = default_model
        # design contract:主备 fallback 备用模型序逐通下发(已由 _resolve_llm_config 校验 ∈ 清单 + 中国区非 anthropic)。
        # 剔除与主模型同名的(避免自我重试)。空则不下发(单模型,行为回退 design contract)。
        primary = (command.get("llm_model_id") or "").strip()
        fbs = [m for m in (llm_config.get("fallback_models") or []) if isinstance(m, str) and m.strip() and m != primary]
        if fbs:
            command["llm_fallback_model_ids"] = fbs
        # design contract:ASR 字幕修正模型逐通下发(仅非空)。**旁路增强**——不在清单/中国区直连不可达时,
        # _resolve_llm_config 已把它从 config 里剔除(降级不修,非 fail-fast),故此处若还在即为已校验合法。
        # 复用同通注入的 llm_bearer_token/llm_mantle_host(不额外下发凭据)。空 = 不修(不下发字段)。
        fixer = (llm_config.get("transcript_fixer_model") or "").strip()
        if fixer:
            command["llm_transcript_fixer_model_id"] = fixer
        # design contract:旁路违规裁判模型逐通下发 = evaluator_model 的 effective 求值(不新增 admin 配置,复用打分模型)。
        #   用 effective_evaluator_model(raw)(evaluator_model||default_model||DEFAULT)——不直读 raw 键(可能 None,review)。
        #   复用同通注入的 token/host/凭据(随 call_method);裁判默认 shadow(仅 log),不产生用户可感知动作直到 flag 开。
        from .llm_config_service import effective_evaluator_model as _eff_eval  # noqa: PLC0415
        moderation_model = _eff_eval(llm_config)
        if moderation_model:
            command["llm_moderation_model_id"] = moderation_model
    return command


def cmd_engine_type(engine: dict) -> str:
    return engine.get("engine_type", "three_stage")


class Dispatcher(Protocol):
    """向实时会话服务下发指令的抽象。生产 = HTTP 预创建(ready)/挂断;测试/本地 = 落库记录。

    hangup 返回 bool:实时服务是否确认收到挂断(HttpDispatcher 据 HTTP 2xx;RecordingDispatcher 落库即视为 OK)。
    供 SessionService.hangup 据此决定是否如实报错(review:失败不静默标 completed)。
    """

    def dispatch(self, command: dict) -> None: ...

    def hangup(self, session_id: str) -> bool: ...


class RecordingDispatcher:
    """本地/测试默认 Dispatcher:把指令落到 SessionEvents(meta.last_dispatch / last_hangup)。

    真预创建/挂断由实时会话服务实现;控制面到此已完整产出「会话就绪指令」。
    **不改 meta.status**(预创建不推进状态,状态由客户端连入的 connected 事件驱动)。
    """

    def __init__(self, db: Db):
        self.db = db

    def dispatch(self, command: dict) -> None:
        # 只合并留痕字段,不读改写 status(与 HttpDispatcher 同口径,review)。
        # ★ command 含明文 llm_bearer_token(design contract 逐通注入)——落 DDB meta 前 MUST 脱敏
        #   (与 HttpDispatcher 同口径;review:此前 RecordingDispatcher 漏脱敏 → 配了 LLM 但缺
        #   AIM_BRIDGE_DIAL_URL 退回本 dispatcher 时,token 明文入库)。
        self.db.merge_session_meta(
            command["session_id"],
            {"last_dispatch": _redact_command(command), "dispatched_at": _now_iso()},
        )

    def hangup(self, session_id: str) -> bool:
        """下发实时服务挂断(生产 = POST /sessions/{id}/hangup)。落库记录指令已发出,视为 OK。"""
        self.db.merge_session_meta(
            session_id,
            {"last_hangup": {"session_id": session_id, "op": "hangup"},
             "hangup_dispatched_at": _now_iso()},
        )
        return True


class HttpDispatcher:
    """生产 Dispatcher:既落库(同 RecordingDispatcher)**又真 HTTP POST 到实时会话服务**。

    - dispatch → POST {rt}/sessions/{id}/ready(携带 resolve_launch_command 的完整就绪指令,
      带 X-Bridge-Secret 头,实时服务侧 fail-closed 拒无密钥请求)。
    - hangup   → POST {rt}/sessions/{id}/hangup。
    实时服务地址经 settings.bridge_dial_url(env AIM_BRIDGE_DIAL_URL,如 http://<实时服务>:3001);
    共享密钥复用 bridge callback secret(env AIM_BRIDGE_CALLBACK_SECRET)。
    best-effort + 超时:实时服务不可达只告警 + 落库留痕,不抛(客户端连入时实时服务可再回源取上下文)。
    """

    def __init__(self, db: Db, base_url: str, timeout_s: float = 5.0, secret: str | None = None):
        self.db = db
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.secret = secret

    def _post(self, path: str, body: dict) -> tuple[bool, str]:
        import json
        from decimal import Decimal

        import httpx

        # ★ 命令字段多来自 DynamoDB(Agent.engine / questions.weight / hangup_reminder_min 等),含 Decimal。
        #   httpx 的 json= 用标准 json.dumps,Decimal 不可序列化 → 报「Object of type Decimal is not JSON
        #   serializable」,指令根本发不出去(真机实测根因)。这里用 Decimal-aware 编码器
        #   手动序列化成 content,Decimal→int(整除)/float。
        def _enc(o):
            if isinstance(o, Decimal):
                return int(o) if o == o.to_integral_value() else float(o)
            raise TypeError(f"not serializable: {type(o)}")

        try:
            payload = json.dumps(body, default=_enc, ensure_ascii=False).encode("utf-8")
            headers = {"Content-Type": "application/json"}
            if self.secret:
                headers["X-Bridge-Secret"] = self.secret
            resp = httpx.post(
                f"{self.base_url}{path}", content=payload,
                headers=headers, timeout=self.timeout_s,
            )
            ok = resp.status_code in (200, 202)
            return ok, f"{resp.status_code}"
        except Exception as exc:  # noqa: BLE001 — 脱敏异常文本(防第三方库带 body 里的 token,review)
            return False, _redact_token(str(exc))

    def dispatch(self, command: dict) -> None:
        sid = command["session_id"]
        ok, detail = self._post(f"/sessions/{sid}/ready", command)
        # ★ design contract:command 含明文 llm_bearer_token(逐通注入 ready body)——落 DDB meta 前 MUST 脱敏,
        #   绝不把系统级 token 写进 Sessions 表(review 只在 POST body 瞬时携带)。
        # 预创建不推进状态(状态留 scheduled,等 connected 事件)。用 merge_session_meta 原子合并留痕字段,
        # **不读改写 status**(review:读改写与 connected 事件并发会把 in_progress 回写成陈旧 scheduled)。
        self.db.merge_session_meta(
            sid,
            {
                "last_dispatch": _redact_command(command),
                "dispatched_at": _now_iso(),
                "dispatch_http_ok": ok,
                "dispatch_http_detail": _redact_token(detail),
            },
        )

    def hangup(self, session_id: str) -> bool:
        ok, detail = self._post(f"/sessions/{session_id}/hangup", {})
        # 同 dispatch:只合并留痕,不读改写 status(挂断后的 completed 推进由调用方/事件回调负责)。
        self.db.merge_session_meta(
            session_id,
            {"last_hangup": {"session_id": session_id, "op": "hangup", "http_ok": ok,
                             "http_detail": detail},
             "hangup_dispatched_at": _now_iso()},
        )
        return ok


def make_dispatcher(db: Db, bridge_dial_url: str | None, secret: str | None = None) -> Dispatcher:
    """据配置选 Dispatcher:配了实时服务地址用 HttpDispatcher(真 POST 预创建);否则 RecordingDispatcher
    (本地/未接实时服务:只落库)。secret = X-Bridge-Secret 共享密钥(复用 bridge callback secret)。"""
    if bridge_dial_url:
        return HttpDispatcher(db, bridge_dial_url, secret=secret)
    return RecordingDispatcher(db)


def make_llm_config_store(settings):
    """design contract:据 settings 造 LlmConfigStore(供 SessionService 发起时读 mantle 凭据 + 权威校验)。

    未配 AIM_LLM_CONFIG_SECRET_ID(本地/测试/未部署 025)→ 返 None(SessionService 按未接线处理:
    媒体面 fail-fast)。生产由 CDK 注入 secret arn。
    """
    if not getattr(settings, "llm_secret_arn", None):
        return None
    from .llm_config_service import LlmConfigStore  # noqa: PLC0415

    return LlmConfigStore(settings)


class SessionService:
    def __init__(self, db: Db, dispatcher: Dispatcher | None = None, *, max_concurrency: int = 8,
                 webhook_emitter=None, capacity_freshness_min: int = 5, llm_config_store=None,
                 session_join_expire_min: int = 30):
        self.db = db
        self.dispatcher = dispatcher or RecordingDispatcher(db)
        self.max_concurrency = max_concurrency
        # design contract:动态容量实况新鲜窗(分钟);超此 reconciler 未更新视作过期(走 fail-safe 决策树)。
        self.capacity_freshness_min = capacity_freshness_min
        # design contract:会话终态时发 webhook 事件(best-effort,注入;None=不发)。
        self.webhook_emitter = webhook_emitter
        # design contract:三段式 LLM 配置读取器(LlmConfigStore;None=未接线,发起时按「未配置」fail-fast/放行本地)。
        self.llm_config_store = llm_config_store
        # 即时开始:未连入过期分钟数(算下发给实时服务的硬连接截止 connect_deadline,防旧 token 在会话已判死后连入)。
        self.session_join_expire_min = session_join_expire_min

    def _effective_max_concurrency(self, now_iso: str) -> int:
        """有效闸门 = min(配置安全阀 max_concurrency 硬顶, 运行时实际可服务并发)(design contract)。

        max_concurrency 是**硬顶**(CDK 注入 GPU_HARD_MAX×每实例,给 autoscaling 留弹性,不再静态钳死);
        真实容量读 DDB gpu_capacity_live(强一致),按新鲜度走 fail-safe 决策树:缺失→**保守**静态兜底
        gpu_capacity_static_fallback(单实例并发,非硬顶,避免首启超派);新鲜→serviceable(含合法 0);
        过期→停机意图 0 / 最后已知>0 用之 / =0 置 0(详 capacity_service)。
        SystemConfig 表未配(本地/旧栈)或读失败 → 退回保守静态兜底(不因容量管理未部署而瘫痪、也不超派)。
        """
        from . import capacity_service as cap
        fallback = self.db.settings.gpu_capacity_static_fallback
        if not self.db.settings.system_config_table:
            return min(self.max_concurrency, fallback)
        try:
            live_item = self.db.get_gpu_capacity_live()
        except Exception:  # noqa: BLE001 — 实况读失败不应阻断发起,退回保守兜底
            logger.warning("读 gpu_capacity_live 失败,闸门退回保守兜底 %d", fallback)
            return min(self.max_concurrency, fallback)
        if live_item is None:
            return min(self.max_concurrency, fallback)  # 首次部署/未初始化:保守兜底
        observed_at = live_item.get("observed_at", "")
        fresh = _within_minutes(observed_at, now_iso, self.capacity_freshness_min)
        live = cap.LiveCapacity(
            serviceable_concurrency=int(live_item.get("serviceable_concurrency", 0)),
            intent_zero=bool(live_item.get("intent_zero", False)),
            fresh=fresh,
        )
        effective, label = cap.effective_capacity(live, static_fallback=fallback)
        if label in ("stale_use_last_known_alert", "stale_zero_alert"):
            logger.warning("GPU 容量实况过期(observed_at=%s),闸门用 %d(%s)—— reconciler 疑似失效,请检查",
                           observed_at, effective, label)
        return min(self.max_concurrency, effective)

    def _emit(self, event_type: str, session: dict) -> None:
        if self.webhook_emitter is None:
            return
        self.webhook_emitter(event_type, {
            "session_id": session["session_id"],
            "status": session.get("status"),
            "trigger": session.get("trigger"),
            "fail_reason": session.get("fail_reason"),
            "ended_at": session.get("ended_at"),
        })

    # ── 发起(预创建) ──
    def launch(self, session: dict, agent: dict, *, immediate: bool = True) -> dict:
        """落 Session + 写 SessionEvents meta(含 rubric + 固化题目快照供 Evaluator)+ 向实时服务预创建。

        新语义(VISION §1):没有拨号。预创建(ready)只是把会话内核(prompt/questions/engine)
        推给实时会话服务暂存;**状态留 scheduled**,等客户端连入的 connected 事件推 in_progress。
        immediate 参数保留调用面兼容(HR 即时/staff 预约都走同一路径:落库 + 预创建)。

        题目快照:session.resolved_questions 已在创建时(build_session_record 调用方)按 Agent 策略 +
        绑定题库固化(design contract)。这里把它连同 rubric 一起冗余进 meta,Evaluator 单表自包含打分
        (无跨表反查、不读 Agent/题库表)。
        """
        # SessionEvents meta:冗余 rubric + Agent 快照 + 固化题目,Evaluator 单表自包含打分(无跨表反查)。
        # rubric 取**创建时冻结的 agent_snapshot**(review:打分须按发起时的 rubric,而非可能已改的 live Agent)。
        snap = session.get("agent_snapshot") or agent
        self.db.put_session_meta(
            session["session_id"],
            {
                "status": session["status"],
                "agent_id": snap.get("agent_id", agent["agent_id"]),
                "agent_version": snap.get("version", agent.get("version", "v1")),
                "rubric": snap.get("rubric", {}),
                "questions": session.get("resolved_questions", []),
                "booked_by": session.get("booked_by"),
            },
        )
        return self.make_ready(session, agent)

    def make_ready(self, session: dict, agent: dict) -> dict:
        """向实时会话服务预创建(会话就绪指令)。不推进状态(留 scheduled)。

        用**创建时冻结的 agent_snapshot**(review:预创建须用发起时的 prompt/engine,
        而非 admin 事后改过的 live Agent);无快照(老数据)回退传入 agent。
        design contract:三段式预创建前解析 + 权威校验 LLM 配置(未配 token / 模型不在清单 → fail-fast)。
        """
        snap = session.get("agent_snapshot") or agent
        llm_config = self._resolve_llm_config(snap)
        self.dispatcher.dispatch(resolve_launch_command(session, snap, llm_config,
                                                        connect_deadline=self._connect_deadline(session)))
        return session

    def _connect_deadline(self, session: dict) -> str | None:
        """硬连接截止(review):实时服务据此拒绝会话已判死后的迟到连入。
        in_progress = started_at + max_duration_s;候选人 slot(有 meeting_end)= meeting_end;
        其它 scheduled 即时会话 = created_at + session_join_expire_min。
        与 scheduler 过期判定同口径(见 scheduler._judge_expired),两者锚点一致才不会「backend 判死但 bridge 放行」。"""
        return connect_deadline_for_session(session, self.session_join_expire_min)

    def _resolve_llm_config(self, agent: dict) -> dict | None:
        """design contract:发起三段式会话前读 `LlmConfigSecret`,决定 LLM 走 mantle 还是 IAM 回退。

        **优雅降级**(用户决策:没配 mantle token 就走旧的 IAM role + Haiku 路径,零配置开箱即用):
        - 非三段式(历史脏数据):返 None(不注入凭据;引擎层 fail-fast)。
        - store 未接线 / 未配 token:返 None —— **实时会话服务回退 IAM BedrockStreamer**(用 env AIM_LLM_MODEL_ID
          的 inference profile 默认 Haiku 4.5),不注入 token、不 fail-fast。这就是 design contract 前的原行为。
        - 已配 token:
          * Agent 指定了 llm_model_id 但不在当前清单 → 抛 LaunchError(TOCTOU 权威闸门:挡住 admin
            事后删清单 / Agent 编辑时清单已变的情形,避免拨一通注定 mantle 400 的静默呼叫);
          * 通过 → 返原始 config dict(含明文 token + host),供 resolve_launch_command 逐通注入 → mantle。
        """
        engine = dict(agent.get("engine", {}))
        if cmd_engine_type(engine) != "three_stage":
            return None

        # IAM 回退路径(未接线 / 未配 token)只服务 Bedrock inference profile(如 us.anthropic.claude-*)。
        # 若 Agent 却指定了 **mantle-only 前缀模型**(minimax./zai./xai./…),IAM BedrockStreamer 调不了 →
        # 会拨一通 AI 静默的呼叫。故回退前 MUST 挡:mantle 前缀模型 + 无 token → fail-fast(review)。
        def _needs_mantle(mid: str | None) -> bool:
            import re  # noqa: PLC0415
            return bool(mid and re.match(r"^(anthropic|xai|zai|minimax|openai)\.", mid))

        # ★ 中国区(aws-cn 分区)**禁止 IAM 回退**(设计决策):中国区无 Bedrock IAM(跨分区 IAM 不互认)+
        #   Claude 受 Anthropic 地域封锁 → IAM 回退的 us.anthropic.claude-* 必然失败(AI 静默)。故中国区
        #   MUST 走 mantle Bearer(API key),未配即 fail-fast 给明确指引,而非静默降级到注定失败的回退。
        #   Global(aws 分区)保留 IAM 回退(有 Bedrock,开箱即用)。db=None 单测场景视作非中国区(不误伤)。
        def _region() -> str:
            try:
                return (self.db.settings.region or "") if self.db is not None else ""
            except Exception:  # noqa: BLE001
                return ""

        cn_region = _region().startswith("cn-")

        def _no_iam_fallback_hint(raw: dict | None = None) -> str:
            # design contract:按 call_method 给对应指引(converse 缺 Bedrock API Key vs mantle 缺 token)。
            if raw is not None:
                from .llm_config_service import call_method as _cm  # noqa: PLC0415
                if _cm(raw) == "bedrock_converse":
                    return (
                        "中国区不支持 IAM 回退,Converse 方式(call_method=bedrock_converse)需要 Bedrock API Key。"
                        "请 admin 在「LLM 配置」页开启「启用自定义」并填 Bedrock API Key。"
                    )
            return (
                "中国区不支持 IAM 回退(无 Bedrock + Claude 地域封锁),LLM 必须走 mantle Bearer(API key)。"
                "请 admin 在「LLM 配置」页开启「启用自定义」并填 token。"
            )

        store = self.llm_config_store
        model_id = engine.get("llm_model_id")
        if store is None or not getattr(store, "secret_id", None):
            if _needs_mantle(model_id):
                raise LaunchError(
                    f"Agent 指定的 LLM 模型 {model_id!r} 需经 mantle 端点,但未启用自定义 LLM。"
                    "请 admin 在「LLM 配置」页开启「启用自定义」并填 token,或改用默认(留空 = IAM Haiku)。"
                )
            if cn_region:
                raise LaunchError(_no_iam_fallback_hint())  # 中国区禁 IAM 回退
            return None  # Global 未接线且非 mantle 模型:媒体面走 IAM 回退(BedrockStreamer)
        from .llm_config_service import catalog_ids, is_enabled  # noqa: PLC0415

        raw = store.read_raw()
        # 「启用自定义」开关(design contract):须 enabled=true 且已配 token 才走 mantle;否则一律 Haiku/IAM 回退。
        if not is_enabled(raw):
            if _needs_mantle(model_id):
                raise LaunchError(
                    f"Agent 指定的 LLM 模型 {model_id!r} 需经 mantle 端点,但自定义 LLM 未启用。"
                    "请 admin 在「LLM 配置」页开启「启用自定义」并填 token,或改用默认(留空 = IAM Haiku)。"
                )
            if cn_region:
                raise LaunchError(_no_iam_fallback_hint(raw))  # 中国区禁 IAM 回退(按 call_method 给指引)
            return None  # Global 未启用自定义:优雅降级到 IAM 回退(= 旧 Haiku 行为)
        ids = catalog_ids(raw)
        if model_id and ids and model_id not in ids:
            raise LaunchError(
                f"Agent 指定的 LLM 模型 {model_id!r} 不在当前允许清单中(请 admin 检查「LLM 配置」清单)"
            )
        # design contract:主备 fallback 备用模型序也走 TOCTOU 闸门(每个 ∈ 清单),挡住「配置后清单变更」的静默失败。
        fallback_models = [m for m in (raw.get("fallback_models") or []) if isinstance(m, str) and m.strip()]
        if ids:
            for fb in fallback_models:
                if fb not in ids:
                    raise LaunchError(
                        f"LLM 主备 fallback 备用模型 {fb!r} 不在当前允许清单中(请 admin 检查「LLM 配置」清单)"
                    )
        # BUG-2 守卫:中国区调 Claude 会被 Anthropic **按源 IP 地域封锁**返 400(直连东京/美东 mantle 皆然)。
        # 但 host 若指向**自建的跨区透传代理**(mantle-proxy,东京出口 IP),则 Claude 可达——此时不应拦。
        # 故守卫改为:**仅当 host 是直连 mantle 官方端点(bedrock-mantle.<region>.api.aws)时拒 Anthropic**;
        # host 指向其它(= 经自建代理绕封锁)时放行 Claude。既保留「防误配直连 + Claude → 静默失败」的原保护,
        # 又允许「经代理用 Claude」。design contract:主模型 + 每个备用模型都查。
        if cn_region:
            import re  # noqa: PLC0415
            host = (raw.get("host") or "").strip().lower()
            # 直连 mantle 官方端点(会被地域封锁);经代理的自定义 host 不匹配此模式 → 放行。
            direct_mantle = bool(re.search(r"bedrock-mantle\.[a-z0-9-]+\.api\.aws", host))
            if direct_mantle:
                def _is_anthropic(mid: str) -> bool:
                    return re.sub(r"^(us|eu|apac)\.", "", mid or "").startswith("anthropic.")
                effective = model_id or raw.get("default_model") or ""
                for mid in [effective, *fallback_models]:
                    if _is_anthropic(mid):
                        raise LaunchError(
                            f"中国区经**直连** mantle 端点不支持 Anthropic/Claude 模型({mid!r}):Claude 被按源 IP "
                            "地域封锁。请改用 GLM / MiniMax 等非 Anthropic 模型,或把「LLM 配置」的 host 指向跨区透传"
                            "代理(mantle-proxy)后再用 Claude(含主备 fallback 备用序)。"
                        )
        # design contract:bedrock_converse 方式的中国区守卫(review 阻断补全)。传统 Bedrock 对 Anthropic 的
        # 地域封锁按源 IP —— 中国区直连**任何 AWS 官方端点**(bedrock-runtime.* 传统 / bedrock-mantle.* mantle)调
        # Claude/Sonnet 都 400。converse 上游是传统 Bedrock,MUST 经跨区代理(host 既非 bedrock-runtime.* 也非
        # bedrock-mantle.* 官方端点,= 自建代理域名)+ 配 Bedrock API Key,否则 fail-fast(不静默拨注定封锁的会话)。
        # ★ review 阻断:原守卫只拒 bedrock-runtime.*,漏拒 mantle 默认 host bedrock-mantle.us-east-1.api.aws
        #   ——那也是官方端点、converse 经它同样封锁。故改为「拒任何 AWS 官方 bedrock 端点」。Global 允许直连(不强制)。
        from .llm_config_service import call_method as _cm  # noqa: PLC0415
        if _cm(raw) == "bedrock_converse":
            bkey = (raw.get("bedrock_api_key") or "").strip()
            host_l = (raw.get("host") or "").strip().lower()
            import re as _re2  # noqa: PLC0415
            # 官方 AWS bedrock 端点(两族都封锁 converse 的 Anthropic):bedrock-runtime.<r>.amazonaws.com(传统)
            # 或 bedrock-mantle.<r>.api.aws(mantle 默认)。自建代理(如 proxy-mantle.example.com)不匹配 → 放行。
            official_bedrock = bool(
                _re2.search(r"bedrock-runtime[a-z0-9.\-]*\.amazonaws\.com", host_l)
                or _re2.search(r"bedrock-mantle\.[a-z0-9-]+\.api\.aws", host_l)
            )
            if cn_region:
                if not host_l or official_bedrock:
                    raise LaunchError(
                        "中国区 Converse 方式(call_method=bedrock_converse)必须经跨区透传代理绕地域封锁:"
                        "请把「LLM 配置」的 host 指向 mantle-proxy 代理域名(而非直连 bedrock-runtime.*.amazonaws.com "
                        "或 bedrock-mantle.*.api.aws 官方端点),否则调 Claude/Sonnet 会被按源 IP 地域封锁。"
                    )
                if not bkey:
                    raise LaunchError(
                        "中国区 Converse 方式需要 Bedrock API Key(bedrock_api_key):请 admin 在「LLM 配置」页填入。"
                    )
        # design contract:transcript_fixer_model 是**旁路增强**(修 ASR 字幕错字),与对话命脉不同 —— 配错**降级不修**、
        # **不 fail-fast 阻断会话**(review)。剔除以下两类非法 fixer(该通不下发 → bridge 走原文):
        #   ① 非空但不在清单(admin 事后删了清单里的模型 / TOCTOU);
        #   ② 中国区经**直连**官方 mantle 端点却配了 Anthropic fixer(地域封锁不可达;经代理 host 则放行,同 BUG-2 口径)。
        # 与 default_model/fallback 的「不合法即 LaunchError」口径**不同**:那些是对话命脉必须 fail-fast,fixer 是旁路。
        fixer = (raw.get("transcript_fixer_model") or "").strip()
        if fixer:
            import re  # noqa: PLC0415
            def _is_anthropic_fixer(mid: str) -> bool:
                return re.sub(r"^(us|eu|apac)\.", "", mid or "").startswith("anthropic.")
            drop_reason = None
            if ids and fixer not in ids:
                drop_reason = "不在当前 models 清单"
            elif cn_region:
                host = (raw.get("host") or "").strip().lower()
                direct_mantle = bool(re.search(r"bedrock-mantle\.[a-z0-9-]+\.api\.aws", host))
                if direct_mantle and _is_anthropic_fixer(fixer):
                    drop_reason = "中国区经直连 mantle 端点不可达 Anthropic(地域封锁);经代理 host 才可用"
            if drop_reason:
                logger.warning(
                    "transcript_fixer_model=%r 降级不修(%s):字幕/转写走 ASR 原文,不阻断会话(design contract 旁路增强)",
                    fixer, drop_reason,
                )
                raw = {**raw, "transcript_fixer_model": ""}  # 浅拷贝剔除,不改 Secret 原 dict
        return raw

    # ── 提前结束 / 强制挂断 ──
    def hangup(self, session: dict, *, end_trigger: str = sm.END_ADMIN_HANGUP) -> dict:
        """admin 提前结束(design contract)或强制收尾:**先下发实时服务挂断** → 再置 completed +
        end_trigger,触发评估(meta→Streams)。

        review:必须先下发挂断指令,否则控制面说「已结束」但 AI 会话仍在进行。挂断指令经
        Dispatcher(本地落库 ready,生产真打实时服务);下发失败则不置 completed,冒泡给调用方报错。
        """
        now = _now_iso()
        sm.assert_transition(session["status"], sm.COMPLETED)
        # 1) 先下发实时服务挂断;失败(实时服务失联)则**不静默标 completed**(review):
        #    抛错让调用方拿到明确失败,会话保持 in_progress(可重试挂断),避免「控制面说已结束、会话仍在跑」。
        ok = self.dispatcher.hangup(session["session_id"])
        if not ok:
            raise RuntimeError("实时会话服务挂断未确认(失联),会话保持进行中;请重试提前结束")
        # 2) 实时服务已确认挂断,再落终态 + 触发评估
        session.update({"status": sm.COMPLETED, "ended_at": now, "end_trigger": end_trigger})
        self.db.put_session(session)
        # meta 置 completed → DDB Streams 触发 Evaluator 打分
        self.db.set_session_meta_status(session["session_id"], sm.COMPLETED, {"end_trigger": end_trigger})
        self._emit("session.completed", session)  # design contract webhook
        return session

    # ── 实时会话服务状态回报(事件回调)──
    def mark_connected(self, session: dict) -> dict:
        """客户端连入回报:scheduled → in_progress。已是 in_progress 则幂等返回。

        终态守卫(review):调度器可能已把超窗会话标 failed(no_show),此后迟到的客户端
        连入仍会触发 connected 回报——终态会话忽略该事件(幂等返回,不抛 StateError 500 给实时服务;
        该会话随后由 meeting_end backstop 或客户端断开自然收尾)。"""
        status = session.get("status")
        if status == sm.IN_PROGRESS:
            return session
        if status in sm.TERMINAL_STATES:
            logger.info("session %s 已终态(%s),忽略迟到的 connected 事件", session.get("session_id"), status)
            return session
        sm.assert_transition(status, sm.IN_PROGRESS)
        now = _now_iso()
        session.update({"status": sm.IN_PROGRESS, "started_at": session.get("started_at") or now})
        self.db.put_session(session)
        self.db.set_session_meta_status(session["session_id"], sm.IN_PROGRESS, {})
        return session

    def complete_from_media(self, session: dict, *, end_trigger: str) -> dict:
        """实时服务结束回报(考生结束 / 到点收尾):in_progress → completed,触发评估。

        与 admin hangup 区别:此处实时服务已自行结束会话,无需再下发挂断(避免重复挂断)。
        """
        if session.get("status") == sm.COMPLETED:
            return session
        sm.assert_transition(session["status"], sm.COMPLETED)
        now = _now_iso()
        session.update({"status": sm.COMPLETED, "ended_at": now, "end_trigger": end_trigger})
        self.db.put_session(session)
        self.db.set_session_meta_status(session["session_id"], sm.COMPLETED, {"end_trigger": end_trigger})
        self._emit("session.completed", session)
        return session

    def fail_from_media(self, session: dict, *, fail_reason: str, end_trigger: str | None = None) -> dict:
        """实时服务失败回报(design contract):违规强制结束 / 物理断连 → scheduled|in_progress → failed。

        与 complete_from_media 对称,但写 `failed` + `fail_reason` + 发 `session.failed` webhook(review)。
        **放行 scheduled → failed**(review_end 与 fire-and-forget connected 竞态,若 violation
        先到会话仍 scheduled,MUST 能转 failed,否则卡死 in_progress)。已终态则幂等返回(重复回报不误改)。
        evaluator 只在 completed 触发 → failed 会话不打分(违规/物理断连不产报告,符合 design contract)。
        """
        if sm.is_terminal(session.get("status", "")):
            return session  # 已 completed/failed:幂等,不误改(迟到/重复回报)
        sm.assert_transition(session["status"], sm.FAILED)  # scheduled|in_progress → failed 均合法
        now = _now_iso()
        session.update({"status": sm.FAILED, "fail_reason": fail_reason, "ended_at": now})
        if end_trigger:
            session["end_trigger"] = end_trigger
        self.db.put_session(session)
        self.db.set_session_meta_status(session["session_id"], sm.FAILED, {"fail_reason": fail_reason})
        self._emit("session.failed", session)  # design contract webhook(与 completed 对称)
        return session


def build_session_record(
    *,
    agent: dict,
    bank: dict | None,
    booked_by: str,
    origin: str,
    target_id: str | None,
    status: str,
    trigger: str = "manual",
    resolved_questions_override: list[dict] | None = None,
    booked_by_email: str | None = None,
) -> dict[str, Any]:
    """组装一条 Session DDB item(单场发起/时段池认领共用)。created_at 必写(进稀疏 GSI)。

    即时开始转向(deployment validation):不再写 meeting_start/meeting_end/hangup_reminder_min。过期判定锚 created_at,
    收尾锚 started_at + engine.max_duration_s。

    design contract 题库固化:创建会话时即按 Agent.question_strategy + 绑定题库(bank)解析出最终题目
    `resolved_questions`,以 seed=session_id 固化(deterministic)。
    控制面在此完成合成 —— 调度器/实时服务/evaluator 全程不读题库表(IAM 红线,design contract)。
    - 绑定固化:agent_id@agent_version + question_bank_id@question_bank_version 写入记录(题库事后改版/删除不影响本场)。
    - resolved_questions_override(可选,通用能力):调用方传一批已固化题目以沿用而非重新抽样(缺省则按策略解析)。
    (电话版的 platform/dial/retry/attempt 字段与 Campaign 展开路径已删,VISION §1;会话级重约已删,无预约。)
    """
    now_iso = _now_iso()
    session_id = f"sess_{uuid.uuid4().hex[:12]}"
    # 题目固化:有 override 则沿用;否则按策略 + 绑定题库以 seed=session_id 解析一次。
    if resolved_questions_override is not None:
        resolved_questions = list(resolved_questions_override)
    else:
        resolved_questions = resolve_questions(agent, bank, seed=session_id)
    record: dict[str, Any] = {
        "session_id": session_id,
        "agent_id": agent["agent_id"],
        "agent_version": agent.get("version", "v1"),  # 版本快照(design contract:改版不污染历史)
        # 冻结 Agent 发起/打分相关字段(review:预创建与打分须用创建时的 Agent 快照,
        # 不用 live Agent —— 否则会话排期后 admin 改 Agent,到点会用 v2 的 prompt/engine/rubric 跑 v1 会话)。
        "agent_snapshot": {k: v for k, v in agent.items() if k != "version_history"},
        "resolved_questions": resolved_questions,  # 固化题目(下发实时服务 + 写 meta 供 evaluator)
        "status": status,
        "trigger": trigger,
        "target_id": target_id,
        "created_at": now_iso,
        "started_at": None,
        "ended_at": None,
        "end_trigger": None,
        "fail_reason": None,
    }
    # 题库绑定快照(design contract):只在挂了题库时写(None 不写,保持稀疏一致)
    if bank is not None:
        record["question_bank_id"] = bank["question_bank_id"]
        record["question_bank_version"] = bank.get("version", "v1")
    # booked_by 是 BookedByIndex GSI 的 key:DynamoDB 不允许 GSI key 为 NULL,故 None 时不落该字段
    # (稀疏索引:API 发起的会话无个人归属,不进「我的会议」GSI)。origin 同理。
    if booked_by is not None:
        record["booked_by"] = booked_by
    if origin is not None:
        record["origin"] = origin
    # 发起人 email(仅展示;归属仍按 booked_by=sub)。空则不落,读侧回退显示 booked_by。
    if booked_by_email:
        record["booked_by_email"] = booked_by_email
    return record


class PerQuestionCheckRequiresQuestions(ValueError):
    """per_question_check rubric 但最终无题(design contract):发起 fail-fast,不进无法判定的会话。"""


def assert_resolvable(agent: dict, resolved_questions: list[dict]) -> None:
    """发起前校验:per_question_check Agent 必须最终有题(design contract「无题时的评估行为」)。

    dimension_score 无题合法(纯人设对话);per_question_check 无题分母为 0、判定无意义 → 拒绝。
    """
    rubric = agent.get("rubric") or {}
    mode = rubric.get("mode", "per_question_check")
    if mode == "per_question_check" and not resolved_questions:
        raise PerQuestionCheckRequiresQuestions(
            "该 Agent 为逐题判定(per_question_check),需挂非空题库;纯人设对话请用维度打分(dimension_score)"
        )
