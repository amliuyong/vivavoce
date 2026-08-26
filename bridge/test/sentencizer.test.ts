import { Sentencizer } from "../src/sentencizer";

describe("Sentencizer", () => {
  it("按句末标点切句", () => {
    const s = new Sentencizer();
    const out: string[] = [];
    for (const tok of ["你好", ",", "我是", "AI", "。", "今天", "聊", "什么", "?"]) {
      out.push(...s.push(tok));
    }
    out.push(...s.flush());
    // 至少切出含"。"和"?"的两句
    expect(out.some((x) => x.includes("我是AI。"))).toBe(true);
    expect(out.some((x) => x.includes("?"))).toBe(true);
  });

  it("流式逐 token 不丢字", () => {
    const s = new Sentencizer();
    const collected: string[] = [];
    for (const ch of "第一句。第二句!第三句".split("")) {
      collected.push(...s.push(ch));
    }
    collected.push(...s.flush());
    expect(collected.join("")).toBe("第一句。第二句!第三句");
  });

  it("flush 吐出无句末标点的残留", () => {
    const s = new Sentencizer();
    s.push("没有结尾标点的一段话");
    expect(s.flush()).toEqual(["没有结尾标点的一段话"]);
  });

  it("超长无句末标点时在逗号软切,降低首音延迟", () => {
    const s = new Sentencizer();
    const long = "这是一段很长的内容没有句号但是有逗号,后面还有更多";
    const out = s.push(long);
    expect(out.length).toBeGreaterThanOrEqual(1); // 在逗号处提前切出至少一段
  });

  it("reset 清空缓冲", () => {
    const s = new Sentencizer();
    s.push("残留");
    s.reset();
    expect(s.flush()).toEqual([]);
  });
});
