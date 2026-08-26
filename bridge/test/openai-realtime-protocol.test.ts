import {
  decodePcm16Base64,
  REALTIME_LIMITS,
  RealtimeProtocolError,
} from "../src/openai-realtime/protocol";

describe("Realtime PCM wire decoding", () => {
  it("strictly accepts only non-empty, aligned, bounded canonical Base64 PCM16", () => {
    const valid = Buffer.from([0x34, 0x12, 0xcc, 0xff]);
    expect(decodePcm16Base64(valid.toString("base64"))).toEqual(valid);

    const rejected = [
      "",
      "!!!!",
      "YQ", // missing canonical padding
      Buffer.from([0x01]).toString("base64"),
      Buffer.alloc(REALTIME_LIMITS.MAX_APPEND_DECODED_BYTES + 2).toString("base64"),
    ];
    for (const encoded of rejected) {
      try {
        decodePcm16Base64(encoded);
        throw new Error("expected decoder rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(RealtimeProtocolError);
        expect((error as RealtimeProtocolError).param).toBe("audio");
      }
    }
  });
});
