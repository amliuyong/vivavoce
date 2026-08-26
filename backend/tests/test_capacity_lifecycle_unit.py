"""lifecycle-handler 单测(design contract):实例终止 drain —— 记 token / 空闲 Complete / 忙 heartbeat / poll 重查。

mock autoscaling + ecs 客户端;DDB 用 app_and_db 的 moto。注入 monkeypatch 替换 _aws()。
"""
from __future__ import annotations

import pytest

import app.capacity_lifecycle as lc


class FakeAsg:
    def __init__(self, complete_raises=False):
        self.completed: list[dict] = []
        self.heartbeats: list[dict] = []
        self._complete_raises = complete_raises

    def complete_lifecycle_action(self, **kw):
        if self._complete_raises:
            raise RuntimeError("ValidationError: No active Lifecycle Action found")
        self.completed.append(kw)

    def record_lifecycle_action_heartbeat(self, **kw):
        self.heartbeats.append(kw)


class FakeEcs:
    """busy=True → list_tasks 返回非空(实例上有 RUNNING task)。raise_on_query=True → API 抛错。"""

    def __init__(self, busy: bool, raise_on_query: bool = False):
        self._busy = busy
        self._raise = raise_on_query
        self.last_filter: str | None = None

    def list_container_instances(self, **kw):
        if self._raise:
            raise RuntimeError("simulated ECS API failure")
        self.last_filter = kw.get("filter")
        return {"containerInstanceArns": ["arn:ci/abc"]} if self._busy else {"containerInstanceArns": []}

    def list_tasks(self, **kw):
        return {"taskArns": ["arn:task/1"]} if self._busy else {"taskArns": []}


@pytest.fixture
def db(app_and_db):
    _, d = app_and_db
    return d


def _patch_aws(monkeypatch, db, asg, ecs):
    monkeypatch.setattr(lc, "load_settings", lambda: db.settings)
    monkeypatch.setattr(lc, "Db", lambda _settings: db)
    monkeypatch.setattr(lc, "_aws", lambda: (asg, ecs, "AimTest-gpu", "AimTest-gpu-asg"))


def _term_event(instance="i-123", token="tok-1"):
    return {
        "detail": {
            "LifecycleTransition": "autoscaling:EC2_INSTANCE_TERMINATING",
            "EC2InstanceId": instance,
            "LifecycleActionToken": token,
        }
    }


def test_idle_instance_completed_immediately(monkeypatch, db):
    asg, ecs = FakeAsg(), FakeEcs(busy=False)
    _patch_aws(monkeypatch, db, asg, ecs)
    res = lc.on_lifecycle(_term_event("i-idle", "tok-idle"))
    assert res["action"] == "completed"
    assert len(asg.completed) == 1 and asg.completed[0]["InstanceId"] == "i-idle"
    # token 已清(完成后不再挂起)
    assert db.list_lifecycle_tokens() == []


def test_busy_instance_heartbeat_and_token_persisted(monkeypatch, db):
    asg, ecs = FakeAsg(), FakeEcs(busy=True)
    _patch_aws(monkeypatch, db, asg, ecs)
    res = lc.on_lifecycle(_term_event("i-busy", "tok-busy"))
    assert res["action"] == "heartbeat_busy"
    assert len(asg.heartbeats) == 1 and len(asg.completed) == 0
    # token 持久化(留待 poll 重查,非 fire-once)
    tokens = db.list_lifecycle_tokens()
    assert len(tokens) == 1 and tokens[0]["instance_id"] == "i-busy"


def test_poll_completes_when_instance_drained(monkeypatch, db):
    # 先记一个忙实例 token
    asg, ecs_busy = FakeAsg(), FakeEcs(busy=True)
    _patch_aws(monkeypatch, db, asg, ecs_busy)
    lc.on_lifecycle(_term_event("i-1", "tok-1"))
    assert len(db.list_lifecycle_tokens()) == 1

    # poll:此时实例已 drain 空 → Complete + 清 token
    asg2, ecs_idle = FakeAsg(), FakeEcs(busy=False)
    _patch_aws(monkeypatch, db, asg2, ecs_idle)
    res = lc.on_lifecycle({"poll": True})
    assert any(r["action"] == "completed" for r in res["polled"])
    assert len(asg2.completed) == 1
    assert db.list_lifecycle_tokens() == []  # drain 完即清


