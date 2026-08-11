from __future__ import annotations

import asyncio
import json
from itertools import product
from pathlib import Path

import httpx
import pytest
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from backend.adapters.database import Database
from backend.adapters.llm import OpenAICompatiblePromptModel
from backend.domain.enums import (
    Category,
    ContentMode,
    ContentStatus,
    DatasetPurpose,
    Ethnicity,
    Gender,
    GpuAvailability,
    GpuSlotName,
    ModelName,
)
from backend.domain.models import BatchVideoInputSnapshot, GpuSlot, Job, RENDERER_PROFILE_VERSION
from backend.domain.schemas import (
    BatchDraftCreate,
    BatchSubmitRequest,
    ContentPlanCreate,
    DatasetCreate,
    DatasetUpdate,
    DemographicInput,
    PromptPresetCreate,
    SourceSelection,
    VideoBackgroundPresetCreate,
)
from backend.services.batches import BatchService
from backend.services.catalog import CatalogService
from backend.services.errors import ServiceError
from backend.services.prompts import PromptContext, PromptService


def fixed_resources(database: Database) -> tuple[CatalogService, object, object, object, object]:
    catalog = CatalogService(database)
    dataset = catalog.create_dataset(
        DatasetCreate(name="正式生成集", purpose=DatasetPurpose.PRODUCTION, note="第一批真实生成")
    )
    content = catalog.create_content_plan(
        ContentPlanCreate(
            name="克制回应",
            category=Category.A_VA,
            mode=ContentMode.FIXED,
            status=ContentStatus.ACTIVE,
            trueEmotion="sadness",
            apparentEmotion="sadness",
            scene="A quiet office after a difficult meeting.",
            triggerEvent="The subject is asked whether everything is fine.",
            psychologicalBackground="The subject does not want to worry a colleague.",
            dialogue="我没事，只是需要一点时间。",
            trueEmotionDescription="说话者在克制悲伤，语言和可见表现保持一致。",
            baseVideoPrompt="A restrained adult sits at a desk and answers a colleague with a steady but tired expression.",
        )
    )
    preset = catalog.create_prompt_preset(
        PromptPresetCreate(
            name="自然室内",
            category=Category.A_VA,
            styleInstruction="Use restrained natural performance and a static medium shot.",
            sceneSupplement="Keep the room visually simple.",
            positiveExamples=["Observable behavior is specific and physically plausible."],
            negativeExamples=["Do not name the target emotion."],
            finalNegativePrompt="subtitles, captions, exaggerated acting, camera shake",
        )
    )
    background = catalog.create_background_preset(
        VideoBackgroundPresetCreate(
            name="安静办公室",
            scene="A small private office with a desk and neutral walls.",
            ambientAudio="Low room tone and distant ventilation.",
            relationship="The subject remains the only occupant in view.",
            lighting="Soft daylight from one side.",
            framingSupplement="Static eye-level medium shot.",
        )
    )
    return catalog, dataset, content, preset, background


def make_batch(
    service: BatchService,
    dataset: object,
    content: object,
    preset: object,
    background: object,
    slots: list[GpuSlotName],
    quantity: int = 4,
):
    return service.create_batch_draft(
        BatchDraftCreate(
            datasetId=dataset.id,
            category=Category.A_VA,
            model=ModelName.LTX,
            quantity=quantity,
            seed=1208,
            contentPlans=[SourceSelection(id=content.id, expectedRevision=content.revision)],
            promptPresets=[SourceSelection(id=preset.id, expectedRevision=preset.revision)],
            backgroundPresets=[SourceSelection(id=background.id, expectedRevision=background.revision)],
            demographics=[
                DemographicInput(age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.EAST_ASIAN),
                DemographicInput(age=35, gender=Gender.MALE, ethnicity=Ethnicity.WHITE),
            ],
            gpuSlots=slots,
        )
    )


