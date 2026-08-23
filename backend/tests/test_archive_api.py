from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from backend.domain.enums import GenerationAttemptStatus
from backend.domain.models import (
    Archive,
    ArchiveItem,
    Asset,
    GenerationAttempt,
    JobItem,
    Sample,
    Reviewer,
    SampleClassificationChange,
    VIDEO_FPS,
    VIDEO_HEIGHT,
    VIDEO_WIDTH,
)
from backend.tests.test_review_api import (
    classification_payload,
    create_reviewer,
    save_note,
    review_payload,
    sample_app,
)


def accept_sample(client: TestClient) -> tuple[dict, dict]:
    response = client.get("/api/samples")
    assert response.status_code == 200, response.text
    sample = response.json()["items"][0]
    reviewer = create_reviewer(client)
    reviewed = client.post("/api/reviews", json=review_payload(sample, reviewer))
    assert reviewed.status_code == 201
    return reviewed.json(), reviewer


def test_archive_preview_and_sync_cover_add_update_remove_and_unchanged(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample, reviewer = accept_sample(client)
        added = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        first_sync = client.post("/api/archives/sync", json=added.json())
        unchanged = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})

        update_draft = save_note(client, sample, reviewer, "updated note")
        changed = client.post(
            "/api/reviews",
            json=review_payload(
                sample,
                reviewer,
                expectedNoteDraftRevision=update_draft["revision"],
            ),
        ).json()
        updated = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        stale = client.post("/api/archives/sync", json=unchanged.json())
        second_sync = client.post("/api/archives/sync", json=updated.json())

        withdrawn = client.post(
            "/api/reviews",
            json=review_payload(changed, reviewer, decision="Pending"),
        ).json()
        removed = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        third_sync = client.post("/api/archives/sync", json=removed.json())
        download = client.get(f"/api/archives/{sample['datasetId']}/manifest")

    assert len(added.json()["added"]) == 1
    added_change = added.json()["added"][0]
    assert added_change == {
        "sampleId": sample["id"],
        "displayId": sample["displayId"],
        "expectedRevision": sample["revision"],
        "datasetId": sample["datasetId"],
        "datasetName": "Formal",
        "category": sample["category"],
        "protocol": "VA",
        "relation": "Aligned",
        "primaryAssetId": int(sample["primaryMedia"]["url"].rsplit("/", 1)[1]),
        "primaryAssetUrl": sample["primaryMedia"]["url"],
    }
    assert added.json()["expectedArchiveRevision"] == 0
    assert first_sync.status_code == 200
    assert first_sync.json()["revision"] == 1
    assert unchanged.json()["unchangedCount"] == 1
    assert unchanged.json()["added"] == unchanged.json()["updated"] == unchanged.json()["removed"] == []
    assert [(row["sampleId"], row["expectedRevision"]) for row in updated.json()["updated"]] == [
        (sample["id"], changed["revision"])
    ]
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "archive_preview_stale"
    assert second_sync.json()["revision"] == 2
    assert withdrawn["reviewDecision"] == "Pending"
    assert withdrawn["archiveSyncStatus"] == "NeedsUpdate"
    assert [(row["sampleId"], row["expectedRevision"]) for row in removed.json()["removed"]] == [
        (sample["id"], withdrawn["revision"])
    ]
    assert third_sync.json()["revision"] == 3
    assert third_sync.json()["currentCount"] == 0
    assert download.status_code == 200
    assert download.content == b""


