import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import * as path from 'path';
import { LAMBDA_ARCH } from '../common/arch';

/**
 * Event plane:Evaluator Lambda(Python)。
 * SessionEvents Streams 触发 → 会话结束(meta.status=completed)→ 按 rubric 打分 → 写 Results。
 * DynamoDB Streams trigger evaluation and result persistence.
 */
export interface EvaluatorProps {
  stackName: string;
  sessionEventsTable: dynamodb.Table;
  resultsTable: dynamodb.Table;
  /** PII 表 CMK:Evaluator 读 SessionEvents(转写)+ 写 Results 需解密权 */
  dataEncryptionKey: kms.IKey;
  /** rubric 打分用的 Bedrock 模型(评估侧;IAM 回退默认。mantle 配了 evaluator_model 则以其为准) */
  evaluatorModelId: string;
  /** Integration 表:打分完成后发 result.ready webhook(design contract),需读订阅 + 写死信 */
  integrationTable: dynamodb.Table;
  /** design contract LlmConfigSecret(mantle host + Bearer token + evaluator_model):打分跨境调美东 mantle。
   *  中国区无 Bedrock、不授 IAM,evaluator 必须经此跨境(BUG-1 修复)。配了则走 mantle,否则回退 IAM(仅 Global)。 */
  llmConfigSecret?: secretsmanager.ISecret;
}

export class Evaluator extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: EvaluatorProps) {
    super(scope, id);

    this.fn = new lambda.Function(this, 'Fn', {
      functionName: `${props.stackName}-evaluator`,
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: LAMBDA_ARCH,
      handler: 'handler.on_event',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambda', 'evaluator')),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        RESULTS_TABLE_NAME: props.resultsTable.tableName,
        SESSION_EVENTS_TABLE_NAME: props.sessionEventsTable.tableName,
        // rubric 打分模型(IAM 回退默认;mantle 的 evaluator_model 优先。单一事实源 bedrock-region.ts → Stack 下发)
        AIM_EVALUATOR_MODEL_ID: props.evaluatorModelId,
        // result.ready webhook(design contract):打分完成向订阅方推送结果摘要 + 拉取链接
        INTEGRATION_TABLE_NAME: props.integrationTable.tableName,
        // design contract 跨境打分(BUG-1):配了则 handler 读此 Secret 取 mantle host+token+evaluator_model,
        // 走跨境 HTTP;未配(Global 无此需求)→ handler 回退 IAM Bedrock(region 钉 us-east-1)。
        ...(props.llmConfigSecret ? { AIM_LLM_CONFIG_SECRET_ID: props.llmConfigSecret.secretArn } : {}),
      },
    });

    // 仅在「会话结束」事件触发打分:过滤 SK=meta 且 status=completed(详细设计精化过滤器)
    this.fn.addEventSource(
      new DynamoEventSource(props.sessionEventsTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
        bisectBatchOnError: true,
      }),
    );

    props.resultsTable.grantReadWriteData(this.fn);
    props.sessionEventsTable.grantReadData(this.fn);
    props.integrationTable.grantReadWriteData(this.fn); // 读 webhook 订阅 + 写死信(result.ready)
    props.dataEncryptionKey.grantEncryptDecrypt(this.fn); // PII 表 CMK 加解密
    // 跨境打分(BUG-1):授 evaluator 读 LlmConfigSecret(mantle Bearer token)。evaluator 是事件面私网
    // Lambda(非公网媒体面),单独授权与 design contract「token 不外扩公网媒体面」正交,不违红线。
    props.llmConfigSecret?.grantRead(this.fn);

    // 注:打分若用 Bedrock Claude(§8)的 InvokeModel 权限,由 Stack 末尾统一的 grantBedrock()
    // 收窄授予(foundation-model + inference-profile ARN,非 resources:'*'),与媒体面/控制面一致。
  }
}
