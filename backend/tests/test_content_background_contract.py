import asyncio
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError

from backend.adapters.database import Database
from backend.adapters.llm import OpenAICompatiblePromptModel
from backend.domain.enums import Category, ContentMode, ContentStatus, DatasetPurpose, Ethnicity, Gender, GpuSlotName, ModelName, ResourceStatus
from backend.domain.models import ContentPlanBackground, Dataset
from backend.domain.schemas import (
    BatchContentSelectionInput,
    BatchDraftCreate,
    ContentPlanBackgroundReplace,
    ContentPlanCreate,
    DemographicInput,
    DatasetUpdate,
    VideoBackgroundPresetCreate,
)
from backend.services.batches import BatchService
from backend.services.errors import ServiceError
from backend.services.prompts import PromptService
from backend.tests.test_generation_services import _ConfiguredRendererGateway, fixed_resources


def _generative_content(catalog) -> object:  # type: ignore[no-untyped-def]
    return catalog.create_content_plan(
        ContentPlanCreate(
            nameZh="生成式回应",
            nameEn="Generative response",
            category=Category.A_VA,
            mode=ContentMode.GENERATIVE,
            status=ContentStatus.ACTIVE,
            trueEmotion="calm",
            apparentEmotion="calm",
            sceneZh="一间私人办公室。",
            sceneEn="A private office.",
            triggerEventZh="计时器响起。",
            triggerEventEn="A timer sounds.",
            psychologicalBackgroundZh="被摄者准备回答。",
            psychologicalBackgroundEn="The subject prepares to answer.",
            contentRequirementsZh="描述一名成年人作出简短回应。",
            contentRequirementsEn="Describe one adult giving a brief response.",
            sceneSupplementZh="",
            sceneSupplementEn="",
        )
    )


