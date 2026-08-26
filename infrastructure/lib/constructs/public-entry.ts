import * as cdk from 'aws-cdk-lib';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { WAF_RATE_LIMIT_PER_5MIN } from '../common/constants';

/**
 * Public entry point:the domain maps directly to the public ALB.
 *
 * - ALB internet-facing,**仅 443(HTTPS 硬前提)**:getUserMedia(麦克风)要求 secure context,
 *   无 HTTPS 整个产品不可用 → **域名 + Route53 zone 是部署必填**(scripts/viva/main.ts fail-fast)。
 *   80 仅做 301 跳 443(不回源)。
 * - ACM DNS 验证证书(REGIONAL,本区即可——不再有 CloudFront 的 us-east-1 约束,这正是
 *   region 锁的最后一根;中国区同样可签)+ A/AAAA alias 记录。
 * - WAF **REGIONAL scope 挂 ALB**(限速 + AWS 托管通用规则;中国区 regional WAF 同样可用,
 *   两分区零分叉——原 CLOUDFRONT scope 的 us-east-1 同栈约束随 CloudFront 一并消失)。
 * - 前端静态资源由 backend 容器托管(Dockerfile 多阶段烘入 + FastAPI StaticFiles,/config.json
 *   动态渲染),S3 前端桶/BucketDeployment 已删。
 *
 * D9 红线(新表述):唯一公网入口 = 本 ALB 443;除 /health、/rt/health、/rt/ws(join token
 * 首帧鉴权)、/v1/realtime(client secret upgrade 鉴权)、/config.json、静态资源、MCP OAuth
 * 发现端点外无未鉴权路由(API=四种认证
 * fail-closed;/rt/sessions/* 控制端点 = X-Bridge-Secret fail-closed)。
 */
export interface PublicEntryProps {
  stackName: string;
  /** 公网 ALB(EcsBackend 建,443 已挂证书);本 construct 补 WAF 关联 + DNS alias。
   *  证书由 aim-stack 先建(EcsBackend 的 443 listener 需要它,与本 construct 的 ALB
   *  依赖相反,拆开断循环)。 */
  alb: elbv2.ApplicationLoadBalancer;
  /** 部署必填:FQDN + 所在 Route53 zone(HTTPS 硬前提)。zone 由 aim-stack lookup 后传入。 */
  domainName: string;
  zone: route53.IHostedZone;
}

export class PublicEntry extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: PublicEntryProps) {
    super(scope, id);

    const zone = props.zone;

    // WAF REGIONAL 挂 ALB(限速 + 托管通用规则;原 CloudFront scoped WAF 的替代,两分区可用)。
    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      // design contract:R2 upgrade 凭据只存在于这两个 header。WebACL 级 data protection 会在
      // request sampling、WAF logging 与 Security Lake 收集前替换其值；ALB access log 本身
      // 不记录 request headers。保留 sampled requests 用于 WAF 误检诊断，但凭据不落遥测。
      dataProtectionConfig: {
        dataProtections: [
          {
            field: { fieldType: 'SINGLE_HEADER', fieldKeys: ['authorization'] },
            action: 'SUBSTITUTION',
          },
          {
            field: { fieldType: 'SINGLE_HEADER', fieldKeys: ['sec-websocket-protocol'] },
            action: 'SUBSTITUTION',
          },
        ],
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${props.stackName}-alb-waf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 0,
          action: { block: {} },
          statement: { rateBasedStatement: { limit: WAF_RATE_LIMIT_PER_5MIN, aggregateKeyType: 'IP' } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${props.stackName}-alb-ratelimit`,
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSCommonRules',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              // ★ OAuth loopback 回调误检修正(design contract full facade,deployment validation 真机 WAF sampled-requests 实证):
              //   CommonRuleSet 把 OAuth 标准的 loopback 回调 `http://127.0.0.1`/`http://localhost`(facade 的
              //   redirect_uri,mcp-remote 等 client 的随机端口本地回调)误判为攻击 → 403 拦掉 /oauth/authorize(query)
              //   与 /register(body)。**真凶经 sampled-requests 定位是 `EC2MetaDataSSRF_QUERYARGUMENTS`**(把
              //   127.0.0.1 当 SSRF;RFI 两条是次凶,一并降级)。把这几条**降级为 count(仅计数不拦)**:
              //   本 API **从不据用户传入 URL 去 fetch 远端资源**——facade 的 redirect_uri 只经 is_loopback_redirect
              //   白名单严格校验(拒非 loopback、拒 userinfo/子域绕过)后**302 返回给 client**,从不服务端 fetch,
              //   故无 SSRF/RFI 实际风险;而 loopback 回调是 OAuth 授权码 + PKCE 标准必需。SQLi/XSS/LFI/RestrictedExtensions
              //   等其余 CommonRuleSet 规则**保持 block 不动**(仅放行 loopback URL 这一类误检)。
              ruleActionOverrides: [
                { name: 'EC2MetaDataSSRF_QUERYARGUMENTS', actionToUse: { count: {} } },
                { name: 'EC2MetaDataSSRF_BODY', actionToUse: { count: {} } },
                { name: 'GenericRFI_QUERYARGUMENTS', actionToUse: { count: {} } },
                { name: 'GenericRFI_BODY', actionToUse: { count: {} } },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${props.stackName}-alb-common`,
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'WafAssoc', {
      resourceArn: props.alb.loadBalancerArn,
      webAclArn: this.webAcl.attrArn,
    });

    // A/AAAA alias → ALB。
    new route53.ARecord(this, 'AliasA', {
      zone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(props.alb)),
    });
    new route53.AaaaRecord(this, 'AliasAaaa', {
      zone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(props.alb)),
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${props.domainName}`,
      description: 'VivaVoce 前端入口(唯一公网入口:域名直挂公网 ALB 443)',
    });
  }
}