def test_poll_keeps_heartbeat_while_busy(monkeypatch, db):
    asg, ecs_busy = FakeAsg(), FakeEcs(busy=True)
    _patch_aws(monkeypatch, db, asg, ecs_busy)
    lc.on_lifecycle(_term_event("i-2", "tok-2"))
    # poll 仍忙 → 续 heartbeat,token 留
    asg2, ecs_busy2 = FakeAsg(), FakeEcs(busy=True)
    _patch_aws(monkeypatch, db, asg2, ecs_busy2)
    res = lc.on_lifecycle({"poll": True})
    assert any(r["action"] == "heartbeat_busy" for r in res["polled"])
    assert len(asg2.heartbeats) == 1
    assert len(db.list_lifecycle_tokens()) == 1  # 仍挂起


def test_term_event_without_token_skipped(monkeypatch, db):
    asg, ecs = FakeAsg(), FakeEcs(busy=False)
    _patch_aws(monkeypatch, db, asg, ecs)
    res = lc.on_lifecycle({"detail": {"LifecycleTransition": "autoscaling:EC2_INSTANCE_TERMINATING"}})
    assert res == {"skipped": "no_token"}


def test_ecs_filter_value_single_quoted(monkeypatch, db):
    """review_container_instances filter 的 ec2InstanceId 值必须单引号包裹。"""
    asg, ecs = FakeAsg(), FakeEcs(busy=False)
    _patch_aws(monkeypatch, db, asg, ecs)
    lc.on_lifecycle(_term_event("i-quote", "tok-q"))
    assert ecs.last_filter == "ec2InstanceId == 'i-quote'"  # 带单引号


def test_complete_clears_token_even_if_complete_raises(monkeypatch, db):
    """review 抛错(token 已失效)→ 仍清 token 防 zombie 反复撞,不冒泡。"""
    asg, ecs = FakeAsg(complete_raises=True), FakeEcs(busy=False)
    _patch_aws(monkeypatch, db, asg, ecs)
    res = lc.on_lifecycle(_term_event("i-zombie", "tok-stale"))
    assert res["action"] == "completed"  # 不冒泡
    assert db.list_lifecycle_tokens() == []  # token 已清(防下轮重撞)


def test_poll_isolates_per_item_failure(monkeypatch, db):
    """review 中首条坏 token 不能让其余实例 heartbeat 全漏(单条隔离)。"""
    # 记两个忙实例 token
    asg, ecs_busy = FakeAsg(), FakeEcs(busy=True)
    _patch_aws(monkeypatch, db, asg, ecs_busy)
    lc.on_lifecycle(_term_event("i-a", "tok-a"))
    lc.on_lifecycle(_term_event("i-b", "tok-b"))
    assert len(db.list_lifecycle_tokens()) == 2

    # poll:让 _instance_busy 对第一个抛、第二个正常(用 ecs 抛错模拟,但 _instance_busy 自己 catch 返 True)
    # 这里更直接:让 heartbeat 对所有抛错也不应中断循环 → 两条都被处理(各记一次尝试)
    class FlakyAsg(FakeAsg):
        def record_lifecycle_action_heartbeat(self, **kw):
            if kw["InstanceId"] == "i-a":
                raise RuntimeError("throttle")
            super().record_lifecycle_action_heartbeat(**kw)

    asg2, ecs_busy2 = FlakyAsg(), FakeEcs(busy=True)
    _patch_aws(monkeypatch, db, asg2, ecs_busy2)
    res = lc.on_lifecycle({"poll": True})
    # 两条都被遍历(i-a heartbeat 抛错被 _complete_or_heartbeat 内 catch → action heartbeat_busy;i-b 正常)
    insts = {r["instance"] for r in res["polled"]}
    assert insts == {"i-a", "i-b"}  # i-a 失败未中断 i-b
    assert len(asg2.heartbeats) == 1 and asg2.heartbeats[0]["InstanceId"] == "i-b"


def test_ecs_query_error_treated_as_busy_not_slaughtered(monkeypatch, db):
    """review:_instance_busy 查询异常 → 视作'忙'(续 heartbeat,不放行终止),不腰斩在途。"""
    asg, ecs = FakeAsg(), FakeEcs(busy=False, raise_on_query=True)
    _patch_aws(monkeypatch, db, asg, ecs)
    res = lc.on_lifecycle(_term_event("i-err", "tok-err"))
    assert res["action"] == "heartbeat_busy"  # 异常按忙处理
    assert len(asg.completed) == 0  # 绝不立即放行终止
    assert len(asg.heartbeats) == 1
    assert len(db.list_lifecycle_tokens()) == 1  # token 留待重查
