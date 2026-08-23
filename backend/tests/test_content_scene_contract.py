import asyncio
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError

from backend.adapters.database import Database
from backend.adapters.llm import OpenAICompatiblePromptModel
from backend.domain.enums import Category, ContentMode, ContentStatus, DatasetPurpose, Ethnicity, Gender, GpuSlotName, ModelName, ResourceStatus, TemplateVersionStatus
from backend.domain.models import BatchDraftCombination, ContentScriptScene, Dataset, PromptTemplateVersion
from backend.domain.schemas import (
    BatchContentSelectionInput,
    BatchDraftCreate,
    ContentScriptCreate,
    ContentScriptUpdate,
    DemographicInput,
    DatasetUpdate,
    SceneCreate,
    PromptTemplateVersionCreate,
    PromptTemplateCreate,
)
from backend.services.batches import BatchService
from backend.services.errors import ServiceError
from backend.services.prompts import PromptService
from backend.tests.test_generation_services import _ConfiguredRendererGateway, fixed_resources
from backend.tests.support import mark_prompt_version_verified


def _generative_content(catalog, scene_ids: list[int]) -> object:  # type: ignore[no-untyped-def]
    return catalog.create_content_script(
        ContentScriptCreate(
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
            sceneIds=scene_ids,
        )
    )


