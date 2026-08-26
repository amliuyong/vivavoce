/**
 * VAD/端点阈值解析 + synth-time 守门单测(constants.ts)。
 * 回归:空串 env 让 `Number("")===0` 绕过守门,把阈值 0(everything=speech)下发 → 永不出 turn_end。
 */
import { assertEndpointAboveVad, resolveVadEnergyThreshold, assertSilenceGapAboveHangover, ENDPOINT_SILENCE_GAP_MS, VAD_HANGOVER_MS } from '../lib/common/constants';

const VAD = 'AIM_VAD_ENERGY_THRESHOLD';
const EP = 'AIM_ENDPOINT_RMS_THRESHOLD';
const HANGOVER = 'AIM_VAD_HANGOVER_MS';
const SILENCE_GAP = 'AIM_ENDPOINT_SILENCE_GAP_MS';

function clearEnv() {
  delete process.env[VAD];
  delete process.env[EP];
  delete process.env[HANGOVER];
  delete process.env[SILENCE_GAP];
}

afterEach(clearEnv);

test('未设 env → 用默认(500/500),不变式满足', () => {
  clearEnv();
  expect(resolveVadEnergyThreshold()).toBe(500);
  expect(assertEndpointAboveVad()).toEqual({ vad: 500, endpoint: 500 });
});

test('空串 env 视作未设 → 回退默认(不再变 0 绕过守门)', () => {
  process.env[VAD] = '';
  process.env[EP] = '';
  // 回归核心:空串绝不能解析成 0 通过 isFinite 守门
  expect(resolveVadEnergyThreshold()).toBe(500);
  expect(assertEndpointAboveVad()).toEqual({ vad: 500, endpoint: 500 });
});

test('纯空白 env 视作未设 → 回退默认', () => {
  process.env[VAD] = '   ';
  expect(resolveVadEnergyThreshold()).toBe(500);
});

test('合法覆盖值透传', () => {
  process.env[VAD] = '400';
  process.env[EP] = '600';
  expect(assertEndpointAboveVad()).toEqual({ vad: 400, endpoint: 600 });
});

test('非数字 env → fail-fast', () => {
  process.env[VAD] = 'abc';
  expect(() => resolveVadEnergyThreshold()).toThrow(/非法/);
});

test('0 / 负数 env → fail-fast(不接受 0 阈值)', () => {
  process.env[VAD] = '0';
  expect(() => resolveVadEnergyThreshold()).toThrow(/非法/);
  process.env[VAD] = '-5';
  expect(() => resolveVadEnergyThreshold()).toThrow(/非法/);
});

test('endpoint < vad → 守门抛错(防 350-500 错配区)', () => {
  process.env[VAD] = '500';
  process.env[EP] = '350';
  expect(() => assertEndpointAboveVad()).toThrow(/endpoint ≥ vad|不变式/);
});

test('endpoint == vad → 通过(下界相等合法)', () => {
  process.env[VAD] = '500';
  process.env[EP] = '500';
  expect(assertEndpointAboveVad()).toEqual({ vad: 500, endpoint: 500 });
});

// ── design contract:端点静音容忍时间不变式 —— silenceGap(bridge)≥ hangover(GPU),防看门狗抢在 GPU VAD 前 flush ──
test('L1:未设 → 默认(两处均已回落真机值),不变式满足', () => {
  clearEnv();
  // ★ design contract:silenceGap 900 → 1500、hangover 800 → 1400,两个真机值都已回落成代码默认。
  //   断言引用权威常量而非字面量 —— 改默认时不会因无关原因假红(要点是「未设 → 用默认且不变式成立」)。
  expect(assertSilenceGapAboveHangover()).toEqual({
    hangover: VAD_HANGOVER_MS,
    silenceGap: ENDPOINT_SILENCE_GAP_MS,
  });
  expect(ENDPOINT_SILENCE_GAP_MS).toBeGreaterThanOrEqual(VAD_HANGOVER_MS); // 不变式本身
});

