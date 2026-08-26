"""capacity-lifecycle handler(design contract)—— GPU 实例终止前的优雅 drain。

ASG TERMINATING:WAIT lifecycle hook 触发(EC2 Instance-terminate Lifecycle Action)→ 本 handler:
  - 记录该实例的 lifecycle action token 到 DDB(SystemConfig,pk=lifecycle#<instance_id>)。
  - 查该实例上 GPU task 是否仍有在途会话:空闲 → CompleteLifecycleAction(放行终止);
    忙 → RecordLifecycleActionHeartbeat 续期 + 留待下次 poll(非 fire-once 等满超时,第7轮 N2)。
  - 定时 poll(每分钟,event={poll:true}):对所有挂起 token 的实例重查,空即 Complete。

判"是否在途":该实例上运行的 GPU task 数 > 0 视作忙(MVP 简化:task 在 = 可能有会话;
task 已停/无 = 空闲可回收)。更精确的 per-task active_sessions 由 /metrics,留 v1。

只调 autoscaling:CompleteLifecycleAction/RecordLifecycleActionHeartbeat(限本 ASG)+ ecs 只读。
"""
from __future__ import annotations

import logging
import os
from datetime import UTC, datetime

from .config import load_settings
from .db import Db

logger = logging.getLogger(__name__)

_TOKEN_PREFIX = "lifecycle#"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _aws():
    import boto3

    settings = load_settings()
    region = settings.region
    return (
        boto3.client("autoscaling", region_name=region),
        boto3.client("ecs", region_name=region),
        os.getenv("AIM_GPU_CLUSTER", ""),
        os.getenv("AIM_GPU_ASG", ""),
    )


def _instance_busy(ecs_client, cluster: str, instance_id: str) -> bool:
    """该 EC2 实例上是否仍有运行中的 GPU task(MVP:有 task = 忙,须等其结束才放行终止)。

    经 container-instance ARN 反查:先 list_container_instances 找到本 EC2 的 container-instance,
    再 list_tasks(containerInstance=该 arn, desiredStatus=RUNNING)。无则空闲。
    """
    if not cluster:
        return False
    try:
        # ★ ECS cluster query language 的字符串值 MUST 单引号包裹(review):
        #   `ec2InstanceId == i-abc` 报 InvalidParameterException / 返空;须 `ec2InstanceId == 'i-abc'`。
        ci = ecs_client.list_container_instances(cluster=cluster, filter=f"ec2InstanceId == '{instance_id}'")
        arns = ci.get("containerInstanceArns", [])
        if not arns:
            return False  # 该实例已不在集群(task 已撤)→ 空闲,可放行终止
        tasks = ecs_client.list_tasks(cluster=cluster, containerInstance=arns[0], desiredStatus="RUNNING")
        return len(tasks.get("taskArns", [])) > 0
    except Exception:  # noqa: BLE001
        # ★ 异常**视作"忙"**(review):IAM/限流/网络抖动若按"空闲"放行 → CompleteLifecycleAction
        #   立即终止 → 在途 GPU task 被强杀(违背 spec §3.7 不腰斩)。宁可续 heartbeat 留待重查,
        #   最坏由 ASG lifecycle hook 的 HeartbeatTimeout(MAX_DRAIN)自然超时兜底,不会无限挂住。
        logger.exception("查实例 %s 在途 task 失败 → 保守视作忙(续 heartbeat,不放行终止)", instance_id)
        return True


