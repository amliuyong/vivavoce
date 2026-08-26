"""API 请求/响应模型(Pydantic v2)。覆盖 MVP 控制面端点。

设计:Agent + QuestionBank 两个内核抽象(design contract,原单一 Knowledge Profile;无场景枚举);
rubric 二选一统一建模(per_question_check / dimension_score,design contract);
Session 单层状态机(design contract 缩水版:scheduled → in_progress → completed | failed,VISION §1)。
"""
from __future__ import annotations

import math
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, Field, model_validator


def _coerce_difficulty(v: Any) -> int:
    """difficulty 宽容归一(design contract):缺失/非整数(null/字符串/小数)兜底 3、越界钳到 [1,5]。

    **不 422 拒绝**(与 weight 严格度有意不同:difficulty 是排序提示而非计分依据,容错即可)——
    在 API 入口就归一,使存进 DDB 的就是合法值。

    design contract 字面契约:只接受**真整数类型**。`"4"` / `4.5` / `True` 都视作「非整数语义」→ 3
    (实测:int("4") 与 int(4.7) 不抛异常,会把字符串/小数静默接受成有效难度,违 spec)。
    **Decimal 整数例外**(DDB 读路径):`get_question_bank` 等不过 `_from_ddb` 的读路径会把存进去的
    int 读回成 `Decimal('3')`;若不认它,题库经 GET/response_model 二次校验时 difficulty 全被打回 3
    (CSV 上传后 GET 验出的真 bug)。故**整数值的 Decimal 视作合法整数**(非整 Decimal 如 2.5 仍兜底 3)。
    """
    # bool 是 int 的子类:True/False 会被 isinstance(_, int) 命中 → 显式排除
    if isinstance(v, bool):
        return 3
    # Decimal 整数(DDB 读回):转 int 后照常钳;非整 Decimal(2.5)→ 兜底 3。
    # 用 `v % 1 == 0` 判「无小数部分」(比 to_integral_value 更直白,review)。
    if isinstance(v, Decimal):
        return max(1, min(5, int(v))) if v % 1 == 0 else 3
    if not isinstance(v, int):
        return 3
    return max(1, min(5, v))


# 难度档:整数 [1,5](1 最易、5 最难),缺省 3;非法/越界输入在校验前归一(不 422)。
Difficulty = Annotated[int, BeforeValidator(_coerce_difficulty)]

def _validate_meeting_window(meeting_start: str, meeting_end: str) -> None:
    """时间窗校验(仅候选人 slot 时段池 design contract 仍用;Session 单场即时开始已无时间窗)。

    meeting_start/meeting_end 必须可解析为 ISO8601 且 end > start。非法窗口在 API 层 422。
    """
    try:
        start = datetime.fromisoformat(meeting_start.replace("Z", "+00:00"))
        end = datetime.fromisoformat(meeting_end.replace("Z", "+00:00"))
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"meeting_start/meeting_end 必须是 ISO8601 时间: {exc}") from exc
    if end <= start:
        raise ValueError("meeting_end 必须晚于 meeting_start")


class EngineParams(BaseModel):
    # Literal 强校验:typo(如 "three-stage")422 拒绝,不静默回退。
    # s2s(Nova)已删(VISION §1 拍板):只留三段式;历史数据带 s2s 在校验层 422,不静默换引擎。
    engine_type: Literal["three_stage"] = "three_stage"
    language: str = "zh-CN"
    # per-Agent LLM 模型;留空则实时会话服务回退 env 默认。
    # 携带至 resolve_launch_command 下发,使不同 Agent 可指定不同对话 LLM(review)。
    llm_model_id: str | None = None
    # 语义音色 key(统一抽象,与引擎无关):→ GPU TTS voice clone 参考音(锁声纹)。Literal 强校验 typo;
    # None=引擎用自身默认。新增音色 = 扩 Literal + GPU 加参考音 wav,不改链路。
    voice: Literal["male_std", "female_std"] | None = None
    # TTS provider 段级可插拔维度(design contract):TTS 由哪家合成。
    # gpu_omnivoice(默认,本地 OmniVoice voice clone,行为不变)| minimax(云端 MiniMax T2A)。
    # Literal 强校验 typo(对齐 voice/engine_type);None=回退 gpu_omnivoice。凭据/映射由 GPU 直读 Secret,不逐通下发。
    tts_provider: Literal["gpu_omnivoice", "minimax"] | None = None
    max_duration_s: int = 1800  # 会话最大时长上限,默认 30min;达此上限强制收尾(即时开始模型的唯一收尾预算)
    max_turns: int = 9999
    # 注:不再开放 temperature(LLM 内部固定 0.4);向后兼容老 Profile 残留该字段时 Pydantic 默认忽略额外字段。


