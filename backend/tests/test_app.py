from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.adapters.config import Settings
from backend.adapters.llm import UnconfiguredPromptModel
from backend.app import create_app


def client_for(tmp_path: Path) -> TestClient:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    return TestClient(create_app(Settings(data_root=tmp_path, frontend_dist=frontend), UnconfiguredPromptModel()))


def test_health_and_initial_gpu_state(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        response = client.get("/api/health")
        gpu_response = client.get("/api/gpu-slots")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "database": "ready", "promptServiceConfigured": False}
    assert [row["availability"] for row in gpu_response.json()] == ["Unknown", "Unknown"]


def test_dataset_crud_uses_camel_case_and_stable_conflict(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        created = client.post(
            "/api/datasets",
            json={"name": "正式生成集", "purpose": "Production", "note": "正式数据"},
        )
        duplicate = client.post(
            "/api/datasets",
            json={"name": "正式生成集", "purpose": "Validation", "note": ""},
        )
        updated = client.patch(
            f"/api/datasets/{created.json()['id']}",
            json={"expectedRevision": created.json()["revision"], "note": "更新后的备注"},
        )
        stale = client.patch(
            f"/api/datasets/{created.json()['id']}",
            json={"expectedRevision": 1, "note": "过期"},
        )

    assert created.status_code == 201
    assert created.json()["createdAt"].endswith("Z")
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "name_conflict"
    assert updated.status_code == 200 and updated.json()["revision"] == 2
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "revision_conflict"


def test_invalid_direction_returns_stable_422(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        response = client.post(
            "/api/content-plans",
            json={
                "name": "无效方向",
                "category": "A-VA",
                "conflictDirection": "Audio",
                "mode": "Fixed",
                "status": "Active",
                "trueEmotion": "calm",
                "apparentEmotion": "calm",
                "scene": "A quiet room.",
                "triggerEvent": "A short question.",
                "psychologicalBackground": "The subject is at ease.",
                "dialogue": "我很好。",
                "trueEmotionDescription": "说话者情绪平静。",
                "baseVideoPrompt": "An adult answers calmly in a quiet room.",
            },
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_unknown_api_route_does_not_return_frontend(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        response = client.get("/api/removed-placeholder")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
