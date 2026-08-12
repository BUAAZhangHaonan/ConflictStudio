from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from backend.adapters.config import Settings
from backend.adapters.llm import UnconfiguredPromptModel
from backend.adapters.renderer import CancelOutcome, RendererInstallationStatus
from backend.app import create_app
from backend.domain.enums import GpuAvailability
from backend.domain.models import GpuSlot


def client_for(tmp_path: Path, renderer: object | None = None) -> TestClient:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    return TestClient(create_app(Settings(data_root=tmp_path, frontend_dist=frontend), UnconfiguredPromptModel(), renderer))


def write_frontend(frontend: Path) -> None:
    frontend.mkdir(exist_ok=True)
    (frontend / "index.html").write_text("<!doctype html><title>ConflictStudio</title><main>index</main>", encoding="utf-8")
    assets = frontend / "assets"
    assets.mkdir(exist_ok=True)
    (assets / "app.js").write_text("console.log('app')", encoding="utf-8")


class _ConfiguredRendererGateway:
    configured = True

    async def probe(self, slot):  # type: ignore[no-untyped-def]
        return slot

    async def installation_status(self) -> RendererInstallationStatus:
        return RendererInstallationStatus.INSTALLED

    async def submit(self, request):  # type: ignore[no-untyped-def]
        return "probe"

    async def wait(self, slot, prompt_id):  # type: ignore[no-untyped-def]
        return ()

    async def cancel(self, slot, prompt_id):  # type: ignore[no-untyped-def]
        return CancelOutcome.CANCELLED

    async def close(self) -> None:
        return None


def test_health_and_initial_gpu_state(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        response = client.get("/api/health")
        gpu_response = client.get("/api/gpu-slots")

    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "database": "ready",
        "promptServiceConfigured": False,
        "rendererInstallation": "notConfigured",
    }
    assert [row["availability"] for row in gpu_response.json()] == ["Unknown", "Unknown"]


def test_health_reports_not_installed_renderer_units(tmp_path: Path) -> None:
    class NotInstalledRenderer(_ConfiguredRendererGateway):
        async def installation_status(self) -> RendererInstallationStatus:
            return RendererInstallationStatus.NOT_INSTALLED

    with client_for(tmp_path, NotInstalledRenderer()) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["rendererInstallation"] == "notInstalled"


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


def content_plan_request(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "name": "Aligned response",
        "category": "A-VA",
        "mode": "Generative",
        "status": "Active",
        "trueEmotion": "calm",
        "apparentEmotion": "calm",
        "scene": "A private office.",
        "triggerEvent": "A timer sounds.",
        "psychologicalBackground": "The subject prepares a brief response.",
        "contentRequirements": "Describe one adult responding in the room.",
    }
    values.update(overrides)
    return values


