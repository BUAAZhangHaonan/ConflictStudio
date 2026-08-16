from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from backend.domain.enums import (
    JobItemStage,
    JobSource,
    JobStatus,
    ModelName,
)
from backend.domain.models import (
    Asset,
    BatchVideoInputSnapshot,
    GenerationAttempt,
    GpuSlot,
    Job,
    JobItem,
    PromptTemplateExample,
    PromptTemplateVersion,
    Sample,
    utc_now,
)
from backend.tests.test_review_api import sample_app
from backend.tests.test_sample_integration import (
    create_api_sources,
    make_app,
)


def prompt_test_payload(
    content: dict[str, object],
    version: dict[str, object],
    scene: dict[str, object],
    model: ModelName,
) -> dict[str, object]:
    return {
        "contentScript": {
            "id": content["id"],
            "expectedRevision": content["revision"],
        },
        "promptTemplateVersion": {
            "id": version["id"],
            "expectedRevision": version["revision"],
        },
        "scene": {
            "id": scene["id"],
            "expectedRevision": scene["revision"],
        },
        "demographic": {
            "age": 25,
            "gender": "Female",
            "ethnicity": "EastAsian",
        },
        "model": model.value,
        "precision": None,
    }


def test_template_identity_versions_are_revisioned_and_verified_versions_are_immutable(
    tmp_path: Path,
) -> None:
    app = make_app(tmp_path)
    with TestClient(app) as client:
        template = client.post(
            "/api/prompt-templates",
            json={"name": "Natural portrait", "category": "A-VA"},
        )
        assert template.status_code == 201
        identity = template.json()
        version = client.post(
            f"/api/prompt-templates/{identity['id']}/versions",
            json={
                "expectedTemplateRevision": identity["revision"],
                "organizationRules": "Keep the selected records in component order.",
                "styleGuidance": "Use a static medium shot.",
                "positiveExamples": ["Keep visible behavior specific."],
                "negativeExamples": ["Do not name the target emotion."],
                "ltxNegativePrompt": "ltx negative",
                "h3NegativePrompt": "h3 negative",
            },
        )
        assert version.status_code == 201
        draft = version.json()
        assert draft["templateId"] == identity["id"]
        assert draft["version"] == 1
        assert draft["verificationStatus"] == "Draft"

        stale = client.post(
            f"/api/prompt-templates/{identity['id']}/versions",
            json={
                "expectedTemplateRevision": identity["revision"],
                "ltxNegativePrompt": "other ltx negative",
                "h3NegativePrompt": "other h3 negative",
            },
        )
        assert stale.status_code == 409

        stale_verify = client.post(
            f"/api/prompt-template-versions/{draft['id']}/verify",
            json={"expectedRevision": draft["revision"] + 1},
        )
        assert stale_verify.status_code == 409
        verified = client.post(
            f"/api/prompt-template-versions/{draft['id']}/verify",
            json={"expectedRevision": draft["revision"]},
        )
        assert verified.status_code == 200
        assert verified.json()["verificationStatus"] == "Verified"

    with app.state.database.read_session() as session:
        examples = session.exec(
            select(PromptTemplateExample).where(
                PromptTemplateExample.prompt_template_version_id == draft["id"]
            )
        ).all()
        assert {row.text for row in examples} == {
            "Keep visible behavior specific.",
            "Do not name the target emotion.",
        }

    with pytest.raises(IntegrityError):
        with app.state.database.immediate_session() as session:
            row = session.get(PromptTemplateVersion, draft["id"])
            assert row is not None
            row.style_instruction = "Changed in place"
            session.flush()


def test_prompt_tests_accept_draft_and_verified_versions_without_gpu_or_media(
    tmp_path: Path,
) -> None:
    app = make_app(tmp_path)
    with TestClient(app) as client:
        content, verified, scene = create_api_sources(client)
        template = client.get(
            f"/api/prompt-templates/{verified['templateId']}"
        ).json()
        draft = client.post(
            f"/api/prompt-templates/{template['id']}/versions",
            json={
                "expectedTemplateRevision": template["revision"],
                "organizationRules": "Keep the selected records in component order.",
                "styleGuidance": "Use a static medium shot.",
                "ltxNegativePrompt": "ltx test negative",
                "h3NegativePrompt": "h3 test negative",
            },
        ).json()

        ltx = client.post(
            "/api/test-runs/prompt",
            json=prompt_test_payload(content, draft, scene, ModelName.LTX),
        )
        h3 = client.post(
            "/api/test-runs/prompt",
            json=prompt_test_payload(content, draft, scene, ModelName.H3),
        )
        verified_run = client.post(
            "/api/test-runs/prompt",
            json=prompt_test_payload(content, verified, scene, ModelName.LTX),
        )
        assert ltx.status_code == h3.status_code == verified_run.status_code == 201
        assert ltx.json()["source"] == h3.json()["source"] == "PromptTest"
        ltx_item = client.get(
            f"/api/test-results/{ltx.json()['id']}/items"
        ).json()["items"][0]
        h3_item = client.get(
            f"/api/test-results/{h3.json()['id']}/items"
        ).json()["items"][0]
        assert ltx_item["gpuSlot"] is None
        assert ltx_item["promptResult"]["negativePrompt"] == "ltx test negative"
        assert h3_item["promptResult"]["negativePrompt"] == "h3 test negative"
        assert (
            ltx_item["promptResult"]["finalPositivePrompt"]
            == h3_item["promptResult"]["finalPositivePrompt"]
        )

    with app.state.database.read_session() as session:
        assert session.exec(select(GenerationAttempt)).all() == []
        assert session.exec(select(Asset)).all() == []
        assert session.exec(select(Sample)).all() == []
        assert all(
            row.active_job_id is None
            for row in session.exec(select(GpuSlot)).all()
        )


