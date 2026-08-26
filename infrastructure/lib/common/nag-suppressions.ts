/**
 * cdk-nag(AwsSolutionsChecks)豁免登记 —— 每条必须带理由。
 *
 * 原则:
 * - 与登录鉴权/公网暴露相关的红线项**不豁免**,已真实加固(Cognito MFA+PLUS、REGIONAL WAF 挂
 *   公网 ALB(仅 443,80 → 301)+ 限速、Cognito JWT、ALB 访问日志、S3 全 BLOCK_ALL、GPU 私网)。
 * - 此处豁免的都是:① CloudFront 默认证书固有项;② CDK 生成的辅助角色(ECS drain hook 等)带
 *   AWS 托管策略 / 通配;③ 骨架阶段占位资源(stub 镜像/handler),实现就位后会收紧;
 *   ④ 运营硬化项(EBS 加密、详细监控、容器非 root 等)留详细设计。
 */
import { NagSuppressions } from 'cdk-nag';
import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export function applyNagSuppressions(scope: Construct): void {
  const stack = Stack.of(scope);

  NagSuppressions.addStackSuppressions(stack, [
    // ── Cognito MFA(用户决定不强制)──
    {
      id: 'AwsSolutions-COG2',
      reason:
        '用户明确决定不强制 MFA(简化登录),改 Mfa.OPTIONAL 保留 TOTP 自愿开启。' +
        '鉴权红线由 JWT 强校验(RS256/iss/aud/exp/token_use)+ REGIONAL WAF(限速)+ 仅 443 入口 + ' +
        'FeaturePlan.PLUS 高级安全守护;MFA 非强制为产品取舍。',
    },
    // ── IAM(CDK 生成的策略 / 骨架阶段广权,实现就位后收紧) ──
    {
      id: 'AwsSolutions-IAM5',
      reason:
        '骨架阶段:CDK 自动注入的 ECR/日志/ECS-drain 辅助策略含通配;Bedrock 已收窄到 ' +
        'foundation-model + inference-profile ARN(非 *)。详细设计接真实 handler 时按最小权限进一步收紧。',
    },
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'CDK 为 EC2/Lambda/ECS-drain 辅助角色附加的 AWS 托管策略(AmazonSSMManagedInstanceCore / ' +
        'AWSLambdaBasicExecutionRole 等)。属平台标准最小集,详细设计评估是否替换为自定义最小策略。',
    },

    // ── 骨架阶段占位资源 / 运营硬化项(详细设计落实) ──
    {
      id: 'AwsSolutions-ECS2',
      reason: '骨架阶段任务定义用占位环境变量(表名/桶名)。详细设计改为 Secrets Manager / SSM 注入敏感项。',
    },
    {
      id: 'AwsSolutions-ECS4',
      reason: 'GPU ECS 集群骨架阶段未开 Container Insights;详细设计随可观测性接入开启。',
    },
    {
      id: 'AwsSolutions-EC26',
      reason: '骨架阶段 ASG 启动配置未声明 EBS 加密;详细设计在 LaunchTemplate 开启 EBS KMS 加密。',
    },
    {
      id: 'AwsSolutions-EC23',
      reason:
        '公网 ALB 443/80 的 0.0.0.0/0 入站是公网入口本意(设计决策 去 CloudFront,域名直挂);' +
        '80 仅 301 跳 443;REGIONAL WAF 限速 + app 层四种认证 fail-closed 兜底。另 VPC CIDR 内部东西向' +
        '规则引用 intrinsic CidrBlock 无法被 nag 静态校验。注:栈级豁免——「除 ALB 443/80 外无 ' +
        '0.0.0.0/0 入站」的真正守门是 CDK UT 的字段级断言(aim-stack.test.ts),新增公网入站会被测试拦下。',
    },
    {
      id: 'AwsSolutions-AS3',
      reason: '骨架阶段 ASG 未配全部 scaling 通知;详细设计接 CloudWatch 告警/通知。',
    },
    {
      id: 'AwsSolutions-L1',
      reason: 'Lambda(Evaluator / ECS-drain hook)运行时由 CDK 固定;详细设计跟进最新运行时版本。',
    },
    {
      id: 'AwsSolutions-SNS3',
      reason: 'CDK 为 ASG 生命周期 drain hook 自动生成的 SNS Topic 未强制 SSL;属平台生成资源,详细设计评估。',
    },
    // ── Secrets Manager:候选人链接 HMAC 密钥不配自动轮换 ──
    {
      id: 'AwsSolutions-SMG4',
      reason:
        '候选人自助一次性链接的 HMAC 签名密钥(design contract)有意不自动轮换:轮换会使所有已发出、未使用的 ' +
        '候选人链接立即失效(签名校验失败),与「短期一次性链接」语义冲突,反伤可用性。密钥由 Secrets ' +
        'Manager 强随机生成、KMS 静态加密、仅控制面 task role 可读;泄露时手动轮换即可。',
    },
  ]);
}
