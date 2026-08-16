from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from backend.adapters.database import Database
from backend.domain.enums import (
    Category,
    ConflictDirection,
    ContentMode,
    DatasetPurpose,
    GpuAvailability,
    GpuSlotName,
    ModelName,
    Precision,
)
from backend.domain.models import BatchDraft, ContentScript, Dataset, GpuSlot, Sample
from backend.domain.schemas import (
    BatchDraftCreate,
    ContentScriptCreate,
    ContentScriptUpdate,
    DatasetUpdate,
    PromptTemplateVersionCreate,
    SceneCreate,
    SceneUpdate,
)


def batch_payload(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "targetDatasetId": 1,
        "category": "A-VA",
        "quantity": 1,
        "contentSelections": [
            {"contentScriptId": 1, "sceneIds": [1]}
        ],
        "promptTemplateVersionId": 1,
        "demographics": [{"age": 25, "gender": "Female", "ethnicity": "EastAsian"}],
        "gpuSlots": ["GPU0"],
    }
    values.update(overrides)
    return values


def test_batch_contract_rejects_removed_global_selection_fields() -> None:
    payload = batch_payload()
    payload.pop("contentSelections")
    payload.pop("promptTemplateVersionId")
    payload.update(
        {
            "datasetId": 1,
            "contentScripts": [{"id": 1, "expectedRevision": 1}],
            "promptTemplateVersions": [{"id": 1, "expectedRevision": 1}],
            "scenes": [{"id": 1, "expectedRevision": 1}],
        }
    )
    with pytest.raises(ValidationError):
        BatchDraftCreate.model_validate(payload)


def test_prompt_template_version_rejects_removed_scene_supplement() -> None:
    with pytest.raises(ValidationError):
        PromptTemplateVersionCreate.model_validate(
            {
                "name": "Natural",
                "category": "A-VA",
                "styleGuidance": "Use concise observable wording.",
                "sceneSupplement": "Use a quiet office.",
                "ltxNegativePrompt": "subtitles",
                "h3NegativePrompt": "subtitles",
                "version": 1,
                "verificationStatus": "Verified",
            }
        )


def content_script_payload(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "nameZh": "方案",
        "nameEn": "Plan",
        "category": Category.A_VA,
        "mode": ContentMode.GENERATIVE,
        "trueEmotion": "calm",
        "apparentEmotion": "calm",
        "sceneZh": "一间私人办公室。",
        "sceneEn": "A private office.",
        "triggerEventZh": "计时器响起。",
        "triggerEventEn": "A timer sounds.",
        "psychologicalBackgroundZh": "被摄者准备回答。",
        "psychologicalBackgroundEn": "The subject prepares to answer.",
        "contentRequirementsZh": "描述一名成年人在房间里作出回应。",
        "contentRequirementsEn": "Describe one adult responding in the room.",
        "sceneSupplementZh": "保持办公室环境清楚可见。",
        "sceneSupplementEn": "Keep the office setting clearly visible.",
        "sceneIds": [1],
    }
    values.update(overrides)
    return values


