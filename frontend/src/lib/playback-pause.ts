export const PLAYBACK_PAUSE_CAPABILITY = 'playback_pause_v1';

export type PlaybackPauseFrame =
  | { type: 'pause'; ai_turn_id: number; pause_id: number }
  | { type: 'resume'; ai_turn_id: number; pause_id: number };

export type WorkletPauseControl =
  | { type: 'control_begin_turn'; seq: number }
  | { type: 'control_end_turn'; seq: number }
  | {
      type: 'pause_turn';
      seq: number;
      pause_id: number;
      pause_context_time: number;
    }
  | { type: 'resume_turn'; seq: number; pause_id: number };

export function negotiatedPause(readyCapabilities: unknown): boolean {
  return (
    Array.isArray(readyCapabilities) &&
    readyCapabilities.includes(PLAYBACK_PAUSE_CAPABILITY)
  );
}

export class PlaybackPauseController {
  private enabled = false;
  private activeTurnId: number | undefined;
  private activePauseId: number | undefined;
  private lastPauseId = -1;
  private readonly postWorklet: (message: WorkletPauseControl) => void;
  private readonly contextTime: () => number;

  constructor(
    postWorklet: (message: WorkletPauseControl) => void,
    contextTime: () => number,
  ) {
    this.postWorklet = postWorklet;
    this.contextTime = contextTime;
  }

  negotiate(readyCapabilities: unknown): boolean {
    this.enabled = negotiatedPause(readyCapabilities);
    return this.enabled;
  }

  onAudioStart(aiTurnId: number): void {
    if (!this.enabled || !validId(aiTurnId)) return;
    if (this.activeTurnId !== undefined && aiTurnId <= this.activeTurnId) return;
    this.activeTurnId = aiTurnId;
    this.activePauseId = undefined;
    this.lastPauseId = -1;
    this.postWorklet({ type: 'control_begin_turn', seq: aiTurnId });
  }

  onAudioEnd(aiTurnId: number): void {
    if (!this.enabled || aiTurnId !== this.activeTurnId) return;
    this.postWorklet({ type: 'control_end_turn', seq: aiTurnId });
    this.activeTurnId = undefined;
    this.activePauseId = undefined;
  }

  onPause(frame: PlaybackPauseFrame): void {
    if (
      !this.enabled ||
      frame.type !== 'pause' ||
      !validId(frame.ai_turn_id) ||
      this.activeTurnId === undefined ||
      frame.ai_turn_id !== this.activeTurnId ||
      !validId(frame.pause_id) ||
      this.activePauseId !== undefined ||
      frame.pause_id <= this.lastPauseId
    ) {
      return;
    }
    const pauseContextTime = this.contextTime();
    if (!Number.isFinite(pauseContextTime) || pauseContextTime < 0) return;
    this.activePauseId = frame.pause_id;
    this.lastPauseId = frame.pause_id;
    this.postWorklet({
      type: 'pause_turn',
      seq: frame.ai_turn_id,
      pause_id: frame.pause_id,
      pause_context_time: pauseContextTime,
    });
  }

  onResume(frame: PlaybackPauseFrame): void {
    if (
      !this.enabled ||
      frame.type !== 'resume' ||
      !validId(frame.ai_turn_id) ||
      !validId(frame.pause_id) ||
      frame.ai_turn_id !== this.activeTurnId ||
      frame.pause_id !== this.activePauseId
    ) {
      return;
    }
    this.postWorklet({
      type: 'resume_turn',
      seq: frame.ai_turn_id,
      pause_id: frame.pause_id,
    });
    this.activePauseId = undefined;
  }

  clear(): void {
    this.activeTurnId = undefined;
    this.activePauseId = undefined;
    this.lastPauseId = -1;
  }

  reset(): void {
    this.clear();
    this.enabled = false;
  }
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
