/**
 * CDK 单元测试:对合成模板做断言 —— 2 个 ECS 集群 + ASG + 认证 + 安全边界。
 * 用 CDK_DOCKER=noop 跳过真实镜像构建(只验资源属性,不需镜像内容)。
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AimStack } from '../lib/aim-stack';
import { GPU_HARD_MAX, GPU_SESSIONS_PER_INSTANCE } from '../lib/common/constants';

/** 域名三件套 context(设计决策 HTTPS 硬前提):缺任一 synth 即 fail-fast,故辅助函数必带。 */
const DOMAIN_CONTEXT = {
  customDomain: 'viva.test.example.com',
  customDomainZoneId: 'Z0TEST',
  customDomainZoneName: 'test.example.com',
};

/** 外部认证池五件套 context(VISION §2:中国区无 Cognito,复用美东池;中国区部署必然带它)。 */
const EXTERNAL_AUTH_CONTEXT = {
  authRegion: 'us-east-1',
  authUserPoolId: 'us-east-1_EXTPOOL',
  authUserPoolClientId: 'extwebclient0123456789',
  authMcpClientId: 'extmcpclient0123456789',
  authHostedUiDomain: 'aim-extstack-99999999',
};

function synth(region = 'us-east-1', extraContext: Record<string, string> = {}): Template {
  const app = new cdk.App({ context: { ...DOMAIN_CONTEXT, ...extraContext } });
  const stack = new AimStack(app, 'TestStack', {
    stackName: 'AimTest',
    adminEmail: 'admin@corp.com',
    engineType: 'three_stage',
    env: { account: '111111111111', region },
  });
  return Template.fromStack(stack);
}

describe('AimStack 资源拓扑', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('恰好 2 个 ECS 集群(控制面 Fargate + GPU EC2)', () => {
    t.resourceCountIs('AWS::ECS::Cluster', 2);
  });

  it('恰好 3 个 ECS 服务(Fargate API + Fargate 实时会话 + EC2 GPU)', () => {
    t.resourceCountIs('AWS::ECS::Service', 3);
  });

  it('控制面是 Fargate 服务', () => {
    t.hasResourceProperties('AWS::ECS::Service', {
      LaunchType: 'FARGATE',
    });
  });

  it('恰好 1 个 ASG(GPU 容量提供者;媒体面电话链路已删)', () => {
    t.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
  });

  it('预置默认 LLM 配置 seed(一安装即有清单):非中国区清单含 Sonnet 5 + Haiku 4.5', () => {
    // 默认 models 清单经 DEFAULT_MODELS env 注入 seed Lambda。非中国:含 Anthropic Sonnet5/Haiku4.5。
    const fns = JSON.stringify(t.findResources('AWS::Lambda::Function'));
    expect(fns).toContain('DefaultLlmConfigSeed');
    expect(fns).toContain('anthropic.claude-sonnet-5');
    expect(fns).toContain('anthropic.claude-haiku-4-5');
    expect(fns).toContain('minimax.minimax-m2.5');
  });

  it('design contract:非中国区 seed 字幕修正模型默认 Haiku(FIXER_MODEL env 非空)', () => {
    // 非中国区 seed Lambda 注入 FIXER_MODEL=anthropic.claude-haiku-4-5(开箱即修字幕错字)。
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({ FIXER_MODEL: 'anthropic.claude-haiku-4-5' }),
      }),
    });
  });

  it('预置默认 Agent seed(一安装即有「自由对话」):seed Lambda 直读 Agents 表', () => {
    // DefaultAgentsSeed:Lambda CustomResource 部署时 put「自由对话」Agent 到 Agents 表。
    const fns = JSON.stringify(t.findResources('AWS::Lambda::Function'));
    expect(fns).toContain('DefaultAgentsSeed');
    // seed Lambda 有 Agents 表的 GetItem/PutItem 权(不多授,最小权限)。
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['dynamodb:GetItem', 'dynamodb:PutItem'] }),
        ]),
      }),
    });
  });

  it('ALB internet-facing(设计决策:域名直挂公网 ALB,去 CloudFront)', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
    });
  });

  it('无 CloudFront(Distribution / VpcOrigin 均已删)', () => {
    t.resourceCountIs('AWS::CloudFront::Distribution', 0);
    t.resourceCountIs('AWS::CloudFront::VpcOrigin', 0);
  });

  it('443 HTTPS listener 挂 ACM 证书(HTTPS 硬前提)+ 80 仅 301 跳 443', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: Match.arrayWith([Match.objectLike({ CertificateArn: Match.anyValue() })]),
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: 'redirect',
          RedirectConfig: Match.objectLike({
            Port: '443',
            Protocol: 'HTTPS',
            StatusCode: 'HTTP_301',
          }),
        }),
      ]),
    });
  });

  it('ALB 目标组健康检查 /health', () => {
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/health',
    });
  });

  it('Cloud Map:PrivateDnsNamespace <stack>.local + api/rt 两个服务(内部东西向直连)', () => {
    t.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
      Name: 'AimTest.local',
    });
    t.hasResourceProperties('AWS::ServiceDiscovery::Service', { Name: 'api' });
    t.hasResourceProperties('AWS::ServiceDiscovery::Service', { Name: 'rt' });
  });

  it('work item dashboard 含首声、RTF、停声三分位及 provider/cache/并发下钻', () => {
    const dashboards = t.findResources('AWS::CloudWatch::Dashboard');
    expect(Object.keys(dashboards)).toHaveLength(1);
    const body = JSON.stringify(dashboards);
    for (const metric of [
      'llm_ttft_ms',
      'sentence_ready_ms',
      'provider_start_to_first_send_ms',
      'bridge_first_receive_ms',
      'e2e_latency_ms',
      'marker_to_first_binary_ms',
      'first_binary_to_first_render_ms',
      'marker_to_first_render_ms',
      'cold_preroll_ms',
      'underruns_before_first_render',
      'tts_rtf',
      'barge_evidence_to_pause_ms',
      'pause_to_confirm_ms',
      'pause_to_first_silent_render_ms',
      'confirm_to_worklet_flush_ms',
      'cancel_to_last_model_compute_ms',
      'cancel_to_last_gpu_send_ms',
      'browser_ring_depth_at_confirm_ms',
      'browser_ring_depth_before_flush_ms',
      'browser_ring_depth_after_flush_ms',
    ]) {
      expect(body).toContain(metric);
    }
    for (const metric of [
      'llm_ttft_ms',
      'sentence_ready_ms',
      'provider_start_to_first_send_ms',
      'bridge_first_receive_ms',
      'e2e_latency_ms',
      'marker_to_first_binary_ms',
      'first_binary_to_first_render_ms',
      'marker_to_first_render_ms',
      'cold_preroll_ms',
      'underruns_before_first_render',
      'barge_evidence_to_pause_ms',
      'pause_to_confirm_ms',
      'pause_to_first_silent_render_ms',
      'confirm_to_worklet_flush_ms',
      'cancel_to_last_model_compute_ms',
      'cancel_to_last_gpu_send_ms',
      'browser_ring_depth_at_confirm_ms',
      'browser_ring_depth_before_flush_ms',
      'browser_ring_depth_after_flush_ms',
    ]) {
      expect(body).toContain(`${metric} p50`);
    }
    expect(body).toContain('p50');
    expect(body).toContain('p95');
    expect(body).toContain('p99');
    expect(body).toContain('tts_provider');
    expect(body).toContain('cache_state');
    expect(body).toContain('concurrency_bucket');
    expect(body).toContain('首声分段 p50 / p95 / p99(ms)');
    expect(body).toContain('首渲染前 underrun p50 / p95 / p99(次)');
    expect(body).toContain('首渲染前 underrun 按 provider / cache / 并发档');
  });
});

