from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from backend.domain.enums import Category
from backend.domain.models import Archive, ArchiveItem, Asset, Sample, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH
from backend.tests.test_review_api import create_reviewer, review_payload, sample_app


def accept_sample(client: TestClient) -> tuple[dict, dict]:
    sample = client.get("/api/samples").json()[0]
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

        changed = client.post(
            "/api/reviews",
            json=review_payload(sample, reviewer, note="updated note"),
        ).json()
        updated = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        stale = client.post("/api/archives/sync", json=unchanged.json())
        second_sync = client.post("/api/archives/sync", json=updated.json())

        rejected = client.post(
            "/api/reviews",
            json=review_payload(changed, reviewer, decision="Rejected", note="not usable"),
        ).json()
        removed = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        third_sync = client.post("/api/archives/sync", json=removed.json())
        download = client.get(f"/api/archives/{sample['datasetId']}/manifest")

    assert added.json()["added"] == [
        {"sampleId": sample["id"], "expectedRevision": sample["revision"]}
    ]
    assert added.json()["expectedArchiveRevision"] == 0
    assert first_sync.status_code == 200
    assert first_sync.json()["revision"] == 1
    assert unchanged.json()["unchangedCount"] == 1
    assert unchanged.json()["added"] == unchanged.json()["updated"] == unchanged.json()["removed"] == []
    assert updated.json()["updated"] == [
        {"sampleId": sample["id"], "expectedRevision": changed["revision"]}
    ]
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "archive_preview_stale"
    assert second_sync.json()["revision"] == 2
    assert removed.json()["removed"] == [
        {"sampleId": sample["id"], "expectedRevision": rejected["revision"]}
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
    assert record["primaryMedia"]["assetId"] == sample["primaryAssetId"]
    assert record["review"]["reviewerName"] == "Reviewer One"
    assert record["contentPlan"]["nameEn"] == sample["contentPlanNameEn"]
    assert record["sampleRevision"] == sample["revision"]
    serialized = response.text.casefold()
    assert "precision" not in serialized
    assert "gpu" not in serialized
    assert "attempt" not in serialized
    assert str(tmp_path.resolve()).casefold() not in serialized
    assert "sourceasset" not in serialized


def test_vt_manifest_uses_only_silent_primary_media(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with app.state.database.immediate_session() as session:
        sample = session.get(Sample, 1)
        assert sample is not None
        relative_path = "media/vt-primary.mp4"
        path = app.state.database.data_root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"silent")
        asset = Asset(
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
        sample.category = Category.A_VT
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
        changed = client.post(
            "/api/reviews",
            json=review_payload(sample, reviewer, note="requires archive update"),
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
        changed = client.post(
            "/api/reviews",
            json=review_payload(sample, reviewer, note="database failure case"),
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
        sample = client.get("/api/samples").json()[0]
        response = client.get(f"/api/archives/{sample['datasetId']}/manifest")
        missing_dataset = client.post("/api/archives/preview", json={"datasetId": 99999})

    assert response.status_code == 404
    assert missing_dataset.status_code == 404
