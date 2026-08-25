from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from backend.domain.enums import (
    Category,
    JobItemStage,
    JobSource,
    JobStatus,
    ContentMode,
    GenerationAttemptStatus,
    ReviewDecision,
)
from backend.domain.models import (
    Asset,
    BatchVideoInputSnapshot,
    ContentScript,
    ContentScriptScene,
    GenerationAttempt,
    Job,
    JobItem,
    Sample,
    SampleClassificationChange,
    VIDEO_FPS,
    VIDEO_HEIGHT,
    VIDEO_WIDTH,
    utc_now,
)
from backend.tests.test_sample_integration import add_completed_result, make_app


def sample_app(tmp_path: Path, **source_options: object):  # type: ignore[no-untyped-def]
    app = make_app(tmp_path)
    job_id, item_id, _ = add_completed_result(
        app,
        JobSource.PRODUCTION,
        **source_options,
    )
    app.state.job_executor._complete_item(job_id, item_id)
    return app


@pytest.mark.parametrize(
    ("actual_scene_id", "register_scene", "expected", "compatible_scene_count"),
    [
        (1, True, "NeedsRegeneration", 1),
        (22, True, "Compatible", 1),
        (22, False, "NeedsRegeneration", 0),
    ],
)
def test_sample_derives_generation_compatibility_from_actual_content_scene_mapping(
    tmp_path: Path,
    actual_scene_id: int,
    register_scene: bool,
    expected: str,
    compatible_scene_count: int,
) -> None:
    app = sample_app(
        tmp_path,
        content_id=22,
        actual_background_id=actual_scene_id,
        registered_background_id=22,
        register_background=register_scene,
    )

    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        detail = client.get(f"/api/samples/{sample['id']}")

    assert sample["generationCompatibility"] == expected
    assert sample["contentScriptNameEn"] == "Aligned response"
    assert detail.status_code == 200
    assert detail.json()["compatibleSceneCount"] == compatible_scene_count

def test_review_detail_counts_all_current_content_script_scene_links(
    tmp_path: Path,
) -> None:
    app = sample_app(
        tmp_path,
        content_id=22,
        actual_background_id=1,
        registered_background_id=22,
    )
    with app.state.database.immediate_session() as session:
        content = session.get(ContentScript, 22)
        assert content is not None
        content.mode = ContentMode.GENERATIVE
        content.content_requirements_zh = "生成内容"
        content.content_requirements_en = "Generate content"
        session.flush()
        session.add(ContentScriptScene(content_script_id=22, scene_id=1, position=1))
        session.flush()

    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        detail = client.get(f"/api/samples/{sample['id']}")

    assert detail.status_code == 200
    assert detail.json()["compatibleSceneCount"] == 2


def test_incompatible_generation_cannot_be_accepted_but_can_be_rejected(
    tmp_path: Path,
) -> None:
    app = sample_app(
        tmp_path,
        content_id=22,
        actual_background_id=1,
        registered_background_id=22,
    )
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        accepted = client.post("/api/reviews", json=review_payload(sample, reviewer))
        rejected = client.post(
            "/api/reviews",
            json=review_payload(sample, reviewer, decision="Rejected"),
        )

    assert accepted.status_code == 422
    assert accepted.json()["error"]["code"] == "generation_incompatible"
    assert accepted.json()["error"]["details"] == {
        "resource": "sample",
        "id": sample["id"],
        "generationCompatibility": "NeedsRegeneration",
    }
    assert rejected.status_code == 201
    assert rejected.json()["reviewDecision"] == "Rejected"


def create_reviewer(client: TestClient, name: str = "Reviewer One") -> dict:
    response = client.post("/api/reviewers", json={"name": name})
    assert response.status_code == 201
    return response.json()


def review_payload(sample: dict, reviewer: dict, **changes: object) -> dict:
    payload: dict[str, object] = {
        "sampleId": sample["id"],
        "reviewerId": reviewer["id"],
        "decision": "Accepted",
        "expectedRevision": sample["revision"],
        "expectedReviewRevision": sample["reviewRevision"],
        "expectedNoteDraftRevision": 0,
        "queue": {"decision": "All"},
    }
    payload.update(changes)
    return payload


def batch_review_payload(sample: dict, reviewer: dict, **changes: object) -> dict:
    payload = review_payload(sample, reviewer, **changes)
    del payload["queue"]
    return payload


