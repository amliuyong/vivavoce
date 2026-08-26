"""GPU 容量管理 e2e(design contract)—— admin 端点 CRUD / 403 / 乐观锁 409 / 闸门动态容量。"""
from __future__ import annotations


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_get_capacity_empty_initially(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    r = client.get("/api/admin/gpu-capacity", headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["config"] is None  # 首次未配置
    assert body["live"] is None
    assert body["hard_max"] == 8


def test_put_capacity_fixed_then_get(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    r = client.put("/api/admin/gpu-capacity", json={"mode": "fixed", "fixed_count": 3}, headers=admin)
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["mode"] == "fixed" and saved["fixed_count"] == 3
    assert saved["config_version"] == 1
    assert saved["updated_by"]
    # 回显
    got = client.get("/api/admin/gpu-capacity", headers=admin).json()
    assert got["config"]["fixed_count"] == 3


def test_put_capacity_auto_allows_min_zero(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    r = client.put("/api/admin/gpu-capacity",
                   json={"mode": "auto", "auto_min": 0, "auto_max": 5, "target_util": 0.7},
                   headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["auto_min"] == 0  # 空闲自动缩 0 省钱


def test_put_capacity_invalid_400(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    r = client.put("/api/admin/gpu-capacity", json={"mode": "fixed", "fixed_count": 999}, headers=admin)
    assert r.status_code == 400


def test_put_capacity_non_admin_403(client, make_token):
    staff = _auth(make_token(groups=["staff"]))
    r = client.put("/api/admin/gpu-capacity", json={"mode": "fixed", "fixed_count": 1}, headers=staff)
    assert r.status_code == 403


def test_put_capacity_optimistic_lock_conflict_409(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    # 首次创建(无 expected_version)
    first = client.put("/api/admin/gpu-capacity", json={"mode": "fixed", "fixed_count": 1}, headers=admin)
    assert first.status_code == 200
    ver = first.json()["config_version"]  # =1
    # admin A 用正确版本改 → 成功(version→2)
    ok = client.put("/api/admin/gpu-capacity",
                    json={"mode": "fixed", "fixed_count": 2, "expected_version": ver}, headers=admin)
    assert ok.status_code == 200 and ok.json()["config_version"] == 2
    # admin B 仍拿旧版本 ver=1 改 → 冲突 409
    conflict = client.put("/api/admin/gpu-capacity",
                          json={"mode": "fixed", "fixed_count": 5, "expected_version": ver}, headers=admin)
    assert conflict.status_code == 409


def test_put_capacity_existing_without_version_409(client, make_token):
    admin = _auth(make_token(groups=["admin"]))
    client.put("/api/admin/gpu-capacity", json={"mode": "fixed", "fixed_count": 1}, headers=admin)
    # 已有配置但 PUT 不带 expected_version → 拒绝盲写
    r = client.put("/api/admin/gpu-capacity", json={"mode": "fixed", "fixed_count": 2}, headers=admin)
    assert r.status_code == 409


def test_gate_blocks_when_serviceable_zero(client, make_token, app_and_db):
    """闸门动态容量:reconciler 回写 serviceable=0(新鲜)→ 发起被容量挡下(退回 scheduled)。"""
    from datetime import UTC, datetime

    app, db = app_and_db
    # admin 停机:写 live 实况 serviceable=0 + intent_zero,新鲜
    db.update_gpu_capacity_live({
        "serviceable_concurrency": 0,
        "intent_zero": True,
        "observed_at": datetime.now(UTC).isoformat(),
    })
    from app.session_service import SessionService
    svc = SessionService(db, max_concurrency=8)
    eff = svc._effective_max_concurrency(datetime.now(UTC).isoformat())
    assert eff == 0  # 容量为 0 → 闸门有效上限 0,所有发起排队/拒


def test_gate_uses_min_of_static_and_serviceable(client, make_token, app_and_db):
    from datetime import UTC, datetime

    app, db = app_and_db
    db.update_gpu_capacity_live({
        "serviceable_concurrency": 6,
        "intent_zero": False,
        "observed_at": datetime.now(UTC).isoformat(),
    })
    from app.session_service import SessionService
    svc = SessionService(db, max_concurrency=3)  # 静态安全阀更小
    eff = svc._effective_max_concurrency(datetime.now(UTC).isoformat())
    assert eff == 3  # min(3, 6)


def test_gate_stale_uses_last_known(app_and_db):
    """实况过期(observed_at 很旧)+ 非停机 + 最后已知>0 → 继续用最后已知值,不砍。"""
    app, db = app_and_db
    db.update_gpu_capacity_live({
        "serviceable_concurrency": 9,
        "intent_zero": False,
        "observed_at": "2020-01-01T00:00:00+00:00",  # 远古 = 过期
    })
    from datetime import UTC, datetime

    from app.session_service import SessionService
    svc = SessionService(db, max_concurrency=15, capacity_freshness_min=5)
    eff = svc._effective_max_concurrency(datetime.now(UTC).isoformat())
    assert eff == 9  # min(15, 9);不因过期砍到 1


def test_gate_autoscale_not_capped_by_static(app_and_db):
    """review 自动扩容后 serviceable=12,静态硬顶=24 → 闸门=12(不被旧静态值 3 封死)。"""
    from datetime import UTC, datetime

    app, db = app_and_db
    db.update_gpu_capacity_live({
        "serviceable_concurrency": 12,  # 4 实例 × 3
        "intent_zero": False,
        "observed_at": datetime.now(UTC).isoformat(),
    })
    from app.session_service import SessionService
    # 硬顶 24(=GPU_HARD_MAX×3),保守兜底只 8 —— 但 live 新鲜,应取 serviceable=12,非兜底
    svc = SessionService(db, max_concurrency=24)
    eff = svc._effective_max_concurrency(datetime.now(UTC).isoformat())
    assert eff == 12  # 弹性生效:不被静态封死


def test_gate_missing_live_uses_conservative_fallback(app_and_db, monkeypatch):
    """live 缺失(首次部署)→ 用保守兜底(单实例并发),非硬顶 24(避免首启超派)。"""
    from datetime import UTC, datetime

    app, db = app_and_db
    # 不写 live(缺失);conftest 的 gpu_capacity_static_fallback=8
    from app.session_service import SessionService
    svc = SessionService(db, max_concurrency=24)
    eff = svc._effective_max_concurrency(datetime.now(UTC).isoformat())
    assert eff == 8  # min(24 硬顶, 8 保守兜底)= 8,不按硬顶 24 超派