def test_content_plan_create_and_update_enforce_emotion_relation(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        invalid_create = client.post(
            "/api/content-plans",
            json=content_plan_request(apparentEmotion="tense"),
        )
        created = client.post("/api/content-plans", json=content_plan_request())
        invalid_update = client.patch(
            f"/api/content-plans/{created.json()['id']}",
            json={"expectedRevision": created.json()["revision"], "apparentEmotion": "tense"},
        )

    assert invalid_create.status_code == 422
    assert invalid_create.json()["error"]["code"] == "validation_error"
    assert created.status_code == 201
    assert invalid_update.status_code == 422
    assert invalid_update.json()["error"]["code"] == "validation_error"


def background_request(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "name": "Private office",
        "scene": "A private office containing one chair and one desk.",
        "ambientSound": "A steady ventilation hum remains audible.",
        "participantRelationship": "The subject is the only occupant in view.",
        "lighting": "Soft daylight enters through one window.",
        "framing": "Use a static eye-level medium shot.",
    }
    values.update(overrides)
    return values


def test_background_create_accepts_natural_scene_use_of_emotion_word(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        response = client.post(
            "/api/video-background-presets",
            json=background_request(scene="Alone in a small kitchen, preparing a surprise breakfast."),
        )

    assert response.status_code == 201


@pytest.mark.parametrize(
    ("field", "expected_field", "value", "message"),
    [
        ("participantRelationship", "participantRelationship", "A second person stands off camera.", "another person"),
        ("ambientSound", "ambientSound", "A soft soundtrack plays nearby.", "music or score terms"),
        ("lighting", "lighting", "The lighting creates a sad atmosphere.", "emotion labels"),
        ("scene", "scene", "The A-VT protocol applies in this office.", "internal category or protocol names"),
    ],
)
def test_background_create_returns_field_specific_policy_error(
    tmp_path: Path,
    field: str,
    expected_field: str,
    value: str,
    message: str,
) -> None:
    with client_for(tmp_path) as client:
        response = client.post(
            "/api/video-background-presets",
            json=background_request(**{field: value}),
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    fields = response.json()["error"]["details"]["fields"]
    assert fields[0]["field"] == expected_field
    assert message in fields[0]["message"]


@pytest.mark.parametrize(
    ("field", "expected_field", "value", "message"),
    [
        ("participantRelationship", "participantRelationship", "A second person stands off camera.", "another person"),
        ("ambientSound", "ambientSound", "A soft soundtrack plays nearby.", "music or score terms"),
        ("lighting", "lighting", "The lighting creates a sad atmosphere.", "emotion labels"),
        ("scene", "scene", "The A-VT protocol applies in this office.", "internal category or protocol names"),
    ],
)
def test_background_update_returns_field_specific_policy_error(
    tmp_path: Path,
    field: str,
    expected_field: str,
    value: str,
    message: str,
) -> None:
    with client_for(tmp_path) as client:
        created = client.post("/api/video-background-presets", json=background_request())
        response = client.patch(
            f"/api/video-background-presets/{created.json()['id']}",
            json={"expectedRevision": created.json()["revision"], field: value},
        )

    assert created.status_code == 201
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    fields = response.json()["error"]["details"]["fields"]
    assert fields[0]["field"] == expected_field
    assert message in fields[0]["message"]


def test_unknown_api_route_does_not_return_frontend(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        response = client.get("/api/removed-placeholder")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_frontend_deep_links_use_index_and_api_paths_stay_on_api(tmp_path: Path) -> None:
    frontend = tmp_path / "frontend"
    write_frontend(frontend)
    client = TestClient(create_app(Settings(data_root=tmp_path, frontend_dist=frontend), UnconfiguredPromptModel()))
    try:
        index = client.get("/")
        deep_link = client.get("/review/42")
        asset = client.get("/assets/app.js")
        unknown_extension = client.get("/missing-file.txt")
        api = client.get("/api/health")
        api_ws = client.get("/api/ws/jobs/1")
    finally:
        client.close()

    assert index.status_code == 200
    assert index.text.startswith("<!doctype html>")
    assert index.headers["cache-control"] == "no-store"
    assert "etag" not in index.headers
    assert deep_link.status_code == 200
    assert deep_link.text == index.text
    assert asset.status_code == 200
    assert asset.text == "console.log('app')"
    assert "etag" not in asset.headers
    assert unknown_extension.status_code == 404
    assert unknown_extension.json()["error"]["code"] == "not_found"
    assert api.status_code == 200
    assert api.json()["database"] == "ready"
    assert api_ws.status_code == 404
    assert api_ws.json()["error"]["code"] == "not_found"


def test_prompt_preview_is_read_only_and_returns_typed_inputs(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        content = client.post(
            "/api/content-plans",
            json={
                "name": "Aligned response",
                "category": "A-VA",
                "mode": "Generative",
                "status": "Active",
                "trueEmotion": "calm",
                "apparentEmotion": "calm",
                "scene": "A private office.",
                "triggerEvent": "A timer sounds.",
                "psychologicalBackground": "The subject prepares a brief response.",
                "contentRequirements": "Describe one adult responding in the room.",
            },
        )
        prompt = client.post(
            "/api/prompt-presets",
            json={
                "name": "Natural shot",
                "category": "A-VA",
                "styleGuidance": "Use a static medium shot.",
                "finalRenderNegativeConstraints": "subtitles, captions, distortion",
            },
        )
        background = client.post(
            "/api/video-background-presets",
            json={
                "name": "Private office",
                "scene": "A private office containing one chair and one desk.",
                "ambientSound": "A steady ventilation hum is audible.",
                "participantRelationship": "The subject is the only occupant in view.",
                "lighting": "Soft daylight enters through one window.",
                "framing": "Use a static eye-level medium shot.",
            },
        )
        response = client.post(
            "/api/prompt-preview",
            json={
                "contentPlan": {"id": content.json()["id"], "expectedRevision": content.json()["revision"]},
                "promptPreset": {"id": prompt.json()["id"], "expectedRevision": prompt.json()["revision"]},
                "backgroundPreset": {"id": background.json()["id"], "expectedRevision": background.json()["revision"]},
                "demographic": {"age": 25, "gender": "Female", "ethnicity": "EastAsian"},
            },
        )

    assert response.status_code == 200
    assert response.json()["requiresPromptGeneration"] is True
    assert response.json()["finalPositivePrompt"] is None
    assert response.json()["finalNegativePrompt"] == "subtitles, captions, distortion"
    assert response.json()["contentPlan"]["id"] == content.json()["id"]


def test_submit_batch_returns_202_with_location(tmp_path: Path) -> None:
    with client_for(tmp_path, _ConfiguredRendererGateway()) as client:
        dataset = client.post(
            "/api/datasets",
            json={"name": "Production", "purpose": "Production", "note": ""},
        )
        content = client.post(
            "/api/content-plans",
            json={
                "name": "Aligned response",
                "category": "A-VA",
                "mode": "Generative",
                "status": "Active",
                "trueEmotion": "calm",
                "apparentEmotion": "calm",
                "scene": "A private office.",
                "triggerEvent": "A timer sounds.",
                "psychologicalBackground": "The subject prepares a brief response.",
                "contentRequirements": "Describe one adult responding in the room.",
            },
        )
        prompt = client.post(
            "/api/prompt-presets",
            json={
                "name": "Natural shot",
                "category": "A-VA",
                "styleGuidance": "Use a static medium shot.",
                "finalRenderNegativeConstraints": "subtitles, captions, distortion",
            },
        )
        background = client.post(
            "/api/video-background-presets",
            json={
                "name": "Private study",
                "scene": "A private study containing one chair and one desk.",
                "ambientSound": "A steady ventilation hum is audible.",
                "lighting": "Soft daylight from one window.",
                "framing": "Use a static eye-level medium shot.",
            },
        )
        draft = client.post(
            "/api/batch-drafts",
            json={
                "datasetId": dataset.json()["id"],
                "category": "A-VA",
                "model": "LTX-2.3",
                "quantity": 1,
                "contentPlans": [{"id": content.json()["id"], "expectedRevision": content.json()["revision"]}],
                "promptPresets": [{"id": prompt.json()["id"], "expectedRevision": prompt.json()["revision"]}],
                "backgroundPresets": [{"id": background.json()["id"], "expectedRevision": background.json()["revision"]}],
                "demographics": [{"age": 25, "gender": "Female", "ethnicity": "EastAsian"}],
                "gpuSlots": ["GPU0"],
            },
        )

        with client.app.state.database.immediate_session() as session:
            rows = session.exec(select(GpuSlot).order_by(GpuSlot.slot)).all()
            for row in rows:
                row.availability = GpuAvailability.AVAILABLE

        preview = client.post(
            f"/api/batch-drafts/{draft.json()['id']}/preview",
            json={"expectedRevision": draft.json()["revision"]},
        )
        submit = client.post(
            f"/api/batch-drafts/{draft.json()['id']}/submit",
            json={
                "expectedRevision": draft.json()["revision"],
                "expectedGpuRevisions": preview.json()["gpuRevisions"],
            },
        )
        assert submit.status_code == 202
        assert submit.headers["Location"] == f"/api/jobs/{submit.json()['id']}"

    assert preview.status_code == 200
