/**
 * 媒体面只读 `GET /config` 端点(design contract)—— 把 registry 的**冻结快照**序列化给控制面聚合。
 *
 * ## 鉴权:fail-closed(D9 红线)
 *
 * 复用 bridge 既有 **`X-Bridge-Secret` 凭据**(与 `/sessions/:id/ready`·`/hangup` 同一凭据,
 * 不新增密钥 —— 新凭据只增轮换负担而不改变主体与信任边界)。契约:
 *
 * | 情况 | 状态码 | 理由 |
 * |---|---|---|
 * | `AIM_BRIDGE_CALLBACK_SECRET` 未配置 | **503** | 端点禁用(区分「没开这功能」与「你没权限」,便于运维定位) |
 * | 头缺失 / 不匹配 | **401** | 拒绝 |
 * | 匹配 | 200 | 返回快照 |
 *
 * ⚠ 与 `/ready`·`/hangup` 的**契约差异**:那两处密钥未配时也走 401(`index.ts` 的 `!secret ||` 短路),
 * 本端点未配时是 **503**。故实现 MUST NOT 直接照抄它们的判断式。
 *
 * ## 双层防护(design contract)
 *
 * 1. **网络层**:本端点只经内网 Cloud Map(`rt.<stack>.local:3001`)由控制面调用。
 *    `/rt/config` **MUST NOT** 进 ALB path allowlist(只允许 `/rt/ws`、`/rt/health`、`/v1/realtime`)。
 * 2. **应用层**(本文件):仍自带 fail-closed 鉴权作纵深第二层 —— path allowlist 是一行 CDK 配置,
 *    将来误加通配(`/rt/*`)即失效,而本层不随之失效。
 *
 * 诊断配置虽非凭据,但暴露全套打断/VAD/沉默违规阈值等于给出**对抗考试防作弊机制的说明书**
 * (如得知 `AIM_SILENCE_VIOLATION_MS` 便可精确规避沉默判定),故不适用「只读即可匿名」的宽松口径。
 *
 * ## 响应信封
 *
 * `{ schema_version, source, entries[] }` —— 带版本才能让控制面区分「版本不兼容」与「格式损坏」
 * (review)。
 */
import * as crypto from "crypto";

import { loadRuntimeConfig, type ConfigEntry } from "./runtime-config";

/**
 * 响应 schema 版本。**破坏性改 entries 结构时 MUST +1**,控制面据此判兼容性。
 * v1 = `{ key, value, default, override_state }`。
 */
export const CONFIG_SCHEMA_VERSION = 1;

export interface ConfigResponse {
  schema_version: number;
  /** 来源标识(控制面按 `(source, key)` 复合身份去重;同名 key 可跨运行时并存)。 */
  source: "media";
  entries: ConfigEntry[];
}

export type ConfigOutcome =
  | { status: 200; body: ConfigResponse }
  | { status: 401 | 503; body: { error: string } };

/**
 * 常量时间比较(防时序侧信道)。长度不等直接判否 —— `timingSafeEqual` 要求等长入参,
 * 长度本身不是秘密。
 *
 * ℹ 现网 `/ready`(`index.ts:147`)与 `/hangup`(`:256`)用的是朴素 `!==`;常量时间比较是本 spec
 * 的**新增要求**,只作用于新端点。是否回改那两处属独立改动,不在本 spec 范围(避免夹带)。
 */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 纯判定:给定「配置的密钥」与「请求头带的密钥」,产出响应。
 *
 * 抽成纯函数便于单测(不起真 HTTP server);`handleConfigRequest` 只负责把它接到 node http 上。
 */
export function evaluateConfigRequest(
  expectedSecret: string | undefined,
  providedSecret: string | undefined,
): ConfigOutcome {
  // 未配密钥 → 端点禁用(503)。MUST 先判这个:否则「没配」会被当成「没权限」,掩盖配置缺失。
  if (!expectedSecret) {
    return { status: 503, body: { error: "config_endpoint_disabled" } };
  }
  if (!secretMatches(providedSecret, expectedSecret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  return {
    status: 200,
    body: {
      schema_version: CONFIG_SCHEMA_VERSION,
      source: "media",
      entries: loadRuntimeConfig(),
    },
  };
}

/** node http 适配:`GET /config`(与 `/rt/config` 前缀等价路径同一 handler)。 */
export function handleConfigRequest(
  req: { headers: Record<string, string | string[] | undefined> },
  res: {
    writeHead(status: number, headers: Record<string, string>): void;
    end(body?: string): void;
  },
  expectedSecret: string | undefined,
): void {
  const raw = req.headers["x-bridge-secret"];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  const outcome = evaluateConfigRequest(expectedSecret, provided);
  res.writeHead(outcome.status, {
    "Content-Type": "application/json",
    // 管理端诊断数据不缓存(review):避免中间层/浏览器缓存住旧快照冒充现状。
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(outcome.body));
}
