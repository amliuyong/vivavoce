"""DynamoDB 访问层 —— 薄封装 boto3 resource。

设计:可注入 endpoint_url(本地 dynamodb-local / moto 测试),生产用真实 AWS。
仅暴露当前 API 用到的最小操作;表结构见 HLD §5 / §6(agent_id / target_id / session_id 主键,
SessionEvents 单表两类行 PK=session_id SK=meta|event#<ts>)。
"""
from __future__ import annotations

import math
import time
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

from .config import Settings

# 转写明细按审计期过期回收(对齐 CDK timeToLiveAttribute='expires_at' / constants AUDIT_TTL_DAYS=365)。
# meta 行不写 expires_at(不过期,保留会话档案)。
_TRANSCRIPT_TTL_SECONDS = 365 * 24 * 3600

# 预置「自由对话」Agent 的固定 id(DefaultAgentsSeed / 前端 VoiceChat 亦硬编码同值)。
# list_agents 把它稳定置顶,让它在 #/agents 与 VoiceChat 选择器里恒为第一项(DDB scan 本身无序)。
_DEFAULT_FREECHAT_AGENT_ID = "agent_freechat_default"


def _created_at_key(created_at: Any) -> datetime:
    """把 created_at 解析成可比较的 datetime,供排序用。**对格式免疫**:

    生产写 `+00:00` 后缀(datetime.now(UTC).isoformat()),但遗留/外部导入数据可能是 `Z` 后缀或无时区——
    直接对原始字符串做字典序会错(ASCII 'Z'(90) > '+'(43),同刻不同格式乱序)。故用 fromisoformat 归一化
    (Py3.11+ 同时认 `Z` 与 `+00:00`);解析失败/缺失 → datetime.min(排最后)。naive/aware 混排:统一剥时区
    按 wall-clock 比较(足够用于"最新在前"的展示排序,不追求跨时区精确)。
    """
    if not isinstance(created_at, str) or not created_at:
        return datetime.min
    try:
        dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min
    return dt.replace(tzinfo=None)


class ConfigVersionConflict(Exception):
    """SystemConfig 乐观锁冲突(并发 admin 写 / 首次创建已存在,design contract)→ 路由层转 409。"""


def _to_ddb(value: Any) -> Any:
    """递归把 float 转 Decimal(DynamoDB 不接受 float),其余原样。

    用 str(value) 构造 Decimal,避免二进制浮点尾差(如 0.4 → 0.4 而非 0.40000…)。
    拒绝非有限值(inf/nan):DynamoDB 不接受,且多为 fuzzing/异常输入,早失败给清晰错误。
    """
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"非法浮点值(inf/nan 不被支持): {value}")
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_ddb(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_ddb(v) for v in value]
    return value


def _from_ddb(value: Any) -> Any:
    """递归把 DynamoDB 读出的 Decimal 转回原生 int/float(整数→int,否则 float)。

    DDB 数字一律存 Decimal;无 response_model 的端点直接返回会被序列化成字符串(如 Decimal('3')→"3")。
    用于 SystemConfig 等裸 dict 返回的读路径,使前端拿到的是 JSON number。
    """
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _from_ddb(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_from_ddb(v) for v in value]
    return value


def _next_version(version: str) -> str:
    """版本号 vN → v(N+1);非法输入兜底为 v2。"""
    try:
        return f"v{int(version.lstrip('v')) + 1}"
    except (ValueError, AttributeError):
        return "v2"


# 版本历史保留上限(Agent / QuestionBank 共用)。每次改版把当前完整快照(含全量 questions)压入
# version_history;无界累积 → 大题库多次改版(尤其 CSV 批量上传)会撑爆 DDB 单 item 400KB 上限
# (review 必修)。保留最近 N 版滚动淘汰最旧:够回溯近期改动,又封顶 item 体积。version 号本身仍单调递增。
_MAX_VERSION_HISTORY = 20


def _bounded_history(history: list) -> list:
    """把版本历史裁到最近 _MAX_VERSION_HISTORY 版(含即将追加的当前版前留 N-1 席)。"""
    if len(history) <= _MAX_VERSION_HISTORY:
        return history
    return history[-_MAX_VERSION_HISTORY:]


