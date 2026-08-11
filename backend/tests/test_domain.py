from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError
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
)
from backend.domain.models import BatchDraft, ContentPlan, Dataset, GpuSlot
from backend.domain.schemas import ContentPlanCreate


def content_plan_payload(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "name": "Plan",
        "category": Category.A_VA,
        "mode": ContentMode.GENERATIVE,
        "trueEmotion": "calm",
        "apparentEmotion": "calm",
        "scene": "A private office.",
        "triggerEvent": "A timer sounds.",
        "psychologicalBackground": "The subject prepares to answer.",
        "contentInstruction": "Describe one adult responding in the room.",
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


@pytest.mark.parametrize(
    ("category", "direction"),
    [
        (Category.C_VA, ConflictDirection.VISION),
        (Category.C_VA, ConflictDirection.AUDIO),
        (Category.C_VT, ConflictDirection.VISION),
        (Category.C_VT, ConflictDirection.TEXT),
    ],
)
def test_content_plan_accepts_protocol_directions(category: Category, direction: ConflictDirection) -> None:
    result = ContentPlanCreate.model_validate(
        content_plan_payload(
            category=category,
            conflictDirection=direction,
            trueEmotion="calm",
            apparentEmotion="tense",
        )
    )
    assert result.conflict_direction is direction


def test_content_plan_normalizes_emotions_before_relation_validation() -> None:
    aligned = ContentPlanCreate.model_validate(
        content_plan_payload(trueEmotion=" Sadness ", apparentEmotion="sadness")
    )
    assert (aligned.true_emotion, aligned.apparent_emotion) == ("sadness", "sadness")

    with pytest.raises(ValidationError):
        ContentPlanCreate.model_validate(
            content_plan_payload(
                category=Category.C_VA,
                conflictDirection=ConflictDirection.AUDIO,
                trueEmotion="Sadness",
                apparentEmotion=" sadness ",
            )
        )


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
def test_content_plan_rejects_invalid_relation_or_protocol(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ContentPlanCreate.model_validate(content_plan_payload(**overrides))


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
            ContentPlan(
                name="Invalid plan",
                name_key="invalid plan",
                category=category,
                conflict_direction=direction,
                mode=ContentMode.GENERATIVE,
                true_emotion=true_emotion,
                apparent_emotion=apparent_emotion,
                scene="A private office.",
                trigger_event="A timer sounds.",
                psychological_background="The subject prepares to answer.",
                true_emotion_description="",
                content_instruction="Describe one adult responding in the room.",
            )
        )
        with pytest.raises(IntegrityError):
            session.flush()


def test_database_rejects_content_emotion_relation_update(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    with database.immediate_session() as session:
        row = ContentPlan(
            name="Valid plan",
            name_key="valid plan",
            category=Category.A_VA,
            mode=ContentMode.GENERATIVE,
            true_emotion="calm",
            apparent_emotion="calm",
            scene="A private office.",
            trigger_event="A timer sounds.",
            psychological_background="The subject prepares to answer.",
            true_emotion_description="",
            content_instruction="Describe one adult responding in the room.",
        )
        session.add(row)
        session.flush()
        identifier = row.id

    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            session.exec(
                update(ContentPlan)
                .where(ContentPlan.id == identifier)
                .values(apparent_emotion="tense")
            )