def save_note(
    client: TestClient,
    sample: dict,
    reviewer: dict,
    note: str,
    expected_revision: int = 0,
) -> dict:
    response = client.put(
        f"/api/samples/{sample['id']}/review-note-draft",
        json={
            "reviewerId": reviewer["id"],
            "note": note,
            "expectedRevision": expected_revision,
            "expectedSampleRevision": sample["revision"],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def classification_payload(
    sample: dict,
    reviewer: dict,
    target_category: str,
    description: str,
    *,
    direction: str | None = None,
    apparent_emotion: str | None = None,
) -> dict:
    payload: dict[str, object] = {
        "reviewerId": reviewer["id"],
        "expectedRevision": sample["revision"],
        "targetCategory": target_category,
        "conflictDirection": direction,
        "trueEmotionDescription": description,
    }
    if apparent_emotion is not None:
        payload["apparentEmotion"] = apparent_emotion
    return payload


def add_sample_copies(app, count: int) -> list[int]:  # type: ignore[no-untyped-def]
    timestamp = utc_now()
    with app.state.database.immediate_session() as session:
        source = session.get(Sample, 1)
        assert source is not None
        source_item = session.get(JobItem, source.job_item_id)
        assert source_item is not None
        source_snapshot = session.get(
            BatchVideoInputSnapshot,
            source_item.input_snapshot_id,
        )
        assert source_snapshot is not None
        ids: list[int] = []
        for offset in range(1, count + 1):
            sequence = source_item.sequence + offset
            snapshot = BatchVideoInputSnapshot(
                **source_snapshot.model_dump(
                    exclude={"id", "sequence", "seed", "created_at"}
                ),
                sequence=sequence,
                seed=source.seed + offset,
                created_at=timestamp,
            )
            session.add(snapshot)
            session.flush()
            item = JobItem(
                job_id=source_item.job_id,
                sequence=sequence,
                input_snapshot_id=snapshot.id,
                gpu_slot=source_item.gpu_slot,
                stage=JobItemStage.COMPLETED,
                status=JobStatus.COMPLETED,
                renderer_prompt_id=f"review-copy-{sequence}",
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(item)
            session.flush()
            relative_path = f"media/review-copy-{sequence}.mp4"
            media_path = app.state.database.data_root / relative_path
            media_path.write_bytes(f"video-{sequence}".encode())
            asset = Asset(
                origin_job_item_id=item.id,
                storage_root=str(app.state.database.data_root),
                relative_path=relative_path,
                media_type="video/mp4",
                byte_size=media_path.stat().st_size,
                width=VIDEO_WIDTH,
                height=VIDEO_HEIGHT,
                fps=VIDEO_FPS,
                frame_count=121,
                duration_seconds=121 / VIDEO_FPS,
                has_audio=True,
                created_at=timestamp,
            )
            session.add(asset)
            session.flush()
            item.source_asset_id = asset.id
            item.primary_asset_id = asset.id
            session.flush()
            assert item.gpu_slot is not None
            session.add(
                GenerationAttempt(
                    job_item_id=item.id,
                    attempt_number=1,
                    model=snapshot.model,
                    precision=snapshot.precision,
                    gpu_slot=item.gpu_slot,
                    seed=snapshot.seed,
                    source_asset_id=asset.id,
                    primary_asset_id=asset.id,
                    renderer_prompt_id=item.renderer_prompt_id,
                    status=GenerationAttemptStatus.COMPLETED,
                    started_at=timestamp,
                    finished_at=timestamp,
                )
            )
            session.flush()
            copied = Sample(
                **source.model_dump(
                    exclude={
                        "id",
                        "job_item_id",
                        "source_asset_id",
                        "primary_asset_id",
                        "review_decision",
                        "review_revision",
                        "revision",
                        "created_at",
                        "updated_at",
                    }
                ),
                job_item_id=item.id,
                source_asset_id=asset.id,
                primary_asset_id=asset.id,
                review_decision=ReviewDecision.PENDING,
                review_revision=0,
                revision=1,
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(copied)
            session.flush()
            ids.append(copied.id)
        job = session.get(Job, source_item.job_id)
        assert job is not None
        job.total_count = count + 1
        job.prepared_count = count + 1
        job.completed_count = count + 1
        job.failed_count = 0
        job.updated_at = timestamp
        return ids


def test_reviewer_create_normalizes_name_and_rename_is_revisioned(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        created = client.post("/api/reviewers", json={"name": "  Reviewer   One  "})
        duplicate = client.post("/api/reviewers", json={"name": "reviewer one"})
        second = client.post("/api/reviewers", json={"name": "Reviewer Two"})
        renamed = client.patch(
            f"/api/reviewers/{created.json()['id']}",
            json={"name": "Reviewer Primary", "expectedRevision": created.json()["revision"]},
        )
        stale = client.patch(
            f"/api/reviewers/{created.json()['id']}",
            json={"name": "Reviewer Stale", "expectedRevision": created.json()["revision"]},
        )
        conflict = client.patch(
            f"/api/reviewers/{created.json()['id']}",
            json={"name": second.json()["name"], "expectedRevision": renamed.json()["revision"]},
        )

    assert created.status_code == 201
    assert created.json()["name"] == "Reviewer One"
    assert duplicate.status_code == 409
    assert duplicate.json()["error"]["code"] == "reviewer_name_conflict"
    assert renamed.status_code == 200
    assert renamed.json()["revision"] == 2
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "revision_conflict"
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "reviewer_name_conflict"


def test_sample_queue_filters_are_applied_before_pagination(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        dataset = client.get(f"/api/datasets/{sample['datasetId']}").json()
        matching = client.get(
            "/api/samples",
            params={
                "decision": "Pending",
                "datasetId": sample["datasetId"],
                "protocol": "VA",
                "relation": "Aligned",
                "search": sample["displayId"],
            },
        )
        by_dataset_name = client.get(
            "/api/samples",
            params={"decision": "Pending", "search": dataset["name"]},
        )
        wrong_protocol = client.get(
            "/api/samples",
            params={"decision": "Pending", "protocol": "VT"},
        )
        wrong_relation = client.get(
            "/api/samples",
            params={"decision": "Pending", "relation": "Conflict"},
        )

    assert matching.status_code == 200
    assert matching.json()["total"] == 1
    assert matching.json()["items"][0]["datasetName"] == dataset["name"]
    assert by_dataset_name.json()["total"] == 1
    assert wrong_protocol.json()["total"] == 0
    assert wrong_relation.json()["total"] == 0


def test_review_history_is_append_only_and_withdrawal_requires_a_decision(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        initial_pending = client.post(
            "/api/reviews",
            json=review_payload(sample, reviewer, decision="Pending"),
        )
        first = client.post("/api/reviews", json=review_payload(sample, reviewer))
        no_change = client.post(
            "/api/reviews",
            json=review_payload(first.json(), reviewer),
        )
        note_draft = save_note(client, first.json(), reviewer, "second note")
        note_change = client.post(
            "/api/reviews",
            json=review_payload(
                first.json(),
                reviewer,
                expectedNoteDraftRevision=note_draft["revision"],
            ),
        )
        decision_draft = save_note(
            client,
            note_change.json(),
            reviewer,
            "second note",
        )
        decision_change = client.post(
            "/api/reviews",
            json=review_payload(
                note_change.json(),
                reviewer,
                decision="Rejected",
                expectedNoteDraftRevision=decision_draft["revision"],
            ),
        )
        withdrawn = client.post(
            "/api/reviews",
            json=review_payload(decision_change.json(), reviewer, decision="Pending"),
        )
        pending_again = client.post(
            "/api/reviews",
            json=review_payload(withdrawn.json(), reviewer, decision="Pending"),
        )
        history = client.get("/api/reviews", params={"sampleId": sample["id"]})

    assert initial_pending.status_code == 422
    assert first.status_code == 201
    assert first.json()["reviewDecision"] == "Accepted"
    assert first.json()["currentReview"]["sampleRevision"] == sample["revision"]
    assert no_change.status_code == 422
    assert note_change.status_code == 201
    assert decision_change.status_code == 201
    assert withdrawn.status_code == 201
    assert withdrawn.json()["reviewDecision"] == "Pending"
    assert pending_again.status_code == 422
    assert [row["revision"] for row in history.json()["items"]] == [1, 2, 3, 4]
    assert [row["decision"] for row in history.json()["items"]] == [
        "Accepted",
        "Accepted",
        "Rejected",
        "Pending",
    ]
    assert all(
        row["protocol"] == "VA" and row["relation"] == "Aligned"
        for row in history.json()["items"]
    )


def test_review_distinguishes_sample_and_review_revision_conflicts(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        reviewed = client.post("/api/reviews", json=review_payload(sample, reviewer)).json()
        stale_sample = client.post(
            "/api/reviews",
            json=review_payload(
                reviewed,
                reviewer,
                expectedRevision=sample["revision"],
                expectedReviewRevision=reviewed["reviewRevision"],
            ),
        )
        stale_review = client.post(
            "/api/reviews",
            json=review_payload(
                reviewed,
                reviewer,
                expectedReviewRevision=sample["reviewRevision"],
            ),
        )

    assert stale_sample.status_code == 409
    assert stale_sample.json()["error"]["code"] == "revision_conflict"
    assert stale_review.status_code == 409
    assert stale_review.json()["error"]["code"] == "review_revision_conflict"


def test_review_batch_is_atomic_when_any_item_is_invalid(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        response = client.post(
            "/api/reviews/batch",
            json={
                "items": [
                    batch_review_payload(sample, reviewer),
                    batch_review_payload({**sample, "id": 99999}, reviewer),
                ]
            },
        )
        duplicate = client.post(
            "/api/reviews/batch",
            json={
                "items": [
                    batch_review_payload(sample, reviewer),
                    batch_review_payload(sample, reviewer),
                ]
            },
        )
        empty = client.post("/api/reviews/batch", json={"items": []})
        pending = client.post(
            "/api/reviews/batch",
            json={
                "items": [
                    batch_review_payload(sample, reviewer, decision="Pending")
                ]
            },
        )
        history = client.get("/api/reviews", params={"sampleId": sample["id"]})
        unchanged = client.get(f"/api/samples/{sample['id']}")

    assert response.status_code == 404
    assert duplicate.status_code == 422
    assert empty.status_code == 422
    assert pending.status_code == 422
    assert history.json()["items"] == []
    assert unchanged.json()["reviewRevision"] == 0


def test_aligned_to_conflict_requires_coherent_emotions_and_preserves_review_history(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        reviewed = client.post("/api/reviews", json=review_payload(sample, reviewer)).json()
        missing_description = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json={
                "expectedRevision": reviewed["revision"],
                "targetCategory": "C-VA",
                "conflictDirection": "Audio",
                "apparentEmotion": "tense",
            },
        )
        missing_apparent_emotion = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json={
                "expectedRevision": reviewed["revision"],
                "targetCategory": "C-VA",
                "conflictDirection": "Audio",
                "trueEmotionDescription": "The voice carries the true emotion.",
            },
        )
        matching_emotion = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                reviewed,
                reviewer,
                "C-VA",
                "The voice carries the true emotion.",
                direction="Audio",
                apparent_emotion="  CALM  ",
            ),
        )
        invalid_direction = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                reviewed,
                reviewer,
                "C-VA",
                "The voice carries the true emotion.",
                direction="Text",
                apparent_emotion="tense",
            ),
        )
        true_emotion_override = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json={
                **classification_payload(
                    reviewed,
                    reviewer,
                    "C-VA",
                    "The voice carries the true emotion.",
                    direction="Audio",
                    apparent_emotion="tense",
                ),
                "trueEmotion": "joy",
            },
        )
        moved = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                reviewed,
                reviewer,
                "C-VA",
                "  The voice carries the true emotion while the face looks tense.  ",
                direction="Audio",
                apparent_emotion="  TENSE  ",
            ),
        )
        cross_protocol = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                moved.json(),
                reviewer,
                "A-VT",
                "The modalities will align.",
            ),
        )
        stale = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                reviewed,
                reviewer,
                "A-VA",
                "The modalities will align.",
            ),
        )
        history = client.get("/api/reviews", params={"sampleId": sample["id"]})
        current = client.get(f"/api/samples/{sample['id']}")
        removed_endpoint = client.patch(
            f"/api/samples/{sample['id']}/review",
            json={"expectedRevision": moved.json()["revision"], "decision": "Accepted"},
        )

    assert moved.status_code == 200
    assert moved.json()["category"] == "C-VA"
    assert moved.json()["conflictDirection"] == "Audio"
    assert moved.json()["trueEmotion"] == sample["trueEmotion"]
    assert moved.json()["apparentEmotion"] == "tense"
    assert moved.json()["trueEmotionDescription"] == "The voice carries the true emotion while the face looks tense."
    assert moved.json()["reviewDecision"] == "Pending"
    assert moved.json()["reviewRevision"] == reviewed["reviewRevision"]
    assert moved.json()["currentReview"] is None
    assert current.json()["currentReview"] is None
    assert history.json()["total"] == 1
    assert history.json()["items"][0]["decision"] == "Accepted"
    assert missing_description.status_code == 422
    assert missing_apparent_emotion.status_code == 422
    assert matching_emotion.status_code == 422
    assert invalid_direction.status_code == 422
    assert true_emotion_override.status_code == 422
    assert cross_protocol.status_code == 422
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "revision_conflict"
    assert removed_endpoint.status_code == 405


