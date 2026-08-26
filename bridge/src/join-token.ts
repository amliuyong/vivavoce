/**
 * join token 验签(M1-B,跨栈契约冻结)。
 *
 * 格式:`v1.<session_id>.<exp_unix>.<sig>`
 *   sig = base64url 无 padding( HMAC-SHA256(key = AIM_BRIDGE_CALLBACK_SECRET 的值,
 *                                            msg = "v1.<session_id>.<exp_unix>") )
 *   exp_unix = 秒级 Unix 时间戳(nowMs >= exp*1000 即过期)。
 *
 * backend 侧签发(同一密钥双用途:/sessions/:id/ready 的 X-Bridge-Secret 与 join token HMAC key)。
 * 本模块只做纯函数验签:格式 / HMAC(timingSafeEqual 防时序侧信道)/ 过期。
 * fail-closed:secret 空 → 一律 null(未配密钥不得放行任何 token)。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** token 长度上限(防超长输入进 HMAC/split;正常 token 远小于此)。 */
const MAX_TOKEN_LEN = 4096;

/**
 * 验签一枚 join token。
 * @returns 验签通过 → `{ sessionId }`;格式坏 / 签名不符 / 已过期 / secret 空 → `null`。
 */
export function verifyJoinToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): { sessionId: string } | null {
  if (!secret) return null; // fail-closed:密钥未配 → 拒绝一切 token
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LEN) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, sessionId, expStr, sig] = parts;
  if (version !== "v1") return null;
  if (!sessionId) return null;
  if (!/^\d{1,15}$/.test(expStr)) return null; // 秒级时间戳:纯数字、防超长
  const exp = Number(expStr);
  if (!Number.isSafeInteger(exp)) return null;
  // 先验签后验期:两者失败对调用方等价(都是 auth_failed),顺序不泄漏信息。
  const expected = createHmac("sha256", secret).update(`v1.${sessionId}.${expStr}`).digest();
  const actual = Buffer.from(sig, "base64url");
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;
  if (nowMs > exp * 1000) return null; // 过期(与 backend join_token.py 同口径:now > exp 才失效,恰等于 exp 仍有效)
  return { sessionId };
}
