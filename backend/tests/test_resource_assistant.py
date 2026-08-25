from __future__ import annotations

import asyncio
import json
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path

import httpx
from fastapi.testclient import TestClient
from sqlmodel import select

from backend.adapters.llm import (
    OpenAICompatiblePromptModel,
    UnconfiguredPromptModel,
)
from backend.domain.models import (
    ContentScript,
    ContentScriptScene,
    Job,
    PromptTemplate,
    PromptTemplateVersion,
    Scene,
)
from backend.services.errors import invalid_request
from backend.tests.support import create_prompt_template
from backend.tests.test_sample_integration import make_app


def resource_bundle(
    *,
    category: str = "C-VA",
    mode: str = "Generative",
    scene_count: int = 2,
) -> dict[str, object]:
    aligned = category in {"A-VA", "A-VT"}
    direction = None if aligned else ("Audio" if category == "C-VA" else "Text")
    is_va = category in {"A-VA", "C-VA"}
    fixed = mode == "Fixed"
    return {
        "contentScript": {
            "nameZh": "资源助手内容",
            "nameEn": "Resource assistant content",
            "category": category,
            "conflictDirection": direction,
            "mode": mode,
            "status": "Draft",
            "trueEmotion": "calm" if aligned else "worried",
            "apparentEmotion": "calm",
            "sceneZh": "一名成年人坐在安静的办公室里。",
            "sceneEn": "An adult sits in a quiet office.",
            "triggerEventZh": "门在身后轻轻关上。",
            "triggerEventEn": "The door closes softly behind the subject.",
            "psychologicalBackgroundZh": "被摄者准备回答一个直接的问题。",
            "psychologicalBackgroundEn": "The subject prepares to answer a direct question.",
            "dialogue": "我可以处理。" if fixed and is_va else None,
            "displayText": "我可以处理。" if fixed and not is_va else None,
            "trueEmotionDescription": "说话方式表明被摄者仍然担忧。" if fixed else "",
            "baseVideoPrompt": "An adult gives one restrained response in a quiet office." if fixed else "",
            "contentRequirementsZh": "生成一句简短、克制的回应。" if not fixed else "",
            "contentRequirementsEn": "Generate one brief and restrained response." if not fixed else "",
            "sceneSupplementZh": "保持背景简单。",
            "sceneSupplementEn": "Keep the background simple.",
        },
        "scenes": [
            {
                "nameZh": f"资源场景{index + 1}",
                "nameEn": f"Resource scene {index + 1}",
                "sceneZh": "一间只有桌椅的安静办公室。",
                "sceneEn": "A quiet office containing one desk and one chair.",
                "ambientSoundZh": "稳定的通风声。",
                "ambientSoundEn": "A steady ventilation hum remains audible.",
                "participantRelationshipZh": "画面中只有被摄者。",
                "participantRelationshipEn": "The subject is the only occupant in view.",
                "lightingZh": "柔和的窗边日光。",
                "lightingEn": "Soft window light keeps the face evenly lit.",
                "framingZh": "静止的正面近景。",
                "framingEn": "A static front-facing close-up holds throughout.",
                "status": "Draft",
            }
            for index in range(scene_count)
        ],
        "promptTemplateVersion": {
            "organizationRules": "Keep the prompt sections in a stable order.",
            "styleGuidance": "Use concrete and observable details.",
            "positiveExamples": ["A restrained response in a plain office."],
            "negativeExamples": ["Avoid exaggerated gestures."],
            "ltxNegativePrompt": "camera shake, text overlays, distorted hands",
            "h3NegativePrompt": "camera shake, text overlays, distorted hands",
        },
    }


@contextmanager
def assistant_client(tmp_path: Path):
    state: dict[str, object] = {
        "response": resource_bundle(),
        "requests": [],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        requests = state["requests"]
        assert isinstance(requests, list)
        requests.append(payload)
        response = state["response"]
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": (
                                response
                                if isinstance(response, str)
                                else json.dumps(response, ensure_ascii=False)
                            )
                        },
                    }
                ]
            },
            headers={"x-request-id": "resource-assistant-request"},
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatiblePromptModel("resource-assistant-key", http_client)
    app = make_app(tmp_path, model)
    try:
        with TestClient(app) as client:
            yield app, client, state
    finally:
        asyncio.run(http_client.aclose())


def create_template(client: TestClient, *, category: str = "C-VA") -> dict:
    return create_prompt_template(
        client.app, f"Resource {category} template", category
    )


