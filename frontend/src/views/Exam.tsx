'use client';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { useAsync, useLang, useSession } from '@/lib/appState';
import { api, ApiError, type SessionJoinOut } from '@/lib/api';
import { candidateApi, CandidateApiError } from '@/lib/candidateApi';
import { Loading, ErrorBanner } from '@/lib/ui';
import { navigate } from '@/lib/router';
import { statusClass, statusLabel } from '@/lib/format';
import { Waveform } from '@/components/Waveform';
import { SvgFace } from '@/components/SvgFace';
import type { FaceVariant } from '@/components/svg-face-core';
import { shouldStickToBottom } from '@/lib/scroll';
import { PlaybackAckTracker, PLAYBACK_ACK_CAPABILITY } from '@/lib/playback-ack';
import {
  PlaybackPauseController,
  PLAYBACK_PAUSE_CAPABILITY,
  type PlaybackPauseFrame,
} from '@/lib/playback-pause';
import {
  UxTelemetryTracker,
  type WorkletUxTelemetryEvent,
} from '@/lib/ux-telemetry';

/**
 * 考试页(M1-C):登录用户(staff 本人 / admin 代考测试)浏览器直连实时语音口试。
 * 流程:载入 session 详情 → 「开始考试」→ GET /api/sessions/{id}/join(Cognito Bearer)→
 * 连 wss://<host>/rt/ws?session_id=<id> → 首帧 auth(join_token)→ ready 后开麦。
 *
 * 跨栈契约(M1 信令 v1,已冻结):
 *  - text 帧 = JSON 信令;binary = 16k mono s16le PCM 双向(下行已是 16k,勿照抄 VoiceTest 的 24k)。
 *  - 上行:首帧 {"type":"auth","token":<join_token>}(10s 内);{"type":"end"} 主动结束;
 *    **ready 前不发 binary**(会被服务端丢弃)。
 *  - 下行:ready / error(auth_failed|not_ready,后连接关)/ transcript(speaker=user|ai)/
 *    barge_in(立即停本地播放+清队列)/ ended(reason,服务端随后关连接)。
 *  - /join 409 = 终态/超窗/未到窗(detail 中文直展);not_ready → 重新 /join 再重连,退避 1s/2s/4s
 *    共 3 次,仍失败给「重试」按钮。
 *
 * 音频管线(M1 目标,AudioWorklet 替换 ScriptProcessor):
 *  - 采集:getUserMedia(AEC/NS/AGC)→ MediaStreamSource → AudioWorkletNode('/pcm-worklet.js',
 *    worklet 内累积+重采样到 16k int16)→ port.postMessage → WS binary。
 *  - 播放(design contract):下行 16k PCM 分片 postMessage 给播放 worklet('/pcm-playback-worklet.js',ring buffer
 *    连续 16k→硬件率升采样,无逐片 createBufferSource 边界→消浏览器杂音);barge_in 帧到达即 worklet flush
 *    清 ring(即时停声闭环;打断检测在服务端,前端只做执行层)。旧「逐片排程 + playingSrcs 集合」已废。
 */
const PLAY_SR = 16000; // 下行采样率(契约:16k;VoiceTest 是 24k,别照抄)。首帧预缓冲移至 worklet PREROLL_SAMPLES。
const MAX_RETRY = 3; // not_ready 自动重试次数(退避 1s/2s/4s)
// 客户端本地打断检测参数(移植 VoiceTest 真机标定值):AI 播报期入向连续高能量达确认时长 → 本地即时停播 +
// 发 barge_in 通知服务端切源。本地检测=零往返即时停声(体感),服务端 bridge 检测并存作兜底。
//
// ⚠️ **DEAD CODE when recovery enabled**(design contract,review):服务端
//   `AIM_FALSE_INTERRUPTION_RECOVERY=1`(**默认已开**,见 CDK aim-stack RealtimeSession env)时,ready 帧带
//   `false_interruption_recovery=true` → `detectBargeIn` 顶部 `if (recoveryMode.current) return` **直接短路**,
//   以下常量**根本不被求值**(不是「与服务端并行的第二道门」,是 fallback 杠杆)。调钝这些值是为
//   **recovery 关闭 / 旧服务端降级模式**下更不容易被弱背景音本地误停播。R2 主力在服务端(recovery 治瞬态 +
//   动态噪声地板治稳态)。短路点见本文件 detectBargeIn 函数首行。
//
// 值向「更钝」调(治「随便有点背景音就本地停播」,design contract):在 recovery 关闭时更不容易被弱背景音误触发。
const BARGE_GUARD_MS = 800; // AI 刚开口 800ms 内不打断(原 500;起始瞬态/AEC 收敛期更长不误判,同时采基线)
const BARGE_CONFIRM_MS = 450; // 连续高能量累计达此才确认打断(原 300;要更长的真人语音才算插话,压短促噪声)
const BARGE_HANGOVER_MS = 150; // 低能量持续超此即判「插话已停」清零(原 200;略缩,短暂噪声更快清零、不易凑满 confirm)
const BARGE_RMS_FLOOR = 0.035; // 打断绝对下限(原 0.02;抬高绝对门槛,弱背景音进不来)
const BARGE_RMS_MULT = 3.5; // 相对阈值倍数 max(floor, 基线×倍数)(原 2.5;门槛随底噪抬得更高,更抗背景音)

type Phase = 'idle' | 'connecting' | 'live' | 'ending' | 'ended' | 'failed';
// seq(design contract):服务端下发的会话内单调序号,作气泡稳定 key + 修正帧(transcript_corrected)按 seq 定位更新。
// 缺省(旧服务端不带 seq)→ undefined,回退用数组下标渲染(向后兼容)。
type ChatMsg = { role: 'user' | 'ai'; text: string; seq?: number };

