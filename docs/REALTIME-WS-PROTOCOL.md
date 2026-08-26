# VivaVoce 实时语音 WS 协议契约(客户端 ↔ 实时会话服务)

> **对外公开契约(design contract)**。本文件描述**客户端 ↔ 实时会话服务(bridge)**之间那条 WebSocket
> 的逐帧协议,供第一方客户端(mobile / 桌面 / 自建 Web)**仅凭本文档**实现语音接入,无需读源码。
>
> **权威性**:本文件即对外契约。初版由既有实现(`frontend/src/views/Exam.tsx` ↔ `bridge/src/*`)
> 成文化;**成文发布后,任何实现变更 MUST 先改本文档**,破坏性变更 MUST 升协议版本(见 §8),
> MUST NOT 让实现与本契约静默分叉。
>
> **协议版本**:`"1"`(当前)。
>
> 基准:`validation rationale` · `validation rationale`
> · 接入总纲:`./INTEGRATION.md`。

---

## 0. 全景

- **一个 WS 连接 = 一场会话**。连接 URL 携带 `session_id`,首帧用 join token 鉴权。
- **两种帧**:`text` 帧 = JSON 信令;`binary` 帧 = 裸 PCM 音频。
- **音频端到端格式(协议保证,稳定面)**:**上行 = 下行 = 16 kHz、单声道(mono)、s16le(16-bit
  little-endian)裸 PCM**。服务端保证下发给客户端的音频**恒为 16k**,与内部使用何种 TTS 引擎、原始
  采样率多少无关(客户端不必关心服务端是否做了降采样)。
- **拿 join token 的前置**:本文档只讲 WS。如何拿到 `join_token`/`ws_path` 见 `INTEGRATION.md`
  「语音接入(第一方)」:第一方后端持 API Key 调 `GET /api/integration/sessions/{id}/join`
  拿票,经 TLS 下发给客户端。

接入时序(happy path):

```
客户端                                          实时会话服务(bridge)
  │  WS connect wss://<入口>/rt/ws?session_id=<id>   │
  │ ───────────────────────────────────────────────▶ │
  │  {"type":"auth","token":"<join_token>","protocol_version":"1"}   (首帧,text)
  │ ───────────────────────────────────────────────▶ │
  │        {"type":"ready","protocol_version":"1","false_interruption_recovery":false}
  │ ◀─────────────────────────────────────────────── │
  │  ══ binary 16k PCM(麦克风上行)══▶               │   (收到 ready 后才可上行音频)
  │              ◀══ binary 16k PCM(AI 语音下行)══   │
  │  ◀── {"type":"transcript_partial",...}            │   (实时字幕)
  │  ◀── {"type":"transcript",...}                    │   (定稿转写)
  │  ...                                              │
  │  ◀── {"type":"ended","reason":"session_end"}      │   (收尾)
```

---

## 1. 连接与鉴权

### 1.1 连接 URL

```
wss://<公网入口>/rt/ws?session_id=<session_id>
```

- 协议:https 部署用 `wss`,否则 `ws`。
- 路径:`/rt/ws`(以签票响应返回的 `ws_path` 为准,当前恒为 `/rt/ws`)。
- query:`session_id`(**协议上可选,但强烈建议带**;取自 join token 的第 2 段,见 §1.3)。**若提供,MUST
  与 token 内 session_id 一致**,否则鉴权时回 `error(auth_failed)`。会话身份最终以 token 内 session_id 为准。

### 1.2 鉴权首帧(客户端 → 服务端,text)

WS `open` 后,客户端 MUST 在 **10 秒内**发送首帧 `auth`;超时未发,服务端关闭连接(不发任何帧)。

```json
{ "type": "auth", "token": "<join_token>", "protocol_version": "1" }
```

- `token`(必填,string):join token(见 §1.3)。
- `protocol_version`(可选,string):客户端支持的协议版本。**缺省即视为 `"1"`**(向后兼容:老客户端
  不带此字段仍按 v1 工作)。携带时 MUST 是服务端支持的版本字符串,否则被拒(见 §1.5)。
