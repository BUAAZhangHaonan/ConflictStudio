from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.adapters.config import Settings
from backend.adapters.gpu import SlotInspection
from backend.adapters.llm import OpenAICompatiblePromptModel, UnconfiguredPromptModel
from backend.adapters.renderer import CancelOutcome, RendererInstallationStatus
from backend.api.gpu_contracts import GpuSlotRead
from backend.app import create_app
from backend.domain.enums import GpuAvailability, GpuSlotName, ModelName, Precision
from backend.tests.support import mark_prompt_version_verified


def client_for(
    tmp_path: Path,
    renderer: object | None = None,
    prompt_model: object | None = None,
) -> TestClient:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    return TestClient(
        create_app(
            Settings(data_root=tmp_path, frontend_dist=frontend),
            prompt_model or UnconfiguredPromptModel(),  # type: ignore[arg-type]
            renderer,  # type: ignore[arg-type]
        )
    )


def write_frontend(frontend: Path) -> None:
    frontend.mkdir(exist_ok=True)
    (frontend / "index.html").write_text("<!doctype html><title>ConflictStudio</title><main>index</main>", encoding="utf-8")
    assets = frontend / "assets"
    assets.mkdir(exist_ok=True)
    (assets / "app.js").write_text("console.log('app')", encoding="utf-8")


def create_verified_prompt(client: TestClient) -> dict[str, object]:
    template = client.post(
        "/api/prompt-templates",
        json={"name": "Natural shot", "category": "A-VA"},
    ).json()
    version = client.post(
        f"/api/prompt-templates/{template['id']}/versions",
        json={
            "expectedTemplateRevision": template["revision"],
            "styleGuidance": "Use a static medium shot.",
            "ltxNegativePrompt": "subtitles, captions, distortion",
            "h3NegativePrompt": "subtitles, captions, distortion",
        },
    ).json()
    mark_prompt_version_verified(client.app.state.database, version["id"])
    return client.get(
        f"/api/prompt-template-versions/{version['id']}"
    ).json()


class _ConfiguredRendererGateway:
    configured = True

    def __init__(self) -> None:
        self.states = {
            slot: SlotInspection(
                slot,
                GpuAvailability.AVAILABLE,
                None,
                gpu_name="Test GPU",
                memory_used_mib=0,
                memory_total_mib=24576,
                service_status="stopped",
            )
            for slot in GpuSlotName
        }
        self.probe_calls: list[GpuSlotName] = []
        self.release_calls: list[tuple[GpuSlotName, ModelName, Precision | None, str]] = []

    async def probe(self, slot):  # type: ignore[no-untyped-def]
        self.probe_calls.append(slot)
        return self.states[slot]

    async def installation_status(self) -> RendererInstallationStatus:
        return RendererInstallationStatus.INSTALLED

    async def submit(self, request):  # type: ignore[no-untyped-def]
        return "probe"

    async def wait(self, slot, prompt_id):  # type: ignore[no-untyped-def]
        return ()

    async def cancel(self, slot, prompt_id):  # type: ignore[no-untyped-def]
        return CancelOutcome.CANCELLED

    async def release(  # type: ignore[no-untyped-def]
        self,
        slot,
        *,
        expected_model,
        expected_precision,
        expected_unit,
    ):
        self.release_calls.append((slot, expected_model, expected_precision, expected_unit))
        released = SlotInspection(
            slot,
            GpuAvailability.AVAILABLE,
            None,
            gpu_name="Test GPU",
            memory_used_mib=0,
            memory_total_mib=24576,
            service_status="stopped",
        )
        self.states[slot] = released
        return released

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


def test_gpu_slots_use_a_fresh_live_inspection_and_expose_runtime_evidence(tmp_path: Path) -> None:
    renderer = _ConfiguredRendererGateway()
    renderer.states[GpuSlotName.GPU0] = SlotInspection(
        GpuSlotName.GPU0,
        GpuAvailability.AVAILABLE,
        ModelName.LTX_25,
        owned_unit="conflictstudio-ltx25-int8-gpu0.service",
        loaded_precision=Precision.INT8,
        gpu_name="NVIDIA RTX PRO 6000 Blackwell",
        memory_used_mib=8192,
        memory_total_mib=97887,
        service_status="running",
    )
    with client_for(tmp_path, renderer) as client:
        first = client.get("/api/gpu-slots")
        renderer.states[GpuSlotName.GPU0] = SlotInspection(
            GpuSlotName.GPU0,
            GpuAvailability.AVAILABLE,
            None,
            gpu_name="NVIDIA RTX PRO 6000 Blackwell",
            memory_used_mib=16,
            memory_total_mib=97887,
            service_status="stopped",
        )
        second = client.get("/api/gpu-slots")

    assert first.status_code == second.status_code == 200
    assert first.json()[0] == {
        "slot": "GPU0",
        "availability": "Available",
        "loadedModel": "LTX-2.5",
        "loadedPrecision": "INT8",
        "serviceStatus": "running",
        "gpuName": "NVIDIA RTX PRO 6000 Blackwell",
        "memory": {"usedMiB": 8192, "totalMiB": 97887},
        "activeJobId": None,
        "revision": 2,
        "checkedAt": first.json()[0]["checkedAt"],
        "statusReason": None,
    }
    assert second.json()[0]["loadedModel"] is None
    assert second.json()[0]["serviceStatus"] == "stopped"
    assert second.json()[0]["memory"] == {"usedMiB": 16, "totalMiB": 97887}
    assert second.json()[0]["revision"] == 3
    assert renderer.probe_calls == [
        GpuSlotName.GPU0,
        GpuSlotName.GPU1,
        GpuSlotName.GPU0,
        GpuSlotName.GPU1,
    ]