@pytest.mark.parametrize(
    ("category", "target_category", "valid_direction", "invalid_direction"),
    [
        (Category.A_VA, "C-VA", "Audio", "Text"),
        (Category.A_VT, "C-VT", "Text", "Audio"),
    ],
)
def test_aligned_to_conflict_requires_new_emotion_and_protocol_direction(
    tmp_path: Path,
    category: Category,
    target_category: str,
    valid_direction: str,
    invalid_direction: str,
) -> None:
    app = sample_app(tmp_path, category=category)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        missing_emotion = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                sample, reviewer, target_category, "The modalities conflict.",
                direction=valid_direction,
            ),
        )
        matching_emotion = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                sample, reviewer, target_category, "The modalities conflict.",
                direction=valid_direction, apparent_emotion=sample["trueEmotion"],
            ),
        )
        invalid_direction_response = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                sample, reviewer, target_category, "The modalities conflict.",
                direction=invalid_direction, apparent_emotion="tense",
            ),
        )
        moved = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                sample, reviewer, target_category, "The modalities conflict.",
                direction=valid_direction, apparent_emotion="tense",
            ),
        )

    assert missing_emotion.status_code == 422
    assert matching_emotion.status_code == 422
    assert invalid_direction_response.status_code == 422
    assert moved.status_code == 200
    assert moved.json()["apparentEmotion"] == "tense"
    assert moved.json()["conflictDirection"] == valid_direction


