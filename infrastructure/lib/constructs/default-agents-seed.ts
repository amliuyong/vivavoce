import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface DefaultAgentsSeedProps {
  agentsTable: dynamodb.Table;
}

/**
 * 预置默认 Agent(一安装即有,无需事后手动 seed)。照 CognitoAuth 的 admin-seed 模式:
 * 单 Lambda CustomResource,每次部署(Create/Update)幂等 put 到 Agents 表(固定 agent_id → 重跑不重复建)。
 *
 * 目前预置「自由对话」Agent(产品第一入口「语音 Chat」的随便聊场景):dimension_score + 1 通用维度
 * (表达流畅度)+ 无题库(纯人设,dimension_score 无题合法)+ voice=male_std + self_bookable。
 * 留记录、轻量评分(不碰 evaluator 红线)。用户可在 Agents 页照常改/删(status/version 齐全)。
 */
export class DefaultAgentsSeed extends Construct {
  constructor(scope: Construct, id: string, props: DefaultAgentsSeedProps) {
    super(scope, id);

    const seedFn = new lambda.Function(this, 'SeedFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromInline(`
import boto3, json, os, urllib.request
from decimal import Decimal

# 固定 agent_id(幂等:部署重跑覆盖同一条,不重复建)。默认「自由对话」Agent。
FREECHAT = {
    "agent_id": "agent_freechat_default",
    "version": "v1",
    "status": "active",
    "name": "自由对话",
    "labels": [],
    "system_prompt": "你是一位友善的中文 AI 语音助手。用自然、口语化的简体中文与用户轻松对话,可以聊任何话题。回答简洁,像朋友聊天一样。",
    "rubric": {"mode": "dimension_score", "dimensions": [
        {"name": "表达流畅度", "description": "对话是否自然流畅", "weight": Decimal("1.0"), "max_score": Decimal("5.0")}]},
    "engine": {"engine_type": "three_stage", "language": "zh-CN", "voice": "male_std",
               "tts_provider": "gpu_omnivoice", "max_duration_s": 1800, "max_turns": 9999},
    "question_strategy": "sequential",
    "default_question_bank_id": None,
    "self_bookable": True,
}

def _send(event, ctx, status, reason=""):
    body = json.dumps({"Status": status, "Reason": reason or "ok", "PhysicalResourceId": "default-agents-seed",
        "StackId": event["StackId"], "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"], "Data": {}}).encode()
    req = urllib.request.Request(event["ResponseURL"], data=body, method="PUT", headers={"content-type": ""})
    urllib.request.urlopen(req)

def handler(event, ctx):
    try:
        # Delete 不删数据(用户可能已改/在用;避免 stack 更新误删)。仅 Create/Update 幂等 put。
        if event["RequestType"] != "Delete":
            table = boto3.resource("dynamodb").Table(os.environ["AGENTS_TABLE"])
            # 已存在则不覆盖(用户可能已在 Agents 页改过人设/音色);仅首次或缺失时建。
            existing = table.get_item(Key={"agent_id": FREECHAT["agent_id"]}).get("Item")
            if not existing:
                table.put_item(Item=FREECHAT)
        _send(event, ctx, "SUCCESS")
    except Exception as e:
        _send(event, ctx, "FAILED", str(e))
`),
      environment: { AGENTS_TABLE: props.agentsTable.tableName },
    });
    seedFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
      resources: [props.agentsTable.tableArn],
    }));

    const provider = new Provider(this, 'SeedProvider', { onEventHandler: seedFn });
    new cdk.CustomResource(this, 'FreechatAgentSeed', {
      serviceToken: provider.serviceToken,
      properties: {
        // 每次部署变更 → 触发 onEvent(幂等重跑,补齐带外删除)
        Nonce: cdk.Names.uniqueId(this),
      },
    });
  }
}
