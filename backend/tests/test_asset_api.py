from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.adapters.config import Settings
from backend.adapters.llm import UnconfiguredPromptModel
from backend.app import create_app
from backend.domain.models import Asset, JobItem
from backend.tests.test_job_event_api import create_queued_job


def create_client(tmp_path: Path) -> TestClient:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    app = create_app(
        Settings(data_root=tmp_path, frontend_dist=frontend),
        UnconfiguredPromptModel(),
    )
    return TestClient(app)


def add_asset(client: TestClient, relative_path: str, content: bytes) -> Asset:
    path = client.app.state.database.data_root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    asset = Asset(
        storage_root=str(client.app.state.database.data_root),
        relative_path=relative_path,
        media_type="video/mp4",
        byte_size=len(content),
        width=1344,
        height=768,
        fps=24,
        frame_count=121,
        duration_seconds=121 / 24,
        has_audio=True,
    )
    with client.app.state.database.immediate_session() as session:
        session.add(asset)
        session.flush()
    assert asset.id is not None
    return asset


def test_media_get_head_and_single_range_return_exact_headers(tmp_path: Path) -> None:
    content = b"0123456789abcdef"
    client = create_client(tmp_path)
    asset = add_asset(client, "media/jobs/1/items/1/attempts/1/source.mp4", content)
    try:
        response = client.get(f"/api/media/{asset.id}")
        head = client.head(f"/api/media/{asset.id}")
        partial = client.get(f"/api/media/{asset.id}", headers={"Range": "bytes=4-8"})
    finally:
        client.close()

    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-length"] == str(len(content))
    assert response.headers["content-type"] == "video/mp4"
    assert response.headers["accept-ranges"] == "bytes"
    assert "etag" not in response.headers
    assert head.status_code == 200
    assert head.content == b""
    assert head.headers["content-length"] == str(len(content))
    assert head.headers["content-type"] == "video/mp4"
    assert head.headers["accept-ranges"] == "bytes"
    assert "etag" not in head.headers
    assert partial.status_code == 206
    assert partial.content == b"45678"
    assert partial.headers["content-length"] == "5"
    assert partial.headers["content-type"] == "video/mp4"
    assert partial.headers["accept-ranges"] == "bytes"
    assert partial.headers["content-range"] == f"bytes 4-8/{len(content)}"
    assert "etag" not in partial.headers


@pytest.mark.parametrize(
    ("range_header", "expected_content_range"),
    [
        ("bytes=abc", "bytes */5"),
        ("bytes=0-1,2-3", "bytes */5"),
        ("bytes=999-1000", "bytes */5"),
    ],
)
def test_media_rejects_malformed_multiple_and_unsatisfiable_ranges(
    tmp_path: Path,
    range_header: str,
    expected_content_range: str | None,
) -> None:
    client = create_client(tmp_path)
    asset = add_asset(client, "media/jobs/1/items/1/attempts/1/source.mp4", b"01234")
    try:
        response = client.get(f"/api/media/{asset.id}", headers={"Range": range_header})
    finally:
        client.close()

    assert response.status_code == 416
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-length"] == "0"
    assert response.headers["content-type"] == "video/mp4"
    assert "etag" not in response.headers
    assert response.headers["content-range"] == expected_content_range


def test_media_rejects_root_escape_and_missing_records(tmp_path: Path) -> None:
    client = create_client(tmp_path)
    missing_file = Asset(
        storage_root=str(client.app.state.database.data_root),
        relative_path="media/missing.mp4",
        media_type="video/mp4",
        byte_size=1,
        width=1344,
        height=768,
        fps=24,
        frame_count=121,
        duration_seconds=121 / 24,
        has_audio=True,
    )
    with client.app.state.database.immediate_session() as session:
        session.add(missing_file)
        session.flush()
    with client.app.state.database.engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
        cursor = connection.exec_driver_sql(
            """
            INSERT INTO assets (
                storage_root, relative_path, media_type, byte_size, width, height,
                fps, frame_count, duration_seconds, has_audio, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(client.app.state.database.data_root),
                "../outside.mp4",
                "video/mp4",
                1,
                1344,
                768,
                24,
                121,
                121 / 24,
                True,
                "2026-08-12T00:00:00Z",
            ),
        )
        unsafe_id = cursor.lastrowid
    try:
        absent = client.get("/api/media/999999")
        missing = client.get(f"/api/media/{missing_file.id}")
        unsafe = client.get(f"/api/media/{unsafe_id}")
    finally:
        client.close()

    assert absent.status_code == 404
    assert absent.json()["error"]["code"] == "not_found"
    for response in (missing, unsafe):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "asset_unavailable"
        assert str(tmp_path) not in response.text
        assert ".." not in response.text


def test_job_item_maps_existing_asset_ids_to_content_urls_without_flattening_prompt_result(
    tmp_path: Path,
) -> None:
    app, job = create_queued_job(tmp_path, quantity=1)
    client = TestClient(app)
    asset = add_asset(client, "media/jobs/1/items/1/attempts/1/source.mp4", b"video")
    with app.state.database.immediate_session() as session:
        item = session.get(JobItem, job.items[0].id)
        assert item is not None
        item.source_asset_id = asset.id
        item.primary_asset_id = asset.id
    try:
        response = client.get(f"/api/jobs/{job.id}/items")
    finally:
        client.close()

    assert response.status_code == 200
    item_payload = response.json()[0]
    assert item_payload["sourceAssetId"] == asset.id
    assert item_payload["sourceAssetUrl"] == f"/api/media/{asset.id}"
    assert item_payload["primaryAssetId"] == asset.id
    assert item_payload["primaryAssetUrl"] == f"/api/media/{asset.id}"
    assert item_payload["promptResult"] is None
    assert "finalPositivePrompt" not in item_payload
