"""OpenAPI 契约守门 —— code-first:checked-in 的 openapi.json 必须与当前代码产出一致。

改了路由/模型却没更新契约 → 本测试红,提示运行 python scripts/export_openapi.py。
这保证前端据以生成 client 的契约永远反映真实后端。
"""
from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_BACKEND_DIR / "scripts"))


def test_openapi_contract_is_current():
    import export_openapi

    expected = export_openapi.serialize(export_openapi.generate())
    path = export_openapi.OPENAPI_PATH
    assert path.exists(), "缺少 openapi.json,请运行 python scripts/export_openapi.py"
    actual = path.read_text(encoding="utf-8")
    assert actual == expected, (
        "openapi.json 与当前代码不一致 —— 请运行 `python scripts/export_openapi.py` 更新契约后提交"
    )


def test_openapi_covers_all_api_routes():
    """所有 /api/* 路由都进了契约(防漏挂)。"""
    import export_openapi

    spec = export_openapi.generate()
    paths = set(spec.get("paths", {}).keys())
    # 抽查关键端点都在契约里
    for p in [
        "/api/me",
        "/api/agents",
        "/api/agents/{agent_id}",
        "/api/agents/{agent_id}/versions",
        "/api/question-banks",
        "/api/question-banks/{question_bank_id}",
        "/api/question-banks/{question_bank_id}/versions",
        "/api/sessions",
        "/api/sessions/{session_id}",
        "/api/sessions/{session_id}/hangup",
        "/api/results/{session_id}",
        # design contract:API Key 机器管理端点
        "/api/integration/agents",
        "/api/integration/agents/{agent_id}",
        "/api/integration/question-banks",
        "/api/integration/question-banks/{question_bank_id}",
        "/api/integration/results/{session_id}",
        "/api/integration/sessions/{session_id}/realtime-client-secret",
    ]:
        assert p in paths, f"路由 {p} 未出现在 OpenAPI 契约中"
    # design contract:targets CRUD 端点已删,不得再出现在契约里。
    # 会话级重约端点已删(即时开始、无预约);候选人 slot 改约 /api/candidate/reschedule 是招聘环节独立功能,保留。
    for gone in ["/api/targets", "/api/targets/{target_id}", "/api/sessions/{session_id}/reschedule"]:
        assert gone not in paths, f"已删端点 {gone} 仍在 OpenAPI 契约中"