class Question(BaseModel):
    text: str
    reference_answer: str | None = None
    # design contract:题目级 follow_up 已废弃——「是否追问」是 Agent 人设行为(system_prompt 决定),不是题目属性。
    # 游标推进判据(bridge)统一按「允许追问」语义(推进由 [[NEXT]] 主导 + 静默兜底,见 design contract)。
    # 历史 DDB 题库/固化会话 meta 残留 follow_up 键:Pydantic 默认 extra='ignore' 读到忽略,运行时无读取点(向后兼容)。
    weight: float = 1.0
    # 难度档(design contract):整数、域 [1,5](1 最易、5 最难)、缺省 3(中等)。仅用于 easy_to_hard 策略排序。
    # 用 BeforeValidator 在校验前归一:越界钳到 [1,5]、非整数(null/字符串)兜底 3 —— **不** 422 拒绝
    # (排序提示而非计分依据,容错即可);resolve_questions 侧仍有同款兜底防 DDB 历史脏数据。
    difficulty: Difficulty = 3

    @model_validator(mode="after")
    def _check_weight(self) -> Question:
        # weight 必须 > 0 且有限(对齐 RubricDimension):零/负权重破坏加权计分;inf/nan 会让 evaluator
        # 的 Σweight/ratio 变 nan(nan<=0 为 False 能溜过 >0 检查)→ 在 API 层 422 早拒,不流到持久化/计算
        #(复核 HIGH:json 非标准支持 Infinity/NaN,攻击者可构造)。
        if not math.isfinite(self.weight) or self.weight <= 0:
            raise ValueError("题目 weight 必须是 > 0 的有限数值")
        return self


class RubricDimension(BaseModel):
    """dimension_score 形态的单个维度(典型面试)。"""

    name: str
    description: str = ""
    weight: float = 1.0
    max_score: float = 5.0


class Rubric(BaseModel):
    """rubric 两形态统一建模 —— 二选一(design contract)。

    - per_question_check:逐题 ✓/✗ + 通过线(pass_threshold ∈ [0,1]),典型培训 check。
    - dimension_score:维度打分(dimensions[]),典型面试。
    校验在 model_validator:形态合法 + 对应字段齐备 + 权重/通过线合法。
    """

    mode: Literal["per_question_check", "dimension_score"] = "per_question_check"
    pass_threshold: float = 0.8  # per_question_check 用:通过线(0~1)
    dimensions: list[RubricDimension] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_shape(self) -> Rubric:
        if self.mode == "per_question_check":
            if not (0.0 <= self.pass_threshold <= 1.0):
                raise ValueError("per_question_check 的 pass_threshold 必须在 [0,1]")
        elif self.mode == "dimension_score":
            if not self.dimensions:
                raise ValueError("dimension_score 至少需要一个维度")
            for d in self.dimensions:
                if not math.isfinite(d.weight) or d.weight <= 0:
                    raise ValueError(f"维度 {d.name} 的 weight 必须是 > 0 的有限数值")
                if not math.isfinite(d.max_score) or d.max_score <= 0:
                    raise ValueError(f"维度 {d.name} 的 max_score 必须是 > 0 的有限数值")
        return self


# 出题策略(design contract):Agent 决定怎么从所挂题库出题。预设枚举,不让用户写自由代码。
#   sequential            全部题目按题库原序(默认,= 003 现状行为)
#   random_n              随机抽 N 题(N=strategy_n),随机顺序
#   easy_to_hard          全部题目按 difficulty 升序(等难度保持原序)
#   random_n_easy_to_hard 先随机抽 N 题,再按 difficulty 升序
QuestionStrategy = Literal["sequential", "random_n", "easy_to_hard", "random_n_easy_to_hard"]
_RANDOM_STRATEGIES = ("random_n", "random_n_easy_to_hard")


