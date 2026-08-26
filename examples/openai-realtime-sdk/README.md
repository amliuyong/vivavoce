# Viva OpenAI Realtime SDK WebSocket 示例

[English](README.en.md)

本示例使用未经修改的官方 `@openai/agents-realtime@0.14.2` 内置 WebSocket
transport，兼容范围严格限定为：

> **OpenAI Realtime SDK WebSocket-compatible subset**

它不是完整 OpenAI Realtime API 兼容层，也不是 drop-in replacement。

## 安装

```bash
npm install
export VIVA_API_BASE=https://voice.example.com
export VIVA_API_KEY=aimk_...
export VIVA_SESSION_ID=sess_...
```

API Key 需要 `sessions:write`，只能保存在可信后端。浏览器示例的 Node 服务用它换取
600 秒有效的 Viva `ek_` client secret；浏览器永远不会收到长期 API Key。client
secret 只传给 Viva 返回的 WebSocket URL，不进入 query，也不得发送到
`api.openai.com`。

## Node PCM 管线

Node 示例从 stdin 读取 mono PCM16 little-endian 24 kHz，并把相同格式写入 stdout。
日志写入 stderr。

```bash
arecord -q -f S16_LE -r 24000 -c 1 -d 5 |
  npm run node |
  aplay -q -f S16_LE -r 24000 -c 1
```

示例会同时等待 `response.done` 和应用播放 sink 排空，再请求
`viva.session.end`。`response.output_audio.done` 与 `response.done` 都不代表用户已听完。

## 浏览器麦克风与播放

```bash
npm run browser
```

打开 `http://127.0.0.1:4173`。页面默认中文，可手动切换中文/English。它通过
AudioWorklet 采集 mono 麦克风音频并转换为 PCM16 little-endian 24 kHz，再调用
`RealtimeSession.sendAudio()`；收到 24 kHz PCM 后由 Web Audio sink 排期播放。
收到 `viva.playback.clear` 时会立即停止并清空已排期音频。

“结束会话”发送 `viva.session.end` 并等待 `viva.session.ended`；“断开连接”只调用
SDK `close()`，仅拆除 transport，不会完成 Viva 业务会话。

## R1 不支持

WebRTC、tools/function calling、handoff、hosted MCP、image、非 PCM codec、OOB/
并行 response、任意 conversation history mutation，以及客户端覆盖 Viva Agent、题目、
rubric、model、voice 或 turn detection。
