import { OpenAIRealtimeSessionState } from "../src/openai-realtime/session-state";
import { StreamingPcmResampler } from "../src/openai-realtime/audio-resampler";

describe("OpenAIRealtimeSessionState", () => {
  it("emits stable bootstrap snapshots for full and tracing-only SDK updates", async () => {
    const events: Record<string, unknown>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "00112233445566778899aabbccddeeff",
      emit: (event) => events.push(event),
    });

    state.open();
    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "client_full",
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        instructions: "SDK-local agent instructions",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: { type: "semantic_vad" },
            noise_reduction: null,
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            speed: 1,
          },
        },
        tools: [],
      },
    });
    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "client_trace",
      session: { tracing: "auto" },
    });

    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "conversation.created",
      "session.updated",
      "session.updated",
    ]);
    const snapshots = events
      .filter((event) => event.type === "session.created" || event.type === "session.updated")
      .map((event) => event.session);
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
    expect(snapshots[0]).toMatchObject({
      type: "realtime",
      object: "realtime.session",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
      tracing: null,
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: {
          format: { type: "audio/pcm", rate: 24_000 },
        },
      },
    });
    expect(snapshots[0]).not.toHaveProperty("instructions");
    expect(snapshots[0]).not.toHaveProperty("tools");
    expect(new Set(events.map((event) => event.event_id)).size).toBe(events.length);
  });

  it("binds appended PCM and core speech activity to one stable user item", async () => {
    const events: Record<string, unknown>[] = [];
    const pushed: Array<{ inputEpoch: number; pcm16k: Buffer }> = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "11112222333344445555666677778888",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: (command) => pushed.push(command),
        commitInput: () => undefined,
        resetInput: async () => undefined,
        cancelActiveResponse: () => undefined,
        requestSessionEnd: () => undefined,
      },
    });
    state.open();
    const pcm24k = Buffer.alloc(960);
    for (let offset = 0; offset < pcm24k.length; offset += 2) {
      pcm24k.writeInt16LE(((offset / 2) % 31) * 500 - 7_500, offset);
    }

    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      event_id: "append_1",
      audio: pcm24k.toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 0,
      audioStartMs: 0,
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0].inputEpoch).toBe(0);
    expect(pushed[0].pcm16k.length).toBeGreaterThan(0);
    expect(pushed[0].pcm16k.length).toBeLessThan(pcm24k.length);
    const speech = events.at(-1);
    expect(speech).toMatchObject({
      type: "input_audio_buffer.speech_started",
      audio_start_ms: 0,
    });
    expect(String(speech?.item_id)).toMatch(/^item_11112222333344445555666677778888_/);
  });

  it("converges explicit commit, final transcription, and retrieve on one user item", async () => {
    const events: Record<string, any>[] = [];
    const commits: Array<{ inputEpoch: number; inputTurnId?: number }> = [];
    const coreOrder: string[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "22223333444455556666777788889999",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: ({ pcm16k }) => coreOrder.push(`pcm:${pcm16k.length}`),
        commitInput: (command) => {
          coreOrder.push("commit");
          commits.push(command);
        },
        resetInput: async () => undefined,
        cancelActiveResponse: () => undefined,
        requestSessionEnd: () => undefined,
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 7,
      audioStartMs: 10,
    });
    await state.dispatchClientEvent({ type: "input_audio_buffer.commit", event_id: "commit_1" });
    await state.dispatchClientEvent({ type: "input_audio_buffer.commit", event_id: "commit_2" });
    state.dispatchCoreEvent({
      type: "user_transcript_final",
      inputEpoch: 0,
      inputTurnId: 7,
      transcript: "最终转写",
    });
    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 7,
      audioEndMs: 310,
    });

    expect(commits).toEqual([{ inputEpoch: 0, inputTurnId: 7 }]);
    expect(coreOrder).toEqual(["pcm:640", "commit"]);
    expect(events.slice(-6).map((event) => event.type)).toEqual([
      "input_audio_buffer.speech_started",
      "input_audio_buffer.speech_stopped",
      "input_audio_buffer.committed",
      "conversation.item.added",
      "conversation.item.done",
      "conversation.item.input_audio_transcription.completed",
    ]);
    const added = events.find((event) => event.type === "conversation.item.added");
    const done = events.find((event) => event.type === "conversation.item.done");
    expect(added).toBeDefined();
    expect(done).toBeDefined();
    if (!added || !done) throw new Error("expected user item lifecycle events");
    expect(added.item).toMatchObject({
      id: done.item.id,
      type: "message",
      role: "user",
      status: "in_progress",
      content: [{ type: "input_audio", transcript: null }],
    });
    expect(done.item).toMatchObject({
      id: added.item.id,
      status: "completed",
      content: [{ type: "input_audio", transcript: "最终转写" }],
    });

    await state.dispatchClientEvent({
      type: "conversation.item.retrieve",
      event_id: "retrieve_1",
      item_id: done.item.id,
    });
    expect(events.at(-1)).toMatchObject({
      type: "conversation.item.retrieved",
      item: done.item,
    });
  });

  it("acknowledges clear only after the input reset fence and isolates the retired turn", async () => {
    const events: Record<string, any>[] = [];
    const resets: Array<{
      command: {
        fromInputEpoch: number;
        nextInputEpoch: number;
        retiredInputTurnId?: number;
      };
      resolve: () => void;
    }> = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "3333444455556666777788889999aaaa",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: (command) =>
          new Promise<void>((resolve) => {
            resets.push({ command, resolve });
          }),
        cancelActiveResponse: () => undefined,
        requestSessionEnd: () => undefined,
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 1).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 4,
      audioStartMs: 20,
    });
    const firstSpeech = events.at(-1);
    expect(firstSpeech).toBeDefined();
    if (!firstSpeech) throw new Error("expected speech-start event");
    const oldItemId = firstSpeech.item_id;

    const clear = state.dispatchClientEvent({
      type: "input_audio_buffer.clear",
      event_id: "clear_1",
    });
    expect(resets).toHaveLength(1);
    expect(resets[0].command).toEqual({
      fromInputEpoch: 0,
      nextInputEpoch: 1,
      retiredInputTurnId: 4,
    });
    expect(events.some((event) => event.type === "input_audio_buffer.cleared")).toBe(false);
    resets[0].resolve();
    await clear;
    expect(events.at(-1)).toMatchObject({ type: "input_audio_buffer.cleared" });

    expect(() =>
      state.dispatchCoreEvent({
        type: "user_transcript_final",
        inputEpoch: 0,
        inputTurnId: 4,
        transcript: "must be rejected",
      }),
    ).toThrow("stale input callback epoch 0");
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 2).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 1,
      inputTurnId: 0,
      audioStartMs: 0,
    });

    const speechEvents = events.filter(
      (event) => event.type === "input_audio_buffer.speech_started",
    );
    expect(speechEvents).toHaveLength(2);
    expect(speechEvents[1].item_id).not.toBe(oldItemId);
    expect(events.some((event) => event.transcript === "must be ignored")).toBe(false);
  });

  it("queues append during clear and flushes it only after the matching reset fence", async () => {
    const pushed: Array<{ inputEpoch: number; pcm16k: Buffer }> = [];
    let releaseReset!: () => void;
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "ccccddddeeeeffff0000111122223333",
      emit: () => undefined,
      core: {
        pushInputPcm: (command) => pushed.push(command),
        commitInput: () => undefined,
        resetInput: () =>
          new Promise<void>((resolve) => {
            releaseReset = resolve;
          }),
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 1).toString("base64"),
    });
    const beforeClear = pushed.length;
    const clear = state.dispatchClientEvent({
      type: "input_audio_buffer.clear",
      event_id: "clear_pending",
    });
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 2).toString("base64"),
    });
    expect(pushed).toHaveLength(beforeClear);

    releaseReset();
    await clear;
    expect(pushed.length).toBeGreaterThan(beforeClear);
    expect(pushed.at(-1)?.inputEpoch).toBe(1);
  });

  it("promotes a GPU-auto-committed clear candidate before the reset ack", async () => {
    const events: Record<string, any>[] = [];
    let releaseReset!: () => void;
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "ccccddddeeeeffff0000111122224444",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: () =>
          new Promise<void>((resolve) => {
            releaseReset = resolve;
          }),
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 3).toString("base64"),
    });

    const clear = state.dispatchClientEvent({
      type: "input_audio_buffer.clear",
      event_id: "clear_auto_committed",
    });
    const beforeCallbacks = events.length;
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 7,
    });
    state.dispatchCoreEvent({
      type: "user_transcript_final",
      inputEpoch: 0,
      inputTurnId: 7,
      transcript: "committed before reset",
    });
    expect(events).toHaveLength(beforeCallbacks);

    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 7,
    });
    expect(
      events.filter((event) => event.type === "conversation.item.done"),
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          content: [
            expect.objectContaining({ transcript: "committed before reset" }),
          ],
        }),
      }),
    ]);

    releaseReset();
    await clear;
    expect(events.at(-1)).toMatchObject({
      type: "input_audio_buffer.cleared",
    });
    expect(() =>
      state.dispatchCoreEvent({
        type: "user_transcript_final",
        inputEpoch: 0,
        inputTurnId: 7,
        transcript: "after ack",
      }),
    ).toThrow("stale input callback epoch 0");
  });

  it("reports pending input overflow as fatal and rejects reset-fence failure", async () => {
    const errors: Array<{ code: string; closeCode?: number }> = [];
    let releaseReset!: () => void;
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "ddddeeeeffff00001111222233334444",
      emit: () => undefined,
      onProtocolError: (error) =>
        errors.push({ code: error.code, closeCode: error.closeCode }),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: () =>
          new Promise<void>((resolve) => {
            releaseReset = resolve;
          }),
      },
    });
    state.open();
    const clear = state.dispatchClientEvent({
      type: "input_audio_buffer.clear",
    });
    const chunk = Buffer.alloc(96_000).toString("base64");
    for (let index = 0; index < 5; index += 1) {
      await state.dispatchClientEvent({
        type: "input_audio_buffer.append",
        event_id: `pending_${index}`,
        audio: chunk,
      });
    }
    expect(errors).toContainEqual({
      code: "payload_too_large",
      closeCode: 1009,
    });
    releaseReset();
    await clear;

    const failing = new OpenAIRealtimeSessionState({
      connectionNamespace: "eeeeffff000011112222333344445555",
      emit: () => undefined,
      core: {
        resetInput: async () => {
          throw new Error("ack timeout");
        },
      },
    });
    failing.open();
    await expect(
      failing.dispatchClientEvent({ type: "input_audio_buffer.clear" }),
    ).rejects.toMatchObject({
      code: "internal_error",
      closeCode: 1011,
    });
  });

  it("converges an automatic endpoint and a late explicit commit without a second core command", async () => {
    const events: Record<string, any>[] = [];
    const commits: Array<{ inputEpoch: number; inputTurnId?: number }> = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "444455556666777788889999aaaabbbb",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: (command) => commits.push(command),
        resetInput: async () => undefined,
        cancelActiveResponse: () => undefined,
        requestSessionEnd: () => undefined,
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.commit",
      event_id: "empty_commit",
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "invalid_request", event_id: "empty_commit" },
    });

    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 3).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 9,
      audioStartMs: 0,
    });
    state.dispatchCoreEvent({
      type: "user_transcript_final",
      inputEpoch: 0,
      inputTurnId: 9,
      transcript: "automatic",
    });
    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 9,
      audioEndMs: 200,
    });
    const beforeLateCommit = events.length;
    await state.dispatchClientEvent({
      type: "input_audio_buffer.commit",
      event_id: "late_commit",
    });

    expect(commits).toEqual([]);
    expect(events).toHaveLength(beforeLateCommit);
    expect(
      events.filter((event) => event.type === "conversation.item.done"),
    ).toHaveLength(1);
  });

  it("retires a no-speech commit and preserves FIR history for the next input", async () => {
    const events: Record<string, any>[] = [];
    const pushed: Array<{ inputEpoch: number; pcm16k: Buffer }> = [];
    const first = Buffer.alloc(960);
    first.writeInt16LE(32_000, first.length - 2);
    const second = Buffer.alloc(960);
    const reference = new StreamingPcmResampler(24_000, 16_000, {
      mode: "causal",
    });
    const expected = Buffer.concat([
      reference.push(first),
      reference.push(second),
      reference.finalize(),
    ]);
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "444455556666777788889999aaaacccc",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: (command) => pushed.push(command),
        commitInput: () => undefined,
        resetInput: async () => undefined,
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: first.toString("base64"),
    });
    await state.dispatchClientEvent({
      type: "input_audio_buffer.commit",
      event_id: "silent_commit",
    });
    state.dispatchCoreEvent({
      type: "input_rejected",
      inputEpoch: 0,
      inputTurnId: 0,
      reason: "no_speech",
    });

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "invalid_request",
        event_id: "silent_commit",
      },
    });

    const pushedBeforeNextInput = pushed.length;
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: second.toString("base64"),
    });
    expect(pushed.length).toBeGreaterThan(pushedBeforeNextInput);
    expect(Buffer.concat(pushed.map(({ pcm16k }) => pcm16k))).toEqual(expected);
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 1,
    });
    expect(events.at(-1)).toMatchObject({
      type: "input_audio_buffer.speech_started",
    });
  });

  it("discards session-ending input without creating a conversation item", async () => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "444455556666777788889999aaaadddd",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: async () => undefined,
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 1).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_rejected",
      inputEpoch: 0,
      inputTurnId: 0,
      reason: "session_ending",
    });

    expect(
      events.filter((event) => event.type === "conversation.item.added"),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.type === "conversation.item.done"),
    ).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "invalid_request",
        message: "input audio was discarded while the session was ending",
      },
    });
  });

  it("emits one typed lifecycle for a completed audio response", () => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "55556666777788889999aaaabbbbcccc",
      emit: (event) => events.push(event),
    });
    state.open();
    state.dispatchCoreEvent({
      type: "response_started",
      responseGeneration: 12,
      turnSeq: 17,
    });
    state.dispatchCoreEvent({
      type: "response_segment_declared",
      responseGeneration: 12,
      turnSeq: 17,
      segmentId: 3,
      text: "你好，",
    });
    const pcm16k = Buffer.alloc(640);
    for (let offset = 0; offset < pcm16k.length; offset += 2) {
      pcm16k.writeInt16LE(((offset / 2) % 41) * 400 - 8_000, offset);
    }
    state.dispatchCoreEvent({
      type: "response_audio",
      responseGeneration: 12,
      turnSeq: 17,
      segmentId: 3,
      pcm16k,
    });
    state.dispatchCoreEvent({
      type: "response_segment_completed",
      responseGeneration: 12,
      turnSeq: 17,
      segmentId: 3,
    });
    state.dispatchCoreEvent({
      type: "response_core_terminal",
      responseGeneration: 12,
      turnSeq: 17,
      status: "completed",
    });

    const responseEvents = events.slice(2);
    expect(responseEvents.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "conversation.item.added",
      "response.content_part.added",
      "response.output_audio_transcript.delta",
      "response.output_audio.delta",
      "response.output_audio.delta",
      "response.output_audio.done",
      "response.output_audio_transcript.done",
      "response.content_part.done",
      "response.output_item.done",
      "conversation.item.done",
      "response.done",
    ]);
    const created = responseEvents[0].response;
    const itemAdded = responseEvents[1].item;
    const audioEvents = responseEvents.filter(
      (event) => event.type === "response.output_audio.delta",
    );
    const terminal = responseEvents.at(-1);
    expect(terminal).toBeDefined();
    if (!terminal) throw new Error("expected response terminal");
    expect(created).toMatchObject({
      object: "realtime.response",
      conversation_id: "conv_55556666777788889999aaaabbbbcccc_1",
      status: "in_progress",
      status_details: null,
      output: [],
    });
    expect(itemAdded).toMatchObject({
      object: "realtime.item",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [{ type: "output_audio", transcript: "" }],
    });
    expect(audioEvents.length).toBeGreaterThan(0);
    expect(
      audioEvents.reduce(
        (total, event) => total + Buffer.from(event.delta, "base64").length / 2,
        0,
      ),
    ).toBe(480);
    expect(new Set(responseEvents.map((event) => event.response_id).filter(Boolean))).toEqual(
      new Set([created.id]),
    );
    expect(terminal.response).toMatchObject({
      id: created.id,
      status: "completed",
      output: [
        {
          id: itemAdded.id,
          status: "completed",
          content: [{ type: "output_audio", transcript: "你好，" }],
        },
      ],
    });
    expect(
      responseEvents.filter((event) => event.type === "response.done"),
    ).toHaveLength(1);
  });

  it("aggregates cancel and tombstone truncate with callback-confirmed audio", async () => {
    const events: Record<string, any>[] = [];
    const deliveries = new Map<string, { onHandoff?: () => void }>();
    const cancels: Array<{ responseGeneration: number; reason: string }> = [];
    let nowMs = 1_000;
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "6666777788889999aaaabbbbccccdddd",
      emit: (event, delivery) => {
        events.push(event);
        if (delivery) deliveries.set(event.event_id, delivery);
      },
      now: () => nowMs,
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: async () => undefined,
        cancelActiveResponse: (command) => {
          cancels.push(command);
          state.dispatchCoreEvent({
            type: "response_core_terminal",
            responseGeneration: 31,
            turnSeq: 32,
            status: "cancelled",
            reason: "client_cancelled",
          });
        },
        requestSessionEnd: () => undefined,
      },
    });
    state.open();
    state.dispatchCoreEvent({
      type: "response_started",
      responseGeneration: 21,
      turnSeq: 22,
    });
    state.dispatchCoreEvent({
      type: "response_segment_declared",
      responseGeneration: 21,
      turnSeq: 22,
      segmentId: 1,
      text: "这段不能完整保留",
    });
    state.dispatchCoreEvent({
      type: "response_audio",
      responseGeneration: 21,
      turnSeq: 22,
      segmentId: 1,
      pcm16k: Buffer.alloc(6_400, 4),
    });
    state.dispatchCoreEvent({
      type: "response_segment_completed",
      responseGeneration: 21,
      turnSeq: 22,
      segmentId: 1,
    });
    for (const event of events.filter(
      (candidate) => candidate.type === "response.output_audio.delta",
    )) {
      deliveries.get(event.event_id)?.onHandoff?.();
    }
    const responseId = events.find((event) => event.type === "response.created")?.response.id;
    const itemId = events.find((event) => event.type === "response.output_item.added")?.item.id;
    expect(responseId).toBeDefined();
    expect(itemId).toBeDefined();

    await state.dispatchClientEvent({
      type: "response.cancel",
      event_id: "cancel_1",
      response_id: responseId,
    });
    await state.dispatchClientEvent({
      type: "response.cancel",
      event_id: "cancel_2",
      response_id: responseId,
    });
    expect(cancels).toEqual([{ responseGeneration: 21, reason: "client_cancelled" }]);
    state.dispatchCoreEvent({
      type: "response_core_terminal",
      responseGeneration: 21,
      turnSeq: 22,
      status: "cancelled",
      reason: "client_cancelled",
    });

    const doneTypes = events
      .filter((event) => event.type.endsWith(".done"))
      .map((event) => event.type);
    expect(doneTypes).toEqual([
      "response.output_audio.done",
      "response.output_audio_transcript.done",
      "response.content_part.done",
      "response.output_item.done",
      "conversation.item.done",
      "response.done",
    ]);
    expect(events.filter((event) => event.type === "response.done")).toHaveLength(1);

    nowMs += 100;
    await state.dispatchClientEvent({
      type: "conversation.item.truncate",
      event_id: "truncate_1",
      item_id: itemId,
      content_index: 0,
      audio_end_ms: 50,
    });
    await state.dispatchClientEvent({
      type: "conversation.item.truncate",
      event_id: "truncate_2",
      item_id: itemId,
      content_index: 0,
      audio_end_ms: 50,
    });
    expect(cancels).toHaveLength(1);
    expect(events.filter((event) => event.type === "response.done")).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "conversation.item.truncated"),
    ).toHaveLength(2);

    await state.dispatchClientEvent({
      type: "conversation.item.retrieve",
      item_id: itemId,
    });
    expect(events.at(-1)).toMatchObject({
      type: "conversation.item.retrieved",
      item: {
        id: itemId,
        status: "incomplete",
        content: [{ type: "output_audio", transcript: "" }],
      },
    });
  });

  it("fences response payload callbacks at cancel request while accepting the terminal", async () => {
    const events: Record<string, any>[] = [];
    const cancels: Array<{ responseGeneration: number; reason: string }> = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "777788889999aaaabbbbccccddddeeee",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: async () => undefined,
        cancelActiveResponse: (command) => cancels.push(command),
        requestSessionEnd: () => undefined,
      },
    });
    state.open();
    state.dispatchCoreEvent({
      type: "response_started",
      responseGeneration: 23,
      turnSeq: 24,
    });
    state.dispatchCoreEvent({
      type: "response_segment_declared",
      responseGeneration: 23,
      turnSeq: 24,
      segmentId: 1,
      text: "保留。",
    });
    state.dispatchCoreEvent({
      type: "response_audio",
      responseGeneration: 23,
      turnSeq: 24,
      segmentId: 1,
      pcm16k: Buffer.alloc(6_400, 1),
    });
    const responseId = events.find((event) => event.type === "response.created")?.response.id;

    await state.dispatchClientEvent({
      type: "response.cancel",
      event_id: "cancel_fence",
      response_id: responseId,
    });
    const eventCountAtCancel = events.length;
    state.dispatchCoreEvent({
      type: "response_segment_declared",
      responseGeneration: 23,
      turnSeq: 24,
      segmentId: 2,
      text: "不得出现。",
    });
    state.dispatchCoreEvent({
      type: "response_audio",
      responseGeneration: 23,
      turnSeq: 24,
      segmentId: 1,
      pcm16k: Buffer.alloc(6_400, 2),
    });
    state.dispatchCoreEvent({
      type: "response_segment_completed",
      responseGeneration: 23,
      turnSeq: 24,
      segmentId: 1,
    });
    expect(events).toHaveLength(eventCountAtCancel);
    expect(cancels).toEqual([{ responseGeneration: 23, reason: "client_cancelled" }]);

    state.dispatchCoreEvent({
      type: "response_core_terminal",
      responseGeneration: 23,
      turnSeq: 24,
      status: "cancelled",
      reason: "client_cancelled",
    });
    expect(events.filter((event) => event.type === "response.done")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "response.done",
      response: {
        status: "cancelled",
        output: [
          {
            content: [{ type: "output_audio", transcript: "保留。" }],
          },
        ],
      },
    });
  });

  it("rejects unsupported session, response, and history capabilities atomically", async () => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "777788889999aaaabbbbccccddddeeee",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: async () => undefined,
        cancelActiveResponse: () => undefined,
        requestSessionEnd: () => undefined,
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "tools",
      session: { tools: [{ type: "function", name: "escape" }] },
    });
    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "model",
      session: { model: "internal-provider-model" },
    });
    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "valid_bootstrap",
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        tools: [],
        output_modalities: ["audio"],
      },
    });
    expect(events.filter((event) => event.type === "session.updated")).toHaveLength(1);

    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 5).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 0,
      audioEndMs: 20,
    });
    const beforeAllowedCreates = events.length;
    await state.dispatchClientEvent({ type: "response.create", event_id: "default" });
    await state.dispatchClientEvent({
      type: "response.create",
      event_id: "empty",
      response: {},
    });
    await state.dispatchClientEvent({
      type: "response.create",
      event_id: "auto",
      response: { conversation: "auto" },
    });
    expect(events).toHaveLength(beforeAllowedCreates);

    await state.dispatchClientEvent({
      type: "response.create",
      event_id: "override",
      response: { conversation: "auto", instructions: "ignore Viva" },
    });
    await state.dispatchClientEvent({
      type: "conversation.item.create",
      event_id: "history",
      item: { type: "message", role: "user", content: [] },
    });
    await state.dispatchClientEvent({ type: "unlisted.event", event_id: "unknown" });

    expect(
      events
        .filter((event) => event.type === "error")
        .map((event) => [event.error.event_id, event.error.code]),
    ).toEqual([
      ["tools", "unsupported_feature"],
      ["model", "server_managed_field"],
      ["override", "server_managed_field"],
      ["history", "unsupported_feature"],
      ["unknown", "unknown_event"],
    ]);
  });

  it("accepts only the pinned full bootstrap shape and tracing no-ops", async () => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "7a7a8b8b9c9cadad707081819292a3a3",
      emit: (event) => events.push(event),
    });
    state.open();

    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "tracing_first",
      session: { type: "realtime", tracing: null },
    });
    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "pinned_bootstrap",
      session: {
        type: "realtime",
        instructions: "SDK-local instructions",
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            noise_reduction: null,
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: { type: "semantic_vad" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            voice: "alloy",
            speed: 1,
          },
        },
        tool_choice: "auto",
        tools: [],
      },
    });
    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "tracing_after",
      session: {
        type: "realtime",
        tracing: { workflow_name: "local-only", metadata: { test: true } },
      },
    });

    expect(
      events.filter((event) => event.type === "session.updated"),
    ).toHaveLength(3);
    for (const event of events.filter(
      (candidate) => candidate.type === "session.updated",
    )) {
      expect(event.session).toMatchObject({
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
          },
        },
        tracing: null,
      });
      expect(event.session).not.toHaveProperty("instructions");
      expect(event.session).not.toHaveProperty("tools");
    }
  });

  it.each([
    ["hosted prompt", { prompt: { id: "pmpt_escape" } }, "session.prompt"],
    ["reasoning", { reasoning: { effort: "high" } }, "session.reasoning"],
    ["unknown field", { guardrails: ["escape"] }, "session.guardrails"],
  ])(
    "rejects unsupported %s without consuming the initial bootstrap",
    async (_label, override, param) => {
      const events: Record<string, any>[] = [];
      const state = new OpenAIRealtimeSessionState({
        connectionNamespace: "7b7b8c8c9d9daeae717182829393a4a4",
        emit: (event) => events.push(event),
      });
      state.open();

      await state.dispatchClientEvent({
        type: "session.update",
        event_id: "unsupported_initial",
        session: {
          type: "realtime",
          ...override,
        },
      });
      await state.dispatchClientEvent({
        type: "session.update",
        event_id: "valid_after_rejection",
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          output_modalities: ["audio"],
          tools: [],
        },
      });

      expect(
        events.filter((event) => event.type === "session.updated"),
      ).toHaveLength(1);
      expect(events.find((event) => event.type === "error")).toMatchObject({
        error: {
          event_id: "unsupported_initial",
          code: "unsupported_feature",
          param,
        },
      });
    },
  );

  it("rejects server-managed updates after bootstrap with a precise field", async () => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "7c7c8d8d9e9eafaf727283839494a5a5",
      emit: (event) => events.push(event),
    });
    state.open();
    await state.dispatchClientEvent({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
      },
    });
    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "replace_instructions",
      session: {
        type: "realtime",
        instructions: "replace Viva",
      },
    });

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        event_id: "replace_instructions",
        code: "server_managed_field",
        param: "session.instructions",
      },
    });
  });

  it.each([
    [
      "unknown turn detection field",
      { type: "semantic_vad", vendor_escape: true },
      "session.audio.input.turn_detection.vendor_escape",
    ],
    [
      "unknown turn detection type",
      { type: "client_vad" },
      "session.audio.input.turn_detection.type",
    ],
    [
      "malformed turn detection option",
      { type: "semantic_vad", create_response: "yes" },
      "session.audio.input.turn_detection.create_response",
    ],
  ])("rejects %s in the initial audio bootstrap", async (_label, turnDetection, param) => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "7e7e8f8fa0a0b1b1747485859696a7a7",
      emit: (event) => events.push(event),
    });
    state.open();

    await state.dispatchClientEvent({
      type: "session.update",
      event_id: "invalid_turn_detection",
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            turn_detection: turnDetection,
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
          },
        },
      },
    });

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        event_id: "invalid_turn_detection",
        code: "unsupported_feature",
        param,
      },
    });
    expect(events.filter((event) => event.type === "session.updated")).toEqual([]);
  });

  it("keeps late response.create idempotent until the next input starts", async () => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "7d7d8e8e9f9fb0b0737384849595a6a6",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 5).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 0,
    });
    state.dispatchCoreEvent({
      type: "response_started",
      responseGeneration: 61,
      turnSeq: 62,
    });
    await state.dispatchClientEvent({
      type: "response.create",
      event_id: "active_duplicate",
    });
    expect(events.at(-1)?.type).toBe("response.created");

    state.dispatchCoreEvent({
      type: "response_core_terminal",
      responseGeneration: 61,
      turnSeq: 62,
      status: "completed",
    });
    const terminalEventCount = events.length;
    await state.dispatchClientEvent({
      type: "response.create",
      event_id: "after_terminal",
    });
    expect(events).toHaveLength(terminalEventCount);

    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 6).toString("base64"),
    });
    await state.dispatchClientEvent({
      type: "response.create",
      event_id: "after_next_input",
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        event_id: "after_next_input",
        code: "invalid_request",
        param: "response",
      },
    });
  });

  it("keeps only complete FIR-safe transcript segments on truncate-first interruption", async () => {
    const events: Record<string, any>[] = [];
    const handoffs: Array<() => void> = [];
    const cancels: Array<{ responseGeneration: number; reason: string }> = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "88889999aaaabbbbccccddddeeeeffff",
      emit: (event, delivery) => {
        events.push(event);
        if (delivery?.onHandoff) handoffs.push(delivery.onHandoff);
      },
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: async () => undefined,
        cancelActiveResponse: (command) => {
          cancels.push(command);
          state.dispatchCoreEvent({
            type: "response_core_terminal",
            responseGeneration: 31,
            turnSeq: 32,
            status: "cancelled",
            reason: "client_cancelled",
          });
        },
        requestSessionEnd: () => undefined,
      },
    });
    state.open();
    state.dispatchCoreEvent({
      type: "response_started",
      responseGeneration: 31,
      turnSeq: 32,
    });
    for (const [segmentId, text] of [
      [1, "第一段。"],
      [2, "第二段。"],
    ] as const) {
      state.dispatchCoreEvent({
        type: "response_segment_declared",
        responseGeneration: 31,
        turnSeq: 32,
        segmentId,
        text,
      });
      state.dispatchCoreEvent({
        type: "response_audio",
        responseGeneration: 31,
        turnSeq: 32,
        segmentId,
        pcm16k: Buffer.alloc(6_400, segmentId),
      });
      state.dispatchCoreEvent({
        type: "response_segment_completed",
        responseGeneration: 31,
        turnSeq: 32,
        segmentId,
      });
    }
    handoffs.forEach((handoff) => handoff());
    const itemId = events.find((event) => event.type === "response.output_item.added")?.item.id;

    await state.dispatchClientEvent({
      type: "conversation.item.truncate",
      event_id: "truncate_first",
      item_id: itemId,
      content_index: 0,
      audio_end_ms: 205,
    });
    await state.dispatchClientEvent({
      type: "response.cancel",
      response_id: events.find((event) => event.type === "response.created")?.response.id,
    });

    expect(cancels).toEqual([{ responseGeneration: 31, reason: "client_cancelled" }]);
    expect(
      events.find((event) => event.type === "response.output_audio_transcript.done")
        ?.transcript,
    ).toBe("第一段。");
    expect(events.find((event) => event.type === "response.done")?.response.output).toMatchObject([
      {
        status: "incomplete",
        content: [{ type: "output_audio", transcript: "第一段。" }],
      },
    ]);
    expect(events.filter((event) => event.type === "response.done")).toHaveLength(1);
  });

  it("fails an unopened response without fabricating output layers and drops stale callbacks", () => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "9999aaaabbbbccccddddeeeeffff0000",
      emit: (event) => events.push(event),
    });
    state.open();
    state.dispatchCoreEvent({
      type: "response_started",
      responseGeneration: 41,
      turnSeq: 42,
    });
    state.dispatchCoreEvent({
      type: "response_core_terminal",
      responseGeneration: 41,
      turnSeq: 42,
      status: "failed",
      reason: "tts_failed",
    });
    state.dispatchCoreEvent({
      type: "response_audio",
      responseGeneration: 41,
      turnSeq: 42,
      segmentId: 1,
      pcm16k: Buffer.alloc(640),
    });

    expect(events.slice(2).map((event) => event.type)).toEqual([
      "response.created",
      "response.done",
    ]);
    expect(events.at(-1)?.response).toMatchObject({
      status: "failed",
      status_details: { type: "failed", reason: "tts_failed" },
      output: [],
    });
  });

  it("maps namespaced business commands and observer events without treating close as end", async () => {
    const events: Record<string, any>[] = [];
    const endRequests: string[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "aaaabbbbccccddddeeeeffff00001111",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: async () => undefined,
        cancelActiveResponse: () => undefined,
        requestSessionEnd: (reason) => endRequests.push(reason),
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "viva.session.end",
      event_id: "business_end",
    });
    state.dispatchCoreEvent({ type: "exam_incomplete", reason: "questions_remaining" });
    state.dispatchCoreEvent({
      type: "playback_clear",
      responseGeneration: 51,
      reason: "new_user_turn",
    });
    state.dispatchCoreEvent({ type: "session_ended", reason: "session_end" });

    expect(endRequests).toEqual(["client_request"]);
    expect(events.slice(2)).toMatchObject([
      {
        type: "viva.exam.incomplete",
        viva_version: "1",
        reason: "questions_remaining",
      },
      {
        type: "viva.playback.clear",
        viva_version: "1",
        response_generation: 51,
        reason: "new_user_turn",
      },
      {
        type: "viva.session.ended",
        viva_version: "1",
        reason: "session_end",
      },
    ]);
  });

  it("keeps a late committed final on its old turn while the next same-epoch input receives", async () => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "bbbbccccddddeeeeffff000011112222",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: async () => undefined,
        cancelActiveResponse: () => undefined,
        requestSessionEnd: () => undefined,
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 6).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 0,
      audioStartMs: 0,
    });
    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 0,
      audioEndMs: 100,
    });
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 7).toString("base64"),
    });

    state.dispatchCoreEvent({
      type: "user_transcript_final",
      inputEpoch: 0,
      inputTurnId: 0,
      transcript: "old final",
    });
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 1,
      audioStartMs: 110,
    });
    state.dispatchCoreEvent({
      type: "user_transcript_final",
      inputEpoch: 0,
      inputTurnId: 1,
      transcript: "new final",
    });
    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 1,
      audioEndMs: 220,
    });

    const done = events.filter((event) => event.type === "conversation.item.done");
    expect(done.map((event) => event.item.content[0].transcript)).toEqual([
      "old final",
      "new final",
    ]);
    expect(done[0].item.id).not.toBe(done[1].item.id);
  });

  it("allocates the next server-VAD item from its first authoritative callback", async () => {
    const events: Record<string, any>[] = [];
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "bbbbccccddddeeeeffff000011113333",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: async () => undefined,
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 6).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 0,
    });

    // This PCM can already be queued toward the GPU when its previous VAD
    // boundary arrives in the opposite WebSocket direction.
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 7).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "user_transcript_final",
      inputEpoch: 0,
      inputTurnId: 0,
      transcript: "first",
    });
    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 0,
    });

    expect(() =>
      state.dispatchCoreEvent({
        type: "input_speech_started",
        inputEpoch: 0,
        inputTurnId: 1,
      }),
    ).not.toThrow();
    state.dispatchCoreEvent({
      type: "user_transcript_final",
      inputEpoch: 0,
      inputTurnId: 1,
      transcript: "second",
    });
    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 1,
    });

    const done = events.filter((event) => event.type === "conversation.item.done");
    expect(done.map((event) => event.item.content[0].transcript)).toEqual([
      "first",
      "second",
    ]);
    expect(done[0].item.id).not.toBe(done[1].item.id);
  });

  it("closes a committed old turn during clear before the reset ack fence", async () => {
    const events: Record<string, any>[] = [];
    let releaseReset!: () => void;
    const state = new OpenAIRealtimeSessionState({
      connectionNamespace: "ccccddddeeeeffff1111222233334444",
      emit: (event) => events.push(event),
      core: {
        pushInputPcm: () => undefined,
        commitInput: () => undefined,
        resetInput: () =>
          new Promise<void>((resolve) => {
            releaseReset = resolve;
          }),
      },
    });
    state.open();
    await state.dispatchClientEvent({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(960, 8).toString("base64"),
    });
    state.dispatchCoreEvent({
      type: "input_speech_started",
      inputEpoch: 0,
      inputTurnId: 3,
    });
    state.dispatchCoreEvent({
      type: "input_committed",
      inputEpoch: 0,
      inputTurnId: 3,
    });

    const clear = state.dispatchClientEvent({
      type: "input_audio_buffer.clear",
      event_id: "clear_after_commit",
    });
    state.dispatchCoreEvent({
      type: "user_transcript_final",
      inputEpoch: 0,
      inputTurnId: 3,
      transcript: "late but ordered",
    });
    expect(events.at(-1)).toMatchObject({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "late but ordered",
    });

    releaseReset();
    await clear;
    expect(() =>
      state.dispatchCoreEvent({
        type: "user_transcript_final",
        inputEpoch: 0,
        inputTurnId: 3,
        transcript: "after ack",
      }),
    ).toThrow("stale input callback epoch 0");
  });
});
