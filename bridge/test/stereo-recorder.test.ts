/**
 * StereoRecorder 单测 —— 双声道交错 + WAV 头(design contract)。注入假 S3 断言上传 key + 内容。
 */
import { StereoRecorder } from "../src/stereo-recorder";

function fakeS3() {
  const puts: { Bucket: string; Key: string; Body: Buffer }[] = [];
  return {
    puts,
    send: async (cmd: { input: { Bucket: string; Key: string; Body: Buffer } }) => {
      puts.push(cmd.input);
      return {};
    },
  };
}

test("录双声道 → WAV 头正确 + 上传到 by-session key", async () => {
  const s3 = fakeS3();
  const rec = new StereoRecorder("sess_rec", { s3: s3 as never, bucket: "aim-recordings" });
  await rec.start();
  // 喂几帧(对端 L / AI R);用满帧 640B 触发 flush
  const frame = Buffer.alloc(640, 1);
  rec.pushCaller(frame);
  rec.pushAi(Buffer.alloc(640, 2));
  await new Promise((r) => setTimeout(r, 60)); // 等 flush timer 跑几轮
  const key = await rec.stopAndUpload();

  expect(key).toBe("recordings/by-session/sess_rec.wav");
  expect(s3.puts).toHaveLength(1);
  const wav = s3.puts[0].Body;
  // WAV 头校验
  expect(wav.slice(0, 4).toString()).toBe("RIFF");
  expect(wav.slice(8, 12).toString()).toBe("WAVE");
  expect(wav.readUInt16LE(22)).toBe(2); // 2 声道
  expect(wav.readUInt32LE(24)).toBe(16000); // 16k
  expect(wav.readUInt16LE(34)).toBe(16); // 16-bit
  // data 区非空(有交错样本)
  expect(wav.length).toBeGreaterThan(44);
});

test("无桶配置:产文件但不上传(返回 key)", async () => {
  const s3 = fakeS3();
  const rec = new StereoRecorder("sess_nobucket", { s3: s3 as never, bucket: "" });
  await rec.start();
  rec.pushCaller(Buffer.alloc(640, 1));
  await new Promise((r) => setTimeout(r, 40));
  const key = await rec.stopAndUpload();
  expect(key).toBe("recordings/by-session/sess_nobucket.wav");
  expect(s3.puts).toHaveLength(0);
});
