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


def client_for(tmp_path: Path) -> TestClient:
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    return TestClient(create_app(Settings(data_root=tmp_path, frontend_dist=frontend), UnconfiguredPromptModel()))


def create_catalog_records(client: TestClient) -> dict[str, dict]:
    records = {
        "dataset": client.post(
            "/api/datasets",
            json={"name": "Production", "purpose": "Production", "note": "Initial"},
        ),
        "content": client.post(
            "/api/content-plans",
            json={
                "name": "Calm response",
                "category": "A-VA",
                "mode": "Generative",
                "status": "Active",
                "trueEmotion": "calm",
                "apparentEmotion": "calm",
                "scene": "A private study with one chair.",
                "triggerEvent": "A timer sounds.",
                "psychologicalBackground": "The subject prepares a brief response.",
                "contentRequirements": "Describe one adult responding in the room.",
            },
        ),
        "prompt": client.post(
            "/api/prompt-presets",
            json={
                "name": "Natural shot",
                "category": "A-VA",
                "styleGuidance": "Use a static medium shot.",
                "finalRenderNegativeConstraints": "subtitles, captions, camera shake",
            },
        ),
        "background": client.post(
            "/api/video-background-presets",
            json={
                "name": "Private study",
                "scene": "A private study containing one chair and one desk.",
                "ambientSound": "A quiet ventilation hum is audible.",
                "lighting": "Soft daylight enters through one window.",
                "framing": "Use a static eye-level medium shot.",
            },
        ),
    }
    assert all(response.status_code == 201 for response in records.values())
    return {name: response.json() for name, response in records.items()}


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
        "name, name_key, scene, ambient_audio, relationship, lighting, framing_supplement, "
        "status, revision, created_at, updated_at"
    )
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                f"INSERT INTO video_background_presets ({columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "Invalid background",
                    "invalid background",
                    "A friend waits beside the subject.",
                    "Room tone",
                    "",
                    "Soft daylight",
                    "Medium shot",
                    "Active",
                    1,
                    "2026-08-12T00:00:00Z",
                    "2026-08-12T00:00:00Z",
                ),
            )

        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                f"INSERT INTO video_background_presets ({columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "Invalid emotion background",
                    "invalid emotion background",
                    "A private office with one chair.",
                    "Room tone",
                    "",
                    "Emotion: surprise",
                    "Medium shot",
                    "Active",
                    1,
                    "2026-08-12T00:00:00Z",
                    "2026-08-12T00:00:00Z",
                ),
            )

        connection.execute(
            f"INSERT INTO video_background_presets ({columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "Valid background",
                "valid background",
                "Alone in a small kitchen, preparing a surprise breakfast.",
                "Room tone",
                "",
                "Soft daylight",
                "Medium shot",
                "Active",
                1,
                "2026-08-12T00:00:00Z",
                "2026-08-12T00:00:00Z",
            ),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "UPDATE video_background_presets SET ambient_audio = ? WHERE name_key = ?",
                ("An orchestra plays nearby.", "valid background"),
            )
    finally:
        connection.close()


