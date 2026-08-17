from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlmodel import Session, SQLModel

from backend.adapters.database import Database
from backend.domain.enums import (
    Category,
    ContentMode,
    ResourceStatus,
    TemplateVersionStatus,
)
from backend.domain.models import (
    ContentScript,
    GpuSlot,
    PromptTemplateExample,
    PromptTemplateVersion,
    Scene,
)
from backend.services.catalog_seed import (
    CatalogSeedError,
    CatalogSeedInitializer,
    DEFAULT_CATALOG_SEED,
    EXPECTED_CONTENT_STATUSES,
    EXPECTED_COUNTS,
    load_default_catalog_seed,
)


TABLE_COUNTS = {
    "content_scripts": 104,
    "scenes": 75,
    "content_script_scenes": 75,
    "prompt_templates": 4,
    "prompt_template_versions": 4,
    "prompt_template_examples": 0,
    "gpu_slots": 2,
}


def _database(tmp_path: Path) -> Database:
    database = Database(tmp_path)
    database.initialize()
    return database


def _all_table_counts(database: Database) -> dict[str, int]:
    with database.engine.connect() as connection:
        return {
            table.name: connection.execute(
                select(func.count()).select_from(table)
            ).scalar_one()
            for table in sorted(SQLModel.metadata.tables.values(), key=lambda item: item.name)
        }


def test_default_seed_is_current_schema_and_matches_approved_inventory() -> None:
    seed = load_default_catalog_seed()
    assert {
        "contentScripts": len(seed.content_scripts),
        "scenes": len(seed.scenes),
        "contentScriptScenes": len(seed.content_script_scenes),
        "promptTemplates": len(seed.prompt_templates),
        "promptTemplateVersions": len(seed.prompt_template_versions),
        "promptTemplateExamples": len(seed.prompt_template_examples),
    } == EXPECTED_COUNTS
    assert Counter(row.record.status for row in seed.content_scripts) == Counter(
        EXPECTED_CONTENT_STATUSES
    )
    assert Counter(row.record.category for row in seed.content_scripts) == Counter(
        {
            Category.A_VA: 37,
            Category.A_VT: 25,
            Category.C_VA: 2,
            Category.C_VT: 40,
        }
    )
    assert Counter(row.record.mode for row in seed.content_scripts) == Counter(
        {ContentMode.FIXED: 71, ContentMode.GENERATIVE: 33}
    )
    assert all(row.record.status is ResourceStatus.ACTIVE for row in seed.scenes)
    assert {
        row.source.file
        for row in seed.prompt_templates
    } == {"config/ltx2_prompt_rules.yaml"}
    assert {
        row.negative_prompt_evidence.h3.file
        for row in seed.prompt_template_versions
    } == {"output/compare-vt-va-20260806/h3/va_aligned/payload.json"}
    assert all(
        row.verification_status is TemplateVersionStatus.VERIFIED
        for row in seed.prompt_template_versions
    )
    assert all(
        not reference.file.startswith("/")
        for row in seed.scenes
        for reference in row.source_references
    )
    serialized = DEFAULT_CATALOG_SEED.read_text().casefold()
    for forbidden in (
        "image-text",
        "/home/team",
        "background-001",
        "aligned-joy-v1",
        "prototype-1",
        "yaml-cse",
    ):
        assert forbidden not in serialized


def test_initializer_populates_only_catalog_and_gpu_slots(tmp_path: Path) -> None:
    database = _database(tmp_path)
    assert CatalogSeedInitializer(database).initialize() == EXPECTED_COUNTS
    counts = _all_table_counts(database)
    for table_name, expected in TABLE_COUNTS.items():
        assert counts[table_name] == expected
    assert {
        table_name: count
        for table_name, count in counts.items()
        if table_name not in TABLE_COUNTS
    } == {
        table_name: 0
        for table_name in counts
        if table_name not in TABLE_COUNTS
    }

    with Session(database.engine) as session:
        assert Counter(session.execute(select(ContentScript.status)).scalars().all()) == Counter(
            EXPECTED_CONTENT_STATUSES
        )
        assert all(
            status is ResourceStatus.ACTIVE
            for status in session.execute(select(Scene.status)).scalars().all()
        )
        assert all(
            status is TemplateVersionStatus.VERIFIED
            for status in session.execute(
                select(PromptTemplateVersion.verification_status)
            ).scalars().all()
        )
        assert len(session.execute(select(GpuSlot)).scalars().all()) == 2
        assert len(session.execute(select(PromptTemplateExample)).scalars().all()) == 0


def test_initializer_refuses_nonempty_catalog_without_changes(tmp_path: Path) -> None:
    database = _database(tmp_path)
    initializer = CatalogSeedInitializer(database)
    initializer.initialize()
    before = _all_table_counts(database)
    with pytest.raises(CatalogSeedError, match="requires empty catalog tables"):
        initializer.initialize()
    assert _all_table_counts(database) == before


def test_initializer_rolls_back_the_whole_catalog_on_failure(tmp_path: Path) -> None:
    database = _database(tmp_path)
    seed = load_default_catalog_seed().model_copy(deep=True)
    seed.content_script_scenes[0].scene_key = "missing-scene"
    with pytest.raises(KeyError, match="missing-scene"):
        CatalogSeedInitializer(database).initialize(seed)
    counts = _all_table_counts(database)
    assert counts["gpu_slots"] == 2
    for table_name in (
        "content_scripts",
        "scenes",
        "content_script_scenes",
        "prompt_templates",
        "prompt_template_versions",
        "prompt_template_examples",
    ):
        assert counts[table_name] == 0


def test_repository_script_initializes_once_and_refuses_a_second_run(
    tmp_path: Path,
) -> None:
    repository_root = Path(__file__).resolve().parents[2]
    command = [
        sys.executable,
        str(repository_root / "scripts" / "initialize_catalog.py"),
        "--data-root",
        str(tmp_path),
    ]
    first = subprocess.run(
        command,
        cwd=repository_root,
        check=False,
        capture_output=True,
        text=True,
    )
    assert first.returncode == 0, first.stderr
    assert json.loads(first.stdout) == EXPECTED_COUNTS

    second = subprocess.run(
        command,
        cwd=repository_root,
        check=False,
        capture_output=True,
        text=True,
    )
    assert second.returncode == 1
    assert "requires empty catalog tables" in second.stdout
