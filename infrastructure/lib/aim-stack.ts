import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { Networking } from './constructs/networking';
import { KmsKeys } from './constructs/kms-keys';
import { S3Buckets } from './constructs/s3-buckets';
import { DynamoDbTables } from './constructs/dynamodb-tables';
import { DefaultAgentsSeed } from './constructs/default-agents-seed';
import { DefaultLlmConfigSeed } from './constructs/default-llm-config-seed';
import { CognitoAuth } from './constructs/cognito';
import { EcsBackend } from './constructs/ecs-backend';
import { PublicEntry } from './constructs/public-entry';
import { RealtimeSession } from './constructs/realtime-session';
import { GpuInference } from './constructs/gpu-inference';
import { CapacityReconciler } from './constructs/capacity-reconciler';
import { Observability } from './constructs/observability';
import { Evaluator } from './constructs/evaluator';
import { SessionScheduler } from './constructs/session-scheduler';
import { applyNagSuppressions } from './common/nag-suppressions';
import { bedrockModelsFor } from './common/bedrock-region';
import {
  BACKEND_PORT,
  GPU_INFERENCE_PORT,
  GPU_HARD_MAX,
  GPU_SESSIONS_PER_INSTANCE,
  MCP_OAUTH_CALLBACK_URL,
  assertEndpointAboveVad,
  assertSilenceGapAboveHangover,
} from './common/constants';
import { buildDeploymentManifest, serializeDeploymentManifest } from './common/deployment-manifest';

export interface AimStackProps extends cdk.StackProps {
  stackName: string;
  adminEmail: string;
  engineType: string; // s2s | three_stage(媒体面默认引擎;单场实际引擎由 Profile 决定)
}

/**
 * VivaVoce 主 Stack —— 只做编排 + 末尾统一 IAM grant(HLD §2.4 模式 1/3)。
 * 构建顺序:KMS → 网络 → 存储 → 认证 → 计算(API)→ CDN → GPU 推理 → 事件面 → 调度。
 * 电话链路(OutboundVoice/Chime VC/DID/CampaignScheduler)已删(VISION §1);
 * 实时会话服务(bridge 减法改造后 Fargate 化)在 M1 接入。
 */
export class AimStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AimStackProps) {
    super(scope, id, props);

    // 端点参数 synth 期 fail-fast 守门(误配即 synth 报错,不留到运行时):
    //  - RMS 阈值不变式 endpoint ≥ vad(constants.ts 注释久称「synth 时守门」但此前从无调用点 = dead guard;
    //    评审/review 一并接上,兑现承诺:防 350-500 错配区致空 turn_end / AI 不回话的真机根因);
    //  - design contract 时间不变式 silenceGap ≥ hangover:防口试抗抢话调长时只调 GPU AIM_VAD_HANGOVER_MS 忘了
    //    bridge AIM_ENDPOINT_SILENCE_GAP_MS 致看门狗抢在 GPU VAD 自然端点前 flush。
    assertEndpointAboveVad();
    assertSilenceGapAboveHangover();

    const region = cdk.Stack.of(this).region;
    // region 守卫在 bin/main.ts(ALLOWED_REGIONS:us-east-1 / cn-north-1 / cn-northwest-1),synth 时 fail-fast。
    // region 是具体值时取模型映射(下发 bridge/evaluator,单一事实源);是 token(环境无关 synth)
    // 时用 us-east-1 映射占位(仅影响 synth 产物,真实 deploy region 必具体)。
    const models = bedrockModelsFor(
      cdk.Token.isUnresolved(region) ? 'us-east-1' : region,
    );

    // ── 1. KMS ──
    const kms = new KmsKeys(this, 'KmsKeys', { stackName: props.stackName });

    // ── 2. 网络 ──
    const net = new Networking(this, 'Networking', { stackName: props.stackName });

    // ── 3. 存储 ──
    const buckets = new S3Buckets(this, 'S3Buckets', {
      stackName: props.stackName,
      recordingEncryptionKey: kms.recordingEncryptionKey,
    });
    const tables = new DynamoDbTables(this, 'DynamoDbTables', {
      stackName: props.stackName,
      dataEncryptionKey: kms.dataEncryptionKey,
    });

    // 预置默认 Agent(一安装即有):「自由对话」——语音 Chat 的随便聊场景(纯人设、无题库、留记录轻量评分)。
    new DefaultAgentsSeed(this, 'DefaultAgentsSeed', { agentsTable: tables.agentsTable });

    // ── 4. 认证 ──
    // VISION §2 拍板:认证所在 region 与部署 region 解耦 —— 中国区无 Cognito,复用美东池作外置
    // 标准 OIDC。外部池五件套 context(authRegion / authUserPoolId / authUserPoolClientId /
    // authMcpClientId / authHostedUiDomain)**全给**则跳过本栈 CognitoAuth(池已存在于美东,
    // admin user seeding 也随之跳过——用户在美东池侧管理);不给 = 现状(本栈建池,Global)。
    // 半配置在 synth 期 fail-fast,防手工 --context 误配。
    const extAuthKeys = [
      'authRegion',
      'authUserPoolId',
      'authUserPoolClientId',
      'authMcpClientId',
      'authHostedUiDomain',
    ] as const;
    const extAuthValues = extAuthKeys.map(
      (k) => ((this.node.tryGetContext(k) as string) || '').trim(),
    );
    const extGiven = extAuthValues.filter((v) => v !== '').length;
    if (extGiven > 0 && extGiven < extAuthKeys.length) {
      throw new Error(
        `外部认证池五件套 context 不全(给了 ${extGiven}/${extAuthKeys.length}):须同时提供 ` +
          `${extAuthKeys.join(' / ')},或全部不给(本栈自建 Cognito)。经 .env.region 设置 VIVA_AUTH_*。`,
      );
    }
    const useExternalAuth = extGiven === extAuthKeys.length;
    const [extAuthRegion, extUserPoolId, extUserPoolClientId, extMcpClientId, extHostedUiDomain] =
      extAuthValues;
    // 下游统一经此中间变量取认证参数(不直引 construct 字段 —— 外部池场景无该 construct)。
    // 显式 if 分支(review:三元 + 非空断言让编译器无法证明 localAuth 非空,重构易埋雷)。
    let auth: {
      userPoolId: string;
      userPoolClientId: string;
      mcpClientId: string;
      hostedUiDomainPrefix: string;
    };
    if (useExternalAuth) {
      auth = {
        userPoolId: extUserPoolId,
        userPoolClientId: extUserPoolClientId,
        mcpClientId: extMcpClientId,
        hostedUiDomainPrefix: extHostedUiDomain,
      };
    } else {
      // 自定义域名(供 MCP client full facade 固定回调 `https://<域>/oauth/callback`,design contract)。
      // 与下方 line ~205 的 domainName 同源(context customDomain);在 Cognito 构造前先读。缺省(无域名)
      // → appDomain 为 undefined → MCP client 回退 loopback(A-lite 行为,full facade 需公网域名才成立)。
      const cognitoAppDomain = (this.node.tryGetContext('customDomain') as string) || undefined;
      const localAuth = new CognitoAuth(this, 'CognitoAuth', {
        stackName: props.stackName,
        adminEmail: props.adminEmail,
        appDomain: cognitoAppDomain,
      });
      auth = {
        userPoolId: localAuth.userPool.userPoolId,
        userPoolClientId: localAuth.userPoolClient.userPoolClientId,
        mcpClientId: localAuth.mcpClient.userPoolClientId,
        hostedUiDomainPrefix: localAuth.hostedUiDomainPrefix,
      };
    }
    // 认证 region:外部池 = 池所在区(美东);本栈池 = 部署 region(backend AIM_AUTH_REGION 缺省
    // 亦回退 region,注入只为显式)。issuer/jwks/Hosted UI host 全由 backend 按它拼(config.py)。
    const authRegion = useExternalAuth ? extAuthRegion : region;