- 首帧 **MUST 是 text 且 type=`auth`**;首条 text 帧非 JSON、或非 `auth`、或 `token` 非字符串 →
  服务端回 `error(auth_failed)` 并关闭。
- **鉴权成功前发送的 binary(音频)帧一律被服务端丢弃**;客户端 MUST 在收到 `ready` 后才开始上行音频。

### 1.3 join token 格式

```
v1.<session_id>.<exp_unix>.<sig>
sig = base64url_nopad( HMAC-SHA256(key=<服务端密钥>, msg="v1.<session_id>.<exp_unix>") )
```

- `exp_unix`:秒级 Unix 过期时间戳。固定 4 小时 TTL(签发时刻 + 4h)。
- 客户端从 `token.split(".")[1]` 取 `session_id` 填入连接 URL 的 query。
- 客户端**不校验签名**(签名由服务端密钥签发/验证);客户端只透传 token。

### 1.4 鉴权成功(服务端 → 客户端,text)

```json
{ "type": "ready", "protocol_version": "1", "false_interruption_recovery": false, "show_subtitles": true }
```

- `protocol_version`:服务端确认生效的协议版本(回显客户端请求的版本;缺省则为 `"1"`)。
- `false_interruption_recovery`(bool):是否启用**误打断恢复模式**(见 §4.4)。**为 `true` 时,客户端
  MUST 禁用本地销毁性打断**(不在本地 RMS 命中即清播放队列),改由服务端 `pause`/`resume`/`barge_in`
  帧驱动。为 `false`(默认)时,客户端本地打断照常(见 §4.1)。
- `show_subtitles`(bool,design contract):会话级**呈现层**开关——是否在实时对话界面渲染字幕/transcript。
  **缺省 / 字段缺失 → 视作 `true`**(默认显示,向后兼容:旧服务端未下发时客户端仍显示字幕)。为 `false` 时,
  客户端**不渲染** transcript 面板/气泡(改纯声波 + 状态布局)。**纯前端呈现**——`transcript`/`transcript_partial`
  帧仍照常下发(客户端仍可记录,只是不渲染),不影响音频/信令/落库/评测。
- 收到 `ready` 后,客户端方可上行音频(binary)。

### 1.5 鉴权/版本失败(服务端 → 客户端,text)

服务端 best-effort 发 `error` 帧后**关闭连接**:

```json
{ "type": "error", "code": "auth_failed" }
{ "type": "error", "code": "not_ready" }
{ "type": "error", "code": "unsupported_protocol_version", "server_supports": ["1"] }
```

- `auth_failed`:首帧非法 / 验签失败 / token 过期 / `?session_id=` 与 token 内 session_id 不一致。
  客户端应视为**终态失败**(不重试同一 token)。
- `not_ready`:验签通过,但服务端暂无该会话的内核上下文(bridge 重启丢内存 / 上下文 TTL 过期)。
  **不是终态失败** —— 见 §6 重连。
- `unsupported_protocol_version`:客户端请求的 `protocol_version` 不在服务端支持列表(`server_supports`
  列出支持的版本)。客户端 MAY 去掉 `protocol_version`(或改用列表内版本)后重连。

---

## 2. 上行帧(客户端 → 服务端)

### 2.1 控制帧(text / JSON)

服务端只识别以下 type,其余 text 帧被忽略(向后兼容):

| type | JSON | 语义 |
|---|---|---|
| `auth` | `{"type":"auth","token":"...","protocol_version":"1","capabilities":["playback_ack_v1","playback_pause_v1"]?}` | 首帧鉴权(仅鉴权阶段处理,见 §1.2)。`capabilities` 可选 |
| `end` | `{"type":"end"}` | 客户端主动结束会话(用户挂断) |
| `barge_in` | `{"type":"barge_in"}` | 客户端本地检测到插话(见 §4.1),通知服务端切源。仅 AI 说话时有效 |
| `playback_complete` | `{"type":"playback_complete","ai_turn_id":N}` | 播放 ACK(design contract):AI 轮 N 已**自然播完**。仅协商 `playback_ack_v1` 后发 |
| `playback_aborted` | `{"type":"playback_aborted","ai_turn_id":N,"reason":"..."}` | 播放 ACK(design contract):AI 轮 N 被**主动清队列中止**。`reason` ∈ barge_in\|user_transcript\|session_end\|superseded\|client_teardown\|playback_error。仅协商后发 |
| `ux_telemetry` | `{"type":"ux_telemetry","ai_turn_id":N,...}` | 可选 UX 指标旁路(见 §2.3),无需 capability |

