"""候选人对外自助编排(design contract,v2 缩水版)。

对外候选人凭一次性签名链接选面试时段(HR 预建时段池 = 纯时间窗,无电话/会议字段);
改/取消有窗口锁;候选人侧只见流程状态,不见评分/转写/录音。

复用 MVP:Session 状态机/实时会话服务/评估不变;origin=candidate 区别 hr/staff。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from . import state_machine as sm
from .candidate_token import issue_token, verify_token
from .db import Db
from .session_service import (
    PerQuestionCheckRequiresQuestions,
    assert_resolvable,
    build_session_record,
)


def _now() -> datetime:
    return datetime.now(UTC)


# 知情同意文案版本(合规举证:同意落库时记此版本;文案改动即升版,可追溯候选人当时同意的是哪版)。
# 当前版本含"AI 录音 + 作答内容传输至境外(美东)AI 处理"跨境条款。文案改动务必同步升版。
CONSENT_VERSION = "v1.cross-border"


class CandidateService:
    def __init__(self, db: Db, *, token_secret: str | None, edit_lock_min: int = 30):
        self.db = db
        self.token_secret = token_secret
        self.edit_lock_min = edit_lock_min

    def _require_secret(self) -> str:
        if not self.token_secret:
            # fail-closed:密钥未配置则候选人功能整体不可用(不静默放行,守 D9 精神)
            raise PermissionError("候选人 token 密钥未配置")
        return self.token_secret

    # ── HR 侧:时段池 + 签发链接 ──
    def add_slot(self, body: dict, *, bank_explicit: bool = False) -> dict:
        slot = {
            "slot_id": f"slot_{uuid.uuid4().hex[:12]}",
            "engagement_id": body["engagement_id"],
            "agent_id": body["agent_id"],  # design contract:面试 Agent(人设/rubric/引擎/出题策略)
            "meeting_start": body["meeting_start"],
            "meeting_end": body["meeting_end"],
            "status": "open",
            "created_at": _now().isoformat(),
        }
        # 题库绑定(design contract):指定了具体题库则记下。bank_explicit 区分「HR 显式选无题库」与「省略」:
        #   显式无题(explicit 且无 id)→ 记 question_bank_explicit_none,book 时不回退 Agent 默认;
        #   省略 → book 时回退 Agent 默认(与 sessions 一致)。
        if body.get("question_bank_id"):
            slot["question_bank_id"] = body["question_bank_id"]
        elif bank_explicit:
            slot["question_bank_explicit_none"] = True
        return self.db.put_slot(slot)

    def issue_link(self, body: dict) -> dict:
        secret = self._require_secret()
        exp = int((_now() + timedelta(hours=int(body.get("ttl_hours", 168)))).timestamp())
        token = issue_token(
            candidate_id=body["candidate_id"],
            engagement_id=body["engagement_id"],
            exp_epoch=exp,
            jti=uuid.uuid4().hex,
            secret=secret,
        )
        return {
            "token": token,
            "candidate_id": body["candidate_id"],
            "engagement_id": body["engagement_id"],
            "exp_epoch": exp,
        }

    # ── 候选人侧(token 鉴权) ──
    def verify(self, token: str) -> dict:
        """验签 + 有效期(fail-closed)。返回 payload {cid, eid, exp, jti}。"""
        secret = self._require_secret()
        return verify_token(token, secret=secret, now_epoch=int(_now().timestamp()))

    def list_open_slots(self, engagement_id: str) -> list[dict]:
        """候选人可选时段(脱敏:只给 slot_id + 起止,不暴露运营侧信息)。"""
        slots = self.db.list_slots_by_engagement(engagement_id, open_only=True)
        slots.sort(key=lambda s: s.get("meeting_start", ""))
        return [
            {"slot_id": s["slot_id"], "meeting_start": s.get("meeting_start"),
             "meeting_end": s.get("meeting_end")}
            for s in slots
        ]

    def book(self, payload: dict, slot_id: str, *, consent: bool) -> dict:
        """候选人选时段(design contract):知情同意 → 认领时段(防双占)→ 建 Target(candidate)+ Session(origin=candidate)。

        返回 {slot_id, session_id, meeting_start, meeting_end}。失败抛 ValueError(同意缺失/时段已占/环节不符)。
        """
        candidate_id = payload["cid"]
        engagement_id = payload["eid"]
        if not consent:
            raise ValueError("需勾选 AI 录音知情同意方可预约")
        slot = self.db.get_slot(slot_id)
        if slot is None:
            raise ValueError("时段不存在")
        if slot.get("engagement_id") != engagement_id:
            raise ValueError("时段不属于本招聘环节")
        if slot.get("status") != "open":
            raise ValueError("该时段已被预约,请选其他时段")

        agent = self.db.get_agent(slot["agent_id"])
        if agent is None:
            raise ValueError("环节绑定的 Agent 不存在")
        # 题库(design contract):时段显式绑定的 question_bank_id 优先;HR 显式选「无题库」则不回退 Agent 默认;
        # 否则(省略)回退 Agent.default_question_bank_id。不存在则纯人设对话。
        if slot.get("question_bank_id"):
            bank_id = slot["question_bank_id"]
        elif slot.get("question_bank_explicit_none"):
            bank_id = None
        else:
            bank_id = agent.get("default_question_bank_id")
        bank = self.db.get_question_bank(bank_id) if bank_id else None

        # 候选人对象:按 candidate_id(email/外部ID)upsert,source=candidate
        target = self.db.upsert_target_by_external_id(
            candidate_id, {"source": "candidate", "name": payload.get("name", candidate_id)}
        )
        session = build_session_record(
            agent=agent,
            bank=bank,
            booked_by=candidate_id,  # 候选人标识(用于「我的状态」查询归属)
            origin="candidate",
            target_id=target["target_id"],
            status=sm.SCHEDULED,  # 等候选人到点连入(connected 事件推进)
        )
        session["engagement_id"] = engagement_id
        session["slot_id"] = slot_id
        # 候选人 slot 预约保留时段窗(Q7:slot 池是「先约后到」的真实招聘场景,session 仍即时可连,
        # 但过期判定用 slot 的 meeting_end 而非 created_at+N —— 见 scheduler 对 candidate origin 的处理)。
        session["meeting_start"] = slot["meeting_start"]
        session["meeting_end"] = slot["meeting_end"]
        # 知情同意落库(合规:PIPL 需可举证"何时、就何种文案取得同意")。录音 + 作答内容跨境处理属敏感,
        # 记同意时间戳 + 文案版本 + 是否含跨境条款,供审计与举证。CONSENT_VERSION 见文件头常量。
        session["consent"] = {
            "granted": True,
            "at": _now().isoformat(),
            "version": CONSENT_VERSION,
            "includes_cross_border": True,  # 当前同意文案含"作答内容传输至境外 AI 处理"条款
        }
        # per_question_check Agent 无题 fail-fast(design contract):HR 配错(逐题判定却无题库)时,
        # 认领前就拦下,不让候选人进一场必然无法判定的面试(review)。
        try:
            assert_resolvable(agent, session.get("resolved_questions", []))
        except PerQuestionCheckRequiresQuestions as exc:
            raise ValueError("该面试环节配置异常(逐题判定但无题库),请联系 HR") from exc
        # 原子认领(防双占):先认领成功再落 Session,避免两候选人抢同一时段。
        if not self.db.claim_slot(slot_id, candidate_id, session["session_id"]):
            raise ValueError("该时段刚被预约,请选其他时段")
        # 补偿回滚(design contract review):claim 成功后若 put_session/meta 失败(网络/DDB throttle),
        # slot 会被永久锁死且指向不存在的 session。捕获异常 → release_slot 回滚 → 再上抛(无 DDB 事务)。
        try:
            self.db.put_session(session)
            self.db.put_session_meta(session["session_id"], {
                "status": sm.SCHEDULED,
                "agent_id": slot["agent_id"],
                "agent_version": agent.get("version", "v1"),
                "rubric": agent.get("rubric", {}),
                "questions": session.get("resolved_questions", []),
                "meeting_end": session["meeting_end"],
            })
        except Exception:
            self.db.release_slot(slot_id)  # 回滚认领,时段回池
            raise
        return {
            "slot_id": slot_id,
            "session_id": session["session_id"],
            "meeting_start": session["meeting_start"],
            "meeting_end": session["meeting_end"],
        }

    def _find_booking(self, candidate_id: str, engagement_id: str) -> dict | None:
        """找候选人在某环节已认领的会话(用 BookedByIndex)。"""
        for s in self.db.list_sessions(owner=candidate_id):
            if s.get("engagement_id") == engagement_id and s.get("origin") == "candidate":
                if s.get("status") not in (sm.FAILED,):  # 已取消(failed)的不算当前预约
                    return s
        return None

    def my_status(self, payload: dict) -> dict:
        """候选人侧状态(design contract 结果隔离:只见流程态,不见评分/转写/录音)。"""
        candidate_id, engagement_id = payload["cid"], payload["eid"]
        booking = self._find_booking(candidate_id, engagement_id)
        if booking is None:
            return {"engagement_id": engagement_id, "booked": False, "stage": "not_booked"}
        status = booking.get("status")
        stage = {
            sm.SCHEDULED: "booked",
            sm.IN_PROGRESS: "in_progress", sm.COMPLETED: "finished",
        }.get(status, "booked")
        return {
            "engagement_id": engagement_id,
            "booked": True,
            "slot_id": booking.get("slot_id"),
            "meeting_start": booking.get("meeting_start"),
            "meeting_end": booking.get("meeting_end"),
            "stage": stage,
        }

    def find_joinable_session(self, payload: dict) -> dict:
        """候选人连入实时对话(design contract-C 收口):定位其在本环节已预约、可连入的 session。

        归属由 token payload(cid/eid)权威决定 —— 候选人只能连自己预约的会话(不信任何入参)。
        返回 session dict(含 session_id/status/meeting_start/end),窗口校验与签 token 由路由层复用
        admin join 同一逻辑(join_gate)。无预约 / 终态 → ValueError(路由转 409)。
        """
        candidate_id, engagement_id = payload["cid"], payload["eid"]
        booking = self._find_booking(candidate_id, engagement_id)
        if booking is None:
            raise ValueError("尚未预约面试时段,无法连入")
        if booking.get("status") not in (sm.SCHEDULED, sm.IN_PROGRESS):
            raise ValueError("面试已结束,无法连入")
        return booking

    def reschedule(self, payload: dict, new_slot_id: str) -> dict:
        """候选人改约到另一空闲时段(design contract「改选其他空闲时段」):窗口锁 → 原子(先认领新、再释放旧)。

        顺序关键:先认领新时段(claim_slot 条件写,失败=被抢则整体放弃,旧预约不动),成功后再释放旧时段
        + 更新 Session,避免「先释放旧→认领新失败→两头落空」的空窗竞态。
        """
        booking = self._find_booking(payload["cid"], payload["eid"])
        if booking is None:
            raise ValueError("没有可改约的预约")
        if booking.get("status") != sm.SCHEDULED:
            raise ValueError("仅待发起的预约可改约")
        if not sm.staff_can_edit(now=_now(), meeting_start=booking["meeting_start"],
                                 lock_minutes=self.edit_lock_min):
            raise ValueError(f"开始前 {self.edit_lock_min} 分钟内不可改,请联系 HR")
        if new_slot_id == booking.get("slot_id"):
            raise ValueError("新时段与当前相同")
        new_slot = self.db.get_slot(new_slot_id)
        if new_slot is None or new_slot.get("engagement_id") != payload["eid"]:
            raise ValueError("新时段不属于本招聘环节")
        if new_slot.get("status") != "open":
            raise ValueError("新时段已被预约,请选其他时段")
        # 先认领新(原子防双占);失败则旧预约保持不变
        if not self.db.claim_slot(new_slot_id, payload["cid"], booking["session_id"]):
            raise ValueError("新时段刚被预约,请选其他时段")
        old_slot_id = booking.get("slot_id")
        booking.update({
            "slot_id": new_slot_id,
            "meeting_start": new_slot["meeting_start"],
            "meeting_end": new_slot["meeting_end"],
        })
        # 补偿回滚(design contract review):认领新时段成功后,若 put_session/meta 失败,
        # 新时段已 claimed 但 Session 仍指向旧时段 → 改约半成品 + 新时段泄漏。捕获 → 释放刚认领的新时段
        # (旧预约保持原状,候选人可重试)→ 再上抛。
        try:
            self.db.put_session(booking)
            self.db.set_session_meta_status(booking["session_id"], sm.SCHEDULED,
                                            {"meeting_end": booking["meeting_end"]})
        except Exception:
            self.db.release_slot(new_slot_id)  # 回滚新认领;旧时段未动,原预约仍有效
            raise
        if old_slot_id:
            self.db.release_slot(old_slot_id)  # 认领新成功后才释放旧,回池供他人
        return {"rescheduled": True, "new_slot_id": new_slot_id,
                "meeting_start": booking["meeting_start"], "meeting_end": booking["meeting_end"]}

    def cancel(self, payload: dict) -> dict:
        """候选人取消预约(design contract):距开始 >lock 才可取消;释放时段回池。"""
        booking = self._find_booking(payload["cid"], payload["eid"])
        if booking is None:
            raise ValueError("没有可取消的预约")
        if booking.get("status") != sm.SCHEDULED:
            raise ValueError("仅待发起的预约可取消")
        if not sm.staff_can_edit(now=_now(), meeting_start=booking["meeting_start"],
                                 lock_minutes=self.edit_lock_min):
            raise ValueError(f"开始前 {self.edit_lock_min} 分钟内不可取消,请联系 HR")
        # 复核 BLOCKER:**先释放时段、再标会话 failed**(无 DDB 事务)。若 put_session 失败,时段已回池
        # (候选人重试取消 → 命中「没有可取消的预约」,可接受);反之若先 put 后 release 失败 → 会话已取消但
        # 时段永久卡 claimed 泄漏。release_slot 幂等。
        if booking.get("slot_id"):
            self.db.release_slot(booking["slot_id"])  # 释放回池供他人选
        booking.update({"status": sm.FAILED, "fail_reason": "cancelled",
                        "ended_at": _now().isoformat()})
        self.db.put_session(booking)
        return {"cancelled": True}
