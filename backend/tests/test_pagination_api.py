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
            "/api/content-scripts",
            "/api/scenes",
            "/api/prompt-template-versions",
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


def test_dataset_and_reviewer_context_remains_addressable_after_page_twenty(
    tmp_path: Path,
) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        reviewers = [create_reviewer(client, f"Reviewer {index:02d}") for index in range(1, 26)]
        datasets = [
            client.post(
                "/api/datasets",
                json={"name": f"Dataset {index:02d}", "note": f"Note {index:02d}"},
            ).json()
            for index in range(1, 25)
        ]
        reviewer_page = client.get("/api/reviewers", params={"page": 2})
        reviewer_detail = client.get(f"/api/reviewers/{reviewers[-1]['id']}")
        dataset_page = client.get("/api/datasets", params={"page": 2})
        dataset_detail = client.get(f"/api/datasets/{datasets[-1]['id']}")
        dataset_search = client.get(
            "/api/datasets",
            params={"search": datasets[-1]["name"]},
        )
        job_status = client.get("/api/jobs").json()["items"][0]["status"]
        matching_jobs = client.get(
            "/api/jobs",
            params={"status": job_status},
        )
        nonmatching_jobs = client.get(
            "/api/jobs",
            params={"status": "Cancelled" if job_status != "Cancelled" else "Failed"},
        )

    assert reviewer_page.json()["total"] == 25
    assert len(reviewer_page.json()["items"]) == 5
    assert reviewer_detail.json()["name"] == "Reviewer 25"
    assert dataset_page.json()["total"] == 25
    assert len(dataset_page.json()["items"]) == 5
    assert dataset_detail.json()["name"] == "Dataset 24"
    assert dataset_search.json()["total"] == 1
    assert dataset_search.json()["items"][0]["id"] == datasets[-1]["id"]
    assert matching_jobs.json()["total"] == 1
    assert nonmatching_jobs.json()["total"] == 0
