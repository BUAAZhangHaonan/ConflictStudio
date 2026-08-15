from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from backend.tests.test_review_api import create_reviewer, review_payload, sample_app


def test_every_growing_collection_uses_the_same_page_contract(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        reviewer = create_reviewer(client)
        reviewed = client.post(
            "/api/reviews",
            json=review_payload(sample, reviewer),
        )
        assert reviewed.status_code == 201

        job = client.get("/api/jobs").json()["items"][0]
        job_item = client.get(f"/api/jobs/{job['id']}/items").json()["items"][0]
        routes = (
            "/api/datasets",
            "/api/content-plans",
            "/api/video-background-presets",
            "/api/prompt-presets",
            "/api/jobs",
            f"/api/jobs/{job['id']}/items",
            f"/api/job-items/{job_item['id']}/attempts",
            f"/api/jobs/{job['id']}/events",
            "/api/samples",
            "/api/reviewers",
            f"/api/reviews?sampleId={sample['id']}",
            "/api/archives",
        )

        for route in routes:
            separator = "&" if "?" in route else "?"
            first = client.get(f"{route}{separator}page=1")
            empty = client.get(f"{route}{separator}page=2")
            invalid = client.get(f"{route}{separator}page=0")

            assert first.status_code == 200, route
            assert first.json()["items"], route
            assert first.json()["page"] == 1, route
            assert first.json()["pageSize"] == 20, route
            assert first.json()["total"] == len(first.json()["items"]), route
            assert first.json()["totalPages"] == 1, route
            assert empty.status_code == 200, route
            assert empty.json() == {
                "items": [],
                "page": 2,
                "pageSize": 20,
                "total": first.json()["total"],
                "totalPages": 1,
            }, route
            assert invalid.status_code == 422, route
