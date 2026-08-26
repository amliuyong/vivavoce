from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "voice_loop_e2e.py"

FAKE_WEBSOCKETS = r'''
import asyncio
import json
import os
from pathlib import Path

_CLOSE = object()


class FakeWebSocket:
    def __init__(self):
        self.inbox = asyncio.Queue()
        self.pending_audio = False
        self.asr_enqueued = False
        self.trace = {
            "silence_frames": 0,
            "bye_received": False,
            "server_close_observed": False,
        }

    async def send(self, message):
        if isinstance(message, str):
            control = json.loads(message)
            kind = control.get("type")
            if kind == "start":
                self.inbox.put_nowait(json.dumps({"type": "ready"}))
            elif kind == "tts_text":
                self.inbox.put_nowait(json.dumps({"type": "tts_audio_meta"}))
                self.inbox.put_nowait(bytes([232, 3]) * 480)
                self.inbox.put_nowait(json.dumps({"type": "tts_done"}))
            elif kind == "audio_meta":
                self.pending_audio = True
            elif kind == "end":
                self.inbox.put_nowait(json.dumps({"type": "bye"}))
                self.inbox.put_nowait(_CLOSE)
                return
        elif self.pending_audio:
            self.pending_audio = False
            if message and not any(message):
                self.trace["silence_frames"] += 1
            if not self.asr_enqueued:
                self.asr_enqueued = True
                self.inbox.put_nowait(json.dumps({"type": "asr_partial", "text": "你好"}))
                self.inbox.put_nowait(json.dumps({"type": "asr_final", "text": "你好"}))
                self.inbox.put_nowait(json.dumps({"type": "turn_end"}))
        await asyncio.sleep(0)

    async def recv(self):
        message = await self.inbox.get()
        if message is _CLOSE:
            self.trace["server_close_observed"] = True
            raise RuntimeError("server closed")
        if isinstance(message, str) and json.loads(message).get("type") == "bye":
            self.trace["bye_received"] = True
        return message


class Connection:
    def __init__(self):
        self.ws = FakeWebSocket()

    async def __aenter__(self):
        return self.ws

    async def __aexit__(self, exc_type, exc, tb):
        Path(os.environ["VOICE_E2E_TRACE"]).write_text(
            json.dumps(self.ws.trace),
            encoding="utf-8",
        )


def connect(url, max_size=None):
    return Connection()
'''


def run_voice_loop(tmp_path: Path) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
    (tmp_path / "websockets.py").write_text(FAKE_WEBSOCKETS, encoding="utf-8")
    trace_path = tmp_path / "trace.json"
    env = os.environ.copy()
    env["AIM_VAD_HANGOVER_MS"] = "1800"
    env["VOICE_E2E_TRACE"] = str(trace_path)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(tmp_path), str(ROOT / "gpu"), env.get("PYTHONPATH", "")]
    )
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    trace = json.loads(trace_path.read_text(encoding="utf-8"))
    return result, trace


def test_cli_tail_silence_exceeds_effective_vad_hangover(tmp_path: Path) -> None:
    result, trace = run_voice_loop(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert trace["silence_frames"] >= 110


def test_cli_waits_for_server_bye_and_close(tmp_path: Path) -> None:
    result, trace = run_voice_loop(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert trace["bye_received"] is True
    assert trace["server_close_observed"] is True