def test_content_and_mapping_update_is_revisioned_atomic_and_database_constrained(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, _, content, _, scene = fixed_resources(database)

    with pytest.raises(ServiceError) as missing:
        catalog.update_content_script(
            content.id,
            ContentScriptUpdate(
                expectedRevision=content.revision,
                sceneIds=[99999],
            ),
        )
    assert missing.value.status_code == 404
    current = catalog.get_content_scenes(content.id)
    assert current.content_script_revision == content.revision
    assert [row.id for row in current.scenes] == [scene.id]

    with pytest.raises(ValidationError):
        ContentScriptCreate(
            **{
                **content.model_dump(exclude={"id", "revision", "created_at", "updated_at", "scene_ids"}),
                "sceneIds": [scene.id, 99999],
            }
        )

    with pytest.raises(ServiceError) as stale:
        catalog.update_content_script(
            content.id,
            ContentScriptUpdate(
                expectedRevision=content.revision + 1,
                sceneIds=[scene.id],
            ),
        )
    assert stale.value.status_code == 409

    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            session.add(
                ContentScriptScene(
                    content_script_id=content.id,
                    scene_id=scene.id,
                    position=1,
                )
            )
            session.flush()
    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            session.add(
                ContentScriptScene(
                    content_script_id=99999,
                    scene_id=scene.id,
                    position=0,
                )
            )
            session.flush()


def test_fixed_scene_is_automatic_and_generative_uses_only_registered_choices(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, fixed_content, template_version, first = fixed_resources(database)
    second = catalog.create_scene(
        SceneCreate(
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
    content = _generative_content(catalog, [first.id, second.id])
    assert content.scene_ids == [first.id, second.id]

    service = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    common = dict(
        targetDatasetId=dataset.id,
        category=Category.A_VA,
        model=ModelName.LTX,
        promptTemplateVersionId=template_version.id,
        demographics=[
            DemographicInput(
                age=25,
                gender=Gender.FEMALE,
                ethnicity=Ethnicity.EAST_ASIAN,
            )
        ],
        gpuSlots=[GpuSlotName.GPU0],
        seeds=[7, 8],
    )
    fixed = service.create_batch_draft(
        BatchDraftCreate(
            contentSelections=[
                BatchContentSelectionInput(contentScriptId=fixed_content.id)
            ],
            **common,
        )
    )
    fixed_preview = asyncio.run(service.preview_batch(fixed.id, fixed.revision))
    assert {row.scene.id for row in fixed_preview.allocations} == {first.id}

    generative = service.create_batch_draft(
        BatchDraftCreate(
            contentSelections=[
                BatchContentSelectionInput(
                    contentScriptId=content.id,
                    sceneIds=[first.id, second.id],
                )
            ],
            **common,
        )
    )
    preview = asyncio.run(service.preview_batch(generative.id, generative.revision))
    assert [row.scene.id for row in preview.allocations] == [
        first.id,
        second.id,
        first.id,
        second.id,
    ]
    assert [row.seed for row in preview.allocations] == [7, 7, 8, 8]

    with pytest.raises(ServiceError) as fixed_explicit:
        service.create_batch_draft(
            BatchDraftCreate(
                contentSelections=[
                    BatchContentSelectionInput(
                        contentScriptId=fixed_content.id,
                        sceneIds=[first.id],
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
                    BatchContentSelectionInput(contentScriptId=content.id)
                ],
                **common,
            )
        )
    assert generative_empty.value.status_code == 422

    third = catalog.create_scene(
        SceneCreate(
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
                        contentScriptId=content.id,
                        sceneIds=[third.id],
                    )
                ],
                **common,
            )
        )
    assert incompatible.value.status_code == 422


def test_mode_switch_and_scene_mapping_commit_together(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, _, _, _, first = fixed_resources(database)
    second = catalog.create_scene(
        SceneCreate(
            nameZh="第二场景",
            nameEn="Second scene",
            sceneZh="一间安静的候车室。",
            sceneEn="A quiet waiting room.",
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
    content = _generative_content(catalog, [first.id, second.id])

    with pytest.raises(ServiceError) as invalid:
        catalog.update_content_script(
            content.id,
            ContentScriptUpdate(
                expectedRevision=content.revision,
                mode=ContentMode.FIXED,
                baseVideoPrompt="An adult answers in a quiet room.",
                dialogue="我知道了。",
                trueEmotionDescription="说话内容和可见表现保持一致。",
                sceneIds=[first.id, second.id],
            ),
        )
    assert invalid.value.status_code == 422
    unchanged = catalog.get_content_script(content.id)
    assert unchanged.mode is ContentMode.GENERATIVE
    assert unchanged.revision == content.revision
    assert unchanged.scene_ids == [first.id, second.id]

    fixed = catalog.update_content_script(
        content.id,
        ContentScriptUpdate(
            expectedRevision=content.revision,
            mode=ContentMode.FIXED,
            baseVideoPrompt="An adult answers in a quiet room.",
            dialogue="我知道了。",
            trueEmotionDescription="说话内容和可见表现保持一致。",
            sceneIds=[first.id],
        ),
    )
    assert fixed.mode is ContentMode.FIXED
    assert fixed.scene_ids == [first.id]

    generative = catalog.update_content_script(
        content.id,
        ContentScriptUpdate(
            expectedRevision=fixed.revision,
            mode=ContentMode.GENERATIVE,
            sceneIds=[first.id, second.id],
        ),
    )
    assert generative.mode is ContentMode.GENERATIVE
    assert generative.scene_ids == [first.id, second.id]


def test_formal_batch_rejects_inactive_and_nonformal_datasets(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content, template_version, _ = fixed_resources(database)
    service = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    payload = BatchDraftCreate(
        targetDatasetId=dataset.id,
        category=Category.A_VA,
        model=ModelName.LTX,
        contentSelections=[BatchContentSelectionInput(contentScriptId=content.id)],
        promptTemplateVersionId=template_version.id,
        demographics=[
            DemographicInput(
                age=25,
                gender=Gender.FEMALE,
                ethnicity=Ethnicity.EAST_ASIAN,
            )
        ],
        gpuSlots=[GpuSlotName.GPU0],
        seeds=[7],
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


def test_incomplete_migrated_draft_cannot_be_previewed(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    _, dataset, content, template_version, _ = fixed_resources(database)
    service = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    draft = service.create_batch_draft(
        BatchDraftCreate(
            targetDatasetId=dataset.id,
            category=Category.A_VA,
            model=ModelName.LTX,
            contentSelections=[BatchContentSelectionInput(contentScriptId=content.id)],
            promptTemplateVersionId=template_version.id,
            demographics=[
                DemographicInput(
                    age=25,
                    gender=Gender.FEMALE,
                    ethnicity=Ethnicity.EAST_ASIAN,
                )
            ],
            gpuSlots=[GpuSlotName.GPU0],
            seeds=[7],
        )
    )
    with database.immediate_session() as session:
        session.exec(
            delete(BatchDraftCombination).where(
                BatchDraftCombination.batch_draft_id == draft.id
            )
        )

    with pytest.raises(ServiceError, match="incomplete source selections") as incomplete:
        asyncio.run(service.preview_batch(draft.id, draft.revision))
    assert incomplete.value.status_code == 409


def test_template_versions_are_immutable_and_formal_batches_require_verified(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content, _, _ = fixed_resources(database)
    template = catalog.create_prompt_template(
        PromptTemplateCreate(
            name="Draft Natural Interior",
            category=Category.A_VA,
        )
    )
    draft_version = catalog.create_prompt_template_version(
        template.id,
        PromptTemplateVersionCreate(
            expectedTemplateRevision=template.revision,
            styleGuidance="Use restrained natural performance.",
            positiveExamples=["Keep behavior visible."],
            negativeExamples=["Do not name emotions."],
            ltxNegativePrompt="subtitles, captions",
            h3NegativePrompt="subtitles, captions, visual artifacts",
        )
    )
    service = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    payload = BatchDraftCreate(
        targetDatasetId=dataset.id,
        category=Category.A_VA,
        model=ModelName.LTX,
        contentSelections=[
            BatchContentSelectionInput(contentScriptId=content.id)
        ],
        promptTemplateVersionId=draft_version.id,
        demographics=[
            DemographicInput(
                age=25,
                gender=Gender.FEMALE,
                ethnicity=Ethnicity.EAST_ASIAN,
            )
        ],
        gpuSlots=[GpuSlotName.GPU0],
        seeds=[7],
    )
    with pytest.raises(ServiceError) as unverified:
        service.create_batch_draft(payload)
    assert unverified.value.status_code == 422

    mark_prompt_version_verified(database, draft_version.id)
    verified = catalog.get_prompt_template_version(draft_version.id)
    assert verified.verification_status is TemplateVersionStatus.VERIFIED
    created = service.create_batch_draft(payload)
    assert created.prompt_template_version.id == verified.id

    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            row = session.get(PromptTemplateVersion, verified.id)
            assert row is not None
            row.style_instruction = "Changed after verification"
            session.flush()


def test_sqlite_rejects_invalid_direct_batch_submission(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content, verified, _ = fixed_resources(database)
    service = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    payload = BatchDraftCreate(
        targetDatasetId=dataset.id,
        category=Category.A_VA,
        model=ModelName.LTX,
        contentSelections=[BatchContentSelectionInput(contentScriptId=content.id)],
        promptTemplateVersionId=verified.id,
        demographics=[
            DemographicInput(
                age=25,
                gender=Gender.FEMALE,
                ethnicity=Ethnicity.EAST_ASIAN,
            )
        ],
        gpuSlots=[GpuSlotName.GPU0],
        seeds=[7],
    )
    draft = service.create_batch_draft(payload)

    with pytest.raises(IntegrityError, match="current compatible active sources"):
        with database.engine.begin() as connection:
            connection.exec_driver_sql(
                "UPDATE batch_draft_combinations "
                "SET content_script_revision = content_script_revision + 1 "
                "WHERE batch_draft_id = ?",
                (draft.id,),
            )

    with database.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE datasets SET status = 'Inactive' WHERE id = ?",
            (dataset.id,),
        )
    with pytest.raises(IntegrityError, match="complete draft"):
        with database.engine.begin() as connection:
            connection.exec_driver_sql(
                "UPDATE batch_drafts SET status = 'Submitted', revision = revision + 1 "
                "WHERE id = ?",
                (draft.id,),
            )
    with database.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE datasets SET status = 'Active' WHERE id = ?",
            (dataset.id,),
        )

    draft_template = catalog.create_prompt_template(
        PromptTemplateCreate(name="Unverified direct selection", category=Category.A_VA)
    )
    draft_version = catalog.create_prompt_template_version(
        draft_template.id,
        PromptTemplateVersionCreate(
            expectedTemplateRevision=draft_template.revision,
            styleGuidance="Use a restrained static shot.",
            ltxNegativePrompt="subtitles",
            h3NegativePrompt="subtitles",
        ),
    )
    with database.engine.begin() as connection:
        connection.exec_driver_sql(
            "UPDATE batch_draft_prompt_template_versions "
            "SET prompt_template_version_id = ?, source_revision = ? "
            "WHERE batch_draft_id = ?",
            (draft_version.id, draft_version.revision, draft.id),
        )
    with pytest.raises(IntegrityError, match="complete draft"):
        with database.engine.begin() as connection:
            connection.exec_driver_sql(
                "UPDATE batch_drafts SET status = 'Submitted', revision = revision + 1 "
                "WHERE id = ?",
                (draft.id,),
            )
