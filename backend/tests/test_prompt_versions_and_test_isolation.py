from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from backend.adapters.llm import UnconfiguredPromptModel
from backend.domain.enums import (
    GpuSlotName,
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
    JobItemPromptResult,
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
from backend.tests.support import mark_prompt_version_verified


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


def add_video_test_media(app) -> dict[str, int]:  # type: ignore[no-untyped-def]
    timestamp = utc_now()
    with app.state.database.immediate_session() as session:
        sample = session.exec(select(Sample)).one()
        production_item = session.get(JobItem, sample.job_item_id)
        assert production_item is not None
        production_snapshot = session.get(
            BatchVideoInputSnapshot,
            production_item.input_snapshot_id,
        )
        production_asset = session.get(Asset, sample.primary_asset_id)
        assert production_snapshot is not None
        assert production_asset is not None

        test_job = Job(
            display_name="A-VA-video-test",
            source=JobSource.VIDEO_TEST,
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

        snapshot_data = production_snapshot.model_dump(
            exclude={
                "id",
                "batch_draft_id",
                "dataset_id",
                "dataset_revision",
                "dataset_name",
                "sequence",
            }
        )
        test_snapshot = BatchVideoInputSnapshot(
            **snapshot_data,
            batch_draft_id=None,
            dataset_id=None,
            dataset_revision=None,
            sequence=1,
        )
        session.add(test_snapshot)
        session.flush()
        test_item = JobItem(
            job_id=test_job.id,
            sequence=2,
            input_snapshot_id=test_snapshot.id,
            gpu_slot=GpuSlotName.GPU0,
            stage=JobItemStage.COMPLETED,
            status=JobStatus.COMPLETED,
            created_at=timestamp,
            updated_at=timestamp,
        )
        session.add(test_item)
        session.flush()

        relative_path = f"media/video-test-{test_item.id}.mp4"
        media_path = app.state.database.data_root / relative_path
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b"video-test")
        test_asset = Asset(
            origin_job_item_id=test_item.id,
            storage_root=str(app.state.database.data_root),
            relative_path=relative_path,
            media_type=production_asset.media_type,
            byte_size=media_path.stat().st_size,
            width=production_asset.width,
            height=production_asset.height,
            fps=production_asset.fps,
            frame_count=production_asset.frame_count,
            duration_seconds=production_asset.duration_seconds,
            has_audio=production_asset.has_audio,
            created_at=timestamp,
        )
        session.add(test_asset)
        session.flush()
        test_item.source_asset_id = test_asset.id
        test_item.primary_asset_id = test_asset.id
        session.flush()

        return {
            "sample_id": sample.id,
            "production_job_id": production_item.job_id,
            "test_job_id": test_job.id,
            "test_item_id": test_item.id,
            "test_asset_id": test_asset.id,
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
        untested = client.post(
            f"/api/prompt-template-versions/{draft['id']}/verify",
            json={"expectedRevision": draft["revision"]},
        )
        assert untested.status_code == 409
        assert untested.json()["error"]["code"] == "state_conflict"
        mark_prompt_version_verified(app.state.database, draft["id"])
        verified = client.get(
            f"/api/prompt-template-versions/{draft['id']}"
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


@pytest.mark.parametrize(
    "evidence_kind",
    ["VideoTest", "Production", "FailedPromptTest", "OldRevision"],
)
def test_verify_rejects_nonmatching_prompt_test_evidence(
    tmp_path: Path,
    evidence_kind: str,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        template = client.get("/api/prompt-templates").json()["items"][0]
        draft = client.post(
            f"/api/prompt-templates/{template['id']}/versions",
            json={
                "expectedTemplateRevision": template["revision"],
                "ltxNegativePrompt": "draft ltx negative",
                "h3NegativePrompt": "draft h3 negative",
            },
        ).json()

        with app.state.database.immediate_session() as session:
            sample = session.exec(select(Sample)).one()
            production_item = session.get(JobItem, sample.job_item_id)
            assert production_item is not None
            production_job = session.get(Job, production_item.job_id)
            production_snapshot = session.get(
                BatchVideoInputSnapshot,
                production_item.input_snapshot_id,
            )
            production_result = session.exec(
                select(JobItemPromptResult).where(
                    JobItemPromptResult.job_item_id == production_item.id
                )
            ).one()
            assert production_job is not None
            assert production_snapshot is not None

            source = (
                JobSource.VIDEO_TEST
                if evidence_kind == "VideoTest"
                else JobSource.PRODUCTION
                if evidence_kind == "Production"
                else JobSource.PROMPT_TEST
            )
            if source is JobSource.PRODUCTION:
                evidence_job = production_job
            else:
                failed = evidence_kind == "FailedPromptTest"
                evidence_job = Job(
                    display_name=f"{evidence_kind}-evidence",
                    source=source,
                    category=production_job.category,
                    conflict_direction=production_job.conflict_direction,
                    status=JobStatus.FAILED if failed else JobStatus.COMPLETED,
                    total_count=1,
                    prepared_count=1,
                    completed_count=0 if failed else 1,
                    failed_count=1 if failed else 0,
                    failure_code="forced_failure" if failed else None,
                    failure_reason="forced failure" if failed else None,
                    started_at=utc_now(),
                    finished_at=utc_now(),
                )
                session.add(evidence_job)
                session.flush()

            snapshot_values = production_snapshot.model_dump(
                exclude={
                    "id",
                    "batch_draft_id",
                    "dataset_id",
                    "dataset_revision",
                    "dataset_name",
                    "sequence",
                    "prompt_template_version_id",
                    "prompt_template_version_revision",
                }
            )
            production = source is JobSource.PRODUCTION
            evidence_snapshot = BatchVideoInputSnapshot(
                **snapshot_values,
                batch_draft_id=(
                    production_snapshot.batch_draft_id if production else None
                ),
                dataset_id=production_snapshot.dataset_id if production else None,
                dataset_revision=(
                    production_snapshot.dataset_revision if production else None
                ),
                dataset_name=(
                    production_snapshot.dataset_name if production else None
                ),
                sequence=production_snapshot.sequence + 1 if production else 1,
                prompt_template_version_id=draft["id"],
                prompt_template_version_revision=(
                    draft["revision"] + 1
                    if evidence_kind == "OldRevision"
                    else draft["revision"]
                ),
            )
            session.add(evidence_snapshot)
            session.flush()
            evidence_item = JobItem(
                job_id=evidence_job.id,
                sequence=production_item.sequence + 1 if production else 1,
                input_snapshot_id=evidence_snapshot.id,
                gpu_slot=(
                    production_item.gpu_slot
                    if production
                    else GpuSlotName.GPU0
                    if source is JobSource.VIDEO_TEST
                    else None
                ),
                stage=JobItemStage.COMPLETED,
                status=JobStatus.COMPLETED,
            )
            session.add(evidence_item)
            session.flush()
            session.add(
                JobItemPromptResult(
                    **production_result.model_dump(
                        exclude={"id", "job_item_id"}
                    ),
                    job_item_id=evidence_item.id,
                )
            )
            session.flush()

        rejected = client.post(
            f"/api/prompt-template-versions/{draft['id']}/verify",
            json={"expectedRevision": draft["revision"]},
        )
        current = client.get(
            f"/api/prompt-template-versions/{draft['id']}"
        )

    assert rejected.status_code == 409
    assert rejected.json()["error"]["code"] == "state_conflict"
    assert current.json()["verificationStatus"] == "Draft"
    assert current.json()["revision"] == draft["revision"]


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
        verified_draft = client.post(
            f"/api/prompt-template-versions/{draft['id']}/verify",
            json={"expectedRevision": draft["revision"]},
        )
        assert verified_draft.status_code == 200
        assert verified_draft.json()["verificationStatus"] == "Verified"
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
        assert client.get(
            f"/api/test-results/{ltx.json()['id']}"
        ).json()["profiles"] == [{"model": "LTX-2.3", "precision": None}]
        assert client.get(
            f"/api/test-results/{h3.json()['id']}"
        ).json()["profiles"] == [{"model": "MiniMax H3", "precision": None}]
        listed_profiles = {
            row["id"]: row["profiles"]
            for row in client.get("/api/test-results").json()["items"]
        }
        assert listed_profiles[ltx.json()["id"]] == [
            {"model": "LTX-2.3", "precision": None}
        ]
        assert listed_profiles[h3.json()["id"]] == [
            {"model": "MiniMax H3", "precision": None}
        ]
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
        snapshot_data = production_snapshot.model_dump(
            exclude={
                "id",
                "batch_draft_id",
                "dataset_id",
                "dataset_revision",
                "dataset_name",
                "sequence",
            }
        )
        test_snapshot = BatchVideoInputSnapshot(
            **snapshot_data,
            batch_draft_id=None,
            dataset_id=None,
            dataset_revision=None,
            dataset_name=None,
            sequence=1,
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


@pytest.mark.parametrize(
    ("column", "replacement"),
    [
        ("source", "'VideoTest'"),
        ("dataset_id", "NULL"),
        ("batch_draft_id", "NULL"),
    ],
)
def test_sqlite_rejects_changing_job_source_or_production_ownership(
    tmp_path: Path,
    column: str,
    replacement: str,
) -> None:
    app = sample_app(tmp_path)
    with app.state.database.read_session() as session:
        sample = session.exec(select(Sample)).one()
        item = session.get(JobItem, sample.job_item_id)
        assert item is not None
        job_id = item.job_id

    statement = (
        "UPDATE jobs SET source = 'VideoTest', dataset_id = NULL, "
        "batch_draft_id = NULL, model = NULL, precision = NULL WHERE id = ?"
        if column == "source"
        else f"UPDATE jobs SET {column} = {replacement} WHERE id = ?"
    )
    with pytest.raises(IntegrityError):
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql(statement, (job_id,))


def test_sqlite_rejects_job_item_reparenting_and_video_test_media_bypass(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    identifiers = add_video_test_media(app)

    with pytest.raises(IntegrityError):
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql(
                """
                UPDATE jobs
                SET source = 'Production',
                    dataset_id = (SELECT dataset_id FROM jobs WHERE id = ?),
                    batch_draft_id = (SELECT batch_draft_id FROM jobs WHERE id = ?),
                    model = (SELECT model FROM jobs WHERE id = ?),
                    precision = (SELECT precision FROM jobs WHERE id = ?)
                WHERE id = ?
                """,
                (
                    identifiers["production_job_id"],
                    identifiers["production_job_id"],
                    identifiers["production_job_id"],
                    identifiers["production_job_id"],
                    identifiers["test_job_id"],
                ),
            )

    with pytest.raises(IntegrityError):
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql(
                "UPDATE job_items SET job_id = ? WHERE id = ?",
                (
                    identifiers["production_job_id"],
                    identifiers["test_item_id"],
                ),
            )

    with pytest.raises(IntegrityError, match="samples require completed production media"):
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql(
                """
                UPDATE samples
                SET job_item_id = ?, source_asset_id = ?, primary_asset_id = ?
                WHERE id = ?
                """,
                (
                    identifiers["test_item_id"],
                    identifiers["test_asset_id"],
                    identifiers["test_asset_id"],
                    identifiers["sample_id"],
                ),
            )

    with app.state.database.read_session() as session:
        sample = session.get(Sample, identifiers["sample_id"])
        test_item = session.get(JobItem, identifiers["test_item_id"])
        assert sample is not None
        assert test_item is not None
        assert sample.job_item_id != test_item.id
        assert test_item.job_id == identifiers["test_job_id"]


def test_sqlite_rejects_changing_referenced_batch_draft_ownership(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with app.state.database.read_session() as session:
        sample = session.exec(select(Sample)).one()
        item = session.get(JobItem, sample.job_item_id)
        assert item is not None
        job = session.get(Job, item.job_id)
        assert job is not None
        assert job.batch_draft_id is not None
        batch_draft_id = job.batch_draft_id

    with pytest.raises(IntegrityError, match="referenced batch draft identity is immutable"):
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql(
                "UPDATE batch_drafts SET dataset_id = dataset_id + 1000 WHERE id = ?",
                (batch_draft_id,),
            )


def test_valid_production_sample_keeps_one_consistent_parent_chain(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        response = client.get("/api/samples")

    assert response.status_code == 200
    assert response.json()["total"] == 1
    with app.state.database.engine.connect() as connection:
        valid_chain_count = connection.exec_driver_sql(
            """
            SELECT count(*)
            FROM samples
            JOIN job_items ON job_items.id = samples.job_item_id
            JOIN jobs ON jobs.id = job_items.job_id
            JOIN batch_drafts ON batch_drafts.id = jobs.batch_draft_id
            JOIN batch_video_input_snapshots AS snapshots
              ON snapshots.id = job_items.input_snapshot_id
            JOIN assets ON assets.id = samples.primary_asset_id
            WHERE jobs.source = 'Production'
              AND jobs.dataset_id = samples.dataset_id
              AND batch_drafts.dataset_id = jobs.dataset_id
              AND snapshots.batch_draft_id = jobs.batch_draft_id
              AND snapshots.dataset_id = jobs.dataset_id
              AND assets.origin_job_item_id = job_items.id
            """
        ).scalar_one()
    assert valid_chain_count == 1


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


def test_prompt_test_missing_key_returns_readable_error(tmp_path: Path) -> None:
    app = make_app(tmp_path, UnconfiguredPromptModel())
    with TestClient(app) as client:
        content, version, scene = create_api_sources(client)
        response = client.post(
            "/api/test-runs/prompt",
            json=prompt_test_payload(content, version, scene, ModelName.LTX),
        )

    assert response.status_code == 503
    assert response.json() == {
        "error": {
            "code": "external_configuration_missing",
            "message": "Prompt generation requires a configured service key",
            "details": {},
        }
    }
    assert "CONFLICTSTUDIO_LLM_API_KEY" not in response.text
