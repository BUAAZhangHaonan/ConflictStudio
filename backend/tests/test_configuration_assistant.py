from __future__ import annotations

import asyncio
import json
from contextlib import contextmanager
from pathlib import Path

import httpx
from fastapi.testclient import TestClient
from sqlmodel import select

from backend.adapters.llm import OpenAICompatiblePromptModel
from backend.domain.models import (
    Asset,
    ConfigurationAssistant,
    ContentScript,
    GenerationAttempt,
    GenerationTestDraft,
    Job,
    Scene,
)
from backend.tests.test_sample_integration import create_api_sources, make_app


def suggestion(
    *,
    missing: list[str] | None = None,
    prefill: dict[str, object] | None = None,
    candidates: list[dict[str, object]] | None = None,
    content_draft: dict[str, object] | None = None,
    scene_draft: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "missingFields": missing or [],
        "prefill": prefill or {},
        "candidates": candidates or [],
        "recommendations": {
            "protocol": None,
            "category": None,
            "conflictDirection": None,
            "trueEmotion": None,
            "apparentEmotion": None,
            "model": None,
            "precision": None,
            "gpuSlots": [],
        },
        "newContentScriptDraft": content_draft,
        "newShootingSceneDraft": scene_draft,
        "failureAdvice": [],
    }


@contextmanager
def assistant_client(tmp_path: Path):
    state: dict[str, object] = {"response": suggestion(), "requests": []}

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        state["requests"].append(payload)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": (
                                state["response"]
                                if isinstance(state["response"], str)
                                else json.dumps(
                                    state["response"],
                                    ensure_ascii=False,
                                )
                            )
                        },
                    }
                ]
            },
            headers={"x-request-id": "assistant-private-request"},
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatiblePromptModel("assistant-private-key", http_client)
    app = make_app(tmp_path, model)
    try:
        with TestClient(app) as client:
            yield app, client, state
    finally:
        asyncio.run(http_client.aclose())


def create_batch(
    client: TestClient,
) -> tuple[dict[str, object], dict[str, object], dict[str, object], dict[str, object]]:
    content, version, scene = create_api_sources(client)
    dataset = client.post(
        "/api/datasets",
        json={"name": "Formal generation set", "note": ""},
    ).json()
    batch = client.post(
        "/api/batch-drafts",
        json={
            "targetDatasetId": dataset["id"],
            "category": "A-VA",
            "conflictDirection": None,
            "model": "LTX-2.5",
            "precision": "INT8",
            "contentSelections": [
                {
                    "contentScriptId": content["id"],
                    "sceneIds": [scene["id"]],
                }
            ],
            "promptTemplateVersionId": version["id"],
            "demographics": [
                {
                    "age": 25,
                    "gender": "Female",
                    "ethnicity": "EastAsian",
                }
            ],
            "gpuSlots": ["GPU0"],
            "seeds": [7],
        },
    ).json()
    return batch, content, version, scene


def complete_form(
    batch: dict[str, object],
    content: dict[str, object],
    version: dict[str, object],
    scene: dict[str, object],
) -> dict[str, object]:
    return {
        "targetDataset": {
            "id": batch["targetDatasetId"],
            "expectedRevision": batch["datasetRevision"],
        },
        "category": "A-VA",
        "conflictDirection": None,
        "model": "LTX-2.5",
        "precision": "INT8",
        "contentSelections": [
            {
                            "contentScript": {
                    "id": content["id"],
                    "expectedRevision": content["revision"],
                },
                "scenes": [
                    {
                        "id": scene["id"],
                        "expectedRevision": scene["revision"],
                    }
                ],
            }
        ],
        "promptTemplateVersion": {
            "id": version["id"],
            "expectedRevision": version["revision"],
        },
        "demographics": [
            {"age": 25, "gender": "Female", "ethnicity": "EastAsian"}
        ],
        "gpuSlots": ["GPU0"],
        "seeds": [7],
    }


