"""ECS task scale-in protection 续租(design contract,High #2)。

会话期(active_sessions>0)保护本 task 不被 ECS scale-in / 部署替换中途停止;active 归 0 解除。
AWS 语义:UpdateTaskProtection 防 "scale-in from Service Autoscaling **or deployments**"。

本 task 的 cluster/taskArn 从 ECS Container Metadata URI v4(env `ECS_CONTAINER_METADATA_URI_V4`)拿;
非 ECS 环境(本地/CI)或 boto3 缺失 → 静默 no-op(不影响通话)。所有调用 best-effort + 异常吞(记日志),
绝不让保护调用失败拖垮 GPU 服务。

由 server 在会话计数变化时调用:
  - on_session_start():active 0→>0 时 protect(True, expiresInMinutes=MAX_DRAIN)
  - on_session_end():active >0→0 时 protect(False)
  - 周期续租(server 后台 task):active>0 期间每 N 分钟续到 now+MAX_DRAIN(防中途过期,H4)
"""
from __future__ import annotations

import logging
import os
import urllib.request

logger = logging.getLogger(__name__)

#: task protection 内建默认(design contract 单一事实源)。
TASK_PROTECTION_DEFAULTS = {"max_drain_min": 60}

_MAX_DRAIN_MIN = int(os.getenv("AIM_GPU_MAX_DRAIN_MIN", str(TASK_PROTECTION_DEFAULTS["max_drain_min"])))


class TaskProtection:
    """封装本 task 的 protection 调用。lazy 解析 cluster/taskArn;不可用则 no-op。"""

    def __init__(self) -> None:
        self._enabled = False  # 是否已成功定位 ECS task(可调 API)
        self._cluster = ""
        self._task_arn = ""
        self._client = None
        self._init()

    def _init(self) -> None:
        meta_uri = os.getenv("ECS_CONTAINER_METADATA_URI_V4", "")
        if not meta_uri:
            logger.info("非 ECS 环境(无 ECS_CONTAINER_METADATA_URI_V4),task protection no-op")
            return
        try:
            # task metadata 在 <meta_uri>/task,含 Cluster + TaskARN
            with urllib.request.urlopen(f"{meta_uri}/task", timeout=2) as r:  # noqa: S310 — 169.254 内网元数据
                import json
                meta = json.loads(r.read().decode("utf-8"))
            self._cluster = meta.get("Cluster", "")
            self._task_arn = meta.get("TaskARN", "")
            if not (self._cluster and self._task_arn):
                logger.warning("ECS task metadata 缺 Cluster/TaskARN,task protection no-op")
                return
            import boto3
            region = self._task_arn.split(":")[3] if self._task_arn.count(":") >= 3 else os.getenv("AWS_REGION", "us-east-1")
            self._client = boto3.client("ecs", region_name=region)
            self._enabled = True
        except Exception:  # noqa: BLE001 — 定位失败不影响通话,降级 no-op
            logger.exception("task protection 初始化失败,降级 no-op")

    def set(self, protected: bool) -> bool:
        """设/清本 task 的 scale-in protection。返回是否成功(供 protect-before-admit 决定 fail-closed)。

        返回 True:成功,或 no-op 环境(非 ECS / 未定位 task —— 本地无 scale-in 风险,不应阻塞接客)。
        返回 False:API 调用抛错。调用方据 AIM_PROTECT_FAIL_CLOSED 决定是否拒接(默认 best-effort 不拒,
        避免 ECS API 抖动掐断真实通话;严格模式可开 fail-closed)。
        """
        if not self._enabled or self._client is None:
            return True  # no-op 环境:无保护需求,不阻塞
        try:
            kwargs: dict = {
                "cluster": self._cluster,
                "tasks": [self._task_arn],
                "protectionEnabled": protected,
            }
            if protected:
                kwargs["expiresInMinutes"] = _MAX_DRAIN_MIN
            self._client.update_task_protection(**kwargs)
            logger.info("UpdateTaskProtection protected=%s task=%s", protected, self._task_arn)
            return True
        except Exception:  # noqa: BLE001
            logger.exception("UpdateTaskProtection(protected=%s)失败", protected)
            return False
