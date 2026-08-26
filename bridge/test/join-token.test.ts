/**
 * join-token 验签单测(M1-B 跨栈契约冻结):
 *   token = `v1.<session_id>.<exp_unix>.<sig>`,
 *   sig = base64url 无 padding(HMAC-SHA256(key=AIM_BRIDGE_CALLBACK_SECRET, msg="v1.<sid>.<exp>"))。
 * 覆盖:合法 / 过期(含边界)/ 坏签名 / 坏格式 / 空 secret(fail-closed)。
 */
import { createHmac } from "node:crypto";
import { verifyJoinToken } from "../src/join-token";

const SECRET = "test-bridge-secret";

/** 按冻结契约签一枚 token(与 backend 侧签发算法一致)。 */
function mkToken(sessionId: string, expUnix: number, secret: string = SECRET): string {
  const msg = `v1.${sessionId}.${expUnix}`;
  const sig = createHmac("sha256", secret).update(msg).digest("base64url");
  return `${msg}.${sig}`;
}

const NOW_MS = 1_800_000_000_000; // 固定时基,测试确定性
const FUTURE = Math.floor(NOW_MS / 1000) + 300; // 5min 后过期

test("合法 token → 返回 sessionId", () => {
  const token = mkToken("sess_abc123", FUTURE);
  expect(verifyJoinToken(token, SECRET, NOW_MS)).toEqual({ sessionId: "sess_abc123" });
});

test("过期 token → null(exp 已过)", () => {
  const past = Math.floor(NOW_MS / 1000) - 60;
  expect(verifyJoinToken(mkToken("sess_a", past), SECRET, NOW_MS)).toBeNull();
});

test("过期边界(与 backend join_token.py 同口径):恰等于 exp 仍有效,过 exp 即失效", () => {
  const exp = Math.floor(NOW_MS / 1000) + 10;
  const token = mkToken("sess_edge", exp);
  expect(verifyJoinToken(token, SECRET, exp * 1000)).toEqual({ sessionId: "sess_edge" }); // now == exp 仍有效
  expect(verifyJoinToken(token, SECRET, exp * 1000 + 1)).toBeNull(); // now > exp → 过期
});

test("坏签名:换密钥签的 / 篡改 sig / 篡改 session_id → null", () => {
  expect(verifyJoinToken(mkToken("sess_a", FUTURE, "wrong-secret"), SECRET, NOW_MS)).toBeNull();
  const good = mkToken("sess_a", FUTURE);
  // 篡改 sig 一个字符(保持长度,走 timingSafeEqual 分支)
  const flipped = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
  expect(verifyJoinToken(flipped, SECRET, NOW_MS)).toBeNull();
  // 篡改 payload(session_id)但保留原 sig
  const parts = good.split(".");
  expect(verifyJoinToken(`v1.sess_b.${parts[2]}.${parts[3]}`, SECRET, NOW_MS)).toBeNull();
});

test("坏格式 → null(段数/版本/空 sid/非数字 exp/空串/超长)", () => {
  expect(verifyJoinToken("", SECRET, NOW_MS)).toBeNull();
  expect(verifyJoinToken("v1.only.three", SECRET, NOW_MS)).toBeNull(); // 3 段
  expect(verifyJoinToken("v1.a.b.c.d", SECRET, NOW_MS)).toBeNull(); // 5 段(sid 含点)
  expect(verifyJoinToken(mkToken("sess_a", FUTURE).replace(/^v1/, "v2"), SECRET, NOW_MS)).toBeNull(); // 版本
  const sigForEmpty = createHmac("sha256", SECRET).update(`v1..${FUTURE}`).digest("base64url");
  expect(verifyJoinToken(`v1..${FUTURE}.${sigForEmpty}`, SECRET, NOW_MS)).toBeNull(); // 空 sid
  const sigBadExp = createHmac("sha256", SECRET).update("v1.sess_a.abc").digest("base64url");
  expect(verifyJoinToken(`v1.sess_a.abc.${sigBadExp}`, SECRET, NOW_MS)).toBeNull(); // exp 非数字
  expect(verifyJoinToken("v1." + "x".repeat(5000) + `.${FUTURE}.AAAA`, SECRET, NOW_MS)).toBeNull(); // 超长
});

test("sig 长度不符(截断/非 32 字节)→ null(不进 timingSafeEqual 抛错)", () => {
  const good = mkToken("sess_a", FUTURE);
  const truncated = good.slice(0, good.lastIndexOf(".") + 5); // sig 只剩 4 字符
  expect(verifyJoinToken(truncated, SECRET, NOW_MS)).toBeNull();
});

test("空 secret → null(fail-closed:未配密钥不放行任何 token,即使 token 本身「合法」)", () => {
  const token = mkToken("sess_a", FUTURE, ""); // 即使用空密钥自签也不行
  expect(verifyJoinToken(token, "", NOW_MS)).toBeNull();
  expect(verifyJoinToken(mkToken("sess_a", FUTURE), "", NOW_MS)).toBeNull();
});