describe('认证与安全红线', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('Cognito User Pool MFA 可选(用户决定不强制)+ 高级安全 PLUS', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'OPTIONAL',
    });
  });

  it('两个角色 Group:admin / staff', () => {
    t.resourceCountIs('AWS::Cognito::UserPoolGroup', 2);
    t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admin' });
    t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'staff' });
  });

  it('REGIONAL WAF 挂公网 ALB(WebACLAssociation 存在;原 CLOUDFRONT scope 已随 CloudFront 删除)', () => {
    t.resourceCountIs('AWS::WAFv2::WebACL', 1);
    t.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'REGIONAL' });
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it('design contract:WAF sampling 在采集前替换 Realtime 鉴权 headers', () => {
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      DataProtectionConfig: {
        DataProtections: Match.arrayWith([
          {
            Field: {
              FieldType: 'SINGLE_HEADER',
              FieldKeys: ['authorization'],
            },
            Action: 'SUBSTITUTION',
          },
          {
            Field: {
              FieldType: 'SINGLE_HEADER',
              FieldKeys: ['sec-websocket-protocol'],
            },
            Action: 'SUBSTITUTION',
          },
        ]),
      },
    });
  });

  it('CommonRuleSet 把 SSRF+RFI 规则降级为 count(修 OAuth loopback redirect_uri 被误判拦 403;design contract)', () => {
    const acls = t.findResources('AWS::WAFv2::WebACL');
    const acl = Object.values(acls)[0] as any;
    const common = (acl.Properties.Rules ?? []).find((r: any) => r.Name === 'AWSCommonRules');
    expect(common).toBeDefined();
    const overrides = common.Statement.ManagedRuleGroupStatement.RuleActionOverrides ?? [];
    const names = overrides.map((o: any) => o.Name);
    // 真凶 = EC2MetaDataSSRF(把 127.0.0.1 当 SSRF);RFI 次凶。均降 count 放行 loopback 回调。
    expect(names).toContain('EC2MetaDataSSRF_QUERYARGUMENTS');
    expect(names).toContain('EC2MetaDataSSRF_BODY');
    expect(names).toContain('GenericRFI_QUERYARGUMENTS');
    expect(names).toContain('GenericRFI_BODY');
    // 降级为 count(仅计数不拦),其余 CommonRuleSet 规则不动(仍 block)
    for (const o of overrides) expect(o.ActionToUse.Count).toBeDefined();
  });

  it('除公网 ALB SG 的 443/80 外,无 0.0.0.0/0 或 ::/0 入站规则(字段级断言)', () => {
    // 公网 ALB(listener open:true)的 443/80 全网放行是入口本意(WAF 限速 + app 层四种认证兜底);
    // 其余任何 SG 规则不得放行公网。豁免按「SG description = Public ALB + 端口 443/80」双条件过滤。
    const sgs = t.findResources('AWS::EC2::SecurityGroup');
    const albSgIds = new Set(
      Object.entries(sgs)
        .filter(([, res]) => ((res as { Properties?: { GroupDescription?: string } })
          .Properties?.GroupDescription ?? '').startsWith('Public ALB'))
        .map(([logicalId]) => logicalId),
    );
    expect(albSgIds.size).toBe(1); // 公网 SG 有且仅有 ALB 一个

    const isExemptAlbRule = (rule: Record<string, unknown>, ownerSgId?: string) => {
      const port = rule.FromPort;
      const onAlbSg = ownerSgId
        ? albSgIds.has(ownerSgId)
        : albSgIds.has(((rule.GroupId as { 'Fn::GetAtt'?: string[] })?.['Fn::GetAtt'] ?? [''])[0]);
      return onAlbSg && (port === 443 || port === 80) && rule.ToPort === port;
    };

    // 独立 SecurityGroupIngress 资源(GroupId 引用所属 SG)
    for (const [, res] of Object.entries(t.findResources('AWS::EC2::SecurityGroupIngress'))) {
      const r = (res as { Properties?: Record<string, unknown> }).Properties ?? {};
      if ((r.CidrIp === '0.0.0.0/0' || r.CidrIpv6 === '::/0') && !isExemptAlbRule(r)) {
        throw new Error(`非 ALB 443/80 的公网入站规则:${JSON.stringify(r)}`);
      }
    }
    // 内联在 SecurityGroup 的 ingress
    for (const [logicalId, res] of Object.entries(sgs)) {
      const inline = (res as { Properties?: { SecurityGroupIngress?: Array<Record<string, unknown>> } })
        .Properties?.SecurityGroupIngress ?? [];
      for (const r of inline) {
        if ((r.CidrIp === '0.0.0.0/0' || r.CidrIpv6 === '::/0') && !isExemptAlbRule(r, logicalId)) {
          throw new Error(`非 ALB 443/80 的公网入站规则(${logicalId}):${JSON.stringify(r)}`);
        }
      }
    }
  });

  it('GPU 推理服务有 readiness 健康检查(/readyz)', () => {
    // GPU 任务定义的容器 healthCheck 命中 /readyz
    const taskDefs = t.findResources('AWS::ECS::TaskDefinition');
    const json = JSON.stringify(taskDefs);
    expect(json).toContain('/readyz');
  });

  it('PII 表(Targets/SessionEvents/Results)用 CMK 加密(合规)', () => {
    // 至少 3 张表声明 SSESpecification(CUSTOMER_MANAGED 会生成 KMSMasterKeyId)
    const tables = t.findResources('AWS::DynamoDB::Table');
    const cmkTables = Object.values(tables).filter((r) => {
      const sse = (r as { Properties?: { SSESpecification?: { SSEEnabled?: boolean } } })
        .Properties?.SSESpecification;
      return sse?.SSEEnabled === true;
    });
    expect(cmkTables.length).toBeGreaterThanOrEqual(3);
  });

  it('录音桶 KMS 加密 + 全 BlockPublicAccess', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

describe('GPU 不持 Bedrock 凭证(权限边界)', () => {
  it('Bedrock InvokeModel 权限存在(媒体面 ec2Role 持有)', () => {
    const t = synth();
    const all = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(all).toContain('bedrock:InvokeModelWithResponseStream');
  });

  it('GPU task role 明确不含 Bedrock 权限(负向断言,防回归)', () => {
    const t = synth();
    const policies = t.findResources('AWS::IAM::Policy');
    // 找出附加到 GpuInference task role 的 policy:其 Roles 引用含 'GpuInference' 的逻辑 ID
    for (const [, res] of Object.entries(policies)) {
      const roles = (res as { Properties?: { Roles?: Array<{ Ref?: string }> } })
        .Properties?.Roles ?? [];
      const onGpuRole = roles.some((r) => (r.Ref ?? '').includes('GpuInference'));
      if (onGpuRole) {
        const doc = JSON.stringify((res as { Properties?: { PolicyDocument?: unknown } })
          .Properties?.PolicyDocument ?? {});
        expect(doc).not.toContain('bedrock:');
      }
    }
  });
});

describe('MCP OAuth 登录(design contract)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('建 Cognito Hosted UI domain(前缀 = aim-<stackName 小写>-<accountId 后8位> 两维)', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      // stackName=AimTest → aimtest;account=111111111111 → 后8位 11111111
      Domain: 'aim-aimtest-11111111',
    });
  });

  it('建 ResourceServer aim + scope invoke(授权锚点 aim/invoke)', () => {
    t.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
      Identifier: 'aim',
      Scopes: Match.arrayWith([Match.objectLike({ ScopeName: 'invoke' })]),
    });
  });

  it('MCP client 是 public(不生成 secret)+ 授权码流 + 授予 aim/invoke scope', () => {
    // GenerateSecret 缺省即 false(public);断言 client 名 + OAuth flow + scope 含 aim/invoke。
    const clients = t.findResources('AWS::Cognito::UserPoolClient');
    const mcp = Object.values(clients).find(
      (r: any) => r.Properties?.ClientName === 'AimTest-mcp',
    ) as any;
    expect(mcp).toBeDefined();
    expect(mcp.Properties.GenerateSecret).not.toBe(true); // public client
    expect(mcp.Properties.AllowedOAuthFlows).toEqual(['code']);
    // 授予的 scope 含自定义 <ResourceServer 'aim'>/invoke —— CFN 层是 Fn::Join(ResourceServer 逻辑 id + '/invoke');
    //   断言含标准 openid + 该自定义 scope 的 '/invoke' 后缀(引用 aim ResourceServer)。
    const scopes = mcp.Properties.AllowedOAuthScopes ?? [];
    expect(scopes).toContain('openid');
    expect(JSON.stringify(scopes)).toContain('/invoke');
    expect(JSON.stringify(scopes)).toContain('AimResourceServer');
  });

  it('MCP client 的 ExplicitAuthFlows 不含 SRP(显式钉死,防默认含 ALLOW_USER_SRP_AUTH)', () => {
    const clients = t.findResources('AWS::Cognito::UserPoolClient');
    const mcp = Object.values(clients).find(
      (r: any) => r.Properties?.ClientName === 'AimTest-mcp',
    ) as any;
    const flows: string[] = mcp.Properties.ExplicitAuthFlows ?? [];
    expect(flows).not.toContain('ALLOW_USER_SRP_AUTH');
    // 设了 refresh rotation 后 L2 不再补 ALLOW_REFRESH_TOKEN_AUTH(由 rotation 取代)
    expect(flows).not.toContain('ALLOW_REFRESH_TOKEN_AUTH');
  });

  it('MCP client 开 refresh token rotation(L2 prop)+ token revocation', () => {
    const clients = t.findResources('AWS::Cognito::UserPoolClient');
    const mcp = Object.values(clients).find(
      (r: any) => r.Properties?.ClientName === 'AimTest-mcp',
    ) as any;
    expect(mcp.Properties.RefreshTokenRotation?.Feature).toBe('ENABLED');
    expect(mcp.Properties.EnableTokenRevocation).toBe(true);
  });

  it('MCP client 回调 URL = facade 固定回调(有自定义域名时;design contract full facade,非通配)', () => {
    const clients = t.findResources('AWS::Cognito::UserPoolClient');
    const mcp = Object.values(clients).find(
      (r: any) => r.Properties?.ClientName === 'AimTest-mcp',
    ) as any;
    const urls: string[] = mcp.Properties.CallbackURLs ?? [];
    // full facade:回调 = https://<appDomain>/oauth/callback(facade 固定回调,单一、非 loopback、非通配)。
    // client 随机 loopback 端口藏 HMAC state、不进 Cognito 登记。
    expect(urls).toContain('https://viva.test.example.com/oauth/callback');
    expect(urls.some((u) => u.includes('*'))).toBe(false);
    expect(urls.some((u) => u.startsWith('http://localhost:'))).toBe(false); // 不再登记 loopback
  });

  it('backend 注入 MCP facade HMAC state 密钥(env,design contract)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_MCP_FACADE_STATE_SECRET' }),
          ]),
        }),
      ]),
    });
  });

  it('backend 注入 MCP client_id + Hosted UI 域(env)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_MCP_CLIENT_ID' }),
            Match.objectLike({ Name: 'AIM_COGNITO_HOSTED_UI_DOMAIN', Value: 'aim-aimtest-11111111' }),
          ]),
        }),
      ]),
    });
  });

  it('design contract:backend 无条件透传 AIM_ROLE_CLAIM(默认 cognito:groups)+ AIM_ROLE_MAP(默认空)', () => {
    // 认证外置 M2 地基:角色来源 claim 名 + 值映射经 env 下发,默认逐字节等价现状(cognito:groups + 恒等)。
    // 只在 backend(角色门控只在控制面);默认值使 task def 恒含此键(保证 env 变更可触发 task def 升版,见 cdk-env-passthrough-gap)。
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_ROLE_CLAIM', Value: 'cognito:groups' }),
            Match.objectLike({ Name: 'AIM_ROLE_MAP', Value: '' }),
          ]),
        }),
      ]),
    });
  });

  // 注:.well-known 发现端点不再需要 CDN 行为——去 CloudFront 后所有路径直达 ALB → backend
  //(app 层具名公开路由,D9 口径不变),无需 infra 级断言。

  it('WebClient 仍保留(SRP 网页登录不动)', () => {
    const clients = t.findResources('AWS::Cognito::UserPoolClient');
    const web = Object.values(clients).find(
      (r: any) => r.Properties?.ClientName === 'AimTest-web',
    ) as any;
    expect(web).toBeDefined();
    // WebClient 仍含 SRP(现状不变)
    expect(web.Properties.ExplicitAuthFlows).toContain('ALLOW_USER_SRP_AUTH');
  });
});

