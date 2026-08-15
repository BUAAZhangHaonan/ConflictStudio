from pathlib import Path

from fastapi.testclient import TestClient

from backend.domain.models import Archive, ArchiveItem, BatchDraft, Dataset, Job, Sample, utc_now
from backend.tests.test_invariants import client_for
from backend.tests.test_review_api import sample_app


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
