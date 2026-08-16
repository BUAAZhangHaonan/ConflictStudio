from __future__ import annotations

import sqlite3
from pathlib import Path
from time import monotonic

import pytest
from fastapi.testclient import TestClient

from backend.adapters.config import Settings
from backend.adapters.database import SQLITE_BUSY_TIMEOUT_MS, Database
from backend.adapters.llm import UnconfiguredPromptModel
from backend.app import create_app
from backend.tests.test_review_api import sample_app


def client_for(tmp_path: Path) -> TestClient:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    return TestClient(create_app(Settings(data_root=tmp_path, frontend_dist=frontend), UnconfiguredPromptModel()))


def create_catalog_records(client: TestClient) -> dict[str, dict]:
    background = client.post(
        "/api/scenes",
        json={
            "nameZh": "私人书房",
            "nameEn": "Private study",
            "sceneZh": "一间有一把椅子和一张书桌的私人书房。",
            "sceneEn": "A private study containing one chair and one desk.",
            "ambientSoundZh": "能听到安静的通风声。",
            "ambientSoundEn": "A quiet ventilation hum is audible.",
            "participantRelationshipZh": "",
            "participantRelationshipEn": "",
            "lightingZh": "柔和的日光从一扇窗户照进来。",
            "lightingEn": "Soft daylight enters through one window.",
            "framingZh": "使用静止的平视中景。",
            "framingEn": "Use a static eye-level medium shot.",
        },
    )
    records = {
        "dataset": client.post(
            "/api/datasets",
            json={"name": "Production", "note": "Initial"},
        ),
        "content": client.post(
            "/api/content-scripts",
            json={
                "nameZh": "平静回应",
                "nameEn": "Calm response",
                "category": "A-VA",
                "mode": "Generative",
                "status": "Active",
                "trueEmotion": "calm",
                "apparentEmotion": "calm",
                "sceneZh": "一间只有一把椅子的私人书房。",
                "sceneEn": "A private study with one chair.",
                "triggerEventZh": "计时器响起。",
                "triggerEventEn": "A timer sounds.",
                "psychologicalBackgroundZh": "被摄者准备作出简短回应。",
                "psychologicalBackgroundEn": "The subject prepares a brief response.",
                "contentRequirementsZh": "描述一名成年人在房间内回应。",
                "contentRequirementsEn": "Describe one adult responding in the room.",
                "sceneSupplementZh": "",
                "sceneSupplementEn": "",
                "sceneIds": [background.json()["id"]],
            },
        ),
        "prompt": client.post(
            "/api/prompt-template-versions",
            json={
                "name": "Natural shot",
                "category": "A-VA",
                "styleGuidance": "Use a static medium shot.",
                "ltxNegativePrompt": "subtitles, captions, camera shake",
                "h3NegativePrompt": "subtitles, captions, camera shake",
                "version": 1,
                "verificationStatus": "Verified",
            },
        ),
        "background": background,
    }
    assert all(response.status_code == 201 for response in records.values())
    values = {name: response.json() for name, response in records.items()}
    return values


def normalized_table_sql(database: Database, table_name: str) -> str:
    with database.engine.connect() as connection:
        statement = connection.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).scalar_one()
    return " ".join(statement.split())