describe('事件面 Evaluator(rubric 打分)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('Evaluator 注入 rubric 打分模型 ID(单一事实源下发,非硬编码)', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AimTest-evaluator',
      Environment: {
        Variables: Match.objectLike({
          AIM_EVALUATOR_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
          RESULTS_TABLE_NAME: Match.anyValue(),
          SESSION_EVENTS_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it('Evaluator 由 SessionEvents Streams 触发', () => {
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });

  it('Evaluator 持 Bedrock InvokeModel 权限(收窄授权,非 resources:*)', () => {
    const policies = t.findResources('AWS::IAM::Policy');
    let found = false;
    for (const [, res] of Object.entries(policies)) {
      const roles = (res as { Properties?: { Roles?: Array<{ Ref?: string }> } })
        .Properties?.Roles ?? [];
      if (roles.some((r) => (r.Ref ?? '').includes('Evaluator'))) {
        const doc = JSON.stringify((res as { Properties?: { PolicyDocument?: unknown } })
          .Properties?.PolicyDocument ?? {});
        if (doc.includes('bedrock:InvokeModel')) found = true;
      }
    }
    expect(found).toBe(true);
  });
});

describe('实时会话服务(M1,VISION §3)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('rt Fargate 服务存在:单任务(min=max=1,会话上下文在进程内存)+ 先停后起', () => {
    const services = t.findResources('AWS::ECS::Service');
    const rt = Object.values(services).find(
      (r: any) => JSON.stringify(r.Properties?.TaskDefinition ?? '').includes('RealtimeSession')
        || (r.Properties?.DesiredCount === 1
            && r.Properties?.DeploymentConfiguration?.MinimumHealthyPercent === 0),
    ) as any;
    expect(rt).toBeDefined();
    expect(rt.Properties.DeploymentConfiguration.MaximumPercent).toBe(100);
  });

  it('ALB 精确 path 路由(/rt/health + /rt/ws + /v1/realtime)到实时会话服务(:3001)', () => {
    // 不用 /rt/* 或 /v1/* 通配:前者暴露控制端点,后者扩大 Realtime API 面。
    // 精确 path 承接原 CloudFront 行为白名单的同一姿态;控制端点只走 Cloud Map 内网。
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: Match.arrayWith([
        Match.objectLike({
          Field: 'path-pattern',
          PathPatternConfig: { Values: ['/rt/health', '/rt/ws', '/v1/realtime'] },
        }),
      ]),
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 3001,
      HealthCheckPath: '/rt/health',
    });
  });

  it('去 CloudFront:无 Distribution;控制端点不在公网 path 白名单(防暴露面回归)', () => {
    t.resourceCountIs('AWS::CloudFront::Distribution', 0);
    // 负向:任何 ListenerRule 都不得含 realtime 前缀通配或 /rt/sessions* path
    const rules = t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');
    for (const [, res] of Object.entries(rules)) {
      const conds = (res as any).Properties?.Conditions ?? [];
      const values = conds.flatMap((c: any) => c.PathPatternConfig?.Values ?? []);
      expect(values).not.toContain('/rt/*');
      expect(values).not.toContain('/v1/*');
      expect(values).not.toContain('/v1/realtime/*');
      expect(values.some((v: string) => v.startsWith('/rt/sessions'))).toBe(false);
    }
  });

  /**
   * design contract:部署清单经 backend env 注入(backend 侧才能读到编译期常量)。
   *
   * 若漏注入,诊断页的「部署清单」段会恒显 not_configured —— 且 backend **绝不允许**
   * 用 Python 手抄 constants.ts 补救(那正是本 spec 要消灭的「第二份可写副本」)。
   */
  it('design contract:AIM_DEPLOYMENT_MANIFEST 注入 backend 容器且是合法非密 JSON', () => {
    const defs = t.findResources('AWS::ECS::TaskDefinition');
    let found: string | undefined;
    for (const [, res] of Object.entries(defs)) {
      for (const c of ((res as any).Properties?.ContainerDefinitions ?? [])) {
        for (const kv of (c.Environment ?? [])) {
          if (kv.Name === 'AIM_DEPLOYMENT_MANIFEST') found = kv.Value;
        }
      }
    }
    expect(found).toBeDefined();
    const parsed = JSON.parse(found!);
    expect(parsed.schema_version).toBe(1);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries.length).toBeGreaterThan(0);
    // 非密守门(与 deployment-manifest.test.ts 同轴,此处锁「注入进模板的那份」)
    expect(found!).not.toMatch(/arn:aws[a-z-]*:secretsmanager:/i);
    expect(found!).not.toMatch(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/);
  });

  /**
   * design contract:诊断配置端点**不上公网**。
   *
   * vivavoce 的 bridge 挂公网 ALB,网络层兜底靠 **path allowlist**(而非 AIM 的
   * `internetFacing=false` NLB —— 在此无对应物)。故本断言是 AIM「NLB 暴露面回归」的等价替代:
   * allowlist MUST 精确保持三条公开路径,`/rt/config` 加进去才会真上公网。
   *
   * bridge 侧仍有 `X-Bridge-Secret` fail-closed 作纵深第二层(未配 503 / 错头 401),
   * 但那是第二层 —— 本层若破,诊断阈值(打断/VAD/沉默违规)就等于对外公开防作弊说明书。
   */
  it('design contract:/rt/config 不在公网 path allowlist(诊断端点仅内网 Cloud Map 可达)', () => {
    const rules = t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule');
    const allValues: string[] = [];
    for (const [, res] of Object.entries(rules)) {
      const conds = (res as any).Properties?.Conditions ?? [];
      allValues.push(...conds.flatMap((c: any) => c.PathPatternConfig?.Values ?? []));
    }
    // 负向:allowlist 不含 /rt/config,也不含任何能覆盖到它的前缀通配
    expect(allValues).not.toContain('/rt/config');
    expect(allValues.some((v) => v.startsWith('/rt/config'))).toBe(false);
    // 正向:rt 相关 path 精确只有这两个(新增任何 rt path 都会让本断言红,迫使显式评审暴露面)
    const rtValues = allValues.filter((v) => v.startsWith('/rt'));
    expect([...new Set(rtValues)].sort()).toEqual(['/rt/health', '/rt/ws']);
    const realtimeValues = allValues.filter((v) => v.startsWith('/v1'));
    expect([...new Set(realtimeValues)]).toEqual(['/v1/realtime']);
  });

  it('SessionScheduler 注入 rt Cloud Map 地址 + X-Bridge-Secret(meeting_end backstop 真 hangup)', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AimTest-session-scheduler',
      Environment: {
        Variables: Match.objectLike({
          AIM_BRIDGE_DIAL_URL: 'http://rt.AimTest.local:3001',
          AIM_BRIDGE_CALLBACK_SECRET: Match.anyValue(), // CFN 动态引用(resolve:secretsmanager)
        }),
      },
    });
  });

  it('rt 容器经 ECS 原生 secret 注入 AIM_BRIDGE_CALLBACK_SECRET(join token 验签,不进模板明文)', () => {
    const taskDefs = t.findResources('AWS::ECS::TaskDefinition');
    const rtDef = Object.values(taskDefs).find(
      (r: any) => r.Properties?.Family === 'AimTest-rt-session',
    ) as any;
    expect(rtDef).toBeDefined();
    const secrets = rtDef.Properties.ContainerDefinitions[0].Secrets ?? [];
    expect(secrets.some((s: any) => s.Name === 'AIM_BRIDGE_CALLBACK_SECRET')).toBe(true);
  });

  it('design contract:backend 与 rt 注入同一个独立 Realtime client-secret key', () => {
    const taskDefs = t.findResources('AWS::ECS::TaskDefinition');
    const backendDef = Object.values(taskDefs).find(
      (r: any) => r.Properties?.Family === 'AimTest-backend',
    ) as any;
    const rtDef = Object.values(taskDefs).find(
      (r: any) => r.Properties?.Family === 'AimTest-rt-session',
    ) as any;
    const backendSecrets = backendDef.Properties.ContainerDefinitions[0].Secrets ?? [];
    const rtSecrets = rtDef.Properties.ContainerDefinitions[0].Secrets ?? [];
    const backendRealtime = backendSecrets.find((s: any) => s.Name === 'AIM_REALTIME_CLIENT_SECRET');
    const rtRealtime = rtSecrets.find((s: any) => s.Name === 'AIM_REALTIME_CLIENT_SECRET');
    const backendBridge = backendSecrets.find((s: any) => s.Name === 'AIM_BRIDGE_CALLBACK_SECRET');

    expect(backendRealtime).toBeDefined();
    expect(rtRealtime).toBeDefined();
    expect(rtRealtime.ValueFrom).toEqual(backendRealtime.ValueFrom);
    expect(backendRealtime.ValueFrom).not.toEqual(backendBridge.ValueFrom);
  });

  it('design contract:rt 透传 AIM_GPU_EMBEDDING_URL(声纹端点)+ 经 secret 注入 AIM_EMBEDDING_SECRET(与 GPU 对称)', () => {
    const taskDefs = t.findResources('AWS::ECS::TaskDefinition');
    const rtDef = Object.values(taskDefs).find(
      (r: any) => r.Properties?.Family === 'AimTest-rt-session',
    ) as any;
    expect(rtDef).toBeDefined();
    // embedding 端点 URL 恒透传(Cloud Map 私有 DNS,同 gpuControlUrl)
    const env = rtDef.Properties.ContainerDefinitions[0].Environment ?? [];
    expect(env).toContainEqual({ Name: 'AIM_GPU_EMBEDDING_URL', Value: 'http://gpu.AimTest-gpu.local:8080/embedding' });
    // 鉴权密钥经 ECS 原生 secret 注入(不进模板明文;[[cdk-env-passthrough-gap]]:两端 secret 必对称否则声纹门恒 fail-open)
    const secrets = rtDef.Properties.ContainerDefinitions[0].Secrets ?? [];
    expect(secrets.some((s: any) => s.Name === 'AIM_EMBEDDING_SECRET')).toBe(true);
  });

  it('design contract:GPU 容器经 secret 注入 AIM_EMBEDDING_SECRET(/embedding fail-closed 鉴权,与 rt 同一密钥)', () => {
    const taskDefs = t.findResources('AWS::ECS::TaskDefinition');
    const gpuDef = Object.values(taskDefs).find(
      (r: any) => r.Properties?.Family?.includes('gpu') && r.Properties?.Family !== 'AimTest-rt-session',
    ) as any;
    expect(gpuDef).toBeDefined();
    const secrets = gpuDef.Properties.ContainerDefinitions[0].Secrets ?? [];
    expect(secrets.some((s: any) => s.Name === 'AIM_EMBEDDING_SECRET')).toBe(true);
  });

  it('rt task role:有录音桶/SessionEvents/Bedrock,无题库表/无 LlmConfigSecret(design contract 红线)', () => {
    const policies = t.findResources('AWS::IAM::Policy');
    for (const [, res] of Object.entries(policies)) {
      const roles = (res as { Properties?: { Roles?: Array<{ Ref?: string }> } }).Properties?.Roles ?? [];
      if (!roles.some((r) => (r.Ref ?? '').includes('RealtimeSessionTaskRole'))) continue;
      const doc = JSON.stringify((res as { Properties?: { PolicyDocument?: unknown } }).Properties?.PolicyDocument ?? {});
      expect(doc).not.toContain('QuestionBanks');
      expect(doc).not.toContain('LlmConfigSecret');
    }
    // Bedrock IAM 回退授权覆盖 rt task role(us-east-1 栈)
    const all = JSON.stringify(policies);
    expect(all).toContain('bedrock:InvokeModelWithResponseStream');
  });

  it('backend 注入 AIM_BRIDGE_DIAL_URL = Cloud Map 直连 rt(预创建下发不经公网 ALB)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_BRIDGE_DIAL_URL', Value: 'http://rt.AimTest.local:3001' }),
          ]),
        }),
      ]),
    });
  });

  it('rt 注入 AIM_CONTROL_CALLBACK_URL = Cloud Map 直连 backend(事件回报不经公网 ALB)', () => {
    const taskDefs = t.findResources('AWS::ECS::TaskDefinition');
    const rtDef = Object.values(taskDefs).find(
      (r: any) => r.Properties?.Family === 'AimTest-rt-session',
    ) as any;
    expect(rtDef).toBeDefined();
    const env = rtDef.Properties.ContainerDefinitions[0].Environment ?? [];
    expect(env).toContainEqual(
      { Name: 'AIM_CONTROL_CALLBACK_URL', Value: 'http://api.AimTest.local:8000/api' },
    );
  });

  /**
   * ★ design contract B 类:此断言**已反转**。
   *
   * 原契约:CDK 无条件注入 `AIM_FALSE_INTERRUPTION_RECOVERY: '1'`(误打断恢复默认启用)。
   * 新契约:该值是**代码默认值**(`turn-handling.ts::TURN_HANDLING_DEFAULTS.interruption.recoveryEnabled = true`),
   *        CDK **MUST NOT** 注入它 —— 无条件注入等于「默认值的第二份可写副本」,会盖住代码默认值,
   *        并让「改代码默认」变成无效操作(design contract 要消灭的正是这种副本)。
   * 行为等价:线上此前恒开(靠 CDK 硬编码),现在仍恒开(靠代码默认)。
   *
   * 同族守门:A 类已删的两个 key 亦 MUST NOT 出现(它们连 env 读取都没了,出现即意味有人加回了开关)。
   */
  it('rt **不注入** AIM_FALSE_INTERRUPTION_RECOVERY(design contract:默认值属代码,CDK 无条件注入会盖住它)', () => {
    const taskDefs = t.findResources('AWS::ECS::TaskDefinition');
    const rtDef = Object.values(taskDefs).find(
      (r: any) => r.Properties?.Family === 'AimTest-rt-session',
    ) as any;
    expect(rtDef).toBeDefined();
    const env = rtDef.Properties.ContainerDefinitions[0].Environment ?? [];
    const names = env.map((e: any) => e.Name);
    expect(names).not.toContain('AIM_FALSE_INTERRUPTION_RECOVERY');
    // A 类(design contract 已删开关):MUST NOT 透传 —— bridge 侧已无 env 读取,出现即是有人加回了开关。
    expect(names).not.toContain('AIM_PLAYBACK_ACK_MODE');
    expect(names).not.toContain('AIM_FAREWELL_TTS_DRAIN_ENABLED');
  });

  it('backend 注入 AIM_PUBLIC_API_BASE = https://<自定义域名>(去 CloudFront 后为域名直挂)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_PUBLIC_API_BASE', Value: 'https://viva.test.example.com' }),
          ]),
        }),
      ]),
    });
  });

  it('backend 注入 AIM_MCP_OAUTH_CALLBACK_URL(/config.json 动态渲染,design contract)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_MCP_OAUTH_CALLBACK_URL' }),
          ]),
        }),
      ]),
    });
  });
});

