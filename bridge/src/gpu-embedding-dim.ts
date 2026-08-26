/**
 * 声纹 embedding 维度(design contract)—— 与 GPU `gpu_service/protocol.py::SPEAKER_EMBEDDING_DIM` 对称。
 * CAM++(ModelScope iic/speech_campplus_sv_zh-cn_16k-common)输出 192 维。两端 MUST 一致:
 * GPU 产出此维、bridge 按此维校验 + cosine 比对(维度不符视为异常 → fail-open)。
 */
export const SPEAKER_EMBEDDING_DIM = 192;
