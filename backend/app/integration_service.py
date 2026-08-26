"""API / Webhook 集成编排(design contract,v2)。

两类程序化访问:
  - API Key(admin 下发):系统集成商凭据,代表 admin 级机器操作整个系统,按 scope 授权。
  - 委托 token(staff 自助签发):授权第三方 agent 代理该 staff 预约/查询,继承 staff 边界。

Webhook:会话完成/失败、结果就绪时,向订阅的 client 推签名事件(HMAC + 至少一次重试 + 死信)。
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from . import api_key as apikeylib
from . import webhook as wh
from .candidate_token import issue_token
from .db import Db


def _now() -> datetime:
    return datetime.now(UTC)


class IntegrationService:
    def __init__(self, db: Db, *, delegation_secret: str | None = None, public_api_base: str | None = None):
        self.db = db
        self.delegation_secret = delegation_secret
        self.public_api_base = public_api_base

    # ── API client(admin) ──
    def create_client(self, name: str, scopes: list[str], created_by: str) -> dict:
        client_id = uuid.uuid4().hex[:16]
        full_key, secret_hash = apikeylib.generate_key(client_id)
        record = {
            "client_id": client_id,
            "name": name,
            "scopes": scopes,
            "secret_hash": secret_hash,
            "created_at": _now().isoformat(),
            "created_by": created_by,
            "disabled": False,
        }
        self.db.put_api_client(record)
        # api_key 明文仅此一次返回(之后只存 hash)
        return {**record, "api_key": full_key}

    def list_clients(self, owner: str | None = None) -> list[dict]:
        # 不回显 secret_hash。owner 给定(=当前 admin username)→ 只返回该 admin 创建的(created_by 匹配),
        # 每个 admin 只见/管自己签发的 key(归属隔离);owner=None 仅供内部/测试取全量。
        clients = self.db.list_api_clients()
        if owner is not None:
            clients = [c for c in clients if c.get("created_by") == owner]
        return [{k: v for k, v in c.items() if k != "secret_hash"} for c in clients]

    def revoke_client(self, client_id: str, owner: str | None = None) -> bool:
        client = self.db.get_api_client(client_id)
        if client is None:
            return False
        # 归属校验:owner 给定且非本人创建 → 当作不存在(返 False → 路由 404,不泄露他人 key 的存在性)。
        if owner is not None and client.get("created_by") != owner:
            return False
        self.db.delete_api_client(client_id)
        return True

    # ── Webhook(client 用 webhooks:manage scope 注册自己的) ──
    def register_webhook(self, client_id: str, url: str, events: list[str]) -> dict:
        webhook_id = uuid.uuid4().hex[:12]
        secret = "whsec_" + uuid.uuid4().hex + uuid.uuid4().hex
        record = {
            "webhook_id": webhook_id,
            "client_id": client_id,
            "url": url,
            "events": events,
            "secret": secret,
            "created_at": _now().isoformat(),
        }
        self.db.put_webhook(client_id, record)
        return record  # secret 仅注册时返回一次

    def list_webhooks(self, client_id: str) -> list[dict]:
        return [{k: v for k, v in w.items() if k != "secret"} for w in self.db.list_webhooks(client_id)]

    def delete_webhook(self, client_id: str, webhook_id: str) -> None:
        self.db.delete_webhook(client_id, webhook_id)

    # ── 委托 token(staff 自助) ──
    def issue_delegation(self, staff: str, label: str | None, ttl_hours: int) -> dict:
        if not self.delegation_secret:
            raise PermissionError("委托 token 密钥未配置")
        exp = int((_now() + timedelta(hours=int(ttl_hours))).timestamp())
        token = issue_token(
            candidate_id=staff, engagement_id="delegation", exp_epoch=exp,
            jti=uuid.uuid4().hex, secret=self.delegation_secret,
        )
        # 即用 MCP 配置(design contract):内嵌 token + endpoint(委托 token 回退路径;OAuth 是首选)。
        # tools 必须与 mcp_server.py::TOOLS 一致——即时开始转向后 reschedule_meeting 已删(无预约窗可改)。
        mcp_config = {
            "server_name": "aim-meeting-agent",
            "transport": "stdio",
            "endpoint": (self.public_api_base or "").rstrip("/"),  # 公网 ALB 域名,如 https://<domain>
            "auth_header": "X-Delegation-Token",
            "token": token,
            "tools": ["list_self_bookable_agents", "book_meeting",
                      "cancel_meeting", "list_my_meetings", "get_meeting_status"],
            "note": "本地启动该 MCP server,agent 即可代你发起/查询;token 仅存本地,勿外传。",
        }
        return {"token": token, "label": label, "staff": staff, "exp_epoch": exp, "mcp_config": mcp_config}

    # ── 幂等 ──
    def idempotent(self, client_id: str, key: str, compute) -> tuple[dict, bool]:
        """幂等执行:同 (client,key) 只 compute 一次;重复请求返回首次结果。返回 (result, first)。

        claim 条件写抢占:first=True 者 compute 并 save 真实结果;first=False 者返回已存结果。
        若 first=False 但结果仍为占位(None,极短竞态窗:另一请求刚 claim 未 save),抛 409 让调用方重试。
        """
        claimed = self.db.claim_idempotency(client_id, key)
        if claimed["first"]:
            try:
                result = compute()
            except Exception:
                # compute 失败:删除占位(review),否则占位 None 永留 → 后续同 key 永远 409 死锁。
                # 删除后允许同 key 重试重新 compute(幂等键本身可重用)。
                self.db.delete_idempotency(client_id, key)
                raise
            self.db.save_idempotency(client_id, key, result)
            return result, True
        if claimed["result"] is None:
            # 并发同键、首次请求尚未 save 完:不重复发起,提示重试(幂等保护到位)
            raise ValueError("幂等请求处理中,请稍后用同一 Idempotency-Key 重试")
        return claimed["result"], False

    # ── 事件投递 ──
    def dispatch_event(self, event_type: str, data: dict, *, sleep=None) -> list[dict]:
        """向所有订阅 event_type 的 webhook 投递签名事件(至少一次 + 死信)。返回投递结果列表。

        ts 由调用方注入 data 或此处 stamp;event_id 唯一(去重)。失败进 deadletter(记 db,可重放)。
        """
        ts = _now().isoformat()
        results = []
        for hook in self.db.list_all_webhooks():
            if event_type not in (hook.get("events") or []):
                continue
            event_id = uuid.uuid4().hex
            event = wh.build_event(event_id=event_id, event_type=event_type, ts=ts, data=data)
            ok, attempts, detail = wh.deliver(hook["url"], event, hook["secret"], sleep=sleep)
            results.append({"webhook_id": hook["webhook_id"], "ok": ok, "attempts": attempts,
                            "detail": detail, "event_id": event_id})
            if not ok:
                # 死信:落库可重放(MVP 落 integration 表一行;v1 可接 SQS DLQ)
                self.db.put_webhook(hook["client_id"], {
                    "webhook_id": f"dead-{event_id}",
                    "client_id": hook["client_id"],
                    "url": hook["url"], "events": [], "secret": "",
                    "deadletter": True, "event_type": event_type, "event_id": event_id,
                    "last_detail": detail, "created_at": ts,
                })
        return results