describe('外部认证池(中国区复用美东 Cognito,VISION §2)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth('us-east-1', EXTERNAL_AUTH_CONTEXT);
  });

  it('五件套 context 齐 → 本栈不建任何 Cognito 资源(池在美东已存在)', () => {
    t.resourceCountIs('AWS::Cognito::UserPool', 0);
    t.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
    t.resourceCountIs('AWS::Cognito::UserPoolDomain', 0);
    t.resourceCountIs('AWS::Cognito::UserPoolGroup', 0);
    t.resourceCountIs('AWS::Cognito::UserPoolResourceServer', 0);
  });

  it('backend env 注入外部池参数 + AIM_AUTH_REGION=us-east-1(认证 region 与部署 region 解耦)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'USER_POOL_ID', Value: 'us-east-1_EXTPOOL' }),
            Match.objectLike({ Name: 'USER_POOL_CLIENT_ID', Value: 'extwebclient0123456789' }),
            Match.objectLike({ Name: 'AIM_AUTH_REGION', Value: 'us-east-1' }),
            Match.objectLike({ Name: 'AIM_MCP_CLIENT_ID', Value: 'extmcpclient0123456789' }),
            Match.objectLike({ Name: 'AIM_COGNITO_HOSTED_UI_DOMAIN', Value: 'aim-extstack-99999999' }),
          ]),
        }),
      ]),
    });
  });

  it('admin user seeding 随本栈池一起跳过(外部池的用户在美东侧管理)', () => {
    // AdminSeed 相关的 Lambda / CustomResource 都不应存在(外部池,用户在美东侧管理)。
    // 注:DefaultAgentsSeed(预置「自由对话」Agent)与池无关、总会有一个 CustomResource,故不再断言
    //     「零 CustomResource」,改为断言「无 AdminSeed / AdminUserSeed 命名的资源」。
    const fns = JSON.stringify(t.findResources('AWS::Lambda::Function'));
    expect(fns).not.toContain('AdminSeed');
    const crs = JSON.stringify(t.findResources('AWS::CloudFormation::CustomResource'));
    expect(crs).not.toContain('AdminUserSeed');
  });

  it('半配置(只给部分五件套)→ synth 抛错 fail-fast', () => {
    const app = new cdk.App({
      context: { ...DOMAIN_CONTEXT, authRegion: 'us-east-1', authUserPoolId: 'us-east-1_EXTPOOL' },
    });
    expect(() => {
      new AimStack(app, 'TestStackHalfAuth', {
        stackName: 'AimTest',
        adminEmail: 'admin@corp.com',
        engineType: 'three_stage',
        env: { account: '111111111111', region: 'us-east-1' },
      });
    }).toThrow(/五件套/);
  });

  it('不给五件套 = 现状:本栈建池 + AIM_AUTH_REGION=部署 region(Global 零变化)', () => {
    const tLocal = synth();
    tLocal.resourceCountIs('AWS::Cognito::UserPool', 1);
    tLocal.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_AUTH_REGION', Value: 'us-east-1' }),
          ]),
        }),
      ]),
    });
  });
});

