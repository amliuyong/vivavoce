/**
 * 旁路 LLM 超时配置**叶子模块**(design contract)—— 字幕修正 / EOU 判定 / 违规裁判三条**旁路**
 * LLM 调用的超时默认值 + 钳制,收口在此。
 *
 * ## 为什么单独一个文件(而非留在各 verdict/fixer 模块里)
 *
 * 那三个模块(`moderation-verdict` / `eou-verdict` / `transcript-fixer`)是**行为模块**(会真发 LLM
 * 请求),测试普遍用 `jest.mock()` 拦掉它们、且 mock 工厂只声明用到的那一两个导出。若 registry
 * 从行为模块 import 配置,mock 一旦生效,registry 在模块加载期就会撞 `xxx is not a function`
 * —— 实测炸了 5 个 suite / 27 个用例。
 *
 * 配置属于**纯数据**,不该和「会触网的行为」同住一个模块。故下沉到本纯叶子:
 * ```
 * moderation-verdict / eou-verdict / transcript-fixer ─┐
 *                                                       ├─→ bypass-llm-config(本文件,纯叶子)
 * runtime-config(registry)─────────────────────────────┘
 * ```
 * 这样 registry 不依赖任何会被 mock 的行为模块,而三个行为模块自身仍复用同一份解析器(单一事实源)。
 *
 * ## 跨境标定要点(勿随意改小)
 *
 * 三者的上限按跨区域调用的延迟抖动设置。`AIM_EOU_VERDICT_TIMEOUT_MS` 尤其要紧 —— 它此前有**两处**
 * 独立钳制(本文件与 `turn-handling.ts`),design contract 要求收敛到这一份。
 *
 * ★ **design contract(deployment validation):`eouVerdictMs` 默认由 2000 改为 6000**,并把 `turn-handling.ts` 里那份
 *   独立硬编码(默认 2000 + 钳制 `[500,8000]` 均写死)改为 import 本模块 —— 完成 design contract 未做完的收敛。
 *   原注释说「跨境部署须调大(如 6000)」= 把正确值写在文档里让人部署时手设,而那份 env 于
 *   曾在重新部署时静默丢失。**正确值属于代码默认值,不属于部署脚本。**
 */

/** 三条旁路的超时默认值(ms)。 */
export const BYPASS_LLM_TIMEOUT_DEFAULTS = {
  /** EOU「说完没」判定:**6000**(design contract B 类,deployment validation 由 2000 改)。
   *
   *  为什么不是 2000:原默认 2000 在跨区域调用中经常超时,judge 要么先超时 fail-open、
   *  要么回来已超关联窗被丢弃,**两头都不纠偏**,L3 恒静默失效。
   *  也就是说 2000 不是「保守默认」而是**已知错误值**:只读页的说明文字自己写着「⚠ 跨境部署必调」。
   *  按铁律「默认值即最佳值」,把部署验证值 6000 回落为默认。
   *
   *  ⚠ 关联窗 `AIM_EOU_CORRELATION_MS` MUST ≥ 此值(judge 回来还要落在窗内);
   *  turn-handling 有启动期 fail-fast 守门。 */
  eouVerdictMs: 6_000,
  /** 字幕修正:比 EOU 宽(旁路慢不拖垮体感)。 */
  fixerMs: 8_000,
  /** 违规裁判:最宽(打分模型 + 结构化输出可能很慢)。 */
  moderationMs: 8_000,
} as const;

/** 各自的合法钳制区间(registry 展示与守门测试复用;勿在别处重写边界)。 */
export const BYPASS_LLM_TIMEOUT_BOUNDS = {
  eouVerdictMs: { min: 500, max: 8_000 },
  fixerMs: { min: 1_000, max: 15_000 },
  moderationMs: { min: 1_000, max: 20_000 },
} as const;

/** 通用:非法/非正 → 默认;否则夹到 [min, max]。逐字沿用三处原实现的判据。 */
function clampTimeout(
  raw: number,
  dflt: number,
  bounds: { min: number; max: number },
): number {
  if (!Number.isFinite(raw) || raw <= 0) return dflt;
  return Math.min(bounds.max, Math.max(bounds.min, raw));
}

/** EOU 判定超时。默认 6000(design contract),夹 [500, 8000]。 */
export function eouVerdictTimeoutMs(): number {
  return clampTimeout(
    Number(process.env.AIM_EOU_VERDICT_TIMEOUT_MS),
    BYPASS_LLM_TIMEOUT_DEFAULTS.eouVerdictMs,
    BYPASS_LLM_TIMEOUT_BOUNDS.eouVerdictMs,
  );
}

/** 字幕修正超时。默认 8000,夹 [1000, 15000]。 */
export function fixerTimeoutMs(): number {
  return clampTimeout(
    Number(process.env.AIM_TRANSCRIPT_FIXER_TIMEOUT_MS),
    BYPASS_LLM_TIMEOUT_DEFAULTS.fixerMs,
    BYPASS_LLM_TIMEOUT_BOUNDS.fixerMs,
  );
}

/** 违规裁判超时。默认 8000,夹 [1000, 20000]。 */
export function moderationTimeoutMs(): number {
  return clampTimeout(
    Number(process.env.AIM_MODERATION_TIMEOUT_MS),
    BYPASS_LLM_TIMEOUT_DEFAULTS.moderationMs,
    BYPASS_LLM_TIMEOUT_BOUNDS.moderationMs,
  );
}