class AgentIn(BaseModel):
    """Agent(design contract,取代 003 的 Profile 角色):人设 + rubric + engine + 出题策略 + self_bookable。

    **不再内嵌 questions** —— 题目外置到 QuestionBank,Agent 经 question_strategy 决定怎么出题。
    rubric 归 Agent(评分是 Agent 的职责定义)。default_question_bank_id 供 staff 自助预约用
    (staff 不选题库,用 Agent 预设;admin/HR 发起可覆盖)。
    """

    name: str
    labels: list[str] = Field(default_factory=list)
    system_prompt: str = ""
    rubric: Rubric = Field(default_factory=Rubric)
    engine: EngineParams = Field(default_factory=EngineParams)
    question_strategy: QuestionStrategy = "sequential"
    # random 类策略的抽题数;仅 random_n / random_n_easy_to_hard 下校验为 > 0,其余策略忽略(可空)。
    strategy_n: int | None = None
    # staff 自助预约用的默认题库(可空 = 纯人设对话);admin/HR 发起表单可显式覆盖。
    default_question_bank_id: str | None = None
    self_bookable: bool = False
    # 实时字幕显示开关(design contract):是否在**实时对话界面**渲染字幕/transcript。默认开(None/缺省=True,
    # 向后兼容现状 design contract Teams 舞台)。**纯前端呈现语义**——只影响实时界面是否渲染,不进引擎/GPU/evaluator;
    # 转写照常经 onTranscript 下发+落库、事后报告照常显示全文。故置 Agent **顶层**(呈现配置),**不**放
    # EngineParams(引擎运行时参数块;voice/tts_provider 虽在其中但最终流向 GPU,属引擎侧)。经 ready 帧下发前端。
    show_subtitles: bool | None = None
    # 头像风格(design contract):实时对话舞台中央视觉主体。minimal(极简线条,默认)/round(圆脸)/tech(方脸机器人)/
    #   waveform(纯波形,无头像=回退 design contract 中央大波形)。**纯前端呈现语义**(同 show_subtitles,不进引擎/GPU/
    #   evaluator);经 ready 帧下发前端。None/缺省 → 前端兜底 minimal。非四枚举 Pydantic Literal 天然 422 守门。
    avatar_style: Literal["minimal", "round", "tech", "waveform"] | None = None
    # 声纹锁定说话人(design contract):开启时会话开场自动注册目标人声纹,之后**只有目标说话人才能打断 AI**
    #   (旁人/环境人声不误触发打断)。**默认锁定(开)**:None/缺省=True(设计决策默认开、上线即生效)。
    #   **会话行为语义**(bridge 侧注册 + 打断门控),不流向 GPU 引擎运行时,故置 Agent **顶层**(同
    #   show_subtitles/avatar_style),**不**放 EngineParams。经 ready 预创建 payload 下发 bridge;实际是否
    #   生效还要过 bridge 的 effective_speaker_lock(需 recovery 开)+ 注册就绪 + 非 fail-open(见 design contract)。
    speaker_lock: bool | None = None

    @model_validator(mode="after")
    def _check_strategy(self) -> AgentIn:
        # 仅 random 类策略校验 strategy_n>0(design contract:不让「random 策略但 N 缺失/≤0」的脏 Agent 入库);
        # 其余策略 strategy_n 被忽略(可为 null、传了也不影响)。
        if self.question_strategy in _RANDOM_STRATEGIES:
            if self.strategy_n is None or self.strategy_n <= 0:
                raise ValueError(f"{self.question_strategy} 策略需要 strategy_n > 0")
        return self


class AuditFields(BaseModel):
    """机器(API Key)写入的审计留痕(design contract)——只记录、不参与任何门控/隔离。

    单租户模型:API Key = admin 本人机器分身。这里记「哪把 key(client_id)」+「签发该 key 的 admin
    (created_by,取自 Principal.created_by)」,供 audit 追溯「谁经机器建/改了 Agent/题库」。
    admin 经 Web 后台 JWT 建的记录这组字段为空(据此区分「机器建 vs 人建」)。DDB 字段可选、零迁移。
    """

    created_by_client: str | None = None
    created_by_admin: str | None = None
    created_at: str | None = None
    updated_by_client: str | None = None
    updated_by_admin: str | None = None
    updated_at: str | None = None


class AgentOut(AgentIn, AuditFields):
    agent_id: str
    version: str = "v1"
    status: str = "active"


class AgentVersionsOut(BaseModel):
    agent_id: str
    current_version: str
    versions: list[AgentOut]