def propose(client: TestClient, template: dict) -> httpx.Response:
    return client.post(
        "/api/resource-assistant/propose",
        json={
            "userRequirement": "Create a small editable resource bundle",
            "promptTemplate": {
                "id": template["id"],
                "expectedRevision": template["revision"],
            },
        },
    )


def apply_body(template: dict, bundle: dict[str, object]) -> dict[str, object]:
    return {
        "promptTemplate": {
            "id": template["id"],
            "expectedRevision": template["revision"],
        },
        "bundle": bundle,
    }


def test_propose_is_typed_read_only_and_removes_the_legacy_contract(
    tmp_path: Path,
) -> None:
    with assistant_client(tmp_path) as (app, client, state):
        template = create_template(client)
        plain_text = resource_bundle()
        plain_text["scenes"][0]["sceneEn"] = (
            "A quiet office; reference https://example.invalid if the user asks."
        )  # type: ignore[index]
        state["response"] = plain_text
        response = propose(client, template)
        legacy = client.get("/api/configuration-assistants/1")
        with app.state.database.read_session() as session:
            assert session.exec(select(ContentScript)).all() == []
            assert session.exec(select(Scene)).all() == []
            assert session.exec(select(PromptTemplateVersion)).all() == []
            assert session.exec(select(Job)).all() == []
            stored_template = session.get(PromptTemplate, template["id"])
            assert stored_template is not None
            assert stored_template.revision == template["revision"]
        with app.state.database.engine.connect() as connection:
            tables = {
                row[0]
                for row in connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).all()
            }

    assert response.status_code == 200, response.text
    assert response.json()["promptTemplate"] == template
    assert response.json()["bundle"]["contentScript"]["status"] == "Draft"
    assert "; reference https://" in response.json()["bundle"]["scenes"][0]["sceneEn"]
    assert len(response.json()["bundle"]["scenes"]) == 2
    assert legacy.status_code == 404
    assert "configuration_assistants" not in tables
    assert "generation_test_drafts" not in tables
    requests = state["requests"]
    assert isinstance(requests, list) and len(requests) == 1
    assert template["name"] in requests[0]["messages"][1]["content"]


def test_propose_rejects_bad_or_control_character_model_output_without_writes(
    tmp_path: Path,
) -> None:
    with assistant_client(tmp_path) as (app, client, state):
        template = create_template(client)
        cases: list[tuple[object, str]] = [
            ('{"contentScript":', "invalid_prompt_json"),
            (
                '{"contentScript":{},"contentScript":{},"scenes":[],"promptTemplateVersion":{}}',
                "duplicate_prompt_key",
            ),
            ({}, "invalid_prompt_schema"),
        ]
        active = resource_bundle()
        active["contentScript"]["status"] = "Active"  # type: ignore[index]
        cases.append((active, "invalid_prompt_schema"))
        controlled = resource_bundle()
        controlled["scenes"][0]["sceneEn"] = "A quiet office.\x00"  # type: ignore[index]
        cases.append((controlled, "invalid_prompt_schema"))
        cases.append((resource_bundle(category="A-VA"), "invalid_prompt_schema"))
        responses = []
        for output, expected_code in cases:
            state["response"] = output
            response = propose(client, template)
            responses.append((response.status_code, response.json()["error"]["code"], expected_code))
        with app.state.database.read_session() as session:
            counts = (
                len(session.exec(select(ContentScript)).all()),
                len(session.exec(select(Scene)).all()),
                len(session.exec(select(PromptTemplateVersion)).all()),
                len(session.exec(select(Job)).all()),
            )

    assert responses == [(502, expected, expected) for _, _, expected in responses]
    assert counts == (0, 0, 0, 0)


def test_propose_checks_template_before_model_and_maps_missing_configuration(
    tmp_path: Path,
) -> None:
    configured_root = tmp_path / "configured"
    configured_root.mkdir()
    with assistant_client(configured_root) as (_, client, state):
        template = create_template(client)
        missing = client.post(
            "/api/resource-assistant/propose",
            json={
                "userRequirement": "Create resources",
                "promptTemplate": {"id": 99999, "expectedRevision": 1},
            },
        )
        stale = client.post(
            "/api/resource-assistant/propose",
            json={
                "userRequirement": "Create resources",
                "promptTemplate": {
                    "id": template["id"],
                    "expectedRevision": template["revision"] + 1,
                },
            },
        )
        assert state["requests"] == []

    unconfigured_root = tmp_path / "unconfigured"
    unconfigured_root.mkdir()
    app = make_app(unconfigured_root, UnconfiguredPromptModel())
    with TestClient(app) as client:
        template = create_template(client)
        unconfigured = propose(client, template)

    assert missing.status_code == 404
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "revision_conflict"
    assert unconfigured.status_code == 503
    assert unconfigured.json()["error"]["code"] == "external_configuration_missing"


