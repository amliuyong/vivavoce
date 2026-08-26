"""AwsPlatform(design contract)—— reconciler 对 AWS 控制面的真实实现(部署期接线)。

实现 CapacityPlatform 协议。**只调 ecs:UpdateService(desiredCount)** 调整容量(ASG 由 ECS managed
scaling 管,绝不直接调 ASG,§3.2);healthy 从 NLB target health 读(§3.4,不用 ECS runningCount);
active 从健康实例 /metrics 并发求和(展示用)。

env(CDK 注入):
  AIM_GPU_CLUSTER / AIM_GPU_SERVICE   —— ECS 集群/服务名(UpdateService/DescribeServices)
  AIM_GPU_TARGET_GROUP_ARN            —— NLB target group ARN(DescribeTargetHealth)
  AIM_GPU_INFERENCE_PORT              —— GPU /metrics 端口(默认 8080)

无 boto3/未接线时构造抛错 → on_schedule 捕获跳过(本地不动 ECS)。
"""
from __future__ import annotations

import logging
import os

from .config import Settings

logger = logging.getLogger(__name__)


class AwsPlatform:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.cluster = os.getenv("AIM_GPU_CLUSTER", "")
        self.service = os.getenv("AIM_GPU_SERVICE", "")
        self.target_group_arn = os.getenv("AIM_GPU_TARGET_GROUP_ARN", "")
        self.metrics_port = int(os.getenv("AIM_GPU_INFERENCE_PORT", "8080"))
        if not (self.cluster and self.service):
            raise RuntimeError("AIM_GPU_CLUSTER/AIM_GPU_SERVICE 未配置,AwsPlatform 不可用")
        import boto3

        self._ecs = boto3.client("ecs", region_name=settings.region)
        self._elbv2 = boto3.client("elbv2", region_name=settings.region) if self.target_group_arn else None
        self._cw = boto3.client("cloudwatch", region_name=settings.region)

    def get_current_desired(self) -> int:
        resp = self._ecs.describe_services(cluster=self.cluster, services=[self.service])
        svcs = resp.get("services", [])
        if not svcs:
            # 服务不存在(栈半部署/被误删)→ 明确报错,而非静默返回 0(0 会被误认为"存在且 desired=0",
            # 且后续 set_desired 必 ServiceNotFound;早失败给清晰日志,reconcile 单轮隔离重试,review)。
            raise RuntimeError(f"ECS service 不存在: cluster={self.cluster} service={self.service}")
        return int(svcs[0].get("desiredCount", 0))

    def set_desired(self, n: int) -> None:
        """只调 ecs:UpdateService 改 desiredCount;ASG 由 ECS managed scaling 跟随(§3.2)。"""
        self._ecs.update_service(cluster=self.cluster, service=self.service, desiredCount=int(n))
        logger.info("ecs:UpdateService desiredCount=%d (cluster=%s service=%s)", n, self.cluster, self.service)

    def healthy_instance_count(self) -> int:
        """可接客(已 ready)实例数(§3.4)。**绝不**用 ECS runningCount —— 它在 /readyz 通过前就为真
        (模型加载中),会把冷启动实例计入容量 → 闸门提前放行 → 撞 CAPACITY_FULL(review)。

        - 配了 NLB target group → 取 State=healthy 的 target(NLB 健检指向 /readyz)。
        - 未配(单实例 MVP 无 NLB)→ 数 **ECS task 中 healthStatus==HEALTHY** 的(该状态由容器
          healthCheck 即 /readyz 决定 → 只数模型已加载完、真能接客的 task,等价于"ready 实例")。
        """
        if self._elbv2 is not None:
            resp = self._elbv2.describe_target_health(TargetGroupArn=self.target_group_arn)
            return sum(
                1 for d in resp.get("TargetHealthDescriptions", [])
                if d.get("TargetHealth", {}).get("State") == "healthy"
            )
        # 无 NLB:列本 service 的 task → describe → 数 healthStatus==HEALTHY(= /readyz 通过)
        task_arns: list[str] = []
        paginator_kwargs = {"cluster": self.cluster, "serviceName": self.service, "desiredStatus": "RUNNING"}
        resp = self._ecs.list_tasks(**paginator_kwargs)
        task_arns.extend(resp.get("taskArns", []))
        while resp.get("nextToken"):
            resp = self._ecs.list_tasks(**paginator_kwargs, nextToken=resp["nextToken"])
            task_arns.extend(resp.get("taskArns", []))
        if not task_arns:
            return 0
        # describe_tasks 一次最多 100 个;MVP 实例数远小于此
        healthy = 0
        for i in range(0, len(task_arns), 100):
            d = self._ecs.describe_tasks(cluster=self.cluster, tasks=task_arns[i:i + 100])
            healthy += sum(1 for t in d.get("tasks", []) if t.get("healthStatus") == "HEALTHY")
        return healthy

    def running_instance_count(self) -> int:
        """运行中实例数(看板 running/draining 用)= ECS service runningCount(含未 ready 的)。
        与 healthy_instance_count(只数 ready)区分:draining ≈ running - healthy(§3.4 看板)。"""
        resp = self._ecs.describe_services(cluster=self.cluster, services=[self.service])
        svcs = resp.get("services", [])
        return int(svcs[0].get("runningCount", 0)) if svcs else 0

    def sum_active_from_metrics(self) -> int:
        """健康实例 /metrics 的 active 求和(交叉校验用)。**MVP stub 返回 0**:需 NLB target→IP
        反查后并发 GET 各实例 /metrics,留 v1。注:reconciler 的 active_sessions_total 已改用权威的
        DDB calling/in_progress 计数(非本 stub),故本方法返 0 不影响看板真数据,仅交叉校验缺位。
        """
        return 0

    def emit_heartbeat(self) -> None:
        """发 CloudWatch AIM/Capacity ReconcilerHeartbeat=1(design contract);CDK Alarm 监控其失活告警。"""
        self._cw.put_metric_data(
            Namespace="AIM/Capacity",
            MetricData=[{"MetricName": "ReconcilerHeartbeat", "Value": 1.0, "Unit": "Count"}],
        )