def test_manifest_contains_user_fields_and_excludes_runtime_details(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample, _ = accept_sample(client)
        preview = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        synced = client.post("/api/archives/sync", json=preview.json())
        response = client.get(f"/api/archives/{sample['datasetId']}/manifest")

    assert synced.status_code == 200
    record = json.loads(response.text)
    assert record["sampleId"] == sample["id"]
    assert record["primaryMedia"]["assetId"] == preview.json()["added"][0]["primaryAssetId"]
    assert record["review"]["reviewerName"] == "Reviewer One"
    assert record["contentScript"]["nameEn"] == sample["contentScriptNameEn"]
    assert record["sampleRevision"] == sample["revision"]
    serialized = response.text.casefold()
    assert "precision" not in serialized
    assert "gpu" not in serialized
    assert "attempt" not in serialized
    assert str(tmp_path.resolve()).casefold() not in serialized
    assert "sourceasset" not in serialized


def test_classification_changes_keep_archive_relation_and_emotions_coherent(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        aligned, reviewer = accept_sample(client)
        initial_preview = client.post(
            "/api/archives/preview",
            json={"datasetId": aligned["datasetId"]},
        )
        client.post("/api/archives/sync", json=initial_preview.json())

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
        )
        assert conflict.status_code == 200
        assert conflict.json()["archiveSyncStatus"] == "NeedsUpdate"
        accepted_conflict = client.post(
            "/api/reviews",
            json=review_payload(conflict.json(), reviewer),
        ).json()
        conflict_preview = client.post(
            "/api/archives/preview",
            json={"datasetId": aligned["datasetId"]},
        )
        client.post("/api/archives/sync", json=conflict_preview.json())
        conflict_manifest = json.loads(
            client.get(f"/api/archives/{aligned['datasetId']}/manifest").text
        )

        restored = client.patch(
            f"/api/samples/{aligned['id']}/classification",
            json=classification_payload(
                accepted_conflict,
                reviewer,
                "A-VA",
                "The voice and face now express the same calm emotion.",
            ),
        )
        assert restored.status_code == 200
        assert restored.json()["archiveSyncStatus"] == "NeedsUpdate"
        client.post(
            "/api/reviews",
            json=review_payload(restored.json(), reviewer),
        )
        aligned_preview = client.post(
            "/api/archives/preview",
            json={"datasetId": aligned["datasetId"]},
        )
        client.post("/api/archives/sync", json=aligned_preview.json())
        aligned_manifest = json.loads(
            client.get(f"/api/archives/{aligned['datasetId']}/manifest").text
        )

    assert conflict_manifest["relation"] == "Conflict"
    assert conflict_manifest["conflictDirection"] == "Audio"
    assert conflict_manifest["trueEmotion"] == aligned["trueEmotion"]
    assert conflict_manifest["apparentEmotion"] == "tense"
    assert conflict_manifest["trueEmotionDescription"] == "The voice carries calm while the face appears tense."
    assert aligned_manifest["relation"] == "Aligned"
    assert aligned_manifest["conflictDirection"] is None
    assert aligned_manifest["trueEmotion"] == aligned["trueEmotion"]
    assert aligned_manifest["apparentEmotion"] == aligned["trueEmotion"]
    assert aligned_manifest["trueEmotionDescription"] == "The voice and face now express the same calm emotion."


def test_vt_manifest_uses_only_silent_primary_media(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with app.state.database.immediate_session() as session:
        sample = session.get(Sample, 1)
        classification_reviewer = Reviewer(
            name="VT Setup Reviewer",
            name_key="vt setup reviewer",
        )
        session.add(classification_reviewer)
        assert sample is not None
        relative_path = "media/vt-primary.mp4"
        path = app.state.database.data_root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"silent")
        asset = Asset(
            origin_job_item_id=sample.job_item_id,
            storage_root=str(app.state.database.data_root),
            relative_path=relative_path,
            media_type="video/mp4",
            byte_size=6,
            width=VIDEO_WIDTH,
            height=VIDEO_HEIGHT,
            fps=VIDEO_FPS,
            frame_count=121,
            duration_seconds=121 / VIDEO_FPS,
            has_audio=False,
        )
        session.add(asset)
        session.flush()
        item = session.get(JobItem, sample.job_item_id)
        assert item is not None
        previous_attempt = session.get(GenerationAttempt, 1)
        assert previous_attempt is not None
        session.add(
            GenerationAttempt(
                job_item_id=item.id,
                attempt_number=2,
                model=previous_attempt.model,
                precision=previous_attempt.precision,
                gpu_slot=previous_attempt.gpu_slot,
                seed=previous_attempt.seed,
                source_asset_id=previous_attempt.source_asset_id,
                primary_asset_id=asset.id,
                renderer_prompt_id=item.renderer_prompt_id,
                status=GenerationAttemptStatus.COMPLETED,
                started_at=previous_attempt.started_at,
                finished_at=previous_attempt.finished_at,
            )
        )
        session.flush()
        change = SampleClassificationChange(
            sample_id=sample.id,
            operator_id=classification_reviewer.id,
            before_protocol="VA",
            after_protocol="VT",
            before_relation="Aligned",
            after_relation="Aligned",
            before_direction=None,
            after_direction=None,
            before_apparent_emotion=sample.apparent_emotion,
            after_apparent_emotion=sample.apparent_emotion,
            before_true_emotion_description=sample.true_emotion_description,
            after_true_emotion_description=sample.true_emotion_description,
            before_sample_revision=sample.revision,
            after_sample_revision=sample.revision + 1,
        )
        session.add(change)
        session.flush([change])
        session.refresh(sample)
        item.primary_asset_id = asset.id
        session.flush([item])
        sample.primary_asset_id = asset.id
        sample.dialogue = None
        sample.display_text = "这是独立展示文本"
        sample.revision += 1

    with TestClient(app) as client:
        sample, _ = accept_sample(client)
        preview = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        client.post("/api/archives/sync", json=preview.json())
        response = client.get(f"/api/archives/{sample['datasetId']}/manifest")

    record = json.loads(response.text)
    assert record["protocol"] == "VT"
    assert record["primaryMedia"]["hasAudio"] is False
    assert record["primaryMedia"]["relativePath"] == "media/vt-primary.mp4"
    assert "source" not in response.text.casefold()


def test_manifest_write_failure_leaves_database_and_old_file_unchanged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample, reviewer = accept_sample(client)
        preview = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        client.post("/api/archives/sync", json=preview.json())
        path = app.state.archive_service.manifests.path(sample["datasetId"])
        previous = path.read_bytes()
        note_draft = save_note(client, sample, reviewer, "requires archive update")
        changed = client.post(
            "/api/reviews",
            json=review_payload(
                sample,
                reviewer,
                expectedNoteDraftRevision=note_draft["revision"],
            ),
        ).json()
        update = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})

        def fail_replace(source: object, destination: object) -> None:
            raise OSError("replace failed")

        monkeypatch.setattr("backend.adapters.archive_manifest.os.replace", fail_replace)
        with pytest.raises(OSError, match="replace failed"):
            client.post("/api/archives/sync", json=update.json())

    assert changed["archiveSyncStatus"] == "NeedsUpdate"
    assert path.read_bytes() == previous
    with app.state.database.read_session() as session:
        archive = session.get(Archive, sample["datasetId"])
        item = session.get(ArchiveItem, (sample["datasetId"], sample["id"]))
        assert archive is not None and archive.revision == 1
        assert item is not None and item.sample_revision == sample["revision"]


