/**
 * 双声道录音:L=对端、R=AI,16k/16-bit/20ms 帧对齐,
 * 收尾写 WAV 头并上传 S3(KMS 加密由桶策略保证)。键 = session_id(与 Session 1:1)。
 *
 * 不在内存里无限堆:每 20ms flush 一帧到本地临时文件,结束时补 WAV 头 + 上传 + 删本地。
 * S3 不可用时不抛(录音是旁路,不应拖垮通话)。
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { promises as fs } from "node:fs";
import path from "node:path";

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES_MONO = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // 640B
const LOCAL_DIR = process.env.RECORDING_TMP_DIR ?? "/tmp/aim-recordings";

export interface RecorderDeps {
  s3?: { send: (cmd: unknown) => Promise<unknown> };
  bucket?: string;
  now?: () => number;
}

export class StereoRecorder {
  private callerQueue: Buffer[] = [];
  private aiQueue: Buffer[] = [];
  private fh: fs.FileHandle | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private bytesWritten = 0;
  private filePath: string;
  private readonly s3: { send: (cmd: unknown) => Promise<unknown> };
  private readonly bucket: string;

  constructor(private sessionId: string, deps: RecorderDeps = {}) {
    this.s3 = deps.s3 ?? (new S3Client({}) as unknown as { send: (cmd: unknown) => Promise<unknown> });
    this.bucket = deps.bucket ?? process.env.RECORDING_BUCKET_NAME ?? "";
    this.filePath = path.join(LOCAL_DIR, `${sessionId}.wav`);
  }

  async start(): Promise<void> {
    await fs.mkdir(LOCAL_DIR, { recursive: true });
    this.fh = await fs.open(this.filePath, "w");
    await this.fh.write(Buffer.alloc(44)); // 预留 WAV 头,收尾回填
    this.bytesWritten = 0;
    this.flushTimer = setInterval(() => {
      void this.flushFrame();
    }, FRAME_MS);
  }

  pushCaller(pcm: Buffer): void {
    this.callerQueue.push(pcm);
  }
  pushAi(pcm: Buffer): void {
    this.aiQueue.push(pcm);
  }

  private drain(queue: Buffer[], want: number): Buffer {
    const out = Buffer.alloc(want); // 不足补静音(零)
    let off = 0;
    while (off < want && queue.length > 0) {
      const head = queue[0];
      const take = Math.min(head.length, want - off);
      head.copy(out, off, 0, take);
      off += take;
      if (take === head.length) queue.shift();
      else queue[0] = head.subarray(take);
    }
    return out;
  }

  private async flushFrame(): Promise<void> {
    if (!this.fh) return;
    if (this.callerQueue.length === 0 && this.aiQueue.length === 0) return;
    const left = this.drain(this.callerQueue, FRAME_BYTES_MONO);
    const right = this.drain(this.aiQueue, FRAME_BYTES_MONO);
    const samples = FRAME_BYTES_MONO / 2;
    const stereo = Buffer.alloc(FRAME_BYTES_MONO * 2);
    for (let i = 0; i < samples; i++) {
      stereo.writeInt16LE(left.readInt16LE(i * 2), i * 4); // L
      stereo.writeInt16LE(right.readInt16LE(i * 2), i * 4 + 2); // R
    }
    await this.fh.write(stereo);
    this.bytesWritten += stereo.length;
  }

  /** 收尾:停 flush → 回填 WAV 头 → 上传 S3 → 删本地。返回 S3 key 或 null。 */
  async stopAndUpload(): Promise<string | null> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // flush 残余
    for (let i = 0; i < 4 && (this.callerQueue.length || this.aiQueue.length); i++) {
      await this.flushFrame();
    }
    if (!this.fh) return null;
    await this.fh.write(this.wavHeader(this.bytesWritten), 0, 44, 0); // 回填头
    await this.fh.close();
    this.fh = null;

    const key = `recordings/by-session/${this.sessionId}.wav`;
    if (!this.bucket) return key; // 无桶配置(本地/测试):只产文件,不上传
    try {
      const body = await fs.readFile(this.filePath);
      await this.s3.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: "audio/wav" }),
      );
      await fs.unlink(this.filePath).catch(() => {});
      return key;
    } catch (e) {
      console.warn(`[recorder] upload failed for ${this.sessionId}:`, (e as Error).message);
      return null;
    }
  }

  /** 标准 44 字节 PCM WAV 头(2ch / 16k / 16-bit)。 */
  private wavHeader(dataLen: number): Buffer {
    const h = Buffer.alloc(44);
    const channels = 2;
    const bitsPerSample = 16;
    const byteRate = (SAMPLE_RATE * channels * bitsPerSample) / 8;
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + dataLen, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(SAMPLE_RATE, 24);
    h.writeUInt32LE(byteRate, 28);
    h.writeUInt16LE((channels * bitsPerSample) / 8, 32);
    h.writeUInt16LE(bitsPerSample, 34);
    h.write("data", 36);
    h.writeUInt32LE(dataLen, 40);
    return h;
  }
}
