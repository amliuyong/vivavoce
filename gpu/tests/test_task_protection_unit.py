"""TaskProtection 单测(design contract):非 ECS 环境 no-op;有 metadata 时调 update_task_protection。"""
from __future__ import annotations

from gpu_service.task_protection import TaskProtection


def test_noop_without_ecs_metadata(monkeypatch):
    """无 ECS_CONTAINER_METADATA_URI_V4(本地/CI)→ no-op,set 返 True(不阻塞接客)、不调任何 API。"""
    monkeypatch.delenv("ECS_CONTAINER_METADATA_URI_V4", raising=False)
    tp = TaskProtection()
    assert tp._enabled is False
    assert tp.set(True) is True   # no-op 返 True(无保护需求,不阻塞)
    assert tp.set(False) is True


def test_set_calls_update_task_protection(monkeypatch):
    """有 metadata + 可定位 task → set(True/False) 调 update_task_protection,参数正确。"""
    calls: list[dict] = []

    class FakeEcs:
        def update_task_protection(self, **kw):
            calls.append(kw)

    tp = TaskProtection.__new__(TaskProtection)  # 跳过 _init(避免真访问 metadata/boto3)
    tp._enabled = True
    tp._cluster = "AimTest-gpu"
    tp._task_arn = "arn:aws:ecs:us-east-1:111:task/AimTest-gpu/abc"
    tp._client = FakeEcs()

    assert tp.set(True) is True  # 成功返 True
    assert calls[0]["protectionEnabled"] is True
    assert calls[0]["cluster"] == "AimTest-gpu"
    assert calls[0]["tasks"] == [tp._task_arn]
    assert "expiresInMinutes" in calls[0]  # 保护必带过期

    assert tp.set(False) is True
    assert calls[1]["protectionEnabled"] is False
    assert "expiresInMinutes" not in calls[1]  # 解除不带过期


def test_set_swallows_api_error(monkeypatch):
    """API 异常 best-effort 吞(不影响通话)。"""
    class BoomEcs:
        def update_task_protection(self, **kw):
            raise RuntimeError("boom")

    tp = TaskProtection.__new__(TaskProtection)
    tp._enabled = True
    tp._cluster = "c"
    tp._task_arn = "t"
    tp._client = BoomEcs()
    assert tp.set(True) is False  # 不抛,但返 False(供 fail-closed 决策)
