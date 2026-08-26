import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface DefaultLlmConfigSeedProps {
  llmConfigSecret: secretsmanager.ISecret;
  /** 中国区(aws-cn):清单不含任何 Anthropic(Claude/Sonnet 地域封锁,选了必 400)。 */
  isCnPartition: boolean;
}

/**
 * 预置默认 LLM 配置(一安装即有,无需事后 admin API 配)。照 DefaultAgentsSeed 模式:
 * Lambda CustomResource **仅在 Secret 为空/缺配置时** seed 默认 models 清单 + default_model + evaluator_model,
 * **绝不覆盖已有配置**(尤其 api_key / enabled —— 生产已配的 Bearer token 不能被冲掉)。
 *
 * 分区感知清单(设计决策):
 *   - 非中国:GLM + MiniMax + Sonnet 5 + Haiku 4.5(Anthropic 仅非中国可用)。
 *   - 中国区:GLM + MiniMax(不含 Anthropic;Claude/Sonnet 从中国经 mantle 被地域封锁返 400)。
 * 两分区都:default_model=zai.glm-4.7-flash(便宜快)、evaluator_model=minimax.minimax-m2.5(打分)。
 * ASR 字幕修正模型(design contract)分区差异:
 *   - 非中国:transcript_fixer_model=anthropic.claude-haiku-4-5(清单含 Anthropic,开箱即修字幕错字)。
 *   - 中国区:**不 seed**(留空=不修)。初装时中国区清单不含 Anthropic,若强 seed Haiku 会落非法配置
 *     (validate_default_in_models 失败)。待 admin 配好跨区代理 token + 把 Haiku 加入清单后,在配置页自行选。
 * token 不 seed(每环境不同,必须 admin 填);enabled 不动(seed 只补清单/模型,不擅自启用)。
 *
 * 分区感知 mantle host(deployment validation 实测,见 docs/CROSSBORDER-LLM.md):
 *   - 中国区:**东京** ap-northeast-1(跨境地理最近,GLM 首字节 ~0.6s vs 美东 ~1.3s,快一倍以上)。
 *   - 非中国(Global us-east-1 部署):**美东** us-east-1(本地端点最近)。
 * 两端点同 token 通用,只是地理远近之差。host 仅在 Secret 无配置时 seed,不覆盖 admin 已改的值。
 */
export class DefaultLlmConfigSeed extends Construct {
  constructor(scope: Construct, id: string, props: DefaultLlmConfigSeedProps) {
    super(scope, id);

    // 分区感知的默认 models 清单(JSON 传给 Lambda,避免在 handler 里再判分区)。
    const models = props.isCnPartition
      ? [
          { id: 'zai.glm-4.7-flash', label: 'GLM 4.7 Flash(最便宜)' },
          { id: 'minimax.minimax-m2.5', label: 'MiniMax M2.5' },
        ]
      : [
          { id: 'zai.glm-4.7-flash', label: 'GLM 4.7 Flash(最便宜)' },
          { id: 'minimax.minimax-m2.5', label: 'MiniMax M2.5' },
          { id: 'anthropic.claude-sonnet-5', label: 'Claude Sonnet 5' },
          { id: 'anthropic.claude-haiku-4-5', label: 'Claude Haiku 4.5' },
        ];

    // 分区感知默认 mantle host:中国区跨境走东京(地理最近,首字节快一倍);非中国用本地美东。
    // 同 token 通用,仅远近之别(见 docs/CROSSBORDER-LLM.md 实测)。
    const defaultHost = props.isCnPartition
      ? 'https://bedrock-mantle.ap-northeast-1.api.aws'
      : 'https://bedrock-mantle.us-east-1.api.aws';

    const seedFn = new lambda.Function(this, 'SeedFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromInline(`
import boto3, json, os, urllib.request

# 分区感知默认清单(CDK 注入),+ 固定 default/evaluator。token 不 seed。
DEFAULT_MODELS = json.loads(os.environ["DEFAULT_MODELS"])
DEFAULT_MODEL = "zai.glm-4.7-flash"
EVALUATOR_MODEL = "minimax.minimax-m2.5"
# design contract:ASR 字幕修正模型。非中国区 = Haiku(开箱即修);中国区注入空串(不 seed,留待 admin 配代理后自选)。
FIXER_MODEL = os.environ.get("FIXER_MODEL", "")
DEFAULT_HOST = os.environ["DEFAULT_HOST"]  # 分区感知(CDK 注入):中国区东京 / 非中国美东。
SECRET_ID = os.environ["SECRET_ID"]

def _send(event, ctx, status, reason=""):
    body = json.dumps({"Status": status, "Reason": reason or "ok", "PhysicalResourceId": "default-llm-config-seed",
        "StackId": event["StackId"], "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"], "Data": {}}).encode()
    req = urllib.request.Request(event["ResponseURL"], data=body, method="PUT", headers={"content-type": ""})
    urllib.request.urlopen(req)

def handler(event, ctx):
    try:
        if event["RequestType"] != "Delete":
            sm = boto3.client("secretsmanager")
            # 读现有配置:仅在「未配 models」时 seed(不覆盖 api_key/enabled/已改的清单)。
            try:
                cur = json.loads(sm.get_secret_value(SecretId=SECRET_ID).get("SecretString") or "{}")
            except Exception:
                cur = {}
            if not cur.get("models"):
                merged = dict(cur)
                merged["models"] = DEFAULT_MODELS
                merged.setdefault("host", DEFAULT_HOST)
                merged.setdefault("default_model", DEFAULT_MODEL)
                merged.setdefault("evaluator_model", EVALUATOR_MODEL)
                # design contract:仅非中国区 seed 字幕修正默认模型(FIXER_MODEL 非空);中国区为空 → 不设(留空=不修)。
                if FIXER_MODEL:
                    merged.setdefault("transcript_fixer_model", FIXER_MODEL)
                # enabled / api_key 不擅动:保留现值(缺省即 false/空,由 admin 填 token 后启用)。
                merged.setdefault("enabled", cur.get("enabled", False))
                merged.setdefault("api_key", cur.get("api_key", ""))
                sm.put_secret_value(SecretId=SECRET_ID, SecretString=json.dumps(merged, ensure_ascii=False))
        _send(event, ctx, "SUCCESS")
    except Exception as e:
        _send(event, ctx, "FAILED", str(e))
`),
      environment: {
        SECRET_ID: props.llmConfigSecret.secretArn,
        DEFAULT_MODELS: JSON.stringify(models),
        DEFAULT_HOST: defaultHost,
        // design contract:非中国区 seed Haiku 修字幕;中国区留空(清单初装无 Anthropic,配好代理后 admin 自选)。
        FIXER_MODEL: props.isCnPartition ? '' : 'anthropic.claude-haiku-4-5',
      },
    });
    // seed 需读+写该 Secret(读判断是否已配、写 seed 默认)。最小权限:仅此 Secret。
    props.llmConfigSecret.grantRead(seedFn);
    props.llmConfigSecret.grantWrite(seedFn);

    const provider = new Provider(this, 'SeedProvider', { onEventHandler: seedFn });
    new cdk.CustomResource(this, 'LlmConfigSeed', {
      serviceToken: provider.serviceToken,
      properties: { Nonce: cdk.Names.uniqueId(this) },
    });
  }
}