def test_sqlite_schema_contains_enum_and_numeric_checks_and_gpu_foreign_keys(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()

    enum_columns = {
        "datasets": ("purpose", "status"),
        "content_plans": ("category", "conflict_direction", "mode", "status"),
        "prompt_presets": ("category", "status"),
        "prompt_examples": ("kind",),
        "video_background_presets": ("status",),
        "batch_drafts": ("category", "conflict_direction", "model", "status"),
        "batch_draft_demographics": ("gender", "ethnicity"),
        "batch_draft_gpu_slots": ("gpu_slot",),
        "batch_video_input_snapshots": ("category", "conflict_direction", "gender", "ethnicity", "model"),
        "jobs": ("source", "category", "conflict_direction", "model", "status"),
        "job_items": ("gpu_slot", "stage", "status"),
        "gpu_slots": ("slot", "availability", "loaded_model"),
    }
    for table_name, columns in enum_columns.items():
        ddl = normalized_table_sql(database, table_name)
        for column in columns:
            assert f"CHECK ({column} IN (" in ddl

    numeric_constraints = {
        "datasets": ("ck_datasets_revision",),
        "content_plans": ("ck_content_plans_revision",),
        "prompt_presets": ("ck_prompt_presets_revision",),
        "prompt_examples": ("ck_prompt_examples_position",),
        "video_background_presets": ("ck_background_presets_revision",),
        "batch_drafts": ("ck_batch_drafts_dataset_revision", "ck_batch_drafts_revision"),
        "batch_draft_content_plans": ("ck_batch_content_position", "ck_batch_content_revision"),
        "batch_draft_prompt_presets": ("ck_batch_preset_position", "ck_batch_preset_revision"),
        "batch_draft_background_presets": ("ck_batch_background_position", "ck_batch_background_revision"),
        "batch_draft_demographics": ("ck_batch_demographics_position",),
        "batch_draft_gpu_slots": ("ck_batch_gpu_position",),
        "batch_video_input_snapshots": (
            "ck_batch_snapshots_sequence",
            "ck_batch_snapshots_dataset_revision",
            "ck_batch_snapshots_content_revision",
            "ck_batch_snapshots_preset_revision",
            "ck_batch_snapshots_background_revision",
            "ck_batch_snapshots_video_format",
            "ck_batch_snapshots_model_frames",
            "ck_batch_snapshots_silent_primary",
            "ck_batch_snapshots_source_audio",
            "ck_batch_snapshots_renderer_profile",
        ),
        "jobs": ("ck_jobs_revision",),
        "job_items": ("ck_job_items_sequence", "ck_job_items_revision"),
        "gpu_slots": ("ck_gpu_slots_revision",),
    }
    for table_name, names in numeric_constraints.items():
        ddl = normalized_table_sql(database, table_name)
        for name in names:
            assert f"CONSTRAINT {name} CHECK" in ddl

    for table_name in ("batch_draft_gpu_slots", "job_items"):
        with database.engine.connect() as connection:
            foreign_keys = connection.exec_driver_sql(f"PRAGMA foreign_key_list({table_name})").all()
        assert ("gpu_slots", "gpu_slot", "slot") in {
            (row[2], row[3], row[4]) for row in foreign_keys
        }


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
                json={"name": "Locked", "purpose": "Production", "note": ""},
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
            json={"name": "Unlocked", "purpose": "Production", "note": ""},
        )
        assert retried.status_code == 201


def test_expected_revision_only_updates_return_422_without_incrementing_revision(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        records = create_catalog_records(client)
        requests = (
            (f"/api/datasets/{records['dataset']['id']}", "/api/datasets", records["dataset"]["id"]),
            (
                f"/api/content-plans/{records['content']['id']}",
                f"/api/content-plans/{records['content']['id']}",
                None,
            ),
            (
                f"/api/prompt-presets/{records['prompt']['id']}",
                f"/api/prompt-presets/{records['prompt']['id']}",
                None,
            ),
            (
                f"/api/video-background-presets/{records['background']['id']}",
                f"/api/video-background-presets/{records['background']['id']}",
                None,
            ),
        )

        for update_path, read_path, list_identifier in requests:
            response = client.patch(update_path, json={"expectedRevision": 1})
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "validation_error"
            current = client.get(read_path).json()
            if list_identifier is not None:
                current = next(row for row in current if row["id"] == list_identifier)
            assert current["revision"] == 1


def test_batch_detail_uses_saved_source_revisions(tmp_path: Path) -> None:
    with client_for(tmp_path) as client:
        records = create_catalog_records(client)
        draft_response = client.post(
            "/api/batch-drafts",
            json={
                "datasetId": records["dataset"]["id"],
                "category": "A-VA",
                "model": "LTX-2.3",
                "quantity": 1,
                "seed": 7,
                "contentPlans": [{"id": records["content"]["id"], "expectedRevision": 1}],
                "promptPresets": [{"id": records["prompt"]["id"], "expectedRevision": 1}],
                "backgroundPresets": [{"id": records["background"]["id"], "expectedRevision": 1}],
                "demographics": [{"age": 25, "gender": "Female", "ethnicity": "EastAsian"}],
                "gpuSlots": ["GPU0"],
            },
        )
        assert draft_response.status_code == 201
        draft = draft_response.json()

        updates = (
            (f"/api/datasets/{records['dataset']['id']}", {"expectedRevision": 1, "note": "Changed"}),
            (
                f"/api/content-plans/{records['content']['id']}",
                {"expectedRevision": 1, "scene": "A changed private study."},
            ),
            (
                f"/api/prompt-presets/{records['prompt']['id']}",
                {"expectedRevision": 1, "name": "Changed prompt"},
            ),
            (
                f"/api/video-background-presets/{records['background']['id']}",
                {"expectedRevision": 1, "name": "Changed background"},
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
        assert body["contentPlans"][0]["revision"] == 1
        assert body["promptPresets"][0]["revision"] == 1
        assert body["backgroundPresets"][0]["revision"] == 1