> `end` / `barge_in` 帧均**只有 `type` 字段**,无 payload。
>
> **播放 ACK(design contract,可选,capability 协商)**:客户端 `auth` MAY 声明 `capabilities:["playback_ack_v1"]`;
> 仅当 `ready` 回显该 capability(= 客户端声明了它)时,客户端才上行播放终态 ACK,服务端才用 ACK
> 驱动播放结算。轮媒体标记 `ai_audio_start/end` 同时是 UX telemetry 的关联边界,服务端无条件下发；
> 不实现 telemetry/ACK 的旧客户端可按未知帧规则忽略。
> **design contract:服务端侧的 `AIM_PLAYBACK_ACK_MODE` 三态门已删** —— 结算恒生效;且 `playback_superseded`
> 的下发**不依赖本协商**(清 ring 是单向通知,老客户端不声明 capability 也会收到)
> 与 ACK(上行 `playback_complete/aborted`)。未协商 = 不发终态 ACK、服务端回落估算结算。`ai_turn_id` = 服务端连接内单调
> 递增的 JSON-safe 正整数；每次连接使用新的高熵 ID 区间，重连不从 1 重置或复用本会话已发行区间。
> 每轮至多一个 terminal ACK(complete **或** aborted,单调)。协议版本保持 `"1"`(可选帧 +
> 可选字段的向后兼容扩展)。

### 2.2 音频帧(binary)

> ⚠️ **必须先收到 `ready` 帧再上行音频**。鉴权成功前发送的 binary 帧会被服务端**静默丢弃**(见 §1.2)——
> 客户端若在 WS `open` 后立即开麦上行,首帧会丢。

- **binary 帧**,内容 = 裸 PCM,**16 kHz、mono、s16le**。
- 由客户端麦克风采集(建议开启回声消除 / 降噪 / 自动增益)后**重采样到 16k** 再发。
- **帧大小无固定约定**:客户端可按任意分片上行(如每 ~20ms 一帧);服务端按每帧字节数动态算时长。
- **全双工**:进入 `live` 后持续上行(即使 AI 正在说话也不停 —— 供服务端做打断检测)。

### 2.3 UX telemetry(text / JSON,可选)

第一方客户端用同一个 `AudioContext` 时钟计算 duration 后，可按 `ai_turn_id` 分多帧上报：

```json
{
  "type": "ux_telemetry",
  "ai_turn_id": 7,
  "marker_to_first_binary_ms": 18,
  "first_binary_to_first_render_ms": 122,
  "marker_to_first_render_ms": 140,
  "cold_preroll_ms": 100,
  "underruns_before_first_render": 0
}
```

可选字段还包括 `pause_to_first_silent_render_ms`、`confirm_to_worklet_flush_ms`、`browser_ring_depth_at_confirm_ms`、
`browser_ring_depth_before_flush_ms` 和 `browser_ring_depth_after_flush_ms`。
`at_confirm` 由 worklet 的固定容量 render-depth 历史按 `confirm_context_time` 还原，
`before_flush` 是 worklet 真正处理 flush 时清队列前的实测值。所有值 MUST 为有限非负数，`underruns_before_first_render`
另须为整数；无效字段被忽略。客户端不得上传浏览器绝对时间，也不得用浏览器时间减服务端时间。
同一轮同一字段首份有效值生效，重复帧幂等。完整指标字典见
[`UX-LATENCY-METRICS.md`](./UX-LATENCY-METRICS.md)。

---

## 3. 下行帧(服务端 → 客户端)

### 3.1 音频帧(binary)

- **binary 帧**,裸 PCM,**16 kHz、mono、s16le**。
- 客户端 MUST 以 **16000 Hz** 播放。某 N 字节的音频帧时长 = `N / 2 / 16000` 秒。
- ⚠️ **常见坑**:切勿按 24k 播放(历史 voice-test 曾用 24k);按 24k 播 16k 数据会 1.5× 变速失真。