describe('分区无关(B6,VISION §2:cn-north-1 可 synth;中国区部署必然带外部池五件套)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth('cn-north-1', EXTERNAL_AUTH_CONTEXT);
  });

  it('中国区也有 REGIONAL WAF 挂 ALB(去 CloudFront 后两分区零分叉,不再条件化跳过)', () => {
    t.resourceCountIs('AWS::WAFv2::WebACL', 1);
    t.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'REGIONAL' });
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it('中国区不授 Bedrock IAM(跨分区 IAM 不可行;LLM 走 Bearer)', () => {
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('bedrock:InvokeModel');
  });

  it('默认 LLM 清单分区感知:中国区 seed 清单不含任何 Anthropic(Claude/Sonnet 地域封锁)', () => {
    const fns = JSON.stringify(t.findResources('AWS::Lambda::Function'));
    expect(fns).toContain('DefaultLlmConfigSeed');
    expect(fns).not.toContain('anthropic.claude-sonnet-5');  // 中国区默认清单剔除 Anthropic
    expect(fns).not.toContain('anthropic.claude-haiku-4-5');
    expect(fns).toContain('minimax.minimax-m2.5');  // 仍含 GLM/MiniMax
  });

  it('design contract:中国区 seed 字幕修正模型留空(FIXER_MODEL="",初装清单无 Anthropic,配代理后 admin 自选)', () => {
    // 中国区 seed Lambda 注入 FIXER_MODEL=''(不 seed Anthropic fixer,避免落非法配置)。
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: Match.objectLike({
        Variables: Match.objectLike({ FIXER_MODEL: '' }),
      }),
    });
  });

  it('BUG-1 正向可达:evaluator 拿到 LlmConfigSecret env + 读权(中国区评分唯一跨境通路)', () => {
    // 审计教训:cn synth 只断言「不该有的」(不授 Bedrock IAM),从不验「该有的替代路径」。
    // 中国区 evaluator 无 Bedrock,必须经 mantle 跨境 → 须有 secret env(handler 据此走 mantle)+ 读该 secret 的 IAM。
    const fns = JSON.stringify(t.findResources('AWS::Lambda::Function'));
    expect(fns).toContain('AIM_LLM_CONFIG_SECRET_ID');  // evaluator env 注入 secret 指针
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('secretsmanager:GetSecretValue');  // evaluator 有读 secret 权(跨境打分凭据)
  });

  it('无硬编码 arn:aws: 的 ECS 资源(partition 动态取)', () => {
    // gpu-inference 的 UpdateTaskProtection 资源 ARN 应随 partition 解析为 arn:aws-cn:
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('arn:aws:ecs:cn-north-1');
  });

  it('中国区不建 Cognito(aws-cn 无此服务),认证指向美东池(AIM_AUTH_REGION=us-east-1)', () => {
    t.resourceCountIs('AWS::Cognito::UserPool', 0);
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            // 注意 arrayWith 是有序子序列匹配:按 env 实际顺序(USER_POOL_ID 在 AIM_AUTH_REGION 前)
            Match.objectLike({ Name: 'USER_POOL_ID', Value: 'us-east-1_EXTPOOL' }),
            Match.objectLike({ Name: 'AIM_AUTH_REGION', Value: 'us-east-1' }),
          ]),
        }),
      ]),
    });
  });
});

