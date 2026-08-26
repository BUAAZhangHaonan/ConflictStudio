from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import select

from backend.domain.enums import BatchDraftStatus, DatasetPurpose, GenerationAttemptStatus, JobItemStage, JobSource, JobStatus
from backend.domain.models import Archive, ArchiveItem, Asset, BatchDraft, BatchVideoInputSnapshot, Dataset, GenerationAttempt, Job, JobItem, JobItemPromptResult, Review, Sample, utc_now
from backend.services.samples import create_sample_for_completed_item
from backend.domain.schemas import ReviewQueueFilter
from backend.tests.test_invariants import client_for
from backend.tests.test_review_api import create_reviewer, review_payload, sample_app


def test_dataset_create_status_transitions_and_empty_delete(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        removed_field = client.post(
            "/api/datasets",
            json={"name": "Removed field", "purpose": "Production", "note": ""},
        )
        created = client.post(
            "/api/datasets",
            json={"name": "Formal batch", "note": "First batch"},
        )
        assert created.status_code == 201
        assert created.json()["purpose"] == "Formal"
        assert created.json()["status"] == "Active"

        inactive = client.patch(
            f"/api/datasets/{created.json()['id']}",
            json={"expectedRevision": 1, "status": "Inactive"},
        )
        active = client.patch(
            f"/api/datasets/{created.json()['id']}",
            json={"expectedRevision": 2, "status": "Active"},
        )
        stale = client.patch(
            f"/api/datasets/{created.json()['id']}",
            json={"expectedRevision": 2, "status": "Inactive"},
        )
        disabled = client.patch(
            f"/api/datasets/{created.json()['id']}",
            json={"expectedRevision": 3, "status": "Disabled"},
        )
        deleted = client.delete(
            f"/api/datasets/{created.json()['id']}?expectedRevision=3"
        )
        missing = client.delete(
            f"/api/datasets/{created.json()['id']}?expectedRevision=3"
        )

    assert removed_field.status_code == 422
    assert inactive.status_code == 200 and inactive.json()["revision"] == 2
    assert active.status_code == 200 and active.json()["revision"] == 3
    assert stale.status_code == 409
    assert disabled.status_code == 422
    assert deleted.status_code == 204
    assert missing.status_code == 404


def test_dataset_delete_reports_every_reference_without_cascade(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        dataset = next(
            row
            for row in client.get("/api/datasets").json()["items"]
            if row["id"] == sample["datasetId"]
        )
        timestamp = utc_now()
        with app.state.database.immediate_session() as session:
            session.add(
                Archive(
                    dataset_id=dataset["id"],
                    last_synced_at=timestamp,
                    created_at=timestamp,
                    updated_at=timestamp,
                )
            )
            session.add(
                ArchiveItem(
                    dataset_id=dataset["id"],
                    sample_id=sample["id"],
                    sample_revision=sample["revision"],
                    synced_at=timestamp,
                )
            )

        blocked = client.delete(
            f"/api/datasets/{dataset['id']}?expectedRevision={dataset['revision']}"
        )

    assert blocked.status_code == 409
    body = blocked.json()["error"]
    assert body["code"] == "dataset_not_empty"
    assert body["details"]["references"] == {
        "samples": 1,
        "jobs": 1,
        "archives": 1,
        "archiveItems": 1,
        "batchDrafts": 1,
    }
    with app.state.database.read_session() as session:
        assert session.get(Dataset, dataset["id"]) is not None
        assert session.get(Sample, sample["id"]) is not None
        assert session.get(Archive, dataset["id"]) is not None
        assert session.get(ArchiveItem, (dataset["id"], sample["id"])) is not None
        assert session.get(Job, 1) is not None
        assert session.get(BatchDraft, 1) is not None


def test_incremental_production_appends_without_changing_existing_review(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        existing = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        reviewed = client.post(
            "/api/reviews",
            json=review_payload(existing, reviewer),
        ).json()

    timestamp = utc_now()
    with app.state.database.immediate_session() as session:
        original = session.get(Sample, existing["id"])
        original_item = session.get(JobItem, original.job_item_id if original else 0)
        original_job = session.get(Job, original_item.job_id if original_item else 0)
        original_snapshot = session.get(
            BatchVideoInputSnapshot,
            original_item.input_snapshot_id if original_item else 0,
        )
        original_prompt = session.exec(
            select(JobItemPromptResult).where(
                JobItemPromptResult.job_item_id == (original_item.id if original_item else 0)
            )
        ).one()
        original_attempt = session.exec(
            select(GenerationAttempt).where(
                GenerationAttempt.job_item_id == (original_item.id if original_item else 0)
            )
        ).one()
        dataset = session.get(Dataset, original.dataset_id if original else 0)
        assert original is not None
        assert original_item is not None
        assert original_job is not None
        assert original_snapshot is not None
        assert dataset is not None
        dataset.purpose = DatasetPurpose.FORMAL

        draft = BatchDraft(
            dataset_id=dataset.id,
            dataset_revision=dataset.revision,
            category=original.category,
            conflict_direction=original.conflict_direction,
            model=original.model,
            precision=original_attempt.precision,
            status=BatchDraftStatus.SUBMITTED,
        )
        session.add(draft)
        session.flush()
        snapshot_values = original_snapshot.model_dump(
            exclude={
                "id",
                "batch_draft_id",
                "dataset_id",
                "dataset_revision",
                "dataset_name",
                "sequence",
                "seed",
                "created_at",
            }
        )
        snapshot = BatchVideoInputSnapshot(
            **snapshot_values,
            batch_draft_id=draft.id,
            dataset_id=dataset.id,
            dataset_revision=dataset.revision,
            dataset_name=dataset.name,
            sequence=1,
            seed=78,
            created_at=timestamp,
        )
        session.add(snapshot)
        session.flush()
        job = Job(
            display_name="A-VA-incremental",
            source=JobSource.PRODUCTION,
            dataset_id=dataset.id,
            dataset_name_snapshot=dataset.name,
            batch_draft_id=draft.id,
            category=original.category,
            conflict_direction=original.conflict_direction,
            model=original.model,
            precision=original_attempt.precision,
            status=JobStatus.COMPLETED,
            total_count=1,
            prepared_count=1,
            completed_count=1,
            started_at=timestamp,
            finished_at=timestamp,
        )
        session.add(job)
        session.flush()
        item = JobItem(
            job_id=job.id,
            sequence=1,
            input_snapshot_id=snapshot.id,
            gpu_slot=original.gpu_slot,
            stage=JobItemStage.COMPLETED,
            status=JobStatus.COMPLETED,
            renderer_prompt_id="incremental-prompt",
        )
        session.add(item)
        session.flush()
        relative_path = "media/incremental.mp4"
        media_path = app.state.database.data_root / relative_path
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b"video-2")
        asset = Asset(
            origin_job_item_id=item.id,
            storage_root=str(app.state.database.data_root),
            relative_path=relative_path,
            media_type="video/mp4",
            byte_size=7,
            width=1344,
            height=768,
            fps=24,
            frame_count=121,
            duration_seconds=121 / 24,
            has_audio=True,
        )
        session.add(asset)
        session.flush()
        item.source_asset_id = asset.id
        item.primary_asset_id = asset.id
        session.add(
            JobItemPromptResult(
                **original_prompt.model_dump(exclude={"id", "job_item_id", "created_at"}),
                job_item_id=item.id,
                created_at=timestamp,
            )
        )
        session.add(
            GenerationAttempt(
                job_item_id=item.id,
                attempt_number=1,
                model=original.model,
                precision=original_attempt.precision,
                gpu_slot=original.gpu_slot,
                seed=78,
                source_asset_id=asset.id,
                primary_asset_id=asset.id,
                renderer_prompt_id=item.renderer_prompt_id,
                status=GenerationAttemptStatus.COMPLETED,
                started_at=timestamp,
                finished_at=timestamp,
            )
        )
        appended = create_sample_for_completed_item(session, job, item, dataset.id)
        session.flush()
        appended_id = appended.id

    samples = app.state.sample_service.list_samples(
        1, ReviewQueueFilter(dataset_id=existing["datasetId"])
    )
    unchanged = app.state.sample_service.get_sample(existing["id"])

    assert samples.total == 2
    assert appended_id != existing["id"]
    assert unchanged.revision == reviewed["revision"]
    assert unchanged.review_decision.value == reviewed["reviewDecision"]
    assert unchanged.review_revision == reviewed["reviewRevision"]
    assert unchanged.current_review is not None
    assert unchanged.current_review.id == reviewed["currentReview"]["id"]
    assert unchanged.primary_media.url == reviewed["primaryMedia"]["url"]