    // GPU WS 端点(Cloud Map 确定性私有 DNS)+ 默认 LLM 模型 —— 下发控制面(admin 容量页展示 GPU 端点等)。
    // 名字与 gpu-inference 的 cloudMapOptions 注册的 A 记录一致;此常量先于 backend/voice 定义,断循环依赖。
    const gpuWsUrl = `ws://gpu.${props.stackName}-gpu.local:${GPU_INFERENCE_PORT}/v1/stream`;
    // GPU 内网控制端点 base(design contract 热加载):backend 写完 MiniMax Secret 后 POST {base}/reload-tts-config。
    // 同 Cloud Map 私有 DNS,HTTP(非 WS);名字与 gpu-inference cloudMapOptions 注册的 A 记录一致。
    const gpuControlUrl = `http://gpu.${props.stackName}-gpu.local:${GPU_INFERENCE_PORT}`;

    // ── 5. 控制面 API(ALB + Fargate) ──
    // 候选人自助(design contract)一次性链接的 HMAC 密钥 —— Secrets Manager 生成强随机,绝不硬编码。
    const candidateTokenSecret = new secretsmanager.Secret(this, 'CandidateTokenSecret', {
      description: 'HMAC secret for candidate self-booking one-time links (design contract)',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // 委托 token(staff 授权第三方 agent,design contract)的**独立** HMAC 密钥 —— 与候选人链接密钥分离:
    // 二者信任域不同(委托 token 能代 staff 预约/改/取消,爆炸半径远大于候选人只读链接),共用一钥则
    // 泄一密钥即可伪造两域。独立生成强随机密钥,注入 AIM_DELEGATION_TOKEN_SECRET。
    const delegationTokenSecret = new secretsmanager.Secret(this, 'DelegationTokenSecret', {
      description: 'HMAC secret for staff delegation tokens (design contract), separate from candidate links',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // 媒体面→控制面状态回报(design contract)的共享密钥:bridge POST /api/sessions/{id}/events 带
    // X-Bridge-Secret;后端 fail-closed 比对。同一密钥经环境注入控制面与媒体面(媒体面接线属 007)。
    const bridgeCallbackSecret = new secretsmanager.Secret(this, 'BridgeCallbackSecret', {
      description: 'Shared secret for media-plane→control-plane status callback (design contract)',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // design contract:Realtime SDK client-secret envelope 的独立 HMAC key。backend 只签发、rt 只验签；
    // 与 join token/callback key 分离，避免任一 wire 凭据域泄露后可伪造另一域。
    const realtimeClientSecret = new secretsmanager.Secret(this, 'RealtimeClientSecret', {
      description: 'HMAC key for Viva Realtime SDK-compatible client secrets (design contract)',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // MCP OAuth facade(design contract)HMAC 签名 state 的**独立**密钥:facade /oauth/authorize 把 client 真实
    // loopback redirect_uri 打进签名 state,/oauth/callback 验签取回(破解 Cognito redirect_uri 白名单)。
    // 独立密钥(信任域与 bridge/委托/候选人分离,泄一钥不牵连他域)。仅 backend 只读。**防篡改+限时,不防重放**。
    const mcpFacadeStateSecret = new secretsmanager.Secret(this, 'McpFacadeStateSecret', {
      description: 'HMAC secret for MCP OAuth facade signed state (design contract full facade)',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // MiniMax TTS provider 配置(design contract):**单一 Secret** 承载 key + 非密参数 JSON(enabled/base_url/
    // model/voice_map/api_key)。admin 经 backend 写;GPU 只读直读。初值 {} 表示未配置(enabled=false)。
    // 明文 key 绝不进 CFN 模板/env(backend 经 PutSecretValue 写,GPU 经 GetSecretValue 读)。
    const miniMaxConfigSecret = new secretsmanager.Secret(this, 'MiniMaxConfigSecret', {
      description: 'MiniMax TTS provider config (key + non-secret params JSON, design contract)',
      secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
    });
    // GPU 内网控制端点共享密钥(design contract /drain + design contract /reload-tts-config 共用):GPU 据此 fail-closed
    // 鉴权(X-Drain-Secret 常量时间比对);backend 调 /reload-tts-config 时带同密钥。注入两端均经 ECS 原生 secret。
    const gpuControlSecret = new secretsmanager.Secret(this, 'GpuControlSecret', {
      description: 'Shared secret for GPU internal control endpoints /drain + /reload-tts-config (design contract)',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // 三段式 LLM 配置(design contract):单一 Secret 承载 mantle host + 模型清单 + default_model + Bearer token。
    // **仅控制面 backend 读**(发起时逐通注入 /dial;媒体面 Bridge 不持系统级 token,不 GetSecretValue)。
    // admin 经 backend PUT /api/admin/llm-config 写。初值 {} = 未配置(admin 页填 host/清单/token 后生效)。
    // 明文 token 绝不进 CFN 模板/env(backend 经 Put/GetSecretValue 走 Secret,grant 在末尾)。
    const llmConfigSecret = new secretsmanager.Secret(this, 'LlmConfigSecret', {
      description: 'Three-stage LLM config: mantle host + model catalog + bearer token JSON (design contract)',
      secretStringValue: cdk.SecretValue.unsafePlainText('{}'),
    });

    // 预置默认 LLM 配置(一安装即有):默认 models 清单 + default_model=GLM + evaluator_model=minimax-m2.5。
    // 分区感知:非中国清单含 Sonnet 5 / Haiku 4.5(Anthropic 仅非中国可用),中国区不含 Anthropic(地域封锁)。
    // 仅缺失时 seed,不覆盖已配的 token/enabled。token 仍需 admin 填。
    new DefaultLlmConfigSeed(this, 'DefaultLlmConfigSeed', {
      llmConfigSecret,
      isCnPartition: cdk.Token.isUnresolved(region) ? false : region.startsWith('cn-'),
    });

    // ── 域名/证书(HTTPS 硬前提,设计决策):域名三件套 context **必填** ──
    // getUserMedia(麦克风)要求 secure context,无 HTTPS 产品不可用 → synth 期 fail-fast。
    // 证书在 EcsBackend 之前建(443 listener 需要);WAF/DNS alias 在 PublicEntry(ALB 之后)。
    const domainName = (this.node.tryGetContext('customDomain') as string) || '';
    const zoneId = (this.node.tryGetContext('customDomainZoneId') as string) || '';
    const zoneName = (this.node.tryGetContext('customDomainZoneName') as string) || '';
    if (!domainName || !zoneId || !zoneName) {
      throw new Error(
        'HTTPS 硬前提:必须提供域名三件套 context(customDomain / customDomainZoneId / ' +
          'customDomainZoneName)——公网 ALB 仅 443,无证书无法部署(getUserMedia 要求 secure context)。' +
          '经 .env.region 设置 VIVA_CUSTOM_DOMAIN / VIVA_ROUTE53_ZONE_ID / VIVA_ROUTE53_ZONE_NAME。',
      );
    }
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'PublicZone', {
      hostedZoneId: zoneId,
      zoneName: zoneName,
    });
    const albCert = new acm.Certificate(this, 'AlbCert', {
      domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    const backend = new EcsBackend(this, 'BackendService', {
      stackName: props.stackName,
      vpc: net.vpc,
      albSecurityGroup: net.albSecurityGroup,
      backendSecurityGroup: net.backendSecurityGroup,
      logBucket: buckets.logBucket,
      certificateArn: albCert.certificateArn,
      environment: {
        AWS_REGION: region,
        // 注:platform(teams/feishu)是 per-Campaign/Session 属性,存 DynamoDB,不在部署环境变量里。
        DEFAULT_ENGINE_TYPE: props.engineType, // 媒体面默认引擎;单场实际引擎由 Agent 决定
        AGENTS_TABLE_NAME: tables.agentsTable.tableName,
        QUESTION_BANKS_TABLE_NAME: tables.questionBanksTable.tableName,
        TARGETS_TABLE_NAME: tables.targetsTable.tableName,
        CAMPAIGNS_TABLE_NAME: tables.campaignsTable.tableName,
        SESSIONS_TABLE_NAME: tables.sessionsTable.tableName,
        RESULTS_TABLE_NAME: tables.resultsTable.tableName,
        SESSION_EVENTS_TABLE_NAME: tables.sessionEventsTable.tableName,
        SLOT_POOLS_TABLE_NAME: tables.slotPoolsTable.tableName,  // 候选人自助时段池(design contract)
        INTEGRATION_TABLE_NAME: tables.integrationTable.tableName,  // API client/Webhook/幂等(design contract)
        SYSTEM_CONFIG_TABLE_NAME: tables.systemConfigTable.tableName,  // GPU 容量 config/live(design contract)
        // 注:两个密钥不放 environment(明文进 CFN 模板,review)→ 用 ECS 原生 secret 注入,见下方 addSecret。
        RECORDING_BUCKET_NAME: buckets.recordingBucket.bucketName,
        USER_POOL_ID: auth.userPoolId,
        USER_POOL_CLIENT_ID: auth.userPoolClientId,
        // 认证 region 解耦(VISION §2):issuer/jwks/Hosted UI 按它拼;Global = region(零变化),
        // 中国区 = us-east-1(外部美东池)。
        AIM_AUTH_REGION: authRegion,
        // design contract:MCP OAuth code-flow client_id(`/api/mcp` Bearer 分支的 allowed client_id)+ Hosted UI
        //   域前缀(backend 拼 AS metadata 的 authorize/token/revoke host)。WebClient 配置不动。
        AIM_MCP_CLIENT_ID: auth.mcpClientId,
        AIM_COGNITO_HOSTED_UI_DOMAIN: auth.hostedUiDomainPrefix,
        // design contract(认证外置 M2 地基):角色来源 claim 名(默认 cognito:groups = 现状逐字节等价)+ 值映射
        //   (JSON,坏配置 backend fail-fast)。无条件透传(同 USER_POOL_ID 款,默认值使 task def 恒含此键→env 变更升版
        //   信号)。空串 → backend getenv 得 '' → _parse_role_map 视作 None 恒等,默认部署行为不变。**仅 backend**:
        //   角色门控只在控制面(实时服务用 join token / evaluator 无 HTTP 鉴权 / GPU 无 Cognito,均不透传)。
        AIM_ROLE_CLAIM: process.env.AIM_ROLE_CLAIM || 'cognito:groups',
        AIM_ROLE_MAP: process.env.AIM_ROLE_MAP || '',
        // GPU WS 端点(admin 容量页展示;voice-test 网页全链路已删,此 env 现仅供只读展示)
        AIM_GPU_WS_URL: gpuWsUrl,
        // 三段式 LLM 的 **IAM 回退默认模型**(inference profile;未配 mantle token 时用,= design contract 前原行为)。
        //   配了 mantle token 时,模型走 LlmConfigSecret 的清单/默认(mantle bare id),不看此 env。
        AIM_LLM_MODEL_ID: models.llmDefault,
        // design contract:LLM 配置 Secret 指针(ARN,非密)。配了 token 才启用 mantle;否则回退上面的 IAM 路径。
        //   明文 token 不在此(backend 经 Get/PutSecretValue,grant 末尾)。
        AIM_LLM_CONFIG_SECRET_ID: llmConfigSecret.secretArn,
        // MiniMax TTS provider(design contract):Secret 指针(ARN,非密)+ GPU 热加载 base。
        // 明文 key 不在此(backend 经 GetSecretValue/PutSecretValue 走 Secret,grant 在末尾);
        // GPU 控制密钥经 ECS 原生 secret 注入(见下 addSecret AIM_DRAIN_SECRET)。
        AIM_MINIMAX_SECRET_ID: miniMaxConfigSecret.secretArn,
        AIM_GPU_CONTROL_URL: gpuControlUrl,
        // 全局并发闸门(design contract:静态值=**安全阀/硬顶**,运行时真实容量由 reconciler 写 DDB live.serviceable 主导)。
        // ★ MAX_CONCURRENCY = GPU 硬上限对应并发(GPU_HARD_MAX × 每实例),给 autoscaling 留满弹性空间;
        //   否则 _effective_max_concurrency=min(静态, live) 被原 3 封死,GPU 扩到多实例时多出并发被丢弃(review)。
        MAX_CONCURRENCY: String(GPU_HARD_MAX * GPU_SESSIONS_PER_INSTANCE),
        // AIM_GPU_CAPACITY = 仅 live **缺失**(首次部署、reconciler 首轮前)的**保守**兜底 = 1 实例并发,
        //   避免首启窗口按硬顶超派(此时实际只有 0-1 台 ready)。reconciler 一轮后(≤1min)即被 live 取代。
        AIM_GPU_CAPACITY: String(GPU_SESSIONS_PER_INSTANCE),
        // AIM_BRIDGE_DIAL_URL 在媒体面 NLB 建好后由下方 addEnvironment 注入(断循环依赖)。
      },
    });
    // ★ 密钥用 ECS 原生 secret 注入(review):运行时从 Secrets Manager 拉,**不进 CFN 模板明文**。
    backend.container.addSecret('AIM_CANDIDATE_TOKEN_SECRET', ecs.Secret.fromSecretsManager(candidateTokenSecret));
    backend.container.addSecret('AIM_DELEGATION_TOKEN_SECRET', ecs.Secret.fromSecretsManager(delegationTokenSecret));
    backend.container.addSecret('AIM_BRIDGE_CALLBACK_SECRET', ecs.Secret.fromSecretsManager(bridgeCallbackSecret));
    backend.container.addSecret('AIM_REALTIME_CLIENT_SECRET', ecs.Secret.fromSecretsManager(realtimeClientSecret));
    backend.container.addSecret('AIM_MCP_FACADE_STATE_SECRET', ecs.Secret.fromSecretsManager(mcpFacadeStateSecret));  // design contract
    // GPU 控制密钥(design contract 热加载):backend 调 GPU /reload-tts-config 时带 X-Drain-Secret = 此密钥。
    // 经 env AIM_DRAIN_SECRET(config.gpu_control_secret 读它);ECS 原生 secret 注入,不进模板明文。
    backend.container.addSecret('AIM_DRAIN_SECRET', ecs.Secret.fromSecretsManager(gpuControlSecret));

    // ── 6. 公网入口(设计决策 去 CloudFront):WAF REGIONAL 挂 ALB + DNS alias ──
    // 前端 config.json 由 backend 动态渲染(env 注入,不再有 S3 BucketDeployment)。
    new PublicEntry(this, 'PublicEntry', {
      stackName: props.stackName,
      alb: backend.alb,
      domainName,
      zone: hostedZone,
    });
    // 公网 API base = 自有域名(design contract:委托 MCP 配置回填 endpoint)。
    backend.container.addEnvironment('AIM_PUBLIC_API_BASE', `https://${domainName}`);
    // /config.json 动态渲染所需(mcp-remote 固定 loopback 回调 URL,design contract)。
    backend.container.addEnvironment('AIM_MCP_OAUTH_CALLBACK_URL', MCP_OAUTH_CALLBACK_URL);
    // design contract:部署清单(非密)注入 —— 让运维在只读诊断页看到「部署时固化」的常量。
    //   MUST 由 CDK 机械生成,MUST NOT 在 Python 手抄 constants.ts(那会造出第二份可写副本,
    //   实测手抄默认值 46% 出错)。清单只含**在清单之外**有独立 consumer 的常量(消除自指)。
    backend.container.addEnvironment(
      'AIM_DEPLOYMENT_MANIFEST',
      serializeDeploymentManifest(
        buildDeploymentManifest({ region: this.region, stackName: props.stackName }),
      ),
    );

    // gpuWsUrl 已在 backend 段前定义(确定性 Cloud Map 私有 DNS,断开 voice↔gpu 循环依赖)。
    // 真实 GPU 镜像 tag(context gpuImageTag;由 scripts/build-gpu-image.sh 经 CodeBuild 构建)。
    const gpuImageTag = this.node.tryGetContext('gpuImageTag') as string | undefined;

    // ── 6b. 实时会话服务(M1,VISION §3:bridge Fargate 化;共享 backend 的 cluster/ALB) ──
    // 客户端 → 公网 ALB 443 /rt/* → 本服务 :3001。WS 首帧 join token 鉴权(D9)。
    const rt = new RealtimeSession(this, 'RealtimeSession', {
      stackName: props.stackName,
      vpc: net.vpc,
      cluster: backend.cluster,
      alb: backend.alb,
      listener: backend.listener,
      bridgeCallbackSecret,
      realtimeClientSecret,
      backendSecurityGroup: net.backendSecurityGroup,
      environment: {
        AWS_REGION: region,
        AIM_GPU_WS_URL: gpuWsUrl,
        AIM_LLM_MODEL_ID: models.llmDefault, // IAM 回退默认模型(mantle token 逐通注入时不看)
        SESSION_EVENTS_TABLE_NAME: tables.sessionEventsTable.tableName, // FINAL 转写 + turn metrics
        RECORDING_BUCKET_NAME: buckets.recordingBucket.bucketName, // 双声道录音上传
        // 事件回报回控制面(connected/completed):Cloud Map 私有 DNS 直连 backend
        //(去 CloudFront 后 ALB 443 证书是公网域名的,内部东西向不绕公网,走服务发现)。
        AIM_CONTROL_CALLBACK_URL: `http://api.${props.stackName}.local:${BACKEND_PORT}/api`,
        // 误打断恢复(design contract + design contract 主力):疑似打断先 tentative-pause(暂停不销毁),恢复窗内无真接管
        // 则续播,治「随便有点背景音就打断」。开启后 ready 帧带 false_interruption_recovery=true,客户端
        // detectBargeIn 短路(打断判定统一交服务端)。
        //
        // ★ design contract B 类:此处原有 `AIM_FALSE_INTERRUPTION_RECOVERY: '1'` **硬编码已删** ——
        //   它是「默认值的第二份可写副本」(bridge 代码默认关、CDK 无条件塞 '1',线上事实上恒开,
        //   代码默认成了不生效的摆设)。现默认值已搬回 `turn-handling.ts::TURN_HANDLING_DEFAULTS`
        //   (recoveryEnabled: true),**行为等价重构**;要关设 `AIM_FALSE_INTERRUPTION_RECOVERY=0`(kill switch)。
        //   MUST NOT 加回无条件透传 —— 那会重新盖住代码默认值,并让「改默认」变成无效操作。
        //   但 **kill switch 必须有路可走**:补条件透传,否则设了 `=0` 也进不了容器
        //   ([[cdk-env-passthrough-gap]]:代码读 env 而 CDK 不透传 = 静默不生效)。
        ...(process.env.AIM_FALSE_INTERRUPTION_RECOVERY
          ? { AIM_FALSE_INTERRUPTION_RECOVERY: process.env.AIM_FALSE_INTERRUPTION_RECOVERY }
          : {}),
        // design contract:出题游标推进闭环——AI 未把当前题独立念出则不推进(治「AI 揉合/吞题、evaluator 冤判考生
        // 未作答」)。**design contract C 类:确实未标定,保持默认关**(validation rationale 记真机 stall 发生率 1/3、
        // 明写「默认开启前应调 questionVoiced 阈值或多轮观察」→ 最佳值未找到,不做「默认值即最佳值」转换)。
        // ⚠ 此处是**唯一的无条件透传**(`?? '0'`):它会盖住 bridge 代码默认值。C 类维持现状故不动;
        //   若将来标定完成转默认开,MUST 同时删掉这行的 `?? '0'`,否则改了默认也不生效。
        AIM_CURSOR_VOICED_GATE: process.env.AIM_CURSOR_VOICED_GATE ?? '0',
        // design contract:端点静音容忍(治「口试思考停顿被判说完 → AI 抢话」)。**design contract B 类:默认已改 1500**
        // (原 900);此处仅作调参入口。与 GPU AIM_VAD_HANGOVER_MS 两处同向调长——synth 期
        // assertSilenceGapAboveHangover 守 silenceGap ≥ hangover(防只调一处致看门狗抢跑)。
        ...(process.env.AIM_ENDPOINT_SILENCE_GAP_MS
          ? { AIM_ENDPOINT_SILENCE_GAP_MS: process.env.AIM_ENDPOINT_SILENCE_GAP_MS }
          : {}),
        // design contract:旁路 EOU 事后纠偏(判「说完没」→ 判 incomplete 期降 barge 门槛让考生亚阈续说触发暂停)。
        // **design contract B 类:默认已改开**(原默认关);此处仅作 kill switch / 调参入口,仅设了才透传。
        // 前置门 = 误打断恢复(亦已默认开);关联窗默认 7000、降门槛窗默认 2500(design contract 已解耦为两参数)。
        ...(process.env.AIM_EOU_CORRECTION_ENABLED
          ? { AIM_EOU_CORRECTION_ENABLED: process.env.AIM_EOU_CORRECTION_ENABLED }
          : {}),
        ...(process.env.AIM_EOU_CORRELATION_MS
          ? { AIM_EOU_CORRELATION_MS: process.env.AIM_EOU_CORRELATION_MS }
          : {}),
        ...(process.env.AIM_EOU_VERDICT_TIMEOUT_MS
          ? { AIM_EOU_VERDICT_TIMEOUT_MS: process.env.AIM_EOU_VERDICT_TIMEOUT_MS }
          : {}),
        ...(process.env.AIM_EOU_SUB_THRESHOLD_MULT
          ? { AIM_EOU_SUB_THRESHOLD_MULT: process.env.AIM_EOU_SUB_THRESHOLD_MULT }
          : {}),
        // design contract:AI 开口冷却窗(治开口瞬间 refPeak≈0 门槛塌陷 + 顺口「嗯」误触发暂停)。默认关(未设 env
        // 则 bridge 默认 openCooldownMs=0,逐字节等价);仅设了才透传。部署验证标定后再定默认。
        ...(process.env.AIM_BARGE_OPEN_COOLDOWN_MS
          ? { AIM_BARGE_OPEN_COOLDOWN_MS: process.env.AIM_BARGE_OPEN_COOLDOWN_MS }
          : {}),
        ...(process.env.AIM_BARGE_OPEN_COOLDOWN_MULT
          ? { AIM_BARGE_OPEN_COOLDOWN_MULT: process.env.AIM_BARGE_OPEN_COOLDOWN_MULT }
          : {}),
        // design contract:恢复窗能量域顺延硬上限(tentative-pause 期每帧高能量重置恢复窗计时,给断续插话用
        // 泄漏累计器攒到 takeover 的机会,但从暂停起点算超此上限强制 resume)。默认 0=关
        // (退回固定 wall-clock);仅设了才透传。
        // 依赖 recovery(已硬编码开)。部署验证标定后再定默认。一并透传,免后续标定 R3 再改 CDK。
        ...(process.env.AIM_FALSE_INTERRUPTION_MAX_HOLD_MS
          ? { AIM_FALSE_INTERRUPTION_MAX_HOLD_MS: process.env.AIM_FALSE_INTERRUPTION_MAX_HOLD_MS }
          : {}),
        // takeover 泄漏累计的低能量衰减系数,运行时默认 0.5;仅显式标定时覆盖。
        ...(process.env.AIM_RECOVERY_TAKEOVER_DECAY
          ? { AIM_RECOVERY_TAKEOVER_DECAY: process.env.AIM_RECOVERY_TAKEOVER_DECAY }
          : {}),
        // design contract:TTS 24k→16k 降采样抗混叠低通(消杂音)。**默认开**(代码硬编码,无 env 部署仍生效);
        // 仅显式覆盖(A/B 回退 AIM_TTS_ANTIALIAS=0 / 调 fc、taps)时透传([[cdk-env-passthrough-gap]] 教训:
        // 默认不依赖 env,故无 env 时默认行为正确;设了才透传以生效)。
        ...(process.env.AIM_TTS_ANTIALIAS
          ? { AIM_TTS_ANTIALIAS: process.env.AIM_TTS_ANTIALIAS }
          : {}),
        ...(process.env.AIM_TTS_ANTIALIAS_TAPS
          ? { AIM_TTS_ANTIALIAS_TAPS: process.env.AIM_TTS_ANTIALIAS_TAPS }
          : {}),
        ...(process.env.AIM_TTS_ANTIALIAS_FC_HZ
          ? { AIM_TTS_ANTIALIAS_FC_HZ: process.env.AIM_TTS_ANTIALIAS_FC_HZ }
          : {}),
        // design contract:收尾挂断按已下发音频时长推算客户端播放完成再切(治跨境告别句尾音被固定 1.5s 延迟切断)。
        // ★ design contract A 类:`AIM_FAREWELL_TTS_DRAIN_ENABLED` 开关**已删**(bridge 侧恒生效),故此处**不再透传**。
        //   MUST NOT 加回 —— 留一个「关掉修复」的开关等于留一条静默回退到已知 bug 的路径(先前的部署回归)。
        //   TAIL=网络/缓冲余量,DRAIN_MAX=硬上限(防黑洞永久不挂),这两个仍是调参入口、保留条件透传。
        ...(process.env.AIM_FAREWELL_TAIL_MS ? { AIM_FAREWELL_TAIL_MS: process.env.AIM_FAREWELL_TAIL_MS } : {}),
        ...(process.env.AIM_FAREWELL_DRAIN_MAX_MS
          ? { AIM_FAREWELL_DRAIN_MAX_MS: process.env.AIM_FAREWELL_DRAIN_MAX_MS }
          : {}),
        // design contract 快速缓解并存:固定挂断延迟(drain 关时的兜底,跨境可先调长作快速缓解)。
        ...(process.env.AIM_FAREWELL_HANGUP_DELAY_MS
          ? { AIM_FAREWELL_HANGUP_DELAY_MS: process.env.AIM_FAREWELL_HANGUP_DELAY_MS }
          : {}),
        // RMS 诊断日志(真机标定 barge 门槛/开口冷却用):AIM_RMS_DIAG=1 周期打印入向 RMS vs 动态门槛 +「开口冷却×N」
        // 标记。仅设了才透传;标定期开、验完关(日志量大,不宜常开)。EVERY 控制打印稀疏度(默认每 25 帧≈0.5s)。
        ...(process.env.AIM_RMS_DIAG ? { AIM_RMS_DIAG: process.env.AIM_RMS_DIAG } : {}),
        ...(process.env.AIM_RMS_DIAG_EVERY ? { AIM_RMS_DIAG_EVERY: process.env.AIM_RMS_DIAG_EVERY } : {}),
        // design contract 违规检测与旁路裁判(需求3)。裁判 model 逐通下发(不走 env);此处透传的是**运行时 knobs**——
        // 全默认关/保守值,仅设了 env 才透传(否则用 bridge 默认,逐字节等价现状)。[[cdk-env-passthrough-gap]]:
        // 新 flag MUST 在此透传否则 deploy 静默不生效。一次性透传 R1/R2/R3/R4 全部 knobs,免后续模块再改 CDK。
        //   AIM_VIOLATION_ENFORCEMENT:强制结束/警告/fail 挂断总开关(默认关=只 shadow 观察,不产生用户可感知动作);
        //   AIM_SILENCE_VIOLATION_MS/WARN_MAX/NO_FRAME_MS:R1 沉默计数阈值/警告上限/断流判定(默认 10000/3/30000);
        //   AIM_MODERATION_TIMEOUT_MS/CONFIDENCE_THRESHOLD/MAX_INFLIGHT:R2 裁判超时/高置信阈/并发(默认 8000/0.8/3);
        //   AIM_IDLE_CHATTER_MIN_TURNS:R4 消极对抗判定的跨轮重复次数(默认 2);
        //   AIM_FORCED_END_MAX_WAIT_MS:R3 违规结束前等原因句播完的硬上限(默认 10000);
        //   AIM_SEVERE_VIOLATION_MAX:R3 严重违规硬结束阈值(<此值警告、>=结束,默认 2)。
        ...(process.env.AIM_VIOLATION_ENFORCEMENT
          ? { AIM_VIOLATION_ENFORCEMENT: process.env.AIM_VIOLATION_ENFORCEMENT }
          : {}),
        ...(process.env.AIM_SILENCE_VIOLATION_MS
          ? { AIM_SILENCE_VIOLATION_MS: process.env.AIM_SILENCE_VIOLATION_MS }
          : {}),
        ...(process.env.AIM_SILENCE_WARN_MAX ? { AIM_SILENCE_WARN_MAX: process.env.AIM_SILENCE_WARN_MAX } : {}),
        ...(process.env.AIM_NO_FRAME_MS ? { AIM_NO_FRAME_MS: process.env.AIM_NO_FRAME_MS } : {}),
        ...(process.env.AIM_MODERATION_TIMEOUT_MS
          ? { AIM_MODERATION_TIMEOUT_MS: process.env.AIM_MODERATION_TIMEOUT_MS }
          : {}),
        ...(process.env.AIM_MODERATION_CONFIDENCE_THRESHOLD
          ? { AIM_MODERATION_CONFIDENCE_THRESHOLD: process.env.AIM_MODERATION_CONFIDENCE_THRESHOLD }
          : {}),
        // 注:AIM_MODERATION_MAX_INFLIGHT 已移除(R4 review 裁判改串行,并发上限无意义)。
        ...(process.env.AIM_IDLE_CHATTER_MIN_TURNS
          ? { AIM_IDLE_CHATTER_MIN_TURNS: process.env.AIM_IDLE_CHATTER_MIN_TURNS }
          : {}),
        ...(process.env.AIM_FORCED_END_MAX_WAIT_MS
          ? { AIM_FORCED_END_MAX_WAIT_MS: process.env.AIM_FORCED_END_MAX_WAIT_MS }
          : {}),
        ...(process.env.AIM_SEVERE_VIOLATION_MAX
          ? { AIM_SEVERE_VIOLATION_MAX: process.env.AIM_SEVERE_VIOLATION_MAX }
          : {}),
        // design contract:答完补充宽限窗(延迟推进,engine 内)。判「当前题正常已作答该推进」时不立即推进,留静默
        //   宽限窗(默认 4000ms);窗内用户再开口→取消推进当本题续答,窗内无声→到期才推进+自动问下一题。别误伤
        //   「边想边答/答完想补充」的用户。<=0=关(逐字节等价现状)。[[cdk-env-passthrough-gap]]:仅设了才透传
        //   (未设则用 bridge 默认 4000);真机标定后再定线上值。
        ...(process.env.AIM_ANSWER_GRACE_MS
          ? { AIM_ANSWER_GRACE_MS: process.env.AIM_ANSWER_GRACE_MS }
          : {}),
        ...(process.env.AIM_AUTO_NEXT_GRACE_MS
          ? { AIM_AUTO_NEXT_GRACE_MS: process.env.AIM_AUTO_NEXT_GRACE_MS }
          : {}),
        // design contract:播放后推进时钟以「客户端估算播完」为起点(治 tts_done≠客户端播完的早推进)。
        //   AIM_MAX_PLAYBACK_LEAD_MS(默认 35000,[0,120000]):超前量上限,防队尾虚高时长时间不推进(clamp 到上限);
        //   AIM_PLAYBACK_LEAD_MARGIN_MS(默认 1000,[0,5000]):播完余量,独立于 farewell TAIL(语义不同,不复用)。
        //   [[cdk-env-passthrough-gap]]:仅设了 env 才透传(未设用 bridge 默认,逐字节等价);真机标定后再定线上值。
        ...(process.env.AIM_MAX_PLAYBACK_LEAD_MS
          ? { AIM_MAX_PLAYBACK_LEAD_MS: process.env.AIM_MAX_PLAYBACK_LEAD_MS }
          : {}),
        ...(process.env.AIM_PLAYBACK_LEAD_MARGIN_MS
          ? { AIM_PLAYBACK_LEAD_MARGIN_MS: process.env.AIM_PLAYBACK_LEAD_MARGIN_MS }
          : {}),
        // design contract:每题独立追问预算(默认 2,整数 [0,5]) + 强制收口/末题/terminal/post-terminal 缓冲完成硬超时
        // (沿用 AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS,默认 15000ms,[1000,60000]);仅显式设置时透传。
        ...(process.env.AIM_QUESTION_MAX_FOLLOW_UPS
          ? { AIM_QUESTION_MAX_FOLLOW_UPS: process.env.AIM_QUESTION_MAX_FOLLOW_UPS }
          : {}),
        ...(process.env.AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS
          ? { AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS: process.env.AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS }
          : {}),
        // design contract:声纹锁定说话人(抗旁人打断)。GPU 声纹 embedding 端点 URL(Cloud Map 私有 DNS,与 gpuControlUrl
        //   同址);secret 经下方 addSecret 注入(与 GPU 同一 gpuControlSecret,两端对称)。effective_speaker_lock
        //   = Agent 请求 && AIM_SPEAKER_LOCK_ENABLED != "0" && recovery 开(D7)。**默认开、上线即生效**(设计决策);
        //   一切不确定 → fail-open 退纯能量(最坏等价现状)。[[cdk-env-passthrough-gap]]:新 env MUST 在此透传否则
        //   deploy 静默不生效。URL 恒透传(端点地址,非行为旋钮);阈值/时长类仅设了才透传(未设用 bridge/design contract 默认)。
        AIM_GPU_EMBEDDING_URL: `${gpuControlUrl}/embedding`,
        ...(process.env.AIM_SPEAKER_LOCK_ENABLED
          ? { AIM_SPEAKER_LOCK_ENABLED: process.env.AIM_SPEAKER_LOCK_ENABLED }
          : {}),
        ...(process.env.AIM_SPEAKER_LOCK_THRESHOLD_HIGH
          ? { AIM_SPEAKER_LOCK_THRESHOLD_HIGH: process.env.AIM_SPEAKER_LOCK_THRESHOLD_HIGH }
          : {}),
        ...(process.env.AIM_SPEAKER_LOCK_THRESHOLD_LOW
          ? { AIM_SPEAKER_LOCK_THRESHOLD_LOW: process.env.AIM_SPEAKER_LOCK_THRESHOLD_LOW }
          : {}),
        ...(process.env.AIM_SPEAKER_LOCK_ENROLL_MS
          ? { AIM_SPEAKER_LOCK_ENROLL_MS: process.env.AIM_SPEAKER_LOCK_ENROLL_MS }
          : {}),
        ...(process.env.AIM_SPEAKER_LOCK_ENROLL_GAP_MS
          ? { AIM_SPEAKER_LOCK_ENROLL_GAP_MS: process.env.AIM_SPEAKER_LOCK_ENROLL_GAP_MS }
          : {}),
        ...(process.env.AIM_SPEAKER_LOCK_ENROLL_CONSISTENCY
          ? { AIM_SPEAKER_LOCK_ENROLL_CONSISTENCY: process.env.AIM_SPEAKER_LOCK_ENROLL_CONSISTENCY }
          : {}),
        ...(process.env.AIM_SPEAKER_LOCK_TIMEOUT_MS
          ? { AIM_SPEAKER_LOCK_TIMEOUT_MS: process.env.AIM_SPEAKER_LOCK_TIMEOUT_MS }
          : {}),
        ...(process.env.AIM_SPEAKER_LOCK_MIN_VERIFY_MS
          ? { AIM_SPEAKER_LOCK_MIN_VERIFY_MS: process.env.AIM_SPEAKER_LOCK_MIN_VERIFY_MS }
          : {}),
        ...(process.env.AIM_SPEAKER_LOCK_VERIFY_WINDOW_MS
          ? { AIM_SPEAKER_LOCK_VERIFY_WINDOW_MS: process.env.AIM_SPEAKER_LOCK_VERIFY_WINDOW_MS }
          : {}),
        ...(process.env.AIM_SPEAKER_LOCK_EMA
          ? { AIM_SPEAKER_LOCK_EMA: process.env.AIM_SPEAKER_LOCK_EMA }
          : {}),
        // design contract:客户端真播完 ACK。[[cdk-env-passthrough-gap]]:仅设了才透传。
        // ★ design contract A 类:`AIM_PLAYBACK_ACK_MODE`(off|observe|enforce)**已删**——结算恒生效,
        //   `playback_superseded` 下发亦不再依赖任何协商。**MUST NOT 加回**:部署期环境覆盖可能
        //   被后续发布静默丢失,从而让旧轮音频继续播放。
        //   timeout 三参(grace/maxWait/inputGrace)+ 跨参数不变量(maxWait≥maxLead+grace)在 bridge
        //   loadAckTimeoutConfig 校验,非法 fail-fast;未设用 bridge 默认(3000/45000/1000)。
        ...(process.env.AIM_PLAYBACK_ACK_GRACE_MS
          ? { AIM_PLAYBACK_ACK_GRACE_MS: process.env.AIM_PLAYBACK_ACK_GRACE_MS }
          : {}),
        ...(process.env.AIM_PLAYBACK_ACK_MAX_WAIT_MS
          ? { AIM_PLAYBACK_ACK_MAX_WAIT_MS: process.env.AIM_PLAYBACK_ACK_MAX_WAIT_MS }
          : {}),
        ...(process.env.AIM_PLAYBACK_ACK_INPUT_GRACE_MS
          ? { AIM_PLAYBACK_ACK_INPUT_GRACE_MS: process.env.AIM_PLAYBACK_ACK_INPUT_GRACE_MS }
          : {}),
      },
    });
    // design contract:声纹 embedding 端点鉴权密钥 —— bridge 与 GPU 注入**同一** gpuControlSecret(两端 X-Embedding-Secret
    // 对称);ECS 原生 secret 注入,不进 CFN 模板明文。未注入则 GPU /embedding 503、bridge embedder 返 null → fail-open。
    rt.container.addSecret('AIM_EMBEDDING_SECRET', ecs.Secret.fromSecretsManager(gpuControlSecret));
    // 控制面 → 实时会话服务预创建(ready/hangup):Cloud Map 直连 rt(同上,不经公网 ALB)。
    backend.container.addEnvironment(
      'AIM_BRIDGE_DIAL_URL', `http://rt.${props.stackName}.local:3001`);
    // rt 事件回报 → backend :8000(Cloud Map 直连):backend SG 放行 rt SG。
    net.backendSecurityGroup.addIngressRule(
      rt.securityGroup, ec2.Port.tcp(BACKEND_PORT), 'rt event callback to backend (Cloud Map)');

    // ── 7. 三段式 GPU 推理服务(默认引擎,ECS on EC2 G6E GPU,私网) ──
    // 可达其单 WS 端点的来源:实时会话服务(真实会话)+ 控制面(design contract TTS 配置热加载
    // /reload-tts-config);无公网入站(安全红线 D9)。
    const gpu = new GpuInference(this, 'GpuInference', {
      stackName: props.stackName,
      vpc: net.vpc,
      callerSecurityGroup: rt.securityGroup,
      extraCallerSecurityGroups: [net.backendSecurityGroup],
      gpuImageTag,
      // design contract:GPU 只读 MiniMax 配置 Secret(直读 key+参数)+ 控制端点共享密钥(/drain + /reload-tts-config)
      miniMaxConfigSecret,
      gpuControlSecret,
    });

    // ── 7c. GPU 容量自动伸缩对账(design contract:reconciler + lifecycle-handler) ──
    // reconciler 只调 ecs:UpdateService(desiredCount)对账;ASG 由 ECS managed scaling 跟随。
    // 用 backend SG 入 VPC(GPU SG 已放行 backend SG → :8080,供读 /metrics)。
    const capacityReconciler = new CapacityReconciler(this, 'CapacityReconciler', {
      stackName: props.stackName,
      vpc: net.vpc,
      securityGroup: net.backendSecurityGroup,
      cluster: gpu.cluster,
      service: gpu.service,
      autoScalingGroup: gpu.autoScalingGroup,
      sessionsTable: tables.sessionsTable,
      systemConfigTable: tables.systemConfigTable,
      dataEncryptionKey: kms.dataEncryptionKey,
    });

    // ── 7d. 可观测性(D-3):bridge EMF per-turn 指标 + ALB 指标 → 基线告警 + 总览 Dashboard ──
    // 复用 reconciler 的 SNS 告警通道(运维订阅一处)。此前全栈仅 reconciler 心跳一个告警。
    new Observability(this, 'Observability', {
      stackName: props.stackName,
      alarmTopic: capacityReconciler.alarmTopic,
      backendAlb: backend.alb,
    });

    // ── 8. 事件面(Evaluator Lambda) ──
    const evaluator = new Evaluator(this, 'Evaluator', {
      stackName: props.stackName,
      sessionEventsTable: tables.sessionEventsTable,
      resultsTable: tables.resultsTable,
      dataEncryptionKey: kms.dataEncryptionKey,
      // rubric 打分模型(IAM 回退默认;单一事实源 bedrock-region.ts)
      evaluatorModelId: models.evaluator,
      integrationTable: tables.integrationTable, // result.ready webhook 推送(design contract)
      // 跨境打分(BUG-1):evaluator 经 LlmConfigSecret 的 mantle host+token+evaluator_model 跨境调美东。
      // 中国区无 Bedrock、不授 IAM,这是评分链路在中国区的唯一通路。
      llmConfigSecret,
    });

    // ── 9. 单场 Session 调度(design contract 缩水版:超时收尾/no_show 判定,EventBridge 每分钟) ──
    // 复用 backend app/ 状态机(container Lambda),与 API 单一事实源不漂移。
    // 拨号 driver(到点拨/重试)随电话链路删除(M0 B3 在 backend 侧收口);construct 保留驱动收尾。
    new SessionScheduler(this, 'SessionScheduler', {
      stackName: props.stackName,
      sessionsTable: tables.sessionsTable,
      agentsTable: tables.agentsTable,
      sessionEventsTable: tables.sessionEventsTable,
      dataEncryptionKey: kms.dataEncryptionKey,
      systemConfigTable: tables.systemConfigTable, // design contract:调度器闸门读动态 GPU 容量 live
      // design contract 与 backend 同口径:maxConcurrency=硬顶(GPU_HARD_MAX×每实例,留 autoscaling 弹性),
      // gpuCapacity=live 缺失时的保守兜底(单实例并发)。
      maxConcurrency: GPU_HARD_MAX * GPU_SESSIONS_PER_INSTANCE,
      gpuCapacity: GPU_SESSIONS_PER_INSTANCE,
      // meeting_end backstop 真 hangup(review):Cloud Map 直连 rt + X-Bridge-Secret。
      // 不接会退 RecordingDispatcher——hangup 只落库返回 True,rt 侧会话不被真正终止。
      bridgeDialUrl: `http://rt.${props.stackName}.local:3001`,
      bridgeCallbackSecret,
      // 调度器入 VPC + 用 backend SG(rt SG 已放行 backend SG → :3001,同 SG 复用)。
      vpc: net.vpc,
      securityGroup: net.backendSecurityGroup,
    });

    // ════════ 末尾统一 IAM grant(HLD §2.4 模式 3:最小权限、按 role 分离) ════════

    // 控制面 task role:读写全部 DDB 表 + 录音桶读写 + KMS。
    tables.grantReadWriteAll(backend.taskRole);
    buckets.recordingBucket.grantReadWrite(backend.taskRole);
    kms.recordingEncryptionKey.grantEncryptDecrypt(backend.taskRole);
    kms.dataEncryptionKey.grantEncryptDecrypt(backend.taskRole); // 读写 PII 表(CMK 加密)需解密权
    // 候选人 HMAC 密钥(design contract)+ 媒体面回调密钥(design contract):两者均经 ECS 原生 secret 注入容器
    // (ecs.Secret.fromSecretsManager,见 backend 段 addSecret),运行时由 ECS agent 拉取 → 任务角色
    // 须有 GetSecretValue 权(grant 在此)。不再用 unsafeUnwrap 注入 env(review:避免明文进 CFN 模板)。
    candidateTokenSecret.grantRead(backend.taskRole);
    delegationTokenSecret.grantRead(backend.taskRole);  // 独立委托密钥(design contract,与候选人密钥分离)
    // BridgeCallbackSecret 保留(MIGRATION-PLAN §2.1):M1 实时会话服务回报 backend 事件仍用 X-Bridge-Secret。
    bridgeCallbackSecret.grantRead(backend.taskRole);
    mcpFacadeStateSecret.grantRead(backend.taskRole);  // design contract:facade HMAC state 密钥(仅 backend 只读)
    // MiniMax 配置 Secret(design contract):backend admin 端点读(脱敏回显)+ 写(PutSecretValue)。
    // GPU 侧只读(grant 在 GpuInference 内,task role 加一条 GetSecretValue,无 DDB/Bedrock)。
    miniMaxConfigSecret.grantRead(backend.taskRole);
    miniMaxConfigSecret.grantWrite(backend.taskRole);
    // LLM 配置 Secret(design contract):**仅** backend admin 端点读(脱敏回显 + 发起时逐通注入 /dial)+ 写(PutSecretValue)。
    // ★ 媒体面 Bridge(voice.ec2Role)与 GPU **不** grant —— 系统级 mantle token 不落公网媒体面(review);
    //   Bridge 经 /dial body 拿逐通注入的 token,不 GetSecretValue、不缓存。
    llmConfigSecret.grantRead(backend.taskRole);
    llmConfigSecret.grantWrite(backend.taskRole);
    // GPU 控制密钥经 ECS 原生 secret 注入 backend 容器(addSecret),执行角色自动获 GetSecretValue(CDK grant)。

    // 实时会话服务 task role(M1;对齐电话版媒体面 ec2Role 的最小权限):录音桶写 + FINAL 转写/metrics
    // 写 SessionEvents + KMS。★ 不 grant:DDB 其它表、题库表(design contract 红线)、LlmConfigSecret
    // (mantle token 逐通经 ready body 注入,design contract 红线——服务不读 Secret、不缓存)。
    buckets.recordingBucket.grantReadWrite(rt.taskRole);
    tables.sessionEventsTable.grantWriteData(rt.taskRole);
    kms.recordingEncryptionKey.grantEncryptDecrypt(rt.taskRole);
    kms.dataEncryptionKey.grantEncryptDecrypt(rt.taskRole); // 写转写到 SessionEvents(CMK)需解密权

    // Bedrock IAM 调用权限(收窄到具体资源,#15:不用 resources:'*')。授予:
    //  - 控制面 taskRole:IAM 回退路径(Global 未配 mantle token 时,backend 侧 LLM 调用兜底;
    //    voice-test 网页全链路已删,但 backend 的 IAM 回退语义保留)
    //  - 实时会话服务 taskRole:三段式 LLM 的 IAM 回退(见下)
    // 跨区 inference profile(us.anthropic.*)需同时授 profile ARN 及底层 foundation-model ARN。
    // ★ `us.` 跨区 profile 会把请求路由到**美国全部成员 region**:us-east-1 / us-east-2 / us-west-2。
    //   必须把三者的 foundation-model ARN 都授权,否则 profile 路由到未授权 region(实测 us-east-2)
    //   会 AccessDenied(e2e 实测:LLM 调用被拒在 us-east-2)。去重(region 可能已在列表里)。
    // ★ 分区说明(VISION §2):Bedrock 资源在 **aws 分区**,ARN 前缀 `arn:aws:` 是资源本身的分区、
    //   **故意不用 Stack.partition**。中国区(aws-cn)IAM 与 aws 分区互不相认 → IAM 路径天然不可用,
    //   整个 grant 跳过(isCnGrant=false);中国区 LLM 一律走 design contract Bearer token(HTTPS,不经 IAM)。
    const isCnPartition = cdk.Token.isUnresolved(region) ? false : region.startsWith('cn-');
    const usProfileRegions = [
      ...new Set(['us-east-1', 'us-east-2', 'us-west-2', ...(isCnPartition ? [] : [region])]),
    ];
    const bedrockModelArns = usProfileRegions.map(
      (r) => `arn:aws:bedrock:${r}::foundation-model/anthropic.*`,
    );
    const grantBedrock = (role: iam.IRole) => {
      if (isCnPartition) return; // 中国区:跨分区 IAM 不可行(AWS 硬限制),LLM 走 Bearer,不授 Bedrock
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
          ],
          resources: [
            ...bedrockModelArns,
            `arn:aws:bedrock:${region}:${this.account}:inference-profile/us.*`,
          ],
        }),
      );
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['bedrock:ListInferenceProfiles'], // list 操作不支持资源级限定
          resources: ['*'],
        }),
      );
    };
    grantBedrock(backend.taskRole);
    grantBedrock(rt.taskRole); // 实时会话服务:三段式 LLM 的 IAM 回退路径(未配 mantle token 时)
    // 事件面 Evaluator:rubric 打分若调 Bedrock(§8),同样走收窄授权(不再 resources:'*')。
    grantBedrock(evaluator.fn.role!);

    applyNagSuppressions(this);
  }
}
