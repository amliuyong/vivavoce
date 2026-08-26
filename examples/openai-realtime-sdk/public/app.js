import { connectWithFreshSecret } from "/shared.mjs";

const sdk = window.OpenAIAgentsRealtime;
if (!sdk) throw new Error("pinned Realtime SDK bundle did not load");

const startButton = document.querySelector("#start");
const endButton = document.querySelector("#end");
const disconnectButton = document.querySelector("#disconnect");
const status = document.querySelector("#status");
const languageButtons = document.querySelectorAll("[data-language]");

const LANGUAGE_KEY = "viva-realtime-example-language";
const messages = {
  zh: {
    htmlLang: "zh-CN",
    title: "Viva Realtime 示例",
    languageLabel: "语言",
    start: "开始",
    end: "结束会话",
    disconnect: "断开连接",
    disconnected: "未连接",
    connecting: "正在连接",
    connected: "已连接",
    retrying: ({ seconds }) => `${seconds} 秒后重试`,
    incomplete: "会话尚未完成",
    ended: "会话已结束",
    ending: "正在结束会话",
    protocolError: "实时协议错误",
    connectionFailed: "连接失败",
  },
  en: {
    htmlLang: "en",
    title: "Viva Realtime Example",
    languageLabel: "Language",
    start: "Start",
    end: "End session",
    disconnect: "Disconnect",
    disconnected: "Disconnected",
    connecting: "Connecting",
    connected: "Connected",
    retrying: ({ seconds }) => `Retrying in ${seconds}s`,
    incomplete: "Session is not complete",
    ended: "Session ended",
    ending: "Ending session",
    protocolError: "Realtime protocol error",
    connectionFailed: "Connection failed",
  },
};

let language = "zh";
let currentStatus = { key: "disconnected", values: {} };

function translated(key, values = {}) {
  const value = messages[language][key];
  return typeof value === "function" ? value(values) : value;
}

function renderLanguage() {
  document.documentElement.lang = messages[language].htmlLang;
  document.title = messages[language].title;
  document.querySelector(".language").setAttribute(
    "aria-label",
    messages[language].languageLabel,
  );
  startButton.textContent = messages[language].start;
  endButton.textContent = messages[language].end;
  disconnectButton.textContent = messages[language].disconnect;
  status.textContent = translated(currentStatus.key, currentStatus.values);
  for (const button of languageButtons) {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.language === language),
    );
  }
}

function setLanguage(nextLanguage) {
  language = nextLanguage === "en" ? "en" : "zh";
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // Private browsing may make localStorage unavailable.
  }
  renderLanguage();
}

function setStatus(key, values = {}) {
  currentStatus = { key, values };
  status.textContent = translated(key, values);
}

try {
  if (localStorage.getItem(LANGUAGE_KEY) === "en") language = "en";
} catch {
  // Keep the Chinese default when localStorage is unavailable.
}
for (const button of languageButtons) {
  button.addEventListener("click", () => setLanguage(button.dataset.language));
}
renderLanguage();

class BrowserPlaybackSink {
  constructor(context) {
    this.context = context;
    this.nextStartTime = context.currentTime;
    this.sources = new Set();
  }

  enqueue(arrayBuffer) {
    const samples = new Int16Array(arrayBuffer);
    const audioBuffer = this.context.createBuffer(1, samples.length, 24_000);
    const output = audioBuffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      output[index] = samples[index] / 32_768;
    }
    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.context.destination);
    source.onended = () => this.sources.delete(source);
    const startAt = Math.max(this.context.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + audioBuffer.duration;
    this.sources.add(source);
  }

  clear() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // A source that ended between iteration and stop is already clear.
      }
    }
    this.sources.clear();
    this.nextStartTime = this.context.currentTime;
  }
}

class BrowserMicrophoneSource {
  constructor(context, session) {
    this.context = context;
    this.session = session;
  }

  async start() {
    await this.context.audioWorklet.addModule("/mic-worklet.js");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(
      this.context,
      "pcm24k-microphone",
      { numberOfInputs: 1, numberOfOutputs: 0 },
    );
    this.worklet.port.onmessage = (event) => {
      this.session.sendAudio(event.data);
    };
    this.source.connect(this.worklet);
  }

  stop() {
    this.worklet?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
  }
}

let session;
let audioContext;
let microphone;
let sink;

function setConnected(connected) {
  startButton.disabled = connected;
  endButton.disabled = !connected;
  disconnectButton.disabled = !connected;
}

function configureSession(candidate) {
  candidate.on("audio", (event) => sink.enqueue(event.data));
  candidate.on("audio_interrupted", () => sink.clear());
  candidate.on("transport_event", (event) => {
    if (event.type === "viva.playback.clear") sink.clear();
    if (event.type === "viva.exam.incomplete") {
      setStatus("incomplete");
    }
    if (event.type === "viva.session.ended") {
      setStatus("ended");
      stopMedia();
      candidate.close();
      setConnected(false);
    }
  });
  candidate.on("error", () => {
    setStatus("protocolError");
  });
}

async function issueCredentials() {
  const response = await fetch("/realtime-bootstrap", { method: "POST" });
  if (!response.ok) {
    throw new Error(`bootstrap failed with HTTP ${response.status}`);
  }
  const credentials = await response.json();
  if (
    typeof credentials.value !== "string" ||
    typeof credentials.url !== "string"
  ) {
    throw new Error("bootstrap returned invalid credentials");
  }
  return credentials;
}

function createRealtimeSession() {
  const agent = new sdk.RealtimeAgent({
    name: "Viva SDK browser client",
    instructions: "Viva server configuration is authoritative.",
  });
  const candidate = new sdk.RealtimeSession(agent, {
    transport: "websocket",
    model: "gpt-realtime-2.1",
    tracingDisabled: true,
  });
  configureSession(candidate);
  return candidate;
}

function stopMedia() {
  microphone?.stop();
  microphone = undefined;
  sink?.clear();
  void audioContext?.close();
  audioContext = undefined;
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  setStatus("connecting");
  try {
    audioContext = new AudioContext();
    await audioContext.resume();
    sink = new BrowserPlaybackSink(audioContext);
    session = await connectWithFreshSecret({
      createSession: createRealtimeSession,
      issueCredentials,
      onRetry: ({ delayMs }) =>
        setStatus("retrying", { seconds: delayMs / 1_000 }),
    });
    microphone = new BrowserMicrophoneSource(audioContext, session);
    await microphone.start();
    setStatus("connected");
    setConnected(true);
  } catch {
    stopMedia();
    startButton.disabled = false;
    setStatus("connectionFailed");
  }
});

endButton.addEventListener("click", () => {
  setStatus("ending");
  session.transport.sendEvent({ type: "viva.session.end" });
});

disconnectButton.addEventListener("click", () => {
  // This tears down transport only. It does not complete the Viva session.
  session.close();
  stopMedia();
  setConnected(false);
  setStatus("disconnected");
});
