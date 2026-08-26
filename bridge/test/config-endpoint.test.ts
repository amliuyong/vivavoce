/**
 * design contract —— 媒体面 `GET /config` 端点单测。
 *
 * 重点是**鉴权 fail-closed**(D9 红线):未配密钥 503 / 缺头或错头 401 / 对头 200。
 * vivavoce 的 bridge 挂公网 ALB(靠 path allowlist 挡住本端点),故应用层鉴权是纵深第二层 ——
 * allowlist 是一行 CDK 配置,误加通配即失效,而本层不随之失效。
 */
import {
  CONFIG_SCHEMA_VERSION,
  evaluateConfigRequest,
  handleConfigRequest,
} from "../src/config-endpoint";
import { TUNABLE_KEYS } from "../src/runtime-config";

const SECRET = "s3cr3t-bridge-callback";

/** 收集 writeHead/end 的假 res。 */
function fakeRes() {
  const captured: { status?: number; headers?: Record<string, string>; body?: string } = {};
  return {
    res: {
      writeHead(status: number, headers: Record<string, string>) {
        captured.status = status;
        captured.headers = headers;
      },
      end(body?: string) {
        captured.body = body;
      },
    },
    captured,
  };
}

describe("design contract —— /config 鉴权 fail-closed", () => {
  it("密钥未配置 → 503 端点禁用(不是 401:区分「没开功能」与「没权限」)", () => {
    for (const unset of [undefined, ""]) {
      const out = evaluateConfigRequest(unset, SECRET);
      expect(out.status).toBe(503);
      expect(out.body).toEqual({ error: "config_endpoint_disabled" });
    }
  });

  it("头缺失 → 401", () => {
    const out = evaluateConfigRequest(SECRET, undefined);
    expect(out.status).toBe(401);
    expect(out.body).toEqual({ error: "unauthorized" });
  });

  it("头不匹配 → 401(含长度相同/不同两种)", () => {
    expect(evaluateConfigRequest(SECRET, "wrong").status).toBe(401);
    // 等长但不同:验证常量时间比较分支也拒
    const sameLenWrong = "x".repeat(SECRET.length);
    expect(sameLenWrong.length).toBe(SECRET.length);
    expect(evaluateConfigRequest(SECRET, sameLenWrong).status).toBe(401);
  });

  it("头匹配 → 200 + 带版本信封", () => {
    const out = evaluateConfigRequest(SECRET, SECRET);
    expect(out.status).toBe(200);
    if (out.status !== 200) throw new Error("unreachable");
    expect(out.body.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(out.body.source).toBe("media");
    expect(Array.isArray(out.body.entries)).toBe(true);
  });

  it("401/503 响应体不含任何配置数据(拒绝路径零泄漏)", () => {
    for (const out of [
      evaluateConfigRequest(undefined, SECRET),
      evaluateConfigRequest(SECRET, "wrong"),
    ]) {
      const text = JSON.stringify(out.body);
      expect(text).not.toMatch(/AIM_/);
      expect(text).not.toMatch(/entries/);
      expect(text).not.toMatch(/schema_version/);
    }
  });
});

describe("design contract —— /config 响应内容", () => {
  const ok = evaluateConfigRequest(SECRET, SECRET);
  if (ok.status !== 200) throw new Error("fixture 应为 200");
  const entries = ok.body.entries;

  it("条目覆盖全部 TUNABLE_KEYS(无缺、无多、无重)", () => {
    const keys = entries.map((e) => e.key);
    expect(keys.length).toBe(new Set(keys).size);
    expect([...keys].sort()).toEqual([...TUNABLE_KEYS].sort());
  });

  it("每条含 key/value/default/override_state 四字段且 override_state 是三态之一", () => {
    for (const e of entries) {
      expect(typeof e.key).toBe("string");
      expect(["string", "number", "boolean"]).toContain(typeof e.value);
      expect(["string", "number", "boolean"]).toContain(typeof e.default);
      expect(["absent", "valid", "ignored_invalid"]).toContain(e.override_state);
    }
  });

  /**
   * ★ 端点 MUST 报告业务**实际在用**的钳制后值,不是 env 原样。
   * `AIM_QUESTION_MAX_RETRY` 有 `max(1,…)`:即便 env 设 0,业务用的也是 1。
   */
  it("value 是钳制后的业务生效值(不是 env 原样)", () => {
    const entry = entries.find((e) => e.key === "AIM_QUESTION_MAX_RETRY");
    expect(entry).toBeDefined();
    expect(entry!.value as number).toBeGreaterThanOrEqual(1);
  });

  /**
   * ★ secret 类 key MUST NOT 出现在载荷里(design contract 独立 Requirement)。
   * 控制面的脱敏保护不了本端点自身的调用者 —— secret 若序列化进来就是直接泄漏。
   */
  it("整段响应不含任何 secret/寻址类 key(它们在 EXCLUDED_KEYS 里)", () => {
    const text = JSON.stringify(ok.body);
    for (const forbidden of [
      "AIM_BRIDGE_CALLBACK_SECRET",
      "AIM_EMBEDDING_SECRET",
      "AIM_GPU_WS_URL",
      "AIM_GPU_EMBEDDING_URL",
      "AIM_CONTROL_CALLBACK_URL",
      "AIM_MANTLE_HOST",
      "AIM_LLM_MODEL_ID",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("整段响应文本不含 fixture secret 明文(值形状守门)", () => {
    const text = JSON.stringify(ok.body);
    expect(text).not.toContain(SECRET);
  });
});

describe("design contract —— node http 适配", () => {
  it("200 路径:写 JSON + Cache-Control: no-store", () => {
    const { res, captured } = fakeRes();
    handleConfigRequest({ headers: { "x-bridge-secret": SECRET } }, res, SECRET);
    expect(captured.status).toBe(200);
    expect(captured.headers).toMatchObject({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    const body = JSON.parse(captured.body!);
    expect(body.schema_version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it("头是数组时取首个(node 允许重复 header)", () => {
    const { res, captured } = fakeRes();
    handleConfigRequest({ headers: { "x-bridge-secret": [SECRET, "other"] } }, res, SECRET);
    expect(captured.status).toBe(200);
  });

  it("未配密钥 → 503;错密钥 → 401", () => {
    const a = fakeRes();
    handleConfigRequest({ headers: { "x-bridge-secret": SECRET } }, a.res, undefined);
    expect(a.captured.status).toBe(503);

    const b = fakeRes();
    handleConfigRequest({ headers: {} }, b.res, SECRET);
    expect(b.captured.status).toBe(401);
  });
});
