from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.domain.enums import Category
from backend.domain.models import Sample
from backend.tests.test_review_api import create_reviewer, review_payload, sample_app


def test_statistics_use_latest_review_snapshots_and_shanghai_calendar_days(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        with patch("backend.services.reviews.utc_now", return_value="2026-08-01T15:30:00Z"):
            first = client.post("/api/reviews", json=review_payload(sample, reviewer)).json()

        with app.state.database.immediate_session() as session:
            row = session.get(Sample, sample["id"])
            assert row is not None
            row.category = Category.A_VT
            row.dialogue = None
            row.display_text = "独立展示文本"
            row.revision += 1

        current = client.get(f"/api/samples/{sample['id']}").json()
        with patch("backend.services.reviews.utc_now", return_value="2026-08-02T16:30:00Z"):
            second = client.post(
                "/api/reviews",
                json=review_payload(current, reviewer, decision="Rejected", note="changed decision"),
            )
        statistics = client.get(
            f"/api/reviewers/{reviewer['id']}/statistics",
            params={"startDate": "2026-08-01", "endDate": "2026-08-03"},
        )
        dataset = client.post(
            "/api/datasets",
            json={"name": "No reviews", "note": ""},
        ).json()
        filtered = client.get(
            f"/api/reviewers/{reviewer['id']}/statistics",
            params={
                "datasetId": dataset["id"],
                "startDate": "2026-08-01",
                "endDate": "2026-08-03",
            },
        )
        inverted = client.get(
            f"/api/reviewers/{reviewer['id']}/statistics",
            params={"startDate": "2026-08-04", "endDate": "2026-08-03"},
        )

    assert second.status_code == 201
    payload = statistics.json()
    assert payload["uniqueReviewedCount"] == 1
    assert payload["acceptedCount"] == 0
    assert payload["rejectedCount"] == 1
    assert payload["vaCount"] == 0
    assert payload["vtCount"] == 1
    assert payload["revisedSampleCount"] == 1
    assert payload["activity"] == [
        {"date": "2026-08-01", "reviewedCount": 1},
        {"date": "2026-08-02", "reviewedCount": 0},
        {"date": "2026-08-03", "reviewedCount": 1},
    ]
    assert first["currentReview"]["protocol"] == "VA"
    assert second.json()["currentReview"]["protocol"] == "VT"
    assert filtered.status_code == 200
    assert filtered.json()["uniqueReviewedCount"] == 0
    assert [row["reviewedCount"] for row in filtered.json()["activity"]] == [0, 0, 0]
    assert inverted.status_code == 422


def test_statistics_derive_current_and_needs_update_archive_counts(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        with patch("backend.services.reviews.utc_now", return_value="2026-08-10T02:00:00Z"):
            accepted = client.post("/api/reviews", json=review_payload(sample, reviewer)).json()
        preview = client.post("/api/archives/preview", json={"datasetId": sample["datasetId"]})
        client.post("/api/archives/sync", json=preview.json())
        current = client.get(
            f"/api/reviewers/{reviewer['id']}/statistics",
            params={"startDate": "2026-08-10", "endDate": "2026-08-10"},
        )
        with patch("backend.services.reviews.utc_now", return_value="2026-08-10T03:00:00Z"):
            client.post(
                "/api/reviews",
                json=review_payload(accepted, reviewer, note="archive must be updated"),
            )
        changed = client.get(
            f"/api/reviewers/{reviewer['id']}/statistics",
            params={"startDate": "2026-08-10", "endDate": "2026-08-10"},
        )

    assert current.json()["archivedCurrentCount"] == 1
    assert current.json()["needsUpdateCount"] == 0
    assert changed.json()["archivedCurrentCount"] == 0
    assert changed.json()["needsUpdateCount"] == 1