def test_catalog_persists_records_and_rejects_stale_revision(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content, _, _ = fixed_resources(database)

    updated = catalog.update_dataset(
        dataset.id,
        DatasetUpdate(expectedRevision=dataset.revision, note="已更新"),
    )
    assert updated.revision == 2
    with pytest.raises(ServiceError, match="changed") as error:
        catalog.update_dataset(dataset.id, DatasetUpdate(expectedRevision=1, note="过期写入"))
    assert error.value.code == "revision_conflict"

    with pytest.raises(ServiceError) as delete_error:
        catalog.delete_content_plan(content.id, content.revision)
    assert delete_error.value.code == "state_conflict"

    reopened = Database(tmp_path)
    reopened.initialize()
    assert reopened.database_path.is_file()
    assert reopened and CatalogService(reopened).list_datasets()[0].note == "已更新"


def test_fixed_prompt_keeps_examples_out_of_final_video_input(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    _, _, content_read, preset_read, background_read = fixed_resources(database)
    with database.read_session() as session:
        from backend.domain.models import ContentPlan, PromptPreset, VideoBackgroundPreset

        content = session.get(ContentPlan, content_read.id)
        preset = session.get(PromptPreset, preset_read.id)
        background = session.get(VideoBackgroundPreset, background_read.id)
        service = PromptService(OpenAICompatiblePromptModel("https://example.invalid/v1", "test"))
        prepared = service.prepare(
            PromptContext(
                content=content,
                preset=preset,
                positive_examples=preset_read.positive_examples,
                negative_examples=preset_read.negative_examples,
                background=background,
                age=25,
                gender=Gender.FEMALE,
                ethnicity=Ethnicity.EAST_ASIAN,
            )
        )
    result = asyncio.run(service.complete(prepared, Category.A_VA))

    assert "Observable behavior" in result.user_input
    assert "Do not name" in result.user_input
    assert "Observable behavior" not in result.final_positive_prompt
    assert "Do not name" not in result.final_positive_prompt
    assert result.dialogue == "我没事，只是需要一点时间。"
    assert result.final_negative_prompt == "subtitles, captions, exaggerated acting, camera shake"


def test_generative_prompt_uses_one_strict_deepseek_request(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, _, _, _, background_read = fixed_resources(database)
    content_read = catalog.create_content_plan(
        ContentPlanCreate(
            name="生成式冲突",
            category=Category.C_VA,
            conflictDirection="Audio",
            mode=ContentMode.GENERATIVE,
            status=ContentStatus.ACTIVE,
            trueEmotion="relief",
            apparentEmotion="worry",
            scene="A clinic waiting area.",
            triggerEvent="A call has just ended.",
            psychologicalBackground="The subject hides good news.",
            contentInstruction="Create subtle conflicting visual and vocal evidence.",
        )
    )
    preset_read = catalog.create_prompt_preset(
        PromptPresetCreate(
            name="冲突预设",
            category=Category.C_VA,
            positiveExamples=["Good writing example"],
            negativeExamples=["Bad writing example"],
            finalNegativePrompt="subtitles, exaggerated movement",
        )
    )
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "positivePrompt": (
                                        "An East Asian woman in a charcoal jacket keeps her dark hair neatly tucked "
                                        "behind one ear. She sits upright, folds both hands on her lap, presses her "
                                        "lips together, and raises her chin while her gaze stays level. She says "
                                        "\"结果出来了，没什么需要担心的。\" in a low steady voice as the ventilation "
                                        "hums softly and a wall clock ticks at an even pace. The private office has "
                                        "pale walls, a bare wooden table, and one closed window behind her stool. The "
                                        "camera holds a static eye-level medium shot with a slow, almost imperceptible "
                                        "push inward. Soft daylight falls from the left, leaving a narrow shadow along "
                                        "her jaw and gentle highlights across the jacket fabric."
                                    ),
                                    "dialogue": "结果出来了，没什么需要担心的。",
                                    "vtText": None,
                                    "trueEmotionDescription": "声音中的放松表达真实情感，视觉表现仍显得担忧。",
                                },
                                ensure_ascii=False,
                            )
                        }
                    }
                ]
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatiblePromptModel("https://llm.example/v1", "test-key", client)
    service = PromptService(model)
    with database.read_session() as session:
        from backend.domain.models import ContentPlan, PromptPreset, VideoBackgroundPreset

        prepared = service.prepare(
            PromptContext(
                content=session.get(ContentPlan, content_read.id),
                preset=session.get(PromptPreset, preset_read.id),
                positive_examples=preset_read.positive_examples,
                negative_examples=preset_read.negative_examples,
                background=session.get(VideoBackgroundPreset, background_read.id),
                age=45,
                gender=Gender.MALE,
                ethnicity=Ethnicity.BLACK,
            )
        )
    result = asyncio.run(service.complete(prepared, Category.C_VA))
    asyncio.run(client.aclose())

    assert len(calls) == 1
    assert calls[0]["model"] == "deepseek-v4-flash"
    assert calls[0]["response_format"] == {"type": "json_object"}
    assert "Good writing example" in prepared.user_input
    assert "Bad writing example" not in result.final_positive_prompt


