from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError

from backend.adapters.config import Settings
from backend.adapters.llm import UnconfiguredPromptModel
from backend.app import create_app
from backend.domain.display_names import (
    DISPLAY_NAME_ERROR_CODE,
    DISPLAY_NAME_ERROR_MESSAGE,
    EnglishDisplayName,
)
from backend.domain.schemas import (
    ContentScriptCreate,
    ContentScriptUpdate,
    PromptTemplateCreate,
    SceneCreate,
    SceneUpdate,
)


class DisplayNameValue(BaseModel):
    value: EnglishDisplayName


def background_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "nameZh": "私人办公室",
        "nameEn": "Private Office",
        "sceneZh": "一间有一把椅子和一张书桌的私人办公室。",
        "sceneEn": "A private office containing one chair and one desk.",
        "ambientSoundZh": "稳定的通风声。",
        "ambientSoundEn": "A steady ventilation hum remains audible.",
        "participantRelationshipZh": "画面中只有被摄者。",
        "participantRelationshipEn": "The subject is the only occupant in view.",
        "lightingZh": "柔和的日光。",
        "lightingEn": "Soft daylight enters through one window.",
        "framingZh": "静止的平视中景。",
        "framingEn": "Use a static eye-level medium shot.",
    }
    payload.update(overrides)
    return payload


def content_payload(background_ids: list[int], **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "nameZh": "一致回应",
        "nameEn": "Aligned Response",
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
        "sceneIds": background_ids,
    }
    payload.update(overrides)
    return payload


def prompt_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "Natural Portrait",
        "category": "A-VA",
    }
    payload.update(overrides)
    return payload


def client_for(tmp_path: Path) -> TestClient:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    settings = Settings(data_root=tmp_path, frontend_dist=frontend)
    return TestClient(create_app(settings, UnconfiguredPromptModel()))


@pytest.mark.parametrize(
    "name",
    [
        "A",
        "A-VA",
        "A-VT",
        "C-VA",
        "C-VT",
        "LTX-2.5",
        "State-of-the-Art Interview",
        "Q&A: Manager's Check-in (Room #2)",
        "Before/After – Calm & Clear",
        "X" * 60,
    ],
)
def test_display_name_accepts_ui_names_categories_models_and_boundaries(name: str) -> None:
    assert DisplayNameValue(value=name).value == name


@pytest.mark.parametrize(
    "name",
    [
        "",
        "X" * 61,
        " Leading space",
        "Trailing space ",
        "scenario-imported",
        "scenario-12 Imported Interview",
        "YAML-42",
        "prototype-demo",
        "scene-001",
        "scene-001 Private Office",
        "Interview v2",
        "V12",
        "natural_portrait",
        "Accepted",
        "rejected",
        "PENDING",
        "英文名称",
    ],
)
def test_display_name_rejects_internal_or_non_ui_names_without_rewriting(name: str) -> None:
    with pytest.raises(ValidationError) as caught:
        DisplayNameValue(value=name)

    assert caught.value.errors()[0]["type"] == DISPLAY_NAME_ERROR_CODE
    assert caught.value.errors()[0]["input"] == name


@pytest.mark.parametrize(
    ("schema", "valid_payload", "invalid_payload"),
    [
        (
            ContentScriptCreate,
            content_payload([1], nameEn="LTX-2.5 Interview"),
            content_payload([1], nameEn="scenario-12"),
        ),
        (
            ContentScriptUpdate,
            {"expectedRevision": 1, "sceneIds": [1], "nameEn": "A-VA Interview"},
            {"expectedRevision": 1, "sceneIds": [1], "nameEn": "content_script_v2"},
        ),
        (
            PromptTemplateCreate,
            prompt_payload(name="Q&A: Natural Portrait"),
            prompt_payload(name="yaml-preset"),
        ),
        (
            SceneCreate,
            background_payload(nameEn="State-of-the-Art Office"),
            background_payload(nameEn="scene-007"),
        ),
        (
            SceneUpdate,
            {"expectedRevision": 1, "nameEn": "LTX-2.5 Studio"},
            {"expectedRevision": 1, "nameEn": "Office v3"},
        ),
    ],
)
def test_catalog_create_and_mutable_update_schemas_share_display_name_validation(
    schema: type[BaseModel],
    valid_payload: dict[str, object],
    invalid_payload: dict[str, object],
) -> None:
    schema.model_validate(valid_payload)

    with pytest.raises(ValidationError) as caught:
        schema.model_validate(invalid_payload)

    assert any(error["type"] == DISPLAY_NAME_ERROR_CODE for error in caught.value.errors())


def assert_display_name_response(response: Any, expected_field: str) -> None:
    assert response.status_code == 422
    body = response.json()["error"]
    assert body["code"] == DISPLAY_NAME_ERROR_CODE
    assert body["message"] == DISPLAY_NAME_ERROR_MESSAGE
    assert body["details"]["fields"][0]["field"] == expected_field
    assert "regex" not in str(body).casefold()


def test_catalog_create_and_mutable_update_apis_return_stable_display_name_422(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        background = client.post("/api/scenes", json=background_payload(nameEn="B"))
        assert background.status_code == 201
        background_id = background.json()["id"]

        content = client.post(
            "/api/content-scripts",
            json=content_payload([background_id], nameEn="X" * 60),
        )
        assert content.status_code == 201

        invalid_responses = [
            (
                client.post(
                    "/api/content-scripts",
                    json=content_payload([background_id], nameZh="无效内容", nameEn="scenario-8"),
                ),
                "nameEn",
            ),
            (
                client.patch(
                    f"/api/content-scripts/{content.json()['id']}",
                    json={
                        "expectedRevision": content.json()["revision"],
                        "sceneIds": [background_id],
                        "nameEn": "Content_Plan",
                    },
                ),
                "nameEn",
            ),
            (
                client.post(
                    "/api/scenes",
                    json=background_payload(nameZh="无效背景", nameEn="scene-099"),
                ),
                "nameEn",
            ),
            (
                client.patch(
                    f"/api/scenes/{background_id}",
                    json={"expectedRevision": background.json()["revision"], "nameEn": "Office v4"},
                ),
                "nameEn",
            ),
        ]

    for response, field in invalid_responses:
        assert_display_name_response(response, field)
