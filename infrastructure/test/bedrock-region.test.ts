/**
 * bedrock-region 分区无关守门(B6,VISION §2):
 * 中国区无 Bedrock → 取 us-east-1 映射(LLM 一律跨境调美东);不支持 region fail-fast。
 */
import { bedrockModelsFor, isCnRegion } from '../lib/common/bedrock-region';

test('中国区取 us-east-1 模型映射(LLM 跨境调美东)', () => {
  const cn = bedrockModelsFor('cn-north-1');
  const use1 = bedrockModelsFor('us-east-1');
  expect(cn).toEqual(use1);
  expect(bedrockModelsFor('cn-northwest-1')).toEqual(use1);
});

test('isCnRegion 判定', () => {
  expect(isCnRegion('cn-north-1')).toBe(true);
  expect(isCnRegion('cn-northwest-1')).toBe(true);
  expect(isCnRegion('us-east-1')).toBe(false);
});

test('不支持 region fail-fast(不静默部署到模型不可用区域)', () => {
  expect(() => bedrockModelsFor('eu-west-1')).toThrow('Unsupported region');
});