### 3.2 信令帧(text / JSON)

| type | JSON 字段 | 含义 |
|---|---|---|
| `ready` | `protocol_version`, `false_interruption_recovery`, `capabilities?` | 鉴权成功,放行上行(见 §1.4)。`capabilities` 回显双方启用的能力(design contract) |
| `transcript_partial` | `speaker:"user"`, `text` | ASR 识别中(临时字幕),仅 user 侧,不落库,可空跳过 |
| `transcript` | `speaker:"user"｜"ai"`, `text`, `seq?` | 定稿转写(user = ASR final;ai = 本轮 AI 完整文本)。`seq`= 会话内单调序号(见下) |
| `transcript_corrected` | `speaker:"user"`, `seq`, `text` | ASR 字幕 LLM 修正(design contract):按 `seq` 定位已显示的 user 气泡,原地替换文本(不新增气泡) |
| `barge_in` | `ai_turn_id?`, `pause_id?` | 服务端确认打断 → 客户端 MUST 清空本地播放队列(见 §4.2)。身份字段在 tentative pause 后确认时用于关联,旧客户端可忽略 |
| `ai_audio_start` | `ai_turn_id` | AI 轮 N 媒体起点(**该轮首个下行 binary 之前**),供 UX telemetry 和可选播放 ACK 关联 |
| `ai_audio_end` | `ai_turn_id` | AI 轮 N 媒体 drain 终点(该轮最后一帧 binary 之后;= server_drained,**非**客户端已播完) |
| `playback_superseded` | `reason?` | 服务端确认起用户驱动新轮 → 客户端 flush 旧 ring(design contract,非由 user-transcript 触发,不踩 design contract) |
| `pause` | `ai_turn_id`, `pause_id` | 误打断恢复:tentative-pause,协商后冻结当前轮但不清队列(见 §4.4) |
| `resume` | `ai_turn_id`, `pause_id` | 误打断恢复:仅匹配同一 pause episode 时续播(见 §4.4) |
| `error` | `code`, 可选附加字段 | 错误(见 §5) |
| `ended` | `reason` | 会话正常收尾(见 §5) |

> **轮媒体标记与播放 ACK**:每个有音频的 AI 轮下行
> `ai_audio_start(N)` → binary×K → `ai_audio_end(N)`(严格有序,同一有序 writer)。客户端据此把该轮媒体绑定到
> `ai_turn_id=N` 并测量浏览器首收/首渲染。仅协商 `playback_ack_v1` 后,自然播完发
> `playback_complete(N)`、被清队列发 `playback_aborted(N,reason)`。`ai_audio_end` 表示
> **服务端不再下发该轮音频**(server_drained),**不代表客户端已播放完成**——真播完由客户端 ACK 权威回报。无音频轮 /
> 被打断轮不发 start/end(清 ring 由 `barge_in`/`playback_superseded` 走)。

> **命名提醒**(勿臆测):到客户端的转写帧叫 `transcript_partial` / `transcript`,**不是** `asr_partial` /
> `asr_final`(那是服务端内部对 GPU 的帧名)。**没有** `turn_end` 下行帧、**没有** `bye` 帧。会话收尾帧
> 叫 `ended`。

> **`seq` 与 `transcript_corrected`(design contract,向后兼容新增)**:`transcript` 帧带一个**会话内单调递增**的
> `seq`(user final 与 ai 定稿都各占一个)。开启 ASR 字幕 LLM 修正时,服务端在 user `transcript` 后可能
> 异步(~1–2s)下发 `transcript_corrected`(同 `seq`),客户端 **MUST 按 `seq` 定位并原地替换**该条 user 气泡文本、
> **MUST NOT 追加新气泡**。客户端 SHOULD 用 `seq` 作气泡稳定 key(而非数组下标),以容忍乱序/快说。
> **向后兼容**:`seq` 与 `transcript_corrected` 均为**可选**;旧客户端不认 `seq`(回退下标渲染)、忽略
> `transcript_corrected`(字幕停在原文,无害)。修正未配置/失败/超时 → 服务端不发 `transcript_corrected`(字幕即 ASR 原文)。
> 会话 `ended` 后迟到的修正结果服务端**不再下发**。