def test_preview_rotates_backgrounds_and_unknown_gpu_blocks_submit(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content, preset, background = fixed_resources(database)
    second = catalog.create_background_preset(
        VideoBackgroundPresetCreate(name="候车室", scene="A quiet station waiting room.")
    )
    prompt_service = PromptService(OpenAICompatiblePromptModel("https://example.invalid/v1", "test"))
    batches = BatchService(database, prompt_service)
    draft = batches.create_batch_draft(
        BatchDraftCreate(
            datasetId=dataset.id,
            category=Category.A_VA,
            model=ModelName.LTX,
            quantity=4,
            seed=7,
            contentPlans=[SourceSelection(id=content.id, expectedRevision=content.revision)],
            promptPresets=[SourceSelection(id=preset.id, expectedRevision=preset.revision)],
            backgroundPresets=[
                SourceSelection(id=background.id, expectedRevision=background.revision),
                SourceSelection(id=second.id, expectedRevision=second.revision),
            ],
            demographics=[DemographicInput(age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.LATINO)],
            gpuSlots=[GpuSlotName.GPU0],
        )
    )
    preview = batches.preview_batch(draft.id, draft.revision)
    assert [item.background_preset.id for item in preview.allocations] == [background.id, second.id] * 2

    with pytest.raises(ServiceError) as error:
        asyncio.run(
            batches.submit_batch(
                draft.id,
                BatchSubmitRequest(
                    expectedRevision=draft.revision,
                    expectedGpuRevisions=preview.gpu_revisions,
                ),
            )
        )
    assert error.value.code == "gpu_unavailable"
    with database.read_session() as session:
        assert session.exec(select(Job)).all() == []
        assert session.exec(select(BatchVideoInputSnapshot)).all() == []


def test_dual_gpu_submit_is_atomic_and_snapshots_survive_restart(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    _, dataset, content, preset, background = fixed_resources(database)
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("https://example.invalid/v1", "test")),
    )
    draft = make_batch(
        batches,
        dataset,
        content,
        preset,
        background,
        [GpuSlotName.GPU0, GpuSlotName.GPU1],
    )
    with database.immediate_session() as session:
        for row in session.exec(select(GpuSlot)).all():
            row.availability = GpuAvailability.AVAILABLE
            row.revision += 1
    preview = batches.preview_batch(draft.id, draft.revision)
    job = asyncio.run(
        batches.submit_batch(
            draft.id,
            BatchSubmitRequest(
                expectedRevision=draft.revision,
                expectedGpuRevisions=preview.gpu_revisions,
            ),
        )
    )

    assert [item.gpu_slot for item in job.items] == [
        GpuSlotName.GPU0,
        GpuSlotName.GPU1,
        GpuSlotName.GPU0,
        GpuSlotName.GPU1,
    ]
    assert len({item.input.seed for item in job.items}) == 4
    first_input = job.items[0].input
    first_preview = preview.allocations[0]
    assert (first_input.dataset_id, first_input.dataset_revision) == (dataset.id, dataset.revision)
    assert (first_input.content_plan_id, first_input.content_plan_revision) == (content.id, content.revision)
    assert (first_input.prompt_preset_id, first_input.prompt_preset_revision) == (preset.id, preset.revision)
    assert (first_input.background_preset_id, first_input.background_preset_revision) == (
        background.id,
        background.revision,
    )
    assert (first_input.age, first_input.gender, first_input.ethnicity) == (
        first_preview.demographic.age,
        first_preview.demographic.gender,
        first_preview.demographic.ethnicity,
    )
    assert (first_input.width, first_input.height, first_input.fps, first_input.frame_count) == (1344, 768, 24, 121)
    assert first_input.renderer_profile_version == RENDERER_PROFILE_VERSION
    assert first_input.prompt_model == "deepseek-v4-flash"
    assert first_input.source_has_audio is True
    assert first_input.derive_silent_primary is False
    assert first_input.final_positive_prompt == first_preview.final_positive_prompt
    assert first_input.final_negative_prompt == first_preview.final_negative_prompt
    assert first_input.seed == first_preview.seed
    assert first_input.model is ModelName.LTX
    with database.read_session() as session:
        slots = session.exec(select(GpuSlot).order_by(GpuSlot.slot)).all()
        assert all(slot.availability is GpuAvailability.RESERVED for slot in slots)
        snapshot_id = job.items[0].input.id
    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            session.exec(
                update(BatchVideoInputSnapshot)
                .where(BatchVideoInputSnapshot.id == snapshot_id)
                .values(final_positive_prompt="changed")
            )
    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            snapshot = session.get(BatchVideoInputSnapshot, snapshot_id)
            assert snapshot is not None
            session.delete(snapshot)

    reopened = Database(tmp_path)
    reopened.initialize()
    restored = BatchService(
        reopened,
        PromptService(OpenAICompatiblePromptModel("https://example.invalid/v1", "test")),
    ).get_job(job.id)
    assert len(restored.items) == 4
    assert restored.items[0].input.final_positive_prompt == job.items[0].input.final_positive_prompt