def test_database_enables_foreign_keys_and_initializes_unknown_gpu_slots(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()

    assert database.foreign_keys_enabled()
    with database.read_session() as session:
        slots = session.exec(select(GpuSlot).order_by(GpuSlot.slot)).all()
    assert [(slot.slot, slot.availability) for slot in slots] == [
        (GpuSlotName.GPU0, GpuAvailability.UNKNOWN),
        (GpuSlotName.GPU1, GpuAvailability.UNKNOWN),
    ]


def test_database_rejects_invalid_category_direction(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    with database.immediate_session() as session:
        dataset = Dataset(name="Production", name_key="production", purpose=DatasetPurpose.PRODUCTION)
        session.add(dataset)
        session.flush()
        session.add(
            BatchDraft(
                dataset_id=dataset.id,
                dataset_revision=dataset.revision,
                category=Category.A_VA,
                conflict_direction=ConflictDirection.AUDIO,
                model="LTX-2.3",
                quantity=1,
                seed_base=1,
            )
        )
        with pytest.raises(IntegrityError):
            session.flush()


def test_batch_model_precision_defaults_and_strict_combinations() -> None:
    current = BatchDraftCreate.model_validate(batch_payload())
    assert (current.model, current.precision) == (ModelName.LTX_25, Precision.INT8)

    old_model = BatchDraftCreate.model_validate(batch_payload(model="LTX-2.3"))
    assert (old_model.model, old_model.precision) == (ModelName.LTX, None)

    with pytest.raises(ValidationError, match="requires BF16 or INT8"):
        BatchDraftCreate.model_validate(batch_payload(model="LTX-2.5", precision=None))
    with pytest.raises(ValidationError, match="older models require null"):
        BatchDraftCreate.model_validate(batch_payload(model="MiniMax H3", precision="BF16"))


def test_database_rejects_invalid_model_precision_pair(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    with database.immediate_session() as session:
        dataset = Dataset(name="Production", name_key="production", purpose=DatasetPurpose.PRODUCTION)
        session.add(dataset)
        session.flush()
        session.add(
            BatchDraft(
                dataset_id=dataset.id,
                dataset_revision=dataset.revision,
                category=Category.A_VA,
                model=ModelName.LTX_25,
                precision=None,
                quantity=1,
                seed_base=1,
            )
        )
        with pytest.raises(IntegrityError):
            session.flush()


def test_clean_database_initializes_precision_schema(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()

    with database.read_session() as session:
        slots = session.exec(select(GpuSlot).order_by(GpuSlot.slot)).all()
    assert [slot.slot for slot in slots] == [GpuSlotName.GPU0, GpuSlotName.GPU1]
    with database.engine.connect() as connection:
        precision_tables = (
            "batch_drafts",
            "batch_video_input_snapshots",
            "jobs",
            "generation_attempts",
        )
        for table_name in precision_tables:
            columns = {
                row[1]
                for row in connection.exec_driver_sql(
                    f'PRAGMA table_info("{table_name}")'
                )
            }
            assert "precision" in columns
        gpu_columns = {
            row[1]
            for row in connection.exec_driver_sql('PRAGMA table_info("gpu_slots")')
        }
        sample_columns = {
            row[1]
            for row in connection.exec_driver_sql('PRAGMA table_info("samples")')
        }
        sample_ddl = connection.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'samples'"
        ).scalar_one()
    assert "loaded_precision" in gpu_columns
    assert "precision" not in sample_columns
    assert "ck_samples_model_precision" not in sample_ddl
    assert "precision" not in Sample.model_fields


@pytest.mark.parametrize(
    ("category", "direction"),
    [
        (Category.C_VA, ConflictDirection.VISION),
        (Category.C_VA, ConflictDirection.AUDIO),
        (Category.C_VT, ConflictDirection.VISION),
        (Category.C_VT, ConflictDirection.TEXT),
    ],
)
def test_content_script_accepts_protocol_directions(category: Category, direction: ConflictDirection) -> None:
    result = ContentScriptCreate.model_validate(
        content_script_payload(
            category=category,
            conflictDirection=direction,
            trueEmotion="calm",
            apparentEmotion="tense",
        )
    )
    assert result.conflict_direction is direction


def test_content_script_normalizes_emotions_before_relation_validation() -> None:
    aligned = ContentScriptCreate.model_validate(
        content_script_payload(trueEmotion=" Sadness ", apparentEmotion="sadness")
    )
    assert (aligned.true_emotion, aligned.apparent_emotion) == ("sadness", "sadness")

    with pytest.raises(ValidationError):
        ContentScriptCreate.model_validate(
            content_script_payload(
                category=Category.C_VA,
                conflictDirection=ConflictDirection.AUDIO,
                trueEmotion="Sadness",
                apparentEmotion=" sadness ",
            )
        )


@pytest.mark.parametrize(
    "field",
    [
        "nameZh",
        "nameEn",
        "sceneZh",
        "sceneEn",
        "triggerEventZh",
        "triggerEventEn",
        "psychologicalBackgroundZh",
        "psychologicalBackgroundEn",
    ],
)
def test_content_script_requires_core_bilingual_values(field: str) -> None:
    with pytest.raises(ValidationError):
        ContentScriptCreate.model_validate(content_script_payload(**{field: "   "}))


def test_content_script_allows_empty_optional_bilingual_values_for_fixed_content() -> None:
    result = ContentScriptCreate.model_validate(
        content_script_payload(
            mode=ContentMode.FIXED,
            dialogue="我会处理。",
            trueEmotionDescription="说话者保持平静并准备处理当前事件。",
            baseVideoPrompt="The subject answers while seated at a desk.",
            contentRequirementsZh="   ",
            contentRequirementsEn="   ",
            sceneSupplementZh="   ",
            sceneSupplementEn="   ",
        )
    )

    assert result.content_requirements_zh == ""
    assert result.content_requirements_en == ""
    assert result.scene_supplement_zh == ""
    assert result.scene_supplement_en == ""


@pytest.mark.parametrize("field", ["contentRequirementsZh", "contentRequirementsEn"])
def test_generative_content_requires_bilingual_content_requirements(field: str) -> None:
    with pytest.raises(ValidationError, match="Chinese and English content requirements"):
        ContentScriptCreate.model_validate(content_script_payload(**{field: "   "}))


def test_background_allows_empty_supplements_but_requires_bilingual_names_and_scenes() -> None:
    payload = {
        "nameZh": "办公室",
        "nameEn": "Office",
        "sceneZh": "一间私人办公室。",
        "sceneEn": "A private office.",
        "ambientSoundZh": "",
        "ambientSoundEn": "",
        "participantRelationshipZh": "",
        "participantRelationshipEn": "",
        "lightingZh": "",
        "lightingEn": "",
        "framingZh": "",
        "framingEn": "",
    }
    result = SceneCreate.model_validate(payload)
    assert result.ambient_sound_zh == result.ambient_sound_en == ""

    for field in ("nameZh", "nameEn", "sceneZh", "sceneEn"):
        with pytest.raises(ValidationError):
            SceneCreate.model_validate({**payload, field: "   "})


def test_content_script_rejects_removed_single_language_fields() -> None:
    with pytest.raises(ValidationError):
        ContentScriptCreate.model_validate({**content_script_payload(), "scene": "Removed field"})


@pytest.mark.parametrize(
    ("schema", "field"),
    [
        (DatasetUpdate, "name"),
        (ContentScriptUpdate, "nameZh"),
        (SceneUpdate, "ambientSoundEn"),
    ],
)
def test_catalog_updates_reject_explicit_null_for_non_nullable_fields(
    schema: type[BaseModel], field: str
) -> None:
    payload = {"expectedRevision": 1, field: None}
    if schema is ContentScriptUpdate:
        payload["sceneIds"] = [1]
    with pytest.raises(ValidationError, match="cannot be null"):
        schema.model_validate(payload)


def test_content_script_update_allows_clearing_nullable_fields() -> None:
    update = ContentScriptUpdate.model_validate(
        {"expectedRevision": 1, "sceneIds": [1], "conflictDirection": None, "dialogue": None, "displayText": None}
    )
    assert update.conflict_direction is None


def test_sqlite_uses_only_new_bilingual_catalog_columns(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()

    with database.engine.connect() as connection:
        content_columns = {
            row[1] for row in connection.exec_driver_sql("PRAGMA table_info(content_scripts)")
        }
        background_columns = {
            row[1]
            for row in connection.exec_driver_sql("PRAGMA table_info(scenes)")
        }

    assert {
        "name_zh",
        "name_en",
        "scene_zh",
        "scene_en",
        "trigger_event_zh",
        "trigger_event_en",
        "psychological_background_zh",
        "psychological_background_en",
        "content_requirements_zh",
        "content_requirements_en",
        "scene_supplement_zh",
        "scene_supplement_en",
    } <= content_columns
    assert {
        "name_zh",
        "name_en",
        "scene_zh",
        "scene_en",
        "ambient_sound_zh",
        "ambient_sound_en",
        "participant_relationship_zh",
        "participant_relationship_en",
        "lighting_zh",
        "lighting_en",
        "framing_zh",
        "framing_en",
    } <= background_columns
    assert not {
        "name",
        "name_key",
        "scene",
        "trigger_event",
        "psychological_background",
        "content_instruction",
        "scene_supplement",
    } & content_columns
    assert not {
        "name",
        "name_key",
        "scene",
        "ambient_audio",
        "relationship",
        "lighting",
        "framing_supplement",
    } & background_columns


@pytest.mark.parametrize(
    "overrides",
    [
        {"category": Category.A_VA, "trueEmotion": "calm", "apparentEmotion": "tense"},
        {
            "category": Category.C_VA,
            "conflictDirection": ConflictDirection.AUDIO,
            "trueEmotion": "calm",
            "apparentEmotion": "calm",
        },
        {
            "category": Category.C_VA,
            "conflictDirection": ConflictDirection.TEXT,
            "trueEmotion": "calm",
            "apparentEmotion": "tense",
        },
        {
            "category": Category.C_VT,
            "conflictDirection": ConflictDirection.AUDIO,
            "trueEmotion": "calm",
            "apparentEmotion": "tense",
        },
    ],
)
def test_content_script_rejects_invalid_relation_or_protocol(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ContentScriptCreate.model_validate(content_script_payload(**overrides))


@pytest.mark.parametrize(
    ("category", "direction", "true_emotion", "apparent_emotion"),
    [
        (Category.A_VA, None, "calm", "tense"),
        (Category.C_VA, ConflictDirection.AUDIO, "calm", "calm"),
        (Category.C_VA, ConflictDirection.AUDIO, "Sadness", " sadness "),
        (Category.C_VA, ConflictDirection.TEXT, "calm", "tense"),
        (Category.C_VT, ConflictDirection.AUDIO, "calm", "tense"),
    ],
)
def test_database_rejects_invalid_content_emotion_relation(
    tmp_path: Path,
    category: Category,
    direction: ConflictDirection | None,
    true_emotion: str,
    apparent_emotion: str,
) -> None:
    database = Database(tmp_path)
    database.initialize()
    with database.immediate_session() as session:
        session.add(
            ContentScript(
                name_zh="无效方案",
                name_zh_key="无效方案",
                name_en="Invalid plan",
                name_en_key="invalid plan",
                category=category,
                conflict_direction=direction,
                mode=ContentMode.GENERATIVE,
                true_emotion=true_emotion,
                apparent_emotion=apparent_emotion,
                scene_zh="一间私人办公室。",
                scene_en="A private office.",
                trigger_event_zh="计时器响起。",
                trigger_event_en="A timer sounds.",
                psychological_background_zh="被摄者准备回答。",
                psychological_background_en="The subject prepares to answer.",
                true_emotion_description="",
                content_requirements_zh="描述一名成年人在房间里作出回应。",
                content_requirements_en="Describe one adult responding in the room.",
                scene_supplement_zh="保持办公室环境清楚可见。",
                scene_supplement_en="Keep the office setting clearly visible.",
            )
        )
        with pytest.raises(IntegrityError):
            session.flush()


def test_database_rejects_content_emotion_relation_update(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    with database.immediate_session() as session:
        row = ContentScript(
            name_zh="有效方案",
            name_zh_key="有效方案",
            name_en="Valid plan",
            name_en_key="valid plan",
            category=Category.A_VA,
            mode=ContentMode.GENERATIVE,
            true_emotion="calm",
            apparent_emotion="calm",
            scene_zh="一间私人办公室。",
            scene_en="A private office.",
            trigger_event_zh="计时器响起。",
            trigger_event_en="A timer sounds.",
            psychological_background_zh="被摄者准备回答。",
            psychological_background_en="The subject prepares to answer.",
            true_emotion_description="",
            content_requirements_zh="描述一名成年人在房间里作出回应。",
            content_requirements_en="Describe one adult responding in the room.",
            scene_supplement_zh="保持办公室环境清楚可见。",
            scene_supplement_en="Keep the office setting clearly visible.",
        )
        session.add(row)
        session.flush()
        identifier = row.id

    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            session.exec(
                update(ContentScript)
                .where(ContentScript.id == identifier)
                .values(apparent_emotion="tense")
            )
