import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { IMAGE_PLATFORM, LAMBDA_ARCH, imageBuildArgs } from '../common/arch';
import {
  GPU_HARD_MAX,
  GPU_SESSIONS_PER_INSTANCE,
  GPU_TARGET_UTIL,
  GPU_MAX_SCALE_OUT_STEP,
  GPU_PREWARM_WINDOW_MIN,
  GPU_SCALE_IN_COOLDOWN_MIN,
} from '../common/constants';

const BACKEND_DIR = path.join(__dirname, '..', '..', '..', 'backend');

/**
 * GPU 容量自动伸缩对账(design contract)。
 *
 * capacity-reconciler Lambda(EventBridge ~1min,reservedConcurrentExecutions=1 串行):
 * 读期望配置(DDB SystemConfig)+ 算需求(A=DDB calling/in_progress、P=未来预热、Q=已到点积压)→
 * **只调 ecs:UpdateService(desiredCount)**(ASG 由 ECS managed scaling 跟随,绝不直接调 ASG)→
 * 回写实况(serviceable/healthy/心跳)。healthy 从 NLB target health 或 ECS runningCount 读。
 *
 * 控制面 backend 不持任何 AWS 控制面写权限;伸缩动作只在本 reconciler。IAM 不含 autoscaling 写、不含 Bedrock。
 */
export interface CapacityReconcilerProps {
  stackName: string;
  vpc: ec2.IVpc;
  // reconciler/lifecycle Lambda 的 SG(GPU SG 须放行它到 /metrics·/drain :8080)。
  // **必填**(review):可选会让"读 /metrics、触发 /drain"路径静默失联(Lambda 无路由到 GPU)。
  securityGroup: ec2.ISecurityGroup;
  cluster: ecs.Cluster;
  service: ecs.Ec2Service;
  autoScalingGroup: autoscaling.AutoScalingGroup;
  sessionsTable: dynamodb.Table;
  systemConfigTable: dynamodb.Table;
  dataEncryptionKey: kms.IKey;
}

