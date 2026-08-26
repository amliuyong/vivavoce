"""GPU 服务 FastAPI app —— WS 端点 + readiness/liveness 探针(design contract)。

健康检查区分(design contract):
  - /healthz  liveness:进程存活/端口可接(恒 200)
  - /readyz   readiness:ASR/TTS 模型加载完 + 轻量 self-probe 通过才 200
ECS container healthCheck / 服务发现以 readyz 为准 —— 未 ready 不接客。

WS /v1/stream:承载一通会话的 ASR/TTS(LLM 不在此,见 014)。
  收 text 控制帧 + 紧跟 binary PCM(audio_meta→PCM / tts_text);产出下行 meta+PCM。
"""
from __future__ import annotations

import asyncio
import logging
import os as _os_top
import time
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from starlette.websockets import WebSocketState

from . import protocol as P
from .asr_execution import (
    AsrExecutionTimeout,
    DedicatedAsrExecution,
    InlineAsrExecution,
)
from .engines import make_asr, make_speaker_embedder, make_tts
from .runtime_info import runtime_info
from .session import OutFrame, SessionOrchestrator

logger = logging.getLogger(__name__)

_ASR_RUN_KINDS = {
    "20ms-sync": ("inline", 20),
    "600ms-sync": ("inline", 600),
    "600ms-dedicated-thread": ("dedicated", 600),
}
_TTS_ASR_HANDOFF_GRACE_S = 0.02

# 声纹 embedding 最小时长门(design contract review):短音频 verification EER 退化 → 拒短窗(bridge fail-open)。
#   默认 400ms(与 bridge AIM_SPEAKER_LOCK_MIN_VERIFY_MS 默认呼应);env AIM_EMBEDDING_MIN_MS 可调。
_EMBED_MIN_FRAMES = P.ASR_SAMPLE_RATE * int(_os_top.getenv("AIM_EMBEDDING_MIN_MS", "400")) // 1000


def _configure_logging() -> None:
    """给 gpu_service 顶层 logger 挂 stdout handler + level(可观测性,真机定位卡死靠它)。

    根因(此前缺这个):minimax_tts/engines/minimax_config 用 logging,但 GPU 服务从不配 handler →
    info 走 Python lastResort(只 WARNING+ 到 stderr)被吞、warning 也无结构 → 真机出问题(如「说一会就哑」)
    看不到 MiniMax 是否失败/是否回退。这里把 gpu_service.* 统一到 stdout(CloudWatch 捕获),
    级别 env AIM_GPU_LOG_LEVEL 可调(默认 INFO);propagate=False 避免与 uvicorn root 重复。"""
    level = getattr(logging, _os_top.getenv("AIM_GPU_LOG_LEVEL", "INFO").upper(), logging.INFO)
    lg = logging.getLogger("gpu_service")
    lg.setLevel(level)
    if not lg.handlers:
        h = logging.StreamHandler()  # stdout/stderr → CloudWatch
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        lg.addHandler(h)
    lg.propagate = False


class ReadinessState:
    """模型加载状态。真实后端在后台线程加载完(数 GB 权重上显存,数十秒~分钟)才置 ready;
    加载期间 /readyz 返回 503,ECS healthCheck / 服务发现据此不路由流量到未就绪 task(review)。
    后台线程写、主线程(/readyz)读,用锁保证可见性 + ready 多字段读的一致性。"""

    def __init__(self) -> None:
        import threading

        self._lock = threading.Lock()
        self.models_loaded = False
        self.self_probe_ok = False
        self.load_error: str | None = None

    def mark(self, *, models_loaded: bool, self_probe_ok: bool, load_error: str | None) -> None:
        with self._lock:
            self.models_loaded = models_loaded
            self.self_probe_ok = self_probe_ok
            self.load_error = load_error

    @property
    def ready(self) -> bool:
        with self._lock:
            return self.models_loaded and self.self_probe_ok


def _self_probe() -> bool:
    """真 self-probe:实例化引擎 + 跑一次 ASR/TTS,确认管线可用。

    关键副作用(焐热):make_asr()/make_tts() 内部走进程级单例(lru_cache),首次调用即把数 GB 权重
    加载进显存并缓存。所以 self-probe 通过 = 模型已加载并焐热;之后每通 WS 会话 new 引擎只命中缓存
    (持有共享模型引用 + 自己的会话 cache),不重载。readiness=ready 真实反映"模型已就绪可接客"。

    ★ TTS 焐热**每个** voice key × **每种参考音语言** 的 voice clone(review):
      VoiceClonePrompt 按 (参考音 wav, ref_text) 进程级缓存,只焐热默认音色 → 首通用 male_std 的会话首句仍要现编码
      (数百 ms),且 male_std 参考音若缺失(漏 checkin / Dockerfile COPY 漏)只会在那通会话才崩。
      故遍历 KNOWN_VOICE_KEYS × {中文, 英文} 各合成一次:① 每音色每语言首句都不延迟(修「英文首句现编码
      英文参考音」);② 任一音色/语言资产缺失都在 readyz 阶段 fail-fast(self-probe False → 永不 ready),
      不拖到真实会话。中/英焐热靠合成句本身的语种(auto 逐句检测据文本选参考音,见 _detect_text_lang)。
    """
    from .funasr_backend import KNOWN_VOICE_KEYS  # noqa: PLC0415

    asr = make_asr()
    asr.transcribe_chunk(b"\x00\x00" * 160)
    _ = asr.finalize()
    ok = True
    # stub 后端 KNOWN_VOICE_KEYS 仍存在(funasr_backend 模块级常量),stub TTS 忽略 voice/language、各 key 行为一致;
    # 真实后端逐 key × 逐语言焐热各自参考音的 clone prompt。任一组合合成不出音 → self-probe 失败。
    # language="auto":OmniVoice 逐句按文本检测选中/英参考音 → 中文句焐中文参考音、英文句焐英文参考音(en 母语)。
    # ★ 只焐热 OmniVoice/ASR(决定 /readyz);**不真调 MiniMax probe**(默认 TTS 后端是 OmniVoice,
    #   minimax 是 per-session 选的;且 design contract ASG min=0/max=8 频繁起停,启动即真调 MiniMax 会烧额度)。
    #   MiniMax 校验抽到 minimax_probe(),仅热加载(/reload-tts-config)触发;失败不拖垮 /readyz(design contract)。
    for voice_key in KNOWN_VOICE_KEYS:
        tts = make_tts(voice_key, language="auto")  # 每个 voice_key 用一个 auto 引擎,逐句检测焐其中英两套参考音
        for probe_text in ("测试", "hello"):
            chunks = list(tts.synthesize(probe_text))
            ok = ok and len(chunks) > 0
    return ok