def prompt_test_form(
    content: dict[str, object],
    version: dict[str, object],
    scene: dict[str, object],
    *,
    model: str | None = "LTX-2.3",
    precision: str | None = None,
) -> dict[str, object]:
    form: dict[str, object] = {
        "contentSelections": [
            {
                "contentScript": {
                    "id": content["id"],
                    "expectedRevision": content["revision"],
                },
                "scenes": [
                    {
                        "id": scene["id"],
                        "expectedRevision": scene["revision"],
                    }
                ],
            }
        ],
        "promptTemplateVersion": {
            "id": version["id"],
            "expectedRevision": version["revision"],
        },
        "demographics": [
            {"age": 25, "gender": "Female", "ethnicity": "EastAsian"}
        ],
    }
    if model is not None:
        form["model"] = model
    if precision is not None:
        form["precision"] = precision
    return form


def create_assistant(
    client: TestClient,
    *,
    target: str,
    current_form: dict[str, object],
    batch: dict[str, object] | None = None,
) -> httpx.Response:
    body: dict[str, object] = {
        "targetSource": target,
        "userRequirement": "Configure the current generation request",
        "currentForm": current_form,
    }
    if batch is not None:
        body["batchDraftId"] = batch["id"]
        body["batchDraftExpectedRevision"] = batch["revision"]
    return client.post("/api/configuration-assistants", json=body)