export class CapacityReconciler extends Construct {
  public readonly fn: lambda.DockerImageFunction;
  public readonly lifecycleFn: lambda.DockerImageFunction;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: CapacityReconcilerProps) {
    super(scope, id);

    const image = lambda.DockerImageCode.fromImageAsset(BACKEND_DIR, {
      file: 'Dockerfile.lambda',
      platform: IMAGE_PLATFORM,
      buildArgs: imageBuildArgs(),
    });
    const baseEnv = {
      SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
      SYSTEM_CONFIG_TABLE_NAME: props.systemConfigTable.tableName,
      AIM_GPU_CLUSTER: props.cluster.clusterName,
      AIM_GPU_SERVICE: props.service.serviceName,
      // GPU 调参常量从 constants.ts 单一事实源注入(review 不再硬编码漂移)
      GPU_HARD_MAX: String(GPU_HARD_MAX),
      GPU_SESSIONS_PER_INSTANCE: String(GPU_SESSIONS_PER_INSTANCE),
      GPU_TARGET_UTIL: String(GPU_TARGET_UTIL),
      GPU_MAX_SCALE_OUT_STEP: String(GPU_MAX_SCALE_OUT_STEP),
      AIM_GPU_PREWARM_WINDOW_MIN: String(GPU_PREWARM_WINDOW_MIN),
      AIM_GPU_SCALE_IN_COOLDOWN_MIN: String(GPU_SCALE_IN_COOLDOWN_MIN),
      AIM_AUTH_MODE: 'cognito',
    };

    // ── reconciler tick ──
    this.fn = new lambda.DockerImageFunction(this, 'Fn', {
      functionName: `${props.stackName}-capacity-reconciler`,
      code: image,
      architecture: LAMBDA_ARCH,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      // 串行(design contract):EventBridge 不保证串行,上轮未完时本值确保不并发改 ECS。
      reservedConcurrentExecutions: 1,
      // 入 VPC:并发 GET 健康 GPU /metrics(展示用)+ 访问 DDB/ECS(经 VPC endpoint 或 NAT)。
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      environment: {
        ...baseEnv,
        // handler 入口:app.capacity_reconciler.on_schedule
        // (Dockerfile.lambda 的 CMD 由 SAM/Lambda runtime 经此 env 或镜像 CMD 决定;见下 cmd 覆盖)
      },
      // container Lambda:覆盖 CMD 指向 reconciler handler
      // (默认镜像 CMD 是 scheduler;此处显式指定本 Lambda 的 handler)
    });
    // 覆盖容器 CMD → 本 Lambda 的 handler(其余 Lambda 共用同一镜像、各自指定 handler)
    (this.fn.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'ImageConfig.Command',
      ['app.capacity_reconciler.on_schedule'],
    );

    // IAM(design contract 最小):只 ecs:UpdateService/Describe* + elbv2:DescribeTargetHealth + ddb;
    // **不含 autoscaling:SetDesiredCapacity/UpdateAutoScalingGroup**(ASG 由 ECS managed scaling 管);**不含 Bedrock**。
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices', 'ecs:ListTasks', 'ecs:DescribeTasks'],
      resources: ['*'], // ECS service/ task ARN 含随机后缀;用 cluster condition 收窄
      conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['elasticloadbalancing:DescribeTargetHealth', 'elasticloadbalancing:DescribeTargetGroups'],
      resources: ['*'],
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'AIM/Capacity' } },
    }));
    props.sessionsTable.grantReadData(this.fn); // 算 A/P/Q(StatusIndex GSI query)
    props.systemConfigTable.grantReadWriteData(this.fn); // 读期望 + 回写实况 live
    props.dataEncryptionKey.grantEncryptDecrypt(this.fn);

    new events.Rule(this, 'Tick', {
      ruleName: `${props.stackName}-capacity-reconciler-tick`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.fn)],
    });

    // ── lifecycle-handler(实例终止 drain,design contract)──
    // ASG TERMINATING:WAIT hook 触发 → 查实例 active_sessions:空闲立即 CompleteLifecycleAction;
    // 忙则 RecordLifecycleActionHeartbeat 续期 + 定时重查,drain 空即放行(非 fire-once 等满超时)。
    this.lifecycleFn = new lambda.DockerImageFunction(this, 'LifecycleFn', {
      functionName: `${props.stackName}-capacity-lifecycle`,
      code: image,
      architecture: LAMBDA_ARCH,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      environment: { ...baseEnv, AIM_GPU_ASG: props.autoScalingGroup.autoScalingGroupName },
    });
    (this.lifecycleFn.node.defaultChild as lambda.CfnFunction).addPropertyOverride(
      'ImageConfig.Command',
      ['app.capacity_lifecycle.on_lifecycle'],
    );
    // 仅 lifecycle-handler 持 autoscaling 的 CompleteLifecycleAction/RecordLifecycleActionHeartbeat(限本 ASG);
    // reconciler 不持(职责隔离,design contract)。
    this.lifecycleFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['autoscaling:CompleteLifecycleAction', 'autoscaling:RecordLifecycleActionHeartbeat'],
      resources: [props.autoScalingGroup.autoScalingGroupArn],
    }));
    this.lifecycleFn.addToRolePolicy(new iam.PolicyStatement({
      // handler 经 ListContainerInstances(按 ec2InstanceId 反查)→ ListTasks 判该实例是否仍有在途 GPU task
      actions: ['ecs:ListContainerInstances', 'ecs:ListTasks', 'ecs:DescribeTasks'],
      resources: ['*'],
      conditions: { ArnEquals: { 'ecs:cluster': props.cluster.clusterArn } },
    }));
    // lifecycle-handler 也读写 SystemConfig(存/查/删 lifecycle drain token)
    props.systemConfigTable.grantReadWriteData(this.lifecycleFn);
    props.dataEncryptionKey.grantEncryptDecrypt(this.lifecycleFn);

    // ASG lifecycle action(EC2 Instance-terminate Lifecycle Action)→ lifecycle-handler
    new events.Rule(this, 'LifecycleRule', {
      ruleName: `${props.stackName}-capacity-lifecycle-rule`,
      eventPattern: {
        source: ['aws.autoscaling'],
        detailType: ['EC2 Instance-terminate Lifecycle Action'],
        detail: { AutoScalingGroupName: [props.autoScalingGroup.autoScalingGroupName] },
      },
      targets: [new targets.LambdaFunction(this.lifecycleFn)],
    });
    // 忙实例的定时重查(每分钟):handler 据 DDB 存的 token 重查 drain 状态,空即 Complete。
    new events.Rule(this, 'LifecyclePoll', {
      ruleName: `${props.stackName}-capacity-lifecycle-poll`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.lifecycleFn, { event: events.RuleTargetInput.fromObject({ poll: true }) })],
    });

    // ── 收敛者失活告警(design contract)──
    // reconciler 每成功一轮发 AIM/Capacity ReconcilerHeartbeat=1;Alarm 监控"超新鲜度窗口无心跳"→ SNS。
    // 这是收敛者失效的主动闭环(不只靠 admin 开页面看 stale 横幅)。SNS topic 留给运维订阅(邮件/PagerDuty)。
    this.alarmTopic = new sns.Topic(this, 'ReconcilerAlarmTopic', {
      topicName: `${props.stackName}-capacity-reconciler-alarm`,
    });
    const heartbeat = new cloudwatch.Metric({
      namespace: 'AIM/Capacity',
      metricName: 'ReconcilerHeartbeat',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });
    const alarm = new cloudwatch.Alarm(this, 'ReconcilerStaleAlarm', {
      alarmName: `${props.stackName}-capacity-reconciler-stale`,
      alarmDescription: 'capacity-reconciler 超过 5min 无心跳(疑似失活;闸门将走 fail-safe 过期分支)',
      metric: heartbeat,
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // 无数据(心跳完全停)= 失活,MUST 告警(不能当正常)
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    alarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));
  }
}