class QuestionBankIn(BaseModel):
    """可复用题库(design contract):一份题目集合,可被多个 Agent / 会议挂载。

    题库 MUST NOT 含 rubric / engine / 人设(那些是 Agent 的职责)。
    """

    name: str
    labels: list[str] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)


class QuestionBankOut(QuestionBankIn, AuditFields):
    question_bank_id: str
    version: str = "v1"
    status: str = "active"


class QuestionBankVersionsOut(BaseModel):
    question_bank_id: str
    current_version: str
    versions: list[QuestionBankOut]


# ── Targets(design contract) ──
class TargetIn(BaseModel):
    name: str
    external_id: str | None = None  # email/手机,业务唯一标识(去重/关联)
    dept: str | None = None
    tags: list[str] = Field(default_factory=list)
    attrs: dict[str, Any] = Field(default_factory=dict)  # 弱 schema:简历/工号/课程等
    note: str | None = None


class TargetOut(TargetIn):
    target_id: str
    source: str = "admin"  # admin(运营录入/CSV) | self(员工自助自动建)


# ── Sessions(design contract 缩水版:无电话/拨号字段,VISION §1) ──
class SessionLaunchIn(BaseModel):
    """即时开始(deployment validation 转向):发起体只剩 agent_id[+题库/对象绑定]。无预约时间窗——
    session 创建即可连入;收尾由 Agent.engine.max_duration_s 上限界定,不再录入 meeting_start/end。"""

    agent_id: str
    question_bank_id: str | None = None  # 可选、单个(design contract);不传则回退 Agent.default_question_bank_id
    target_external_id: str | None = None  # HR 可选绑定既有对象
    # 发起人 email(前端从 id token 取;仅供「发起人」可读展示,access token 无 email claim)。
    # 归属/过滤仍按 booked_by=principal.sub(权威、稳定),此字段不参与鉴权/隔离。
    booked_by_email: str | None = None


class SessionJoinOut(BaseModel):
    """GET /api/sessions/{session_id}/join 响应(M1-B):实时会话连入凭据。

    客户端流程:拿 join_token → 连 wss://<站点>{ws_path}?session_id=<id> →
    首帧 {"type":"auth","token":<join_token>}。生产验签在实时会话服务(bridge)。
    """

    join_token: str  # v1.<session_id>.<exp_unix>.<sig>(HMAC-SHA256,契约见 app/join_token.py)
    ws_path: str = "/rt/ws"
    expires_at: str  # ISO8601(= token exp,now + JOIN_MAX_TTL)


class RealtimeClientSecretOut(BaseModel):
    value: str
    expires_at: int
    url: str


class SessionOut(BaseModel):
    session_id: str
    agent_id: str
    agent_name: str | None = None  # 发起时的 Agent 名字快照(取自 agent_snapshot.name;供会话历史「场景」列可读展示)
    agent_version: str | None = None  # 发起时的 Agent 版本快照(design contract)
    question_bank_id: str | None = None  # 绑定的题库(design contract,可空)
    question_bank_version: str | None = None  # 绑定时的题库版本快照
    status: str
    trigger: str  # manual(Campaign 已删;读侧容忍历史数据)
    origin: str | None = None  # hr | staff | candidate | api
    booked_by: str | None = None  # 归属键(= principal.sub,稳定;staff 只看自己按此过滤)
    booked_by_email: str | None = None  # 发起人 email(仅展示,可空;access token 无 email 时前端未带则空)
    target_id: str | None = None
    target_name: str | None = None  # 对象可读名(解析 target_id → Target.name/external_id;供详情「对象」列展示,不落库)
    created_at: str | None = None  # 创建时刻(列表排序 + 详情「创建时间」展示;过期判定锚点 created_at+N)
    # meeting_start/end 保留为可空(即时开始转向后新建不再写;历史数据/候选人 slot 回填仍可显)。
    meeting_start: str | None = None
    meeting_end: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    end_trigger: str | None = None
    fail_reason: str | None = None  # no_show(过期未连入)| unrecoverable | cancelled