// ★★ design contract 防漂移守门:`constants.ts::ENDPOINT_SILENCE_GAP_MS` 是 bridge
//   `turn-handling.ts::TURN_HANDLING_DEFAULTS.endpointing.silenceGapMs` 的**第二份副本**
//   (CDK 是独立 TS 子系统,不能 import bridge 源码,故两份只能同向手工维护)。
//
//   实证代价:design contract 只改了 bridge 侧而漏了 CDK 侧 → deployment validation 北京部署 `cdk synth` 直接
//   fail-fast(「silenceGap(900) < hangover(1400)」),部署起不来。守门响亮地炸是好事,
//   但这条测试让漂移**在 CI 就红**,不必等到部署。
//
//   读 bridge 源文件做字符串断言(而非 import —— 跨子系统 import 在 CDK 构建期不可用)。
// ★ design contract:`constants.ts::VAD_HANGOVER_MS` 是 GPU `vad.py::VAD_DEFAULTS["hangover_ms"]` 的
//   **第二份副本**(CDK 不能 import Python)。1400 此前只活在 legacy deployment script 的 export 里、
//   代码默认是 800 —— 换部署路径就静默退回 800(不变式仍成立故守门不报警,但 VAD 判轮
//   从 1.4s 缩到 0.8s = 更容易抢话)。现已回落成代码默认,此测试守两份不漂移。
test('design contract:CDK 侧 VAD hangover 默认 MUST 与 gpu/vad.py 同值(防跨语言副本漂移)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../gpu/gpu_service/vad.py'), 'utf8',
  ) as string;
  // 匹配 VAD_DEFAULTS 里的 hangover_ms(注释里也含该数字,故锚定 key 名 + 冒号)
  const m = /"hangover_ms":\s*(\d+)/.exec(src);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBe(VAD_HANGOVER_MS);
});

test('design contract:CDK 侧 silenceGap 默认 MUST 与 bridge turn-handling 同值(防第二副本漂移)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../bridge/src/turn-handling.ts'), 'utf8',
  ) as string;
  // 匹配 DEFAULTS 里 endpointing 的 silenceGapMs 字面量
  const m = /endpointing:\s*\{[^}]*silenceGapMs:\s*(\d+)/.exec(src);
  expect(m).not.toBeNull();
  const bridgeDefault = Number(m![1]);
  expect(bridgeDefault).toBe(ENDPOINT_SILENCE_GAP_MS);
});

test('L1:口试场景两处同向调长(1400/1500)合法', () => {
  process.env[HANGOVER] = '1400';
  process.env[SILENCE_GAP] = '1500';
  expect(assertSilenceGapAboveHangover()).toEqual({ hangover: 1400, silenceGap: 1500 });
});

test('L1:只调长 GPU hangover 忘了 bridge silenceGap → fail-fast(看门狗会抢跑)', () => {
  // ★ design contract:silenceGap 默认已升到 1500,故本用例的 hangover 须 > 1500 才能触发不变式
  //   (原用 1400,在新默认下反而合法 —— 测试意图不变,只是取值随默认值上移)。
  process.env[HANGOVER] = '2000'; // 只调 GPU
  // silenceGap 仍默认 1500 < 2000 → 违反 silenceGap ≥ hangover
  expect(() => assertSilenceGapAboveHangover()).toThrow(/silenceGap ≥ hangover|看门狗|不变式/);
});

test('L1:silenceGap == hangover → 通过(相等合法)', () => {
  process.env[HANGOVER] = '1000';
  process.env[SILENCE_GAP] = '1000';
  expect(assertSilenceGapAboveHangover()).toEqual({ hangover: 1000, silenceGap: 1000 });
});

test('L1:空串 env 视作未设 → 回退默认(不变 0 绕过)', () => {
  process.env[HANGOVER] = '';
  process.env[SILENCE_GAP] = '';
  // ★ 断言引用权威常量(design contract 已把 silenceGap 默认 900 → 1500);本用例的要点是
  //   「空串视作未设、回退默认」,而非具体数值 —— 用字面量会在改默认时假红。
  expect(assertSilenceGapAboveHangover()).toEqual({
    hangover: VAD_HANGOVER_MS, silenceGap: ENDPOINT_SILENCE_GAP_MS,
  });
});