def test_apply_persists_user_edits_but_cannot_verify_without_prompt_test(
    tmp_path: Path,
) -> None:
    with assistant_client(tmp_path) as (app, client, _):
        template = create_template(client)
        proposal = propose(client, template).json()
        edited = deepcopy(proposal["bundle"])
        edited["contentScript"]["nameZh"] = "用户确认后的内容"
        edited["contentScript"]["nameEn"] = "User confirmed content"
        edited["scenes"][0]["nameZh"] = "用户确认场景一"
        edited["scenes"][0]["nameEn"] = "User confirmed scene one"
        edited["promptTemplateVersion"]["organizationRules"] = "Use the confirmed order."
        applied = client.post(
            "/api/resource-assistant/apply",
            json=apply_body(template, edited),
        )
        result = applied.json()
        stale = client.post(
            "/api/resource-assistant/apply",
            json=apply_body(template, edited),
        )
        verified = client.post(
            f"/api/prompt-template-versions/{result['promptTemplateVersion']['id']}/verify",
            json={"expectedRevision": result["promptTemplateVersion"]["revision"]},
        )
        current_template = client.get(
            f"/api/prompt-templates/{template['id']}"
        ).json()
        with app.state.database.read_session() as session:
            links = session.exec(
                select(ContentScriptScene)
                .where(
                    ContentScriptScene.content_script_id
                    == result["contentScript"]["id"]
                )
                .order_by(ContentScriptScene.position)
            ).all()
            jobs = session.exec(select(Job)).all()

    assert applied.status_code == 201, applied.text
    assert result["contentScript"]["nameEn"] == "User confirmed content"
    assert result["contentScript"]["status"] == "Draft"
    assert [scene["status"] for scene in result["scenes"]] == ["Draft", "Draft"]
    assert result["contentScript"]["sceneIds"] == [scene["id"] for scene in result["scenes"]]
    assert [link.scene_id for link in links] == result["contentScript"]["sceneIds"]
    assert result["promptTemplateVersion"]["organizationRules"] == "Use the confirmed order."
    assert result["promptTemplateVersion"]["verificationStatus"] == "Draft"
    assert result["promptTemplateVersion"]["verifiedAt"] is None
    assert current_template["revision"] == template["revision"] + 1
    assert stale.status_code == 409
    assert verified.status_code == 409
    assert verified.json()["error"]["code"] == "state_conflict"
    assert jobs == []


def test_apply_rolls_back_the_complete_bundle_when_the_last_create_fails(
    tmp_path: Path,
    monkeypatch,
) -> None:  # type: ignore[no-untyped-def]
    with assistant_client(tmp_path) as (app, client, _):
        template = create_template(client)
        original = app.state.catalog_service.create_prompt_template_version_in_session

        def fail_after_version(session, template_id, payload):  # type: ignore[no-untyped-def]
            original(session, template_id, payload)
            raise invalid_request("forced final resource failure")

        monkeypatch.setattr(
            app.state.catalog_service,
            "create_prompt_template_version_in_session",
            fail_after_version,
        )
        response = client.post(
            "/api/resource-assistant/apply",
            json=apply_body(template, resource_bundle()),
        )
        fixed = resource_bundle(mode="Fixed", scene_count=2)
        invalid_fixed = client.post(
            "/api/resource-assistant/apply",
            json=apply_body(template, fixed),
        )
        with app.state.database.read_session() as session:
            counts = (
                len(session.exec(select(ContentScript)).all()),
                len(session.exec(select(Scene)).all()),
                len(session.exec(select(PromptTemplateVersion)).all()),
                len(session.exec(select(ContentScriptScene)).all()),
                len(session.exec(select(Job)).all()),
            )
            stored_template = session.get(PromptTemplate, template["id"])
            assert stored_template is not None
            template_revision = stored_template.revision

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert invalid_fixed.status_code == 422
    assert counts == (0, 0, 0, 0, 0)
    assert template_revision == template["revision"]
