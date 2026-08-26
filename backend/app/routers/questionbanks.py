"""题库(QuestionBank)路由(design contract)。

可复用的题目集合,可被多个 Agent / 会议挂载。题库 CRUD 全 admin-only(staff 不可见、不可管;
staff 自助走 Agent 预设题库)。版本快照:改版不覆盖历史(db.update_question_bank)。

删除保护(引用完整性,design contract):被活动会话 / 时段池 Slot / 任何 Agent 的
default_question_bank_id 引用时 409 挡删(避免悬挂默认/引用)。已固化 resolved_questions 的
会话不算引用(快照独立,题库删除不影响其报告)。
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import ValidationError

from .. import state_machine as sm
from ..auth import Principal
from ..deps import require_admin
from ..models import (
    CsvRowError,
    Question,
    QuestionBankIn,
    QuestionBankOut,
    QuestionBankUploadResult,
    QuestionBankVersionsOut,
)

router = APIRouter(prefix="/api/question-banks", tags=["question-banks"])

# CSV 上传上限(防超大体,5MB)。
_MAX_CSV_BYTES = 5 * 1024 * 1024
# CSV 列(= Question 字段);text 必填,其余留空用默认(weight=1.0/difficulty=3)。
# design contract:题目级 follow_up 已废弃(追问=Agent 人设行为),CSV 不再含该列;历史 CSV 带 follow_up 列 → 多余列忽略。
_CSV_COLUMNS = ["text", "reference_answer", "weight", "difficulty"]
# 模板内容(表头 + 一行示例);前端「下载模板」直接取此。
_CSV_TEMPLATE = (
    "text,reference_answer,weight,difficulty\r\n"
    "请简单介绍一下你自己,期望涵盖经历与技能,1.0,2\r\n"
)


def parse_questions_csv(text: str) -> tuple[list[Question], list[CsvRowError]]:
    """解析题库 CSV(text 必填,其余留空用默认)。逐行校验:合法行 → Question,非法行 → 错误明细。

    CSV 容错口径:难度宽容(Question.difficulty 的 BeforeValidator 已钳 [1,5]/兜底 3);
    weight 非数字 → 该行拒;text 空 → 该行拒。表头大小写/空格不敏感。历史 follow_up 列被忽略(design contract)。
    """
    questions: list[Question] = []
    errors: list[CsvRowError] = []
    reader = csv.DictReader(io.StringIO(text))
    # 表头规整(小写去空格);缺 text 列 → 整体无法解析,返回单条错误。
    if reader.fieldnames is None:
        return [], [CsvRowError(line=1, reason="CSV 为空或无表头", raw={})]
    # 表头规整(小写去空格)→ 原列名;**规整后冲突**(如 "Text" 与 "text")明确报错,不静默丢列(review)。
    norm_map: dict[str, str] = {}
    for name in reader.fieldnames:
        key = (name or "").strip().lower()
        if key in norm_map:
            return [], [CsvRowError(line=1, reason=f"列名重复(规整后):{key!r}", raw={})]
        norm_map[key] = name
    if "text" not in norm_map:
        return [], [CsvRowError(line=1, reason="缺少必需列 text(表头需含 text)", raw={})]
    def _cell(row: dict, col: str) -> str:
        """按规整表头取值(容忍列名大小写/空格);缺列 → 空串。"""
        src = norm_map.get(col)
        return (row.get(src) or "") if src else ""

    line = 1  # 表头是第 1 行,数据行从 2 起
    for row in reader:
        line += 1
        text_v = _cell(row, "text").strip()
        if not text_v:
            errors.append(CsvRowError(line=line, reason="text 为空(题干必填)", raw=dict(row)))
            continue
        ref = _cell(row, "reference_answer").strip() or None
        weight_raw = _cell(row, "weight").strip()
        diff_raw = _cell(row, "difficulty").strip()
        payload: dict = {"text": text_v, "reference_answer": ref}
        # weight:留空用默认 1.0;填了但非数字 → 拒该行(weight 是计分依据,不宜静默兜底)。
        if weight_raw:
            try:
                payload["weight"] = float(weight_raw)
            except ValueError:
                errors.append(CsvRowError(line=line, reason=f"weight 非数字:{weight_raw!r}", raw=dict(row)))
                continue
        # difficulty:CSV 值是字符串,但 Question.difficulty 的契约只认**真 int 类型**(字符串会被
        #   _coerce_difficulty 当「非整数语义」兜底 3)。故在此先转 int 再交给验证器(越界由验证器钳 [1,5]);
        #   非整数串(如 "高"/"2.5")转不了 → 留空用默认 3(difficulty 是排序提示,容错不拒行,沿用 design contract)。
        if diff_raw:
            try:
                payload["difficulty"] = int(diff_raw)
            except ValueError:
                pass  # 非整数难度串 → 不塞,用默认 3(不拒行)
        try:
            questions.append(Question(**payload))
        except ValidationError as exc:
            # weight 范围等模型级校验失败(Question._check_weight)→ 拒该行,给首条错误。
            reason = exc.errors()[0].get("msg", "校验失败") if exc.errors() else "校验失败"
            errors.append(CsvRowError(line=line, reason=str(reason), raw=dict(row)))
    return questions, errors


def _db(request: Request):
    return request.app.state.db


def assert_qb_deletable(db, question_bank_id: str) -> None:
    """题库删除引用完整性检查(design contract;design contract 机器端点复用)。不满足 → 409,满足 → 返回。

    3 类引用挡删:① 活动会话(question_bank_id 字段);② 任何 Agent 的 default_question_bank_id;
    ③ 时段池 Slot。已固化 resolved_questions 的(终态/历史)会话不算引用(快照独立)。
    调用方须先确认题库存在(本函数只查引用,不查存在性)。
    """
    active = [
        s for s in db.list_sessions()
        if s.get("question_bank_id") == question_bank_id and s.get("status") in sm.ACTIVE_STATES
    ]
    if active:
        raise HTTPException(
            status_code=409,
            detail=f"该题库仍被 {len(active)} 个进行中的会话引用,无法删除(请先结束这些会话)",
        )
    agents = [a for a in db.list_agents() if a.get("default_question_bank_id") == question_bank_id]
    if agents:
        names = ", ".join(a.get("name", a.get("agent_id", "?")) for a in agents[:3])
        raise HTTPException(
            status_code=409,
            detail=f"该题库被 {len(agents)} 个 Agent 设为默认题库({names}…),无法删除(请先改其默认题库)",
        )
    slots = [s for s in db.list_slots() if s.get("question_bank_id") == question_bank_id]
    if slots:
        raise HTTPException(
            status_code=409,
            detail=f"该题库仍被 {len(slots)} 个招聘时段引用,无法删除(请先处理这些时段)",
        )


@router.get("", response_model=list[QuestionBankOut])
def list_question_banks(
    request: Request, _: Principal = Depends(require_admin)
) -> list[dict]:
    return _db(request).list_question_banks()


@router.post("", response_model=QuestionBankOut, status_code=201)
def create_question_bank(
    body: QuestionBankIn, request: Request, _: Principal = Depends(require_admin)
) -> dict:
    bank = body.model_dump()
    bank.update({
        "question_bank_id": f"qb_{uuid.uuid4().hex[:12]}",
        "version": "v1",
        "status": "active",
        "created_at": datetime.now(UTC).isoformat(),  # 与 Agent 一致(审计 + 后续可按此排序)
    })
    return _db(request).put_question_bank(bank)


@router.get("/csv-template")
def download_csv_template(_: Principal = Depends(require_admin)) -> Response:
    """下载题库 CSV 模板(表头 + 一行示例)。text 必填,reference_answer/weight/difficulty
    可留空用默认(weight=1.0 / difficulty=3)。design contract:题目级 follow_up 已废弃,模板不含该列。"""
    return Response(
        content=_CSV_TEMPLATE,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="question-bank-template.csv"'},
    )


@router.post("/{question_bank_id}/upload-csv", response_model=QuestionBankUploadResult)
async def upload_csv(
    question_bank_id: str,
    request: Request,
    mode: str = Query("append", pattern="^(append|replace)$"),
    _: Principal = Depends(require_admin),
) -> dict:
    """批量上传题库 CSV(免逐题手加)。body = 原始 CSV 文本(UTF-8)。逐行校验:合法行入库、
    非法行跳过并返回错误明细。mode=append 追加到现有题目;mode=replace 整批替换题库题目。
    改版语义沿用 update_question_bank(当前版本入 version_history、version bump)。"""
    bank = _db(request).get_question_bank(question_bank_id)
    if bank is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    raw = await request.body()
    if len(raw) > _MAX_CSV_BYTES:
        raise HTTPException(status_code=413, detail="CSV 过大(上限 5MB)")
    try:
        content = raw.decode("utf-8-sig")  # -sig:容忍 Excel 导出的 UTF-8 BOM
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=422, detail="CSV 必须是 UTF-8 编码") from exc

    parsed, errors = parse_questions_csv(content)
    total_rows = len(parsed) + len(errors)
    new_questions = [q.model_dump() for q in parsed]
    existing = list(bank.get("questions", []))
    # 数据保护(review 必修):replace 模式下若**一题都没成功导入**(整份坏 CSV / 误传空文件 /
    #   列名全错 / 纯空行),直接替换会把题库**清空成 0 题**(不可逆数据丢失)。replace 成 0 题几乎总是误操作
    #   (真要清空走编辑器删题),故一律拒绝、不写库,返回 422 + 错误明细。append 模式无此风险(追加 0 题 = 无操作)。
    if mode == "replace" and not new_questions:
        first = f"首个错误:第 {errors[0].line} 行 {errors[0].reason}" if errors else "CSV 无任何有效题目"
        raise HTTPException(
            status_code=422,
            detail=f"replace 模式未导入任何题目(会清空题库)→ 已拒绝。{first}",
        )
    merged = (existing + new_questions) if mode == "append" else new_questions

    # 沿用 PUT 的改版语义:整份 QuestionBankIn 写回(当前版本入 history、bump version)。
    # 保留题库元数据(name/labels/difficulty 等),仅换 questions。
    body = {k: v for k, v in bank.items() if k in QuestionBankIn.model_fields}
    body["questions"] = merged
    updated = _db(request).update_question_bank(question_bank_id, body)
    if updated is None:  # 并发删除兜底
        raise HTTPException(status_code=404, detail="题库不存在")
    return {
        "question_bank_id": question_bank_id,
        "mode": mode,
        "total_rows": total_rows,
        "imported": len(new_questions),
        "rejected": len(errors),
        "total_questions": len(merged),
        "errors": [e.model_dump() for e in errors],
    }


@router.get("/{question_bank_id}", response_model=QuestionBankOut)
def get_question_bank(
    question_bank_id: str, request: Request, _: Principal = Depends(require_admin)
) -> dict:
    bank = _db(request).get_question_bank(question_bank_id)
    if bank is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    return bank


@router.put("/{question_bank_id}", response_model=QuestionBankOut)
def update_question_bank(
    question_bank_id: str, body: QuestionBankIn, request: Request, _: Principal = Depends(require_admin)
) -> dict:
    """改版不覆盖历史(design contract):当前版本入 version_history、version bump。"""
    updated = _db(request).update_question_bank(question_bank_id, body.model_dump())
    if updated is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    return updated


@router.get("/{question_bank_id}/versions", response_model=QuestionBankVersionsOut)
def get_question_bank_versions(
    question_bank_id: str, request: Request, _: Principal = Depends(require_admin)
) -> dict:
    bank = _db(request).get_question_bank(question_bank_id)
    if bank is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    history = list(bank.get("version_history", []))
    current = {k: v for k, v in bank.items() if k != "version_history"}
    versions = [*history, current]
    return {
        "question_bank_id": question_bank_id,
        "current_version": bank.get("version", "v1"),
        "versions": versions,
    }


@router.delete("/{question_bank_id}", status_code=204)
def delete_question_bank(
    question_bank_id: str, request: Request, _: Principal = Depends(require_admin)
) -> Response:
    """删除题库(design contract,仅 admin)。引用完整性检查(409):

    被以下任一引用时挡删 —— ① 活动会话(question_bank_id 字段);② 任何时段池 Slot;
    ③ 任何 Agent 的 default_question_bank_id(否则留悬挂默认)。
    已固化 resolved_questions 的(终态/历史)会话不算引用(快照独立)。
    """
    db = _db(request)
    if db.get_question_bank(question_bank_id) is None:
        raise HTTPException(status_code=404, detail="题库不存在")
    assert_qb_deletable(db, question_bank_id)  # 活动会话 / Agent 默认 / 时段 Slot 引用 → 409(与机器端点共用)
    db.delete_question_bank(question_bank_id)
    return Response(status_code=204)