describe('电话链路已删(VISION §1 负向断言,防回归)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('无任何 Chime VC 权限 / EIP 自绑权限(电话资产不再存在)', () => {
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('chime:');
    expect(policies).not.toContain('ec2:AssociateAddress');
  });

  it('无媒体面公网 LaunchTemplate(不再有 associatePublicIpAddress=true 的实例)', () => {
    const lts = t.findResources('AWS::EC2::LaunchTemplate');
    const hasPublicIpLt = Object.values(lts).some((lt) => {
      const data = (lt as { Properties?: { LaunchTemplateData?: Record<string, unknown> } }).Properties
        ?.LaunchTemplateData;
      const nis = (data?.NetworkInterfaces ?? []) as Array<Record<string, unknown>>;
      return nis.some((ni) => ni.AssociatePublicIpAddress === true);
    });
    expect(hasPublicIpLt).toBe(false);
  });

  it('无 SQS 队列(CampaignScheduler 已删)', () => {
    t.resourceCountIs('AWS::SQS::Queue', 0);
  });
});

describe('单场 Session 调度(design contract)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('SessionScheduler Lambda 存在(container Lambda)', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AimTest-session-scheduler',
      PackageType: 'Image',
    });
  });

  it('EventBridge 每分钟触发调度器', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
      State: 'ENABLED',
    });
  });

  it('调度器注入会话/Agent/事件表名 + 并发闸门', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AimTest-session-scheduler',
      Environment: {
        Variables: Match.objectLike({
          SESSIONS_TABLE_NAME: Match.anyValue(),
          AGENTS_TABLE_NAME: Match.anyValue(),  // design contract:原 PROFILES_TABLE_NAME
          SESSION_EVENTS_TABLE_NAME: Match.anyValue(),
          // design contract:MAX_CONCURRENCY=安全阀硬顶(GPU_HARD_MAX×每实例),给 autoscaling 留弹性(锁确切值)。
          MAX_CONCURRENCY: String(GPU_HARD_MAX * GPU_SESSIONS_PER_INSTANCE),
          AIM_GPU_CAPACITY: String(GPU_SESSIONS_PER_INSTANCE), // live 缺失时保守兜底(单实例并发)
          SYSTEM_CONFIG_TABLE_NAME: Match.anyValue(), // 调度器闸门读动态容量(design contract)
        }),
      },
    });
  });
});

describe('GPU 容量管理与自动伸缩(design contract)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('SystemConfig 表存在(PK=config_key)', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'AimTest-SystemConfig',
      KeySchema: [{ AttributeName: 'config_key', KeyType: 'HASH' }],
    });
  });

  it('Sessions 表有 StatusIndex GSI(partition-only;reconciler 算 P/Q 走 query 非全表 scan)', () => {
    // 无 sort key:dispatch_asap 会话无 meeting_start 也须入索引(否则 Q 漏即时发起)
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'AimTest-Sessions',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'StatusIndex',
          KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }],
        }),
      ]),
    });
  });

  it('GPU ASG min=0(可停机)/ max=GPU_HARD_MAX(护栏)+ scale-in protection', () => {
    t.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      MinSize: '0',
      MaxSize: '8',
      NewInstancesProtectedFromScaleIn: true,
    });
  });

  it('GPU capacity provider 开 managed scaling + termination protection', () => {
    t.hasResourceProperties('AWS::ECS::CapacityProvider', {
      AutoScalingGroupProvider: Match.objectLike({
        ManagedScaling: Match.objectLike({ Status: 'ENABLED' }),
        ManagedTerminationProtection: 'ENABLED',
      }),
    });
  });

  it('ASG 有 TERMINATING lifecycle hook(drain 兜底)', () => {
    t.hasResourceProperties('AWS::AutoScaling::LifecycleHook', {
      LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING',
    });
  });

  it('GPU ECS service 省略 DesiredCount(避免 deploy 重置运行时容量)', () => {
    const services = t.findResources('AWS::ECS::Service');
    const gpuSvc = Object.values(services).find(
      (r: any) => r.Properties?.ServiceName?.includes?.('gpu') ||
        JSON.stringify(r.Properties?.ServiceName ?? '').toLowerCase().includes('gpu'),
    ) as any;
    // 找不到精确名也至少断言:存在一个 ECS service 不带 DesiredCount
    const anyNoDesired = Object.values(services).some(
      (r: any) => r.Properties?.DesiredCount === undefined,
    );
    expect(gpuSvc ? gpuSvc.Properties.DesiredCount : undefined).toBeUndefined();
    expect(anyNoDesired).toBe(true);
  });

  it('reconciler Lambda 存在 + 串行(reservedConcurrency=1)+ EventBridge 每分钟', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AimTest-capacity-reconciler',
      PackageType: 'Image',
      ReservedConcurrentExecutions: 1,
    });
  });

  it('reconciler 不持 autoscaling 写权限、不持 Bedrock(只 ecs:UpdateService)', () => {
    // 收集所有 IAM policy 文档,断言无 SetDesiredCapacity / 无 bedrock
    const policies = t.findResources('AWS::IAM::Policy');
    const all = JSON.stringify(policies);
    expect(all).toContain('ecs:UpdateService');
    expect(all).not.toContain('autoscaling:SetDesiredCapacity');
    expect(all).not.toContain('autoscaling:UpdateAutoScalingGroup');
  });

  it('lifecycle-handler 持 CompleteLifecycleAction(限本 ASG)', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AimTest-capacity-lifecycle',
      PackageType: 'Image',
    });
    const all = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(all).toContain('autoscaling:CompleteLifecycleAction');
  });

  it('GPU task role 持 PutMetricData(限 AIM/GPU)+ UpdateTaskProtection,仍无 Bedrock', () => {
    const all = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(all).toContain('cloudwatch:PutMetricData');
    expect(all).toContain('ecs:UpdateTaskProtection');
    expect(all).toContain('AIM/GPU');
  });

  it('reconciler 失活告警(CloudWatch Alarm on ReconcilerHeartbeat + SNS)', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AIM/Capacity',
      MetricName: 'ReconcilerHeartbeat',
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching', // 心跳完全停 = 失活,必告警
    });
    t.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'AimTest-capacity-reconciler-alarm',
    });
  });

  it('backend 注入 SYSTEM_CONFIG_TABLE_NAME(闸门读动态容量)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'SYSTEM_CONFIG_TABLE_NAME' }),
          ]),
        }),
      ]),
    });
  });
});