def test_gpu_contract_rejects_unsupported_service_status() -> None:
    with pytest.raises(ValidationError) as error:
        GpuSlotRead.model_validate(
            {
                "slot": "GPU0",
                "availability": "Available",
                "loadedModel": None,
                "loadedPrecision": None,
                "serviceStatus": "degraded",
                "gpuName": None,
                "memory": {"usedMiB": None, "totalMiB": None},
                "activeJobId": None,
                "revision": 1,
                "checkedAt": "2026-08-13T00:00:00Z",
                "statusReason": None,
            }
        )
    assert error.value.errors()[0]["loc"] == ("serviceStatus",)
    assert error.value.errors()[0]["type"] == "literal_error"


def test_openapi_contains_review_statistics_and_archive_contracts(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        paths = client.get("/openapi.json").json()["paths"]

    expected = {
        "/api/reviewers",
        "/api/reviewers/{reviewer_id}",
        "/api/reviewers/{reviewer_id}/statistics",
        "/api/reviews",
        "/api/reviews/batch",
        "/api/samples/{sample_id}/classification",
        "/api/samples/{sample_id}/classification-history",
        "/api/samples/{sample_id}/review-note-draft",
        "/api/archives",
        "/api/archives/preview",
        "/api/archives/sync",
        "/api/archives/{dataset_id}/manifest",
    }
    assert expected <= set(paths)
    assert "/api/samples/{sample_id}/review" not in paths


def test_dataset_crud_uses_camel_case_and_stable_conflict(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        created = client.post(
            "/api/datasets",
            json={"name": "正式生成集", "note": "正式数据"},
        )
        duplicate = client.post(
            "/api/datasets",
            json={"name": "正式生成集", "note": ""},
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
            "/api/content-scripts",
            json={
                "nameZh": "无效方向",
                "nameEn": "Invalid direction",
                "category": "A-VA",
                "conflictDirection": "Audio",
                "mode": "Fixed",
                "status": "Active",
                "trueEmotion": "calm",
                "apparentEmotion": "calm",
                "sceneZh": "一间安静的房间。",
                "sceneEn": "A quiet room.",
                "triggerEventZh": "有人提出一个简短问题。",
                "triggerEventEn": "A short question is asked.",
                "psychologicalBackgroundZh": "被摄者感到自在。",
                "psychologicalBackgroundEn": "The subject is at ease.",
                "dialogue": "我很好。",
                "trueEmotionDescription": "说话者情绪平静。",
                "baseVideoPrompt": "An adult answers calmly in a quiet room.",
                "contentRequirementsZh": "",
                "contentRequirementsEn": "",
                "sceneSupplementZh": "",
                "sceneSupplementEn": "",
            },
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def content_script_request(scene_ids: list[int], **overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "nameZh": "一致回应",
        "nameEn": "Aligned response",
        "category": "A-VA",
        "mode": "Generative",
        "status": "Active",
        "trueEmotion": "calm",
        "apparentEmotion": "calm",
        "sceneZh": "一间私人办公室。",
        "sceneEn": "A private office.",
        "triggerEventZh": "计时器响起。",
        "triggerEventEn": "A timer sounds.",
        "psychologicalBackgroundZh": "被摄者准备作出简短回应。",
        "psychologicalBackgroundEn": "The subject prepares a brief response.",
        "contentRequirementsZh": "描述一名成年人在房间内回应。",
        "contentRequirementsEn": "Describe one adult responding in the room.",
        "sceneSupplementZh": "",
        "sceneSupplementEn": "",
        "sceneIds": scene_ids,
    }
    values.update(overrides)
    return values


def test_content_script_create_and_update_enforce_emotion_relation(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        background = client.post("/api/scenes", json=background_request()).json()
        invalid_create = client.post(
            "/api/content-scripts",
            json=content_script_request([background["id"]], apparentEmotion="tense"),
        )
        created = client.post("/api/content-scripts", json=content_script_request([background["id"]]))
        invalid_update = client.patch(
            f"/api/content-scripts/{created.json()['id']}",
            json={"expectedRevision": created.json()["revision"], "apparentEmotion": "tense", "sceneIds": [background["id"]]},
        )

    assert invalid_create.status_code == 422
    assert invalid_create.json()["error"]["code"] == "validation_error"
    assert created.status_code == 201
    assert invalid_update.status_code == 422
    assert invalid_update.json()["error"]["code"] == "validation_error"


def background_request(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "nameZh": "私人办公室",
        "nameEn": "Private office",
        "sceneZh": "一间有一把椅子和一张书桌的私人办公室。",
        "sceneEn": "A private office containing one chair and one desk.",
        "ambientSoundZh": "能听到稳定的通风声。",
        "ambientSoundEn": "A steady ventilation hum remains audible.",
        "participantRelationshipZh": "画面中只有被摄者。",
        "participantRelationshipEn": "The subject is the only occupant in view.",
        "lightingZh": "柔和的日光从一扇窗户照进来。",
        "lightingEn": "Soft daylight enters through one window.",
        "framingZh": "使用静止的平视中景。",
        "framingEn": "Use a static eye-level medium shot.",
    }
    values.update(overrides)
    return values


def test_background_create_accepts_natural_scene_use_of_emotion_word(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        response = client.post(
            "/api/scenes",
            json=background_request(sceneEn="Alone in a small kitchen, preparing a surprise breakfast."),
        )

    assert response.status_code == 201


@pytest.mark.parametrize(
    ("field", "expected_field", "value", "message"),
    [
        ("participantRelationshipEn", "participantRelationshipEn", "A second person stands off camera.", "another person"),
        ("ambientSoundEn", "ambientSoundEn", "A soft soundtrack plays nearby.", "music or score terms"),
        ("lightingEn", "lightingEn", "The lighting creates a sad atmosphere.", "emotion labels"),
        ("sceneEn", "sceneEn", "The A-VT protocol applies in this office.", "internal category or protocol names"),
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
            "/api/scenes",
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
        ("participantRelationshipEn", "participantRelationshipEn", "A second person stands off camera.", "another person"),
        ("ambientSoundEn", "ambientSoundEn", "A soft soundtrack plays nearby.", "music or score terms"),
        ("lightingEn", "lightingEn", "The lighting creates a sad atmosphere.", "emotion labels"),
        ("sceneEn", "sceneEn", "The A-VT protocol applies in this office.", "internal category or protocol names"),
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
        created = client.post("/api/scenes", json=background_request())
        response = client.patch(
            f"/api/scenes/{created.json()['id']}",
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
        background = client.post(
            "/api/scenes",
            json=background_request(),
        )
        content = client.post(
            "/api/content-scripts",
            json=content_script_request([background.json()["id"]]),
        )
        prompt = create_verified_prompt(client)
        response = client.post(
            "/api/prompt-preview",
            json={
                "contentScript": {"id": content.json()["id"], "expectedRevision": content.json()["revision"]},
                "promptTemplateVersion": {"id": prompt["id"], "expectedRevision": prompt["revision"]},
                "scene": {"id": background.json()["id"], "expectedRevision": background.json()["revision"]},
                "demographic": {"age": 25, "gender": "Female", "ethnicity": "EastAsian"},
                "model": "LTX-2.3",
            },
        )

    assert response.status_code == 200
    assert response.json()["requiresPromptGeneration"] is True
    assert response.json()["finalPositivePrompt"] is None
    assert response.json()["negativePrompt"] == "subtitles, captions, distortion"
    assert response.json()["contentScript"]["id"] == content.json()["id"]


def test_submit_ltx25_int8_batch_returns_202_with_location(tmp_path: Path) -> None:
    renderer = _ConfiguredRendererGateway()
    with client_for(
        tmp_path, renderer, OpenAICompatiblePromptModel("test-key")
    ) as client:
        dataset = client.post(
            "/api/datasets",
            json={"name": "Production", "note": ""},
        )
        background = client.post(
            "/api/scenes",
            json=background_request(nameZh="私人书房", nameEn="Private study"),
        )
        content = client.post(
            "/api/content-scripts",
            json=content_script_request([background.json()["id"]]),
        )
        prompt = create_verified_prompt(client)
        draft = client.post(
            "/api/batch-drafts",
            json={
                "targetDatasetId": dataset.json()["id"],
                "category": "A-VA",
                "model": "LTX-2.5",
                "precision": "INT8",
                    "contentSelections": [
                        {
                            "contentScriptId": content.json()["id"],
                            "sceneIds": [background.json()["id"]],
                        }
                    ],
                "promptTemplateVersionId": prompt["id"],
                "demographics": [{"age": 25, "gender": "Female", "ethnicity": "EastAsian"}],
                "gpuSlots": ["GPU0"],
                "seeds": [17],
            },
        )

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
        assert submit.headers["Location"] == f"/api/generation-results/{submit.json()['id']}"
        assert draft.json()["precision"] == "INT8"
        assert preview.json()["allocations"][0]["model"] == "LTX-2.5"
        assert preview.json()["allocations"][0]["precision"] == "INT8"
        assert submit.json()["model"] == "LTX-2.5"
        assert submit.json()["precision"] == "INT8"
        job_items = client.get(
            f"/api/generation-results/{submit.json()['id']}/items"
        ).json()
        assert job_items["items"][0]["input"]["precision"] == "INT8"
        assert preview.json()["gpuRevisions"] == {"GPU0": 2}

    assert preview.status_code == 200
    assert renderer.probe_calls == [GpuSlotName.GPU0, GpuSlotName.GPU0]


def test_gpu_release_uses_revision_and_returns_cleared_profile(tmp_path: Path) -> None:
    renderer = _ConfiguredRendererGateway()
    renderer.states[GpuSlotName.GPU0] = SlotInspection(
        GpuSlotName.GPU0,
        GpuAvailability.AVAILABLE,
        ModelName.LTX,
        owned_unit="conflictstudio-ltx-gpu0.service",
        gpu_name="Test GPU",
        memory_used_mib=4096,
        memory_total_mib=24576,
        service_status="running",
    )
    with client_for(tmp_path, renderer) as client:
        live = client.get("/api/gpu-slots").json()[0]
        revision = live["revision"]

        response = client.post(
            "/api/gpu-slots/GPU0/release",
            json={"expectedRevision": revision},
        )

    assert response.status_code == 200
    assert response.json()["loadedModel"] is None
    assert response.json()["loadedPrecision"] is None
    assert response.json()["revision"] == revision + 2
    assert renderer.release_calls == [
        (
            GpuSlotName.GPU0,
            ModelName.LTX,
            None,
            "conflictstudio-ltx-gpu0.service",
        )
    ]


def test_gpu_release_rejects_unknown_ownership_without_stopping(tmp_path: Path) -> None:
    renderer = _ConfiguredRendererGateway()
    renderer.states[GpuSlotName.GPU0] = SlotInspection(
        GpuSlotName.GPU0,
        GpuAvailability.EXTERNAL_OCCUPIED,
        None,
        reason="Port 8188 is owned by an unknown process",
        gpu_name="Test GPU",
        memory_used_mib=8192,
        memory_total_mib=24576,
        service_status="unknown",
    )
    with client_for(tmp_path, renderer) as client:
        live = client.get("/api/gpu-slots").json()[0]
        response = client.post(
            "/api/gpu-slots/GPU0/release",
            json={"expectedRevision": live["revision"]},
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "gpu_ownership_unproven"
    assert "Port 8188" in response.json()["error"]["message"]
    assert renderer.release_calls == []


def test_gpu_release_rejects_stale_revision_before_stopping(tmp_path: Path) -> None:
    renderer = _ConfiguredRendererGateway()
    renderer.states[GpuSlotName.GPU0] = SlotInspection(
        GpuSlotName.GPU0,
        GpuAvailability.AVAILABLE,
        ModelName.LTX_25,
        owned_unit="conflictstudio-ltx25-bf16-gpu0.service",
        loaded_precision=Precision.BF16,
        gpu_name="Test GPU",
        memory_used_mib=8192,
        memory_total_mib=24576,
        service_status="running",
    )
    with client_for(tmp_path, renderer) as client:
        live = client.get("/api/gpu-slots").json()[0]
        response = client.post(
            "/api/gpu-slots/GPU0/release",
            json={"expectedRevision": live["revision"] - 1},
        )

    assert response.status_code == 409
    assert response.json()["error"] == {
        "code": "revision_conflict",
        "message": "The record has been changed by another operation",
        "details": {
            "resource": "gpuSlot",
            "id": "GPU0",
            "expectedRevision": live["revision"] - 1,
            "actualRevision": live["revision"],
        },
    }
    assert renderer.release_calls == []
def test_health_exposes_only_prompt_configuration_state(tmp_path: Path) -> None:
    frontend = tmp_path / "configured-frontend"
    frontend.mkdir()
    data_root = tmp_path / "configured-data"
    data_root.mkdir()
    model = OpenAICompatiblePromptModel("private-test-key")

    with TestClient(
        create_app(
            Settings(data_root=data_root, frontend_dist=frontend),
            model,
        )
    ) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["promptServiceConfigured"] is True
    assert "private-test-key" not in response.text
    assert "apiKey" not in response.text
