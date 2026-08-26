import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { ECS_CPU_ARCH, IMAGE_PLATFORM, imageBuildArgs } from '../common/arch';
import {
  BACKEND_CPU,
  BACKEND_MEMORY,
  BACKEND_MIN_TASKS,
  BACKEND_MAX_TASKS,
  BACKEND_PORT,
} from '../common/constants';

/** 仓库根(镜像 build context:Dockerfile 需同时 COPY backend/ 与 frontend/)。 */
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/**
 * 控制面:**公网 ALB(仅 443,设计决策 去 CloudFront)** + ECS Fargate(Orchestrator API)。
 * 容器同时托管前端静态导出(Dockerfile 多阶段烘入 frontend/out → FastAPI StaticFiles;
 * /config.json 由 backend 从 env 动态渲染)——不再有 S3 前端桶 / CloudFront。
 *
 * 镜像:build context = **仓库根**(要同时拿 backend/ 与 frontend/),file=backend/Dockerfile。
 * /health、静态资源、/config.json 开放;/api/* 由 app 内四种认证 fail-closed(安全红线 D9)。
 * HTTPS 硬前提:443 listener 挂 ACM 证书(证书由 PublicEntry 造好传入);80 仅 301 跳 443。
 */
export interface EcsBackendProps {
  stackName: string;
  vpc: ec2.Vpc;
  albSecurityGroup: ec2.SecurityGroup;
  backendSecurityGroup: ec2.SecurityGroup;
  /** ALB 访问日志桶(安全合规 AwsSolutions-ELB2) */
  logBucket: s3.IBucket;
  /** 443 listener 的 ACM 证书 ARN(域名部署必填的产物;由 aim-stack 先建证书再传入)。 */
  certificateArn: string;
  /** 注入给容器的环境变量(表名/桶名/region 等,Stack 编排时填) */
  environment: Record<string, string>;
}

export class EcsBackend extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly listener: elbv2.ApplicationListener; // 暴露供 RealtimeSession 加 /rt/* path 规则(M1)
  public readonly taskRole: iam.Role;
  public readonly container: ecs.ContainerDefinition; // 暴露供后置 addEnvironment(如 CloudFront 域名)

  constructor(scope: Construct, id: string, props: EcsBackendProps) {
    super(scope, id);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `${props.stackName}-cluster`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      // 内部东西向服务发现(去 CloudFront 后 ALB 只有 443 公网证书:内部互调不走 ALB,
      // 走 Cloud Map 私有 DNS 直连——backend↔rt 的 ready/hangup/事件回报都在 VPC 内)。
      defaultCloudMapNamespace: { name: `${props.stackName}.local` },
    });

    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'AIM Orchestrator API task role (DDB/S3/KMS granted at stack end)',
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${props.stackName}-backend`,
      cpu: BACKEND_CPU,
      memoryLimitMiB: BACKEND_MEMORY,
      taskRole: this.taskRole,
      runtimePlatform: {
        cpuArchitecture: ECS_CPU_ARCH,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const image = new ecrAssets.DockerImageAsset(this, 'ApiImage', {
      directory: REPO_ROOT, // 仓库根 context(.dockerignore 已收窄到 backend+frontend 必需)
      file: 'backend/Dockerfile',
      platform: IMAGE_PLATFORM, // 对齐 task runtimePlatform(AIM_CONTAINER_ARCH)
      buildArgs: imageBuildArgs(), // 区域镜像源(中国区 npm/pip 加速),默认空
    });
    this.container = taskDef.addContainer('Api', {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'aim-api' }),
      environment: props.environment,
      portMappings: [{ containerPort: BACKEND_PORT }],
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true, // 公网入口(设计决策 去 CloudFront;域名直挂,443 only)
      securityGroup: props.albSecurityGroup,
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: BACKEND_MIN_TASKS,
      securityGroups: [props.backendSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true }, // 任务起不来时快速失败回滚,不等 3h
      cloudMapOptions: { name: 'api' }, // api.<stack>.local(rt 事件回报直连,不经公网 ALB)
    });

    // ALB 访问日志(AwsSolutions-ELB2)
    this.alb.logAccessLogs(props.logBucket, 'alb-access');

    // 443 HTTPS(唯一业务入口;HTTPS 硬前提——getUserMedia 要求 secure context)。
    // open:true = CDK 给 ALB SG 放行 0.0.0.0/0:443(公网入口本意;WAF 限速 + app 层四种认证兜底)。
    this.listener = this.alb.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS, // TLS1.2+(对齐原 CloudFront TLS_V1_2_2021 姿态)
      open: true,
    });
    const listener = this.listener;
    listener.addTargets('ApiTargets', {
      port: BACKEND_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
    });
    // 80 → 301 跳 443(不回源;习惯性 http:// 访问不落坑)。
    this.alb.addListener('HttpRedirect', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({ port: '443', protocol: 'HTTPS', permanent: true }),
    });

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: BACKEND_MIN_TASKS,
      maxCapacity: BACKEND_MAX_TASKS,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 60 });

    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
  }
}