def test_database_failure_after_manifest_replace_restores_both_states(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample, reviewer = accept_sample(client)
        preview = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        client.post("/api/archives/sync", json=preview.json())
        path = app.state.archive_service.manifests.path(sample["datasetId"])
        previous = path.read_bytes()
        note_draft = save_note(client, sample, reviewer, "database failure case")
        changed = client.post(
            "/api/reviews",
            json=review_payload(
                sample,
                reviewer,
                expectedNoteDraftRevision=note_draft["revision"],
            ),
        ).json()
        update = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql(
                """
                CREATE TRIGGER fail_archive_item_insert
                BEFORE INSERT ON archive_items
                BEGIN
                    SELECT RAISE(ABORT, 'forced archive item failure');
                END
                """
            )
        with pytest.raises(IntegrityError, match="forced archive item failure"):
            client.post("/api/archives/sync", json=update.json())
        with app.state.database.engine.begin() as connection:
            connection.exec_driver_sql("DROP TRIGGER fail_archive_item_insert")

    assert path.read_bytes() == previous
    with app.state.database.read_session() as session:
        archive = session.get(Archive, sample["datasetId"])
        item = session.get(ArchiveItem, (sample["datasetId"], sample["id"]))
        assert archive is not None and archive.revision == 1
        assert item is not None and item.sample_revision != changed["revision"]


def test_manifest_download_requires_an_existing_file(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        response = client.get(f"/api/archives/{sample['datasetId']}/manifest")
        missing_dataset = client.post("/api/archives/preview", json={"datasetId": 99999})

    assert response.status_code == 404
    assert missing_dataset.status_code == 404
