/**
 * 字幕面板自动滚动纯逻辑(design contract)—— 与 React/DOM 解耦,便于原生 node --test 直接单测
 * (本仓前端无 jsdom/jest,策略见 test/exam-waveform-tap.test.js:纯函数直测 + 源码守门)。
 *
 * 「stick-to-bottom」判据:用户当前是否处于「跟随底部」态。**必须在没有新内容注入的稳定滚动态测量**
 * (onScroll 事件里),而非新气泡 commit 后——否则新增的长气泡会把 scrollHeight 撑大,让「距底距离」
 * 瞬间超阈值、被自己撑破判定为「不在底部」(design contract 根因:AI 长回复 > 阈值 → 不自动滚)。
 */

/** 距底容差(px):diff = scrollHeight - scrollTop - clientHeight ≤ threshold 视为「跟随底部」。
 *  比 design contract 原 80px 略放宽(在稳定态测量,不再受新内容高度干扰,可容更大容差不误判)。 */
export const STICK_BOTTOM_THRESHOLD_PX = 120;

/**
 * 是否处于「跟随底部」态。
 * @param scrollHeight 内容总高
 * @param scrollTop 已滚动距离
 * @param clientHeight 可视高
 * @param threshold 距底容差(默认 STICK_BOTTOM_THRESHOLD_PX)
 * @returns true = 在底部附近(应跟随最新);false = 用户上滚看历史(不强行拉回)
 *
 * 非有限/负值输入 → 保守返回 true(宁跟随底部,不误判用户在看历史而卡住不滚)。
 */
export function shouldStickToBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold: number = STICK_BOTTOM_THRESHOLD_PX,
): boolean {
  if (![scrollHeight, scrollTop, clientHeight].every((n) => Number.isFinite(n))) return true;
  const diff = scrollHeight - scrollTop - clientHeight;
  if (!Number.isFinite(diff)) return true;
  // diff ≤ 0(已在底或过底)或 ≤ threshold(底部附近)→ 跟随;diff < 0 也算跟随(浮点/回弹)。
  return diff <= Math.max(0, threshold);
}
