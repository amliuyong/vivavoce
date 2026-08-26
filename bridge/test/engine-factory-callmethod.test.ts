/**
 * design contract:engine-factory 按 call_method 选 streamer。用 fake GPU 连接,断言 createEngine 在
 * bedrock_converse 方式下(无 llmBearerToken,只有 bedrockApiKey)能正常建引擎(不走 mantle/IAM 回退)。
 */
import { createEngine } from "../src/engine-factory";
import { EngineParams } from "../src/voice-engine";
import { WsLike } from "../src/gpu-client";

// fake GPU WS(不连真 GPU):send/close/on 都 no-op。
function fakeGpu(): WsLike {
  return {
    send: () => {},
    close: () => {},
    on: () => {},
  };
}

const BASE: EngineParams = { engineType: "three_stage", language: "zh-CN" };

test("bedrock_converse 方式:无 mantle token,只 bedrockApiKey → 正常建引擎(不抛)", () => {
  const params: EngineParams = {
    ...BASE,
    llmCallMethod: "bedrock_converse",
    llmBedrockApiKey: "bedrock-key",
    llmMantleHost: "https://proxy.test",
    llmBedrockRegion: "us-east-1",
    llmModelId: "global.anthropic.claude-sonnet-4-6",
  };
  const engine = createEngine("sess_conv", params, { connectGpu: () => fakeGpu() });
  expect(engine).toBeTruthy();
});

test("mantle 方式(缺省):有 llmBearerToken → 正常建引擎", () => {
  const params: EngineParams = {
    ...BASE,
    llmBearerToken: "mantle-tok",
    llmMantleHost: "https://mantle.test",
    llmModelId: "zai.glm-4.7-flash",
  };
  const engine = createEngine("sess_mantle", params, { connectGpu: () => fakeGpu() });
  expect(engine).toBeTruthy();
});

test("bedrock_converse + fallback 备用模型 → 包 FallbackLlmStreamer(不抛,全局单选同 wire)", () => {
  const params: EngineParams = {
    ...BASE,
    llmCallMethod: "bedrock_converse",
    llmBedrockApiKey: "bedrock-key",
    llmMantleHost: "https://proxy.test",
    llmBedrockRegion: "us-east-1",
    llmModelId: "global.anthropic.claude-sonnet-4-6",
    llmFallbackModelIds: ["global.anthropic.claude-opus-4-7"],
  };
  const engine = createEngine("sess_conv_fb", params, { connectGpu: () => fakeGpu() });
  expect(engine).toBeTruthy();
});

test("非法 engineType → fail-fast(不静默降级)", () => {
  expect(() => createEngine("sess_bad", { ...BASE, engineType: "s2s" as never }, { connectGpu: () => fakeGpu() }))
    .toThrow(/engineType/);
});