class AgentStat(BaseModel):
    """总览「按场景(Agent)分」的单个 Agent 聚合统计。

    「场景」= Agent(本项目铁律无场景类型枚举,用途由 Agent 决定)。通过率口径:
    分母 = 有评测结果的会话数(evaluated);分子 = passed 的会话数(优先人工复核 review_passed,
    回退 AI passed;dimension_score 模式无 passed → 按 overall_score>=阈值,由聚合侧折算)。
    未出评测结果(评测中/失败/未完成)的会话计入 total 但**不计入 evaluated 分母**,避免拉低通过率。
    """
    agent_id: str
    agent_name: str | None = None  # Agent 名字(取 live Agent 或会话快照);无则前端回退 agent_id
    total: int = 0        # 该 Agent 的会话总数(全状态)
    completed: int = 0    # status=completed 的会话数
    evaluated: int = 0    # 有评测结果的会话数(= 通过率分母)
    passed: int = 0       # 通过的会话数(= 通过率分子)
    pass_rate: float | None = None  # passed/evaluated;evaluated=0 → None(前端显「—」不显 0%)


class SessionStatsOut(BaseModel):
    """总览统计聚合(spec:按场景分 + 通过率)。按 Agent 分组,按会话总数倒序。"""
    agents: list[AgentStat] = []


# ── Results(design contract) ──
class QuestionCheck(BaseModel):
    index: int = 0  # 从 1 起的题号(evaluator handler 按序匹配权重/去重/过滤幻觉);对齐实际输出契约
    # question 可空:Evaluator 出分时可能只给 index+passed(题面缺失/题库未透传),不应让整个报告 500
    # (真机根因 deployment validation:question 原为必填 → 存量结果 question_checks 缺 question → GET /results 500)。
    question: str | None = None
    passed: bool
    evidence: str | None = None  # 判定 passed 的依据
    # design contract:逐题报告补「考生回答摘录 + 文字点评」。全部可选(evaluator 侧非 required,跨境 GLM 稳定;
    #   存量旧结果无这些字段亦不崩)。三字段职责:user_answer=回答原话摘录、evidence=判对错依据、comment=点评。
    user_answer: str | None = None
    comment: str | None = None
    # design contract:逐题 0–满分 评分(默认满分 10)。可选(evaluator tool schema 非 required,跨境 GLM 稳定;
    #   存量旧结果无这些字段亦不崩)。evaluator 由 score 折算 passed(单题及格比例 0.6);前端按 score/max_score
    #   归一比例显示三色档(<0.6 红 / [0.6,0.8] 黄 / >0.8 绿),无 score 回退 ✓/✗。
    score: float | None = None
    max_score: float | None = None
    # design contract:该 passed=false 的题疑似**系统漏问**(转写里 AI 从没独立念出该题),非考生答错 → 供报告页/
    #   人工复核区分「系统缺陷」与「考生真未作答」。仅 evaluator 判定为疑似漏问时置 True;否则缺省(存量结果无此字段)。
    skip_suspected: bool | None = None


class QuestionAnalysis(BaseModel):
    """逐题分析(design contract):dimension_score 模式并列产出(该模式原本无逐题结构)。
    与维度分独立:维度分是综合评估,此处 score 是单题得分,两者不强制求和。全字段可选(缺项容错)。"""

    index: int = 0  # 从 1 起的题号
    question: str | None = None
    user_answer: str | None = None  # 考生回答摘录
    comment: str | None = None  # 文字点评
    score: float | None = None  # 单题得分
    max_score: float | None = None  # 单题满分


class DimensionScore(BaseModel):
    name: str
    score: float
    max_score: float
    comment: str | None = None


class Excerpt(BaseModel):
    text: str
    audio_offset_s: float | None = None  # 录音偏移(报告跳点回放)


class TranscriptLine(BaseModel):
    """一句转写(design contract 转写下载);与 bridge transcript-store / SessionEvents event#<ts> 行对称。"""

    ts: str | None = None  # ISO8601 时间戳(SK 排序键)
    speaker: str | None = None  # "user" | "ai"
    text: str | None = None


class TranscriptOut(BaseModel):
    session_id: str
    lines: list[TranscriptLine] = Field(default_factory=list)