def _complete_or_heartbeat(asg_client, db: Db, asg: str, instance_id: str, token: str, *, busy: bool) -> str:
    """空闲 → CompleteLifecycleAction(CONTINUE)放行 + 清 token;忙 → 续 heartbeat 留待下次。"""
    if busy:
        try:
            asg_client.record_lifecycle_action_heartbeat(
                AutoScalingGroupName=asg,
                LifecycleHookName="GpuDrainHook",
                InstanceId=instance_id,
                LifecycleActionToken=token,
            )
            return "heartbeat_busy"
        except Exception as exc:  # noqa: BLE001
            # heartbeat 失败:若 token 已失效(ASG HeartbeatTimeout 到期 ABANDON/CONTINUE → ValidationError),
            # 必须**清 token**,否则每分钟 poll 重撞同 token、刷 ERROR + SystemConfig 残留 zombie 行(review)。
            # 其它瞬时错误(throttle)也清:下次新 TERMINATING 事件会 put 新 token 覆盖,不丢保护(实例真终止前
            # 会再发 lifecycle 事件)。
            logger.warning("lifecycle heartbeat 失败 instance=%s(清 token 防 zombie;%s)", instance_id, exc)
            try:
                db.delete_lifecycle_token(instance_id)
            except Exception:  # noqa: BLE001
                logger.exception("清 lifecycle token 失败 instance=%s(下轮重试)", instance_id)
            return "heartbeat_failed_token_cleared"
    # complete + delete 两步合一保护(review):若 delete 抛错(DDB throttle/KMS 抖动)token 留库,
    # 下轮 poll 重撞同 token → ASG "No active Lifecycle Action found"。无论 complete 是否成功,**总是清 token**
    # (complete 成功即生命周期已推进;若 token 已失效,清掉防 zombie 反复撞)。complete 异常也吞(记 ERROR),
    # 由 ASG HeartbeatTimeout 兜底,绝不让单实例错误冒泡中断 poll 其余实例。
    try:
        asg_client.complete_lifecycle_action(
            AutoScalingGroupName=asg,
            LifecycleHookName="GpuDrainHook",
            InstanceId=instance_id,
            LifecycleActionToken=token,
            LifecycleActionResult="CONTINUE",
        )
    except Exception:  # noqa: BLE001
        logger.exception("CompleteLifecycleAction 失败 instance=%s(清 token 防 zombie,HeartbeatTimeout 兜底)", instance_id)
    finally:
        try:
            db.delete_lifecycle_token(instance_id)
        except Exception:  # noqa: BLE001
            logger.exception("删 lifecycle token 失败 instance=%s(下轮 poll 会重试)", instance_id)
    return "completed"


def on_lifecycle(event=None, _context=None) -> dict:
    """Lambda 入口。两类触发:
    - ASG lifecycle 事件(detail 含 LifecycleActionToken/EC2InstanceId):记 token + 首次判定。
    - poll(event={poll:true}):对 DDB 所有挂起 token 的实例重查。
    单轮异常隔离,不让 EventBridge 反复重投打挂。
    """
    settings = load_settings()
    db = Db(settings)
    try:
        asg_client, ecs_client, cluster, asg = _aws()
    except Exception:  # noqa: BLE001
        logger.exception("AWS 客户端未就绪(本地/未接线),跳过")
        return {"skipped": "no_aws"}

    event = event or {}
    detail = event.get("detail", {})

    # 1) 新的 lifecycle 事件:记 token
    if detail.get("LifecycleTransition") == "autoscaling:EC2_INSTANCE_TERMINATING":
        instance_id = detail.get("EC2InstanceId", "")
        token = detail.get("LifecycleActionToken", "")
        if instance_id and token:
            db.put_lifecycle_token(instance_id, token, _now_iso())
            busy = _instance_busy(ecs_client, cluster, instance_id)
            action = _complete_or_heartbeat(asg_client, db, asg, instance_id, token, busy=busy)
            return {"instance": instance_id, "action": action}
        return {"skipped": "no_token"}

    # 2) poll:重查所有挂起 token。**每条单独 try/except 隔离**(review):
    #    首条坏 token(ASG ValidationError 等)绝不能让本轮其余实例的 heartbeat 全漏续 → 被 ASG 强杀腰斩。
    pending = db.list_lifecycle_tokens()
    results = []
    for item in pending:
        instance_id = item.get("instance_id", "")
        token = item.get("token", "")
        if not instance_id or not token:
            continue
        try:
            busy = _instance_busy(ecs_client, cluster, instance_id)
            action = _complete_or_heartbeat(asg_client, db, asg, instance_id, token, busy=busy)
            results.append({"instance": instance_id, "action": action})
        except Exception:  # noqa: BLE001 — 单实例错误隔离,不中断其余实例的 drain 处理
            logger.exception("poll 处理实例 %s 失败(隔离,继续下一个)", instance_id)
            results.append({"instance": instance_id, "action": "error"})
    return {"polled": results}