def test_background_policy_triggers_reject_direct_sql_writes(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    connection = sqlite3.connect(database.database_path)
    columns = (
        "name_zh, name_zh_key, name_en, name_en_key, scene_zh, scene_en, "
        "ambient_sound_zh, ambient_sound_en, participant_relationship_zh, "
        "participant_relationship_en, lighting_zh, lighting_en, framing_zh, framing_en, "
        "status, revision, created_at, updated_at"
    )
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                f"INSERT INTO scenes ({columns}) VALUES ({', '.join('?' for _ in range(18))})",
                (
                    "无效背景",
                    "无效背景",
                    "Invalid background",
                    "invalid background",
                    "被摄者旁边等待着一位朋友。",
                    "A friend waits beside the subject.",
                    "",
                    "Room tone",
                    "",
                    "",
                    "",
                    "Soft daylight",
                    "",
                    "Medium shot",
                    "Active",
                    1,
                    "2026-08-12T00:00:00Z",
                    "2026-08-12T00:00:00Z",
                ),
            )

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                f"INSERT INTO scenes ({columns}) VALUES ({', '.join('?' for _ in range(18))})",
                (
                    "无效情绪背景",
                    "无效情绪背景",
                    "Invalid emotion background",
                    "invalid emotion background",
                    "一间只有一把椅子的私人办公室。",
                    "A private office with one chair.",
                    "",
                    "Room tone",
                    "",
                    "",
                    "",
                    "Emotion: surprise",
                    "",
                    "Medium shot",
                    "Active",
                    1,
                    "2026-08-12T00:00:00Z",
                    "2026-08-12T00:00:00Z",
                ),
            )

        connection.execute(
            f"INSERT INTO scenes ({columns}) VALUES ({', '.join('?' for _ in range(18))})",
            (
                "有效背景",
                "有效背景",
                "Valid background",
                "valid background",
                "独自在小厨房里准备一份惊喜早餐。",
                "Alone in a small kitchen, preparing a surprise breakfast.",
                "",
                "Room tone",
                "",
                "",
                "",
                "Soft daylight",
                "",
                "Medium shot",
                "Active",
                1,
                "2026-08-12T00:00:00Z",
                "2026-08-12T00:00:00Z",
            ),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE scenes SET ambient_sound_en = ? WHERE name_en_key = ?",
                ("An orchestra plays nearby.", "valid background"),
            )
    finally:
        connection.close()


