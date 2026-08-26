import { MEDIA_SESSION_OUTPUT_LIMITS } from "../media-session-port";

export const REALTIME_LIMITS = {
  MAX_TEXT_FRAME_BYTES: 1_048_576,
  MAX_APPEND_DECODED_BYTES: 96_000,
  MAX_PENDING_INPUT_BYTES: 384_000,
  MAX_CORE_PENDING_OUTPUT_BYTES: MEDIA_SESSION_OUTPUT_LIMITS.MAX_PENDING_BYTES,
  OUTBOUND_HIGH_WATER_BYTES: 524_288,
  OUTBOUND_LOW_WATER_BYTES: 131_072,
  OUTBOUND_HARD_LIMIT_BYTES: 2_097_152,
  OUTBOUND_MAX_QUEUE_AGE_MS: MEDIA_SESSION_OUTPUT_LIMITS.MAX_QUEUE_AGE_MS,
  OUTBOUND_DRAIN_TIMEOUT_MS: 2_000,
} as const;

export type RealtimeErrorCode =
  | "invalid_audio"
  | "invalid_request"
  | "payload_too_large"
  | "server_managed_field"
  | "unsupported_feature"
  | "unknown_event"
  | "internal_error";

export class RealtimeProtocolError extends Error {
  readonly errorType = "invalid_request_error";

  constructor(
    readonly code: RealtimeErrorCode,
    message: string,
    readonly param?: string,
    readonly eventId?: string,
    readonly closeCode?: 1008 | 1009 | 1011,
  ) {
    super(message);
    this.name = "RealtimeProtocolError";
  }
}

const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function decodePcm16Base64(encoded: string): Buffer {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(encoded)
  ) {
    throw new RealtimeProtocolError(
      "invalid_audio",
      "audio must be non-empty canonical Base64 PCM16",
      "audio",
    );
  }

  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new RealtimeProtocolError(
      "invalid_audio",
      "audio must be canonical Base64 PCM16",
      "audio",
    );
  }
  if (decoded.length > REALTIME_LIMITS.MAX_APPEND_DECODED_BYTES) {
    throw new RealtimeProtocolError(
      "payload_too_large",
      `decoded audio exceeds ${REALTIME_LIMITS.MAX_APPEND_DECODED_BYTES} bytes`,
      "audio",
      undefined,
      1009,
    );
  }
  if (decoded.length === 0 || decoded.length % 2 !== 0) {
    throw new RealtimeProtocolError(
      "invalid_audio",
      "audio must contain aligned PCM16 samples",
      "audio",
    );
  }
  return decoded;
}