---

## 4. 打断(barge-in)语义

打断有**两条独立触发链**,幂等汇聚到服务端切源。

### 4.1 客户端本地检测(上行)—— 默认模式

AI 播报期间,客户端本地 RMS 检测到连续高能量(建议:起始有一段禁打断窗、连续达确认时长、带
hangover 消抖)命中时:

1. **立即本地停播**(停所有在播/排程音源、清本地播放队列 —— 零往返,体感"打断了")。
2. **上行** `{"type":"barge_in"}` 通知服务端切 LLM/TTS 源。

> 仅在 `false_interruption_recovery === false`(默认)时启用本地销毁性打断;为 `true` 时禁用(见 §4.4)。

### 4.2 服务端检测(下行)

服务端做双讲检测(DTD + 动态噪声地板)命中后,切源并**下行** `{"type":"barge_in"}`。客户端收到后
MUST **清空本地播放队列**(停所有在播/排程音源,复位播放游标)。

### 4.3 两路并存

客户端负责即时停声(体感),服务端负责真停后端生成;二者同到服务端切源(幂等)。

### 4.4 误打断恢复模式(可选,`false_interruption_recovery=true` 时)

> **能力协商**:客户端在 `auth.capabilities` 声明 `playback_pause_v1`,且 `ready.capabilities`
> 回显该值后,才执行本节的 worklet 冻结/恢复。未协商或旧客户端仍可忽略 `pause` / `resume`,
> 保持原先“只暂停后续供给”的行为。`false_interruption_recovery:false` 时按 §4.1 本地打断。

服务端统一判定打断,客户端禁用本地销毁性打断:

- `pause`:服务端进入 tentative-pause(暂停下发音频、不销毁本轮)。协商客户端仅当
  `ai_turn_id` 是当前轮且 `pause_id` 是该轮更新的 episode 时,让 worklet 从下一 render quantum
  输出静音；不得消费 ring、推进播放账本或触发 played/drained。
- `resume`:服务端确认是误打断。客户端仅接受与当前冻结 episode 完全匹配的
  `ai_turn_id + pause_id`,从被冻结的下一个源样本继续；重复、乱序、缺字段和旧轮帧均忽略。
- `barge_in`:窗内确认是真打断 → 走 §4.2(客户端清队列)。

`ai_audio_start` 建立可控轮身份,`ai_audio_end` 退休该身份；confirmed `barge_in`/断线/新轮抢占
清除冻结身份。`pause_id` 在连接内单调递增。协议版本仍为 `"1"`：能力和新增字段均是向后兼容扩展。

---

## 5. 错误码与关闭

### 5.1 `error` 帧

```json
{ "type": "error", "code": "<code>", ... }
```

`code` 枚举(客户端 MUST 对**未知 code** 做兜底,不崩溃):

| code | 阶段 | 语义 / 客户端应对 |
|---|---|---|
| `auth_failed` | 鉴权 | 首帧非法/验签失败/过期/session_id 不一致 → 终态失败,不重试同一 token |
| `not_ready` | 鉴权 | 服务端暂无会话上下文 → 重新签票 + 退避重连(见 §6) |
| `unsupported_protocol_version` | 鉴权 | 版本不支持,附 `server_supports` → 换版本重连 |
| `superseded` | 会话中 | **本连接被同会话的新连接取代**(见 §7)→ 静默收场,**不重试、不报错** |

> `error` 帧发出后服务端会关闭连接。除 `not_ready`(重连)、`superseded`(静默收场)外,均视为失败。

### 5.2 `ended` 帧(正常收尾)

```json
{ "type": "ended", "reason": "<reason>" }
```

`reason` 枚举:`session_end`(用户 `end` 帧 / WS 关闭 / AI 语义收尾)、`manual_hangup`(管理端提前结束)、
`error`(服务端引擎错误)。客户端收到后 teardown(停麦/播放),置结束态。

