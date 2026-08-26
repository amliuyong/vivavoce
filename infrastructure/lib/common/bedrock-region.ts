/**
 * region → Bedrock 模型 ID 映射(模型 ID 单一事实源,由 Stack 下发,勿在运行时代码硬编码)。
 * Global 支持 us-west-2 / us-east-1;**中国区(cn-north-1/cn-northwest-1)取 us-east-1 映射**——
 * 中国区无 Bedrock,LLM 一律跨境调美东(VISION §2 拍板:Bedrock API key/Bearer 形式,design contract
 * mantle wire;IAM 回退路径在中国区不可用,配置 LlmConfigSecret 后不看这些默认值)。
 * 其它 region 一律 fail-fast,避免部署到模型不可用的区域。
 *
 * ⚠ Claude 调用**必须经跨区 inference profile**(`us.` 前缀):新一代 Claude 在 Bedrock 上不支持用裸
 *   foundation-model ID 做 on-demand InvokeModel/InvokeModelWithResponseStream(会报
 *   "on-demand throughput isn't supported")。故下面 Claude 的 ID 一律用 `us.` inference profile。
 *   部署前仍须按账号实际可用的 profile ID 校准(型号串/版本日期可能变)。
 *
 * 注:Nova S2S 引擎已删(VISION §1),novaSonic 映射随之移除。
 */

export type SupportedRegion = 'us-west-2' | 'us-east-1';

/** 中国区 region(cn 分区):无 Bedrock/Cognito,LLM 跨境调美东(VISION §2)。 */
export const CN_REGIONS = ['cn-north-1', 'cn-northwest-1'] as const;

export function isCnRegion(region: string): boolean {
  return (CN_REGIONS as readonly string[]).includes(region);
}

export interface BedrockModels {
  /** 三段式默认对话 LLM(IAM 回退路径:BedrockStreamer 经 SigV4 调 InvokeModel;design contract 未配 mantle token 时用)。
   *  Claude → 必须 us. inference profile。配了 mantle token 时模型走 LlmConfigSecret,不看此值。 */
  llmDefault: string;
  /** 评估侧 Evaluator 的 rubric 打分强模型(与三段式对话 LLM 不同用途)。Claude → 必须 us. inference profile */
  evaluator: string;
}

// 注:Claude 一律用 `us.` 跨区 inference profile(on-demand streaming 的硬性要求);部署前按账号实际 profile 校准。
const MODELS_BY_REGION: Record<SupportedRegion, BedrockModels> = {
  'us-west-2': {
    llmDefault: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', // 三段式 IAM 回退默认 = Claude Haiku 4.5(inference profile)
    evaluator: 'us.anthropic.claude-sonnet-4-6', // 评估打分用更强模型(inference profile;注:Sonnet 4.6 的 profile ID 无 -v1:0 后缀,实测账号可用)
  },
  'us-east-1': {
    llmDefault: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    evaluator: 'us.anthropic.claude-sonnet-4-6', // Sonnet 4.6 profile ID 无 -v1:0 后缀(实测账号可用)
  },
};

export function isSupportedRegion(region: string): region is SupportedRegion {
  return region === 'us-west-2' || region === 'us-east-1';
}

/** 取该 region 的模型映射;中国区取 us-east-1(LLM 跨境调美东);其它不支持 region 抛错(synth fail-fast)。 */
export function bedrockModelsFor(region: string): BedrockModels {
  if (isCnRegion(region)) {
    return MODELS_BY_REGION['us-east-1'];
  }
  if (!isSupportedRegion(region)) {
    throw new Error(
      `Unsupported region '${region}'. 支持 us-west-2 / us-east-1 / ${CN_REGIONS.join(' / ')}。` +
        `如需扩展,请在 bedrock-region.ts 增加映射并确认 Bedrock 在该 region 可用(分区无关见 VISION §2)。`,
    );
  }
  return MODELS_BY_REGION[region];
}
