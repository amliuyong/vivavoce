"""录音访问层(design contract)—— 从 session_id 推导固定 S3 key,按需生成限时预签名 URL。

录音由媒体面(bridge/src/stereo-recorder.ts)直接上传到录音桶,key 规约固定:
  recordings/by-session/<session_id>.wav        (双声道,L=对端/R=AI,16k s16le)
key 仅含 session_id(同会话多通拨叫覆盖同一文件),故控制面无需媒体面回传具体 key,
直接据 session_id 推导即可。访问全程经**限时预签名 URL**(不直发文件、不公开桶,design contract 数据主权)。

设计原则同 db.py:懒加载 boto3 client(无 AWS 配置的环境 import 不崩);测试可注入 fake client。
"""
from __future__ import annotations

from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from .config import Settings

# 预签名 URL 有效期(秒):报告页临时回放够用,短到降低链接泄漏风险(design contract 限时)。
_PRESIGN_TTL_SECONDS = 15 * 60


def recording_key(session_id: str) -> str:
    """会话录音的固定 S3 key(与 bridge/src/stereo-recorder.ts 规约对称)。"""
    return f"recordings/by-session/{session_id}.wav"


class RecordingStore:
    def __init__(self, settings: Settings, client: Any | None = None):
        self.settings = settings
        # 懒加载:不在构造/import 时连 boto3(否则无 AWS 配置的环境一 import 就崩)。
        # 注入的 client(测试/本地)直接用;否则首次访问时才建真实 client。
        self._s3 = client

    def _client(self):
        if self._s3 is None:
            self._s3 = boto3.client("s3", region_name=self.settings.region)
        return self._s3

    def presigned_url(self, session_id: str) -> str | None:
        """生成会话录音的限时预签名 URL;录音对象不存在(或未配桶)则返回 None。

        先 head_object 确认对象真实存在 —— 避免给前端一个指向不存在文件的链接
        (attempt 标了 has_recording 但上传失败的脏数据,或尚未上传)。
        桶名未配(本地/测试无 RECORDING_BUCKET_NAME)→ 直接 None,不抛。
        """
        bucket = self.settings.recording_bucket
        if not bucket:
            return None
        key = recording_key(session_id)
        client = self._client()
        try:
            client.head_object(Bucket=bucket, Key=key)
        except (ClientError, BotoCoreError):
            # 404 / 403 / 桶不存在 / 凭证缺失 / 网络错误等:无可回放录音,静默降级返回 None
            # (报告页显示「无录音」)。录音是结果页附属功能,不应让任何 S3 问题把 /results 打成 500。
            return None
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=_PRESIGN_TTL_SECONDS,
        )
