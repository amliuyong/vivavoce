import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { IMAGE_PLATFORM, LAMBDA_ARCH, imageBuildArgs } from '../common/arch';
import { DEFAULT_MAX_CONCURRENCY, GPU_MAX_MVP, GPU_SESSIONS_PER_INSTANCE } from '../common/constants';

/**
 * MVP 单场 Session 调度(design contract / §「MVP 单场调度」)。
 * EventBridge 每分钟触发 → Lambda 扫 scheduled/in_progress 会话(即时开始转向 deployment validation,无拨入/无重试):
 *   - scheduled 创建后 N 分钟(候选人 slot 按时段窗)仍未连入 → failed(过期);
 *   - in_progress 达 started_at + max_duration_s 上限 → 强制收尾(control-plane backstop)。
 *
 * 复用 backend app/ 的 state_machine + session_service(单一事实源,不与 API 状态机漂移):
 * 作为 backend 镜像的 container Lambda 部署(handler = app.scheduler.on_schedule)。
 * 仅访问 DynamoDB(公网 AWS 服务 + IAM),无需入 VPC。
 *
 * Campaign 批量队列(campaign-scheduler)是 v1 增量,与此单场调度并存、互不前置依赖。
 */
const BACKEND_DIR = path.join(__dirname, '..', '..', '..', 'backend');

export interface SessionSchedulerProps {
  stackName: string;
  sessionsTable: dynamodb.Table;
  agentsTable: dynamodb.Table;
  sessionEventsTable: dynamodb.Table;
  /** PII 表 CMK:写 SessionEvents meta(下发指令/状态)需解密权 */
  dataEncryptionKey: kms.IKey;
  /** SystemConfig 表(design contract):调度器闸门读动态 GPU 容量 live。给定则注入表名 + 授读权。 */
  systemConfigTable?: dynamodb.Table;
  /** 全局并发闸门安全阀硬顶(design contract);默认对齐 constants */
  maxConcurrency?: number;
  /** GPU 可服务并发(= GPU 实例数 × GPU_SESSIONS_PER_INSTANCE);config 据此把 MAX_CONCURRENCY 钳到 ≤ GPU 容量。
   *  调度器是自动拨入/重试的主路径,**也**经 config.load_settings() 算 max_concurrency,故必须与 backend 同口径
   *  注入,否则调度器会按未钳制的 MAX_CONCURRENCY 放过超 GPU 算力的会话(review)。 */
  gpuCapacity?: number;
  /** 实时会话服务入口(HttpDispatcher → POST /sessions/{id}/ready|hangup,Cloud Map 内网);
   *  留空则调度器仅落库(RecordingDispatcher)——meeting_end backstop 将无法真正终止 rt 侧会话。 */
  bridgeDialUrl?: string;
  /** X-Bridge-Secret(ISecret,Lambda env 经 Secrets Manager 动态引用注入;调 rt ready/hangup 鉴权)。 */
  bridgeCallbackSecret?: secretsmanager.ISecret;
  /** 实时会话服务在私网:调度器须入 VPC 才能经 Cloud Map 直连(否则非 VPC Lambda 解析不到 .local)。 */
  vpc?: ec2.IVpc;
  /** 调度器 Lambda 的 SG;rt SG 须放行它到 :3001(与 backend 同用 backendSecurityGroup 时已覆盖)。 */
  securityGroup?: ec2.ISecurityGroup;
}

export class SessionScheduler extends Construct {
  public readonly fn: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: SessionSchedulerProps) {
    super(scope, id);

    this.fn = new lambda.DockerImageFunction(this, 'Fn', {
      functionName: `${props.stackName}-session-scheduler`,
      code: lambda.DockerImageCode.fromImageAsset(BACKEND_DIR, {
        file: 'Dockerfile.lambda',
        platform: IMAGE_PLATFORM,
        buildArgs: imageBuildArgs(),
      }),
      architecture: LAMBDA_ARCH,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      // 入 VPC private subnet:才能访问内部 NLB(下发拨号给媒体面 bridge,主拨入链路)。
      ...(props.vpc
        ? {
            vpc: props.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            securityGroups: props.securityGroup ? [props.securityGroup] : undefined,
          }
        : {}),
      environment: {
        SESSIONS_TABLE_NAME: props.sessionsTable.tableName,
        AGENTS_TABLE_NAME: props.agentsTable.tableName,
        SESSION_EVENTS_TABLE_NAME: props.sessionEventsTable.tableName,
        // 调度器也是发起主路径,须与 backend 同口径读**动态**容量(design contract):注入 SystemConfig 表名,
        // 否则它的闸门只会用保守静态兜底、感知不到 GPU autoscaling 扩容。
        ...(props.systemConfigTable ? { SYSTEM_CONFIG_TABLE_NAME: props.systemConfigTable.tableName } : {}),
        // MAX_CONCURRENCY = 安全阀硬顶(与 backend 同;design contract,不再静态钳制,给 autoscaling 留弹性)。
        MAX_CONCURRENCY: String(props.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
        // AIM_GPU_CAPACITY = live 缺失时的保守兜底(单实例并发);缺省同 backend 推导。
        AIM_GPU_CAPACITY: String(props.gpuCapacity ?? GPU_MAX_MVP * GPU_SESSIONS_PER_INSTANCE),
        AIM_AUTH_MODE: 'cognito', // 调度器不做鉴权,但避免误开 docs
        // 实时会话服务入口:配了则 meeting_end backstop 真 POST hangup(否则 RecordingDispatcher 只落库)
        AIM_BRIDGE_DIAL_URL: props.bridgeDialUrl ?? '',
        // X-Bridge-Secret:经 CFN 动态引用注入(值不进模板明文;Lambda env 引用 Secrets Manager)
        ...(props.bridgeCallbackSecret
          ? { AIM_BRIDGE_CALLBACK_SECRET: props.bridgeCallbackSecret.secretValue.unsafeUnwrap() }
          : {}),
      },
    });

    // 读写 Sessions(状态推进)、读 Agents(解析发起指令)、读写 SessionEvents(下发指令/meta 状态)。
    // 注:调度器**不读题库表** —— 题目在创建会话时已固化进 session.resolved_questions(design contract),
    // 调度器/媒体面/evaluator 全程不碰 QuestionBanks 表(IAM 红线)。
    props.sessionsTable.grantReadWriteData(this.fn);
    props.agentsTable.grantReadData(this.fn);
    props.sessionEventsTable.grantReadWriteData(this.fn);
    props.dataEncryptionKey.grantEncryptDecrypt(this.fn); // PII 表 CMK
    props.systemConfigTable?.grantReadData(this.fn); // design contract:闸门读动态 GPU 容量 live

    // 每分钟触发(MVP 单场;粒度足够:meeting_start/next_retry_at 都按分钟界定)
    new events.Rule(this, 'Tick', {
      ruleName: `${props.stackName}-session-scheduler-tick`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.fn)],
    });
  }
}
