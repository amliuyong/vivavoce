"""录音访问层单测(design contract):key 推导 + 预签名 URL 存在性门控,不连真实 S3。"""
from __future__ import annotations

from botocore.exceptions import ClientError, NoCredentialsError

from app.config import load_settings
from app.recording import RecordingStore, recording_key


def _settings(bucket: str):
    import os

    os.environ["RECORDING_BUCKET_NAME"] = bucket
    try:
        return load_settings()
    finally:
        os.environ.pop("RECORDING_BUCKET_NAME", None)


class _FakeS3:
    def __init__(self, exists: bool):
        self._exists = exists
        self.head_calls: list[tuple] = []

    def head_object(self, Bucket, Key):
        self.head_calls.append((Bucket, Key))
        if not self._exists:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        return {"ContentLength": 123}

    def generate_presigned_url(self, op, Params, ExpiresIn):
        assert op == "get_object"
        return f"https://signed.example/{Params['Key']}?exp={ExpiresIn}"


def test_recording_key_matches_bridge_convention():
    assert recording_key("sess_abc") == "recordings/by-session/sess_abc.wav"


def test_presigned_url_when_object_exists():
    s3 = _FakeS3(exists=True)
    store = RecordingStore(_settings("aim-rec"), client=s3)
    url = store.presigned_url("sess_abc")
    assert url == "https://signed.example/recordings/by-session/sess_abc.wav?exp=900"
    assert s3.head_calls == [("aim-rec", "recordings/by-session/sess_abc.wav")]


def test_presigned_url_none_when_object_missing():
    s3 = _FakeS3(exists=False)
    store = RecordingStore(_settings("aim-rec"), client=s3)
    assert store.presigned_url("sess_missing") is None


def test_presigned_url_none_when_no_bucket_configured():
    # 桶未配(本地/测试):直接 None,不触 boto3、不抛
    store = RecordingStore(_settings(""), client=_FakeS3(exists=True))
    assert store.presigned_url("sess_x") is None


def test_presigned_url_none_on_credential_or_network_error():
    # 凭证缺失/网络错误(BotoCoreError 而非 ClientError):静默降级 None,不让 /results 500
    class _BrokenS3:
        def head_object(self, Bucket, Key):
            raise NoCredentialsError()

    store = RecordingStore(_settings("aim-rec"), client=_BrokenS3())
    assert store.presigned_url("sess_x") is None