class Db:
    def __init__(self, settings: Settings, resource: Any | None = None):
        self.settings = settings
        # 懒加载:不在构造/import 时连 boto3(否则无 AWS 配置的环境一 import 就崩)。
        # 注入的 resource(测试/本地 moto)直接用;否则首次访问表时才建真实 resource。
        self._ddb = resource

    def _resource(self):
        if self._ddb is None:
            kwargs: dict[str, Any] = {"region_name": self.settings.region}
            if self.settings.dynamodb_endpoint_url:
                kwargs["endpoint_url"] = self.settings.dynamodb_endpoint_url
            self._ddb = boto3.resource("dynamodb", **kwargs)
        return self._ddb

    def _table(self, name: str):
        return self._resource().Table(name)

    @staticmethod
    def _scan_all(table) -> list[dict]:
        """全量 scan,跟随 LastEvaluatedKey 翻页 —— 否则单页上限会静默丢数据(#6)。

        注:MVP 数据量小、单页够;但翻页保证正确性。v1 放量前改 query 走 GSI(见上注)。
        """
        items: list[dict] = []
        kwargs: dict[str, Any] = {}
        while True:
            resp = table.scan(**kwargs)
            items.extend(resp.get("Items", []))
            lek = resp.get("LastEvaluatedKey")
            if not lek:
                break
            kwargs["ExclusiveStartKey"] = lek
        return items

    # 注:list_* 用 scan + 内存过滤,MVP 数据量可用。v1 放量前 MUST 改 query 走 GSI
    # (Sessions 有 TriggerIndex、Targets 有 ExternalIdIndex),避免线性退化吃 RCU。
    # ── Agents(design contract,原 KnowledgeProfiles;PK=agent_id)──
    def list_agents(self, self_bookable_only: bool = False) -> list[dict]:
        items = self._scan_all(self._table(self.settings.agents_table))
        if self_bookable_only:
            items = [a for a in items if a.get("self_bookable") is True]
        # 排序(scan 无序,须显式排否则列表漂移;参照 list_sessions)。叠加**稳定** sort,最后一次优先级最高:
        #  ① 次级 agent_id 升序 —— 兜底确定性(created_at 相同/都缺失时顺序仍固定,不随 scan 漂移);
        #  ② created_at 倒序(最新在前)—— 用 _created_at_key 归一化(对 Z/+00:00/无时区格式免疫,
        #     解析失败/缺失回退 datetime.min → 排最后,如 admin Web 早期建的无此字段的老 Agent);
        #  ③ 「自由对话」预置 Agent 置顶(压过前两级)。
        items.sort(key=lambda a: a.get("agent_id") or "")
        items.sort(key=lambda a: _created_at_key(a.get("created_at")), reverse=True)
        items.sort(key=lambda a: a.get("agent_id") != _DEFAULT_FREECHAT_AGENT_ID)
        return items

    def get_agent(self, agent_id: str) -> dict | None:
        return self._table(self.settings.agents_table).get_item(
            Key={"agent_id": agent_id}
        ).get("Item")

    def put_agent(self, agent: dict) -> dict:
        self._table(self.settings.agents_table).put_item(Item=_to_ddb(agent))
        return agent

    def update_agent(self, agent_id: str, new_fields: dict) -> dict | None:
        """改版不覆盖历史(design contract):把当前版本压入 version_history、bump version 后写回。

        version_history 里只存「精简快照」(剥离嵌套 history,避免指数膨胀)。返回新 agent;
        agent 不存在返回 None。
        """
        current = self.get_agent(agent_id)
        if current is None:
            return None
        history = list(current.get("version_history", []))
        snapshot = {k: v for k, v in current.items() if k != "version_history"}
        history.append(snapshot)
        history = _bounded_history(history)  # 封顶,防 DDB 400KB 撑爆(review)
        new_version = _next_version(current.get("version", "v1"))
        updated = {
            **snapshot,  # 保留 agent_id/status 等
            **new_fields,  # 覆盖可改字段(name/system_prompt/rubric/question_strategy/engine/...)
            "agent_id": agent_id,
            "version": new_version,
            "version_history": history,
        }
        self._table(self.settings.agents_table).put_item(Item=_to_ddb(updated))
        return updated

    def delete_agent(self, agent_id: str) -> None:
        """删除 Agent(连同版本历史)。幂等:不存在也不报错。

        注:历史 Session 已快照 agent_id@version(design contract 版本快照),删 Agent 不影响
        既有报告依据;但删除前路由层会校验「无活动会话仍引用」(在 routers/agents.py)。
        """
        self._table(self.settings.agents_table).delete_item(
            Key={"agent_id": agent_id}
        )

    # ── QuestionBanks(design contract,可复用题库;PK=question_bank_id)──
    def list_question_banks(self) -> list[dict]:
        return self._scan_all(self._table(self.settings.question_banks_table))

    def get_question_bank(self, question_bank_id: str) -> dict | None:
        return self._table(self.settings.question_banks_table).get_item(
            Key={"question_bank_id": question_bank_id}
        ).get("Item")

    def put_question_bank(self, bank: dict) -> dict:
        self._table(self.settings.question_banks_table).put_item(Item=_to_ddb(bank))
        return bank

    def update_question_bank(self, question_bank_id: str, new_fields: dict) -> dict | None:
        """改版不覆盖历史(design contract,同 Agent 机制):当前版本压入 version_history、bump version。"""
        current = self.get_question_bank(question_bank_id)
        if current is None:
            return None
        history = list(current.get("version_history", []))
        snapshot = {k: v for k, v in current.items() if k != "version_history"}
        history.append(snapshot)
        history = _bounded_history(history)  # 封顶,防 CSV 批量上传多次改版撑爆 DDB 400KB(review)
        new_version = _next_version(current.get("version", "v1"))
        updated = {
            **snapshot,
            **new_fields,  # 覆盖可改字段(name/labels/questions)
            "question_bank_id": question_bank_id,
            "version": new_version,
            "version_history": history,
        }
        self._table(self.settings.question_banks_table).put_item(Item=_to_ddb(updated))
        return updated

    def delete_question_bank(self, question_bank_id: str) -> None:
        """删除题库(连同版本历史)。幂等。删除前路由层校验引用完整性(routers/questionbanks.py)。"""
        self._table(self.settings.question_banks_table).delete_item(
            Key={"question_bank_id": question_bank_id}
        )

    # ── Targets ──
    # 注:list/delete_target CRUD 方法随 /api/targets 端点删除(design contract,死代码);
    # 发起会话仍写对象记录,故保留 put_target + upsert_target_by_external_id;
    # get_target 复活(仅按 PK 读单条)供会话详情把 target_id 解析成可读名字(不重开 CRUD 端点)。
    def put_target(self, target: dict) -> dict:
        """建/改对象(必含 PK target_id)。发起路径(sessions/candidate/mcp)upsert 时的底层写。"""
        self._table(self.settings.targets_table).put_item(Item=_to_ddb(target))
        return target

    def get_target(self, target_id: str) -> dict | None:
        """按 PK 读单条对象(会话详情「对象」列解析可读名字用)。不存在 → None。"""
        return self._table(self.settings.targets_table).get_item(
            Key={"target_id": target_id}
        ).get("Item")

    def upsert_target_by_external_id(self, external_id: str, attrs: dict) -> dict:
        """按 external_id(登录 email/手机)去重 upsert 一条 Target。

        表 PK = target_id,external_id 是 GSI(ExternalIdIndex)——所以:
        先查 GSI 看该 external_id 是否已有 Target,有则复用其 target_id(同一人多次预约
        关联同一对象),无则生成新 target_id。写入 Item 必含 PK=target_id,否则 DDB 抛
        ValidationException(这正是之前测试 schema 漂移掩盖的生产 bug)。

        并发注意:GSI 最终一致 + 无唯一约束 → 同一 external_id 的并发自助预约理论上可能
        各自查不到对方而建出重复 Target。MVP 媒体面单实例、自助并发极低,可接受;若 external_id
        要做硬唯一,v1 改为以 external_id 为键的 transactional sentinel item(条件写)。
        """
        table = self._table(self.settings.targets_table)
        existing = table.query(
            IndexName="ExternalIdIndex",
            KeyConditionExpression=Key("external_id").eq(external_id),
            Limit=1,
        ).get("Items", [])
        # 增量合并(design contract review):已存在则在既有字段基底上覆盖传入字段,**保留** admin 后补的
        # dept/tags/note/attrs —— 此前全量替换会让 staff 再次预约时把这些运营维护资料清空。
        base = dict(existing[0]) if existing else {}
        target_id = base.get("target_id") or f"tgt_{uuid.uuid4().hex[:12]}"
        item = {**base, **attrs, "target_id": target_id, "external_id": external_id}
        # source = 首创者(复核 HIGH):已存在则保留既有 source(self/admin),不被本次调用覆盖
        #(staff 再预约不把 admin 录入对象改回 self;admin 再 create 同 email 也不把 self 改成 admin)。
        if base.get("source"):
            item["source"] = base["source"]
        table.put_item(Item=_to_ddb(item))
        return item

    # ── Integration(API client / Webhook / 幂等键,design contract;单表 PK=pk SK=sk 三类行) ──
    #   client:   pk=client#<id>           sk=meta
    #   webhook:  pk=client#<id>           sk=webhook#<wid>
    #   idemp:    pk=idemp#<client>#<key>  sk=meta(带 TTL expires_at)
    def put_api_client(self, client: dict) -> dict:
        item = {"pk": f"client#{client['client_id']}", "sk": "meta", **client}
        self._table(self.settings.integration_table).put_item(Item=_to_ddb(item))
        return client

    def get_api_client(self, client_id: str) -> dict | None:
        return self._table(self.settings.integration_table).get_item(
            Key={"pk": f"client#{client_id}", "sk": "meta"}
        ).get("Item")

    def delete_api_client(self, client_id: str) -> None:
        self._table(self.settings.integration_table).delete_item(
            Key={"pk": f"client#{client_id}", "sk": "meta"}
        )

    def list_api_clients(self) -> list[dict]:
        """列全部 API client(admin 管理用)。MVP scan(集成 client 数量极少)。"""
        items = self._scan_all(self._table(self.settings.integration_table))
        return [i for i in items if i.get("sk") == "meta" and str(i.get("pk", "")).startswith("client#")]

    def put_webhook(self, client_id: str, webhook: dict) -> dict:
        item = {"pk": f"client#{client_id}", "sk": f"webhook#{webhook['webhook_id']}", **webhook}
        self._table(self.settings.integration_table).put_item(Item=_to_ddb(item))
        return webhook

    def list_webhooks(self, client_id: str) -> list[dict]:
        resp = self._table(self.settings.integration_table).query(
            KeyConditionExpression=Key("pk").eq(f"client#{client_id}") & Key("sk").begins_with("webhook#"),
        )
        return resp.get("Items", [])

    def delete_webhook(self, client_id: str, webhook_id: str) -> None:
        self._table(self.settings.integration_table).delete_item(
            Key={"pk": f"client#{client_id}", "sk": f"webhook#{webhook_id}"}
        )

    def list_all_webhooks(self) -> list[dict]:
        """列全系统 webhook(事件投递时按订阅事件匹配)。MVP scan。"""
        items = self._scan_all(self._table(self.settings.integration_table))
        return [i for i in items if str(i.get("sk", "")).startswith("webhook#")]

    def claim_idempotency(self, client_id: str, key: str, ttl_seconds: int = 86400) -> dict:
        """抢占幂等键:条件写占位(仅当不存在)。返回 {"first": bool, "result": <已存结果或 None>}。

        first=True:本次抢到,调用方应 compute 后用 save_idempotency 覆盖写真实结果。
        first=False:已被占,返回已存 result(可能仍是占位 None,极短竞态窗内;调用方可短暂重试或直接返回)。
        并发同键只一个 first=True(条件写原子)。
        """
        from botocore.exceptions import ClientError

        pk = f"idemp#{client_id}#{key}"
        item = {"pk": pk, "sk": "meta", "result": None, "expires_at": int(time.time()) + ttl_seconds}
        try:
            self._table(self.settings.integration_table).put_item(
                Item=_to_ddb(item), ConditionExpression="attribute_not_exists(pk)",
            )
            return {"first": True, "result": None}
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                existing = self._table(self.settings.integration_table).get_item(
                    Key={"pk": pk, "sk": "meta"}
                ).get("Item")
                return {"first": False, "result": (existing or {}).get("result")}
            raise

    def save_idempotency(self, client_id: str, key: str, result: dict, ttl_seconds: int = 86400) -> None:
        """覆盖写幂等键的真实结果(占位 → 结果)。无条件 put(覆盖占位)。"""
        pk = f"idemp#{client_id}#{key}"
        self._table(self.settings.integration_table).put_item(
            Item=_to_ddb({"pk": pk, "sk": "meta", "result": result,
                          "expires_at": int(time.time()) + ttl_seconds})
        )

    def delete_idempotency(self, client_id: str, key: str) -> None:
        """删幂等占位(compute 失败时清理,避免占位 None 永留死锁后续同 key 请求)。"""
        self._table(self.settings.integration_table).delete_item(
            Key={"pk": f"idemp#{client_id}#{key}", "sk": "meta"}
        )

    # ── SlotPools(候选人自助时段池,design contract) ──
    def put_slot(self, slot: dict) -> dict:
        self._table(self.settings.slot_pools_table).put_item(Item=_to_ddb(slot))
        return slot

    def get_slot(self, slot_id: str) -> dict | None:
        return self._table(self.settings.slot_pools_table).get_item(
            Key={"slot_id": slot_id}
        ).get("Item")

    def list_slots(self) -> list[dict]:
        """列全部时段(design contract 题库删除引用检查用)。MVP scan(时段量小)。"""
        return self._scan_all(self._table(self.settings.slot_pools_table))

    def list_slots_by_engagement(self, engagement_id: str, open_only: bool = False) -> list[dict]:
        """列某环节的时段(走 EngagementIndex GSI,按 meeting_start 升序)。open_only=只列未认领。"""
        resp = self._table(self.settings.slot_pools_table).query(
            IndexName="EngagementIndex",
            KeyConditionExpression=Key("engagement_id").eq(engagement_id),
        )
        items = resp.get("Items", [])
        if open_only:
            items = [s for s in items if s.get("status", "open") == "open"]
        return items

    def claim_slot(self, slot_id: str, candidate_id: str, session_id: str) -> bool:
        """原子认领时段(防双占,design contract):条件写 —— 仅当 status=open(或字段不存在)才置 claimed。

        返回 True=认领成功;False=已被占(ConditionalCheckFailedException)。用 DynamoDB 条件表达式
        保证并发下只有一个候选人能认领同一时段(非 scan-then-write 的竞态)。
        """
        from botocore.exceptions import ClientError

        try:
            self._table(self.settings.slot_pools_table).update_item(
                Key={"slot_id": slot_id},
                UpdateExpression="SET #s = :claimed, claimed_by = :cb, session_id = :sid",
                ConditionExpression="attribute_not_exists(#s) OR #s = :open",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":claimed": "claimed", ":open": "open",
                    ":cb": candidate_id, ":sid": session_id,
                },
            )
            return True
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return False
            raise

    def release_slot(self, slot_id: str) -> None:
        """取消预约时释放时段回池(design contract):置回 open,清认领信息。"""
        from botocore.exceptions import ClientError

        try:
            self._table(self.settings.slot_pools_table).update_item(
                Key={"slot_id": slot_id},
                UpdateExpression="SET #s = :open REMOVE claimed_by, session_id",
                ConditionExpression="attribute_exists(slot_id)",
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":open": "open"},
            )
        except ClientError:
            pass  # 时段不存在 = 幂等无操作

    # ── Sessions ──
    def list_sessions(self, owner: str | None = None, trigger: str | None = None,
                      exclude_origin: str | None = None) -> list[dict]:
        """列会话。owner=按 booked_by 过滤(staff 看自己);trigger=按触发来源过滤;
        exclude_origin=排除某来源(如 candidate)。

        design contract:候选人会话(origin=candidate)走专门的招聘环节管理,不混入常规单场列表。
        trigger 过滤保留(读侧容忍历史 campaign 数据,不展示)。MVP scan;v1 走 GSI。
        """
        items = self._scan_all(self._table(self.settings.sessions_table))
        if owner is not None:
            items = [s for s in items if s.get("booked_by") == owner]
        if trigger is not None:
            items = [s for s in items if s.get("trigger") == trigger]
        if exclude_origin is not None:
            items = [s for s in items if s.get("origin") != exclude_origin]
        # 按创建时间倒序(最新在前):DynamoDB scan 顺序不定,否则列表乱序、新建的会议难找(用户反馈)。
        items.sort(key=lambda s: s.get("created_at") or "", reverse=True)
        return items

    def get_session(self, session_id: str, *, consistent: bool = False) -> dict | None:
        """按主键取会话。consistent=True 走强一致读(主表 PK 支持;用于读后即判的临界路径)。"""
        kwargs = {"Key": {"session_id": session_id}}
        if consistent:
            kwargs["ConsistentRead"] = True
        return self._table(self.settings.sessions_table).get_item(**kwargs).get("Item")

    def put_session(self, session: dict) -> dict:
        self._table(self.settings.sessions_table).put_item(Item=_to_ddb(session))
        return session

    def count_active_sessions(self, exclude_session_id: str | None = None) -> int:
        """全局并发闸门用:统计处于进行中(in_progress)的会话数(design contract 缩水版)。

        exclude_session_id:排除本场自身(不把自己算进占用名额)。MVP scan + 内存过滤;
        v1 放量前走 StatusIndex GSI 强一致计数。
        """
        return sum(
            1
            for s in self.list_sessions()
            if s.get("status") == "in_progress" and s.get("session_id") != exclude_session_id
        )

    # ── SessionEvents(PK=session_id, SK=meta|event#<ts>) ──
    # Evaluator 的单一数据源:meta 行冗余 rubric 快照(发起时写),event# 是逐句转写。
    # 这样 Evaluator 只 query 一张表即自包含(无 orphan、无跨表反查,符合 HLD 设计)。
    def put_session_meta(self, session_id: str, meta: dict) -> dict:
        """写/覆盖 SessionEvents 的 meta 行(SK=meta)。status 变化经此触发 Evaluator(Streams)。"""
        item = {"session_id": session_id, "sk": "meta", **meta}
        self._table(self.settings.session_events_table).put_item(Item=_to_ddb(item))
        return item

    def get_session_meta(self, session_id: str) -> dict | None:
        return self._table(self.settings.session_events_table).get_item(
            Key={"session_id": session_id, "sk": "meta"}
        ).get("Item")

    def set_session_meta_status(self, session_id: str, status: str, extra: dict | None = None) -> dict | None:
        """更新 meta 行的 status(+可选字段)。会话置 completed 时经此触发 Evaluator。"""
        meta = self.get_session_meta(session_id)
        if meta is None:
            return None
        meta = {**meta, "status": status, **(extra or {})}
        self._table(self.settings.session_events_table).put_item(Item=_to_ddb(meta))
        return meta

    def merge_session_meta(self, session_id: str, extra: dict) -> dict | None:
        """只合并 meta 附加字段,**不改 status**(review 留痕若读改写 status,
        与 connected 事件并发时会把 in_progress 回写成陈旧 scheduled)。UpdateItem 原子合并,
        条件 = meta 行已存在(不创建孤儿行);不存在返回 None。"""
        from botocore.exceptions import ClientError  # noqa: PLC0415

        table = self._table(self.settings.session_events_table)
        expr_names = {f"#k{i}": k for i, k in enumerate(extra)}
        expr_values = {f":v{i}": _to_ddb(v) for i, v in enumerate(extra.values())}
        set_expr = ", ".join(f"#k{i} = :v{i}" for i in range(len(extra)))
        try:
            resp = table.update_item(
                Key={"session_id": session_id, "sk": "meta"},
                UpdateExpression=f"SET {set_expr}",
                ExpressionAttributeNames=expr_names,
                ExpressionAttributeValues=expr_values,
                ConditionExpression="attribute_exists(session_id)",
                ReturnValues="ALL_NEW",
            )
            return resp.get("Attributes")
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                return None
            raise

    def put_transcript_event(self, session_id: str, ts: str, payload: dict) -> dict:
        """写一句转写(SK=event#<ts>)。媒体面/语音链路写;Evaluator 据此打分。

        写 expires_at(审计期后 DDB TTL 自动回收转写明细,review)—— 仅转写行过期,
        meta 行不写 expires_at(保留会话档案)。
        """
        item = {
            "session_id": session_id,
            "sk": f"event#{ts}",
            "ts": ts,
            "expires_at": int(time.time()) + _TRANSCRIPT_TTL_SECONDS,
            **payload,
        }
        self._table(self.settings.session_events_table).put_item(Item=_to_ddb(item))
        return item

    def list_transcript(self, session_id: str) -> list[dict]:
        resp = self._table(self.settings.session_events_table).query(
            KeyConditionExpression=Key("session_id").eq(session_id) & Key("sk").begins_with("event#"),
        )
        items = resp.get("Items", [])
        items.sort(key=lambda e: e.get("sk", ""))
        return items

    # ── Results(PK=session_id,与 Session 1:1) ──
    def get_result(self, session_id: str) -> dict | None:
        return self._table(self.settings.results_table).get_item(
            Key={"session_id": session_id}
        ).get("Item")

    def list_results(self) -> list[dict]:
        """全量 Results(总览按场景聚合通过率用)。MVP scan(与 list_sessions 同口径);v1 放量前走 GSI。
        无归属过滤——调用方(stats)按 Session 归属先筛出可见 session_id,再取交集(不信本方法做隔离)。"""
        return self._scan_all(self._table(self.settings.results_table))

    def put_result(self, result: dict) -> dict:
        self._table(self.settings.results_table).put_item(Item=_to_ddb(result))
        return result

    def update_result(self, session_id: str, patch: dict) -> dict | None:
        """复核改判等局部更新:读 → 合并 → 写回(双轨保留,AI 原始分不被覆盖,design contract)。"""
        current = self.get_result(session_id)
        if current is None:
            return None
        merged = {**current, **patch, "session_id": session_id}
        self._table(self.settings.results_table).put_item(Item=_to_ddb(merged))
        return merged

    # ── SystemConfig:GPU 容量(design contract)──
    # 两条不同主键的独立记录(非同主键多 attribute):
    #   config_key="gpu_capacity_config" —— admin 写期望(乐观锁 config_version)
    #   config_key="gpu_capacity_live"   —— reconciler 写实况
    # 各自 update_item 只改自己记录,零交叉(避免 put_item 全量写互相抹字段)。
    _CFG_KEY = "gpu_capacity_config"
    _LIVE_KEY = "gpu_capacity_live"

    def get_gpu_capacity_config(self) -> dict | None:
        item = self._table(self.settings.system_config_table).get_item(
            Key={"config_key": self._CFG_KEY}
        ).get("Item")
        return _from_ddb(item) if item is not None else None

    def put_gpu_capacity_config(self, config: dict, *, expected_version: int | None = None) -> dict:
        """写期望配置。乐观锁(并发 admin 防覆盖,design contract):
          - expected_version=None:首次创建,仅当记录不存在(否则视作冲突);
          - 给定:仅当当前 config_version 匹配才写。
        版本不匹配/已存在抛 ConfigVersionConflict(路由层转 409)。返回写入后的记录(version+1)。"""
        from botocore.exceptions import ClientError

        item = dict(config)
        item["config_key"] = self._CFG_KEY
        item["config_version"] = int(item.get("config_version", 0)) + 1
        table = self._table(self.settings.system_config_table)
        try:
            if expected_version is None:
                table.put_item(Item=_to_ddb(item),
                               ConditionExpression="attribute_not_exists(config_key)")
            else:
                table.put_item(
                    Item=_to_ddb(item),
                    ConditionExpression="config_version = :v",
                    ExpressionAttributeValues={":v": expected_version},
                )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
                raise ConfigVersionConflict("配置已被他人修改或已存在,请刷新重试") from exc
            raise
        return item

    def get_gpu_capacity_live(self, *, consistent: bool = True) -> dict | None:
        """读实况。默认强一致(design contract:reconciler/admin 刚写入即被闸门感知,不被 ≤1s 滞后绕过)。"""
        item = self._table(self.settings.system_config_table).get_item(
            Key={"config_key": self._LIVE_KEY}, ConsistentRead=consistent
        ).get("Item")
        return _from_ddb(item) if item is not None else None

    def update_gpu_capacity_live(self, fields: dict) -> dict:
        """reconciler 回写实况:update_item 只改自己的字段(不碰 config 记录)。

        **None 值 → REMOVE 该属性**(非存 None/""):如 scale_in_candidate_since=None 时删字段,
        而非落 ""(review:落 "" 永久存在、影响 attribute_exists 查询,且读侧若漏归一会回归 parse_iso 崩)。
        """
        if not fields:
            return {}
        set_fields = {k: v for k, v in fields.items() if v is not None}
        remove_fields = [k for k, v in fields.items() if v is None]
        names = {f"#{k}": k for k in fields}
        parts: list[str] = []
        kwargs: dict[str, Any] = {
            "Key": {"config_key": self._LIVE_KEY},
            "ExpressionAttributeNames": names,
        }
        if set_fields:
            parts.append("SET " + ", ".join(f"#{k} = :{k}" for k in set_fields))
            kwargs["ExpressionAttributeValues"] = {f":{k}": v for k, v in _to_ddb(set_fields).items()}
        if remove_fields:
            parts.append("REMOVE " + ", ".join(f"#{k}" for k in remove_fields))
        kwargs["UpdateExpression"] = " ".join(parts)
        self._table(self.settings.system_config_table).update_item(**kwargs)
        return self.get_gpu_capacity_live() or {}

    # lifecycle drain token(design contract):存 SystemConfig,config_key=lifecycle#<instance_id>。
    # lifecycle-handler 记 ASG TERMINATING hook 的 token,poll 时重查 drain 状态。
    _LIFECYCLE_PREFIX = "lifecycle#"

    def put_lifecycle_token(self, instance_id: str, token: str, recorded_at: str) -> None:
        self._table(self.settings.system_config_table).put_item(Item=_to_ddb({
            "config_key": f"{self._LIFECYCLE_PREFIX}{instance_id}",
            "instance_id": instance_id, "token": token, "recorded_at": recorded_at,
        }))

    def delete_lifecycle_token(self, instance_id: str) -> None:
        self._table(self.settings.system_config_table).delete_item(
            Key={"config_key": f"{self._LIFECYCLE_PREFIX}{instance_id}"}
        )

    def list_lifecycle_tokens(self) -> list[dict]:
        """列所有挂起的 lifecycle token。server-side begins_with 过滤(只取 lifecycle# 行,
        不把 config/live 等其它 SystemConfig 行拉回;实例数少,但 server-side 过滤更省、更清晰)。"""
        from boto3.dynamodb.conditions import Attr

        table = self._table(self.settings.system_config_table)
        items: list[dict] = []
        kwargs: dict[str, Any] = {"FilterExpression": Attr("config_key").begins_with(self._LIFECYCLE_PREFIX)}
        while True:
            resp = table.scan(**kwargs)
            items.extend(resp.get("Items", []))
            lek = resp.get("LastEvaluatedKey")
            if not lek:
                break
            kwargs["ExclusiveStartKey"] = lek
        return [_from_ddb(i) for i in items]

    def query_sessions_by_status(self, status: str) -> list[dict]:
        """按 status 走 StatusIndex GSI(design contract:reconciler 算预扩 P / 积压 Q,避免全表 scan)。

        返回该状态全部会话(含 meeting_start 排序键);调用方按 meeting_start 窗口过滤。
        大数据量下 query 远优于 scan(只取该 status 分区)。
        """
        items: list[dict] = []
        kwargs: dict[str, Any] = {
            "IndexName": "StatusIndex",
            "KeyConditionExpression": Key("status").eq(status),
        }
        while True:
            resp = self._table(self.settings.sessions_table).query(**kwargs)
            items.extend(resp.get("Items", []))
            lek = resp.get("LastEvaluatedKey")
            if not lek:
                return items
            kwargs["ExclusiveStartKey"] = lek
