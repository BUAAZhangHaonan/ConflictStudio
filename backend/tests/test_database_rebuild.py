from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from backend.adapters.database import Database


LEGACY_SCHEMA = """
CREATE TABLE content_plans (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE video_background_presets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE prompt_presets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE datasets (id INTEGER PRIMARY KEY);
CREATE TABLE gpu_slots (
    slot TEXT PRIMARY KEY,
    availability TEXT NOT NULL,
    loaded_model TEXT,
    active_job_id INTEGER REFERENCES jobs(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL,
    checked_at TEXT NOT NULL
);
CREATE TABLE batch_drafts (
    id INTEGER PRIMARY KEY,
    dataset_id INTEGER NOT NULL,
    dataset_revision INTEGER NOT NULL,
    category TEXT NOT NULL,
    conflict_direction TEXT,
    model TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    seed_base INTEGER NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE RESTRICT
);
CREATE TABLE batch_draft_content_plans (
    batch_draft_id INTEGER REFERENCES batch_drafts(id) ON DELETE CASCADE,
    content_plan_id INTEGER REFERENCES content_plans(id) ON DELETE RESTRICT
);
CREATE TABLE batch_draft_prompt_presets (
    batch_draft_id INTEGER REFERENCES batch_drafts(id) ON DELETE CASCADE,
    prompt_preset_id INTEGER REFERENCES prompt_presets(id) ON DELETE RESTRICT
);
CREATE TABLE batch_draft_background_presets (
    batch_draft_id INTEGER REFERENCES batch_drafts(id) ON DELETE CASCADE,
    background_preset_id INTEGER REFERENCES video_background_presets(id) ON DELETE RESTRICT
);
CREATE TABLE batch_draft_demographics (
    id INTEGER PRIMARY KEY,
    batch_draft_id INTEGER REFERENCES batch_drafts(id) ON DELETE CASCADE
);
CREATE TABLE batch_draft_gpu_slots (
    batch_draft_id INTEGER REFERENCES batch_drafts(id) ON DELETE CASCADE,
    gpu_slot TEXT REFERENCES gpu_slots(slot) ON DELETE RESTRICT
);
CREATE TABLE batch_video_input_snapshots (
    id INTEGER PRIMARY KEY,
    batch_draft_id INTEGER,
    dataset_id INTEGER,
    dataset_revision INTEGER,
    sequence INTEGER NOT NULL,
    content_plan_id INTEGER NOT NULL,
    content_plan_revision INTEGER NOT NULL,
    prompt_preset_id INTEGER NOT NULL,
    prompt_preset_revision INTEGER NOT NULL,
    background_preset_id INTEGER NOT NULL,
    background_preset_revision INTEGER NOT NULL,
    policy_version TEXT NOT NULL,
    category TEXT NOT NULL,
    conflict_direction TEXT,
    age INTEGER NOT NULL,
    gender TEXT NOT NULL,
    ethnicity TEXT NOT NULL,
    model TEXT NOT NULL,
    seed INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    fps INTEGER NOT NULL,
    frame_count INTEGER NOT NULL,
    renderer_profile_version TEXT NOT NULL,
    prompt_model TEXT NOT NULL,
    source_has_audio BOOLEAN NOT NULL,
    derive_silent_primary BOOLEAN NOT NULL,
    system_input TEXT NOT NULL,
    user_input TEXT NOT NULL,
    final_negative_prompt TEXT NOT NULL,
    fixed_positive_prompt TEXT,
    fixed_dialogue TEXT,
    fixed_vt_text TEXT,
    fixed_true_emotion_description TEXT,
    true_emotion TEXT NOT NULL,
    apparent_emotion TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (batch_draft_id) REFERENCES batch_drafts(id) ON DELETE RESTRICT,
    FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE RESTRICT,
    FOREIGN KEY (content_plan_id) REFERENCES content_plans(id) ON DELETE RESTRICT,
    FOREIGN KEY (prompt_preset_id) REFERENCES prompt_presets(id) ON DELETE RESTRICT,
    FOREIGN KEY (background_preset_id) REFERENCES video_background_presets(id) ON DELETE RESTRICT
);
CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    display_name TEXT NOT NULL,
    source TEXT NOT NULL,
    dataset_id INTEGER,
    batch_draft_id INTEGER,
    category TEXT NOT NULL,
    conflict_direction TEXT,
    model TEXT,
    status TEXT NOT NULL,
    total_count INTEGER NOT NULL,
    prepared_count INTEGER NOT NULL,
    completed_count INTEGER NOT NULL,
    failed_count INTEGER NOT NULL,
    confirm_model_switch BOOLEAN NOT NULL,
    cancel_requested_at TEXT,
    failure_code TEXT,
    failure_reason TEXT,
    started_at TEXT,
    finished_at TEXT,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE RESTRICT,
    FOREIGN KEY (batch_draft_id) REFERENCES batch_drafts(id) ON DELETE RESTRICT
);
CREATE TABLE assets (id INTEGER PRIMARY KEY);
CREATE TABLE job_items (
    id INTEGER PRIMARY KEY,
    job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    input_snapshot_id INTEGER REFERENCES batch_video_input_snapshots(id) ON DELETE RESTRICT,
    gpu_slot TEXT REFERENCES gpu_slots(slot) ON DELETE RESTRICT,
    source_asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT,
    primary_asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT
);
CREATE TABLE job_item_prompt_results (
    id INTEGER PRIMARY KEY,
    job_item_id INTEGER REFERENCES job_items(id) ON DELETE CASCADE
);
CREATE TABLE generation_attempts (
    id INTEGER PRIMARY KEY,
    job_item_id INTEGER NOT NULL,
    attempt_number INTEGER NOT NULL,
    model TEXT NOT NULL,
    gpu_slot TEXT NOT NULL,
    seed INTEGER NOT NULL,
    source_asset_id INTEGER,
    primary_asset_id INTEGER,
    renderer_prompt_id TEXT,
    status TEXT NOT NULL,
    failure_reason TEXT,
    started_at TEXT,
    finished_at TEXT,
    FOREIGN KEY (job_item_id) REFERENCES job_items(id) ON DELETE CASCADE,
    FOREIGN KEY (gpu_slot) REFERENCES gpu_slots(slot) ON DELETE RESTRICT,
    FOREIGN KEY (source_asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
    FOREIGN KEY (primary_asset_id) REFERENCES assets(id) ON DELETE RESTRICT
);
CREATE TABLE job_events (
    id INTEGER PRIMARY KEY,
    job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES job_items(id) ON DELETE SET NULL
);
"""