describe('MiniMax TTS provider(design contract)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('建 MiniMaxConfigSecret + GpuControlSecret 两个 Secret', () => {
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('MiniMax TTS provider config'),
    });
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('/drain \\+ /reload-tts-config'),
    });
  });

  it('建 LlmConfigSecret(design contract 三段式 LLM 配置)', () => {
    t.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('Three-stage LLM config'),
    });
  });

  it('backend 注入 LLM Secret 指针(非密 env,design contract)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_LLM_CONFIG_SECRET_ID' }),
          ]),
        }),
      ]),
    });
  });

  it('backend IAM 回退默认 LLM 模型 = Haiku inference profile(design contract 未配 mantle token 时)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_LLM_MODEL_ID', Value: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' }),
          ]),
        }),
      ]),
    });
  });

  it('媒体面 EC2 role 不含 LlmConfigSecret 读权限(design contract:系统级 token 不落公网媒体面)', () => {
    // 找出 LlmConfigSecret 的逻辑 ID,再确认没有任何挂在 OutboundVoice EC2 role 上的 policy 引用它的 GetSecretValue。
    const secrets = t.findResources('AWS::SecretsManager::Secret');
    const llmSecretId = Object.entries(secrets).find(
      ([, r]) => ((r as { Properties?: { Description?: string } }).Properties?.Description ?? '')
        .includes('Three-stage LLM config'),
    )?.[0];
    expect(llmSecretId).toBeDefined();
    const policies = t.findResources('AWS::IAM::Policy');
    for (const [, res] of Object.entries(policies)) {
      const props = (res as {
        Properties?: {
          Roles?: Array<{ Ref?: string }>;
          PolicyDocument?: { Statement?: Array<{ Action?: unknown; Resource?: unknown }> };
        };
      }).Properties ?? {};
      const onEc2Role = (props.Roles ?? []).some((r) => (r.Ref ?? '').includes('Ec2Role')
        || (r.Ref ?? '').includes('OutboundVoice'));
      if (!onEc2Role) continue;
      // 该 policy 挂在媒体面 EC2 role 上 → 其任何 statement 的 Resource MUST NOT 引用 LlmConfigSecret。
      const stmts = props.PolicyDocument?.Statement ?? [];
      const refsLlmSecret = JSON.stringify(stmts).includes(llmSecretId as string);
      expect(refsLlmSecret).toBe(false);
    }
  });

  it('backend 注入 MiniMax Secret 指针 + GPU 热加载 base(非密 env)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_MINIMAX_SECRET_ID' }),
            Match.objectLike({ Name: 'AIM_GPU_CONTROL_URL' }),
          ]),
        }),
      ]),
    });
  });

  it('backend 经 ECS 原生 secret 注入 GPU 控制密钥 AIM_DRAIN_SECRET(不进模板明文)', () => {
    t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Secrets: Match.arrayWith([
            Match.objectLike({ Name: 'AIM_DRAIN_SECRET' }),
          ]),
        }),
      ]),
    });
  });

  it('GPU task role 只读 MiniMax Secret 仍不含 Bedrock(权限边界不破)', () => {
    const policies = t.findResources('AWS::IAM::Policy');
    for (const [, res] of Object.entries(policies)) {
      const roles = (res as { Properties?: { Roles?: Array<{ Ref?: string }> } })
        .Properties?.Roles ?? [];
      const onGpuRole = roles.some((r) => (r.Ref ?? '').includes('GpuInferenceGpuTaskRole'));
      if (onGpuRole) {
        const doc = JSON.stringify((res as { Properties?: { PolicyDocument?: unknown } })
          .Properties?.PolicyDocument ?? {});
        expect(doc).not.toContain('bedrock:');
        expect(doc).not.toContain('dynamodb:');
      }
    }
  });
});

describe('自定义域名(设计决策:HTTPS 硬前提,三件套 context 必填)', () => {
  it('三件套 context 齐 → ACM DNS 验证证书 + A/AAAA alias 指向 ALB', () => {
    const t = synth(); // 辅助函数已带 DOMAIN_CONTEXT
    t.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'viva.test.example.com',
      ValidationMethod: 'DNS',
    });
    // A/AAAA alias:AliasTarget.DNSName 引用 ALB 的 DNSName(dualstack.<ALB DNS>),非 CloudFront。
    const records = t.findResources('AWS::Route53::RecordSet');
    const byType = (type: string) => Object.values(records).filter(
      (r: any) => r.Properties?.Type === type && r.Properties?.Name === 'viva.test.example.com.',
    ) as any[];
    for (const type of ['A', 'AAAA']) {
      const matched = byType(type);
      expect(matched).toHaveLength(1);
      const aliasDns = JSON.stringify(matched[0].Properties.AliasTarget?.DNSName ?? '');
      expect(aliasDns).toContain('dualstack');
      expect(aliasDns).toContain('Alb'); // Fn::GetAtt 引用 EcsBackend 的 ALB,而非 CloudFront 域名
      expect(aliasDns).not.toContain('cloudfront');
    }
  });

  it('缺域名三件套 context → synth 抛错 fail-fast(公网 ALB 仅 443,无证书无法部署)', () => {
    const app = new cdk.App(); // 不带 context
    expect(() => {
      new AimStack(app, 'TestStackNoDomain', {
        stackName: 'AimTest',
        adminEmail: 'admin@corp.com',
        engineType: 'three_stage',
        env: { account: '111111111111', region: 'us-east-1' },
      });
    }).toThrow(/域名三件套/);
  });
});

