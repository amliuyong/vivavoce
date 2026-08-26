#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AimStack } from '../lib/aim-stack';

const app = new cdk.App();
// cdk-nag:对全栈施加 AwsSolutionsChecks 安全合规规则(IAM 通配/公网/加密/WAF…)。
// 合理豁免集中登记在 lib/common/nag-suppressions.ts,且必须带理由。
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

/**
 * Required-context guard:缺失/拼错的 context 在 synth 时 fail-fast,
 * 不让空串流到运行时变成晦涩的 boto3 ValidationException。
 * tryGetContext 对拼错的 key 静默返回 undefined,所以拼写很重要。
 */
function requireContext(key: string): string {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error(
      `Missing required CDK context '${key}'. ` +
        `Pass --context ${key}=<value> or run ./scripts/viva with .env and .env.region.`,
    );
  }
  return String(raw);
}

// VivaVoce 默认栈名。
const stackName = app.node.tryGetContext('stackName') || 'Voce';
// adminEmail 在纯 synth 时允许空;真实部署由 scripts/viva 注入。
const adminEmail = (app.node.tryGetContext('adminEmail') || '') as string;
// engineType:默认引擎,只剩 three_stage(Nova s2s 已删,VISION §1;开关保留为将来引擎扩展留缝)。
const engineType = (app.node.tryGetContext('engineType') || 'three_stage') as string;
if (engineType !== 'three_stage') {
  throw new Error(`Invalid engineType '${engineType}'. Must be 'three_stage'.`);
}
// 注:platform(teams/feishu)是 per-Campaign/Session 运行时属性(建 Campaign / CSV 行选),
//     存 DynamoDB,不是部署级开关 —— 故不在此读取。
//     Campaign 是核心功能、永远存在,媒体面 ASG 规模由 constants 控制,无部署开关。

// Region guard. Extending this list requires service, GPU, identity, and
// data-residency validation rather than only a code change.
const region = (app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'us-east-1') as string;
const ALLOWED_REGIONS = ['us-east-1', 'cn-north-1', 'cn-northwest-1'];
if (!ALLOWED_REGIONS.includes(region)) {
  throw new Error(
    `Unsupported region '${region}'. Supported: ${ALLOWED_REGIONS.join(' / ')}.`,
  );
}
const account = app.node.tryGetContext('account') || undefined;

new AimStack(app, stackName, {
  stackName,
  adminEmail,
  engineType,
  env: { account, region },
  description:
    'VivaVoce - 公网 ALB(REGIONAL WAF)/ Cognito / ECS Fargate(控制面+实时会话)/ EC2-GPU ASG(ASR+TTS) / DynamoDB / Bedrock mantle LLM',
});

// 防止未使用告警(requireContext 在详细设计接 adminEmail 必填时启用)
void requireContext;
