import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudmap from 'aws-cdk-lib/aws-servicediscovery';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { imageBuildArgs } from '../common/arch';
import {
  GPU_INSTANCE_TYPE,
  GPU_INFERENCE_PORT,
  GPU_SESSIONS_PER_INSTANCE,
  GPU_HARD_MAX,
  GPU_MAX_DRAIN_MIN,
  resolveVadEnergyThreshold,
} from '../common/constants';

/** gpu/ 源码目录(ASR+TTS WS 服务 + Dockerfile)。 */
const GPU_DIR = path.join(__dirname, '..', '..', '..', 'gpu');

/**
 * GPU 推理服务(自建 **ASR + TTS**),默认语音引擎的语音段算力。HLD §3.4.1 / design contract。
 * 形态:ECS on EC2(**G6E GPU** 实例)+ GPU 容量提供者 + ASG;ASR/TTS 模型同机常驻。
 * 接入:Bridge 经**单条 WebSocket**串 ASR/TTS(私网,不公网暴露 —— 安全红线 D9)。
 *
 * ⚠ LLM 段不在此:三段式的 LLM 走 **Bedrock(默认 Claude Haiku)**,由媒体面 Bridge 调用。
 *    故本服务 task role **绝不含 Bedrock 权限**(爆炸半径最小)。
 * ⚠ 全新部署的 GPU 机器:不复用任何既有 GPU 主机,也不沿用「ECS 网关 + 远程 GPU 反向 WS」两层拓扑。
 *
 * 骨架阶段:
 *  - 用占位镜像让 synth 通过;真实 GPU 镜像(ASR/TTS worker + WS 接入)详细设计填。
 *  - GPU AMI(ECS GPU-optimized)+ nvidia runtime 由容量提供者的 EC2 用户数据处理(占位)。
 *  - 服务私网,仅媒体面安全组可达 GPU_INFERENCE_PORT。
 */
export interface GpuInferenceProps {
  stackName: string;
  vpc: ec2.Vpc;
  /** 媒体面安全组:放通它访问本服务的 WS 端点(Bridge → GPU) */
  callerSecurityGroup?: ec2.ISecurityGroup;
  /** 其它可达 GPU WS 的来源(如控制面 backend SG,供 voice-test 网页全链路测试) */
  extraCallerSecurityGroups?: ec2.ISecurityGroup[];
  /**
   * 真实 GPU 镜像 tag(由 scripts/build-gpu-image.sh 经 CodeBuild 构建推到 ECR aim-gpu)。
   * 给定时:用该 ECR 镜像(CUDA + FunASR + 真 OmniVoice,真实模型)+ 声明 gpuCount:1。
   * 未给定:用本地 stub asset(python-slim,无 GPU 也能起,供 synth/本地冒烟)。
   */
  gpuImageTag?: string;
  /**
   * MiniMax TTS provider 配置 Secret(design contract):单一 Secret 承载 key + 非密参数 JSON。
   * GPU task role 仅"只读该 Secret"(启动读一次 + 热加载重读),**仍无 DDB/Bedrock**(014/002 红线不破)。
   * 注入 env AIM_MINIMAX_SECRET_ID 指向它;GPU minimax_config 直读。
   */
  miniMaxConfigSecret?: secretsmanager.ISecret;
  /**
   * GPU 内网控制端点共享密钥(design contract /drain + design contract /reload-tts-config 共用)。
   * 注入 env AIM_DRAIN_SECRET;backend 调 /reload-tts-config 时带 X-Drain-Secret 比对。fail-closed:
   * 未给则两端点禁用(503)。
   */
  gpuControlSecret?: secretsmanager.ISecret;
}