GENERATION_BUSINESS_TABLES = (
    "datasets",
    "batch_draft_content_plans",
    "batch_draft_prompt_presets",
    "batch_draft_background_presets",
    "batch_draft_demographics",
    "batch_draft_gpu_slots",
    "batch_video_input_snapshots",
    "batch_drafts",
    "job_item_prompt_results",
    "generation_attempts",
    "samples",
    "job_events",
    "job_items",
    "jobs",
    "assets",
)


def test_rebuild_empty_generation_tables_refuses_business_data(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    with sqlite3.connect(database.database_path) as connection:
        connection.execute(
            """
            INSERT INTO datasets
                (id, name, name_key, purpose, note, status, revision, created_at, updated_at)
            VALUES (1, 'Protected', 'protected', 'Production', '', 'Active', 1,
                    '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')
            """
        )
        connection.execute(
            """
            INSERT INTO batch_drafts
                (id, dataset_id, dataset_revision, category, conflict_direction, model,
                 precision, quantity, seed_base, status, revision, created_at, updated_at)
            VALUES (1, 1, 1, 'A-VA', NULL, 'LTX-2.5', 'INT8', 1, 1, 'Draft', 1,
                    '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')
            """
        )
        original_schema = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'batch_drafts'"
        ).fetchone()

    with pytest.raises(RuntimeError, match="business data exists in: batch_drafts"):
        database.rebuild_empty_generation_tables()

    with sqlite3.connect(database.database_path) as connection:
        assert connection.execute("SELECT id FROM batch_drafts").fetchall() == [(1,)]
        assert connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'batch_drafts'"
        ).fetchone() == original_schema
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)


