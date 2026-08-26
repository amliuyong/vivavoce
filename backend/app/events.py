"""Webhook 事件接线(design contract/3.3)—— 会话终态/结果就绪时触发 webhook 投递。

设计:emitter 是 callable(event_type, data),注入 SessionService;终态时调用。
投递经 IntegrationService.dispatch_event(签名 + 至少一次重试 + 死信),**后台线程 fire-and-forget**
不阻塞控制面请求。无 webhook 订阅时是空操作。全异常吞(webhook 失败绝不影响主流程)。
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Callable

from .db import Db
from .integration_service import IntegrationService

logger = logging.getLogger(__name__)

EventEmitter = Callable[[str, dict], None]


def make_webhook_emitter(db: Db, settings) -> EventEmitter:
    """构造一个 best-effort、后台线程的 webhook 事件发射器(design contract)。

    返回的 callable(event_type, data) 立即返回,投递在 daemon 线程做(含重试/死信),不阻塞调用方。
    """
    svc = IntegrationService(db)

    def _emit(event_type: str, data: dict) -> None:
        def _run() -> None:
            try:
                svc.dispatch_event(event_type, data)
            except Exception:  # noqa: BLE001
                logger.exception("webhook 投递失败(event=%s),不影响主流程", event_type)

        try:
            threading.Thread(target=_run, daemon=True).start()
        except Exception:  # noqa: BLE001
            logger.exception("webhook 线程启动失败,跳过")

    return _emit
