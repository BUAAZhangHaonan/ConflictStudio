from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.domain.enums import JobSource
from backend.tests.test_sample_integration import add_completed_result, make_app


def sample_app(tmp_path: Path):  # type: ignore[no-untyped-def]
    app = make_app(tmp_path)
    job_id, item_id, _ = add_completed_result(app, JobSource.PRODUCTION)
    app.state.job_executor._complete_item(job_id, item_id)
    return app


def create_reviewer(client: TestClient, name: str = "Reviewer One") -> dict:
    response = client.post("/api/reviewers", json={"name": name})
    assert response.status_code == 201
    return response.json()


def review_payload(sample: dict, reviewer: dict, **changes: object) -> dict:
    payload: dict[str, object] = {
        "sampleId": sample["id"],
        "reviewerId": reviewer["id"],
        "decision": "Accepted",
        "note": "usable",
        "expectedRevision": sample["revision"],
        "expectedReviewRevision": sample["reviewRevision"],
    }
    payload.update(changes)
    return payload


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


def test_review_history_is_append_only_and_rejects_no_change_or_pending(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()[0]
        reviewer = create_reviewer(client)
        first = client.post("/api/reviews", json=review_payload(sample, reviewer))
        no_change = client.post(
            "/api/reviews",
            json=review_payload(first.json(), reviewer),
        )
        note_change = client.post(
            "/api/reviews",
            json=review_payload(first.json(), reviewer, note="second note"),
        )
        decision_change = client.post(
            "/api/reviews",
            json=review_payload(note_change.json(), reviewer, decision="Rejected", note="second note"),
        )
        pending = client.post(
            "/api/reviews",
            json=review_payload(decision_change.json(), reviewer, decision="Pending"),
        )
        history = client.get("/api/reviews", params={"sampleId": sample["id"]})

    assert first.status_code == 201
    assert first.json()["reviewDecision"] == "Accepted"
    assert first.json()["currentReview"]["sampleRevision"] == sample["revision"]
    assert no_change.status_code == 422
    assert note_change.status_code == 201
    assert decision_change.status_code == 201
    assert pending.status_code == 422
    assert [row["revision"] for row in history.json()] == [1, 2, 3]
    assert [row["decision"] for row in history.json()] == ["Accepted", "Accepted", "Rejected"]
    assert all(row["protocol"] == "VA" and row["relation"] == "Aligned" for row in history.json())


def test_review_distinguishes_sample_and_review_revision_conflicts(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()[0]
        reviewer = create_reviewer(client)
        reviewed = client.post("/api/reviews", json=review_payload(sample, reviewer)).json()
        stale_sample = client.post(
            "/api/reviews",
            json=review_payload(
                reviewed,
                reviewer,
                expectedRevision=sample["revision"],
                expectedReviewRevision=reviewed["reviewRevision"],
                note="changed",
            ),
        )
        stale_review = client.post(
            "/api/reviews",
            json=review_payload(
                reviewed,
                reviewer,
                expectedReviewRevision=sample["reviewRevision"],
                note="changed",
            ),
        )

    assert stale_sample.status_code == 409
    assert stale_sample.json()["error"]["code"] == "revision_conflict"
    assert stale_review.status_code == 409
    assert stale_review.json()["error"]["code"] == "review_revision_conflict"


def test_review_batch_is_atomic_when_any_item_is_invalid(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()[0]
        reviewer = create_reviewer(client)
        response = client.post(
            "/api/reviews/batch",
            json={
                "items": [
                    review_payload(sample, reviewer),
                    review_payload({**sample, "id": 99999}, reviewer),
                ]
            },
        )
        duplicate = client.post(
            "/api/reviews/batch",
            json={"items": [review_payload(sample, reviewer), review_payload(sample, reviewer)]},
        )
        empty = client.post("/api/reviews/batch", json={"items": []})
        history = client.get("/api/reviews", params={"sampleId": sample["id"]})
        unchanged = client.get(f"/api/samples/{sample['id']}")

    assert response.status_code == 404
    assert duplicate.status_code == 422
    assert empty.status_code == 422
    assert history.json() == []
    assert unchanged.json()["reviewRevision"] == 0


def test_classification_moves_only_between_relations_in_same_protocol(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()[0]
        reviewer = create_reviewer(client)
        reviewed = client.post("/api/reviews", json=review_payload(sample, reviewer)).json()
        moved = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json={
                "expectedRevision": reviewed["revision"],
                "targetCategory": "C-VA",
                "conflictDirection": "Audio",
            },
        )
        invalid_direction = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json={
                "expectedRevision": moved.json()["revision"],
                "targetCategory": "C-VA",
                "conflictDirection": "Text",
            },
        )
        cross_protocol = client.patch(
            f"/api/samples/{sample['id']}/classification",
            json={
                "expectedRevision": moved.json()["revision"],
                "targetCategory": "A-VT",
                "conflictDirection": None,
            },
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
    assert moved.json()["reviewDecision"] == "Pending"
    assert moved.json()["reviewRevision"] == reviewed["reviewRevision"]
    assert moved.json()["currentReview"] is None
    assert current.json()["currentReview"] is None
    assert len(history.json()) == 1
    assert history.json()[0]["decision"] == "Accepted"
    assert invalid_direction.status_code == 422
    assert cross_protocol.status_code == 422
    assert removed_endpoint.status_code == 405


def test_review_rows_cannot_be_updated_or_deleted_in_sqlite(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()[0]
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
        sample = client.get("/api/samples").json()[0]
        reviewer = create_reviewer(client)
        other_dataset = client.post(
            "/api/datasets",
            json={"name": "Other", "purpose": "Validation", "note": ""},
        ).json()

    statement = (
        "INSERT INTO reviews "
        "(sample_id, reviewer_id, dataset_id, protocol, relation, decision, note, "
        "sample_revision, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    valid = (
        sample["id"], reviewer["id"], sample["datasetId"], "VA", "Aligned",
        "Accepted", "", sample["revision"], 1, "2026-08-14T00:00:00Z",
    )
    connection = sqlite3.connect(app.state.database.database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        mismatches = (
            (*valid[:2], other_dataset["id"], *valid[3:]),
            (*valid[:3], "VT", *valid[4:]),
            (*valid[:4], "Conflict", *valid[5:]),
        )
        for values in mismatches:
            with pytest.raises(sqlite3.IntegrityError, match="review snapshot must match its sample"):
                connection.execute(statement, values)
        assert connection.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 0
    finally:
        connection.close()


def test_initialize_installs_review_snapshot_trigger_on_existing_database(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    database = app.state.database
    with database.engine.begin() as connection:
        connection.exec_driver_sql("DROP TRIGGER require_reviews_sample_snapshot")
        assert connection.exec_driver_sql(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' "
            "AND name = 'require_reviews_sample_snapshot'"
        ).scalar_one() == 0

    database.initialize()

    with database.engine.connect() as connection:
        assert connection.exec_driver_sql(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' "
            "AND name = 'require_reviews_sample_snapshot'"
        ).scalar_one() == 1