def minimax_probe() -> dict:
    """MiniMax 凭据 self-probe(design contract):对各已知 voice key 试合成一次,识别
    key 错误 / 网络不通 / voice_id 非法 / 参数错配。返回校验回执(供热加载即时告知 admin)。

    ★ 默认只在热加载(/reload-tts-config)时触发,**不在 GPU 启动时默认跑**(避免 design contract autoscaling
      额度放大);每次 probe 真调云端,按 extra_info.usage_characters 计费(每 voice key 合成一短句,
      字符极少 —— 见部署文档额度提示)。失败只标记 minimax 不可用、**不拖垮整体 /readyz**(OmniVoice 决定 readiness)。
    """
    from .funasr_backend import KNOWN_VOICE_KEYS  # noqa: PLC0415
    from .minimax_config import reload_minimax_config  # noqa: PLC0415
    from .minimax_tts import MiniMaxTts  # noqa: PLC0415
    from .voice_lang import lang_key  # noqa: PLC0415

    cfg = reload_minimax_config()  # 先重读 Secret(原子替换),再用新配置探测
    if not cfg.enabled:
        return {"ok": False, "enabled": False, "detail": "MiniMax 未启用(enabled=false)"}
    if not cfg.has_key:
        return {"ok": False, "enabled": True, "detail": "MiniMax 已启用但未配置 API key"}
    # 探针清单:每个 voice key 验中文音色(裸键);若配了英文特化键(<key>.en)则**额外验英文音色**
    # ——英文 voice_id 非法此前只在真实英文会话才 2013 失败,probe 期一并验(review)。
    # (probe_key 作展示键;base_key 传给 MiniMaxTts,lang 决定解析哪个 voice_id + language_boost。)
    probes: list[tuple[str, str, str | None, str]] = []
    for voice_key in KNOWN_VOICE_KEYS:
        probes.append((voice_key, voice_key, None, "测试"))          # 中文音色
        if lang_key(voice_key, "en") in cfg.voice_map:
            probes.append((f"{voice_key}.en", voice_key, "en", "test"))  # 英文音色(仅在配了英文键时)
    per_voice: dict[str, str] = {}
    ok = True
    for probe_key, base_key, lang, text in probes:
        try:
            chunks = list(MiniMaxTts(base_key, lang, config=cfg).synthesize(text))
            if chunks:
                per_voice[probe_key] = "ok"
            else:
                per_voice[probe_key] = "空音频"
                ok = False
        except Exception as exc:  # noqa: BLE001 — probe 失败只标记不可用,不抛
            per_voice[probe_key] = str(exc)
            ok = False
    return {"ok": ok, "enabled": True, "has_key": True,
            "detail": "校验通过" if ok else "key/voice_id 校验失败", "per_voice": per_voice}


def require_drain_secret(request: Request) -> JSONResponse | None:
    """`X-Drain-Secret` fail-closed 鉴权(design contract:抽共享 helper 统一三处)。

    统一 `/drain`、`/reload-tts-config`、`/config` 的鉴权姿态,**沿用现网契约**:

    * env `AIM_DRAIN_SECRET` 未配 → **503**(端点禁用;区分「没开功能」与「没权限」)
    * 头缺失 / 不匹配 → **401**(**非** 403,与现网一致)
    * 通过 → 返回 ``None``

    常量时间比对(`hmac.compare_digest`)防时序侧信道。返回 JSONResponse 而非抛
    HTTPException:三处原实现里 503 走 JSONResponse、401 走 HTTPException 不一致,
    统一成前者以便调用点写法一致(HTTP 语义与状态码逐字节不变)。
    """
    import hmac

    secret = _os_top.getenv("AIM_DRAIN_SECRET", "")
    if not secret:
        return JSONResponse(status_code=503,
                            content={"detail": "端点未启用(AIM_DRAIN_SECRET 未配置)"})
    provided = request.headers.get("X-Drain-Secret", "")
    if not hmac.compare_digest(provided, secret):
        return JSONResponse(status_code=401, content={"detail": "X-Drain-Secret 不匹配"})
    return None


