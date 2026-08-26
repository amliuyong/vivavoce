"""AIM Evaluator Lambda —— rubric 打分(design contract)。

由 SessionEvents DynamoDB Streams 触发:
  1. 过滤「会话结束」事件:SK=meta 且 status=completed(MODIFY/INSERT);
  2. 读该 session 的 meta 行(冗余了 rubric/questions/agent 快照)+ event#<ts> 转写;
  3. 按 rubric 形态打分(per_question_check 逐题 ✓/✗ + 通过线;或 dimension_score 维度分)
     —— 调 Bedrock Claude 结构化输出(tool_use 强约束 JSON);
  4. 写 Results(含 ai_* 原始分;人工复核双轨由控制面 PATCH 写 review_*)。

只处理本系统自发起的会话(meta 必有 session_id + agent_id,无 orphan)。
幂等:已有 Results 且 review_status != pending(已被人工复核)则不覆盖。

依赖最小:boto3(Lambda runtime 自带)。Bedrock client / DDB resource 可注入(单测)。
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
from decimal import Decimal
from typing import Any

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ── design contract:归因「疑似系统漏问」的题干念出判定 ──
#   ⚠️ **双份实现,MUST 与 `bridge/src/prompt-compose.ts::questionVoiced` 保持同步**(停用词集/2-gram/阈值)——
#   两份故意独立(bridge 运行时判游标推进 R1,evaluator 事后归因 R2,职责不同不能合并),改一处务必改另一处。
#   部署回归 地面真值 10/10 是两份共同的行为回归锚(bridge test/prompt-compose.test.ts + 本 handler)。
#   某 passed=false 题,若转写里 AI 从没独立念出该题(题干判别 token 未在 AI 发言出现)→ 疑似系统漏问(非考生答错)。
#   **仅标注 + review_status,MUST NOT 改 pass_ratio**(评审 F6:启发式会误判,自动改分母风险大)。判不准偏保守
#   (题干无判别 token → 视为已念出、不误标漏问)。已知盲区(与 bridge 同):揉合时题干关键词可能出现在揉合句 →
#   判「已念出」→ 漏标(此归因抓不到揉合漏问,根治靠 design contract 从源头保证独立念出)。
_VOICED_STOPWORDS = {
    "什么", "这个", "做的", "是做", "请用", "一句", "说明", "它的", "哪两", "可以", "基于", "支持",
    "接入", "哪些", "关系", "方式", "作用", "要素", "配置", "一下", "请你", "请举", "例子", "以及", "还是",
    "怎么", "如何", "为何", "为什", "是否", "能否", "哪个", "哪种", "多少", "为止", "有没", "会受",
}


def _voiced_tokens(question_text: str) -> list[str]:
    """题干判别 token:连续中文 ≥2 字的 2-gram + 英文词(小写),去通用疑问/结构停用词。"""
    toks: set[str] = set()
    for run in re.findall(r"[一-龥]{2,}", question_text or ""):
        for i in range(len(run) - 1):
            gram = run[i:i + 2]
            if gram not in _VOICED_STOPWORDS:
                toks.add(gram)
    for w in re.findall(r"[A-Za-z][A-Za-z0-9]+", question_text or ""):
        toks.add(w.lower())
    return list(toks)


def question_voiced(question_text: str, ai_text: str, threshold: float = 0.3) -> bool:
    """AI 发言 ai_text 是否把 question_text 这道题独立念出(判别 token 命中 ≥ threshold)。
    题干无判别 token → 保守 True(不误标漏问);ai_text 空 → False。"""
    toks = _voiced_tokens(question_text or "")
    if not toks:
        return True
    ai = (ai_text or "").lower()
    if not ai:
        return False
    hit = sum(1 for t in toks if t.lower() in ai)
    return hit / len(toks) >= threshold

# ── design contract:逐题 10 分制 ──
# 单题满分默认值(LLM 未给 max_score / 非法时回填)。
DEFAULT_QUESTION_MAX_SCORE = 10.0
# 单题及格比例:每题 (score/max_score) >= 此值 → 折算 passed=True。**独立于**整场 pass_threshold
# (后者是整场加权通过线,默认 0.8,判 result["passed"]);二者作用域不同,MUST NOT 混用。
# M1 固定为常量(不进 rubric 配置,避免与 pass_threshold 混淆);可配置化另行立项(design contract 评审拍板)。
QUESTION_PASS_RATIO = 0.6

RESULTS_TABLE_NAME = os.environ.get("RESULTS_TABLE_NAME", "")
SESSION_EVENTS_TABLE_NAME = os.environ.get("SESSION_EVENTS_TABLE_NAME", "")
EVALUATOR_MODEL_ID = os.environ.get("AIM_EVALUATOR_MODEL_ID", "")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
INTEGRATION_TABLE_NAME = os.environ.get("INTEGRATION_TABLE_NAME", "")
# design contract 跨境打分(BUG-1 修复):承载 mantle host + Bearer token + evaluator_model 的 Secret。
# 中国区无 Bedrock、不授 IAM → evaluator 必须经 mantle 跨境调美东。配了则走 mantle;
# 未配则回退 IAM Bedrock(仅 Global 可用,region 钉死 us-east-1,不再用本区 AWS_REGION)。
LLM_CONFIG_SECRET_ID = os.environ.get("AIM_LLM_CONFIG_SECRET_ID", "")
# IAM 回退用 Bedrock 的 region:恒 us-east-1(中国区无 Bedrock;绝不用本区 AWS_REGION,否则连
# bedrock-runtime.cn-north-1.amazonaws.com.cn 必挂 —— 这正是 BUG-1 的根因)。
BEDROCK_FALLBACK_REGION = "us-east-1"


def _mantle_path_for(model_id: str) -> str:
    """按 model id 前缀选 mantle 路径(复刻 bridge/src/mantle-llm.ts::mantlePathFor)。
    先剥 us./eu./apac. 跨区前缀,再判 anthropic.:是 → Anthropic Messages;否则 → OpenAI 兼容。"""
    import re
    base = re.sub(r"^(us|eu|apac)\.", "", model_id or "")
    return "anthropic" if base.startswith("anthropic.") else "openai"


def _load_mantle_config() -> dict | None:
    """读 LlmConfigSecret 取 {host, api_key, evaluator_model}(design contract;BUG-1 跨境打分)。
    未配 secret / 未配 token / 读失败 → 返 None(调用方回退 IAM Bedrock,仅 Global 可用)。
    evaluator 属事件面私网 Lambda,运行时 GetSecretValue(不落库),与「系统级 token 不外扩公网媒体面」正交。"""
    if not LLM_CONFIG_SECRET_ID:
        return None
    try:
        sm = boto3.client("secretsmanager", region_name=AWS_REGION)
        body = sm.get_secret_value(SecretId=LLM_CONFIG_SECRET_ID).get("SecretString")
        raw = json.loads(body) if body else {}
    except Exception:  # noqa: BLE001 — 读不到 secret 就回退 IAM(Global);中国区会在 invoke 时 fail-fast
        logger.exception("读 LlmConfigSecret 失败,回退 IAM Bedrock(中国区将无可用打分通路)")
        return None
    # design contract:调用方式(全局单选)。mantle(现状)/ bedrock_converse(传统 Bedrock Converse API)。
    cm = raw.get("call_method")
    method = cm if cm in ("mantle", "bedrock_converse") else "mantle"
    evaluator_model = (raw.get("evaluator_model") or raw.get("default_model") or "").strip() or None
    if method == "bedrock_converse":
        # design contract:converse 凭据 = Bedrock API Key(按 call_method 取,不混用 mantle token)。
        bkey = (raw.get("bedrock_api_key") or "").strip()
        if not bkey:
            return None  # 未配 Bedrock API Key:回退 IAM(中国区会在 invoke 时 fail-fast)
        return {
            "call_method": "bedrock_converse",
            "host": (raw.get("host") or "").rstrip("/"),  # converse 端点(经代理域名);无默认(中国区必配)
            "bedrock_api_key": bkey,
            "bedrock_region": (raw.get("bedrock_region") or "us-east-1").strip(),
            "evaluator_model": evaluator_model,
        }
    token = (raw.get("api_key") or "").strip()
    if not token:
        return None  # 未配 token:回退 IAM
    return {
        "call_method": "mantle",
        "host": (raw.get("host") or "https://bedrock-mantle.us-east-1.api.aws").rstrip("/"),
        "api_key": token,
        # 打分模型:evaluator_model 优先;缺省回退 default_model;再缺回退 env(与实时对话默认解耦)。
        "evaluator_model": evaluator_model,
    }

# 结构化打分的工具定义(Bedrock Claude tool_use 强约束输出 JSON,避免脆弱的文本解析)。
# tool 按 rubric 形态动态构造(见 _build_tool),把对应打分数组设为 required。
_QUESTION_CHECKS_PROP = {
    "type": "array",
    "description": "per_question_check 形态:逐题对错(必须覆盖题目列表中的每一题)",
    "items": {
        "type": "object",
        "properties": {
            "index": {"type": "integer", "description": "题号(从 1 起,对应题目列表序号)"},
            "question": {"type": "string"},
            "passed": {"type": "boolean"},
            "evidence": {"type": "string", "description": "判定得分/对错的依据"},
            # design contract:逐题报告补「考生回答摘录 + 文字点评」。均可选(非 required),避免跨境 GLM
            #   因 N 题 × 多字段的 O(N) 文本生成压垮(evaluator 无重试;design contract GLM TTFT 悬崖)。prompt 强引导补齐。
            "user_answer": {"type": "string", "description": "考生对该题的回答摘录(原话/口语意图,ASR 转写)"},
            "comment": {"type": "string", "description": "对该题作答的简短文字点评"},
            # design contract:逐题 0–满分 评分(默认满分 10)。均可选(非 required,跨境 GLM 稳定);
            #   evaluator 由 score 折算 passed(_fold_question_score),缺 score 回退 LLM passed。
            "score": {"type": "number", "description": "单题得分(0–满分,满分默认 10)"},
            "max_score": {"type": "number", "description": "单题满分(默认 10)"},
        },
        "required": ["index", "question", "passed"],
    },
}
_DIMENSION_SCORES_PROP = {
    "type": "array",
    "description": "dimension_score 形态:各维度打分(必须覆盖每个评估维度)",
    "items": {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "score": {"type": "number"},
            "max_score": {"type": "number"},
            "comment": {"type": "string"},
        },
        "required": ["name", "score", "max_score"],
    },
}
# design contract:dimension_score 模式**新增**逐题分析数组(原本此模式完全无逐题结构,只有维度分)。
#   与维度分**并列独立**:维度分是 LLM 综合评估、逐题 score 是单题评分,两者不强制求和关系(prompt 明确)。
#   ★ 全字段可选(非 required):跨境 GLM 稳定优先(review);缺项/不足题数由 score()/前端容错。
_QUESTION_ANALYSES_PROP = {
    "type": "array",
    "description": "逐题分析(尽量覆盖每一题):题目 / 考生回答摘录 / 点评 / 单题得分",
    "items": {
        "type": "object",
        "properties": {
            "index": {"type": "integer", "description": "题号(从 1 起,对应题目列表序号)"},
            "question": {"type": "string"},
            "user_answer": {"type": "string", "description": "考生对该题的回答摘录(ASR 口语意图)"},
            "comment": {"type": "string", "description": "对该题作答的文字点评"},
            "score": {"type": "number", "description": "单题得分"},
            "max_score": {"type": "number", "description": "单题满分"},
        },
        "required": ["index"],
    },
}
# 转写感知(design contract 洞见 a,借鉴 LiveKit/Pipecat judge):被评估者的发言经 ASR 转文字,
# 可能含同音字/漏标点/口语化残字。打分 MUST 按**口语意图**判、而非按拼写判(如英文 for/fore/4 同义、
# 中文「俩个/两个」同义)。**仅改 prompt 措辞**,不动任何数据结构 / 触发 / IAM(evaluator 红线,design contract)。
# 两种 rubric 形态共用,置于 system prompt 尾部。
_ASR_AWARENESS = (
    "【转写说明】对话转写中被评估者(user)的发言由语音识别(ASR)自动转成文字,可能含同音字、"
    "漏标点或口语化残字(如「两个」被转成「俩个」、英文 for/fore/four 同音)。请按**口语意图**判定对错,"
    "**不要**因转写的拼写/用字差异而扣分或误判;AI(assistant)的提问是原文,可如实引用。"
)
# design contract:转写行题号标注说明(仅当转写含服务端游标题号 [Qn] 标注时置于 system prompt 尾部)。
# 服务端在每句转写落库时打上「当时的出题游标题号」(user + AI 都标)——这是**确定性的题目边界**,
# 不再让 evaluator 靠语义猜(design contract 去机器感后 AI 台词里已无「第 N 题」字样)。用法:题号为主分段 +
# 允许语义校正(跨题补充/标注异常时可按内容归题);[--] 行(开场/收尾/非题干)不强制归题。
_QUESTION_MARKER_AWARENESS = (
    "【题号标注说明】对话转写每行行首的 [Qn] 是系统在录制时标注的**题号**(该句发生时正在问答的题,"
    "n 与题目列表序号一致,user 与 AI 两侧都标)。请**以每句的题号标注为主**把回答确定性地归到对应题目"
    "(不要仅凭语义猜边界,尤其题目相似/答案简短/跨题补充时);**但允许**在发现「某段内容明显在说别的题」"
    "(如跨题补充、标注异常)时按语义校正归题。行首标 [--] 的行(开场白/收尾语/与题目无关的话)**不强制**"
    "归到任一题,按语义判断或不计入某题得分。"
)
_SUMMARY_PROP = {"type": "string", "description": "AI 总结(简洁中文)"}
_EXCERPTS_PROP = {
    "type": "array",
    "description": "关键回答摘录",
    "items": {
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "audio_offset_s": {"type": "number"},
        },
        "required": ["text"],
    },
}


def _build_tool(mode: str) -> dict:
    """按 rubric 形态构造 tool —— 把当前形态对应的打分数组设为 **required**,强制 LLM 必须填。

    线上实测:若把 question_checks/dimension_scores 都设为可选,LLM 可能只回 summary 而省略打分数组,
    导致 Results 出现「summary 说通过、但 passed=false / 数组为空」的矛盾。故按 mode 必填对应数组。
    """
    if mode == "dimension_score":
        # design contract:并列 question_analyses(逐题分析);它可选(不进 required),不改维度分/summary 的必填契约。
        props = {
            "dimension_scores": _DIMENSION_SCORES_PROP,
            "question_analyses": _QUESTION_ANALYSES_PROP,
            "summary": _SUMMARY_PROP,
            "excerpts": _EXCERPTS_PROP,
        }
        required = ["dimension_scores", "summary"]
    else:  # per_question_check
        props = {"question_checks": _QUESTION_CHECKS_PROP, "summary": _SUMMARY_PROP, "excerpts": _EXCERPTS_PROP}
        required = ["question_checks", "summary"]
    return {
        "name": "submit_evaluation",
        "description": "提交本场对话的结构化评估结果",
        "input_schema": {"type": "object", "properties": props, "required": required},
    }


class Evaluator:
    """可注入依赖的评估器(单测注入 fake bedrock / moto ddb)。"""

    def __init__(self, *, bedrock=None, ddb=None, model_id: str | None = None,
                 mantle=None):
        self._bedrock = bedrock
        self._ddb = ddb
        # mantle 跨境配置(BUG-1):{host, api_key, evaluator_model} 或 None(未配 → IAM 回退)。
        # 注入优先(单测);否则从 LlmConfigSecret 读。model_id 显式传入 > evaluator_model > EVALUATOR_MODEL_ID。
        self._mantle = mantle if mantle is not None else _load_mantle_config()
        self.model_id = (
            model_id
            or (self._mantle or {}).get("evaluator_model")
            or EVALUATOR_MODEL_ID
        )

    @property
    def bedrock(self):
        # IAM 回退路径:region 恒 us-east-1(中国区无 Bedrock;绝不用本区,见 BUG-1)。仅在未配 mantle 时用。
        if self._bedrock is None:
            self._bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_FALLBACK_REGION)
        return self._bedrock

    @property
    def ddb(self):
        if self._ddb is None:
            self._ddb = boto3.resource("dynamodb", region_name=AWS_REGION)
        return self._ddb

    # ── 数据读取 ──
    def _events_table(self):
        return self.ddb.Table(SESSION_EVENTS_TABLE_NAME)

    def _results_table(self):
        return self.ddb.Table(RESULTS_TABLE_NAME)

    def get_meta(self, session_id: str) -> dict | None:
        return self._events_table().get_item(
            Key={"session_id": session_id, "sk": "meta"}
        ).get("Item")

    def get_transcript(self, session_id: str) -> list[dict]:
        from boto3.dynamodb.conditions import Key

        resp = self._events_table().query(
            KeyConditionExpression=Key("session_id").eq(session_id) & Key("sk").begins_with("event#"),
        )
        items = resp.get("Items", [])
        items.sort(key=lambda e: e.get("sk", ""))
        return items

    # ── 打分 ──
    def build_prompt(self, meta: dict, transcript: list[dict]) -> tuple[str, str]:
        """组装 (system_prompt, user_prompt)。rubric 形态决定打分口径(design contract「报告形态随 rubric」)。"""
        rubric = meta.get("rubric", {}) or {}
        mode = rubric.get("mode", "per_question_check")
        questions = meta.get("questions", []) or []

        # ── design contract:转写行题号确定性标注 ──
        #   转写行落库时带 `question_index`(0-based 服务端游标事件快照,user+AI 都标)→ 渲染时 **+1 转 1-based**
        #   `[Q{n+1}]`(与 question_checks index「从 1 起」对齐;MUST 显式 +1,否则 [Q0] 让 LLM 把第 1 题回答错位)。
        #   无 question_index 字段的行(越界收尾/开场/**老会话**)标 `[--]`。
        #   老会话(整场所有行都无 question_index)→ 全 [--] + 不加题号说明 → evaluator 完全回退纯语义(现状);
        #   稀疏行(部分有部分无)→ 有题号确定归位、[--] 不强制归题(混合)。
        # design contract 评审 Minor(review):**先探测**整场是否有任何题号行(any_marker),再渲染——
        #   老会话(全无 question_index)→ 完全回退纯 `speaker: text` 格式(**不加 `[--]`**,与现状逐字节一致);
        #   有题号(含稀疏)→ 有题号行标 `[Qn+1]`、缺失行标 `[--]`(混合)。若循环里内联判 any_marker 会在
        #   老会话也误加 `[--]` 前缀(违反 spec 完整回退)。
        any_marker = any(e.get("question_index") is not None for e in transcript if e.get("text"))
        lines = []
        for e in transcript:
            speaker = e.get("speaker", "?")
            text = e.get("text", "")
            if not text:
                continue
            if not any_marker:
                lines.append(f"{speaker}: {text}")  # 老会话完全回退:无题号前缀(纯语义分段)
                continue
            qi = e.get("question_index")
            # DDB 数值可能是 Decimal;有题号统一转 int 再 +1 转 1-based;缺失行标 [--]。
            marker = "[--]" if qi is None else f"[Q{int(qi) + 1}]"
            lines.append(f"{marker} {speaker}: {text}")
        convo = "\n".join(lines) if lines else "(无转写内容)"

        q_lines = []
        for i, q in enumerate(questions, 1):
            ref = q.get("reference_answer")
            q_lines.append(f"{i}. {q.get('text', '')}" + (f"(参考答案:{ref})" if ref else ""))
        q_block = "\n".join(q_lines) if q_lines else "(无预设题目)"

        if mode == "dimension_score":
            dims = rubric.get("dimensions", []) or []
            dim_block = "\n".join(
                f"- {d.get('name')}(满分 {d.get('max_score', 5)},权重 {d.get('weight', 1)}):{d.get('description', '')}"
                for d in dims
            )
            n_dim = len(dims)
            n_q = len(questions)
            # design contract:dimension 模式也逐题分析。逐题与维度分**并列独立**——维度分是综合评估,
            #   question_analyses 是每题的回答摘录/点评/单题分,两者不必求和(避免 LLM 纠结于让二者数值一致)。
            per_q_hint = (
                f"另外,请对**每一道题**(共 {n_q} 题)在 question_analyses 里给出一项:index(从 1 起)、"
                "question(题面)、user_answer(考生回答摘录)、comment(简短点评)、score/max_score(单题得分)。"
                "question_analyses 与 dimension_scores **相互独立**:维度分是综合评估,逐题分是每题表现,不必让两者数值互相吻合。"
                if n_q > 0 else ""
            )
            system = (
                "你是严谨的对话评估官。请按给定维度对被评估者的表现打分,"
                "用 submit_evaluation 工具提交 dimension_scores、summary 与关键 excerpts。"
                f"dimension_scores 必须**恰好 {n_dim} 项**,每个评估维度一项(name 用给定维度名,"
                "score≤max_score),不要新增或重复维度。"
                + per_q_hint
                + "只依据转写证据,不臆测。"
                + _ASR_AWARENESS
                # design contract:仅当转写含题号标注([Qn])才加说明(老会话全 [--] → 不加 → 纯语义回退)。
                + (_QUESTION_MARKER_AWARENESS if any_marker else "")
            )
            user = f"评估维度({n_dim} 个):\n{dim_block}\n\n题目:\n{q_block}\n\n对话转写:\n{convo}"
        else:  # per_question_check
            pass_threshold = rubric.get("pass_threshold", 0.8)
            n_q = len(questions)
            system = (
                "你是严谨的知识 check 评估官。请逐题为被评估者的作答**打分**,"
                "用 submit_evaluation 工具提交 question_checks、summary 与关键 excerpts。"
                f"question_checks 必须**恰好 {n_q} 项**,与题目列表一一对应:第 k 项的 index=k"
                "(从 1 起),不要新增、拆分或重复题目。"
                # design contract:每题按 0–10 打分(score/max_score);passed 由系统据分数折算,你也给出 passed 供参考。
                "每项请给 score(该题得分,0–10)与 max_score(满分,填 10),分数应如实反映作答质量:"
                "完全答对给 8–10,部分正确给 5–7,基本答错/未作答给 0–4。同时给 passed(true/false)与 evidence(判分依据)。"
                # design contract:每题补 user_answer(考生回答摘录)+ comment(文字点评)。
                "另请补 user_answer(考生对该题的回答摘录)与 comment(简短点评)。"
                f"综合通过线为 {pass_threshold:.0%}(按题目权重)。只依据转写证据,不臆测。"
                + _ASR_AWARENESS
                # design contract:仅当转写含题号标注([Qn])才加说明(老会话全 [--] → 不加 → 纯语义回退)。
                + (_QUESTION_MARKER_AWARENESS if any_marker else "")
            )
            user = f"题目(共 {n_q} 题):\n{q_block}\n\n对话转写:\n{convo}"
        return system, user

    def invoke_llm(self, system: str, user: str, mode: str = "per_question_check") -> dict:
        """强制结构化输出打分结果;返回 tool input(dict)。

        三条路(BUG-1 跨境修复):
          ① 配了 mantle token + 模型走 anthropic 路径 → POST {host}/anthropic/v1/messages(tool_use)。
          ② 配了 mantle token + 其它模型(minimax/glm/…) → POST {host}/v1/chat/completions(OpenAI function-calling)。
          ③ 未配 mantle → IAM Bedrock invoke_model(仅 Global;中国区无 Bedrock,应在此前 fail-fast)。
        tool schema 按 rubric 形态构造(对应打分数组必填),两种 wire 复用同一 JSON schema。
        """
        tool = _build_tool(mode)
        if self._mantle:
            # design contract:调用方式(全局单选)。bedrock_converse → Converse API(tool 契约不同,见 _invoke_converse)。
            if self._mantle.get("call_method") == "bedrock_converse":
                return self._invoke_converse(system, user, tool)
            if _mantle_path_for(self.model_id) == "anthropic":
                return self._invoke_mantle_anthropic(system, user, tool)
            return self._invoke_mantle_openai(system, user, tool)
        # ③ IAM 回退(Global)。中国区不该走到这(未配 token 时上层已 fail-fast)。
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 4096,
            # temperature 彻底不传(设计决策 deployment validation):新模型拒该参数(400 deprecated);打分确定性由 tool 强约束保证。
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "tools": [tool],
            "tool_choice": {"type": "tool", "name": "submit_evaluation"},
        }
        resp = self.bedrock.invoke_model(
            modelId=self.model_id,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(resp["body"].read())
        for block in payload.get("content", []):
            if block.get("type") == "tool_use" and block.get("name") == "submit_evaluation":
                return _normalize_tool_input(block.get("input", {}))
        raise ValueError("LLM 未返回 submit_evaluation 工具结果")

    def _mantle_post(self, path: str, body: dict) -> dict:
        """POST 到 mantle 端点(Bearer),返回解析后的 JSON。非流式(打分要完整结果)。

        有界重试(实测:mantle 上游对个别请求偶发 5xx,一次 500 就整场放弃 → 报告空)。
        对 5xx / 超时 / 连接错误重试(指数退避 1s/2s/4s);4xx(鉴权/参数)不重试直接抛。
        """
        import time
        import urllib.error
        import urllib.request
        url = f"{self._mantle['host']}{path}"
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json",
                   "Authorization": f"Bearer {self._mantle['api_key']}"}
        last_exc: Exception | None = None
        for attempt in range(3):  # 共 3 次(初次 + 2 重试)
            if attempt:
                time.sleep(2 ** (attempt - 1))  # 1s, 2s 退避
            try:
                req = urllib.request.Request(url, data=data, method="POST", headers=headers)
                with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 — 固定 https mantle 端点
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                last_exc = e
                if e.code < 500:  # 4xx(鉴权/参数)重试无益,直接抛
                    raise
                logger.warning("mantle %s 返回 %d(第 %d 次),重试", path, e.code, attempt + 1)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_exc = e
                logger.warning("mantle %s 连接错误(第 %d 次):%s,重试", path, attempt + 1, e)
        raise last_exc  # type: ignore[misc]  # 重试耗尽:抛最后一次异常(上层 on_event 记录、Streams 重投)

    def _invoke_mantle_anthropic(self, system: str, user: str, tool: dict) -> dict:
        """mantle Anthropic Messages 路径(tool_use)。body 与 IAM Bedrock 的 Anthropic 格式一致。"""
        payload = self._mantle_post("/anthropic/v1/messages", {
            "model": self.model_id,
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 4096,
            # temperature 彻底不传(设计决策 deployment validation);打分确定性由 tool 强约束保证。
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "tools": [tool],
            "tool_choice": {"type": "tool", "name": "submit_evaluation"},
        })
        for block in payload.get("content", []):
            if block.get("type") == "tool_use" and block.get("name") == "submit_evaluation":
                return _normalize_tool_input(block.get("input", {}))
        raise ValueError("LLM(mantle/anthropic)未返回 submit_evaluation 工具结果")

    def _invoke_mantle_openai(self, system: str, user: str, tool: dict) -> dict:
        """mantle OpenAI 兼容路径(/v1/chat/completions,function calling)。
        Anthropic tool 的 input_schema 映射到 OpenAI function 的 parameters;tool_choice 强制调用。"""
        fn = {"type": "function", "function": {
            "name": tool["name"], "description": tool.get("description", ""),
            "parameters": tool["input_schema"],
        }}
        payload = self._mantle_post("/v1/chat/completions", {
            "model": self.model_id,
            "max_tokens": 4096,
            # temperature 彻底不传(设计决策 deployment validation);打分确定性由 function 强约束保证。
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "tools": [fn],
            "tool_choice": {"type": "function", "function": {"name": tool["name"]}},
        })
        choices = payload.get("choices") or []
        if choices:
            calls = (choices[0].get("message") or {}).get("tool_calls") or []
            for c in calls:
                if (c.get("function") or {}).get("name") == "submit_evaluation":
                    args = (c.get("function") or {}).get("arguments") or "{}"
                    return _normalize_tool_input(json.loads(args) if isinstance(args, str) else args)
        raise ValueError("LLM(mantle/openai)未返回 submit_evaluation 函数调用")

    def _invoke_converse(self, system: str, user: str, tool: dict) -> dict:
        """design contract:传统 Bedrock Converse API(/model/<id>/converse?mantle=false&region=,经代理绕封锁)。
        Converse 的 toolConfig 与 Anthropic Messages / OpenAI function-calling **结构各异**(review):
          - 请求:toolConfig={tools:[{toolSpec:{name,description,inputSchema:{json:<schema>}}}],
                   toolChoice:{tool:{name}}}(强制调指定 tool);
          - 响应:output.message.content[] 里 type 含 toolUse 的块 → toolUse.input(即打分 JSON)。
        鉴权 Bearer(Bedrock API Key);URL 带 mantle-proxy 路由参数 ?mantle=false&region=<r>(代理转发前剥除)。"""
        region = self._mantle["bedrock_region"]
        path = f"/model/{self.model_id}/converse?mantle=false&region={region}"
        # ★ 真机(deployment validation):Opus 4.7 等新模型 converse **不接受 `temperature`**(返 400
        #   "`temperature` is deprecated for this model")。故 converse inferenceConfig **不带 temperature**
        #   (打分确定性由 tool 强约束 + 模型默认保证;与 mantle 路径的 temperature:0 不同,converse 不传)。
        body = {
            "messages": [{"role": "user", "content": [{"text": user}]}],
            "system": [{"text": system}],
            "inferenceConfig": {"maxTokens": 4096},
            "toolConfig": {
                "tools": [{"toolSpec": {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "inputSchema": {"json": tool["input_schema"]},
                }}],
                "toolChoice": {"tool": {"name": tool["name"]}},
            },
        }
        payload = self._converse_post(path, body)
        content = ((payload.get("output") or {}).get("message") or {}).get("content") or []
        for block in content:
            tu = block.get("toolUse") if isinstance(block, dict) else None
            if tu and tu.get("name") == "submit_evaluation":
                return _normalize_tool_input(tu.get("input", {}))
        raise ValueError("LLM(converse)未返回 submit_evaluation toolUse 结果")

    def _converse_post(self, path: str, body: dict) -> dict:
        """POST 到 Bedrock Converse 端点(Bearer=Bedrock API Key),有界重试(同 _mantle_post 语义)。"""
        import time
        import urllib.error
        import urllib.request
        url = f"{self._mantle['host']}{path}"
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json",
                   "Authorization": f"Bearer {self._mantle['bedrock_api_key']}"}
        last_exc: Exception | None = None
        for attempt in range(3):
            if attempt:
                time.sleep(2 ** (attempt - 1))
            try:
                req = urllib.request.Request(url, data=data, method="POST", headers=headers)
                with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 — 固定 https 代理端点
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                last_exc = e
                # 读 4xx/5xx 响应体(Bedrock 的 400 常含具体原因,如 "temperature is deprecated")——
                # 供 evaluation_error 标记 + CloudWatch 排障(否则只有裸 "HTTP 400"、无从定位,真机踩坑教训)。
                detail = ""
                try:
                    detail = e.read().decode("utf-8", "replace")[:300]
                except Exception:  # noqa: BLE001
                    pass
                logger.warning("converse %s 返回 %d(第 %d 次):%s", path, e.code, attempt + 1, detail)
                if e.code < 500:
                    raise ValueError(f"converse HTTP {e.code}: {detail}") from e  # 4xx 带体抛,不重试
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_exc = e
                logger.warning("converse %s 连接错误(第 %d 次):%s,重试", path, attempt + 1, e)
        raise last_exc  # type: ignore[misc]

    def _clean_indexed_items(self, items: list, questions: list) -> list[dict]:
        """清洗逐题数组(design contract,question_analyses 用):只保留 index ∈ [1, n] 的 dict 项、按 index 去重、
        回填缺失的 question 题面(LLM 偶发只回 index+score 省略 question)。缺项(LLM 不足题数)不补空占位——
        交前端「缺项显示未评测」;不崩、不索引错。与 per_question_check 的 kept 逻辑同思路。"""
        n = len(questions)
        seen: set[int] = set()
        out: list[dict] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            idx = it.get("index")
            if not (isinstance(idx, (int, float)) and 1 <= int(idx) <= n):
                continue
            ii = int(idx)
            if ii in seen:
                continue
            seen.add(ii)
            if not it.get("question"):
                q_text = str(questions[ii - 1].get("text", "") or "").strip()
                if q_text:
                    it["question"] = q_text
            out.append(it)
        out.sort(key=lambda x: int(x.get("index", 0)))
        return out

    def score(self, meta: dict) -> dict:
        """对一个 session 打分,返回 Results item(不含人工复核字段)。"""
        session_id = meta["session_id"]
        rubric = meta.get("rubric", {}) or {}
        mode = rubric.get("mode", "per_question_check")
        transcript = self.get_transcript(session_id)
        system, user = self.build_prompt(meta, transcript)
        raw = self.invoke_llm(system, user, mode=mode)

        result: dict[str, Any] = {
            "session_id": session_id,
            "agent_id": meta.get("agent_id"),
            "agent_version": meta.get("agent_version"),
            "rubric_mode": mode,
            "summary": raw.get("summary", ""),
            "excerpts": [e for e in (raw.get("excerpts", []) or []) if isinstance(e, dict)],
            "review_status": "pending",
        }
        if mode == "dimension_score":
            # 防御:LLM tool 输出偶尔把数组元素返成字符串/非 dict —— 只保留 dict 项(否则 .get 抛 AttributeError)
            dims = [d for d in (raw.get("dimension_scores", []) or []) if isinstance(d, dict)]
            result["dimension_scores"] = dims
            # 加权综合分:Σ(weight_i · score_i/max_i) / Σ weight_i,归一到 [0,1](review)。
            # **迭代 rubric 定义的全部维度**(canonical 集),而非 LLM 返回的子集 —— LLM 漏返的维度
            # 按 0 分计入分母,不让缺失维度虚高总分(review)。按维度 name 匹配 LLM 分数。
            llm_by_name = {d.get("name", ""): d for d in dims}
            weighted_sum = 0.0
            weight_total = 0.0
            for rd in (rubric.get("dimensions", []) or []):
                name = rd.get("name", "")
                w = _num(rd.get("weight", 1.0))
                rd_max = _num(rd.get("max_score", 0))  # max_score 以 rubric 定义为准
                scored = llm_by_name.get(name)
                if scored is not None:
                    mx = rd_max or _num(scored.get("max_score", 0)) or 1.0
                    weighted_sum += w * (_num(scored.get("score", 0)) / mx)
                # 漏返维度:贡献 0(只进分母,不虚高)
                weight_total += w
            # 钳到 [0,1]:防 LLM 给出 score>max_score 致归一分越界(review)。
            overall = weighted_sum / weight_total if weight_total else 0.0
            result["overall_score"] = round(min(max(overall, 0.0), 1.0), 4)
            # design contract:dimension 模式并列逐题分析(与维度分独立,不参与 overall_score 计算)。
            #   有题才产出;清洗只留有效 index + 回填题面 + 缺项容错(LLM 可能不足题数,前端显示「未评测」)。
            questions = meta.get("questions", []) or []
            if questions:
                result["question_analyses"] = self._clean_indexed_items(
                    raw.get("question_analyses", []) or [], questions)
        else:  # per_question_check
            # 防御:同上,只保留 dict 项(LLM 偶发返回字符串元素会致 .get 抛 AttributeError)
            checks = [c for c in (raw.get("question_checks", []) or []) if isinstance(c, dict)]
            result["question_checks"] = checks
            # ── design contract:逐题 0–满分 评分 + 由 score 折算 passed(就地归一化,在 valid_passed 循环前)──
            #   每题产出 score/max_score(默认满分 10);passed 由 (score/max) >= QUESTION_PASS_RATIO 折算。
            #   三分支(review + review):①有合法 score → 折算 passed(覆盖 LLM 直给,消矛盾);
            #   ②无 score 但有 LLM passed → 保留(仍计入通过,不因缺 score 被误判未通过、低估通过率);
            #   ③都无 → False。数值归一化(防除零/越界/NaN,review):max_score 非正/非有限 → 回填默认 10;
            #   score 负/超 max/非有限 → 视同缺 score 走分支②。归一化后的 score/max_score 就地写回(前端三色档同源)。
            for c in checks:
                _fold_question_score(c)
            # 按题目权重判通过线(design contract)。按**题号 index** 匹配权重(review:
            # 不按 LLM 自由文本匹配 —— 文本措辞会漂移、重复题文会折叠)。index 从 1 起;
            # 越界/缺失 fallback 权重 1.0。分母用全题权重之和(总分基准固定)。
            questions = meta.get("questions", []) or []
            q_weights = [_num(q.get("weight", 1.0)) for q in questions]
            n_q = len(q_weights)
            # 只认 index ∈ [1, n_q] 的 check,按 index 去重 —— 丢弃越界/缺 index 的幻觉条目
            # (实测高温下 LLM 会狂造数百条 phantom check;给它们权重会把分数算错,review/线上实测)。
            # 分母固定为「全题权重和」(总分基准),不随 LLM 返回条数变化。
            valid_passed: dict[int, bool] = {}
            for c in checks:
                idx = c.get("index")
                if isinstance(idx, (int, float)) and 1 <= int(idx) <= n_q:
                    ii = int(idx)
                    valid_passed.setdefault(ii, bool(c.get("passed")))  # 折算后的 passed(见 _fold_question_score);同题取首次去重
            total_w = sum(q_weights) or 1.0
            passed_w = sum(q_weights[i - 1] for i, ok in valid_passed.items() if ok)
            ratio = min(passed_w / total_w, 1.0)
            threshold = _num(rubric.get("pass_threshold", 0.8))
            result["passed"] = bool(ratio >= threshold)
            result["pass_ratio"] = round(ratio, 4)
            # 只保留有效范围内的 check(去掉幻觉条目),报告才干净;并回填题面 question
            # (LLM 偶发只回 index+passed 省略 question → 报告侧 ResultOut.question 缺失会 500;
            #  evaluator 手上有 meta.questions,按 index 回填题面,报告既不崩也可读,真机根因 deployment validation)。
            kept = []
            for c in checks:
                idx = c.get("index")
                if not (isinstance(idx, (int, float)) and 1 <= int(idx) <= n_q):
                    continue
                if not c.get("question"):
                    q_text = str(questions[int(idx) - 1].get("text", "") or "").strip()
                    if q_text:
                        c["question"] = q_text
                kept.append(c)
            result["question_checks"] = kept
            # ── design contract:归因「疑似系统漏问」——passed=false 的题,若转写里 AI 从没独立念出该题
            #   (题干判别 token 未在任一 AI 发言出现)→ 标 skip_suspected + review_status=needs_review(提示人工复核)。
            #   **只标注,MUST NOT 改 pass_ratio/passed**(评审 F6:启发式误判风险,自动改分母危险)。判不准偏保守。
            ai_text = " ".join(
                str(e.get("text", "") or "") for e in transcript if e.get("speaker") == "ai"
            )
            skip_found = False
            for c in kept:
                if c.get("passed"):
                    continue  # 只审 passed=false 的题(通过的不需归因)
                q_text = str(c.get("question", "") or "")
                if q_text and not question_voiced(q_text, ai_text):
                    c["skip_suspected"] = True  # AI 未独立念出该题 → 疑似系统漏问(非考生答错)
                    skip_found = True
            if skip_found:
                # 有疑似漏问 → 提示人工复核(不改 pass_ratio;write_result 幂等仍保护已 approved/overridden)。
                result["review_status"] = "needs_review"
        return result

    def write_result(self, result: dict) -> None:
        # 幂等:已被人工复核(approved/overridden)的结果不被自动评估覆盖
        existing = self._results_table().get_item(
            Key={"session_id": result["session_id"]}
        ).get("Item")
        if existing and existing.get("review_status") in ("approved", "overridden"):
            logger.info("session %s 已人工复核,跳过覆盖", result["session_id"])
            return
        self._results_table().put_item(Item=_to_ddb(result))

    def evaluate_session(self, session_id: str) -> dict | None:
        meta = self.get_meta(session_id)
        if meta is None:
            logger.warning("session %s 无 meta,跳过(可能非本系统会话)", session_id)
            return None
        # 只处理本系统会话:meta 必有 agent_id(无 orphan)
        if not meta.get("agent_id"):
            logger.warning("session %s meta 无 agent_id,跳过", session_id)
            return None
        try:
            result = self.score(meta)
        except Exception as exc:  # noqa: BLE001
            # design contract(review):打分失败(如 converse 经代理不可达/地域封锁/toolUse 缺失)不再静默——
            # 写一个**带 evaluation_error 标记**的 Results,让前端报告页显示「评测失败」而非轮询到 3min 超时空转。
            # 写完仍 re-raise → DDB Streams 重投(瞬时故障可自愈);人工复核态不覆盖(write_result 幂等守)。
            logger.exception("session %s 打分失败,写 evaluation_error 标记后 re-raise(供 Streams 重投)", session_id)
            self.write_result({
                "session_id": session_id,
                "agent_id": meta.get("agent_id"),
                "agent_version": meta.get("agent_version"),
                "rubric_mode": (meta.get("rubric", {}) or {}).get("mode", "per_question_check"),
                "summary": "",
                "excerpts": [],
                "review_status": "pending",
                "evaluation_error": str(exc)[:300],  # 截断,不泄漏长栈;前端据此显示「评测失败」
            })
            raise
        self.write_result(result)
        logger.info("session %s 评估完成 → Results", session_id)
        # design contract:打分完成 → 向订阅 result.ready 的 webhook 推结果摘要(不发录音原文件)。
        try:
            _dispatch_result_ready(self.ddb, session_id, result, meta)
        except Exception:  # noqa: BLE001 - webhook 是旁路,失败不应影响打分主流程
            logger.exception("result.ready webhook 派发失败(session %s)", session_id)
        return result


_ARRAY_FIELDS = ("question_checks", "dimension_scores", "question_analyses", "excerpts")


def _lenient_objects(s: str) -> list[dict]:
    """从一段「本应是 JSON 数组、但内部字符串含未转义引号」的文本里尽力抽出对象列表。

    实测 Bedrock 偶把数组字段序列化成字符串,且 evidence 等自由文本含未转义的中/英文引号,
    使 json.loads 失败。这里按花括号配对切出每个 {...} 片段,逐个先严格 json.loads,失败再
    用正则提取该片段里的标量键(index/passed/score/max_score/name/question/text)兜底。
    目标是不丢「对错/分数」这类计分关键信号,而非完美还原 evidence 文本。
    """
    import re

    objs: list[dict] = []
    depth = 0
    start = -1
    for i, ch in enumerate(s):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                frag = s[start : i + 1]
                try:
                    o = json.loads(frag)
                    if isinstance(o, dict):
                        objs.append(o)
                        continue
                except (ValueError, TypeError):
                    pass
                # 兜底:正则抽标量键(计分只需 index/passed/score/max_score/name)
                o = {}
                m = re.search(r'"index"\s*:\s*(\d+)', frag)
                if m:
                    o["index"] = int(m.group(1))
                m = re.search(r'"passed"\s*:\s*(true|false)', frag)
                if m:
                    o["passed"] = m.group(1) == "true"
                m = re.search(r'"score"\s*:\s*(-?\d+(?:\.\d+)?)', frag)
                if m:
                    o["score"] = float(m.group(1))
                m = re.search(r'"max_score"\s*:\s*(-?\d+(?:\.\d+)?)', frag)
                if m:
                    o["max_score"] = float(m.group(1))
                m = re.search(r'"name"\s*:\s*"([^"]*)"', frag)
                if m:
                    o["name"] = m.group(1)
                if o:
                    objs.append(o)
    return objs


def _normalize_tool_input(raw: dict) -> dict:
    """规整 Bedrock tool_use 输出 —— 修线上实测的三类畸形:
      ① 数组字段被模型序列化成 JSON 字符串 → 先 json.loads;失败(内部含未转义引号)→ 宽松抽取;
      ② 数组里混入非 dict 元素 → 过滤掉(否则下游 .get 抛 AttributeError);
      ③ 字段缺失/类型不符 → 退化为空列表(交由下游按 0 计分,不崩)。
    """
    if not isinstance(raw, dict):
        return {}
    out = dict(raw)
    for f in _ARRAY_FIELDS:
        v = out.get(f)
        if isinstance(v, str):
            try:
                v = json.loads(v)
            except (ValueError, TypeError):
                v = _lenient_objects(v)  # 含未转义引号的坏 JSON:宽松抽取计分关键键
        if isinstance(v, list):
            out[f] = [x for x in v if isinstance(x, dict)]
        elif f in out:
            out[f] = []
    return out


def _num(v: Any) -> float:
    if isinstance(v, Decimal):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _finite_num(v: Any) -> float | None:
    """转有限浮点;非数值/NaN/Infinity → None(区别于 _num 的 0.0 兜底,用于「是否有合法数值」判定)。"""
    if v is None:
        return None
    if isinstance(v, Decimal):
        v = float(v)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _fold_question_score(c: dict) -> None:
    """design contract:就地归一化单题 score/max_score 并折算 passed(在 valid_passed 计算前调用)。
    数值归一化(防除零/越界/NaN):max_score 非正/非有限 → 回填默认 10;score 负/超 max/非有限 → 视同缺 score。
    passed 三分支:①有合法 score → (score/max) >= QUESTION_PASS_RATIO(覆盖 LLM 直给,消矛盾);
    ②无合法 score 但有 LLM passed → 保留(仍计入通过,不因缺 score 低估);③都无 → False。
    归一化后的 score/max_score 就地写回 c(前端三色档同源);无合法 score 时删除 score 键(前端据此显示「未评分」回退 ✓/✗)。"""
    mx = _finite_num(c.get("max_score"))
    if mx is None or mx <= 0:
        mx = DEFAULT_QUESTION_MAX_SCORE
    sc = _finite_num(c.get("score"))
    has_score = sc is not None and 0.0 <= sc <= mx
    if has_score:
        c["score"] = sc
        c["max_score"] = mx
        c["passed"] = (sc / mx) >= QUESTION_PASS_RATIO  # 折算,覆盖 LLM 直给的 passed
    else:
        # 无合法 score:删 score 键(前端回退 ✓/✗),保留/兜底 passed
        c.pop("score", None)
        c.pop("max_score", None)
        if c.get("passed") is None:
            c["passed"] = False  # 既无 score 又无 passed → 按未通过计


def _to_ddb(value: Any) -> Any:
    """float → Decimal(DynamoDB 不接受 float)。"""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_ddb(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_ddb(v) for v in value]
    return value


def _is_completed_meta(record: dict) -> str | None:
    """从一条 Streams record 判定是否「会话结束」事件;是则返回 session_id,否则 None。

    条件:SK(sk)=meta 且 NewImage.status=completed。INSERT/MODIFY 都看(直接落 completed 也触发)。
    DDB Streams 的 NewImage 是带类型标记的低层格式({"S":...}),用 deserializer 还原。
    """
    if record.get("eventName") not in ("INSERT", "MODIFY"):
        return None
    ddb = record.get("dynamodb", {})
    keys = _deser_image(ddb.get("Keys", {}))
    if keys.get("sk") != "meta":
        return None
    new_image = _deser_image(ddb.get("NewImage", {}))
    if new_image.get("status") != "completed":
        return None
    return keys.get("session_id")


def _result_safe_ips(host: str) -> bool:
    """webhook 投递前校验解析 IP 不指向内网/元数据(SSRF/DNS rebinding 防护,与 backend webhook.py 对齐)。"""
    import socket
    from ipaddress import ip_address

    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:  # noqa: BLE001 - 解析失败不算 SSRF(与 backend webhook.py 对齐):放行给 HTTP 层
        return True                    # 正常失败 → 走重试/死信,而非误判成 SSRF 永久丢弃
    for info in infos:
        try:
            a = ip_address(info[4][0])
        except ValueError:
            continue
        if a.is_private or a.is_loopback or a.is_link_local or a.is_reserved or a.is_multicast:
            return False
    return True


def _dispatch_result_ready(ddb, session_id: str, result: dict, meta: dict) -> None:
    """向订阅 result.ready 的 webhook 推送结果摘要(design contract)。

    自包含实现(evaluator Lambda 不能 import backend/app):scan Integration 表取所有 webhook 订阅,
    过滤含 'result.ready' 的,对每个 HMAC-SHA256 签名 + https 投递(SSRF 防护)。**不发录音原文件**,
    只发摘要(passed/overall_score + session/profile id)。失败写死信行(可重放),不重试阻塞打分。"""
    if not INTEGRATION_TABLE_NAME:
        return
    import hashlib
    import hmac as _hmac
    import time as _time
    import urllib.request
    from datetime import datetime, timezone
    from urllib.parse import urlparse

    table = ddb.Table(INTEGRATION_TABLE_NAME)
    # MVP:scan 取所有 webhook 行(集成 client 极少);过滤订阅 result.ready 的
    items = []
    scan_kwargs = {}
    while True:
        resp = table.scan(**scan_kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    hooks = [
        i for i in items
        if str(i.get("sk", "")).startswith("webhook#") and "result.ready" in (i.get("events") or [])
    ]
    if not hooks:
        return
    summary = {
        "session_id": session_id,
        "agent_id": meta.get("agent_id"),
        # rubric_mode 告知消费方该看 passed(check)还是 overall_score(dimension),负载自包含(复核 HIGH)
        "rubric_mode": result.get("rubric_mode"),
        "passed": result.get("passed"),
        "pass_ratio": _num(result.get("pass_ratio")) if result.get("pass_ratio") is not None else None,
        "overall_score": _num(result.get("overall_score")) if result.get("overall_score") is not None else None,
        # 不直发录音:给 API 拉取路径(第三方用 API Key 拉完整结果),守数据主权
        "result_url": f"/api/results/{session_id}",
    }
    event = {"event_id": f"result-{session_id}", "type": "result.ready",
             "ts": datetime.now(timezone.utc).isoformat(), "data": summary}
    body = json.dumps(event, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode("utf-8")
    for hook in hooks:
        url = hook.get("url", "")
        secret = hook.get("secret", "")
        host = (urlparse(url).hostname or "").lower()
        if not url.startswith("https://") or not host or not _result_safe_ips(host):
            logger.warning("result.ready 跳过不安全 webhook url: %s", url)
            continue
        sig = "sha256=" + _hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "X-AIM-Signature": sig, "X-AIM-Event-Id": event["event_id"]})
        # 指数退避重试(与 backend webhook.deliver 对齐:max 4 次,退避 0.5*2^(n-1)s),耗尽才写死信(复核)。
        last_detail = ""
        delivered = False
        for attempt in range(1, 5):
            try:
                with urllib.request.urlopen(req, timeout=5):  # noqa: S310 - 已校验 https + 解析 IP
                    delivered = True
                    break
            except Exception as exc:  # noqa: BLE001
                last_detail = str(exc)
                if attempt < 4:
                    _time.sleep(0.5 * (2 ** (attempt - 1)))
        if not delivered:
            logger.warning("result.ready 投递失败(重试耗尽)%s: %s", url, last_detail)
            try:
                table.put_item(Item={"pk": hook.get("pk", "client#unknown"),
                                     "sk": f"deadletter#result-{session_id}",
                                     "deadletter": True, "event_type": "result.ready",
                                     "event_id": event["event_id"], "url": url, "detail": last_detail})
            except Exception:  # noqa: BLE001
                pass


def _deser_image(image: dict) -> dict:
    """把 DDB Streams 低层 image({"k":{"S":"v"}})还原为普通 dict。"""
    from boto3.dynamodb.types import TypeDeserializer

    de = TypeDeserializer()
    out = {}
    for k, v in (image or {}).items():
        try:
            out[k] = de.deserialize(v)
        except Exception:  # noqa: BLE001
            out[k] = None
    return out


def on_event(event, _context):
    """DynamoDB Streams handler 入口。"""
    records = event.get("Records", [])
    logger.info("evaluator invoked: %d record(s)", len(records))
    evaluator = Evaluator()
    processed = 0
    for r in records:
        session_id = _is_completed_meta(r)
        if not session_id:
            continue
        try:
            evaluator.evaluate_session(session_id)
            processed += 1
        except Exception:  # noqa: BLE001
            # 单条失败不拖垮整批(bisectBatchOnError 会重投);记录后继续
            logger.exception("评估 session %s 失败", session_id)
    return {"processed": processed, "received": len(records)}
