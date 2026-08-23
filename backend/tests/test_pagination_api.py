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

        job = client.get("/api/generation-results").json()["items"][0]
        job_item = client.get(
            f"/api/generation-results/{job['id']}/items"
        ).json()["items"][0]
        template = client.get("/api/prompt-templates").json()["items"][0]
        routes = (
            "/api/datasets",
            "/api/content-scripts",
            "/api/scenes",
            "/api/prompt-templates",
            f"/api/prompt-templates/{template['id']}/versions",
            "/api/generation-results",
            f"/api/generation-results/{job['id']}/items",
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
        job_status = client.get("/api/generation-results").json()["items"][0]["status"]
        matching_jobs = client.get(
            "/api/generation-results",
            params={"status": job_status},
        )
        nonmatching_jobs = client.get(
            "/api/generation-results",
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


def test_content_script_filters_run_before_pagination(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        for index in range(20):
            response = client.post(
                "/api/content-scripts",
                json={
                    "nameZh": f"分页占位内容{index:02d}",
                    "nameEn": f"Pagination decoy {index:02d}",
                    "category": "A-VA",
                    "conflictDirection": None,
                    "mode": "Generative",
                    "status": "Draft",
                    "trueEmotion": "calm",
                    "apparentEmotion": "calm",
                    "sceneZh": "一间安静的办公室。",
                    "sceneEn": "A quiet office.",
                    "triggerEventZh": "门轻轻关上。",
                    "triggerEventEn": "The door closes softly.",
                    "psychologicalBackgroundZh": "被摄者准备回应。",
                    "psychologicalBackgroundEn": "The subject prepares to respond.",
                    "dialogue": None,
                    "displayText": None,
                    "trueEmotionDescription": "",
                    "baseVideoPrompt": "",
                    "contentRequirementsZh": "生成一句简短回应。",
                    "contentRequirementsEn": "Generate one brief response.",
                    "sceneSupplementZh": "",
                    "sceneSupplementEn": "",
                    "sceneIds": [],
                },
            )
            assert response.status_code == 201, response.text
        target = client.post(
            "/api/content-scripts",
            json={
                "nameZh": "音频冲突目标",
                "nameEn": "Audio conflict target",
                "category": "C-VA",
                "conflictDirection": "Audio",
                "mode": "Generative",
                "status": "Draft",
                "trueEmotion": "worried",
                "apparentEmotion": "calm",
                "sceneZh": "一间安静的办公室。",
                "sceneEn": "A quiet office.",
                "triggerEventZh": "门轻轻关上。",
                "triggerEventEn": "The door closes softly.",
                "psychologicalBackgroundZh": "被摄者试图隐藏担忧。",
                "psychologicalBackgroundEn": "The subject tries to hide concern.",
                "dialogue": None,
                "displayText": None,
                "trueEmotionDescription": "",
                "baseVideoPrompt": "",
                "contentRequirementsZh": "生成一句平静但声音担忧的回应。",
                "contentRequirementsEn": "Generate a calm reply with worried vocal delivery.",
                "sceneSupplementZh": "",
                "sceneSupplementEn": "",
                "sceneIds": [],
            },
        ).json()
        filtered = client.get(
            "/api/content-scripts",
            params={
                "page": 1,
                "status": "Draft",
                "category": "C-VA",
                "direction": "Audio",
            },
        )
        wrong_direction = client.get(
            "/api/content-scripts",
            params={"category": "C-VA", "direction": "Vision"},
        )

    assert filtered.status_code == 200
    assert filtered.json()["total"] == 1
    assert [row["id"] for row in filtered.json()["items"]] == [target["id"]]
    assert wrong_direction.json()["total"] == 0