def test_sqlite_rejects_changing_a_sample_to_a_test_job_item(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    timestamp = utc_now()
    with app.state.database.immediate_session() as session:
        sample = session.get(Sample, 1)
        assert sample is not None
        production_item = session.get(JobItem, sample.job_item_id)
        assert production_item is not None
        production_snapshot = session.get(
            BatchVideoInputSnapshot,
            production_item.input_snapshot_id,
        )
        assert production_snapshot is not None
        test_job = Job(
            display_name="A-VA-prompt-test",
            source=JobSource.PROMPT_TEST,
            dataset_id=None,
            batch_draft_id=None,
            category=production_snapshot.category,
            conflict_direction=production_snapshot.conflict_direction,
            model=None,
            precision=None,
            status=JobStatus.COMPLETED,
            total_count=1,
            prepared_count=1,
            completed_count=1,
            started_at=timestamp,
            finished_at=timestamp,
            created_at=timestamp,
            updated_at=timestamp,
        )
        session.add(test_job)
        session.flush()
        test_snapshot = BatchVideoInputSnapshot(
            batch_draft_id=None,
            dataset_id=None,
            dataset_revision=None,
            sequence=1,
            content_script_id=production_snapshot.content_script_id,
            content_script_revision=production_snapshot.content_script_revision,
            prompt_template_version_id=production_snapshot.prompt_template_version_id,
            prompt_template_version_revision=production_snapshot.prompt_template_version_revision,
            scene_id=production_snapshot.scene_id,
            scene_revision=production_snapshot.scene_revision,
            policy_version=production_snapshot.policy_version,
            category=production_snapshot.category,
            conflict_direction=production_snapshot.conflict_direction,
            age=production_snapshot.age,
            gender=production_snapshot.gender,
            ethnicity=production_snapshot.ethnicity,
            model=production_snapshot.model,
            precision=production_snapshot.precision,
            seed=production_snapshot.seed,
            width=production_snapshot.width,
            height=production_snapshot.height,
            fps=production_snapshot.fps,
            frame_count=production_snapshot.frame_count,
            renderer_profile_version=production_snapshot.renderer_profile_version,
            prompt_model=production_snapshot.prompt_model,
            source_has_audio=True,
            derive_silent_primary=production_snapshot.derive_silent_primary,
            system_input=production_snapshot.system_input,
            user_input=production_snapshot.user_input,
            negative_prompt=production_snapshot.negative_prompt,
            true_emotion=production_snapshot.true_emotion,
            apparent_emotion=production_snapshot.apparent_emotion,
            created_at=timestamp,
        )
        session.add(test_snapshot)
        session.flush()
        test_item = JobItem(
            job_id=test_job.id,
            sequence=1,
            input_snapshot_id=test_snapshot.id,
            gpu_slot=None,
            stage=JobItemStage.COMPLETED,
            status=JobStatus.COMPLETED,
            created_at=timestamp,
            updated_at=timestamp,
        )
        session.add(test_item)
        session.flush()
        test_item_id = test_item.id
        sample_id = sample.id

    with pytest.raises(IntegrityError):
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql(
                "UPDATE samples SET job_item_id = ? WHERE id = ?",
                (test_item_id, sample_id),
            )


def test_test_result_filters_are_applied_before_fixed_pagination(
    tmp_path: Path,
) -> None:
    app = make_app(tmp_path)
    timestamp = utc_now()
    with app.state.database.immediate_session() as session:
        for index in range(21):
            session.add(
                Job(
                    display_name=f"A-VA-prompt-{index}",
                    source=JobSource.PROMPT_TEST,
                    category="A-VA",
                    status=JobStatus.COMPLETED,
                    total_count=1,
                    prepared_count=1,
                    completed_count=1,
                    started_at=timestamp,
                    finished_at=timestamp,
                    created_at=timestamp,
                    updated_at=timestamp,
                )
            )
        for index in range(3):
            session.add(
                Job(
                    display_name=f"A-VA-video-{index}",
                    source=JobSource.VIDEO_TEST,
                    category="A-VA",
                    status=JobStatus.COMPLETED,
                    total_count=1,
                    prepared_count=1,
                    completed_count=1,
                    started_at=timestamp,
                    finished_at=timestamp,
                    created_at=timestamp,
                    updated_at=timestamp,
                )
            )

    with TestClient(app) as client:
        prompt_page = client.get(
            "/api/test-results",
            params={"source": "PromptTest", "page": 2},
        )
        video_page = client.get(
            "/api/test-results",
            params={"source": "VideoTest", "page": 1},
        )
        production = client.get("/api/generation-results")
        invalid = client.get(
            "/api/test-results",
            params={"source": "Production"},
        )

    assert prompt_page.status_code == 200
    assert prompt_page.json()["pageSize"] == 20
    assert prompt_page.json()["total"] == 21
    assert prompt_page.json()["totalPages"] == 2
    assert len(prompt_page.json()["items"]) == 1
    assert all(row["source"] == "PromptTest" for row in prompt_page.json()["items"])
    assert video_page.json()["total"] == 3
    assert all(row["source"] == "VideoTest" for row in video_page.json()["items"])
    assert production.json()["total"] == 0
    assert invalid.status_code == 422
