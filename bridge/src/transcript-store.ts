/**
 * 转写落库(design contract)—— 每句 FINAL 写 SessionEvents(PK=session_id, SK=event#<ts>),
 * 供 Evaluator 打分 + 结束后查看。**不实时推前端**(design contract)。
 *
 * schema 与控制面 backend/app/db.py put_transcript_event 对齐:
 *   { session_id, sk:"event#<ts>", ts, speaker, text, expires_at }
 * expires_at:审计期 TTL(对齐 SessionEvents timeToLiveAttribute,转写明细到期回收)。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TTL_SECONDS = 365 * 24 * 3600;

export interface TranscriptDeps {
  ddb?: { send: (cmd: unknown) => Promise<unknown> };
  table?: string;
  now?: () => number;
}

export class TranscriptStore {
  private readonly ddb: { send: (cmd: unknown) => Promise<unknown> };
  private readonly table: string;
  private readonly now: () => number;

  constructor(deps: TranscriptDeps = {}) {
    this.ddb =
      deps.ddb ??
      (DynamoDBDocumentClient.from(new DynamoDBClient({})) as unknown as {
        send: (cmd: unknown) => Promise<unknown>;
      });
    this.table = deps.table ?? process.env.SESSION_EVENTS_TABLE_NAME ?? "";
    this.now = deps.now ?? (() => Date.now());
  }

  /** 写一句 FINAL 转写。best-effort:落库失败只告警,不拖垮通话(转写是旁路)。
   *
   *  design contract:可传显式 `tsMs` 固定排序键(sk=event#<ISO ts>)。ASR final 到达时先落原文占位(定 tsMs),
   *  修正返回后用**同一 tsMs 覆盖**该行为修正版(PutCommand 同 PK+SK 幂等覆盖)。好处:转写顺序在 final
   *  到达时即固定(不受修正快慢/乱序影响,user 行绝不排到后续 AI 行之后);修正未回则停在原文(fail-open)。
   *  缺省(不传 tsMs)= 用当前时刻(现状行为,AI 侧转写与不修正路径仍走此)。
   *
   *  design contract:可传 `questionIndex`(0-based 服务端游标题号,事件快照)→ 写进 Item `question_index`(供
   *  evaluator 确定性分段)。**undefined 不写字段**(稀疏:越界/无题轮 + 老会话都无此字段,evaluator 回退语义)。 */
  async putFinal(
    sessionId: string,
    speaker: "user" | "ai",
    text: string,
    tsMs?: number,
    questionIndex?: number,
  ): Promise<void> {
    if (!this.table || !text.trim()) return;
    const stampMs = tsMs ?? this.now();
    const ts = new Date(stampMs).toISOString();
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            session_id: sessionId,
            sk: `event#${ts}`,
            ts,
            speaker,
            text,
            expires_at: Math.floor(stampMs / 1000) + TTL_SECONDS,
            // design contract:题号稀疏落库——仅当捕获到有效题号(非 undefined)才写(越界/无题/老会话不写)。
            ...(questionIndex !== undefined ? { question_index: questionIndex } : {}),
          },
        }),
      );
    } catch (e) {
      console.warn(`[transcript] put failed for ${sessionId}:`, (e as Error).message);
    }
  }
}