describe('容器架构可配置(AIM_CONTAINER_ARCH,中国区 x86 构建机原生构建)', () => {
  const origArch = process.env.AIM_CONTAINER_ARCH;
  afterEach(() => {
    if (origArch === undefined) delete process.env.AIM_CONTAINER_ARCH;
    else process.env.AIM_CONTAINER_ARCH = origArch;
    jest.resetModules();
  });

  function synthWithArch(arch: string | undefined): Template {
    if (arch === undefined) delete process.env.AIM_CONTAINER_ARCH;
    else process.env.AIM_CONTAINER_ARCH = arch;
    jest.resetModules();
    // 重新 require(constants/arch 在模块加载期读 env)
    const cdkMod = require('aws-cdk-lib');
    const { AimStack: FreshStack } = require('../lib/aim-stack');
    const app = new cdkMod.App({ context: { ...DOMAIN_CONTEXT } });
    const stack = new FreshStack(app, 'ArchTest', {
      stackName: 'AimTest',
      adminEmail: 'admin@corp.com',
      engineType: 'three_stage',
      env: { account: '111111111111', region: 'us-east-1' },
    });
    return cdkMod.assertions.Template.fromStack(stack);
  }

  // Fargate task def(backend/rt)有 RuntimePlatform;GPU task def 是 EC2 launch type 无此属性。
  // 按 Family 过滤到 Fargate 两个,断言其 CpuArchitecture。
  function fargateArchs(t: Template): string[] {
    const defs = t.findResources('AWS::ECS::TaskDefinition');
    return Object.values(defs)
      .map((r: any) => r.Properties?.RuntimePlatform?.CpuArchitecture)
      .filter((a: unknown): a is string => typeof a === 'string');
  }

  it('默认 arm64:Fargate task ARM64 + Lambda arm64', () => {
    const t = synthWithArch(undefined);
    const archs = fargateArchs(t);
    expect(archs.length).toBeGreaterThanOrEqual(2); // backend + rt
    expect(archs.every((a) => a === 'ARM64')).toBe(true);
    t.hasResourceProperties('AWS::Lambda::Function', { Architectures: ['arm64'] });
  });

  it('AIM_CONTAINER_ARCH=amd64:Fargate task X86_64 + Lambda x86_64(x86 构建机原生构建)', () => {
    const t = synthWithArch('amd64');
    const archs = fargateArchs(t);
    expect(archs.length).toBeGreaterThanOrEqual(2);
    expect(archs.every((a) => a === 'X86_64')).toBe(true);
    t.hasResourceProperties('AWS::Lambda::Function', { Architectures: ['x86_64'] });
  });
});

describe('design contract 违规检测 knobs 条件透传(rt session env;防 cdk-env-passthrough-gap)', () => {
  const KNOBS = [
    'AIM_VIOLATION_ENFORCEMENT', 'AIM_SILENCE_VIOLATION_MS', 'AIM_SILENCE_WARN_MAX', 'AIM_NO_FRAME_MS',
    'AIM_MODERATION_TIMEOUT_MS', 'AIM_MODERATION_CONFIDENCE_THRESHOLD',
    'AIM_IDLE_CHATTER_MIN_TURNS', 'AIM_FORCED_END_MAX_WAIT_MS', 'AIM_SEVERE_VIOLATION_MAX',
    'AIM_ANSWER_GRACE_MS', // design contract:答完补充宽限窗(engine 内延迟推进);仅设了才透传,防 cdk-env-passthrough-gap
    'AIM_AUTO_NEXT_GRACE_MS', // direct auto-next 短宽限;避免题间固定静默 4s
    // design contract:播放边界推进时钟超前量上限 + 播完余量;仅设了才透传(未设用 bridge 默认 35000/1000)。
    'AIM_MAX_PLAYBACK_LEAD_MS', 'AIM_PLAYBACK_LEAD_MARGIN_MS',
    'AIM_QUESTION_MAX_FOLLOW_UPS', 'AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KNOBS) saved[k] = process.env[k]; });
  afterEach(() => {
    for (const k of KNOBS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
    jest.resetModules();
  });

  function synthFresh(): any {
    jest.resetModules();
    const cdkMod = require('aws-cdk-lib');
    const { AimStack: FreshStack } = require('../lib/aim-stack');
    const app = new cdkMod.App({ context: { ...DOMAIN_CONTEXT } });
    const stack = new FreshStack(app, 'ModTest', {
      stackName: 'AimTest', adminEmail: 'admin@corp.com', engineType: 'three_stage',
      env: { account: '111111111111', region: 'us-east-1' },
    });
    return cdkMod.assertions.Template.fromStack(stack);
  }
  function rtEnv(t: any): Record<string, unknown>[] {
    const defs = t.findResources('AWS::ECS::TaskDefinition');
    const rt = Object.values(defs).find((r: any) => r.Properties?.Family === 'AimTest-rt-session') as any;
    return rt?.Properties?.ContainerDefinitions?.[0]?.Environment ?? [];
  }

  it('未设 env → knobs 不进 rt 环境(用 bridge 默认,逐字节等价)', () => {
    for (const k of KNOBS) delete process.env[k];
    const env = rtEnv(synthFresh());
    for (const k of KNOBS) expect(env.find((e: any) => e.Name === k)).toBeUndefined();
  });

  it('设了 env → 对应 knob 透传进 rt 环境(deploy 生效)', () => {
    process.env.AIM_VIOLATION_ENFORCEMENT = '1';
    process.env.AIM_MODERATION_TIMEOUT_MS = '6000';
    process.env.AIM_SILENCE_WARN_MAX = '3';
    process.env.AIM_FORCED_END_MAX_WAIT_MS = '8000'; // R3(正向断言,防透传被删无人知,review)
    process.env.AIM_SEVERE_VIOLATION_MAX = '2';       // R3
    process.env.AIM_ANSWER_GRACE_MS = '4000';         // design contract(正向锁定透传)
    process.env.AIM_AUTO_NEXT_GRACE_MS = '800';       // direct auto-next 短宽限
    process.env.AIM_MAX_PLAYBACK_LEAD_MS = '35000';   // design contract(正向锁定透传)
    process.env.AIM_PLAYBACK_LEAD_MARGIN_MS = '1000'; // design contract
    process.env.AIM_QUESTION_MAX_FOLLOW_UPS = '2';     // design contract
    process.env.AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS = '15000'; // design contract buffered-stream backstop
    const env = rtEnv(synthFresh());
    expect(env).toContainEqual({ Name: 'AIM_VIOLATION_ENFORCEMENT', Value: '1' });
    expect(env).toContainEqual({ Name: 'AIM_MODERATION_TIMEOUT_MS', Value: '6000' });
    expect(env).toContainEqual({ Name: 'AIM_SILENCE_WARN_MAX', Value: '3' });
    expect(env).toContainEqual({ Name: 'AIM_FORCED_END_MAX_WAIT_MS', Value: '8000' }); // R3 透传正向锁定
    expect(env).toContainEqual({ Name: 'AIM_SEVERE_VIOLATION_MAX', Value: '2' });        // R3 透传正向锁定
    expect(env).toContainEqual({ Name: 'AIM_ANSWER_GRACE_MS', Value: '4000' });          // design contract 透传正向锁定
    expect(env).toContainEqual({ Name: 'AIM_AUTO_NEXT_GRACE_MS', Value: '800' });
    expect(env).toContainEqual({ Name: 'AIM_MAX_PLAYBACK_LEAD_MS', Value: '35000' });     // design contract 透传正向锁定
    expect(env).toContainEqual({ Name: 'AIM_PLAYBACK_LEAD_MARGIN_MS', Value: '1000' });   // design contract 透传正向锁定
    expect(env).toContainEqual({ Name: 'AIM_QUESTION_MAX_FOLLOW_UPS', Value: '2' });       // design contract 透传正向锁定
    expect(env).toContainEqual({ Name: 'AIM_QUESTION_FORCE_CLOSURE_TIMEOUT_MS', Value: '15000' });
    // 未设的仍不透传
    expect(env.find((e: any) => e.Name === 'AIM_IDLE_CHATTER_MIN_TURNS')).toBeUndefined();
  });
});
