/**
 * TranscriptStore 单测 —— FINAL 转写写 SessionEvents(event#<ts>),schema 对齐控制面 db.py。
 */
import { TranscriptStore } from "../src/transcript-store";

function fakeDdb() {
  const items: Record<string, unknown>[] = [];
  return {
    items,
    send: async (cmd: { input: { Item: Record<string, unknown> } }) => {
      items.push(cmd.input.Item);
      return {};
    },
  };
}

test("putFinal 写 event#<ts> + speaker/text/expires_at TTL", async () => {
  const ddb = fakeDdb();
  const store = new TranscriptStore({ ddb: ddb as never, table: "VivaTest-SessionEvents", now: () => 1_700_000_000_000 });
  await store.putFinal("sess_t", "user", "我是候选人");
  expect(ddb.items).toHaveLength(1);
  const it = ddb.items[0];
  expect(it.session_id).toBe("sess_t");
  expect(String(it.sk).startsWith("event#")).toBe(true);
  expect(it.speaker).toBe("user");
  expect(it.text).toBe("我是候选人");
  expect(typeof it.expires_at).toBe("number");
  expect(it.expires_at as number).toBeGreaterThan(1_700_000_000); // 秒级 TTL
});

test("design contract:显式 tsMs 固定排序键 → 同 tsMs 覆盖同 sk(修正就地覆盖,顺序不变)", async () => {
  const ddb = fakeDdb();
  // now() 每次不同(模拟修正比 final 晚返回);但传显式 tsMs 应固定 sk。
  let t = 1_700_000_000_000;
  const store = new TranscriptStore({ ddb: ddb as never, table: "VivaTest-SessionEvents", now: () => (t += 5000) });
  const fixedTs = 1_700_000_000_000;
  await store.putFinal("sess_t", "user", "42", fixedTs); // 原文占位
  await store.putFinal("sess_t", "user", "62", fixedTs); // 修正覆盖(同 tsMs)
  expect(ddb.items).toHaveLength(2);
  // 两次同 sk(同 tsMs)→ DDB 同 PK+SK 幂等覆盖(此 fake 只 push,断言 sk 相等即证明覆盖同一行)。
  expect(ddb.items[0].sk).toBe(ddb.items[1].sk);
  expect(ddb.items[0].sk).toBe(`event#${new Date(fixedTs).toISOString()}`);
  // expires_at 基于 tsMs(非 now),两次一致。
  expect(ddb.items[0].expires_at).toBe(ddb.items[1].expires_at);
});

test("不传 tsMs → 用 now()(现状行为)", async () => {
  const ddb = fakeDdb();
  const store = new TranscriptStore({ ddb: ddb as never, table: "VivaTest-SessionEvents", now: () => 1_700_000_000_000 });
  await store.putFinal("sess_t", "ai", "你好");
  expect(ddb.items[0].sk).toBe(`event#${new Date(1_700_000_000_000).toISOString()}`);
});

test("空文本 / 无表名 不写", async () => {
  const ddb = fakeDdb();
  const store = new TranscriptStore({ ddb: ddb as never, table: "VivaTest-SessionEvents" });
  await store.putFinal("sess_t", "user", "   ");
  expect(ddb.items).toHaveLength(0);
  const store2 = new TranscriptStore({ ddb: ddb as never, table: "" });
  await store2.putFinal("sess_t", "user", "x");
  expect(ddb.items).toHaveLength(0);
});

// ── design contract:题号稀疏落库 ──
test("design contract:传 questionIndex(含 0)→ 写 question_index", async () => {
  const ddb = fakeDdb();
  const store = new TranscriptStore({ ddb: ddb as never, table: "VivaTest-SessionEvents", now: () => 1_700_000_000_000 });
  await store.putFinal("sess_t", "user", "答案", undefined, 0); // 0-based 首题(0 是合法题号,MUST 落)
  await store.putFinal("sess_t", "ai", "问第二题", 1_700_000_000_500, 1);
  expect(ddb.items).toHaveLength(2);
  expect(ddb.items[0].question_index).toBe(0); // 0 不能被 falsy 误吞
  expect(ddb.items[1].question_index).toBe(1);
});

test("design contract:不传 questionIndex(越界/无题/老会话)→ 不写 question_index(稀疏)", async () => {
  const ddb = fakeDdb();
  const store = new TranscriptStore({ ddb: ddb as never, table: "VivaTest-SessionEvents", now: () => 1_700_000_000_000 });
  await store.putFinal("sess_t", "user", "收尾语"); // 无 questionIndex 参数
  await store.putFinal("sess_t", "ai", "结语", 1_700_000_000_500, undefined); // 显式 undefined
  expect(ddb.items).toHaveLength(2);
  expect("question_index" in ddb.items[0]).toBe(false); // 稀疏:不写字段
  expect("question_index" in ddb.items[1]).toBe(false);
});
