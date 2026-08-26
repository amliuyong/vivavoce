# 用户可听首声与打断停声指标

本文定义 work item 的指标边界、关联键、时钟域和缺失值语义。指标记录按
`session_id + ai_turn_id + tts_provider` 关联；GPU 单句明细另带 `segment_id`。
生产 Bridge 为每个连接分配新的 37-bit 高熵命名空间和一个宽度为 65,536 的区间，
按偏移 1..65,535 发行 `ai_turn_id`。该 ID 在连接内单调递增，重连不会从 1
重新使用旧区间。`turn_index` 仍保留为引擎本地轮序号，但不作为跨重连存储身份。

## 时钟域

系统只在同一时钟域内做时间相减：

| 时钟域 | 来源 | 指标 |
|---|---|---|
| Bridge wall clock | Node `Date.now()` | LLM、分句、Bridge 首包、打断判定 |
| GPU monotonic clock | Python `time.monotonic()` | provider 生成、发送、取消尾延迟 |
| Browser audio clock | `AudioContext.currentTime` / worklet `currentTime` | 浏览器首包、首渲染、flush |

禁止把 GPU、Bridge 或浏览器的绝对时间戳直接相减。跨域只传各域已经计算好的 duration。
Bridge 首帧边界与浏览器 marker 接收边界之间仍含未校准的单向网络传输时间，因此不把
`e2e_latency_ms` 与浏览器 duration 相加伪造“用户首声总时延”。Dashboard 并列展示各分段；
若未来增加浏览器时钟校准或同域用户停说锚点，再单独定义总量。

## 首声链路

| 阶段或字段 | 精确边界 |
|---|---|
| `llm_first_token` / `llm_ttft_ms` | Bridge 启动本轮 LLM 到收到首 token |
| `sentence_ready_ms` | Bridge 启动本轮 LLM 到首句进入 GPU TTS 队列 |
| `provider_start` | GPU 开始迭代该 segment 的 provider；仅作为 GPU 本地起点，不上传绝对时间 |
| `model_first_chunk` | 当前 provider 不暴露模型内部首 chunk，字段缺失并写 `model_first_chunk_unavailable_reason` |
| `gpu_first_send` / `provider_start_to_first_send_ms` | provider 起点到 GPU 开始发送首个 PCM meta/binary 对 |
| `bridge_first_receive_ms` | Bridge 启动本轮 LLM 到 Bridge 收到首个 PCM |
| `e2e_latency_ms` | Bridge 观测的用户停说到 Bridge 收到本轮首个 PCM；不含 Bridge 到浏览器的单向传输与浏览器播放等待 |
| `browser_first_receive` / `marker_to_first_binary_ms` | 浏览器收到 `ai_audio_start` marker 到收到该轮首个 binary |
| `worklet_first_render` / `marker_to_first_render_ms` | marker 到该轮首个源样本实际进入 AudioWorklet render quantum |
| `first_binary_to_first_render_ms` | 浏览器首 binary 到首个源样本实际进入 render quantum |
| `cold_preroll_ms` | 冷 worklet 收到首 chunk 到首渲染；有意的 preroll 等待不算 underrun |
| `underruns_before_first_render` | 收到首 chunk 后、首渲染前的独立 warm underrun episode 数 |

`tts_ttfb_ms` 是保留的历史兼容指标，语义与 `bridge_first_receive_ms` 相同：
**LLM turn start 到 Bridge 收到首个 PCM**。它包含 LLM、分句、provider 和 GPU 发送等待，
不是 server first chunk 到达浏览器，更不是用户可听首声。

## TTS 吞吐

- `tts_generation_wall_time_ms`：GPU 在 executor 中等待 provider 迭代结果的时间之和。
- `generated_audio_duration_ms`：provider 已生成 PCM 的样本时长。
- `tts_rtf = sum(tts_generation_wall_time_ms) / sum(generated_audio_duration_ms)`。
- 只有本轮所有已声明 segment 的 telemetry 齐全时才发布稳态 RTF；取消后的半轮数据不进入 RTF。
- `tts_cache_state` 为 `cold | warm | not_applicable | unknown`。本地 OmniVoice 以 voice-clone
  prompt 是否已编码为冷热边界；MiniMax 为 `not_applicable`。
- `tts_concurrency` 是 segment 入队时 GPU 实例的 active session 数，查询维度折叠为
  `concurrency_bucket = 1 | 2-4 | 5+`。

## 打断与停声

| 字段 | 精确边界 |
|---|---|
| `barge_evidence_to_pause_ms` | Bridge 首个过阈声学帧到 tentative pause；不启恢复时终点为立即确认 |
| `pause_to_confirm_ms` | Bridge tentative pause 到 confirmed takeover；不启恢复时为 0 |
| `pause_to_first_silent_render_ms` | 浏览器主线程收到有效 pause 到 worklet 首个全静音 render quantum，均使用 AudioContext 时钟 |
| `confirm_to_worklet_flush_ms` | 浏览器本地确认时刻到 worklet 处理 flush，均使用 AudioContext 时钟 |
| `browser_ring_depth_at_confirm_ms` | 主线程发出 confirmed flush 时的 16 kHz 源样本深度；worklet 从固定容量 render-depth 历史按 `confirm_context_time` 还原 |
| `browser_ring_depth_before_flush_ms` | worklet 实际处理 flush 回调时、清队列前的 16 kHz 源样本深度 |
| `browser_ring_depth_after_flush_ms` | 同一 worklet 回调清队列后的深度 |
| `cancel_to_last_model_compute_ms` | GPU 收到 cancel 到旧代次最后一次 provider 迭代返回 |
| `cancel_to_last_gpu_send_ms` | GPU 收到 cancel 到旧代次最后一个 PCM binary 发送完成 |

排队但尚未开始的 segment 会在 cancel 后丢弃，因此不会伪造 segment telemetry。正在生成的
segment 即使是多句轮中的一部分，仍可迟到补写取消尾延迟，但不会据此计算半轮 RTF。

## 缺失、乱序与存储

- unavailable 使用字段缺失表示，不能写 0；已知不支持原因写入对应 `*_unavailable_reason`。
- 同一 `segment_id` 或浏览器字段首份有效值生效，重复和 stale turn 被忽略。
- DynamoDB 使用同一 `metric#<zero-padded ai_turn_id>` 行完整覆盖；同一
  `session_id + ai_turn_id` 的写入按观测顺序串行，迟到 GPU/浏览器字段不会被更早的稀疏写反向覆盖。
- CloudWatch EMF 按 turn、metric name 和 dimension schema 去重。迟到的 provider/cache/并发信息
  可以补建新维度序列，但不会重复采样已经发布的无维度 aggregate。provider 维度只在 GPU 同时给出
  实际 `tts_provider + cache_state + concurrency_bucket` 后发布，避免 fallback 前后的 requested/actual
  provider 形成两条序列。
- Dashboard 在 `AIM/Realtime` 并列展示首声各分段、RTF 和全部停声分段的 p50/p95/p99，
  并为每项提供 `tts_provider + cache_state + concurrency_bucket` 下钻。
