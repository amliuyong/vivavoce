/**
 * 疑问/新话头 cue pattern —— **单一事实源**(design contract + design contract)。
 *
 * 覆盖疑问词 / 语气词 / 新话头信号(不只 `[?？]`),用于两处**同源**判据:
 *  - design contract `media-session.ts::isSubstantiveTurn`:用户本轮是否引入「实质新内容/新话头」(自由聊天两步确认清 latch)。
 *  - design contract `three-stage-engine.ts::aiIsAsking`:AI 本轮回复是否**在追问**(retry 上限强推的追问豁免)。
 *    覆盖「能再展开一下吗」「请具体说说有哪些响应」这类**无问号追问**(design contract 追问=Agent 行为)。
 *
 * 两处语义不同(一个判用户、一个判 AI)但 pattern **必须同源**(design contract 明示「复用同款 pattern」)——
 * 抽为共用常量杜绝各自内联导致的漂移。**非全局正则**(无 /g):`.test()` 无 lastIndex 副作用,可安全跨调用复用。
 */
export const QUESTION_CUE_RE =
  /[?？]|吗|呢|什么|怎么|为什么|为何|哪|谁|多少|能不能|可不可以|还有|另外|对了|再说说|再聊|其实|我想(问|说|聊)/;