> ⚠️ **勿为 `barge_in` 写 `ended` 分支**:打断(barge-in)只让 AI 停当前发言、对话**继续**(见 §4),
> **不产生 `ended` 帧**。`ended.reason` 只会是上述三值之一。

### 5.3 WS close code

**无自定义 close code**。所有关闭均为无参 `close()`。收尾语义完全由 text 帧承载:

- 收到 `ended` → 正常结束。
- 收到 `error` → 按 code 处理。
- **未收到任何帧就断开(裸断连)** → 客户端应提示并允许手动重连(见 §6)。服务端在关闭前 best-effort
  先发收尾帧,故裸断连通常意味着网络中断。

---

## 6. 断线重连

- **无断点续传**:重连 = **重新签票拿新 join token** + 新 WS 连接。WS 层不保留会话历史;对话上下文由
  服务端引擎持有。
- **收到 `not_ready`**:表示服务端丢了该会话内核(重启 / TTL 过期),但会话本身仍在进行。客户端 MUST
  **重新调签票接口**(这会触发后端 best-effort 重新预创建上下文)后重连,SHOULD 指数退避有限次
  (参考实现:退避 1s / 2s / 4s,至多 3 次)。**不应**把 `not_ready` 判为终态失败。
- **裸断连**:对话进行中意外断开且无收尾帧 → 提示用户,允许手动重连(重新签票)。

---

## 7. 同一会话同时只有一条活跃连接(新挤旧)

同一 `session_id` **同时只有一条活跃 WS**。当新连接鉴权通过而该会话已有活跃连接时,服务端采取
**「最后一次连接胜出」**:

1. 向**旧**连接发 `{"type":"error","code":"superseded"}` 并关闭它。
2. 向**新**连接发 `ready`,接管会话。

**客户端应对**:收到 `superseded` 说明本连接已被"同会话的另一连接"取代(常见于弱网重连、app 切后台
复活、或换设备接入)——应**静默收场,不重试、不报错**(否则旧、新连接会互相抢会话)。

> 这也是 join token 泄露的一道可见防线:攻击者用窃得的 token 连入会**立即把合法用户挤下线**(可察觉的
> 异常),而非静默并行操控同一会话。

---

## 8. 协议版本与演进

- 当前版本 `"1"`。客户端在 `auth` 帧声明 `protocol_version`(缺省 v1);服务端 `ready` 回显生效版本;
  未知版本 fail-closed(§1.5)。
- **破坏性变更(MUST 升版本)**:改音频采样率 / 位深 / 声道;改既有帧语义;删除或重命名帧类型 / 字段;
  新增"客户端必须处理"的下行帧或必填上行字段。
- **向后兼容变更(MAY 不升版本)**:新增**可选**下行帧类型(老客户端可安全忽略);新增**可选**字段
  (如某帧加 `confidence`);新增 `error` 帧的 `code` 枚举值(客户端须对未知 code 兜底)。

---

## 9. Security Considerations

- **join token 是短时 bearer**(HMAC,固定 4h TTL):**持有即可用,无额外身份绑定**(设计取舍:简化
  客户端实现)。代价 = 泄露后在有效期内任何人可连入该会话。
- **风险量化**:4h TTL 远超会话本身 `max_duration`(默认约 30 分钟)。攻击面 = 「token 泄露后 4h 内、
  会话仍未终态时,任何持有者可连入该 session_id」。多层收敛:会话终态后签票 409;连入后 `max_duration`
  强制收尾;**同 session_id「新挤旧」**(§7,攻击连入即挤下合法用户,异常可见);超时未连入判 `no_show`。
- **集成方责任**:
  - MUST 只经 **TLS** 下发 join token;MUST 只下发给**可信客户端**;MUST NOT 把 token 写入日志 /
    Crash Report。
  - **API Key MUST 只存在于你的后端**,MUST NOT 下发到客户端设备(设备只应持短时 join token)。
    正确模式:`App → 你的后端 API(持 API Key)→ VivaVoce`;反例:`App 直接持 API Key`。
  - SHOULD 监控同一 token / session 的异常连接(地理跳变、频繁 supersede)以检测泄露。