def create_app(*, asr_run_kind: str = "600ms-dedicated-thread") -> FastAPI:
    _configure_logging()
    if asr_run_kind not in _ASR_RUN_KINDS:
        raise ValueError(f"未知 ASR run kind: {asr_run_kind}")
    execution_mode, asr_chunk_ms = _ASR_RUN_KINDS[asr_run_kind]

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        st: ReadinessState = app.state.readiness

        import os

        def _load() -> None:
            try:
                ok = _self_probe()
                st.mark(models_loaded=True, self_probe_ok=ok, load_error=None)
            except Exception as exc:  # noqa: BLE001
                st.mark(models_loaded=False, self_probe_ok=False, load_error=str(exc))
            # 声纹 embedder(design contract):**独立加载,失败绝不影响 readiness**(上面 st.mark 已定 /readyz)。
            #   仅当配置了 AIM_EMBEDDING_SECRET(=启用声纹门)才加载,省去无谓显存;加载 + 一次 self-embed 焐热,
            #   任一步失败 → embedder 保持 None → /embedding 返 503 → bridge UNCERTAIN fail-open(不误聋目标人)。
            if _os.getenv("AIM_EMBEDDING_SECRET", ""):
                try:
                    emb = make_speaker_embedder()
                    emb.embed(b"\x00\x00" * 1600)  # 焐热(0.1s 静音,只验管线可跑,不校验语义)
                    app.state.speaker_embedder = emb
                    print("[startup] 声纹 embedder(CAM++)已加载焐热(design contract)", flush=True)
                except Exception as exc:  # noqa: BLE001
                    app.state.speaker_embedder = None
                    print(f"[startup] 声纹 embedder 加载失败(不影响 /readyz,声纹门将 fail-open): {exc}", flush=True)
            # ★ 预热 MiniMax 配置(review):在此后台线程里先读一次 Secret 焐热进程内 _current,
            #   使首个 minimax 会话在 WS 事件循环上 new SessionOrchestrator 时直接命中、**不触发同步 Secret 读**
            #   (否则 SM 抖动会冻结整个 GPU 异步服务)。只读不 probe(不真调云端、不烧额度);失败只记日志,
            #   不影响 /readyz(minimax 会话届时走 error 降级)。
            try:
                from .minimax_config import preload_minimax_config  # noqa: PLC0415
                cfg = preload_minimax_config()
                print(f"[startup] MiniMax 配置预热: enabled={cfg.enabled} has_key={cfg.has_key}", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"[startup] MiniMax 配置预热失败(不影响 readyz,首会话惰性重试): {exc}", flush=True)
            # 可显式开启的启动 MiniMax probe(默认关,design contract:开启者自担额度)。
            # 失败/异常**绝不影响 /readyz**(只记日志);默认靠直读同一已校验 Secret 即可服务 minimax 会话。
            if _os.getenv("AIM_MINIMAX_STARTUP_PROBE", "") in ("1", "true", "True"):
                try:
                    res = minimax_probe()
                    app.state.minimax_probe = res
                    print(f"[startup] MiniMax probe(显式开启): {res.get('detail')}", flush=True)
                except Exception as exc:  # noqa: BLE001
                    print(f"[startup] MiniMax probe 异常(不影响 readyz): {exc}", flush=True)

        backend = os.getenv("AIM_GPU_BACKEND", "stub")
        if backend == "stub":
            # ★ 防呆(用户 review):stub = 假语音(正弦波 + 假 ASR 文本 "[一轮语音 X.Xs]"),
            #   链路"机械上通"但**不是真识别/真合成**。醒目警告,避免误把假语音当生产跑通。
            print("=" * 70, flush=True)
            print("⚠  AIM_GPU_BACKEND=stub —— STUB MODE(假语音:正弦波 TTS + 假 ASR 文本)", flush=True)
            print("⚠  这不是真实模型!要真识别/真合成需用真实镜像(AIM_GPU_BACKEND=funasr)。", flush=True)
            print("=" * 70, flush=True)
            # stub 无重模型,同步立即就绪(本地/CI/快验 WS e2e 不需等)
            _load()
        else:
            # 真实模型:后台线程加载(数 GB 上显存),不阻塞 startup;加载完才 ready
            import threading

            print(f"[startup] AIM_GPU_BACKEND={backend} —— 真实模型加载中(后台线程)...", flush=True)
            threading.Thread(target=_load, daemon=True).start()

        # task protection 周期续租(design contract):active>0 期间每 N 分钟续到 now+MAX_DRAIN,
        # 防 expiresInMinutes 在长会话中途过期(否则第 50min 进来的会话只被保护 10min)。
        renew_min = max(1, int(_os.getenv("AIM_GPU_PROTECT_RENEW_MIN", "10")))

        async def _renew_loop() -> None:
            while True:
                await asyncio.sleep(renew_min * 60)
                if app.state.active_sessions > 0:
                    try:
                        await asyncio.get_running_loop().run_in_executor(
                            None, app.state.task_protection.set, True)
                    except Exception:  # noqa: BLE001 — 续租 best-effort
                        pass

        renew_task = asyncio.create_task(_renew_loop())
        lag_interval_s = 0.05

        async def _event_loop_lag_loop() -> None:
            expected = time.monotonic() + lag_interval_s
            while True:
                await asyncio.sleep(max(0.0, expected - time.monotonic()))
                now = time.monotonic()
                app.state.asr_execution.metrics.observe_event_loop_lag(
                    max(0.0, (now - expected) * 1000)
                )
                expected = now + lag_interval_s

        lag_task = asyncio.create_task(_event_loop_lag_loop())
        try:
            yield
        finally:
            renew_task.cancel()
            lag_task.cancel()
            with suppress(asyncio.CancelledError):
                await renew_task
            with suppress(asyncio.CancelledError):
                await lag_task
            await app.state.asr_execution.shutdown()

    app = FastAPI(title="AIM GPU Inference", version="0.1.0", lifespan=lifespan)
    app.state.readiness = ReadinessState()
    app.state.asr_execution = (
        InlineAsrExecution()
        if execution_mode == "inline"
        else DedicatedAsrExecution()
    )
    app.state.asr_run_kind = asr_run_kind
    app.state.asr_chunk_ms = asr_chunk_ms
    # ── 单实例并发 admission 闸门(design contract):GPU 一台只能服务有限路 ASR+TTS,超了必须**拒绝**
    #    而非接下来打爆显存/拖垮所有通话。活跃会话计数 + 上限;满了对 start 回 CAPACITY_FULL 并关连接。
    #    上限默认 = GPU_SESSIONS_PER_INSTANCE(与控制面全局闸门 max_concurrency 对齐,见 constants.ts §4.2/4.3);
    #    可经 env AIM_GPU_MAX_SESSIONS 覆盖。计数在事件循环单线程内增减、无需锁,**但 check-and-increment
    #    必须原子**(中间不得 await:否则冷启动多通并发在 await 处让出 → 都过 `>= max` 检查 → 超派;
    #    真机压测暴露,见 start 分支「先占名额」注释)。
    import os as _os

    app.state.active_sessions = 0
    # 默认 3 = 实测算力上界(g6e/L40S,含 ASR+TTS 并发留 buffer;见 constants.ts GPU_SESSIONS_PER_INSTANCE 注释)。
    # CDK 部署时经 AIM_GPU_MAX_SESSIONS 显式注入 = GPU_SESSIONS_PER_INSTANCE,两边一致。
    app.state.gpu_max_sessions = int(_os.getenv("AIM_GPU_MAX_SESSIONS", "3"))
    # drain 标志(design contract):收到缩容/停机 drain 信令后置 True → 拒新 start(回 CAPACITY_FULL)但服务在途。
    app.state.draining = False
    # MiniMax 最近一次 self-probe 回执(design contract:热加载/启动 probe 写,供观测;不影响 /readyz)。
    app.state.minimax_probe = None
    # 声纹 embedder(design contract):启动时加载(见 lifespan _load);加载失败 → None → /embedding 返 503 → bridge fail-open。
    # **与核心 ASR/TTS readiness 解耦**:CAM++ 挂了不影响 /readyz(声纹门可 fail-open,ASR/TTS 照常服务)。
    app.state.speaker_embedder = None
    # /embedding 有界并发(review):与 TTS 争 GPU/线程池,信号量限并发,满则 503(bridge fail-open),不堆积。
    app.state.embedding_sem = asyncio.Semaphore(int(_os.getenv("AIM_EMBEDDING_MAX_INFLIGHT", "2")))
    # ECS task scale-in protection(design contract High #2):会话期保护本 task 不被 ECS scale-in/部署
    # 中途停止。非 ECS 环境(本地/CI)自动 no-op。
    from .task_protection import TaskProtection
    app.state.task_protection = TaskProtection()

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "alive"}

    @app.get("/metrics")
    def metrics() -> dict:
        """本实例用量(design contract,私网):供 reconciler 求和算容量、backend 代理给前端看逐实例。

        注:active/max 在事件循环单线程增减(无需锁)。utilization = active/max(max=0 时 0)。
        """
        active = int(app.state.active_sessions)
        mx = int(app.state.gpu_max_sessions)
        st: ReadinessState = app.state.readiness
        return {
            "active_sessions": active,
            "max_sessions": mx,
            "utilization": (active / mx) if mx > 0 else 0.0,
            "backend": _os.getenv("AIM_GPU_BACKEND", "stub"),
            "ready": bool(st.ready),
            "draining": bool(app.state.draining),
            "asr_run_kind": app.state.asr_run_kind,
            "asr_chunk_ms": app.state.asr_chunk_ms,
            "asr": app.state.asr_execution.metrics.snapshot(),
            "runtime": runtime_info(),
        }

    @app.post("/drain")
    def drain(request: Request, on: bool = True) -> dict:
        """缩容前置 drain 信令(design contract,私网)。

        置 draining 后**拒新 start 但继续服务在途**(进程不退,与 SIGTERM 退出不同)—— 这是"还想用
        app 内 draining 逻辑拒新、又保在途"的唯一有效窗口(review
        太晚)。reconciler/lifecycle 缩容选中某实例时 POST /drain 让其退出接客;实例终止仍由 ECS task
        protection + ASG lifecycle hook 保证在途不腰斩。on=false 可撤销。

        ★ 鉴权(review + D9):/drain **改状态**,不能像 /metrics 那样纯靠 SG。
        fail-closed —— env `AIM_DRAIN_SECRET` 未配则端点禁用(503),配了则须 `X-Drain-Secret` 头匹配
        (常量时间比对),否则 401。避免同 VPC 任意进程(含媒体面被入侵)滥调把 GPU 永久标 drain。
        """
        # design contract:鉴权收口到共享 helper(三处同姿态:未配 503 / 不匹配 401,常量时间比对)
        denied = require_drain_secret(request)
        if denied is not None:
            return denied
        app.state.draining = bool(on)
        return {"draining": bool(app.state.draining)}

    @app.post("/reload-tts-config")
    def reload_tts_config(request: Request) -> dict:
        """MiniMax 配置热加载端点(design contract,私网,fail-closed)。

        backend 的 PUT /api/admin/tts-config 写完 Secret 后 best-effort 调此端点:
          重读 Secret → **原子替换**进程内 MiniMax 配置(在途会话不受影响)→ 重跑 MiniMax self-probe →
          回执返回 key 是否有效(backend 据此告知前端"已生效"/"key 无效",admin 即时看到,不拖到通话中)。

        ★ 鉴权(复用 /drain 的共享密钥模式 + D9):**改状态/真调云端**,不能纯靠 SG。fail-closed ——
          env `AIM_DRAIN_SECRET` 未配则端点禁用(503,与 /drain 同密钥);配了须 `X-Drain-Secret` 头匹配
          (常量时间比对),否则 401。避免同 VPC 任意进程滥调烧额度/刷配置。

        ★ 整体 /readyz 不受 MiniMax probe 结果影响(默认 OmniVoice 决定 readiness,design contract)。
        """
        # design contract:鉴权收口到共享 helper(与 /drain·/config 同姿态)
        denied = require_drain_secret(request)
        if denied is not None:
            return denied
        # 重读 Secret + 原子替换 + 重跑 MiniMax probe(probe 内部已先 reload_minimax_config)。
        result = minimax_probe()
        app.state.minimax_probe = result
        return result

    @app.get("/config")
    def read_config(request: Request) -> Any:
        """只读运行时诊断配置(design contract)——返回本进程 ``AIM_*`` 的**实际生效值** + 内建默认。

        鉴权:复用 ``/drain``·``/reload-tts-config`` 的 ``X-Drain-Secret`` 共享密钥
        (未配 **503** / 不匹配 **401**,与现网契约一致,**非** 403)。

        ★ 红线(GPU task role:无 DDB、无 Bedrock):本端点**只读进程内已解析的 env 快照** ——
          MUST NOT 触发模型加载、MUST NOT 改 readiness、MUST NOT 新增任何 boto3/DDB/Bedrock 调用,
          故**不需要任何新 IAM 权限**。

        ★ secret 类 key **完全不进载荷**(不是脱敏,是根本不出现,见 runtime_config.EXCLUDED_KEYS)——
          控制面的脱敏保护不了本端点自身的调用者。

        ★ 响应带 ``schema_version`` 信封 + **实例标识**:GPU 可 0–8 实例,控制面只命中 Cloud Map
          返回的一台 → 聚合侧据此标 ``scope: sampled_instance``,不冒充「集群统一生效值」。
        """
        denied = require_drain_secret(request)
        if denied is not None:
            return denied
        # ★ 用**冻结快照**(非 load_gpu_config()):业务模块在导入时就固定了 env 解析结果,
        #   端点若重解析会报出业务并未在用的值(review 实证)。
        from .runtime_config import CONFIG_SCHEMA_VERSION, get_frozen_config

        return {
            "schema_version": CONFIG_SCHEMA_VERSION,
            "source": "gpu",
            # 采样语义:这是**单实例**快照,非集群一致性视图
            "instance": {
                # ECS task ARN 尾段(无 ECS 元数据时为空串);仅标识"哪一台",不含敏感信息
                "task": _os.getenv("ECS_CONTAINER_METADATA_URI_V4", "").rsplit("/", 1)[-1],
                "backend": _os.getenv("AIM_GPU_BACKEND", "stub"),
                "image_tag": _os.getenv("AIM_GPU_IMAGE_TAG", ""),
            },
            "entries": [e.as_dict() for e in get_frozen_config()],
        }

    @app.get("/readyz")
    def readyz():
        import os
        st: ReadinessState = app.state.readiness
        backend = os.getenv("AIM_GPU_BACKEND", "stub")
        if st.ready:
            # 防呆:标注 backend + real_audio,任何人查健康即知是真模型还是 stub 假语音
            return {"status": "ready", "asr": True, "tts": True,
                    "backend": backend, "real_audio": backend != "stub"}
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=503, content={"status": "loading", "backend": backend})

    @app.post("/embedding")
    async def embedding(request: Request):
        """声纹 embedding 原语(design contract,私网,fail-closed)。

        入:{"pcm_base64": <16k mono s16le>, "sample_rate": 16000}  出:{"embedding": [192 floats], ...}
        **无状态**:只算向量,不持有/比对参考声纹(注册/门控/cosine 全在 bridge)。

        ★ 鉴权(D9,复用 /drain fail-closed 家族):env `AIM_EMBEDDING_SECRET` 未配 → 端点禁用(503),
          配了须 `X-Embedding-Secret` 头匹配(常量时间比对),否则 401。避免同 VPC 任意负载白嫖 GPU 触发 bridge fail-open。
        ★ 加载失败/异常:返错误码(非 200),**绝不拖垮 /readyz**;bridge 据此 UNCERTAIN fail-open。
        """
        import base64
        import hmac

        from fastapi.responses import JSONResponse

        secret = _os.getenv("AIM_EMBEDDING_SECRET", "")
        if not secret:
            return JSONResponse(status_code=503,
                                content={"error": "embedding 未启用(AIM_EMBEDDING_SECRET 未配置)"})
        provided = request.headers.get("X-Embedding-Secret", "")
        if not hmac.compare_digest(provided, secret):
            return JSONResponse(status_code=401, content={"error": "X-Embedding-Secret 不匹配"})
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return JSONResponse(status_code=400, content={"error": "请求体非合法 JSON"})
        if not isinstance(body, dict):
            return JSONResponse(status_code=400, content={"error": "请求体必须是 JSON 对象"})
        sr = body.get("sample_rate", P.ASR_SAMPLE_RATE)
        if sr != P.ASR_SAMPLE_RATE:  # 只收 16k(与 ASR 上行同;避免误传别的率被当 16k 算错 embedding)
            return JSONResponse(status_code=400,
                                content={"error": f"sample_rate 须 {P.ASR_SAMPLE_RATE},收到 {sr}"})
        b64 = body.get("pcm_base64")
        if not isinstance(b64, str) or not b64:
            return JSONResponse(status_code=400, content={"error": "缺少 pcm_base64"})
        # review 解码**前**先卡编码长度(base64 膨胀 ~4/3),防超大体在解码时先吃满内存。
        if len(b64) > (P.MAX_EMBED_PCM_BYTES * 4) // 3 + 4:
            return JSONResponse(status_code=413,
                                content={"error": f"pcm_base64 过大 {len(b64)}"})
        try:
            pcm = base64.b64decode(b64, validate=True)
        except Exception:  # noqa: BLE001
            return JSONResponse(status_code=400, content={"error": "pcm_base64 解码失败"})
        if len(pcm) == 0 or len(pcm) % P.SAMPLE_WIDTH_BYTES != 0:
            return JSONResponse(status_code=400, content={"error": "PCM 为空或非 s16le 对齐"})
        if len(pcm) > P.MAX_EMBED_PCM_BYTES:
            return JSONResponse(status_code=413,
                                content={"error": f"PCM 过大 {len(pcm)} > {P.MAX_EMBED_PCM_BYTES}"})
        # review:最小时长门(短音频 verification EER 退化 → GPU 侧也强制拒,与 bridge minVerifyMs 呼应,
        #   防端点被绕过直接喂短窗)。frames/16000 秒 < 下限 → 400,bridge 据此 UNCERTAIN fail-open。
        frames = len(pcm) // P.SAMPLE_WIDTH_BYTES
        if frames < _EMBED_MIN_FRAMES:
            return JSONResponse(status_code=400,
                                content={"error": f"音频过短 {frames} frames < {_EMBED_MIN_FRAMES}(短窗 EER 退化)"})
        embedder = app.state.speaker_embedder
        if embedder is None:  # 未加载成功(真实后端加载失败)→ bridge fail-open
            return JSONResponse(status_code=503, content={"error": "声纹模型不可用"})
        # review:有界并发 —— /embedding 与 TTS 争同一 GPU/线程池,无上限会拖垮 ASR/TTS。**非阻塞**获取
        #   信号量(locked() 判满),满则快速 503(bridge fail-open),不排队堆积。
        sem: asyncio.Semaphore = app.state.embedding_sem
        if sem.locked():  # 已达上限(value 归 0)→ 快速 503,不排队
            return JSONResponse(status_code=503, content={"error": "embedding 并发已满,请稍后"})
        acquired = False
        try:
            await sem.acquire()  # 上面 locked() 已判非满,这里立即拿到(单事件循环,无中间 await 让出)
            acquired = True
        except Exception:  # noqa: BLE001
            return JSONResponse(status_code=503, content={"error": "embedding 并发获取失败"})
        try:
            import time as _t
            t0 = _t.monotonic()
            # 前向可能是阻塞 GPU 调用 → 丢线程池,不卡事件循环(与 _run_tts 同款)
            emb = await asyncio.get_running_loop().run_in_executor(None, embedder.embed, pcm)
            dur_ms = int((_t.monotonic() - t0) * 1000)
        except Exception as exc:  # noqa: BLE001 — embedding 失败不崩服务,bridge fail-open
            return JSONResponse(status_code=500, content={"error": f"embedding 失败: {exc}"})
        finally:
            if acquired:
                sem.release()
        return {"embedding": emb, "dim": len(emb), "frames": frames, "duration_ms": dur_ms}

    async def _send(
        ws: WebSocket,
        frame: OutFrame,
        send_lock: asyncio.Lock,
        guard: Callable[[], bool] | None = None,
        before_send: Callable[[], None] | None = None,
    ) -> bool:
        async with send_lock:
            if guard is not None and not guard():
                return False
            if before_send is not None:
                before_send()
            await ws.send_text(frame.control.to_json())
            if frame.pcm is not None:
                await ws.send_bytes(frame.pcm)
            return True

    async def _run_tts(
        ws: WebSocket,
        orch: SessionOrchestrator,
        text: str,
        send_lock: asyncio.Lock,
        epoch: int | None = None,
        ai_turn_id: int | None = None,
        segment_id: int | None = None,
        concurrency: int = 1,
    ) -> None:
        """后台 TTS 任务:逐块合成并发送。同步生成器在线程池逐项取出,避免卡事件循环;
        每块前检查 orch._cancelled(由主循环收到 cancel 时即时置位),实现真·可打断 barge-in。
        epoch = 该句入队时的 cancel 代际(见 _tts_consumer):代际已变 → on_tts_text 整句丢弃。

        单句合成失败(如 OmniVoice 对某文本抛错):上报 error 但**不中断整轮** —— 仍补发 tts_done,
        让上层计数自洽(否则后端 tts_pending 泄漏 → turn_complete 不发 → 麦克风卡死,review)。
        on_tts_text 正常结束已自带 tts_done;失败路径在 finally 兜底补一个(用 emitted 标志防重复)。"""
        loop = asyncio.get_running_loop()
        sentinel = object()
        done_emitted = False
        metrics_emitted = False
        failed = False
        provider_started_at: float | None = None
        generation_wall_s = 0.0
        generated_bytes = 0
        first_send_at: float | None = None
        last_compute_at: float | None = None
        last_send_at: float | None = None
        initial_provider = orch.tts_provider_name()
        initial_cache_state = orch.tts_cache_state(text)

        def _note_provider_start(at: float) -> None:
            nonlocal provider_started_at
            if provider_started_at is None:
                provider_started_at = at

        def _note_model_compute(at: float) -> None:
            nonlocal last_compute_at
            last_compute_at = at

        def _note_first_send() -> None:
            nonlocal first_send_at
            if first_send_at is None:
                first_send_at = time.monotonic()

        gen = orch.on_tts_text(
            text,
            epoch,
            ai_turn_id=ai_turn_id,
            segment_id=segment_id,
            on_provider_start=_note_provider_start,
            on_model_compute=_note_model_compute,
        )

        def _metric_frame() -> OutFrame | None:
            started_at = provider_started_at
            if ai_turn_id is None or segment_id is None or started_at is None:
                return None
            audio_ms = (generated_bytes / P.SAMPLE_WIDTH_BYTES / P.TTS_SAMPLE_RATE) * 1000
            generation_ms = generation_wall_s * 1000
            cancel_at = orch.cancellation_at(epoch)
            provider = orch.tts_provider_name()
            # FallbackTts selects its real provider inside synthesize(). Preserve
            # the pre-generation cache observation for a stable provider, but
            # refresh it when fallback changed the provider.
            cache_state = (
                orch.tts_cache_state(text)
                if provider != initial_provider
                else initial_cache_state
            )
            return OutFrame(P.tts_metrics(
                orch.session_id,
                ai_turn_id=ai_turn_id,
                segment_id=segment_id,
                tts_provider=provider,
                provider_start_to_first_send_ms=(
                    (first_send_at - started_at) * 1000
                    if first_send_at is not None
                    else None
                ),
                generation_wall_time_ms=generation_ms,
                generated_audio_duration_ms=audio_ms,
                rtf=(generation_ms / audio_ms) if audio_ms > 0 else None,
                cache_state=cache_state,
                concurrency=max(1, concurrency),
                model_first_chunk_unavailable_reason="provider_does_not_expose_model_first_chunk",
                cancel_to_last_model_compute_ms=(
                    max(0.0, (last_compute_at - cancel_at) * 1000)
                    if cancel_at is not None and last_compute_at is not None
                    else None
                ),
                cancel_to_last_gpu_send_ms=(
                    max(0.0, (last_send_at - cancel_at) * 1000)
                    if cancel_at is not None and last_send_at is not None
                    else None
                ),
            ))
        try:
            while True:
                # 在线程里取生成器下一项(真实 TTS 的 GPU 推理是阻塞调用,不能在事件循环里直接跑)
                compute_started_at = time.monotonic()
                out = await loop.run_in_executor(None, lambda: next(gen, sentinel))
                compute_finished_at = time.monotonic()
                generation_wall_s += compute_finished_at - compute_started_at
                if out is sentinel:
                    break
                if out.pcm is not None:
                    generated_bytes += len(out.pcm)
                # The executor may finish an old frame just before the event loop
                # processes cancel. Re-check after the await so cancel_ack is a
                # fence: no old-generation meta/PCM can be sent after the ack.
                if epoch is not None and epoch != orch.cancel_epoch:
                    break
                if out.control.type == "tts_done":
                    metric = _metric_frame()
                    if metric is not None:
                        await _send(ws, metric, send_lock)
                        metrics_emitted = True
                    done_emitted = True
                sent = await _send(
                    ws,
                    out,
                    send_lock,
                    guard=lambda: epoch is None or epoch == orch.cancel_epoch,
                    # Capture after acquiring the ordered writer lock and after
                    # the generation guard, immediately before send_text starts.
                    before_send=(
                        _note_first_send
                        if out.pcm is not None and first_send_at is None
                        else None
                    ),
                )
                if not sent:
                    break
                if out.pcm is not None:
                    last_send_at = time.monotonic()
        except Exception as exc:  # noqa: BLE001
            failed = True
            await _send(
                ws,
                OutFrame(P.error(orch.session_id, P.ErrorCode.INTERNAL, f"TTS 失败: {exc}")),
                send_lock,
            )
        finally:
            if (
                not metrics_emitted
                and provider_started_at is not None
                and orch.cancellation_at(epoch) is not None
            ):
                try:
                    metric = _metric_frame()
                    if metric is not None:
                        await _send(ws, metric, send_lock)
                except Exception:  # noqa: BLE001
                    pass
            # 合成失败但没发过 tts_done(且非被 cancel 打断)→ 补一个,保证每句必有 tts_done,计数自洽
            if failed and not done_emitted and not orch._cancelled:
                try:
                    await _send(
                        ws,
                        OutFrame(P.tts_done(
                            orch.session_id,
                            orch._next_seq(),
                            ai_turn_id=ai_turn_id,
                            segment_id=segment_id,
                        )),
                        send_lock,
                    )
                except Exception:  # noqa: BLE001
                    pass

    @app.websocket("/v1/stream")
    async def stream(ws: WebSocket) -> None:
        await ws.accept()
        send_lock = asyncio.Lock()
        st: ReadinessState = app.state.readiness
        orch: SessionOrchestrator | None = None
        # ── TTS 句队列 + 单消费者(修 cancel 队头阻塞)──:此前 tts_text 若上一句还在合成,主循环
        # `await tts_task` 阻塞、不再 receive;而 Bridge 是 LLM 流式分句背靠背连发 → 多句轮里主循环
        # 几乎总卡在 await 上,cancel 帧在 WS 缓冲排队、等当前句合成完才被处理(barge-in 打断迟到
        # 整句,cancel_ack 也随之秒级迟到 = 线上 cancel_ack_timeout 71% 的根因)。改为:tts_text 只
        # 入队(永不 await),常驻 consumer 串行消费(轮内句序不变);cancel 在主循环即时处理(置旗 +
        # 代际+1)→ 在飞句下一块即停,队列中旧代际句被 on_tts_text 整句丢弃。
        tts_queue: asyncio.Queue[tuple[str, int, int | None, int | None, int]] = asyncio.Queue()
        consumer_task: asyncio.Task | None = None
        admitted = False  # 本连接是否已占用一个并发名额(start 通过闸门时置 True;finally 据此释放)

        async def _send_asr_failure(action: str, exc: Exception) -> None:
            logger.exception("%s sid=%s", action, orch.session_id if orch else "")
            if isinstance(exc, AsrExecutionTimeout):
                st.mark(models_loaded=True, self_probe_ok=False, load_error=str(exc))
            await _send(ws, OutFrame(P.error(
                orch.session_id if orch else "",
                P.ErrorCode.INTERNAL,
                f"{action}: {exc}",
            )), send_lock)

        async def _tts_consumer(o: SessionOrchestrator) -> None:
            """串行消费 TTS 句队列(一次一句,轮内句序 = 入队序)。_run_tts 已自兜合成异常;
            这里再兜一层(如 WS 断连时 _send 抛)——消费者绝不能死,死了后续句永不合成(AI 哑)。
            每句 task_done()(finally 保证):end 路径靠 tts_queue.join() 等在飞句干净收尾。"""
            while True:
                text, epoch, ai_turn_id, segment_id, concurrency = await tts_queue.get()
                try:
                    # A just-finished session can enqueue TTS while another
                    # session's residual/finalize is already queued. Give that
                    # submitted ASR work the GPU first; otherwise OmniVoice can
                    # inflate the other session's final tail by several times.
                    await app.state.asr_execution.wait_until_idle(
                        grace_s=_TTS_ASR_HANDOFF_GRACE_S
                    )
                    await _run_tts(
                        ws,
                        o,
                        text,
                        send_lock,
                        epoch,
                        ai_turn_id,
                        segment_id,
                        concurrency,
                    )
                except Exception:  # noqa: BLE001 — 单句失败不拖垮消费者;错误帧已在 _run_tts 内上报
                    pass
                finally:
                    tts_queue.task_done()
        try:
            if not st.ready:
                await ws.send_text(
                    P.error("", P.ErrorCode.MODEL_NOT_READY, "模型未就绪").to_json()
                )
                await ws.close(code=1013)  # try again later
                return

            pending_meta: P.ControlMessage | None = None
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break

                # binary 帧:必须紧跟在 audio_meta 之后
                if (data := msg.get("bytes")) is not None:
                    meta = pending_meta
                    pending_meta = None  # 无论成败都清状态,避免后续帧错配(review)
                    if meta is None or meta.type != "audio_meta":
                        await _send(ws, OutFrame(P.error(
                            orch.session_id if orch else "",
                            P.ErrorCode.PROTOCOL_ERROR, "binary 帧前缺少 audio_meta")), send_lock)
                        continue
                    if orch is None:
                        await _send(ws, OutFrame(P.error("", P.ErrorCode.PROTOCOL_ERROR, "未 start")), send_lock)
                        continue
                    # 校验 binary 长度与 meta 声明一致(防协议注入 / 缓冲膨胀,review)。
                    # bytes 字段做安全解析:非整数(字符串/null)→ 协议错误,不让 int() 抛出崩会话(#9)。
                    raw_bytes = meta.data.get("bytes", -1)
                    if isinstance(raw_bytes, bool) or not isinstance(raw_bytes, int):
                        await _send(ws, OutFrame(P.error(
                            orch.session_id, P.ErrorCode.PROTOCOL_ERROR,
                            "audio_meta.bytes 必须是整数")), send_lock)
                        continue
                    declared = raw_bytes
                    if declared >= 0 and declared != len(data):
                        await _send(ws, OutFrame(P.error(
                            orch.session_id, P.ErrorCode.BAD_AUDIO_FORMAT,
                            f"audio 长度 {len(data)} 与 meta.bytes {declared} 不一致")), send_lock)
                        continue
                    raw_input_epoch = meta.data.get("input_epoch", orch.input_epoch)
                    if isinstance(raw_input_epoch, bool) or not isinstance(raw_input_epoch, int):
                        await _send(ws, OutFrame(P.error(
                            orch.session_id, P.ErrorCode.PROTOCOL_ERROR,
                            "audio_meta.input_epoch 必须是整数")), send_lock)
                        continue
                    if raw_input_epoch != orch.input_epoch:
                        await _send(ws, OutFrame(P.error(
                            orch.session_id, P.ErrorCode.PROTOCOL_ERROR,
                            f"audio_meta.input_epoch 陈旧:收到 {raw_input_epoch},当前 {orch.input_epoch}")), send_lock)
                        continue
                    try:
                        for out in await orch.on_audio(data):
                            await _send(ws, out, send_lock)
                    except P.ProtocolError as exc:
                        await _send(ws, OutFrame(P.error(orch.session_id,
                                    P.ErrorCode.BAD_AUDIO_FORMAT, str(exc))), send_lock)
                    except Exception as exc:  # noqa: BLE001
                        await _send_asr_failure("ASR audio 失败", exc)
                        break
                    continue

                # text 控制帧
                raw = msg.get("text")
                if raw is None:
                    continue
                try:
                    ctrl = P.ControlMessage.from_json(raw)
                except P.ProtocolError as exc:
                    await _send(ws, OutFrame(P.error("", P.ErrorCode.PROTOCOL_ERROR, str(exc))), send_lock)
                    continue

                if ctrl.type == "start":
                    if orch is not None:
                        continue  # 重复 start 忽略(已建会话,不重复占名额)
                    # ★ admission 闸门(§4.1 + design contract):满了 **或本实例正在 drain(缩容/停机)** 都拒绝,
                    #   回 CAPACITY_FULL + 关连接,不建会话、不占名额。Bridge 退避换实例重连(design contract)。
                    #   draining 时拒新但**不影响在途**(已建会话继续服务,直到自然结束 → active 归 0 后实例被回收)。
                    if app.state.draining or app.state.active_sessions >= app.state.gpu_max_sessions:
                        why = "本实例正在 drain(缩容/停机)" if app.state.draining \
                            else f"GPU 并发已满({app.state.gpu_max_sessions})"
                        await ws.send_text(P.error(
                            ctrl.session_id or "", P.ErrorCode.CAPACITY_FULL,
                            f"{why},请稍后重试").to_json())
                        await ws.close(code=1013)  # try again later
                        return
                    # ★ 先占名额(检查→自增之间**绝不能有 await**):事件循环单线程,但下面 protect-before-admit
                    #   的 executor await 会让出循环 → 若把 `+= 1` 放到 await 之后,冷启动(active=0)多通同时
                    #   到达会各自闯过上面的 `>= max` 检查再依次自增 → 超派(真机压测暴露的 TOCTOU 竞态)。
                    #   故此处 check-and-increment 保持原子(无 await),name占了才去做 protection。
                    was_idle = app.state.active_sessions == 0
                    app.state.active_sessions += 1
                    admitted = True  # 名额已占:后续任何早退路径都会经 finally 的 `-= 1` 归还(§4.1)
                    # protect-before-admit(design contract / High #2):0→1 首会话时置 task scale-in protection,
                    # 防"接通瞬间被 ECS scale-in/部署挑停"。默认 best-effort(set 失败仍接客):ECS API 抖动不该
                    # 掐断真实通话(no-op 环境也返 True)。严格模式 AIM_PROTECT_FAIL_CLOSED=1:set 失败则拒接
                    # (回 CAPACITY_FULL,Bridge 退避换实例)——此时已占的名额由下面 return 触发的 finally 归还。
                    if was_idle:
                        ok = await asyncio.get_running_loop().run_in_executor(
                            None, app.state.task_protection.set, True)
                        if not ok and _os.getenv("AIM_PROTECT_FAIL_CLOSED", "") in ("1", "true", "True"):
                            await ws.send_text(P.error(
                                ctrl.session_id or "", P.ErrorCode.CAPACITY_FULL,
                                "task protection 置位失败(fail-closed:拒接以保不腰斩),请重试").to_json())
                            await ws.close(code=1013)
                            return  # admitted=True → finally 会 `-= 1` 归还名额,不泄漏
                    # start.data.language(控制面下发 engine.language,如 zh-CN/en)→ ASR finalize 复核语言偏置,
                    # 避免 SenseVoice auto 误判中文短句、又不误伤英文(review)。非字符串/缺省 → None(默认 auto)。
                    _lang = ctrl.data.get("language")
                    # start.data.voice(控制面下发 engine.voice,male_std/female_std…)→ TTS voice clone 锁声纹。
                    # 非字符串/缺省 → None(真实 TTS 回退默认参考音)。
                    _voice = ctrl.data.get("voice")
                    # start.data.tts_provider(控制面下发 engine.tts_provider,gpu_omnivoice/minimax,design contract)
                    # → 选 TTS 段后端。非字符串/缺省 → None(回退系统默认 gpu_omnivoice)。凭据/映射由 GPU 直读
                    # Secret,**不逐通下发**(此处只传 provider 字符串选后端)。
                    _provider = ctrl.data.get("tts_provider")
                    orch = SessionOrchestrator(
                        ctrl.session_id or "sess",
                        language=_lang if isinstance(_lang, str) else None,
                        voice=_voice if isinstance(_voice, str) else None,
                        tts_provider=_provider if isinstance(_provider, str) else None,
                        asr_execution=app.state.asr_execution,
                        asr_concurrency=lambda: int(app.state.active_sessions),
                        asr_chunk_ms=app.state.asr_chunk_ms,
                    )
                    await _send(ws, orch.ready(), send_lock)
                elif ctrl.type == "audio_meta":
                    pending_meta = ctrl  # 等紧跟的 binary
                elif ctrl.type == "input_reset":
                    if orch is None:
                        await _send(ws, OutFrame(P.error(
                            "", P.ErrorCode.PROTOCOL_ERROR, "未 start")), send_lock)
                        continue
                    from_epoch = ctrl.data.get("from_input_epoch")
                    next_epoch = ctrl.data.get("next_input_epoch")
                    if (
                        isinstance(from_epoch, bool)
                        or not isinstance(from_epoch, int)
                        or isinstance(next_epoch, bool)
                        or not isinstance(next_epoch, int)
                    ):
                        await _send(ws, OutFrame(P.error(
                            orch.session_id, P.ErrorCode.PROTOCOL_ERROR,
                            "input_reset epoch 必须是整数")), send_lock)
                        continue
                    try:
                        await _send(ws, await orch.reset_input(
                            from_input_epoch=from_epoch,
                            next_input_epoch=next_epoch,
                        ), send_lock)
                    except P.ProtocolError as exc:
                        await _send(ws, OutFrame(P.error(
                            orch.session_id, P.ErrorCode.PROTOCOL_ERROR, str(exc))), send_lock)
                    except Exception as exc:  # noqa: BLE001
                        await _send_asr_failure("ASR input_reset 失败", exc)
                        break
                elif ctrl.type == "tts_text":
                    text = ctrl.data.get("text", "")
                    if not isinstance(text, str):
                        await _send(ws, OutFrame(P.error(
                            orch.session_id if orch else "",
                            P.ErrorCode.PROTOCOL_ERROR, "tts_text.text 必须是字符串")), send_lock)
                        continue
                    if orch is not None:
                        ai_turn_id = ctrl.data.get("ai_turn_id")
                        segment_id = ctrl.data.get("segment_id")
                        has_ai_turn = "ai_turn_id" in ctrl.data
                        has_segment = "segment_id" in ctrl.data
                        if has_ai_turn != has_segment or (
                            has_ai_turn
                            and (
                                isinstance(ai_turn_id, bool)
                                or not isinstance(ai_turn_id, int)
                                or ai_turn_id < 0
                                or isinstance(segment_id, bool)
                                or not isinstance(segment_id, int)
                                or segment_id < 0
                            )
                        ):
                            await _send(ws, OutFrame(P.error(
                                orch.session_id,
                                P.ErrorCode.PROTOCOL_ERROR,
                                "tts_text identity 必须成对且为非负整数",
                            )), send_lock)
                            continue
                        # 只入队,**永不 await 合成**(修 cancel 队头阻塞,见 tts_queue 注释)——主循环
                        # 保持 receive,cancel 能即时处理。消费者串行消费:同一轮多句句序不变、不取消
                        # 上一句(取消会丢音频 + 丢 tts_done → 计数泄漏 + 只播最后一句,review)。
                        # 随句捕获当前 cancel 代际:出队时代际已变 = 旧轮残句 → 整句丢弃。
                        if consumer_task is None:
                            consumer_task = asyncio.create_task(_tts_consumer(orch))
                        tts_queue.put_nowait((
                            text,
                            orch.cancel_epoch,
                            ai_turn_id if isinstance(ai_turn_id, int) else None,
                            segment_id if isinstance(segment_id, int) else None,
                            int(app.state.active_sessions),
                        ))
                elif ctrl.type == "cancel":
                    if orch is not None:
                        # 即时置 _cancelled + 代际+1:在飞句(_run_tts 在 executor 逐块取)下一块前看到
                        # 即停;队列中旧代际句由 on_tts_text 按代际整句丢弃。cancel_ack 立即回
                        # (不再等在飞句合成完 —— 修 cancel_ack 秒级迟到)。
                        try:
                            for out in await orch.on_cancel(ctrl.data.get("reason", "error")):
                                await _send(ws, out, send_lock)
                        except Exception as exc:  # noqa: BLE001
                            await _send_asr_failure("ASR cancel reset 失败", exc)
                            break
                elif ctrl.type == "flush":
                    # 主动结束当前一轮(用户「结束本轮」/无尾随静音):finalize ASR → asr_final+turn_end,
                    # 触发下游 LLM→TTS。不关闭会话(区别于 end)。VAD 只在语音后接静音才自然命中,
                    # 连续说话无尾静音时永不出 turn_end —— 这是 voice-test 卡住、没声音的根因。
                    if orch is not None:
                        has_epoch = "input_epoch" in ctrl.data
                        has_turn = "input_turn_id" in ctrl.data
                        input_epoch = ctrl.data.get("input_epoch")
                        input_turn_id = ctrl.data.get("input_turn_id")
                        if has_epoch != has_turn or (
                            has_epoch
                            and (
                                isinstance(input_epoch, bool)
                                or not isinstance(input_epoch, int)
                                or input_epoch < 0
                                or isinstance(input_turn_id, bool)
                                or not isinstance(input_turn_id, int)
                                or input_turn_id < 0
                            )
                        ):
                            await _send(ws, OutFrame(P.error(
                                orch.session_id, P.ErrorCode.PROTOCOL_ERROR,
                                "flush input_epoch/input_turn_id 必须成对且为非负整数")), send_lock)
                            continue
                        try:
                            for out in await orch.finalize_turn(
                                expected_input_epoch=input_epoch if has_epoch else None,
                                expected_input_turn_id=input_turn_id if has_turn else None,
                            ):
                                await _send(ws, out, send_lock)
                        except P.ProtocolError as exc:
                            await _send(ws, OutFrame(P.error(
                                orch.session_id, P.ErrorCode.PROTOCOL_ERROR, str(exc))), send_lock)
                        except Exception as exc:  # noqa: BLE001
                            await _send_asr_failure("ASR flush 失败", exc)
                            break
                elif ctrl.type == "end":
                    if orch is not None:
                        # stop_tts(非 on_cancel):置旗 + 代际+1 真生效。旧代码 `orch.on_cancel(...)`
                        # 调而不迭代 —— 生成器 body 根本不执行,是 no-op(在跑的 TTS 从没被停过)。
                        orch.stop_tts()
                        # 等在飞句干净收尾(旧代际句被丢弃、极快);join 保证 bye 是最后一帧。
                        if consumer_task is not None:
                            await tts_queue.join()
                        await _send(ws, orch.bye(), send_lock)
                    break
                else:
                    await _send(ws, OutFrame(P.error(
                        orch.session_id if orch else "",
                        P.ErrorCode.PROTOCOL_ERROR, f"未知上行类型 {ctrl.type}")), send_lock)
        except WebSocketDisconnect:
            pass
        finally:
            # 释放并发名额(只在本连接确实占过名额时减,避免被拒连接/重复 start 把计数减负,§4.1)。
            if admitted:
                app.state.active_sessions = max(0, app.state.active_sessions - 1)
                # 归 0 → 解除 task protection(本实例无在途,可被 scale-in 回收;design contract)。
                if app.state.active_sessions == 0:
                    try:
                        await asyncio.get_running_loop().run_in_executor(
                            None, app.state.task_protection.set, False)
                    except Exception:  # noqa: BLE001 — 解保护 best-effort,失败由 expiresInMinutes 自动过期兜底
                        pass
            # 资源清理:停 TTS 消费者(WS 断连/异常时,#WS生命周期)。
            # stop_tts(非 on_cancel):旧代码调生成器函数不迭代 = no-op,在跑的合成从没被真停过。
            if orch is not None:
                orch.stop_tts()
                orch.close_input()
            if consumer_task is not None:
                consumer_task.cancel()
            if ws.application_state != WebSocketState.DISCONNECTED:
                await ws.close()

    return app


app = create_app()