def test_conflict_to_aligned_uses_preserved_true_emotion_and_clears_direction(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        aligned = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        conflict = client.patch(
            f"/api/samples/{aligned['id']}/classification",
            json=classification_payload(
                aligned,
                reviewer,
                "C-VA",
                "The voice carries calm while the face appears tense.",
                direction="Audio",
                apparent_emotion="tense",
            ),
        ).json()
        reviewed = client.post("/api/reviews", json=review_payload(conflict, reviewer)).json()
        no_change = client.patch(
            f"/api/samples/{aligned['id']}/classification",
            json=classification_payload(
                reviewed,
                reviewer,
                "C-VA",
                "The voice still carries calm while the face appears tense.",
                direction="Vision",
                apparent_emotion="worried",
            ),
        )
        explicit_apparent_emotion = client.patch(
            f"/api/samples/{aligned['id']}/classification",
            json={
                **classification_payload(
                    reviewed,
                    reviewer,
                    "A-VA",
                    "The voice and face now express the same calm emotion.",
                ),
                "apparentEmotion": None,
            },
        )
        moved = client.patch(
            f"/api/samples/{aligned['id']}/classification",
            json=classification_payload(
                reviewed,
                reviewer,
                "A-VA",
                "  The voice and face now express the same calm emotion.  ",
            ),
        )
        history = client.get("/api/reviews", params={"sampleId": aligned["id"]})

    assert no_change.status_code == 422
    assert explicit_apparent_emotion.status_code == 422
    assert moved.status_code == 200
    assert moved.json()["category"] == "A-VA"
    assert moved.json()["conflictDirection"] is None
    assert moved.json()["trueEmotion"] == aligned["trueEmotion"]
    assert moved.json()["apparentEmotion"] == aligned["trueEmotion"]
    assert moved.json()["trueEmotionDescription"] == "The voice and face now express the same calm emotion."
    assert moved.json()["reviewDecision"] == "Pending"
    assert moved.json()["reviewRevision"] == reviewed["reviewRevision"]
    assert moved.json()["currentReview"] is None
    assert history.json()["total"] == 1


def test_classification_deletes_note_draft_but_keeps_review_history(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        reviewed = client.post(
            "/api/reviews", json=review_payload(sample, reviewer)
        ).json()
        saved_draft = save_note(
            client, reviewed, reviewer, "This note belongs to the aligned revision."
        )
        moved = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                reviewed,
                reviewer,
                "C-VA",
                "The voice stays calm while the face appears tense.",
                direction="Audio",
                apparent_emotion="tense",
            ),
        )
        empty_draft = client.get(
            f"/api/samples/{sample['id']}/review-note-draft",
            params={"reviewerId": reviewer["id"]},
        )
        immediate_review = client.post(
            "/api/reviews",
            json=review_payload(
                moved.json(), reviewer, decision="Rejected",
                expectedNoteDraftRevision=0,
            ),
        )
        history = client.get("/api/reviews", params={"sampleId": sample["id"]})

    assert saved_draft["revision"] == 1
    assert moved.status_code == 200
    assert empty_draft.status_code == 200
    assert empty_draft.json()["note"] == ""
    assert empty_draft.json()["revision"] == 0
    assert empty_draft.json()["sampleRevision"] == moved.json()["revision"]
    assert immediate_review.status_code == 201
    assert history.json()["total"] == 2
    assert [row["decision"] for row in history.json()["items"]] == [
        "Accepted", "Rejected"
    ]