export class GpuInference extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.Ec2Service;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly taskRole: iam.Role;
  /** ASG(design contract:reconciler/lifecycle-handler 对账目标;capacity provider managed scaling 管其 desired) */
  public readonly autoScalingGroup: autoscaling.AutoScalingGroup;
  /** Bridge/backend 连接的 GPU WS 端点内网名(Cloud Map 私有 DNS A 记录,VPC 内通用解析) */
  public readonly wsEndpointName: string;

  constructor(scope: Construct, id: string, props: GpuInferenceProps) {
    super(scope, id);

    this.cluster = new ecs.Cluster(this, 'GpuCluster', {
      vpc: props.vpc,
      clusterName: `${props.stackName}-gpu`,
      // Cloud Map 私有命名空间(私有托管区):GPU task 在此注册标准 A 记录 gpu.<stack>-gpu.local,
      // Bridge/backend 经稳定 DNS 连 GPU,实例重建/扩缩不改配置(VPC 内通用解析,非 Service Connect)。
      defaultCloudMapNamespace: { name: `${props.stackName}-gpu.local` },
    });

    // GPU 安全组:私网,仅放通媒体面访问 WS 端点;无公网入站(安全红线 D9)
    this.securityGroup = new ec2.SecurityGroup(this, 'GpuSg', {
      vpc: props.vpc,
      description: 'GPU inference (ASR+TTS; LLM on Bedrock) - private, no public ingress',
      allowAllOutbound: true,
    });
    // 放通可达 GPU WS 端点的来源:媒体面 Bridge(真实通话)+ 控制面(voice-test 网页全链路测试)。
    const callers = [props.callerSecurityGroup, ...(props.extraCallerSecurityGroups ?? [])].filter(
      (sg): sg is ec2.ISecurityGroup => !!sg,
    );
    for (const sg of callers) {
      this.securityGroup.addIngressRule(
        sg,
        ec2.Port.tcp(GPU_INFERENCE_PORT),
        'caller to GPU WS endpoint (ASR/TTS; LLM via Bedrock, not here)',
      );
    }

    // GPU 容量提供者:G6E(L40S)EC2 ASG,ECS GPU-optimized AMI。
    // ⚠ 必须用 LaunchTemplate —— 旧式 LaunchConfiguration 不支持 g6e 等新实例族
    //    (真实部署报 "instance type g6e.xlarge is not valid")。
    const ecsInstanceRole = new iam.Role(this, 'GpuAsgInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    const launchTemplate = new ec2.LaunchTemplate(this, 'GpuLaunchTemplate', {
      instanceType: new ec2.InstanceType(GPU_INSTANCE_TYPE),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(ecs.AmiHardwareType.GPU),
      securityGroup: this.securityGroup,
      role: ecsInstanceRole,
      requireImdsv2: true,
      // 加大根卷:真实模型镜像(DLC CUDA+torch+triton 解压后达数十 GB)+ 运行时拉的模型权重(数 GB),
      // ECS GPU AMI 默认 30GB 根盘装不下 → "no space left on device" 拉镜像失败(实测部署阻塞)。
      // 120GB gp3 给足镜像层 + 权重 + 余量。
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(120, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
          encrypted: true,
        }),
      }],
      // AsgCapacityProvider 要求 LT 暴露 userData(ECS 往里追加 join-cluster 脚本)
      userData: ec2.UserData.forLinux(),
    });
    // ASG 容量管理(design contract):min=0 允许停机省钱、max=GPU_HARD_MAX 护栏;desired 不由 CDK 锁,
    // 由 capacity-reconciler 经 ECS managed scaling 在区间内调整。newInstancesProtectedFromScaleIn=true
    // 是开启 enableManagedTerminationProtection 的前置(ECS 自动管理实例 protection 标志:有 task 加、
    // task 空移除 → 缩到 0 仍可终止,见 design contract AWS 查证)。
    const asg = new autoscaling.AutoScalingGroup(this, 'GpuAsg', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minCapacity: 0,
      maxCapacity: GPU_HARD_MAX,
      newInstancesProtectedFromScaleIn: true,
      launchTemplate,
    });
    // TERMINATING:WAIT lifecycle hook:实例终止前等其在途会话 drain(由 lifecycle-handler Lambda
    // 检查 active_sessions,空闲即放行、忙则 heartbeat 续期;design contract)。heartbeatTimeout=MAX_DRAIN。
    asg.addLifecycleHook('GpuDrainHook', {
      lifecycleTransition: autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
      heartbeatTimeout: cdk.Duration.minutes(GPU_MAX_DRAIN_MIN),
      defaultResult: autoscaling.DefaultResult.CONTINUE, // 超时兜底放行(不无限挂住缩容)
    });
    const capacityProvider = new ecs.AsgCapacityProvider(this, 'GpuCapacity', {
      autoScalingGroup: asg,
      enableManagedScaling: true, // ECS 据任务放置自动调 ASG desired(reconciler 只动 ECS desiredCount)
      // ★ 不阻断"缩到 0 省钱"(AWS 文档查证 deployment validation,回应 review 疑虑):
      //   ECS managed termination protection **主动管理**实例 scale-in 保护标志 —— task 落实例时加、
      //   "When all non-daemon tasks are stopped on an instance, Amazon ECS ... turns off scale-in
      //   protection for the EC2 instance"(官方原文)→ desiredCount=0 停 task 后 ECS 自动解保护 →
      //   ASG 正常终止实例 → 计费停。newInstancesProtectedFromScaleIn=true 只是新实例**初始**加保护,
      //   非永久。故 fixed=0 真能回收实例。(per-task UpdateTaskProtection 是另一更细的在途保护,留 [~]。)
      enableManagedTerminationProtection: true,
    });
    this.cluster.addAsgCapacityProvider(capacityProvider);
    this.autoScalingGroup = asg;

    this.taskRole = new iam.Role(this, 'GpuTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      // 只做自建 ASR/TTS;LLM 走 Bedrock 由媒体面 Bridge 调用 → GPU role 绝不含 Bedrock 权限(design contract)
      description: 'GPU inference task role (self-hosted ASR/TTS; LLM on Bedrock; NO Bedrock perms here)',
    });
    // design contract:GPU 服务上报 CloudWatch 自定义指标(限 AIM/GPU 命名空间)+ 会话期续租 task scale-in
    // protection(防缩容/部署杀正忙 task)。仍**无 Bedrock**(爆炸半径最小)。
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'AIM/GPU' } },
    }));
    this.taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateTaskProtection'],
      // 限本 cluster 的 task(资源 ARN 用 cluster 名约束;task id 运行时才知,用通配)。
      // partition 动态取(分区无关红线,VISION §2:中国区是 aws-cn,硬编码 arn:aws: 会失配)。
      resources: [
        `arn:${cdk.Stack.of(this).partition}:ecs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:task/${props.stackName}-gpu/*`,
      ],
    }));
    // design contract:GPU 仅"只读 MiniMax 配置 Secret"(启动读一次 + 热加载重读)。**仍无 DDB、无 Bedrock**
    // (014/002 红线不破)—— task role 只多这一条 GetSecretValue,爆炸半径仍最小。
    if (props.miniMaxConfigSecret) {
      props.miniMaxConfigSecret.grantRead(this.taskRole);
    }

    // GPU 任务定义:从 gpu/(ASR+TTS WS 服务 + Dockerfile)构建镜像资产。
    // 默认 AIM_GPU_BACKEND=stub(无 GPU 也能起);真实部署设 funasr 并基于 CUDA base + 声明 gpuCount。
    const taskDef = new ecs.Ec2TaskDefinition(this, 'GpuTaskDef', {
      family: `${props.stackName}-gpu-inference`,
      taskRole: this.taskRole,
      networkMode: ecs.NetworkMode.AWS_VPC,
    });
    // 镜像来源二选一:
    //  - 真实 GPU(gpuImageTag 给定):用 CodeBuild 推到 ECR aim-gpu 的 CUDA+FunASR+真 OmniVoice 镜像
    //    (本机 ARM 跨构建 amd64 太慢,故 GPU 镜像走 CodeBuild,见 scripts/build-gpu-image.sh)。
    //  - stub(未给定):本地 DockerImageAsset(python-slim,无 GPU 也能起,供 synth/本地冒烟)。
    const realGpu = !!props.gpuImageTag;
    let containerImage: ecs.ContainerImage;
    if (realGpu) {
      const repo = ecr.Repository.fromRepositoryName(this, 'GpuEcrRepo', 'aim-gpu');
      repo.grantPull(this.taskRole);
      containerImage = ecs.ContainerImage.fromEcrRepository(repo, props.gpuImageTag);
    } else {
      // G6E 是 x86_64 → 镜像必须 LINUX_AMD64。
      // ★ target 必须显式 'stub':Dockerfile 是多 stage(stub + gpu),不指定则 docker 构建
      //   最后一个 stage(gpu)→ 拉 DLC pytorch base(需 ECR 登录/跨境慢/几 GB)——stub 路径
      //   本意就是轻量 python-slim(北京首次部署实测根因:未登录 DLC ECR 403)。
      const image = new ecrAssets.DockerImageAsset(this, 'GpuImage', {
        directory: GPU_DIR,
        platform: ecrAssets.Platform.LINUX_AMD64,
        target: 'stub',
        buildArgs: imageBuildArgs(),
      });
      containerImage = ecs.ContainerImage.fromDockerImageAsset(image);
    }
    // GPU 容器 env:真实 GPU 段的 backend/VAD 调参 + MiniMax Secret 指针(design contract)。
    // ★ AIM_MINIMAX_SECRET_ID 是 Secret 的 **ARN(指针,非密)**,可进 env(与表名同类);明文 key 由 GPU
    //   运行时经 secretsmanager:GetSecretValue 直读(不进模板/env)。stub 与真实 GPU 都注入(minimax 可跑在 stub 上)。
    const realGpuEnv: Record<string, string> = realGpu
      ? {
          AIM_GPU_BACKEND: 'funasr',
          AIM_GPU_IMAGE_TAG: props.gpuImageTag!,
          // 单实例并发 admission 上限(design contract):满了对 start 回 CAPACITY_FULL。默认 =
          // GPU_SESSIONS_PER_INSTANCE(单实例可服务并发,见 constants.ts);可经 env 覆盖与 GPU 实测容量对齐。
          AIM_GPU_MAX_SESSIONS: String(GPU_SESSIONS_PER_INSTANCE),
          ...(process.env.AIM_VAD_DEBUG ? { AIM_VAD_DEBUG: process.env.AIM_VAD_DEBUG } : {}),
          // VAD energy 阈值 **always emit**(review):单一事实源 constants(默认 500),部署期 env
          // AIM_VAD_ENERGY_THRESHOLD 覆盖。用 resolveVadEnergyThreshold()(空串/未设→默认,非法/≤0 fail-fast)
          // —— 不直接 `String(env ?? default)`,否则空串会原样发给 GPU → vad.py float("") 启动崩。
          AIM_VAD_ENERGY_THRESHOLD: String(resolveVadEnergyThreshold()),
          ...(process.env.AIM_VAD_HANGOVER_MS ? { AIM_VAD_HANGOVER_MS: process.env.AIM_VAD_HANGOVER_MS } : {}),
          // 声纹 embedding /embedding(design contract):并发上限 + 最小时长门(仅显式标定时透传,否则用 server.py 默认
          //   2 / 400ms)。[[cdk-env-passthrough-gap]]:新 env 须在此透传否则 deploy 静默不生效。
          ...(process.env.AIM_EMBEDDING_MAX_INFLIGHT ? { AIM_EMBEDDING_MAX_INFLIGHT: process.env.AIM_EMBEDDING_MAX_INFLIGHT } : {}),
          ...(process.env.AIM_EMBEDDING_MIN_MS ? { AIM_EMBEDDING_MIN_MS: process.env.AIM_EMBEDDING_MIN_MS } : {}),
        }
      : {};
    const containerEnv: Record<string, string> = {
      ...realGpuEnv,
      // MiniMax Secret 指针(design contract):GPU minimax_config 据此 GetSecretValue 直读 key + 非密参数。
      ...(props.miniMaxConfigSecret ? { AIM_MINIMAX_SECRET_ID: props.miniMaxConfigSecret.secretArn } : {}),
    };
    taskDef.addContainer('Inference', {
      image: containerImage,
      memoryReservationMiB: 2048,
      // 真实 GPU 镜像声明 gpuCount:1(ECS 为 task 预留/绑定 GPU,防多 task 抢卡,review)
      gpuCount: realGpu ? 1 : undefined,
      environment: Object.keys(containerEnv).length > 0 ? containerEnv : undefined,
      // GPU 控制端点共享密钥(design contract /drain + design contract /reload-tts-config + design contract /embedding):ECS 原生
      // secret 注入,运行时从 Secrets Manager 拉,不进 CFN 模板明文(review 同款)。同一密钥复用为三端点鉴权:
      //   AIM_DRAIN_SECRET(/drain·/reload-tts-config)+ AIM_EMBEDDING_SECRET(design contract /embedding 声纹门,
      //   配了即启用端点;bridge 侧注入同一密钥,两端对称;未配则 /embedding 503,bridge fail-open)。
      secrets: props.gpuControlSecret
        ? {
            AIM_DRAIN_SECRET: ecs.Secret.fromSecretsManager(props.gpuControlSecret),
            AIM_EMBEDDING_SECRET: ecs.Secret.fromSecretsManager(props.gpuControlSecret),
          }
        : undefined,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'aim-gpu' }),
      // 命名端口 'gpu-ws' 供 Service Connect 暴露为稳定私有 DNS
      portMappings: [{ name: 'gpu-ws', containerPort: GPU_INFERENCE_PORT }],
      // healthCheck 探 **readiness**(/readyz:ASR/TTS 模型加载完 + self-probe 才 200,design contract);
      // 未 ready 的 task 不进 healthy → 不被服务发现暴露给 Bridge,避免"容器起了但模型没加载完"接客。
      // 真实模型(realGpu)首启要拉数 GB 权重 + 上显存,远超 stub:startPeriod 拉满 ECS 上限 300s
      // (ECS 容器级 healthCheck startPeriod 硬上限就是 300s,>300 会被 CreateTaskDefinition 直接拒)。
      // 300s 内探测失败不计入 unhealthy;之后 retries=5 × interval=30s 再给 ~150s 缓冲,合计 ~450s 容忍窗口。
      // 若真实加载仍超此窗口,需在镜像里预烘焙模型权重(免运行时拉 ModelScope)而非再加大此值。
      healthCheck: {
        command: [
          'CMD-SHELL',
          `python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:${GPU_INFERENCE_PORT}/readyz').status==200 else 1)"`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(realGpu ? 10 : 5),
        retries: realGpu ? 5 : 3,
        startPeriod: cdk.Duration.seconds(realGpu ? 300 : 120),
      },
    });

    // 用 **Cloud Map service discovery**(不是 Service Connect)暴露稳定私有 DNS 'gpu'。
    // 关键(review):Service Connect 的名字解析发生在 Envoy sidecar 层,只有同样启用了
    // Service Connect 的 ECS 服务才能解析 gpu.<stack>-gpu.local;而本服务的客户端 —— Bridge(EC2 上
    // 裸 docker run,无 Envoy)与 backend(Fargate,未配 Service Connect)—— 都不是成员,会解析失败。
    // GPU 服务是 AWS_VPC 网络模式(task 有独立 ENI 私有 IP),cloudMapOptions 会在 <stack>-gpu.local
    // 私有托管区注册标准 A 记录 gpu→task IP,**VPC 内任意客户端用普通 DNS 即可解析**。端点名不变。
    const dnsName = 'gpu';
    this.service = new ecs.Ec2Service(this, 'GpuService', {
      cluster: this.cluster,
      taskDefinition: taskDef,
      // design contract:**完全省略 desiredCount** —— 指定值会被 CloudFormation 每次 deploy 重置,冲掉
      // reconciler/admin 运行时设的容量(尤其改 TaskDef 触发 service 更新时)。省略 → 模板无该字段 →
      // CFN 不回写;首建默认 0,由 CapacityReconciler 首轮兜底 seed(配置缺失 → 条件写 fixed_count=1,
      // capacity_reconciler.py)拉起(design contract/§3.9)。CDK UT 断言 desiredCount Match.absent()。
      securityGroups: [this.securityGroup],
      capacityProviderStrategies: [{ capacityProvider: capacityProvider.capacityProviderName, weight: 1 }],
      minHealthyPercent: 0, // 部署时允许先停后起(GPU 无滚动余量;长会话由 task protection 兜底)
      circuitBreaker: { rollback: true },
      cloudMapOptions: {
        name: dnsName,
        dnsRecordType: cloudmap.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(10), // 短 TTL:单 GPU task 重建后客户端快速重解析到新 IP
      },
    });

    // Bridge/backend 据此连 GPU WS 端点(Cloud Map 私有 DNS,标准 A 记录,VPC 内通用解析)。
    this.wsEndpointName = `${dnsName}.${props.stackName}-gpu.local`;
    new cdk.CfnOutput(this, 'GpuClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'GpuWsEndpoint', {
      value: `${this.wsEndpointName}:${GPU_INFERENCE_PORT}`,
      description: 'GPU ASR/TTS single-WS endpoint (Cloud Map private DNS A record)',
    });
  }
}