def test_cartesian_preview_and_submit_cover_all_dimensions_in_order(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content_one, preset_one, background_one = fixed_resources(database)
    content_two = catalog.create_content_plan(
        ContentPlanCreate(
            name="一致回应二",
            category=Category.A_VA,
            mode=ContentMode.FIXED,
            status=ContentStatus.ACTIVE,
            trueEmotion="sadness",
            apparentEmotion="sadness",
            scene="A quiet office after a difficult meeting.",
            triggerEvent="The subject is asked whether everything is fine.",
            psychologicalBackground="The subject wants to keep the answer brief.",
            dialogue="我没事，只是需要一点时间。",
            trueEmotionDescription="说话者在克制悲伤，语言和可见表现保持一致。",
            baseVideoPrompt=(
                "A restrained adult sits at a desk and answers a direct question with a steady but tired expression."
            ),
        )
    )
    preset_two = catalog.create_prompt_preset(
        PromptPresetCreate(
            name="自然室内二",
            category=Category.A_VA,
            styleInstruction="Use restrained natural performance and a static medium shot.",
            sceneSupplement="Keep the room visually simple.",
            finalNegativePrompt="subtitles, captions, exaggerated acting, camera shake",
        )
    )
    background_two = catalog.create_background_preset(
        VideoBackgroundPresetCreate(
            name="安静办公室二",
            scene="A compact private office with a desk and neutral walls.",
            ambientAudio="Low room tone and distant ventilation.",
            relationship="The subject remains the only occupant in view.",
            lighting="Soft daylight from one side.",
            framingSupplement="Static eye-level medium shot.",
        )
    )
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("https://example.invalid/v1", "test")),
    )
    demographics = [
        DemographicInput(age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.EAST_ASIAN),
        DemographicInput(age=35, gender=Gender.MALE, ethnicity=Ethnicity.WHITE),
    ]
    selections = {
        "datasetId": dataset.id,
        "category": Category.A_VA,
        "model": ModelName.LTX,
        "seed": 47,
        "contentPlans": [
            SourceSelection(id=content_one.id, expectedRevision=content_one.revision),
            SourceSelection(id=content_two.id, expectedRevision=content_two.revision),
        ],
        "promptPresets": [
            SourceSelection(id=preset_one.id, expectedRevision=preset_one.revision),
            SourceSelection(id=preset_two.id, expectedRevision=preset_two.revision),
        ],
        "backgroundPresets": [
            SourceSelection(id=background_one.id, expectedRevision=background_one.revision),
            SourceSelection(id=background_two.id, expectedRevision=background_two.revision),
        ],
        "demographics": demographics,
        "gpuSlots": [GpuSlotName.GPU0, GpuSlotName.GPU1],
    }
    draft = batches.create_batch_draft(BatchDraftCreate(quantity=16, **selections))
    repeating_draft = batches.create_batch_draft(BatchDraftCreate(quantity=18, **selections))
    with database.immediate_session() as session:
        for row in session.exec(select(GpuSlot)).all():
            row.availability = GpuAvailability.AVAILABLE
            row.revision += 1

    preview = batches.preview_batch(draft.id, draft.revision)
    repeating_preview = batches.preview_batch(repeating_draft.id, repeating_draft.revision)

    expected = list(
        product(
            [content_one.id, content_two.id],
            [preset_one.id, preset_two.id],
            [background_one.id, background_two.id],
            [
                (25, Gender.FEMALE, Ethnicity.EAST_ASIAN),
                (35, Gender.MALE, Ethnicity.WHITE),
            ],
        )
    )

    def preview_signatures(allocations: list[object]) -> list[tuple[object, ...]]:
        return [
            (
                item.content_plan.id,
                item.prompt_preset.id,
                item.background_preset.id,
                (item.demographic.age, item.demographic.gender, item.demographic.ethnicity),
            )
            for item in allocations
        ]

    preview_values = preview_signatures(preview.allocations)
    repeating_values = preview_signatures(repeating_preview.allocations)
    assert preview_values == expected
    assert len(set(preview_values)) == 16
    assert repeating_values[:16] == expected
    assert repeating_values[16:] == expected[:2]
    assert [item.gpu_slot for item in preview.allocations] == [GpuSlotName.GPU0, GpuSlotName.GPU1] * 8

    job = asyncio.run(
        batches.submit_batch(
            draft.id,
            BatchSubmitRequest(
                expectedRevision=draft.revision,
                expectedGpuRevisions=preview.gpu_revisions,
            ),
        )
    )
    submitted_values = [
        (
            item.input.content_plan_id,
            item.input.prompt_preset_id,
            item.input.background_preset_id,
            (item.input.age, item.input.gender, item.input.ethnicity),
        )
        for item in job.items
    ]
    assert submitted_values == preview_values
    assert [item.input.seed for item in job.items] == [item.seed for item in preview.allocations]
    assert [item.input.model for item in job.items] == [item.model for item in preview.allocations]
    assert [item.gpu_slot for item in job.items] == [item.gpu_slot for item in preview.allocations]