class ResultOut(BaseModel):
    session_id: str
    agent_id: str | None = None
    agent_version: str | None = None
    rubric_mode: str | None = None
    # per_question_check 形态(AI 出分)
    question_checks: list[QuestionCheck] = Field(default_factory=list)
    passed: bool | None = None
    pass_ratio: float | None = None  # 加权通过比例(AI 原始)
    # dimension_score 形态(AI 出分)
    dimension_scores: list[DimensionScore] = Field(default_factory=list)
    overall_score: float | None = None
    # design contract:逐题分析(dimension_score 模式并列产出;per_question_check 模式逐题信息在 question_checks)。
    #   默认空列表 → 存量旧结果(无此 key)序列化不崩,前端缺项显示「未评测」。
    question_analyses: list[QuestionAnalysis] = Field(default_factory=list)
    # 通用
    summary: str | None = None
    excerpts: list[Excerpt] = Field(default_factory=list)
    # design contract(review):打分失败标记。evaluator 经跨境 LLM(mantle/converse)调用失败时写此字段,
    #   前端报告页据此显示「评测失败」而非轮询到超时空转。默认 None(正常打分无此字段,旧结果不崩)。
    evaluation_error: str | None = None
    # 人工复核双轨(AI 出分与人工判定不互相覆盖):review_* 是人工改判值,与上方 AI 原始分并存
    # pending(默认,待复核) | needs_review(design contract:检出疑似系统漏问,系统侧提示优先复核) |
    # approved / overridden(人工终态,write_result 幂等只保护这两个不被自动重评覆盖;pending/needs_review 会被重评刷新)。
    review_status: str = "pending"
    reviewer: str | None = None
    reviewed_at: str | None = None
    review_note: str | None = None
    review_passed: bool | None = None  # 人工改判(check 类),不覆盖 AI 的 passed
    review_overall_score: float | None = None  # 人工改判(维度类),不覆盖 AI 的 overall_score
    recording_url: str | None = None  # 预签名 URL(限时)


class ResultReviewIn(BaseModel):
    action: Literal["approve", "override"]
    # override 时可改判:覆盖 passed(check 类)或 overall_score(维度类)
    passed: bool | None = None
    overall_score: float | None = None
    note: str | None = None


class CsvRowError(BaseModel):
    line: int  # CSV 行号(1-based,含表头则数据行从 2 起)
    reason: str
    raw: dict[str, Any] = Field(default_factory=dict)


class QuestionBankUploadResult(BaseModel):
    """题库 CSV 批量上传结果(spec:免逐题手加)。逐行校验:合法行入库、非法行跳过 + 错误明细。"""
    question_bank_id: str
    mode: str  # append(追加现有题目) | replace(整替题库题目)
    total_rows: int  # CSV 数据行数(不含表头)
    imported: int  # 成功导入的题数
    rejected: int  # 校验失败跳过的行数
    total_questions: int  # 导入后题库题目总数(append=原有+导入;replace=导入数)
    errors: list[CsvRowError] = Field(default_factory=list)


# ── 候选人对外自助(design contract,v2)──
class SlotIn(BaseModel):
    """HR 录入一个面试时段到时段池(design contract 缩水版:纯时间窗,无电话/会议字段)。"""

    engagement_id: str  # 招聘环节标识(同一环节的候选人从这批时段里选)
    agent_id: str  # 该环节用的 Agent(面试官人设/rubric/引擎/出题策略,design contract)
    question_bank_id: str | None = None  # 可选、单个题库(design contract);不传走 Agent 默认
    meeting_start: str
    meeting_end: str

    @model_validator(mode="after")
    def _check(self) -> SlotIn:
        _validate_meeting_window(self.meeting_start, self.meeting_end)
        return self


class SlotOut(BaseModel):
    slot_id: str
    engagement_id: str
    agent_id: str
    question_bank_id: str | None = None
    meeting_start: str | None = None
    meeting_end: str | None = None
    status: str = "open"  # open | claimed
    claimed_by: str | None = None  # 候选人标识(认领后)
    session_id: str | None = None  # 认领后绑定的会话


class CandidateLinkIn(BaseModel):
    """HR 为某候选人 + 环节签发一次性自助链接(design contract)。"""

    candidate_id: str  # 候选人业务标识(email/手机/外部ID)
    engagement_id: str
    candidate_name: str | None = None
    ttl_hours: int = 168  # 链接有效期(默认 7 天)

    @model_validator(mode="after")
    def _check_ttl(self) -> CandidateLinkIn:
        # 一次性链接封顶(与 DelegationIn 同口径):HR 误发数年有效链接 = 长期暴露面。上界 336h(14 天)。
        if self.ttl_hours <= 0:
            raise ValueError("ttl_hours 必须为正")
        if self.ttl_hours > 336:
            raise ValueError("ttl_hours 不得超过 336(14 天)")
        return self


class CandidateLinkOut(BaseModel):
    token: str
    candidate_id: str
    engagement_id: str
    exp_epoch: int


