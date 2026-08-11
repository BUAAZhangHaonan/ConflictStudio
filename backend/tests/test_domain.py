from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from backend.adapters.database import Database
from backend.domain.enums import Category, ConflictDirection, DatasetPurpose, GpuAvailability, GpuSlotName
from backend.domain.models import BatchDraft, Dataset, GpuSlot


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