def test_sqlite_schema_contains_enum_and_numeric_checks_and_gpu_foreign_keys(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()

    enum_columns = {
        "datasets": ("purpose", "status"),
        "content_scripts": ("category", "conflict_direction", "mode", "status"),
        "prompt_template_versions": ("category", "verification_status"),
        "scenes": ("status",),
        "batch_drafts": ("category", "conflict_direction", "model", "precision", "status"),
        "batch_draft_demographics": ("gender", "ethnicity"),
        "batch_draft_gpu_slots": ("gpu_slot",),
        "batch_video_input_snapshots": ("category", "conflict_direction", "gender", "ethnicity", "model", "precision"),
        "jobs": ("source", "category", "conflict_direction", "model", "precision", "status"),
        "job_items": ("gpu_slot", "stage", "status"),
        "generation_attempts": ("model", "precision", "gpu_slot", "status"),
        "samples": ("category", "conflict_direction", "review_decision", "model", "gpu_slot", "gender", "ethnicity"),
        "reviews": ("protocol", "relation", "decision"),
        "gpu_slots": ("slot", "availability", "loaded_model", "loaded_precision"),
    }
    for table_name, columns in enum_columns.items():
        ddl = normalized_table_sql(database, table_name)
        for column in columns:
            assert f"CHECK ({column} IN (" in ddl

    numeric_constraints = {
        "datasets": ("ck_datasets_revision",),
        "content_scripts": ("ck_content_scripts_revision",),
        "prompt_template_versions": ("ck_prompt_template_versions_version", "ck_prompt_template_versions_revision"),
        "scenes": ("ck_scenes_revision",),
        "content_script_scenes": ("ck_content_script_scene_position",),
        "batch_drafts": ("ck_batch_drafts_dataset_revision", "ck_batch_drafts_revision", "ck_batch_drafts_model_precision"),
        "batch_draft_script_selections": (
            "ck_batch_content_selection_position",
            "ck_batch_content_selection_revision",
        ),
        "batch_draft_prompt_template_versions": ("ck_batch_single_prompt_template_version", "ck_batch_preset_revision"),
        "batch_draft_content_scenes": (
            "ck_batch_content_scene_position",
            "ck_batch_content_scene_revision",
        ),
        "batch_draft_demographics": ("ck_batch_demographics_position",),
        "batch_draft_gpu_slots": ("ck_batch_gpu_position",),
        "batch_video_input_snapshots": (
            "ck_batch_snapshots_sequence",
            "ck_batch_snapshots_dataset_revision",
            "ck_batch_snapshots_content_revision",
            "ck_batch_snapshots_preset_revision",
            "ck_batch_snapshots_scene_revision",
            "ck_batch_snapshots_video_format",
            "ck_batch_snapshots_model_frames",
            "ck_batch_snapshots_silent_primary",
            "ck_batch_snapshots_source_audio",
            "ck_batch_snapshots_renderer_profile",
            "ck_batch_snapshots_model_precision",
        ),
        "jobs": ("ck_jobs_revision", "ck_jobs_model_precision"),
        "job_items": ("ck_job_items_sequence", "ck_job_items_revision"),
        "generation_attempts": ("ck_generation_attempts_model_precision",),
        "samples": ("ck_samples_content_revision", "ck_samples_seed", "ck_samples_review_revision", "ck_samples_revision"),
        "reviewers": ("ck_reviewers_revision",),
        "reviews": ("ck_reviews_sample_revision", "ck_reviews_revision", "ck_reviews_decision"),
        "archives": ("ck_archives_revision",),
        "archive_items": ("ck_archive_items_sample_revision",),
        "gpu_slots": ("ck_gpu_slots_revision", "ck_gpu_slots_loaded_model_precision"),
    }
    for table_name, names in numeric_constraints.items():
        ddl = normalized_table_sql(database, table_name)
        for name in names:
            assert f"CONSTRAINT {name} CHECK" in ddl

    assert "precision" not in normalized_table_sql(database, "samples")

    for table_name in ("batch_draft_gpu_slots", "job_items"):
        with database.engine.connect() as connection:
            foreign_keys = connection.exec_driver_sql(f"PRAGMA foreign_key_list({table_name})").all()
        assert ("gpu_slots", "gpu_slot", "slot") in {
            (row[2], row[3], row[4]) for row in foreign_keys
        }


def test_archive_item_database_trigger_requires_matching_sample_dataset(tmp_path: Path) -> None:
    app = sample_app(tmp_path)
    with TestClient(app) as client:
        sample = client.get("/api/samples").json()["items"][0]
        other = client.post(
            "/api/datasets",
            json={"name": "Other", "note": ""},
        ).json()

    connection = sqlite3.connect(app.state.database.database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        with pytest.raises(sqlite3.IntegrityError, match="archive item dataset"):
            connection.execute(
                "INSERT INTO archive_items (dataset_id, sample_id, sample_revision, synced_at) "
                "VALUES (?, ?, ?, ?)",
                (other["id"], sample["id"], sample["revision"], "2026-08-14T00:00:00Z"),
            )
    finally:
        connection.close()


def test_write_lock_returns_stable_409_and_releases_connection(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        database = client.app.state.database
        with database.engine.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA busy_timeout").scalar_one() == SQLITE_BUSY_TIMEOUT_MS

        locker = sqlite3.connect(database.database_path, timeout=0)
        locker.execute("BEGIN IMMEDIATE")
        started = monotonic()
        try:
            response = client.post(
                "/api/datasets",
                json={"name": "Locked", "note": ""},
            )
        finally:
            locker.rollback()
            locker.close()

        assert monotonic() - started < 1
        assert response.status_code == 409
        assert response.json()["error"] == {
            "code": "database_busy",
            "message": "The database is busy with another write transaction",
            "details": {},
        }
        assert database.engine.pool.checkedout() == 0

        retried = client.post(
            "/api/datasets",
            json={"name": "Unlocked", "note": ""},
        )
        assert retried.status_code == 201


def test_prompt_template_version_reads_continue_during_sqlite_write(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        created = client.post(
            "/api/prompt-template-versions",
            json={
                "name": "Natural shot",
                "category": "A-VA",
                "styleGuidance": "Use a static medium shot.",
                "ltxNegativePrompt": "subtitles, captions, camera shake",
                "h3NegativePrompt": "subtitles, captions, camera shake",
                "version": 1,
                "verificationStatus": "Verified",
            },
        )
        assert created.status_code == 201

        database = client.app.state.database
        with database.engine.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA journal_mode").scalar_one() == "wal"

        writer = sqlite3.connect(database.database_path, timeout=0, isolation_level=None)
        try:
            writer.execute("BEGIN EXCLUSIVE")
            writer.execute("UPDATE gpu_slots SET checked_at = checked_at WHERE slot = 'GPU0'")
            response = client.get("/api/prompt-template-versions")
        finally:
            writer.rollback()
            writer.close()

        assert response.status_code == 200
        assert response.json()["items"] == [created.json()]


def test_expected_revision_only_updates_return_422_without_incrementing_revision(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        records = create_catalog_records(client)
        requests = (
            (
                f"/api/datasets/{records['dataset']['id']}",
                "/api/datasets",
                records["dataset"]["id"],
                records["dataset"]["revision"],
            ),
            (
                f"/api/content-scripts/{records['content']['id']}",
                f"/api/content-scripts/{records['content']['id']}",
                None,
                records["content"]["revision"],
            ),
            (
                f"/api/scenes/{records['background']['id']}",
                f"/api/scenes/{records['background']['id']}",
                None,
                records["background"]["revision"],
            ),
        )

        for update_path, read_path, list_identifier, revision in requests:
            response = client.patch(
                update_path,
                json={"expectedRevision": revision},
            )
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "validation_error"
            current = client.get(read_path).json()
            if list_identifier is not None:
                current = next(
                    row
                    for row in current["items"]
                    if row["id"] == list_identifier
                )
            assert current["revision"] == revision


def test_batch_detail_uses_saved_source_revisions(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        records = create_catalog_records(client)
        draft_response = client.post(
            "/api/batch-drafts",
            json={
                "targetDatasetId": records["dataset"]["id"],
                "category": "A-VA",
                "model": "LTX-2.3",
                "quantity": 1,
                "seed": 7,
                "contentSelections": [
                    {
                        "contentScriptId": records["content"]["id"],
                        "sceneIds": [records["background"]["id"]],
                    }
                ],
                "promptTemplateVersionId": records["prompt"]["id"],
                "demographics": [{"age": 25, "gender": "Female", "ethnicity": "EastAsian"}],
                "gpuSlots": ["GPU0"],
            },
        )
        assert draft_response.status_code == 201
        draft = draft_response.json()

        updates = (
            (f"/api/datasets/{records['dataset']['id']}", {"expectedRevision": 1, "note": "Changed"}),
            (
                f"/api/content-scripts/{records['content']['id']}",
                {
                    "expectedRevision": 1,
                    "sceneEn": "A changed private study.",
                    "sceneIds": [records["background"]["id"]],
                },
            ),
            (
                f"/api/scenes/{records['background']['id']}",
                {"expectedRevision": 1, "nameEn": "Changed background"},
            ),
        )
        update_responses = [(path, client.patch(path, json=payload)) for path, payload in updates]
        assert [(path, response.status_code) for path, response in update_responses] == [
            (path, 200) for path, _ in updates
        ]

        saved = client.get(f"/api/batch-drafts/{draft['id']}")
        assert saved.status_code == 200
        body = saved.json()
        assert body["datasetRevision"] == 1
        assert body["contentSelections"][0]["contentScript"]["revision"] == 1
        assert body["contentSelections"][0]["mode"] == "Generative"
        assert body["promptTemplateVersion"]["revision"] == 1
        assert body["contentSelections"][0]["scenes"][0]["revision"] == 1
        assert body["contentSelections"][0]["compatibleScenes"][0]["id"] == records["background"]["id"]
