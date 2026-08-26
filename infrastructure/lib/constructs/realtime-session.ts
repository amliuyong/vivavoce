import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { ECS_CPU_ARCH, IMAGE_PLATFORM, imageBuildArgs } from '../common/arch';
import { RT_SESSION_CPU, RT_SESSION_MEMORY, RT_SESSION_MIN_TASKS, RT_SESSION_PORT } from '../common/constants';

/** bridge/ 源码目录(实时会话服务,Node/TS + Dockerfile)。 */
const BRIDGE_DIR = path.join(__dirname, '..', '..', '..', 'bridge');

/**
 * 实时会话服务(M1,VISION §3):bridge 减法改造后落 Fargate 普通容器(无 SIP/RTP 后
 * 不再需要 EC2/EIP/公网子网——那是电话版 FreeSWITCH 的拓扑)。
 *
 * 接入路径:客户端 → 公网 ALB 443(精确 `/rt/health`、`/rt/ws`、`/v1/realtime`)
 * → Fargate :3001。WS 升级由 ALB 原生支持。
 * 安全(D9):`/rt/ws` 首帧 join token 鉴权；`/v1/realtime` 在 upgrade 阶段用独立
 * client secret 鉴权；`/rt/sessions/*` 控制端点不进公网 allowlist,只走 Cloud Map 内网直连,
 * 并保留 X-Bridge-Secret 作纵深防御。
 *
 * ★ M1 单任务约束(min=max=1):session-context(预创建暂存)与活动会话表在**进程内存**,
 *   多任务需 sticky 或外置存储(design contract 缩水版遗留债,放量前解决——对齐 MIGRATION-PLAN 风险 #6)。
 */
export interface RealtimeSessionProps {
  stackName: string;
  vpc: ec2.Vpc;
  /** 共享 ECS cluster(EcsBackend 建;同集群省一份控制面开销)。 */
  cluster: ecs.ICluster;
  /** 共享公网 ALB(EcsBackend 建);本 construct 只加三条精确实时 path 路由规则。 */
  alb: elbv2.ApplicationLoadBalancer;
  listener: elbv2.ApplicationListener;
  /** 与控制面/客户端共用的回调+join 密钥(X-Bridge-Secret / join token HMAC)。 */
  bridgeCallbackSecret: secretsmanager.ISecret;
  /** design contract:backend 签发、rt 验签的独立 Realtime client-secret HMAC key。 */
  realtimeClientSecret: secretsmanager.ISecret;
  /** 控制面 SG:放行 backend → :3001(ready/hangup 内部直连,Cloud Map,不经公网 ALB)。 */
  backendSecurityGroup: ec2.ISecurityGroup;
  /** 注入容器的环境变量(GPU WS 地址/表名/桶名/回调地址等,Stack 编排时填)。 */
  environment: Record<string, string>;
}

export class RealtimeSession extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskRole: iam.Role;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly container: ecs.ContainerDefinition;

  constructor(scope: Construct, id: string, props: RealtimeSessionProps) {
    super(scope, id);

    // 独立 SG:入站仅 ALB SG → :3001;出站放开(GPU WS/Bedrock/S3/DDB 经 NAT/Endpoints)。
    this.securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc: props.vpc,
      description: 'Realtime session service (bridge) - ALB ingress only',
      allowAllOutbound: true,
    });

    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Realtime session service task role (S3 recordings / SessionEvents / Bedrock granted at stack end)',
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${props.stackName}-rt-session`,
      cpu: RT_SESSION_CPU,
      memoryLimitMiB: RT_SESSION_MEMORY,
      taskRole: this.taskRole,
      runtimePlatform: {
        cpuArchitecture: ECS_CPU_ARCH,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const image = new ecrAssets.DockerImageAsset(this, 'RtImage', {
      directory: BRIDGE_DIR,
      platform: IMAGE_PLATFORM,
      buildArgs: imageBuildArgs(),
    });
    this.container = taskDef.addContainer('Rt', {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'aim-rt' }),
      environment: props.environment,
      portMappings: [{ containerPort: RT_SESSION_PORT }],
    });
    // 密钥经 ECS 原生 secret 注入(不进 CFN 模板明文):join token 验签 + ready 端点鉴权 + 回调签名三用。
    this.container.addSecret('AIM_BRIDGE_CALLBACK_SECRET', ecs.Secret.fromSecretsManager(props.bridgeCallbackSecret));
    this.container.addSecret(
      'AIM_REALTIME_CLIENT_SECRET',
      ecs.Secret.fromSecretsManager(props.realtimeClientSecret),
    );

    // ★ M1 min=max=1(见类注释:会话上下文在进程内存);maxHealthyPercent 200 允许滚动替换,
    //   替换窗口内在途会话会断(减法版可接受;WS 断线由客户端提示重试)。
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: taskDef,
      desiredCount: RT_SESSION_MIN_TASKS,
      securityGroups: [this.securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 0, // 单任务:先停旧再起新(端口/会话表进程内,双任务并存会分裂会话)
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      cloudMapOptions: { name: 'rt' }, // rt.<stack>.local(backend 预创建/hangup 直连)
    });

    // ALB path 路由:**精确 path**(/rt/ws + /rt/health + /v1/realtime),不用通配(review:
    // 通配会把 /rt/sessions/:id/ready|hangup 控制端点推上公网——那是原 CloudFront 精确行为
    // 挡住的暴露面,去 CloudFront 后由 ALB 精确 path 承接同一姿态;控制端点只走 Cloud Map 内网,
    // bridge 侧 X-Bridge-Secret 仍是纵深防御第二层)。
    // ALB 不重写路径 → bridge 侧统一 strip 前导 /rt(index.ts)。
    props.listener.addTargets('RtTargets', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/rt/health', '/rt/ws', '/v1/realtime'])],
      port: RT_SESSION_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: { path: '/rt/health', healthyHttpCodes: '200' },
      // WS 长连接:摘除时给在途会话留缓冲(考试会话可能几十分钟,30s 是滚动部署与在途的折中;
      // meeting_end backstop 会兜底强制收尾)。
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ALB → 本服务 SG 放行(公网 WS 接入路径)
    this.securityGroup.addIngressRule(
      ec2.Peer.securityGroupId(props.alb.connections.securityGroups[0].securityGroupId),
      ec2.Port.tcp(RT_SESSION_PORT),
      `ALB to realtime session on ${RT_SESSION_PORT}`,
    );
    // backend → 本服务(ready/hangup 内部直连,Cloud Map;不经公网 ALB——443 证书是域名的)
    this.securityGroup.addIngressRule(
      props.backendSecurityGroup,
      ec2.Port.tcp(RT_SESSION_PORT),
      `backend to realtime session (ready/hangup) on ${RT_SESSION_PORT}`,
    );

    new cdk.CfnOutput(this, 'RtServiceName', { value: this.service.serviceName });
  }
}
