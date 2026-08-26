import { createEngine } from "../src/engine-factory";
import { EngineParams } from "../src/voice-engine";

it("非法 engineType 运行时抛错(不静默降级)", () => {
  const params = { engineType: "invalid_type" } as any as EngineParams;
  expect(() => createEngine("test", params, {})).toThrow("非法 engineType");
});

it("s2s 已删除:历史数据带 s2s 的会话 fail-fast(不静默换引擎)", () => {
  const params = { engineType: "s2s", language: "zh-CN" } as any as EngineParams;
  expect(() => createEngine("test", params, {})).toThrow("非法 engineType");
});