def test_rebuild_empty_generation_tables_upgrades_legacy_schema_and_retains_catalog(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path)
    with sqlite3.connect(database.database_path) as connection:
        connection.executescript(LEGACY_SCHEMA)
        connection.executemany(
            "INSERT INTO content_plans (id, name) VALUES (?, ?)",
            ((index, f"content-{index}") for index in range(1, 105)),
        )
        connection.executemany(
            "INSERT INTO video_background_presets (id, name) VALUES (?, ?)",
            ((index, f"background-{index}") for index in range(1, 76)),
        )
        connection.executemany(
            "INSERT INTO prompt_presets (id, name) VALUES (?, ?)",
            ((index, f"prompt-{index}") for index in range(1, 5)),
        )
        connection.executemany(
            """
            INSERT INTO gpu_slots
                (slot, availability, loaded_model, active_job_id, revision, checked_at)
            VALUES (?, 'Unknown', NULL, NULL, 1, '2026-08-13T00:00:00Z')
            """,
            ((slot,) for slot in ("GPU0", "GPU1")),
        )
        connection.execute("INSERT INTO datasets (id) VALUES (1)")
        for table_name in (
            "batch_drafts",
            "batch_video_input_snapshots",
            "jobs",
            "generation_attempts",
        ):
            columns = {
                row[1]
                for row in connection.execute(f'PRAGMA table_info("{table_name}")').fetchall()
            }
            assert "precision" not in columns
        gpu_columns = {
            row[1] for row in connection.execute('PRAGMA table_info("gpu_slots")').fetchall()
        }
        assert "loaded_precision" not in gpu_columns
        assert connection.execute(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'samples'"
        ).fetchone() == (0,)

    database.rebuild_empty_generation_tables()

    with sqlite3.connect(database.database_path) as connection:
        assert [
            connection.execute(f'SELECT count(*) FROM "{table_name}"').fetchone()[0]
            for table_name in (
                "content_plans",
                "video_background_presets",
                "prompt_presets",
                "gpu_slots",
            )
        ] == [104, 75, 4, 2]
        assert all(
            connection.execute(f'SELECT count(*) FROM "{table_name}"').fetchone()[0] == 0
            for table_name in GENERATION_BUSINESS_TABLES
        )

        with connection:
            connection.execute(
                """
                INSERT INTO datasets
                    (id, name, name_key, purpose, note, status, revision, created_at, updated_at)
                VALUES (1, 'Database test', 'database test', 'Production', '', 'Active', 1,
                        '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')
                """
            )
            for precision in ("BF16", "INT8"):
                connection.execute(
                    """
                    INSERT INTO batch_drafts
                        (id, dataset_id, dataset_revision, category, conflict_direction, model,
                         precision, quantity, seed_base, status, revision, created_at, updated_at)
                    VALUES (?, 1, 1, 'A-VA', NULL, 'LTX-2.5', ?, 1, 1, 'Draft', 1,
                            '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')
                    """,
                    (1 if precision == "BF16" else 2, precision),
                )

            invalid_pairs = (
                ("LTX-2.5", None),
                ("LTX-2.3", "BF16"),
                ("MiniMax H3", "INT8"),
            )
            for model, precision in invalid_pairs:
                with pytest.raises(sqlite3.IntegrityError):
                    connection.execute(
                        """
                        INSERT INTO batch_drafts
                            (dataset_id, dataset_revision, category, conflict_direction, model,
                             precision, quantity, seed_base, status, revision, created_at, updated_at)
                        VALUES (1, 1, 'A-VA', NULL, ?, ?, 1, 1, 'Draft', 1,
                                '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z')
                        """,
                        (model, precision),
                    )

        snapshot_sql = """
            INSERT INTO batch_video_input_snapshots
                (sequence, content_plan_id, content_plan_revision, prompt_preset_id,
                 prompt_preset_revision, background_preset_id, background_preset_revision,
                 policy_version, category, conflict_direction, age, gender, ethnicity, model,
                 precision, seed, width, height, fps, frame_count, renderer_profile_version,
                 prompt_model, source_has_audio, derive_silent_primary, system_input, user_input,
                 final_negative_prompt, true_emotion, apparent_emotion, created_at)
            VALUES (?, 1, 1, 1, 1, 1, 1, 'policy', 'A-VA', NULL, 25, 'Female',
                    'EastAsian', ?, ?, 1, 1344, 768, 24, ?, '2026-08-12.1', 'prompt-model',
                    1, 0, 'system', 'user', 'negative', 'calm', 'calm',
                    '2026-08-13T00:00:00Z')
        """
        valid_frames = (
            (1, "LTX-2.3", None, 121),
            (2, "LTX-2.5", "BF16", 121),
            (3, "LTX-2.5", "INT8", 121),
            (4, "MiniMax H3", None, 124),
        )
        with connection:
            connection.executemany(snapshot_sql, valid_frames)
            for invalid_frames in (
                (5, "LTX-2.3", None, 124),
                (6, "LTX-2.5", "BF16", 124),
                (7, "MiniMax H3", None, 121),
            ):
                with pytest.raises(sqlite3.IntegrityError):
                    connection.execute(snapshot_sql, invalid_frames)

        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