export function Exam({ id, candidateToken, autoStart, embedded }: { id: string; candidateToken?: string; autoStart?: boolean; embedded?: boolean }) {
  useLang();
  const authSession = useSession();
  // 候选人模式(design contract-C):凭一次性 token 连入,无 Cognito、无权看 session 详情 → 跳过 getSession
  //(候选人只需连入对话,不展示 Agent/窗口卡)。登录用户(admin代考/staff本人)照旧拉详情。
  const isCandidate = !!candidateToken;
  const { data: sess, error: loadErr, loading } = useAsync(
    () => (isCandidate ? Promise.resolve(null) : api.getSession(id)),
    [id, isCandidate],
  );

  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState('');
  const [retryN, setRetryN] = useState(0); // 当前自动重试序号(0=非重试)
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [endReason, setEndReason] = useState('');
  // 评测结果就绪态(design contract 修):对话结束后 evaluator 异步打分需时间。ended 态轮询 result:
  //  'pending'=评测中(按钮禁用显「正在生成评测结果…」)/ 'ready'=就绪(可点「查看结果」)/
  //  'none'=无结果(session failed / 超时,可点进报告页看具体状态)。避免「结果没生成就能点、点进报错」。
  const [reportStatus, setReportStatus] = useState<'pending' | 'ready' | 'none'>('pending');
  // 实时字幕(P1-7):ASR 识别中的临时文本(partial),显示为灰色"识别中"气泡,定稿(final transcript)后清空。
  const [partialText, setPartialText] = useState('');
  // 实时反馈(P2 UI):AI 是否在说(下行音频播放中)。驱动状态指示器「AI 在说 / 在听」,
  // 让用户明确当前谁的回合(此前只有文字气泡,静默期不知 AI 是否在听)。
  const [aiSpeaking, setAiSpeaking] = useState(false);
  // 实时字幕显示开关(design contract):会话级呈现配置,ready 帧到达时由服务端下发确定,整场不变。
  // **初值乐观 true**(默认开=现状 design contract;保 pre-ready 零变化、防 idle/connecting 期布局闪烁,review)。
  // false 时进无字幕纯声波布局(去右侧 transcript 面板、声波居中放大、仅状态提示、不渲染任何转写文本)。
  const [showSubtitles, setShowSubtitles] = useState(true);
  // design contract:头像风格(Agent 顶层 avatar_style,经 ready 帧下发)。state 初值 minimal(ready 帧到达前默认);
  //   合法四枚举才用,否则兜底 minimal(向后兼容旧 backend/ready 帧无此字段;fail-safe 见 onmessage)。
  const [avatarStyle, setAvatarStyle] = useState<FaceVariant | 'waveform'>('minimal');
  // Teams 会议式舞台(design contract):transcript 面板折叠。初始 false(展开)——**不依赖 window.innerWidth**
  // (静态导出/hydration 下依赖 window 会首帧 mismatch,review);持久化到 localStorage(容错)。
  const PANEL_KEY = 'voce:transcript-panel-collapsed';
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // 挂载后从 localStorage 恢复(放 effect 里避免 SSR/首帧读 window)。
  useEffect(() => {
    try {
      if (localStorage.getItem(PANEL_KEY) === '1') setPanelCollapsed(true);
    } catch {
      /* 无 localStorage / 隐私模式:降级 in-memory 默认展开 */
    }
  }, []);
  function togglePanel() {
    setPanelCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(PANEL_KEY, next ? '1' : '0');
      } catch {
        /* quota/隐私模式:仅 in-memory */
      }
      return next;
    });
  }
  // 波形配色(design contract 评审 m1):canvas 不能直接用 CSS 变量,用 getComputedStyle 从 .stage scope 读出
  // --wave-ai/--wave-user 实际色值透传给 Waveform,随 token 走不硬编码。默认值与 globals.css .stage 的
  // --wave-* 保持同步(读取失败时的兜底)。
  const stageElRef = useRef<HTMLDivElement | null>(null);
  const colorReadRef = useRef(false); // 只读一次守卫(舞台深色恒定,读到有效值即固化)
  const [waveColors, setWaveColors] = useState<{ ai: string; user: string }>({ ai: '#8b8bf0', user: '#4ade80' });
  // useLayoutEffect:同步在 paint 前读 DOM,保证 CSS 已生效(review)。依赖 phase:.stage 仅在
  // live/ending 渲染,进 live 后 stageElRef 才有值;读到 ai&&user 才更新并置守卫,之后不再读(不随 phase 抖动)。
  useLayoutEffect(() => {
    if (colorReadRef.current) return;
    const el = stageElRef.current;
    if (!el || typeof getComputedStyle !== 'function') return;
    try {
      const cs = getComputedStyle(el);
      const ai = cs.getPropertyValue('--wave-ai').trim();
      const user = cs.getPropertyValue('--wave-user').trim();
      if (ai && user) {
        setWaveColors({ ai, user });
        colorReadRef.current = true;
      }
    } catch {
      /* getComputedStyle 不可用:保留默认色 */
    }
  }, [phase]);

  // 对话容器引用:新气泡/识别中更新后自动滚到底(P2:长对话不用手动下滚看最新)。
  const transcriptElRef = useRef<HTMLDivElement | null>(null);
  // design contract:是否处于「跟随底部」态。**在 onScroll(无新内容注入的稳定态)测量并更新**——新内容 effect 只读此
  //   ref 决定是否滚到底,不再在 commit 后重算「近底」(AI 长气泡撑大 scrollHeight 会撑破 commit 后判据 = 原 bug)。
  //   初值 true = 默认跟随最新。
  const stickToBottomRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const srcNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  // 波形只读 tap(design contract):playbackAnalyser 挂播放侧、micAnalyser 挂麦克风侧,**只喂 Waveform 显示**。
  // 权威拓扑见 design contract「架构示意」:双 connect 并联 / analyser 不接任何下游 / 建失败置 null 走降级(回退零改动直连)。
  // ⚠️ 红线:这两个 analyser 与打断检测正交——detectBargeIn 输入源保持 worklet port(不改),不从 analyser 读。
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  // 触发 Waveform 重渲染用(analyser 是 ref,建好后置一次 state 让 Waveform 拿到实例)。
  const [analysersReady, setAnalysersReady] = useState(0);
  const readyRef = useRef(false); // 收到 ready 才放行 binary 上行(契约:ready 前发会被丢弃)
  const endedRef = useRef(false);
  const closeHandledRef = useRef(false); // 本连接 close 已由 error/ended 分支处置,onclose 不再兜底
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const endTimerRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>('idle');
  // 播放调度(design contract:连续重采样 worklet,替代逐片 createBufferSource)。下行 16k PCM 分片 postMessage
  // 给播放 worklet(ring buffer 连续 16k→硬件率升采样,无逐片边界 glitch);flush 清 ring 即时停声;
  // drained 消息驱动 aiSpeaking 去抖。playbackActive 由「入队 → true / worklet drained → 去抖 false」维护。
  const playbackWorkletRef = useRef<AudioWorkletNode | null>(null);
  const playbackActive = useRef(false); // aiSpeaking 用:AI 音频在排程/播放(drained 300ms 确认后才 false,防界面闪)
  // aiSpeaking 去抖:队列瞬空(句间/网络抖动)不立刻转「在听」,延迟 300ms;期间新帧到达则取消。
  const aiSpeakOffTimer = useRef<number | null>(null);
  // 客户端本地打断检测状态(移植 VoiceTest):累计高能量 ms / hangover ms / 本段禁打断窗基线 / 本段起始时刻 / 本段已打断。
  const bargeMs = useRef(0);
  const bargeDipMs = useRef(0);
  const bargeBaseline = useRef(0);
  const aiPlayStartedAt = useRef(0);
  const bargedThisSeg = useRef(false);
  // 误打断恢复(design contract):服务端 ready 帧告知是否开启。开启时**客户端禁用本地销毁性 barge_in**——
  // 打断判定统一由服务端做(pause/resume/barge_in 下行驱动),避免「客户端已销毁、服务端想 resume」自相矛盾。
  const recoveryMode = useRef(false);
  // 播放 ACK 追踪器(design contract):capability 协商后,轮边界(ai_audio_start/end)下发 worklet 段账本,
  //   worklet 回执(turn_played/turn_aborted)→ 上行 playback_complete/aborted。未协商 = inert(逐字节等价现状)。
  //   ★ Phase 2 单独上线:服务端 Phase 4 前不回显 capability → 全程 inert,安全。
  const ackTrackerRef = useRef<PlaybackAckTracker | null>(null);
  const pauseControllerRef = useRef<PlaybackPauseController | null>(null);
  // work item:browser receive/render/flush telemetry. All timestamps use the
  // shared AudioContext clock; only durations cross the websocket.
  const uxTelemetryRef = useRef<UxTelemetryTracker | null>(null);

  function gotoPhase(p: Phase) {
    phaseRef.current = p;
    setPhase(p);
  }

  // 卸载时全量清理(WS/音频/计时器)。
  useEffect(
    () => () => {
      if (retryTimerRef.current != null) clearTimeout(retryTimerRef.current);
      if (endTimerRef.current != null) clearTimeout(endTimerRef.current);
      closeHandledRef.current = true;
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      teardownAudio();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 新气泡/识别中更新 → 自动滚到底(长对话可用性;design contract 修:stick-to-bottom 解耦新内容高度)。
  //   ★ 只读 stickToBottomRef(在 onScroll 稳定态测量),**不再** commit 后重算「近底」——AI 长回复(>80px)
  //   commit 后把 scrollHeight 撑大会让旧「<80px」判据被自己撑破 → 不滚(真机 bug 根因)。跟随态则无条件滚到底。
  //   用 useLayoutEffect:paint 前同步滚动,消除「先看到旧位置再跳」的闪。
  useLayoutEffect(() => {
    const el = transcriptElRef.current;
    if (!el) return;
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs, partialText]);

  // design contract:用户滚动时(**无新内容注入的稳定态**)更新跟随态。此刻 scrollHeight 稳定,能真实反映用户滚到哪:
  //   上滚离底 → stick=false(看历史不拉回);滚回底部附近 → stick=true(恢复跟随)。程序滚到底也触发此回调,
  //   但那时必在底 → stick 保持 true,自洽无需「程序滚动标志」。
  const onTranscriptScroll = () => {
    const el = transcriptElRef.current;
    if (!el) return;
    stickToBottomRef.current = shouldStickToBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  };

  function pushMsg(role: 'user' | 'ai', text: string, seq?: number) {
    if (!text || !text.trim()) return;
    setMsgs((prev) => [...prev, { role, text, seq }].slice(-200));
  }

  // ── 播放侧(契约下行 16k;排程模式与 VoiceTest 一致)──
  function enqueuePcm(buf: ArrayBuffer) {
    if (!buf || buf.byteLength < 2) return; // 空/半字节帧跳过
    const ctx = ctxRef.current;
    const node = playbackWorkletRef.current;
    if (!ctx || !node) return;
    if (ctx.state === 'suspended') void ctx.resume(); // 自动播放策略兜底(主解锁在开始按钮手势里)
    // 新播报段起始(此前播放空 = AI 刚开口)→ 复位本地打断检测状态 + 记起始时刻(禁打断窗从此算)。
    // design contract:判据从 playingSrcs.size===0 迁到 playbackActive(worklet drained 后置 false)。
    if (!playbackActive.current) {
      aiPlayStartedAt.current = ctx.currentTime;
      bargedThisSeg.current = false;
      bargeMs.current = 0;
      bargeDipMs.current = 0;
      bargeBaseline.current = 0;
    }
    playbackActive.current = true;
    // ★ design contract:int16→float32 归一在**主线程**做,worklet 只接收 Float32Array 的所有权。
    //   为什么移过来(第 2 轮 review 实证):若归一留在 worklet,每片必须新建一个 Float32Array
    //   → worklet 的「push 零分配」在技术上不可能成立;而音频渲染线程上的每帧分配会制造 GC 停顿、
    //   叠加在本 spec 要解决的 deadline 压力上。参考实现同做法:
    //   参考公开 WebSocket speech-to-speech 客户端的同类处理。
    //   归一公式与两份实现逐字节一致(design contract 已数值排除不对称归一为杂音源,勿"顺手统一")。
    const i16 = new Int16Array(buf);
    const samples = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) {
      const v = i16[i];
      samples[i] = v < 0 ? v / 32768 : v / 32767;
    }
    // transfer samples.buffer 所有权(零拷贝);worklet 侧 push 变成纯 O(1) 入队。
    // ★ transfer 后 samples 置空,主线程不可再读 —— 安全:samples 是本函数内新建、不被复用
    //   (本函数后续只动状态变量 aiSpeaking/timer/barge 计数,不再访问 samples)。
    // ★ GC 权衡(实现review,记录以免后人误改):每 20ms 新建一个 Float32Array
    //   (320 样本 ≈ 1.28KB;180s 长回复累计 ≈ 11.5MB)。这是**主线程**分配,不在 render quantum
    //   deadline 内,且现代分代 GC 回收短生命周期对象很廉价 —— 用它换掉音频线程上的每帧分配
    //   与 O(缓冲深度) 拷贝(峰值 5761µs > 预算 2667µs)是正确的权衡。
    //   若真机 Performance 采样发现主线程停顿再考虑 buffer 池复用(会引入已 transfer buffer 的
    //   回收管理复杂度,当前"新建即转移"天然无别名风险)。
    node.port.postMessage(samples, [samples.buffer]);
    // 新帧到达:取消待定的「转在听」延迟 + 立即置在说(消除句间/抖动闪烁)。
    if (aiSpeakOffTimer.current != null) {
      clearTimeout(aiSpeakOffTimer.current);
      aiSpeakOffTimer.current = null;
    }
    setAiSpeaking(true); // 有下行音频在排程/播放 → AI 在说
  }

  // 播放 worklet 回传 drained → **真正播完**(worklet 已确认 ring 空后持续静默 ~300ms,非瞬时 underrun)。
  // design contract:drained 语义从「ring 一空就发」收紧为「持续静默确认」——瞬时中段 underrun(等下一句跨境生成)
  //   不再发 drained,故 playbackActive 不被误翻 false → design contract user-final 停播 / detectBargeIn 判据不误读
  //   「没在播」→ 不跳 flush → 旧轮音频不串进新轮(消"两句叠一起")。此处收到 = 确认播完,置 false 转「在听」。
  // ★ review 已做 300ms 静默确认,主线程**不再叠加 300ms 去抖**(否则总延迟 600ms、
  //   界面"在说"→"在听"迟钝)。drained 已是权威"播完"信号 → 直接转;仅留极短 80ms 防边界(新帧入队即清)。
  function onPlaybackDrained() {
    playbackActive.current = false;
    if (aiSpeakOffTimer.current == null) {
      aiSpeakOffTimer.current = window.setTimeout(() => {
        aiSpeakOffTimer.current = null;
        if (!playbackActive.current) setAiSpeaking(false);
      }, 80);
    }
  }

  // barge_in 执行层:worklet flush 清 ring(即时停声闭环;检测在服务端)。
  // design contract:替代原逐片 playingSrcs 全 stop();worklet 清空 ring → 下一硬件帧即静音(~2.7ms,体感即时)。
  function stopPlayback(confirmedBargeIn = false) {
    pauseControllerRef.current?.clear();
    const flushMessage = confirmedBargeIn
      ? uxTelemetryRef.current?.confirmedFlushMessage()
      : undefined;
    playbackWorkletRef.current?.port.postMessage(flushMessage ?? { type: 'flush' });
    playbackActive.current = false;
    if (aiSpeakOffTimer.current != null) {
      clearTimeout(aiSpeakOffTimer.current);
      aiSpeakOffTimer.current = null;
    }
    setAiSpeaking(false); // 停播(barge_in/结束)→ 立即 AI 不在说(打断不延迟)
  }

  // 客户端本地打断检测(移植 VoiceTest,真机标定过能打断):AI 播报期入向连续高能量达确认时长 →
  // **本地即时停播**(零往返,体感"打断了")+ 发 {type:barge_in} 通知服务端切 LLM/TTS 源。每段播报只触发一次。
  // 与服务端 bridge detectBargeIn 并存(双保险);本地负责即时停声,服务端负责真停后端生成。
  function detectBargeIn(i16: Int16Array) {
    // 误打断恢复(design contract):开启时打断判定统一由服务端做(它有真实入向音频 + tentative-pause 计时),
    // 客户端**不做本地销毁性打断**——否则「客户端已 stopPlayback 销毁、服务端想 resume」自相矛盾(spec 明确排除)。
    // ★ recovery 开启(默认)时此处直接返回 → 下方 BARGE_* 门槛全部**不被求值**(死代码,见文件头常量注释)。
    if (recoveryMode.current) return;
    const ctx = ctxRef.current;
    if (!ctx) return;
    const now = ctx.currentTime;
    const aiPlaying = playbackActive.current; // design contract:有音频在 worklet 排程/播放 = AI 在说(替代 now<nextPlayTime)
    if (!aiPlaying || bargedThisSeg.current) {
      bargeMs.current = 0;
      bargeDipMs.current = 0;
      return;
    }
    // 帧 RMS(int16 归一化到 [-1,1])
    let sum = 0;
    for (let k = 0; k < i16.length; k++) { const v = i16[k] / 32768; sum += v * v; }
    const rms = Math.sqrt(sum / Math.max(1, i16.length));
    const frameMs = (i16.length / PLAY_SR) * 1000;
    // 起始禁打断窗:AI 这段刚开口 BARGE_GUARD_MS 内不打断(回放瞬态/AEC 收敛前易误判);同时采基线(环境+回声残留)。
    if (now - aiPlayStartedAt.current < BARGE_GUARD_MS / 1000) {
      if (rms > bargeBaseline.current) bargeBaseline.current = rms;
      return;
    }
    const threshold = Math.max(BARGE_RMS_FLOOR, bargeBaseline.current * BARGE_RMS_MULT);
    if (rms >= threshold) {
      bargeMs.current += frameMs;
      bargeDipMs.current = 0;
      if (bargeMs.current >= BARGE_CONFIRM_MS) {
        bargedThisSeg.current = true;
        bargeMs.current = 0;
        ackTrackerRef.current?.flushWithReason('barge_in'); // design contract:本地打断停播
        stopPlayback(true); // 本地即时停声(执行层,零往返)
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'barge_in' })); // 通知服务端切源
      }
    } else {
      // hangover:浊/清音交替的单帧跌落不清零(计时暂停),低能量持续超 BARGE_HANGOVER_MS 才判「插话已停」。
      bargeDipMs.current += frameMs;
      if (bargeDipMs.current >= BARGE_HANGOVER_MS) { bargeMs.current = 0; bargeDipMs.current = 0; }
    }
  }

  // ── 采集侧(AudioWorklet)──
  /** 初始化音频管线(幂等):AudioContext + worklet 模块 + 麦克风。抛错分两类:
   *  'audio'(AudioContext/worklet 失败)与 'mic'(getUserMedia 拒/失败),上层映射明确文案。 */
  async function ensureAudio(): Promise<void> {
    if (ctxRef.current && micRef.current) return;
    let ctx: AudioContext;
    try {
      ctx =
        ctxRef.current ||
        new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      ctxRef.current = ctx;
      // ★ AudioContext 新建即 suspended,只能在用户手势里解锁(本函数由「开始考试」点击调用)。
      await ctx.resume().catch(() => undefined);
      // 播一个极短静音踢一脚输出管线(蓝牙路由首次需要;VoiceTest 真机经验)。
      try {
        const warm = ctx.createBufferSource();
        warm.buffer = ctx.createBuffer(1, 1, PLAY_SR);
        warm.connect(ctx.destination);
        warm.start();
      } catch {
        /* ignore */
      }
      // AudioWorklet 模块(M1:替换 ScriptProcessor;重采样在 worklet 线程做)。
      await ctx.audioWorklet.addModule('/pcm-worklet.js');
      // design contract:播放 worklet 模块(下行 16k→硬件率连续升采样,消逐片边界杂音)。与采集同一 addModule 阶段;
      // 失败即整体音频 'audio' 错(不留旧逐片路径,单一路径,与采集 worklet 一致)。
      await ctx.audioWorklet.addModule('/pcm-playback-worklet.js');
    } catch {
      throw new Error('audio');
    }
    // 波形 tap:播放侧 analyser(design contract)。**建失败置 null → 波形降级,不阻断对话**,不抛。
    // analyser 不接任何下游(纯 tap);smoothingTimeConstant 稍高让波形不过于抖。
    if (!playbackAnalyserRef.current) {
      try {
        const pa = ctx.createAnalyser();
        pa.fftSize = 256;
        pa.smoothingTimeConstant = 0.7;
        playbackAnalyserRef.current = pa;
      } catch {
        playbackAnalyserRef.current = null;
      }
    }
    // design contract:播放 worklet 节点(0 输入 / 1 输出)。下行 PCM 经 enqueuePcm postMessage 进来,连续升采样出声。
    // node → destination 出声;node → playbackAnalyser(纯 tap,不接下游,同 design contract 红线);drained 消息驱动 aiSpeaking。
    if (!playbackWorkletRef.current) {
      const pnode = new AudioWorkletNode(ctx, 'pcm-playback', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      // dropped:design contract 容量溢出告警(可选消息;旧主线程忽略也能正常工作)
      pnode.port.onmessage = (
        e: MessageEvent<{
          type?: string;
          generation?: number;
          seq?: number;
          positionMs?: number;
          dropped?: number;
          ai_turn_id?: number;
          render_context_time?: number;
          pause_id?: number;
          pause_context_time?: number;
          silent_context_time?: number;
          flush_context_time?: number;
          cold_preroll_ms?: number;
          underruns_before_first_render?: number;
          browser_ring_depth_at_confirm_ms?: number;
          browser_ring_depth_before_flush_ms?: number;
          browser_ring_depth_after_flush_ms?: number;
        }>,
      ) => {
        const d = e.data;
        if (!d) return;
        if (d.type === 'drained') {
          onPlaybackDrained(); // design contract:全局 ring 排空确认(驱动 aiSpeaking/UI,与单轮 ACK 解耦)
        } else if (d.type === 'legacy_payload') {
          // design contract:worklet 收到旧格式 int16 载荷 → 前端文件版本不一致(worklet 新、Exam.tsx 旧,
          //   或反之)。走的是 fail-soft 兼容路径、仍能出声,但应清缓存/重部署使两侧同版。
          // eslint-disable-next-line no-console
          console.warn('[playback] worklet received legacy int16 payload — frontend files out of sync (clear cache / redeploy)');
        } else if (d.type === 'overflow') {
          // design contract(实现review):worklet 容量溢出告警 —— 此前主线程忽略该消息,
          //   后续溢出episode 会完全静默。现落日志(病态路径,正常长回复恒不触发)。
          // eslint-disable-next-line no-console
          console.warn(`[playback] worklet capacity overflow: dropped ${d.dropped} unplayed samples`);
        } else if (d.type === 'turn_played' || d.type === 'turn_aborted') {
          // design contract:worklet 段账本回执 → tracker → 上行 playback_complete/aborted(未协商则 inert)。
          if (typeof d.generation === 'number' && typeof d.seq === 'number') {
            ackTrackerRef.current?.onWorkletEvent(d as { type: 'turn_played' | 'turn_aborted'; generation: number; seq: number; positionMs: number });
          }
        } else if (
          d.type === 'telemetry_first_rendered' ||
          d.type === 'telemetry_paused' ||
          d.type === 'telemetry_flushed'
        ) {
          uxTelemetryRef.current?.onWorkletEvent(d as WorkletUxTelemetryEvent);
        }
      };
      pnode.connect(ctx.destination);
      if (playbackAnalyserRef.current) {
        try {
          pnode.connect(playbackAnalyserRef.current); // 波形 tap(纯旁挂,不接下游)
        } catch {
          /* 极端环境 connect 失败:忽略,播放路径已建立,波形自然降级 */
        }
      }
      playbackWorkletRef.current = pnode;
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micRef.current = mic;
    } catch {
      throw new Error('mic');
    }
    // mic → worklet(重采样 16k int16)→ 零增益汇 → destination(不把麦克风外放,防回授)。
    const srcNode = ctx.createMediaStreamSource(micRef.current);
    const node = new AudioWorkletNode(ctx, 'pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const ws = wsRef.current;
      // 契约:ready 前不发 binary(服务端会丢弃);全双工——live 期间持续上行(供服务端检测 + 打断后立即起新轮)。
      if (readyRef.current && ws && ws.readyState === 1) ws.send(e.data);
      // 客户端本地打断检测(零往返即时停声):AI 播报期检测插话 → 本地停播 + 发 barge_in。
      if (e.data && e.data.byteLength >= 2) detectBargeIn(new Int16Array(e.data));
    };
    const sink = ctx.createGain();
    sink.gain.value = 0;
    srcNode.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    srcNodeRef.current = srcNode;
    workletRef.current = node;
    sinkRef.current = sink;
    // 波形 tap:麦克风侧 analyser(design contract)。旁挂在 srcNode 上,**不 connect 任何下游节点**
    // (不接 destination=防回授/不外放;不接 worklet=不干扰上行)。**仅供 Waveform 显示**——打断检测
    // (detectBargeIn)输入源仍是 worklet port 的 16k PCM(不改,红线;design contract review)。建失败置 null。
    try {
      const ma = ctx.createAnalyser();
      ma.fftSize = 256;
      ma.smoothingTimeConstant = 0.7;
      srcNode.connect(ma);
      micAnalyserRef.current = ma;
    } catch {
      micAnalyserRef.current = null;
    }
    // 通知渲染层 analyser 已就绪(Waveform 取实例)。
    setAnalysersReady((n) => n + 1);
  }

  function teardownAudio() {
    readyRef.current = false;
    // design contract:若尚未标更具体的停播原因(ended/superseded 已各自标过),按 teardown 收尾。二次 flush 对已清账本无副作用。
    ackTrackerRef.current?.flushWithReason('client_teardown');
    stopPlayback();
    uxTelemetryRef.current?.clear();
    uxTelemetryRef.current = null;
    pauseControllerRef.current?.reset();
    pauseControllerRef.current = null;
    try {
      workletRef.current?.port.close();
      workletRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    // design contract:播放 worklet 节点清理(与采集 worklet 同批,无泄漏)。
    try {
      playbackWorkletRef.current?.port.close();
      playbackWorkletRef.current?.disconnect();
      playbackWorkletRef.current = null;
    } catch {
      /* ignore */
    }
    playbackActive.current = false;
    try {
      srcNodeRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      sinkRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    if (micRef.current) micRef.current.getTracks().forEach((tr) => tr.stop());
    // 波形 tap 清理(design contract):disconnect 两个 analyser,与 srcNode/worklet/sink 同批(无泄漏)。
    try {
      playbackAnalyserRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      micAnalyserRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      void ctxRef.current?.close();
    } catch {
      /* ignore */
    }
    workletRef.current = null;
    srcNodeRef.current = null;
    sinkRef.current = null;
    micRef.current = null;
    playbackAnalyserRef.current = null;
    micAnalyserRef.current = null;
    ctxRef.current = null;
  }

  // ── 连接流程 ──
  /** /join → 开 WS。409/503 等 REST 错误:detail 直展 + 回 idle(「开始考试」可再点)。 */
  async function connect(): Promise<void> {
    let join: SessionJoinOut;
    try {
      // 候选人模式凭一次性 token 走 /api/candidate/join(后端凭 token 定位其会话);登录用户走 /api/sessions/{id}/join。
      join = candidateToken
        ? (await candidateApi.join(candidateToken)) as SessionJoinOut
        : await api.joinSession(id);
    } catch (e) {
      // 409(未到窗/已结束/终态)与 503(密钥未配):后端 detail 是中文,直接展示。
      // 拆采集(review):join 被拒后麦克风不能仍开着(用户可能离开页面停在 idle)。
      teardownAudio();
      const detail = e instanceof ApiError ? e.detail
        : (e instanceof CandidateApiError ? e.message : t('error_generic'));
      setErr(detail);
      setRetryN(0);
      gotoPhase('idle');
      return;
    }
    openWs(join);
  }

  function openWs(join: SessionJoinOut) {
    // 清理旧连接(重试/重连路径可能残留;review:迟到的旧 onclose 会污染新连接状态)。
    if (wsRef.current) {
      uxTelemetryRef.current?.clear();
      uxTelemetryRef.current = null;
      pauseControllerRef.current?.reset();
      pauseControllerRef.current = null;
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsPath = join.ws_path || '/rt/ws';
    // WS ?session_id= 必须与 join_token 内含的 session_id 一致(bridge 交叉校验,不一致即拒)。
    // 候选人模式 id 为空(后端凭 token 定位会话),从 join_token(v1.<session_id>.<exp>.<sig>)解析真实
    // session_id;登录模式该值与 id 相同。这样两条路径统一走 token 内的权威 session_id。
    const sidFromToken = join.join_token.split('.')[1] || id;
    const ws = new WebSocket(`${proto}://${location.host}${wsPath}?session_id=${encodeURIComponent(sidFromToken)}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    readyRef.current = false;
    closeHandledRef.current = false;

    ws.onopen = () => {
      if (wsRef.current !== ws) return; // stale socket 守卫
      // 首帧鉴权(契约:10s 内必发;token 不入 URL)。protocol_version 声明本客户端支持的 WS 协议版本
      // (design contract;服务端 ready 帧回显,未知版本 fail-closed)。
      // design contract:声明 playback_ack_v1 能力;服务端 ready 回显才启用(否则 inert,老服务端忽略未知字段)。
      ws.send(JSON.stringify({
        type: 'auth',
        token: join.join_token,
        protocol_version: '1',
        capabilities: [PLAYBACK_ACK_CAPABILITY, PLAYBACK_PAUSE_CAPABILITY],
      }));
      // design contract:建 ACK tracker,绑定本连接的 WS send + 播放 worklet post。协商在 ready 帧做。
      ackTrackerRef.current = new PlaybackAckTracker(
        (frame) => { if (wsRef.current === ws && ws.readyState === 1) ws.send(JSON.stringify(frame)); },
        (msg) => { playbackWorkletRef.current?.port.postMessage(msg); },
      );
      pauseControllerRef.current = new PlaybackPauseController(
        (msg) => { playbackWorkletRef.current?.port.postMessage(msg); },
        () => ctxRef.current?.currentTime ?? 0,
      );
      uxTelemetryRef.current = new UxTelemetryTracker(
        (frame) => { if (wsRef.current === ws && ws.readyState === 1) ws.send(JSON.stringify(frame)); },
        (msg) => { playbackWorkletRef.current?.port.postMessage(msg); },
        () => ctxRef.current?.currentTime ?? 0,
      );
    };
    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return; // stale socket 守卫(被新连接替换后迟到的帧一律丢)
      if (typeof ev.data !== 'string') {
        uxTelemetryRef.current?.onFirstBinary();
        enqueuePcm(ev.data as ArrayBuffer); // 下行 AI 语音(16k)→ 排程播放
        return;
      }
      let m: { type?: string; code?: string; speaker?: string; text?: string; reason?: string; false_interruption_recovery?: boolean; show_subtitles?: boolean; avatar_style?: string; effective_speaker_lock?: boolean; seq?: number; capabilities?: unknown; ai_turn_id?: number; pause_id?: number };
      try {
        m = JSON.parse(ev.data);
      } catch {
        return; // 非 JSON 信令忽略(向前兼容)
      }
      if (m.type === 'ready') {
        // 鉴权成功:开麦(readyRef 放行 binary 上行)。
        // 误打断恢复(design contract):记录服务端模式;开启则本地禁销毁性 barge_in(改由服务端 pause/resume/barge_in 驱动)。
        // 声纹锁定(design contract D7):effective_speaker_lock=true ⟹ recovery 必开(服务端裁定),故本地销毁性 barge_in
        //   同样须禁用(所有打断经服务端声纹门)。`=== true` 显式判(禁 `!!`,缺省不误开);与 recovery 取或,
        //   保证两者任一为真都禁本地打断。**不新增其他前端行为**(打断/播放/采集零改动)。
        recoveryMode.current = !!m.false_interruption_recovery || m.effective_speaker_lock === true;
        // 实时字幕显示开关(design contract):**唯字面 false 才关**(缺省/undefined/旧服务端未下发 → true 默认开)。
        // ⚠ 不能用 `!!m.show_subtitles`——`!!undefined===false` 会倒置默认(review)。
        setShowSubtitles(m.show_subtitles !== false);
        // design contract:合法四枚举才用,否则兜底 minimal(fail-safe:旧 backend 无字段 / 脏值)。
        setAvatarStyle((['minimal', 'round', 'tech', 'waveform'].includes(m.avatar_style || '') ? m.avatar_style : 'minimal') as FaceVariant | 'waveform');
        // design contract:按 ready 回显的 capabilities 协商播放 ACK(未回显 → inert,逐字节等价现状)。
        ackTrackerRef.current?.negotiate(m.capabilities);
        pauseControllerRef.current?.negotiate(m.capabilities);
        readyRef.current = true;
        attemptRef.current = 0;
        setRetryN(0);
        setErr('');
        gotoPhase('live');
      } else if (m.type === 'transcript_partial') {
        // 识别中(partial):实时更新临时气泡,让用户看到"系统在听我说"(消除说话时静默焦虑)。
        setPartialText(m.text || '');
      } else if (m.type === 'transcript') {
        pushMsg(m.speaker === 'ai' ? 'ai' : 'user', m.text || '', typeof m.seq === 'number' ? m.seq : undefined);
        if (m.speaker !== 'ai') {
          setPartialText(''); // user 定稿到达 → 清识别中临时气泡
          // ★★ design contract(真机根因):**删除**原「收到 user final transcript 就 stopPlayback flush」逻辑
          //   (design contract 引入,本意防"服务端以为播完、客户端旧音频还在播"的时差窗打断残留)。
          //   **与 ring 架构根本冲突**:旧架构 nextPlayTime 只排"有限已排程音频"、且假设"收到 user final 时新回复
          //   尚未产生";新架构 ring **缓冲整段 AI 回复的多句**(跨境下发快于播放)。全双工下 ASR 把 AI 回声/用户
          //   环境噪声识别成 final → 此处 flush → **清掉 ring 里还没播的后续句 = "下一句冲掉上一句"**(真机实证)。
          //   清旧音频只应由**真打断**触发:①本地 detectBargeIn(连续高能量)→ stopPlayback ②服务端 barge_in 下行
          //   → stopPlayback。两条 barge_in 链路仍在(见下 barge_in case),user transcript 到达**不再**销毁性 flush。
          //   (与 design contract 误打断恢复精神一致:非确凿打断不销毁播放。)
        }
      } else if (m.type === 'transcript_corrected') {
        // ASR 字幕修正(design contract):按 seq 定位已显示的该条 user 气泡,原地替换文本(不新增气泡)。
        // seq 缺失(异常)则忽略(不误改);会话结束后迟到的帧此处仍会更新(无害,气泡还在),但服务端已不再发。
        const cseq = m.seq;
        const ctext = m.text || '';
        if (typeof cseq === 'number' && ctext) {
          setMsgs((prev) => prev.map((mm) => (mm.seq === cseq && mm.role === 'user' ? { ...mm, text: ctext } : mm)));
        }
      } else if (m.type === 'pause') {
        // work item:协商后按 ai_turn_id + pause_id 冻结 worklet render,保留 ring/账本。
        pauseControllerRef.current?.onPause(m as PlaybackPauseFrame);
      } else if (m.type === 'resume') {
        pauseControllerRef.current?.onResume(m as PlaybackPauseFrame);
      } else if (m.type === 'barge_in') {
        // design contract:服务端 barge_in = 已确认打断,标 abort reason(客户端 flush 会触发 worklet turn_aborted 上行)。
        ackTrackerRef.current?.flushWithReason('barge_in');
        stopPlayback(true); // 契约:立即停止本地播放并清空播放队列(即时停声闭环)
      } else if (m.type === 'ai_audio_start') {
        if (typeof m.ai_turn_id === 'number') {
          // UX marker is unconditional; ACK bookkeeping remains capability-gated.
          pauseControllerRef.current?.onAudioStart(m.ai_turn_id);
          uxTelemetryRef.current?.onAudioStart(m.ai_turn_id);
          ackTrackerRef.current?.onAudioStart(m.ai_turn_id);
        }
      } else if (m.type === 'ai_audio_end') {
        // design contract:轮媒体 drain 终点(onAiDone)→ worklet 封口该轮(未协商则 inert)。
        if (typeof m.ai_turn_id === 'number') {
          pauseControllerRef.current?.onAudioEnd(m.ai_turn_id);
          ackTrackerRef.current?.onAudioEnd(m.ai_turn_id);
        }
      } else if (m.type === 'playback_superseded') {
        // design contract:服务端确认起用户驱动新轮 → flush 旧轮 ring(带 superseded reason)。
        // ★ 由服务端权威触发(非 user-transcript,不踩 design contract);worklet turn_aborted → 上行 playback_aborted。
        // design contract 后服务端无条件下发此单向帧；旧客户端按 v1 未知帧规则忽略。
        ackTrackerRef.current?.flushWithReason('superseded');
        stopPlayback();
      } else if (m.type === 'ended') {
        endedRef.current = true;
        closeHandledRef.current = true;
        setPartialText(''); // 结束:清残留识别中气泡
        if (endTimerRef.current != null) clearTimeout(endTimerRef.current);
        setEndReason(String(m.reason || ''));
        ackTrackerRef.current?.flushWithReason('session_end'); // design contract:会话结束停播
        stopPlayback();
        teardownAudio();
        gotoPhase('ended');
      } else if (m.type === 'error') {
        // 契约:error 后服务端关连接。not_ready → 重新 /join + 重连(退避);
        // superseded(design contract「新挤旧」)→ 本连接已被同会话的新连接取代,静默收场不报错、不重试
        // (否则旧 tab/旧设备会误报失败或与新连接抢会话);其它(auth_failed/未知 code)→ 失败态。
        closeHandledRef.current = true;
        if (m.code === 'not_ready') scheduleRetry();
        else if (m.code === 'superseded') {
          teardownAudio(); // 被新连接接管:停本地麦/播放(内含 stopPlayback),不重试、不判 failed
          setPartialText('');
          setEndReason('superseded');
          gotoPhase('ended');
        } else {
          teardownAudio(); // 不可恢复失败:停麦(review)
          setPartialText(''); // 清残留识别中气泡
          setErr(t('exam_auth_failed'));
          gotoPhase('failed');
        }
      }
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return; // stale socket 守卫
      if (endedRef.current || closeHandledRef.current) return;
      if (phaseRef.current === 'live' || phaseRef.current === 'ending') {
        // 对话中裸断连(无 ended 帧):提示 + 给重试(重连走 /join,scheduled/in_progress 仍可连入)。
        stopPlayback();
        teardownAudio(); // failed 态停麦(review;「重试」按钮里 ensureAudio 会重建)
        setPartialText(''); // 清残留识别中气泡(review:裸断连不清则留 stale 气泡)
        setErr(t('exam_ws_closed'));
        gotoPhase('failed');
      } else if (phaseRef.current === 'connecting') {
        // 未收 ready 也未收 error 帧就断(auth 超时/网络抖动)→ 按 not_ready 同路径退避重试。
        scheduleRetry();
      }
    };
    ws.onerror = () => {
      /* onclose 统一处置 */
    };
  }

  /** not_ready 自动重试:重新 /join 再重连,退避 1s/2s/4s;超 MAX_RETRY 次给「重试」按钮。 */
  function scheduleRetry() {
    const n = attemptRef.current + 1;
    if (n > MAX_RETRY) {
      teardownAudio(); // 重试耗尽:停麦(review)
      setErr(t('exam_not_ready_failed'));
      setRetryN(0);
      gotoPhase('failed');
      return;
    }
    attemptRef.current = n;
    setRetryN(n);
    gotoPhase('connecting');
    const delayMs = 1000 * Math.pow(2, n - 1); // 1s / 2s / 4s
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      void connect();
    }, delayMs);
  }

  /** 「开始考试」(用户手势:解锁 AudioContext + 申请麦克风)→ /join → WS。 */
  async function startExam() {
    setErr('');
    setEndReason('');
    endedRef.current = false;
    attemptRef.current = 0;
    setRetryN(0);
    gotoPhase('connecting');
    try {
      await ensureAudio();
    } catch (e) {
      setErr(t((e as Error).message === 'mic' ? 'exam_mic_denied' : 'exam_audio_failed'));
      gotoPhase('idle');
      return;
    }
    await connect();
  }

  /** 「重试」(failed 态,用户手势)。 */
  async function retry() {
    setErr('');
    attemptRef.current = 0;
    setRetryN(0);
    gotoPhase('connecting');
    try {
      await ensureAudio(); // 可能已被 teardown(裸断连路径没拆;ensureAudio 幂等)
    } catch (e) {
      setErr(t((e as Error).message === 'mic' ? 'exam_mic_denied' : 'exam_audio_failed'));
      gotoPhase('failed');
      return;
    }
    await connect();
  }

  // autoStart(语音 Chat 内联):一挂载即自动进入对话,免用户在 Exam 内再点一次「开始」——
  // VoiceChat 的「语音对话」点击(用户手势)→ 建 session → 挂载本组件 → 这里紧接着 startExam,
  // 浏览器仍认得该手势(getUserMedia 在手势后短时内)。只触发一次(startedOnceRef 守卫);
  // 非候选人需等 session 详情加载完(拿到 join 所需上下文)。失败回 idle,用户可手动点重试。
  const startedOnceRef = useRef(false);
  useEffect(() => {
    if (!autoStart || startedOnceRef.current) return;
    if (phase !== 'idle') return;
    if (!isCandidate && loading) return; // 等 getSession 完成
    startedOnceRef.current = true;
    void startExam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, phase, isCandidate, loading]);

  /** 「结束考试」:发 {"type":"end"},等服务端 ended 帧(兜底 8s 强制置终态)。 */
  function endExam() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) {
      // 连接已不在:直接置终态。
      endedRef.current = true;
      teardownAudio();
      gotoPhase('ended');
      return;
    }
    gotoPhase('ending');
    try {
      ws.send(JSON.stringify({ type: 'end' }));
    } catch {
      /* onclose 兜底 */
    }
    // 兜底:服务端 ended 帧尽力而为,8s 未到强制收尾(避免 UI 卡在「结束中」)。
    endTimerRef.current = window.setTimeout(() => {
      endTimerRef.current = null;
      if (phaseRef.current !== 'ending') return;
      endedRef.current = true;
      closeHandledRef.current = true;
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      teardownAudio();
      gotoPhase('ended');
    }, 8000);
  }

  function backHome() {
    // 候选人无后台;登录用户回各自列表。
    if (isCandidate) return;
    navigate(authSession?.isAdmin ? '#/sessions' : '#/my-meetings');
  }

  // design contract:通话结束后进报告页(评测进行中会轮询、就绪自动显示)。候选人无后台不提供。
  function gotoReport() {
    if (isCandidate) return;
    navigate(authSession?.isAdmin ? `#/sessions/${id}/report` : `#/my-meetings/${id}/report`);
  }

  // 评测就绪轮询(design contract 修):对话结束 → evaluator 异步打分需时间(跨境 LLM)。ended 态轮询 result,
  // 驱动「查看结果」按钮:pending 时禁用显「正在生成评测结果…」,ready 才可点。判据同 Report.tsx::useReportResult:
  //  getResult 200 → ready(停轮);404 + session.status=failed → none(不轮,进报告页看失败详情);
  //  其余(completed/未知 + 404)→ 评测中,继续轮询(退避,总时长上限)。候选人无报告不轮。
  useEffect(() => {
    if (phase !== 'ended' || isCandidate) return;
    let cancelled = false;
    let timer: number | null = null;
    const startedAt = Date.now();
    const POLL_MS = 3000;
    const POLL_MAX_MS = 180000; // 3min 上限(与 Report 页一致);超时停在 pending,用户仍可点进报告页看状态
    setReportStatus('pending');
    async function poll() {
      try {
        await api.getResult(id);
        if (cancelled) return;
        setReportStatus('ready'); // 200 → 就绪(评测完成,含 evaluation_error 也算「有结果可看」)
        return;
      } catch (e) {
        if (cancelled) return;
        const status = e instanceof ApiError ? e.status : 0;
        if (status !== 404) { setReportStatus('none'); return; } // 非 404 异常:让用户进报告页看详情
        let sessStatus = '';
        try {
          const s = await api.getSession(id);
          sessStatus = s.status || '';
        } catch { /* 取不到 → 当评测中兜底轮询 */ }
        if (cancelled) return;
        if (sessStatus === 'failed') { setReportStatus('none'); return; } // 会话失败:无结果,进报告页看
        // completed/未知 + 404 → 评测中,继续轮询
        if (Date.now() - startedAt >= POLL_MAX_MS) { setReportStatus('none'); return; } // 超时:放行点击(评审/review),报告页仍会显「评测中」提示,用户可手动刷新
        setReportStatus('pending');
        timer = window.setTimeout(poll, POLL_MS);
      }
    }
    void poll();
    return () => { cancelled = true; if (timer != null) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, isCandidate, id]);

  // ── 渲染 ──
  if (loading) {
    return (
      <div className="page">
        <Loading label={t('loading')} />
      </div>
    );
  }
  // 候选人模式无 sess(不拉详情),不因 !sess 报错;仅登录用户路径校验加载错误。
  if (!isCandidate && (loadErr || !sess)) {
    return (
      <div className="page">
        <ErrorBanner message={loadErr || t('error_generic')} />
        <button className="btn" onClick={backHome}>
          {t('back')}
        </button>
      </div>
    );
  }

  const phaseLabel: Record<Phase, string> = {
    idle: t('exam_st_idle'),
    connecting: t('exam_st_connecting'),
    live: t('exam_st_live'),
    ending: t('exam_st_ending'),
    ended: t('exam_st_ended'),
    failed: t('exam_st_failed'),
  };

  // 波形当前路:AI 在说 → 播放侧 analyser + 靛蓝;否则(聆听/句间)→ 麦克风侧 analyser + 绿。
  const waveAnalyser = aiSpeaking ? playbackAnalyserRef.current : micAnalyserRef.current;
  const waveVariant: 'ai' | 'user' = aiSpeaking ? 'ai' : 'user';
  const waveColor = aiSpeaking ? waveColors.ai : waveColors.user;
  // active(review):live/ending 期**两路都 active**——AI 说话跟播放能量跳动、
  // 聆听态跟麦克风能量跳动(用户说话时绿波形真实起伏,不说话自然平缓)。此前误传 aiSpeaking →
  // 聆听态 active=false 使 spectrumToBars 走待机、用户说话波形不动(反直觉,真机会当 bug)。
  const waveActive = phase === 'live' || phase === 'ending';
  // 引用 analysersReady 让 lint 满意;它的 setState(ensureAudio 尾部)触发重渲染,使 Waveform 拿到
  // 新建的 analyser ref 实例(ref 变化本身不重渲染,靠这次 setState 兜)。
  void analysersReady;

  return (
    <div className={embedded ? '' : 'page'}>
      {/* 内联(语音 Chat)时不显自己的标题:外层 VoiceChat 已给标题 + 返回。独立页才显。 */}
      {!embedded && (
        <div className="page-head">
          <div>
            <h1 className="page-title">{t('exam_title')}</h1>
            <div className="page-sub">{t('exam_sub')}</div>
          </div>
          {/* 候选人凭链接进入,无后台可返回;仅登录用户显返回。 */}
          {!isCandidate && (
            <button className="btn" onClick={backHome}>
              {t('back')}
            </button>
          )}
        </div>
      )}

      <ErrorBanner message={err} />

      {/* Teams 会议式舞台(design contract):.stage-shell(grid)> 兄弟节点 .stage(深色 scope) + .stage-panel(跟随 token,
          不嵌套在 .stage 内,不继承深色);底部 .stage-bar 控制条。折叠态给 shell 加 class,CSS 收起面板列。
          design contract:showSubtitles=false 时加 .no-subtitles class(CSS 只作用此 class,不碰默认/折叠态规则),
          不渲染 .stage-panel(声波占满宽度居中放大)。 */}
      <div
        className={
          'stage-shell' +
          (!showSubtitles ? ' no-subtitles' : panelCollapsed ? ' panel-collapsed' : '')
        }
      >
        <div className={'stage' + (avatarStyle === 'waveform' ? ' avatar-waveform' : '')} ref={stageElRef}>
          {/* info-card 三路径(design contract review):仅**登录用户独立页**显,作舞台上方独立行;
              embedded(外层已给)与候选人(不可见 Agent 详情)均不显。 */}
          {!embedded && !isCandidate && sess && (
            <div className="stage-info">
              <span className="si-agent">{sess.agent_name || sess.agent_id}</span>
              <span className={'status ' + statusClass(sess.status, sess.fail_reason)}>
                <span className="dot" />
                {statusLabel(sess.status, sess.fail_reason)}
              </span>
            </div>
          )}

          {/* 舞台中央:按 phase 承载内容(逻辑与按钮 onClick 一律不改)。 */}
          <div className="stage-center">
            {phase === 'idle' && (
              // 「开始对话」按钮 onClick=startExam(用户手势解锁 AudioContext + getUserMedia)——
              // autoStart 亦经 useEffect 调 startExam,此按钮位置变化 MUST NOT 破坏手势链(design contract review)。
              <button className="btn btn-primary btn-lg stage-start" onClick={startExam}>
                <span aria-hidden="true">🎤 </span>{t('exam_start')}
              </button>
            )}
            {phase === 'connecting' && (
              <div className="stage-msg">
                <Loading label={t('exam_st_connecting')} />
                {retryN > 0 && (
                  <div className="stage-retry">
                    {t('exam_retrying').replace('{n}', String(retryN)).replace('{max}', String(MAX_RETRY))}
                  </div>
                )}
              </div>
            )}
            {(phase === 'live' || phase === 'ending') && (
              <>
                {/* design contract:按 Agent avatar_style 分流。minimal/round/tech → SVG 头像(视觉主体,嘴型随能量连续
                    开合、眼睛周期眨)+ 底部小波形;waveform → 无头像,只中央大波形(回退 design contract)。旁挂只读 analyser
                    (与 Waveform 共用同一 tap),音频/信令零改动(design contract 红线)。配色随 aiSpeaking(AI/用户)。 */}
                {avatarStyle !== 'waveform' && (
                  <SvgFace analyser={waveAnalyser} active={waveActive} variant={avatarStyle as FaceVariant} color={waveColor} />
                )}
                {/* 舞台大字「谁在说」:纯视觉,aria-hidden(播报交给控制条 live-cue,避免双重播报;design contract review)。 */}
                <div className={'stage-who ' + (aiSpeaking ? 'who-ai' : 'who-listen')} aria-hidden="true">
                  {aiSpeaking ? t('exam_ai_speaking') : t('exam_listening')}
                </div>
                {/* 波形:头像风格下缩小移底作辅助(design contract);waveform 风格下经 .avatar-waveform 回 design contract 大尺寸。 */}
                <Waveform analyser={waveAnalyser} active={waveActive} variant={waveVariant} color={waveColor} />
              </>
            )}
            {phase === 'ended' && (
              <div className="stage-msg stage-ended">
                <div className="stage-ended-icon" aria-hidden="true">✓</div>
                <div>
                  {isCandidate ? t('exam_ended_candidate') : t('exam_ended_msg')}
                  {endReason ? `(${endReason})` : ''}
                </div>
              </div>
            )}
            {phase === 'failed' && (
              <div className="stage-msg stage-failed">{t('exam_st_failed')}</div>
            )}
          </div>
        </div>

        {/* 右侧 transcript 面板(常驻可折叠;折叠时仍在 DOM,保 role=log aria-live 活——design contract review)。
            折叠切换按钮移到控制条(见 .stage-bar):折叠后面板 pointer-events:none,按钮若留在面板头则点不到、
            无法再展开(真机 e2e 抓到的可用性缺陷)。
            design contract:showSubtitles=false 时**整块不渲染**(不只是 CSS 隐藏)——无字幕态显示任何转写文本无意义。
            注:transcript 帧仍到达并更新 msgs state(onTranscript 回调零改动),仅此处不渲染 DOM(用户不可见)。 */}
        {showSubtitles && (
          <div className="stage-panel">
            <div className="stage-panel-head">
              <span className="sp-title">{t('exam_transcript_title')}</span>
            </div>
            <div className="transcript" ref={transcriptElRef} onScroll={onTranscriptScroll} role="log" aria-live="polite" aria-relevant="additions">
              {msgs.length === 0 && !partialText ? (
                <div className="empty-state">{t('exam_empty')}</div>
              ) : (
                <>
                  {msgs.map((m, i) => (
                    // key 优先用 seq(design contract:稳定 id,修正帧原地更新不重挂);缺省回退下标(旧服务端向后兼容)。
                    <div key={m.seq ?? `i${i}`} className={'bubble ' + (m.role === 'ai' ? 'b-ai' : 'b-human')}>
                      <div className="who">{m.role === 'ai' ? t('exam_speaker_ai') : t('exam_speaker_me')}</div>
                      {m.text}
                    </div>
                  ))}
                  {/* 识别中临时气泡:灰色、跟随 partial 实时更新,定稿后被清空并转为正式气泡 */}
                  {partialText && (
                    <div className="bubble b-human bubble-partial" aria-label={t('exam_recognizing')}>
                      <div className="who">{t('exam_speaker_me')} · {t('exam_recognizing')}</div>
                      {partialText}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 底部 Teams 式控制条:操作按钮(按 phase,onClick 一律不改)+ 实时状态(保 role=status aria-live)。 */}
        <div className="stage-bar">
          <div className="bar-actions">
            {phase === 'connecting' && (
              <button className="btn" disabled>
                {t('loading')}
              </button>
            )}
            {(phase === 'live' || phase === 'ending') && (
              <button className="btn btn-danger" onClick={endExam} disabled={phase === 'ending'}>
                <span aria-hidden="true">■ </span>
                {phase === 'ending' ? t('exam_ending_btn') : t('exam_end')}
              </button>
            )}
            {phase === 'failed' && (
              <button className="btn btn-primary" onClick={retry}>
                {t('exam_retry')}
              </button>
            )}
            {phase === 'ended' && !isCandidate && (
              <>
                {/* 评测就绪前(pending):按钮禁用显「正在生成评测结果…」(带小 spinner);就绪(ready/none)才可点
                    ——避免「结果没生成就能点、点进报错」。none(会话失败/异常)仍放行,进报告页看具体失败状态。 */}
                <button
                  className="btn btn-primary"
                  onClick={gotoReport}
                  disabled={reportStatus === 'pending'}
                  aria-busy={reportStatus === 'pending'}
                >
                  {reportStatus === 'pending' ? (
                    <>
                      <span className="btn-spinner" aria-hidden="true" />
                      {t('exam_report_generating')}
                    </>
                  ) : (
                    t('exam_view_report')
                  )}
                </button>
                <button className="btn" onClick={backHome}>
                  {t('back')}
                </button>
              </>
            )}
          </div>
          <div className="bar-status">
            {/* live 期实时反馈:唯一带 role=status aria-live 的元素(舞台大字 aria-hidden),状态切换自动播报。 */}
            {phase === 'live' ? (
              aiSpeaking ? (
                <span className="live-cue cue-ai" role="status" aria-live="polite" aria-atomic="true">
                  <span className="wave" aria-hidden="true">
                    <span /><span /><span /><span />
                  </span>
                  {t('exam_ai_speaking')}
                </span>
              ) : (
                <span className="live-cue cue-listen" role="status" aria-live="polite" aria-atomic="true">
                  <span className="mic-pulse" aria-hidden="true">🎙</span>
                  {t('exam_listening')}
                </span>
              )
            ) : (
              <span className="bar-phase" role="status" aria-live="polite" aria-atomic="true">
                {t('status')}:{' '}
                <b>{phaseLabel[phase]}</b>
              </span>
            )}
          </div>
          {/* 折叠切换(移到控制条:折叠后面板 pointer-events:none,按钮留面板内则点不到无法再展开;真机 e2e 抓到)。
              窄屏堆叠折叠无意义 → CSS 隐藏(.sp-toggle 窄屏 display:none)。
              design contract:无字幕态无 transcript 面板可折叠 → 不渲染此按钮。 */}
          {showSubtitles && (
            <button
              className="btn btn-ghost sp-toggle"
              onClick={togglePanel}
              aria-expanded={!panelCollapsed}
              title={panelCollapsed ? t('exam_panel_expand') : t('exam_panel_collapse')}
            >
              {panelCollapsed ? t('exam_panel_expand') : t('exam_panel_collapse')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