def test_review_rows_cannot_be_updated_or_deleted_in_sqlite(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        client.post("/api/reviews", json=review_payload(sample, reviewer))

    connection = sqlite3.connect(app.state.database.database_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("UPDATE reviews SET note = 'changed' WHERE sample_id = ?", (sample["id"],))
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("DELETE FROM reviews WHERE sample_id = ?", (sample["id"],))
    finally:
        connection.close()


def test_review_snapshot_must_match_current_sample_in_sqlite(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
    statement = (
        "INSERT INTO reviews "
        "(sample_id, reviewer_id, protocol, relation, decision, note, "
        "sample_revision, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    valid = (
        sample["id"], reviewer["id"], "VA", "Aligned",
        "Accepted", "", sample["revision"], 1, "2026-08-14T00:00:00Z",
    )
    connection = sqlite3.connect(app.state.database.database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        mismatches = (
            (*valid[:2], "VT", *valid[3:]),
            (*valid[:3], "Conflict", *valid[4:]),
        )
        for values in mismatches:
            with pytest.raises(sqlite3.IntegrityError, match="review snapshot must match its sample"):
                connection.execute(statement, values)
        assert connection.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 0
    finally:
        connection.close()


def test_initialize_installs_review_integrity_triggers_on_existing_database(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    database = app.state.database
    trigger_names = (
        "require_reviews_sample_snapshot",
        "apply_review_to_sample",
        "protect_sample_review_state",
        "validate_sample_classification_change",
        "apply_sample_classification_change",
        "protect_sample_classification",
    )
    with database.engine.begin() as connection:
        for trigger_name in trigger_names:
            connection.exec_driver_sql(f"DROP TRIGGER {trigger_name}")

    database.initialize()

    with database.engine.connect() as connection:
        installed = {
            row[0]
            for row in connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type = 'trigger'"
            ).all()
        }
    assert set(trigger_names) <= installed


def test_note_draft_autosave_conflicts_and_review_consumes_it_atomically(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        initial = client.get(
            f"/api/samples/{sample['id']}/review-note-draft",
            params={"reviewerId": reviewer["id"]},
        )
        missing_reviewer = client.put(
            f"/api/samples/{sample['id']}/review-note-draft",
            json={
                "note": "not allowed",
                "expectedRevision": 0,
                "expectedSampleRevision": sample["revision"],
            },
        )
        draft = save_note(client, sample, reviewer, "server draft")
        stale = client.put(
            f"/api/samples/{sample['id']}/review-note-draft",
            json={
                "reviewerId": reviewer["id"],
                "note": "stale write",
                "expectedRevision": 0,
                "expectedSampleRevision": sample["revision"],
            },
        )
        wrong_draft_revision = client.post(
            "/api/reviews",
            json=review_payload(sample, reviewer),
        )
        preserved = client.get(
            f"/api/samples/{sample['id']}/review-note-draft",
            params={"reviewerId": reviewer["id"]},
        )
        submitted = client.post(
            "/api/reviews",
            json=review_payload(
                sample,
                reviewer,
                expectedNoteDraftRevision=draft["revision"],
            ),
        )
        cleared = client.get(
            f"/api/samples/{sample['id']}/review-note-draft",
            params={"reviewerId": reviewer["id"]},
        )
        withdrawal_draft = save_note(
            client,
            submitted.json(),
            reviewer,
            "withdraw after reconsideration",
        )
        withdrawn = client.post(
            "/api/reviews",
            json=review_payload(
                submitted.json(),
                reviewer,
                decision="Pending",
                expectedNoteDraftRevision=withdrawal_draft["revision"],
            ),
        )
        cleared_after_withdrawal = client.get(
            f"/api/samples/{sample['id']}/review-note-draft",
            params={"reviewerId": reviewer["id"]},
        )
        history = client.get("/api/reviews", params={"sampleId": sample["id"]})

    assert initial.status_code == 200
    assert initial.json()["revision"] == 0
    assert initial.json()["note"] == ""
    assert missing_reviewer.status_code == 422
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "note_draft_revision_conflict"
    assert wrong_draft_revision.status_code == 409
    assert preserved.json() == draft
    assert submitted.status_code == 201
    assert submitted.json()["currentReview"]["note"] == "server draft"
    assert cleared.json()["revision"] == 0
    assert cleared.json()["note"] == ""
    assert withdrawn.status_code == 201
    assert withdrawn.json()["reviewDecision"] == "Pending"
    assert withdrawn.json()["reviewRevision"] == submitted.json()["reviewRevision"] + 1
    assert withdrawn.json()["revision"] == submitted.json()["revision"] + 1
    assert withdrawn.json()["currentReview"] is None
    assert cleared_after_withdrawal.json()["revision"] == 0
    assert cleared_after_withdrawal.json()["note"] == ""
    assert history.json()["total"] == 2
    assert history.json()["items"][-1]["note"] == "withdraw after reconsideration"


def test_review_insert_failure_rolls_back_history_sample_and_note_draft(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        draft = save_note(client, sample, reviewer, "must survive")
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql(
                """
                CREATE TRIGGER fail_review_insert
                BEFORE INSERT ON reviews
                BEGIN
                    SELECT RAISE(ABORT, 'forced review failure');
                END
                """
            )
        with pytest.raises(IntegrityError, match="forced review failure"):
            client.post(
                "/api/reviews",
                json=review_payload(
                    sample,
                    reviewer,
                    expectedNoteDraftRevision=draft["revision"],
                ),
            )
        current = client.get(f"/api/samples/{sample['id']}")
        saved = client.get(
            f"/api/samples/{sample['id']}/review-note-draft",
            params={"reviewerId": reviewer["id"]},
        )
        history = client.get("/api/reviews", params={"sampleId": sample["id"]})

    assert current.json()["reviewDecision"] == "Pending"
    assert current.json()["revision"] == sample["revision"]
    assert saved.json() == draft
    assert history.json()["items"] == []


def test_writes_require_a_reviewer_while_queue_and_detail_remain_readable(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        missing_review = review_payload(sample, reviewer)
        del missing_review["reviewerId"]
        review = client.post("/api/reviews", json=missing_review)
        missing_batch = batch_review_payload(sample, reviewer)
        del missing_batch["reviewerId"]
        batch = client.post("/api/reviews/batch", json={"items": [missing_batch]})
        classification = classification_payload(
            sample,
            reviewer,
            "C-VA",
            "The voice stays calm while the face appears tense.",
            direction="Audio",
            apparent_emotion="tense",
        )
        del classification["reviewerId"]
        changed = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification,
        )
        queue = client.get("/api/samples")
        detail = client.get(f"/api/samples/{sample['id']}")

    assert review.status_code == 422
    assert batch.status_code == 422
    assert changed.status_code == 422
    assert queue.status_code == 200
    assert detail.status_code == 200


def test_review_queue_search_filters_fixed_paging_and_cross_page_next_reference(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    copied_ids = add_sample_copies(app, 20)
    with TestClient(app) as client:
        first_page = client.get("/api/samples", params={"page": 1})
        second_page = client.get("/api/samples", params={"page": 2})
        sample = first_page.json()["items"][0]
        detail = client.get(f"/api/samples/{sample['id']}").json()
        dataset_search = client.get(
            "/api/samples",
            params={"search": sample["datasetName"]},
        )
        id_search = client.get(
            "/api/samples",
            params={"search": sample["displayId"]},
        )
        emotion_search = client.get(
            "/api/samples",
            params={"search": sample["trueEmotion"]},
        )
        dialogue_search = client.get(
            "/api/samples",
            params={"search": detail["dialogue"]},
        )
        protocol_relation = client.get(
            "/api/samples",
            params={"protocol": "VA", "relation": "Aligned"},
        )
        prompt_only = "prompt-only-search-token"
        with app.state.database.immediate_session() as session:
            row = session.get(Sample, sample["id"])
            assert row is not None
            row.video_prompt = prompt_only
        prompt_search = client.get("/api/samples", params={"search": prompt_only})
        reviewer = create_reviewer(client)
        twentieth = first_page.json()["items"][-1]
        submitted = client.post(
            "/api/reviews",
            json=review_payload(
                twentieth,
                reviewer,
                queue={"decision": "All"},
            ),
        )
        accepted_filter = client.get(
            "/api/samples",
            params={"decision": "Accepted"},
        )
        rejected_filter = client.get(
            "/api/samples",
            params={"decision": "Rejected"},
        )

    assert first_page.status_code == 200
    assert first_page.json()["pageSize"] == 20
    assert first_page.json()["total"] == 21
    assert len(first_page.json()["items"]) == 20
    assert second_page.json()["items"][0]["id"] == copied_ids[-1]
    assert dataset_search.json()["total"] == 21
    assert id_search.json()["total"] == 1
    assert emotion_search.json()["total"] == 21
    assert dialogue_search.json()["total"] == 21
    assert protocol_relation.json()["total"] == 21
    assert prompt_search.json()["total"] == 0
    assert submitted.status_code == 201
    assert accepted_filter.json()["total"] == 1
    assert rejected_filter.json()["total"] == 0
    assert submitted.json()["nextReference"] == {
        "id": copied_ids[-1],
        "displayId": f"CS-{copied_ids[-1]:06d}",
        "page": 2,
    }


def test_review_detail_media_roles_and_sensitive_fields(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        va_detail = client.get(f"/api/samples/{sample['id']}")
        media = client.get(
            va_detail.json()["primaryMedia"]["url"], headers={"Range": "bytes=0-0"}
        )
        reviewer = create_reviewer(client)
        with app.state.database.immediate_session() as session:
            row = session.get(Sample, sample["id"])
            assert row is not None
            source_asset = session.get(Asset, row.primary_asset_id)
            item = session.get(JobItem, row.job_item_id)
            assert source_asset is not None
            assert item is not None
            relative_path = "media/review-vt-primary.mp4"
            media_path = app.state.database.data_root / relative_path
            media_path.write_bytes(b"silent")
            silent = Asset(
                origin_job_item_id=row.job_item_id,
                storage_root=str(app.state.database.data_root),
                relative_path=relative_path,
                media_type="video/mp4",
                byte_size=6,
                width=source_asset.width,
                height=source_asset.height,
                fps=source_asset.fps,
                frame_count=source_asset.frame_count,
                duration_seconds=source_asset.duration_seconds,
                has_audio=False,
            )
            session.add(silent)
            session.flush()
            change = SampleClassificationChange(
                sample_id=row.id,
                operator_id=reviewer["id"],
                before_protocol="VA",
                after_protocol="VT",
                before_relation="Aligned",
                after_relation="Aligned",
                before_direction=None,
                after_direction=None,
                before_apparent_emotion=row.apparent_emotion,
                after_apparent_emotion=row.apparent_emotion,
                before_true_emotion_description=row.true_emotion_description,
                after_true_emotion_description=row.true_emotion_description,
                before_sample_revision=row.revision,
                after_sample_revision=row.revision + 1,
            )
            session.add(change)
            session.flush([change])
            session.refresh(row)
            item.primary_asset_id = silent.id
            session.flush([item])
            row.primary_asset_id = silent.id
            row.dialogue = None
            row.display_text = "independent vt display text"
            row.revision += 1
            current_attempt = session.exec(
                select(GenerationAttempt)
                .where(GenerationAttempt.job_item_id == item.id)
                .order_by(GenerationAttempt.attempt_number.desc())
            ).first()
            assert current_attempt is not None
            session.add(
                GenerationAttempt(
                    **current_attempt.model_dump(
                        exclude={
                            "id",
                            "attempt_number",
                            "primary_asset_id",
                            "renderer_prompt_id",
                            "finished_at",
                        }
                    ),
                    attempt_number=current_attempt.attempt_number + 1,
                    primary_asset_id=silent.id,
                    renderer_prompt_id=item.renderer_prompt_id,
                    finished_at=current_attempt.finished_at,
                )
            )
            session.flush()
        vt_detail = client.get(f"/api/samples/{sample['id']}")
        display_search = client.get(
            "/api/samples",
            params={"search": "independent vt display text"},
        )

    assert va_detail.status_code == 200
    assert media.status_code == 206
    assert media.headers["content-type"] == "video/mp4"
    assert media.content == b"v"
    assert va_detail.json()["primaryMedia"]["hasAudio"] is True
    assert va_detail.json()["sourceMedia"] is None
    assert vt_detail.status_code == 200
    assert vt_detail.json()["primaryMedia"]["hasAudio"] is False
    assert vt_detail.json()["sourceMedia"]["hasAudio"] is True
    assert display_search.json()["total"] == 1
    forbidden = {
        "jobItemId",
        "seed",
        "videoPrompt",
        "negativePrompt",
        "generationRecord",
        "sourceAssetId",
        "primaryAssetId",
        "promptTemplateVersionId",
        "vlm",
    }
    assert forbidden.isdisjoint(va_detail.json())
    assert forbidden.isdisjoint(vt_detail.json())

def test_sqlite_requires_classification_history_for_sample_updates(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        moved = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json=classification_payload(
                sample,
                reviewer,
                "C-VA",
                "The voice stays calm while the face appears tense.",
                direction="Audio",
                apparent_emotion="tense",
            ),
        ).json()

    statements = (
        (
            "UPDATE samples SET category = 'A-VA', "
            "conflict_direction = NULL, apparent_emotion = true_emotion, "
            "revision = revision + 1 WHERE id = ?",
            "relation",
        ),
        (
            "UPDATE samples SET category = 'C-VT', "
            "conflict_direction = 'Text', revision = revision + 1 WHERE id = ?",
            "protocol",
        ),
        (
            "UPDATE samples SET conflict_direction = 'Vision', "
            "revision = revision + 1 WHERE id = ?",
            "direction",
        ),
        (
            "UPDATE samples SET apparent_emotion = 'angry', "
            "revision = revision + 1 WHERE id = ?",
            "surface emotion",
        ),
        (
            "UPDATE samples SET true_emotion_description = 'changed', "
            "revision = revision + 1 WHERE id = ?",
            "true emotion description",
        ),
    )
    connection = sqlite3.connect(app.state.database.database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        for statement, _ in statements:
            with pytest.raises(
                sqlite3.IntegrityError,
                match="sample classification requires append-only history",
            ):
                connection.execute(statement, (sample["id"],))
            connection.rollback()
        with pytest.raises(
            sqlite3.IntegrityError,
            match="sample review state requires its append-only review",
        ):
            connection.execute(
                "UPDATE samples SET review_decision = 'Accepted', "
                "review_revision = review_revision + 1, "
                "revision = revision + 1 WHERE id = ?",
                (sample["id"],),
            )
        connection.rollback()
        current = connection.execute(
            "SELECT category, conflict_direction, apparent_emotion, "
            "true_emotion_description, review_decision, review_revision, revision "
            "FROM samples WHERE id = ?",
            (sample["id"],),
        ).fetchone()
        history_count = connection.execute(
            "SELECT count(*) FROM sample_classification_changes "
            "WHERE sample_id = ?",
            (sample["id"],),
        ).fetchone()[0]
    finally:
        connection.close()

    assert current == (
        "C-VA",
        "Audio",
        "tense",
        "The voice stays calm while the face appears tense.",
        "Pending",
        moved["reviewRevision"],
        moved["revision"],
    )
    assert history_count == 1


def test_sqlite_validates_classification_history_and_rolls_back_failed_apply(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)

    statement = (
        "INSERT INTO sample_classification_changes "
        "(sample_id, operator_id, before_protocol, after_protocol, "
        "before_relation, after_relation, before_direction, after_direction, "
        "before_apparent_emotion, after_apparent_emotion, "
        "before_true_emotion_description, after_true_emotion_description, "
        "before_sample_revision, after_sample_revision, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    connection = sqlite3.connect(app.state.database.database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        apparent_emotion, description, revision = connection.execute(
            "SELECT apparent_emotion, true_emotion_description, revision "
            "FROM samples WHERE id = ?",
            (sample["id"],),
        ).fetchone()
        valid = (
            sample["id"],
            reviewer["id"],
            "VA",
            "VA",
            "Aligned",
            "Conflict",
            None,
            "Audio",
            apparent_emotion,
            "tense",
            description,
            "The voice stays calm while the face appears tense.",
            revision,
            revision + 1,
            "2026-08-17T00:00:00Z",
        )
        invalid_changes = (
            (2, "VT"),
            (7, "Text"),
            (12, revision + 1),
        )
        for index, value in invalid_changes:
            invalid = list(valid)
            invalid[index] = value
            with pytest.raises(
                sqlite3.IntegrityError,
                match="classification history must match its sample transition",
            ):
                connection.execute(statement, invalid)
            connection.rollback()
        no_op = list(valid)
        no_op[5] = "Aligned"
        no_op[7] = None
        no_op[9] = apparent_emotion
        no_op[11] = description
        with pytest.raises(
            sqlite3.IntegrityError,
            match="classification history must match its sample transition",
        ):
            connection.execute(statement, no_op)
        connection.rollback()


        connection.execute(
            """
            CREATE TRIGGER fail_classification_sample_update
            BEFORE UPDATE OF category ON samples
            BEGIN
                SELECT RAISE(ABORT, 'forced classification apply failure');
            END
            """
        )
        connection.commit()
        with pytest.raises(
            sqlite3.IntegrityError,
            match="forced classification apply failure",
        ):
            connection.execute(statement, valid)
        connection.rollback()
        history_count = connection.execute(
            "SELECT count(*) FROM sample_classification_changes "
            "WHERE sample_id = ?",
            (sample["id"],),
        ).fetchone()[0]
        current = connection.execute(
            "SELECT category, revision FROM samples WHERE id = ?",
            (sample["id"],),
        ).fetchone()
    finally:
        connection.close()

    assert history_count == 0
    assert current == ("A-VA", sample["revision"])


def test_sqlite_keeps_reviews_and_sample_review_state_in_one_transition(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)

    statement = (
        "INSERT INTO reviews "
        "(sample_id, reviewer_id, protocol, relation, decision, note, "
        "sample_revision, revision, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    valid = (
        sample["id"],
        reviewer["id"],
        "VA",
        "Aligned",
        "Accepted",
        "",
        sample["revision"],
        1,
        "2026-08-17T00:00:00Z",
    )
    connection = sqlite3.connect(app.state.database.database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        with pytest.raises(
            sqlite3.IntegrityError,
            match="sample review state requires its append-only review",
        ):
            connection.execute(
                "UPDATE samples SET review_decision = 'Accepted', "
                "review_revision = 1, revision = revision + 1 WHERE id = ?",
                (sample["id"],),
            )
        connection.rollback()

        invalid_changes = (
            (2, "VT"),
            (3, "Conflict"),
            (6, sample["revision"] + 1),
            (7, 2),
        )
        for index, value in invalid_changes:
            invalid = list(valid)
            invalid[index] = value
            with pytest.raises(
                sqlite3.IntegrityError,
                match="review snapshot must match its sample",
            ):
                connection.execute(statement, invalid)
            connection.rollback()
        initial_pending = list(valid)
        initial_pending[4] = "Pending"
        with pytest.raises(
            sqlite3.IntegrityError,
            match="review snapshot must match its sample",
        ):
            connection.execute(statement, initial_pending)
        connection.rollback()
        assert connection.execute(
            "SELECT count(*) FROM reviews WHERE sample_id = ?",
            (sample["id"],),
        ).fetchone()[0] == 0

        connection.execute(
            """
            CREATE TRIGGER fail_review_sample_update
            BEFORE UPDATE OF review_decision ON samples
            BEGIN
                SELECT RAISE(ABORT, 'forced review apply failure');
            END
            """
        )
        connection.commit()
        with pytest.raises(
            sqlite3.IntegrityError,
            match="forced review apply failure",
        ):
            connection.execute(statement, valid)
        connection.rollback()
        assert connection.execute(
            "SELECT count(*) FROM reviews WHERE sample_id = ?",
            (sample["id"],),
        ).fetchone()[0] == 0
        connection.execute("DROP TRIGGER fail_review_sample_update")
        connection.commit()

        connection.execute(statement, valid)
        connection.commit()
        current = connection.execute(
            "SELECT review_decision, review_revision, revision "
            "FROM samples WHERE id = ?",
            (sample["id"],),
        ).fetchone()
        current_review = connection.execute(
            "SELECT decision, sample_revision, revision "
            "FROM reviews WHERE sample_id = ?",
            (sample["id"],),
        ).fetchone()
        with pytest.raises(
            sqlite3.IntegrityError,
            match="sample review state requires its append-only review",
        ):
            connection.execute(
                "UPDATE samples SET review_decision = 'Rejected', "
                "review_revision = review_revision + 1, "
                "revision = revision + 1 WHERE id = ?",
                (sample["id"],),
            )
        connection.rollback()
        withdrawal = list(valid)
        withdrawal[4] = "Pending"
        withdrawal[5] = "withdrawn"
        withdrawal[6] = sample["revision"] + 1
        withdrawal[7] = 2
        withdrawal[8] = "2026-08-17T00:01:00Z"
        connection.execute(statement, withdrawal)
        connection.commit()
        withdrawn_state = connection.execute(
            "SELECT review_decision, review_revision, revision "
            "FROM samples WHERE id = ?",
            (sample["id"],),
        ).fetchone()
        review_history = connection.execute(
            "SELECT decision, sample_revision, revision FROM reviews "
            "WHERE sample_id = ? ORDER BY revision",
            (sample["id"],),
        ).fetchall()
    finally:
        connection.close()

    assert current == ("Accepted", 1, sample["revision"] + 1)
    assert current_review == ("Accepted", sample["revision"], 1)
    assert withdrawn_state == ("Pending", 2, sample["revision"] + 2)
    assert review_history == [
        ("Accepted", sample["revision"], 1),
        ("Pending", sample["revision"] + 1, 2),
    ]