class CandidateSlotPublic(BaseModel):
    """候选人侧看到的可选时段(脱敏:不暴露运营侧信息)。"""

    slot_id: str
    meeting_start: str | None = None
    meeting_end: str | None = None


class CandidateBookIn(BaseModel):
    slot_id: str
    consent: bool = False  # AI 录音知情同意(design contract:未同意不开始)


class CandidateRescheduleIn(BaseModel):
    new_slot_id: str  # 改约到的新空闲时段(design contract「改选其他空闲时段」)


class CandidateStatusOut(BaseModel):
    """候选人侧只见流程状态,不见任何评分/转写/录音(design contract 结果隔离)。"""

    engagement_id: str
    booked: bool = False
    slot_id: str | None = None
    meeting_start: str | None = None
    meeting_end: str | None = None
    # 流程态:not_booked | booked | in_progress | finished(完成只说"已完成",不给分)
    stage: str = "not_booked"


# ── API / Webhook 集成(design contract,v2)──
# 合法 scope(API Key 机器身份按 scope 最小授权;campaigns:write 已随 Campaign 删除)。
# agents:* / question-banks:*(design contract):admin 级机器 CRUD Agent/题库,等价 admin Web 后台能力。
VALID_SCOPES = (
    "sessions:write", "sessions:read", "results:read", "webhooks:manage",
    "agents:write", "agents:read", "question-banks:write", "question-banks:read",
)


class ApiClientIn(BaseModel):
    """admin 创建 API client(系统集成商凭据,代表 admin 级机器操作整个系统)。"""

    name: str
    scopes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check(self) -> ApiClientIn:
        bad = [s for s in self.scopes if s not in VALID_SCOPES]
        if bad:
            raise ValueError(f"非法 scope: {bad};合法值 {list(VALID_SCOPES)}")
        return self


class ApiClientOut(BaseModel):
    client_id: str
    name: str
    scopes: list[str] = Field(default_factory=list)
    created_at: str | None = None
    created_by: str | None = None
    # api_key 仅在创建响应里返回一次(之后只存 hash,不可取回)
    api_key: str | None = None


class WebhookIn(BaseModel):
    url: str
    events: list[str] = Field(default_factory=list)  # session.completed/failed、result.ready

    @model_validator(mode="after")
    def _check(self) -> WebhookIn:
        from .webhook import VALID_EVENTS, validate_webhook_url
        validate_webhook_url(self.url)  # https + 防 SSRF(内网/元数据地址,review 高危)
        bad = [e for e in self.events if e not in VALID_EVENTS]
        if bad:
            raise ValueError(f"非法事件类型: {bad}")
        if not self.events:
            raise ValueError("至少订阅一个事件")
        return self


class WebhookOut(BaseModel):
    webhook_id: str
    client_id: str
    url: str
    events: list[str] = Field(default_factory=list)
    created_at: str | None = None
    secret: str | None = None  # 仅创建时返回一次(验签用),之后不回显


class DelegationIn(BaseModel):
    """staff 自助签发委托 token,授权第三方 agent 代自己预约/查询(design contract)。"""

    label: str | None = None  # 给这个委托起个名(如"我的日程助理")
    ttl_hours: int = 168  # 默认 7 天

    @model_validator(mode="after")
    def _check_ttl(self) -> DelegationIn:
        # 委托 token 是无状态 HMAC、签发后无法单条吊销,只能等过期 → 硬上限 30 天控制泄露窗口(design contract)
        if self.ttl_hours <= 0:
            raise ValueError("ttl_hours 必须为正")
        if self.ttl_hours > 720:
            raise ValueError("委托有效期最长 720 小时(30 天)")
        return self


class DelegationOut(BaseModel):
    token: str  # 仅签发时返回一次
    label: str | None = None
    staff: str  # 被代理的 staff identity
    exp_epoch: int
    # 即用 MCP 配置(design contract):前端据此生成「下载我的 MCP 助手」—— 内嵌 token + endpoint 的
    # 本地 stdio MCP server,用户下载即用,无需手动 copy token。MCP server 程序本身单列交付。
    mcp_config: dict | None = None


class LlmCredentialStatusOut(BaseModel):
    status: Literal["ok", "expiring", "expired", "not_configured", "not_applicable"]
    expires_at: str | None = None


class WhoAmI(BaseModel):
    sub: str
    username: str
    groups: list[str]
    is_admin: bool
    is_staff: bool