def test_assistant_uses_independent_template_and_lists_all_missing_fields(
    tmp_path: Path,
) -> None:
    expected = [
        "ContentSelections",
        "PromptTemplateVersion",
        "Demographics",
        "Model",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        state["response"] = suggestion(missing=expected)
        response = create_assistant(
            client,
            target="PromptTest",
            current_form={},
        )
        assistant = response.json()
        applied = client.post(
            f"/api/configuration-assistants/{assistant['id']}/apply",
            json={
                "expectedRevision": assistant["revision"],
                "expectedTargetRevision": assistant["testDraft"]["revision"],
                "confirmedFields": ["Model"],
                "values": {"model": "LTX-2.3"},
            },
        )
        with app.state.database.read_session() as session:
            jobs = session.exec(select(Job)).all()
            attempts = session.exec(select(GenerationAttempt)).all()
            assets = session.exec(select(Asset)).all()
            stored = session.get(ConfigurationAssistant, assistant["id"])
            draft = session.get(GenerationTestDraft, assistant["testDraft"]["id"])

    assert response.status_code == 201, response.text
    assert applied.status_code == 422, applied.text
    assert jobs == []
    assert attempts == []
    assert assets == []
    assert stored is not None and stored.status.value == "Pending"
    assert draft is not None and draft.revision == assistant["testDraft"]["revision"]
    assert response.json()["suggestion"]["missingFields"] == expected
    assert response.json()["modelName"] == "deepseek-v4-flash"
    request = state["requests"][0]
    assert request["model"] == "deepseek-v4-flash"
    assert "safe ConflictStudio generation form suggestion" in (
        request["messages"][0]["content"]
    )
    assert "spokenText" not in request["messages"][0]["content"]


def test_unique_candidates_prefill_and_multiple_candidates_do_not_autoselect(
    tmp_path: Path,
) -> None:
    missing = [
        "ContentSelections",
        "PromptTemplateVersion",
        "Demographics",
        "Model",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        content, version, scene = create_api_sources(client)
        unique_candidates = [
            {
                "kind": "ContentScript",
                "items": [
                    {
                        "id": content["id"],
                        "revision": content["revision"],
                        "label": f"{content['nameZh']} / {content['nameEn']}",
                    }
                ],
            },
            {
                "kind": "ShootingScene",
                "items": [
                    {
                        "id": scene["id"],
                        "revision": scene["revision"],
                        "label": f"{scene['nameZh']} / {scene['nameEn']}",
                    }
                ],
            },
            {
                "kind": "PromptTemplateVersion",
                "items": [
                    {
                        "id": version["id"],
                        "revision": version["revision"],
                        "label": f"{version['templateName']} v{version['version']}",
                    }
                ],
            },
        ]
        prefill = {
            "contentSelections": [
                {
                        "contentScript": {
                            "id": content["id"],
                            "expectedRevision": content["revision"],
                            "label": f"{content['nameZh']} / {content['nameEn']}",
                        },
                    "scenes": [
                            {
                                "id": scene["id"],
                                "expectedRevision": scene["revision"],
                                "label": f"{scene['nameZh']} / {scene['nameEn']}",
                            }
                    ],
                }
            ],
            "promptTemplateVersion": {
                "id": version["id"],
                "expectedRevision": version["revision"],
                "label": f"{version['templateName']} v{version['version']}",
            },
        }
        state["response"] = suggestion(
            missing=missing,
            prefill=prefill,
            candidates=unique_candidates,
        )
        unique = create_assistant(
            client,
            target="PromptTest",
            current_form={},
        )
        assert unique.status_code == 201, unique.text

        second = client.post(
            "/api/content-scripts",
            json={
                **{
                    key: value
                    for key, value in content.items()
                    if key
                    in {
                        "category",
                        "conflictDirection",
                        "mode",
                        "trueEmotion",
                        "apparentEmotion",
                        "sceneZh",
                        "sceneEn",
                        "triggerEventZh",
                        "triggerEventEn",
                        "psychologicalBackgroundZh",
                        "psychologicalBackgroundEn",
                        "dialogue",
                        "displayText",
                        "trueEmotionDescription",
                        "baseVideoPrompt",
                        "contentRequirementsZh",
                        "contentRequirementsEn",
                        "sceneSupplementZh",
                        "sceneSupplementEn",
                    }
                },
                "nameZh": "Second aligned response",
                "nameEn": "Second aligned response",
                "status": "Active",
                "sceneIds": [scene["id"]],
            },
        ).json()
        state["response"] = suggestion(
            missing=missing,
            candidates=[
                {
                    "kind": "ContentScript",
                    "items": [
                        unique_candidates[0]["items"][0],
                        {
                            "id": second["id"],
                            "revision": second["revision"],
                            "label": f"{second['nameZh']} / {second['nameEn']}",
                        },
                    ],
                }
            ],
        )
        multiple = create_assistant(
            client,
            target="PromptTest",
            current_form={},
        )
        state["response"] = suggestion(
            missing=missing,
            prefill={
                "contentSelections": [
                    {
                        "contentScript": {
                            "id": content["id"],
                            "expectedRevision": content["revision"],
                            "label": f"{content['nameZh']} / {content['nameEn']}",
                        },
                        "scenes": [
                            {
                                "id": scene["id"],
                                "expectedRevision": scene["revision"],
                                "label": f"{scene['nameZh']} / {scene['nameEn']}",
                            }
                        ],
                    }
                ]
            },
            candidates=[
                {
                    "kind": "ContentScript",
                    "items": [
                        unique_candidates[0]["items"][0],
                        {
                            "id": second["id"],
                            "revision": second["revision"],
                            "label": f"{second['nameZh']} / {second['nameEn']}",
                        },
                    ],
                },
                unique_candidates[1],
            ],
        )
        selected_multiple = create_assistant(
            client,
            target="PromptTest",
            current_form={},
        )

    assert multiple.status_code == 201, multiple.text
    assert multiple.json()["suggestion"]["prefill"]["contentSelections"] is None
    assert selected_multiple.status_code == 502


def test_partial_conditional_fields_are_reported_and_complete_apply_is_atomic(
    tmp_path: Path,
) -> None:
    c_missing = [
        "ConflictDirection",
        "ContentSelections",
        "PromptTemplateVersion",
        "Demographics",
        "Precision",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        state["response"] = suggestion(missing=c_missing)
        conflict = create_assistant(
            client,
            target="PromptTest",
            current_form={"category": "C-VA", "model": "LTX-2.5"},
        )
        assert conflict.status_code == 201, conflict.text

        content, version, scene = create_api_sources(client)
        state["response"] = suggestion(missing=["Precision"])
        precision = create_assistant(
            client,
            target="PromptTest",
            current_form=prompt_test_form(
                content,
                version,
                scene,
                model="LTX-2.5",
            ),
        ).json()
        applied = client.post(
            f"/api/configuration-assistants/{precision['id']}/apply",
            json={
                "expectedRevision": precision["revision"],
                "expectedTargetRevision": precision["testDraft"]["revision"],
                "confirmedFields": ["Precision"],
                "values": {"precision": "INT8"},
            },
        )
        with app.state.database.read_session() as session:
            jobs = session.exec(select(Job)).all()

    assert conflict.json()["suggestion"]["missingFields"] == c_missing
    assert applied.status_code == 200, applied.text
    assert applied.json()["testDraft"]["formState"]["precision"] == "INT8"
    assert jobs == []


def test_prefill_references_require_one_exact_same_kind_candidate(
    tmp_path: Path,
) -> None:
    missing = [
        "ContentSelections",
        "PromptTemplateVersion",
        "Demographics",
        "Model",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        content, _, scene = create_api_sources(client)
        content_label = f"{content['nameZh']} / {content['nameEn']}"
        prefill = {
            "contentSelections": [
                {
                    "contentScript": {
                        "id": content["id"],
                        "expectedRevision": content["revision"],
                        "label": content_label,
                    },
                    "scenes": [
                        {
                            "id": scene["id"],
                            "expectedRevision": scene["revision"],
                            "label": f"{scene['nameZh']} / {scene['nameEn']}",
                        }
                    ],
                }
            ]
        }
        state["response"] = suggestion(missing=missing, prefill=prefill)
        no_group = create_assistant(client, target="PromptTest", current_form={})

        wrong_kind = {
            "kind": "ShootingScene",
            "items": [
                {
                    "id": scene["id"],
                    "revision": scene["revision"],
                    "label": f"{scene['nameZh']} / {scene['nameEn']}",
                }
            ],
        }
        state["response"] = suggestion(
            missing=missing,
            prefill=prefill,
            candidates=[wrong_kind],
        )
        crossed = create_assistant(client, target="PromptTest", current_form={})

        mismatched = {
            "kind": "ContentScript",
            "items": [
                {
                    "id": content["id"],
                    "revision": content["revision"],
                    "label": content_label,
                }
            ],
        }
        wrong_label = json.loads(json.dumps(prefill))
        wrong_label["contentSelections"][0]["contentScript"]["label"] = "Wrong"
        state["response"] = suggestion(
            missing=missing,
            prefill=wrong_label,
            candidates=[mismatched, wrong_kind],
        )
        label_mismatch = create_assistant(
            client,
            target="PromptTest",
            current_form={},
        )
        with app.state.database.read_session() as session:
            records = session.exec(select(ConfigurationAssistant)).all()

    assert no_group.status_code == 502
    assert crossed.status_code == 502
    assert label_mismatch.status_code == 502
    assert records == []


def test_invalid_json_duplicate_keys_and_forbidden_operations_fail_whole_request(
    tmp_path: Path,
) -> None:
    missing = [
        "ContentSelections",
        "PromptTemplateVersion",
        "Demographics",
        "Model",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        state["response"] = '{"missingFields":[],"missingFields":[]}'
        duplicate = create_assistant(
            client, target="PromptTest", current_form={}
        )
        state["response"] = {
            **suggestion(missing=missing),
            "datasetAction": {"create": True},
        }
        forbidden = create_assistant(
            client, target="PromptTest", current_form={}
        )
        unsafe_operations = []
        for unsafe_text in (
            "Use ftp://example.test/input",
            "Open file:///tmp/request.json",
            "Read www.example.test first",
            "Run python -c print(1)",
            "Run sh -c echo-ready",
            "Run the request at /api/jobs/start",
            "Run one command; then another",
        ):
            unsafe = suggestion(missing=missing)
            unsafe["failureAdvice"] = [unsafe_text]
            state["response"] = unsafe
            unsafe_operations.append(
                create_assistant(client, target="PromptTest", current_form={})
            )
        invalid_recommendations = []
        for changes in (
            {
                "protocol": "VA",
                "category": "A-VA",
                "trueEmotion": "calm",
                "apparentEmotion": "sad",
            },
            {
                "protocol": "VA",
                "category": "C-VA",
                "conflictDirection": "Audio",
                "trueEmotion": "calm",
                "apparentEmotion": "calm",
            },
            {"protocol": "VT", "category": "A-VA"},
            {"model": "LTX-2.5", "precision": None},
        ):
            invalid = suggestion(missing=missing)
            invalid["recommendations"] = {
                **invalid["recommendations"],
                **changes,
            }
            state["response"] = invalid
            invalid_recommendations.append(
                create_assistant(client, target="PromptTest", current_form={})
            )
        state["response"] = suggestion(missing=["Model"])
        incomplete = create_assistant(
            client, target="PromptTest", current_form={}
        )
        with app.state.database.read_session() as session:
            records = session.exec(select(ConfigurationAssistant)).all()
            drafts = session.exec(select(GenerationTestDraft)).all()

    assert duplicate.status_code == 502
    assert forbidden.status_code == 502
    assert all(response.status_code == 502 for response in unsafe_operations)
    assert all(response.status_code == 502 for response in invalid_recommendations)
    assert incomplete.status_code == 502
    assert records == []
    assert drafts == []
    rendered = json.dumps(
        [
            duplicate.json(),
            forbidden.json(),
            *[response.json() for response in unsafe_operations],
            *[response.json() for response in invalid_recommendations],
            incomplete.json(),
        ]
    ).lower()
    assert "sql" not in rendered
    assert "traceback" not in rendered
    assert "/api/" not in rendered


def test_production_apply_updates_only_confirmed_value_and_is_terminal(
    tmp_path: Path,
) -> None:
    with assistant_client(tmp_path) as (_, client, state):
        batch, content, version, scene = create_batch(client)
        state["response"] = suggestion()
        created = create_assistant(
            client,
            target="Production",
            current_form=complete_form(batch, content, version, scene),
            batch=batch,
        )
        assert created.status_code == 201, created.text
        assistant = created.json()
        applied = client.post(
            f"/api/configuration-assistants/{assistant['id']}/apply",
            json={
                "expectedRevision": assistant["revision"],
                "expectedTargetRevision": batch["revision"],
                "confirmedFields": ["DisplayName"],
                "values": {"displayName": "A-VA-formal"},
            },
        )
        assert applied.status_code == 200, applied.text
        repeated = client.post(
            f"/api/configuration-assistants/{assistant['id']}/discard",
            json={"expectedRevision": applied.json()["revision"]},
        )
        updated = client.get(f"/api/batch-drafts/{batch['id']}")

    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "Applied"
    assert applied.json()["appliedValues"]["displayName"] == "A-VA-formal"
    assert applied.json()["result"]["targetRevision"] == batch["revision"] + 1
    assert updated.json()["displayName"] == "A-VA-formal"
    assert repeated.status_code == 409


def test_target_or_candidate_revision_change_returns_conflict_without_apply(
    tmp_path: Path,
) -> None:
    with assistant_client(tmp_path) as (_, client, state):
        batch, content, version, scene = create_batch(client)
        state["response"] = suggestion()
        production = create_assistant(
            client,
            target="Production",
            current_form=complete_form(batch, content, version, scene),
            batch=batch,
        ).json()
        changed_batch = client.put(
            f"/api/batch-drafts/{batch['id']}",
            json={
                "targetDatasetId": batch["targetDatasetId"],
                "displayName": "External update",
                "category": "A-VA",
                "conflictDirection": None,
                "model": "LTX-2.5",
                "precision": "INT8",
                "contentSelections": [
                    {
                        "contentScriptId": content["id"],
                        "sceneIds": [scene["id"]],
                    }
                ],
                "promptTemplateVersionId": version["id"],
                "demographics": [
                    {
                        "age": 25,
                        "gender": "Female",
                        "ethnicity": "EastAsian",
                    }
                ],
                "gpuSlots": ["GPU0"],
                "seeds": [7],
                "expectedRevision": batch["revision"],
            },
        )
        stale_target = client.post(
            f"/api/configuration-assistants/{production['id']}/apply",
            json={
                "expectedRevision": production["revision"],
                "expectedTargetRevision": batch["revision"],
                "confirmedFields": ["DisplayName"],
                "values": {"displayName": "Must not apply"},
            },
        )
        assert changed_batch.status_code == 200

        candidates = [
            {
                "kind": "ContentScript",
                "items": [
                    {
                        "id": content["id"],
                        "revision": content["revision"],
                        "label": f"{content['nameZh']} / {content['nameEn']}",
                    }
                ],
            },
            {
                "kind": "ShootingScene",
                "items": [
                    {
                        "id": scene["id"],
                        "revision": scene["revision"],
                        "label": f"{scene['nameZh']} / {scene['nameEn']}",
                    }
                ],
            },
        ]
        prefill = {
            "contentSelections": [
                {
                        "contentScript": {
                            "id": content["id"],
                            "expectedRevision": content["revision"],
                            "label": f"{content['nameZh']} / {content['nameEn']}",
                        },
                    "scenes": [
                            {
                                "id": scene["id"],
                                "expectedRevision": scene["revision"],
                                "label": f"{scene['nameZh']} / {scene['nameEn']}",
                            }
                    ],
                }
            ]
        }
        state["response"] = suggestion(
            missing=[
                "ContentSelections",
                "PromptTemplateVersion",
                "Demographics",
                "Model",
            ],
            prefill=prefill,
            candidates=candidates,
        )
        test_assistant = create_assistant(
            client, target="PromptTest", current_form={}
        ).json()
        scene_update = client.patch(
            f"/api/scenes/{scene['id']}",
            json={
                "expectedRevision": scene["revision"],
                "nameEn": "Changed private office",
            },
        )
        stale_candidate = client.post(
            f"/api/configuration-assistants/{test_assistant['id']}/apply",
            json={
                "expectedRevision": test_assistant["revision"],
                "expectedTargetRevision": test_assistant["testDraft"]["revision"],
                "confirmedFields": ["Model"],
                "values": {"model": "LTX-2.3"},
            },
        )

    assert stale_target.status_code == 409
    assert scene_update.status_code == 200
    assert stale_candidate.status_code == 409


def draft_scene(name: str = "Quiet scene") -> dict[str, object]:
    return {
        "nameZh": name,
        "nameEn": "Assistant scene",
        "sceneZh": "A small room with one table.",
        "sceneEn": "A small room containing one chair.",
        "ambientSoundZh": "Steady ventilation sound.",
        "ambientSoundEn": "A steady ventilation hum remains audible.",
        "participantRelationshipZh": "Only the speaker is present.",
        "participantRelationshipEn": "The subject is the only occupant.",
        "lightingZh": "Soft even lighting.",
        "lightingEn": "Soft even light keeps the face readable.",
        "framingZh": "Static medium shot.",
        "framingEn": "A static front-facing close-up.",
        "status": "Draft",
    }


def draft_content(name: str = "Content draft") -> dict[str, object]:
    return {
        "nameZh": name,
        "nameEn": "Assistant content",
        "category": "A-VA",
        "conflictDirection": None,
        "mode": "Generative",
        "status": "Draft",
        "trueEmotion": "calm",
        "apparentEmotion": "calm",
        "sceneZh": "A quiet room.",
        "sceneEn": "A quiet room.",
        "triggerEventZh": "A presentation has just ended.",
        "triggerEventEn": "A short signal has just ended.",
        "psychologicalBackgroundZh": "The speaker prepared carefully.",
        "psychologicalBackgroundEn": "The subject prepares to answer.",
        "dialogue": None,
        "displayText": None,
        "trueEmotionDescription": "",
        "baseVideoPrompt": "",
        "contentRequirementsZh": "Keep the response calm.",
        "contentRequirementsEn": "The subject responds calmly.",
        "sceneSupplementZh": "",
        "sceneSupplementEn": "",
        "sceneIds": [],
    }


def test_draft_creation_requires_confirmation_and_rolls_back_atomically(
    tmp_path: Path,
) -> None:
    missing = [
        "ContentSelections",
        "PromptTemplateVersion",
        "Demographics",
        "Model",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        content, version, scene = create_api_sources(client)
        state["response"] = suggestion(
            missing=[],
            content_draft=draft_content(),
            scene_draft=draft_scene(),
        )
        assistant = create_assistant(
            client,
            target="PromptTest",
            current_form=prompt_test_form(content, version, scene),
        ).json()
        applied = client.post(
            f"/api/configuration-assistants/{assistant['id']}/apply",
            json={
                "expectedRevision": assistant["revision"],
                "expectedTargetRevision": assistant["testDraft"]["revision"],
                "confirmedFields": [],
                "values": {},
                "createContentScript": True,
                "createShootingScene": True,
                "linkNewSceneToContent": True,
            },
        )
        with app.state.database.read_session() as session:
            new_content = session.get(
                ContentScript,
                applied.json()["result"]["createdContentScriptId"],
            )
            new_scene = session.get(
                Scene,
                applied.json()["result"]["createdShootingSceneId"],
            )
            assert new_content is not None and new_content.status.value == "Draft"
            assert new_scene is not None and new_scene.status.value == "Draft"

        state["response"] = suggestion(
            missing=[],
            content_draft=draft_content("Aligned response"),
            scene_draft=draft_scene("Office scene"),
        )
        failed_assistant = create_assistant(
            client,
            target="PromptTest",
            current_form=prompt_test_form(content, version, scene),
        ).json()
        before = client.get("/api/scenes").json()["total"]
        failed = client.post(
            f"/api/configuration-assistants/{failed_assistant['id']}/apply",
            json={
                "expectedRevision": failed_assistant["revision"],
                "expectedTargetRevision": failed_assistant["testDraft"]["revision"],
                "confirmedFields": [],
                "values": {},
                "createContentScript": True,
                "createShootingScene": True,
                "linkNewSceneToContent": True,
            },
        )
        after = client.get("/api/scenes").json()["total"]
        pending = client.get(
            f"/api/configuration-assistants/{failed_assistant['id']}"
        ).json()

    assert applied.status_code == 200, applied.text
    assert failed.status_code == 409
    assert before == after
    assert pending["status"] == "Pending"


def test_candidate_missing_and_active_catalog_drafts_are_rejected(
    tmp_path: Path,
) -> None:
    missing = [
        "ContentSelections",
        "PromptTemplateVersion",
        "Demographics",
        "Model",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        state["response"] = suggestion(
            missing=missing,
            candidates=[
                {
                    "kind": "ContentScript",
                    "items": [
                        {"id": 99999, "revision": 1, "label": "Missing item"}
                    ],
                }
            ],
        )
        missing_candidate = create_assistant(
            client, target="PromptTest", current_form={}
        )
        active_scene = draft_scene()
        active_scene["status"] = "Active"
        state["response"] = suggestion(
            missing=missing,
            scene_draft=active_scene,
        )
        active = create_assistant(
            client, target="PromptTest", current_form={}
        )
        with app.state.database.read_session() as session:
            assert session.exec(select(ConfigurationAssistant)).all() == []

    assert missing_candidate.status_code == 502
    assert active.status_code == 502


def test_records_exclude_transport_secrets_and_discard_is_final(
    tmp_path: Path,
) -> None:
    missing = [
        "ContentSelections",
        "PromptTemplateVersion",
        "Demographics",
        "Model",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        state["response"] = suggestion(missing=missing)
        created = create_assistant(
            client, target="PromptTest", current_form={}
        )
        assistant = created.json()
        discarded = client.post(
            f"/api/configuration-assistants/{assistant['id']}/discard",
            json={"expectedRevision": assistant["revision"]},
        )
        repeated = client.post(
            f"/api/configuration-assistants/{assistant['id']}/discard",
            json={"expectedRevision": discarded.json()["revision"]},
        )
        with app.state.database.engine.connect() as connection:
            stored = connection.exec_driver_sql(
                """
                SELECT user_requirement, model_name, current_form_json,
                       suggestion_json, applied_values_json, result_json
                FROM configuration_assistants
                """
            ).one()
            rendered = " ".join("" if value is None else str(value) for value in stored)

    assert created.status_code == 201
    assert discarded.status_code == 200
    assert discarded.json()["status"] == "Discarded"
    assert discarded.json()["result"]["discarded"] is True
    assert repeated.status_code == 409
    assert "deepseek-v4-flash" in rendered
    assert "assistant-private-key" not in rendered
    assert "assistant-private-request" not in rendered
    assert "authorization" not in rendered.casefold()


def test_expected_revision_and_confirmation_matrix_are_strict(
    tmp_path: Path,
) -> None:
    missing = [
        "ContentSelections",
        "PromptTemplateVersion",
        "Demographics",
        "Model",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        state["response"] = suggestion(missing=missing)
        assistant = create_assistant(
            client, target="PromptTest", current_form={}
        ).json()
        stale_record = client.post(
            f"/api/configuration-assistants/{assistant['id']}/apply",
            json={
                "expectedRevision": assistant["revision"] + 1,
                "expectedTargetRevision": assistant["testDraft"]["revision"],
                "confirmedFields": ["Model"],
                "values": {"model": "LTX-2.3"},
            },
        )
        mismatched_confirmation = client.post(
            f"/api/configuration-assistants/{assistant['id']}/apply",
            json={
                "expectedRevision": assistant["revision"],
                "expectedTargetRevision": assistant["testDraft"]["revision"],
                "confirmedFields": [],
                "values": {"model": "LTX-2.3"},
            },
        )
        dataset_operation = client.post(
            f"/api/configuration-assistants/{assistant['id']}/apply",
            json={
                "expectedRevision": assistant["revision"],
                "expectedTargetRevision": assistant["testDraft"]["revision"],
                "confirmedFields": ["TargetDataset"],
                "values": {
                    "targetDataset": {"id": 1, "expectedRevision": 1}
                },
            },
        )
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql(
                """
                UPDATE generation_test_drafts
                SET revision = revision + 1
                WHERE id = ?
                """,
                (assistant["testDraft"]["id"],),
            )
        stale_target = client.post(
            f"/api/configuration-assistants/{assistant['id']}/apply",
            json={
                "expectedRevision": assistant["revision"],
                "expectedTargetRevision": assistant["testDraft"]["revision"],
                "confirmedFields": ["Model"],
                "values": {"model": "LTX-2.3"},
            },
        )

    assert stale_record.status_code == 409
    assert stale_target.status_code == 409
    assert mismatched_confirmation.status_code == 422
    assert dataset_operation.status_code == 422


def test_video_test_apply_updates_only_its_draft_and_never_executes(
    tmp_path: Path,
) -> None:
    missing = [
        "Comparisons",
        "ExecutionMode",
        "Seeds",
    ]
    with assistant_client(tmp_path) as (app, client, state):
        content, version, scene = create_api_sources(client)
        state["response"] = suggestion(missing=missing)
        assistant = create_assistant(
            client,
            target="VideoTest",
            current_form={
                key: value
                for key, value in prompt_test_form(
                    content,
                    version,
                    scene,
                    model=None,
                ).items()
                if key != "model"
            },
        ).json()
        applied = client.post(
            f"/api/configuration-assistants/{assistant['id']}/apply",
            json={
                "expectedRevision": assistant["revision"],
                "expectedTargetRevision": assistant["testDraft"]["revision"],
                "confirmedFields": [
                    "Comparisons",
                    "ExecutionMode",
                    "Seeds",
                ],
                "values": {
                    "comparisons": [
                        {
                            "model": "LTX-2.5",
                            "precision": "INT8",
                            "gpuSlot": "GPU0",
                        }
                    ],
                    "executionMode": "Serial",
                    "seeds": [31],
                },
            },
        )
        with app.state.database.read_session() as session:
            jobs = session.exec(select(Job)).all()
            attempts = session.exec(select(GenerationAttempt)).all()
            assets = session.exec(select(Asset)).all()

    assert applied.status_code == 200, applied.text
    assert applied.json()["targetSource"] == "VideoTest"
    assert applied.json()["testDraft"]["formState"]["seeds"] == [31]
    assert jobs == []
    assert attempts == []
    assert assets == []