def test_mapping_replace_is_revisioned_atomic_and_database_constrained(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, _, content, _, background = fixed_resources(database)

    with pytest.raises(ServiceError) as missing:
        catalog.replace_content_backgrounds(
            content.id,
            ContentPlanBackgroundReplace(
                expectedRevision=content.revision,
                backgroundPresetIds=[99999],
            ),
        )
    assert missing.value.status_code == 404
    current = catalog.get_content_backgrounds(content.id)
    assert current.content_plan_revision == content.revision
    assert [row.id for row in current.backgrounds] == [background.id]

    with pytest.raises(ServiceError) as fixed_many:
        catalog.replace_content_backgrounds(
            content.id,
            ContentPlanBackgroundReplace(
                expectedRevision=content.revision,
                backgroundPresetIds=[background.id, 99999],
            ),
        )
    assert fixed_many.value.status_code == 422

    with pytest.raises(ServiceError) as stale:
        catalog.replace_content_backgrounds(
            content.id,
            ContentPlanBackgroundReplace(
                expectedRevision=1,
                backgroundPresetIds=[background.id],
            ),
        )
    assert stale.value.status_code == 409

    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            session.add(
                ContentPlanBackground(
                    content_plan_id=content.id,
                    background_preset_id=background.id,
                    position=1,
                )
            )
            session.flush()
    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            session.add(
                ContentPlanBackground(
                    content_plan_id=99999,
                    background_preset_id=background.id,
                    position=0,
                )
            )
            session.flush()


def test_fixed_background_is_automatic_and_generative_uses_only_registered_choices(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, fixed_content, preset, first = fixed_resources(database)
    second = catalog.create_background_preset(
        VideoBackgroundPresetCreate(
            nameZh="候车室",
            nameEn="Waiting room",
            sceneZh="一间安静的候车室。",
            sceneEn="A quiet waiting room.",
            ambientSoundZh="稳定的通风声。",
            ambientSoundEn="A steady ventilation hum.",
            participantRelationshipZh="画面中只有被摄者。",
            participantRelationshipEn="The subject is alone.",
            lightingZh="柔和顶灯。",
            lightingEn="Soft overhead light.",
            framingZh="静止中景。",
            framingEn="A static medium shot.",
        )
    )
    content = _generative_content(catalog)
    mapped = catalog.replace_content_backgrounds(
        content.id,
        ContentPlanBackgroundReplace(
            expectedRevision=content.revision,
            backgroundPresetIds=[first.id, second.id],
        ),
    )
    content = catalog.get_content_plan(content.id)
    assert [row.id for row in mapped.backgrounds] == [first.id, second.id]

    service = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    common = dict(
        targetDatasetId=dataset.id,
        category=Category.A_VA,
        model=ModelName.LTX,
        quantity=2,
        seed=7,
        promptPresetId=preset.id,
        demographics=[
            DemographicInput(
                age=25,
                gender=Gender.FEMALE,
                ethnicity=Ethnicity.EAST_ASIAN,
            )
        ],
        gpuSlots=[GpuSlotName.GPU0],
    )
    fixed = service.create_batch_draft(
        BatchDraftCreate(
            contentSelections=[
                BatchContentSelectionInput(contentPlanId=fixed_content.id)
            ],
            **common,
        )
    )
    fixed_preview = asyncio.run(service.preview_batch(fixed.id, fixed.revision))
    assert {row.background_preset.id for row in fixed_preview.allocations} == {first.id}

    generative = service.create_batch_draft(
        BatchDraftCreate(
            contentSelections=[
                BatchContentSelectionInput(
                    contentPlanId=content.id,
                    backgroundPresetIds=[first.id, second.id],
                )
            ],
            **common,
        )
    )
    preview = asyncio.run(service.preview_batch(generative.id, generative.revision))
    assert [row.background_preset.id for row in preview.allocations] == [first.id, second.id]

    with pytest.raises(ServiceError) as fixed_explicit:
        service.create_batch_draft(
            BatchDraftCreate(
                contentSelections=[
                    BatchContentSelectionInput(
                        contentPlanId=fixed_content.id,
                        backgroundPresetIds=[first.id],
                    )
                ],
                **common,
            )
        )
    assert fixed_explicit.value.status_code == 422

    with pytest.raises(ServiceError) as generative_empty:
        service.create_batch_draft(
            BatchDraftCreate(
                contentSelections=[
                    BatchContentSelectionInput(contentPlanId=content.id)
                ],
                **common,
            )
        )
    assert generative_empty.value.status_code == 422

    third = catalog.create_background_preset(
        VideoBackgroundPresetCreate(
            nameZh="会议室",
            nameEn="Meeting room",
            sceneZh="一间小会议室。",
            sceneEn="A small meeting room.",
            ambientSoundZh="",
            ambientSoundEn="",
            participantRelationshipZh="",
            participantRelationshipEn="",
            lightingZh="",
            lightingEn="",
            framingZh="",
            framingEn="",
        )
    )
    with pytest.raises(ServiceError) as incompatible:
        service.create_batch_draft(
            BatchDraftCreate(
                contentSelections=[
                    BatchContentSelectionInput(
                        contentPlanId=content.id,
                        backgroundPresetIds=[third.id],
                    )
                ],
                **common,
            )
        )
    assert incompatible.value.status_code == 422


def test_formal_batch_rejects_inactive_and_nonformal_datasets(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content, preset, _ = fixed_resources(database)
    service = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    payload = BatchDraftCreate(
        targetDatasetId=dataset.id,
        category=Category.A_VA,
        model=ModelName.LTX,
        quantity=1,
        seed=7,
        contentSelections=[BatchContentSelectionInput(contentPlanId=content.id)],
        promptPresetId=preset.id,
        demographics=[
            DemographicInput(
                age=25,
                gender=Gender.FEMALE,
                ethnicity=Ethnicity.EAST_ASIAN,
            )
        ],
        gpuSlots=[GpuSlotName.GPU0],
    )
    catalog.update_dataset(
        dataset.id,
        DatasetUpdate(expectedRevision=dataset.revision, status=ResourceStatus.INACTIVE),
    )
    with pytest.raises(ServiceError) as inactive:
        service.create_batch_draft(payload)
    assert inactive.value.status_code == 422

    with database.immediate_session() as session:
        row = session.get(Dataset, dataset.id)
        assert row is not None
        row.status = ResourceStatus.ACTIVE
        row.purpose = DatasetPurpose.VALIDATION
        row.revision += 1
    with pytest.raises(ServiceError) as nonformal:
        service.create_batch_draft(payload)
    assert nonformal.value.status_code == 422