def test_h3_vt_snapshot_keeps_negative_constraints_and_silent_primary(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, _, _, background = fixed_resources(database)
    content = catalog.create_content_plan(
        ContentPlanCreate(
            name="文字一致回应",
            category=Category.A_VT,
            mode=ContentMode.FIXED,
            status=ContentStatus.ACTIVE,
            trueEmotion="calm",
            apparentEmotion="calm",
            scene="A quiet office after a meeting.",
            triggerEvent="A timer sounds.",
            psychologicalBackground="The subject prepares a brief answer.",
            displayText="我需要再想一想。",
            trueEmotionDescription="说话者的内容和可见表现保持一致。",
            baseVideoPrompt=(
                "A restrained adult sits at a desk and answers with a steady, attentive expression while both hands "
                "remain resting on the desk."
            ),
        )
    )
    preset = catalog.create_prompt_preset(
        PromptPresetCreate(
            name="文字自然室内",
            category=Category.A_VT,
            styleInstruction="Use restrained natural performance and a static medium shot.",
            sceneSupplement="Keep the room visually simple.",
            finalNegativePrompt="subtitles, captions, exaggerated acting, camera shake",
        )
    )
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("https://example.invalid/v1", "test")),
    )
    draft = batches.create_batch_draft(
        BatchDraftCreate(
            datasetId=dataset.id,
            category=Category.A_VT,
            model=ModelName.H3,
            quantity=1,
            seed=83,
            contentPlans=[SourceSelection(id=content.id, expectedRevision=content.revision)],
            promptPresets=[SourceSelection(id=preset.id, expectedRevision=preset.revision)],
            backgroundPresets=[SourceSelection(id=background.id, expectedRevision=background.revision)],
            demographics=[DemographicInput(age=45, gender=Gender.MALE, ethnicity=Ethnicity.SOUTH_ASIAN)],
            gpuSlots=[GpuSlotName.GPU0],
        )
    )
    with database.immediate_session() as session:
        gpu = session.get(GpuSlot, GpuSlotName.GPU0)
        assert gpu is not None
        gpu.availability = GpuAvailability.AVAILABLE
        gpu.revision += 1
    preview = batches.preview_batch(draft.id, draft.revision)
    job = asyncio.run(
        batches.submit_batch(
            draft.id,
            BatchSubmitRequest(
                expectedRevision=draft.revision,
                expectedGpuRevisions=preview.gpu_revisions,
            ),
        )
    )

    snapshot = job.items[0].input
    assert (snapshot.width, snapshot.height, snapshot.fps, snapshot.frame_count) == (1344, 768, 24, 124)
    assert snapshot.renderer_profile_version == RENDERER_PROFILE_VERSION
    assert snapshot.prompt_model == "deepseek-v4-flash"
    assert snapshot.source_has_audio is True
    assert snapshot.derive_silent_primary is True
    assert snapshot.final_negative_prompt == preset.final_negative_prompt
    assert snapshot.final_negative_prompt == preview.allocations[0].final_negative_prompt
    assert snapshot.final_positive_prompt == preview.allocations[0].final_positive_prompt
    assert snapshot.seed == preview.allocations[0].seed
    assert snapshot.model is ModelName.H3
    assert (snapshot.dataset_id, snapshot.dataset_revision) == (dataset.id, dataset.revision)
    assert (snapshot.content_plan_id, snapshot.content_plan_revision) == (content.id, content.revision)
    assert (snapshot.prompt_preset_id, snapshot.prompt_preset_revision) == (preset.id, preset.revision)
    assert (snapshot.background_preset_id, snapshot.background_preset_revision) == (
        background.id,
        background.revision,
    )
    assert (snapshot.age, snapshot.gender, snapshot.ethnicity) == (
        45,
        Gender.MALE,
        Ethnicity.SOUTH_ASIAN,
    )
