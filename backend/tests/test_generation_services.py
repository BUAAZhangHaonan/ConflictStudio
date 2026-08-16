from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from backend.adapters.database import Database
from backend.adapters.gpu import SlotInspection
from backend.adapters.llm import OpenAICompatiblePromptModel, UnconfiguredPromptModel
from backend.domain.enums import (
    BatchDraftStatus,
    Category,
    ContentMode,
    ContentStatus,
    DatasetPurpose,
    Ethnicity,
    Gender,
    GpuAvailability,
    GpuSlotName,
    JobSource,
    ModelName,
    Precision,
    TestExecutionMode as ExecutionMode,
)
from backend.domain.models import (
    BatchDraft,
    BatchVideoInputSnapshot,
    GpuSlot,
    Job,
    JobEvent,
    JobItemPromptResult,
    RENDERER_PROFILE_VERSION,
)
from backend.domain.schemas import (
    BatchDraftCreate,
    BatchSubmitRequest,
    BatchContentSelectionInput,
    ContentScriptCreate,
    DatasetCreate,
    DatasetUpdate,
    DemographicInput,
    PromptTemplateVersionCreate,
    SourceSelection,
    TestComparisonInput as ComparisonInput,
    TestRunCreate as RunCreate,
    SceneCreate,
)
from backend.services.batches import BatchService
from backend.services.catalog import CatalogService
from backend.services.errors import ServiceError
from backend.services.prompts import PromptContext, PromptService


class _ConfiguredRendererGateway:
    configured = True

    def __init__(
        self,
        loaded_model: ModelName | None = None,
        loaded_precision: Precision | None = None,
        availability: GpuAvailability = GpuAvailability.AVAILABLE,
        reason: str | None = None,
    ) -> None:
        self.loaded_model = loaded_model
        self.loaded_precision = loaded_precision
        self.availability = availability
        self.reason = reason
        self.probe_calls: list[GpuSlotName] = []

    async def probe(self, slot):  # type: ignore[no-untyped-def]
        self.probe_calls.append(slot)
        return SlotInspection(
            slot,
            self.availability,
            self.loaded_model,
            owned_unit=(
                f"conflictstudio-test-{slot.value.lower()}.service"
                if self.loaded_model
                else None
            ),
            reason=self.reason,
            loaded_precision=self.loaded_precision,
            gpu_name="Test GPU",
            memory_used_mib=0,
            memory_total_mib=24576,
            service_status="running" if self.loaded_model else "stopped",
        )

    async def submit(self, request):  # type: ignore[no-untyped-def]
        return "probe"

    async def wait(self, slot, prompt_id):  # type: ignore[no-untyped-def]
        return ()

    async def cancel(self, slot, prompt_id):  # type: ignore[no-untyped-def]
        return None

    async def close(self) -> None:
        return None


class _InterleavingRendererGateway(_ConfiguredRendererGateway):
    def __init__(self) -> None:
        super().__init__(ModelName.LTX_25, Precision.INT8)
        self.block_next_probe = False
        self.probe_started = asyncio.Event()
        self.continue_probe = asyncio.Event()
        self.block_release = False
        self.release_started = asyncio.Event()
        self.continue_release = asyncio.Event()
        self.release_calls: list[
            tuple[GpuSlotName, ModelName, Precision | None, str]
        ] = []

    async def probe(self, slot):  # type: ignore[no-untyped-def]
        if self.block_next_probe:
            self.block_next_probe = False
            self.probe_started.set()
            await self.continue_probe.wait()
        return await super().probe(slot)

    async def release(
        self,
        slot: GpuSlotName,
        *,
        expected_model: ModelName,
        expected_precision: Precision | None,
        expected_unit: str,
    ) -> SlotInspection:
        self.release_calls.append(
            (slot, expected_model, expected_precision, expected_unit)
        )
        self.release_started.set()
        if self.block_release:
            await self.continue_release.wait()
        self.loaded_model = None
        self.loaded_precision = None
        return SlotInspection(
            slot,
            GpuAvailability.AVAILABLE,
            None,
            gpu_name="Test GPU",
            memory_used_mib=0,
            memory_total_mib=24576,
            service_status="stopped",
        )


def fixed_resources(
    database: Database,
) -> tuple[CatalogService, object, object, object, object]:
    catalog = CatalogService(database)
    dataset = catalog.create_dataset(
        DatasetCreate(name="正式生成集", note="第一批真实生成")
    )
    background = catalog.create_scene(
        SceneCreate(
            nameZh="安静办公室",
            nameEn="Quiet office",
            sceneZh="一间有书桌和中性墙面的小型私人办公室。",
            sceneEn="A small private office with a desk and neutral walls.",
            ambientSoundZh="低沉的室内底噪和远处的通风声。",
            ambientSoundEn="Low room tone and distant ventilation.",
            participantRelationshipZh="画面中只有被摄者。",
            participantRelationshipEn="The subject remains the only occupant in view.",
            lightingZh="柔和的日光从一侧照入。",
            lightingEn="Soft daylight from one side.",
            framingZh="静止的平视中景。",
            framingEn="Static eye-level medium shot.",
        )
    )
    content = catalog.create_content_script(
        ContentScriptCreate(
            nameZh="克制回应",
            nameEn="Restrained response",
            category=Category.A_VA,
            mode=ContentMode.FIXED,
            status=ContentStatus.ACTIVE,
            trueEmotion="sadness",
            apparentEmotion="sadness",
            sceneZh="一次艰难会议后的一间安静办公室。",
            sceneEn="A quiet office after a difficult meeting.",
            triggerEventZh="有人问被摄者是否一切都好。",
            triggerEventEn="The subject is asked whether everything is fine.",
            psychologicalBackgroundZh="被摄者不想让别人担心。",
            psychologicalBackgroundEn="The subject does not want to worry anyone.",
            dialogue="我没事，只是需要一点时间。",
            trueEmotionDescription="说话者在克制悲伤，语言和可见表现保持一致。",
            baseVideoPrompt=(
                "{demographic} sits alone at a desk, keeps both hands visible, and says aloud "
                '"I am fine and only need a little time." in a steady voice. Quiet room tone remains audible. '
                "The camera stays static in a front-facing portrait and soft daylight keeps the face readable."
            ),
            contentRequirementsZh="",
            contentRequirementsEn="",
            sceneSupplementZh="",
            sceneSupplementEn="",
            sceneIds=[background.id],
        )
    )
    preset = catalog.create_prompt_template_version(
        PromptTemplateVersionCreate(
            name="Natural Interior",
            category=Category.A_VA,
            styleGuidance="Use restrained natural performance and a static medium shot.",
            positiveExamples=[
                "Observable behavior is specific and physically plausible."
            ],
            negativeExamples=["Do not name the target emotion."],
            ltxNegativePrompt="subtitles, captions, exaggerated acting, camera shake",
            h3NegativePrompt="subtitles, captions, exaggerated acting, camera shake",
            version=1,
            verificationStatus="Verified",
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
    model: ModelName = ModelName.LTX,
    precision: Precision | None = None,
):
    return service.create_batch_draft(
        BatchDraftCreate(
            targetDatasetId=dataset.id,
            category=Category.A_VA,
            model=model,
            precision=precision,
            quantity=quantity,
            seed=1208,
            contentSelections=[
                BatchContentSelectionInput(contentScriptId=content.id)
            ],
            promptTemplateVersionId=preset.id,
            demographics=[
                DemographicInput(
                    age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.EAST_ASIAN
                ),
                DemographicInput(age=35, gender=Gender.MALE, ethnicity=Ethnicity.WHITE),
            ],
            gpuSlots=slots,
        )
    )


def test_batch_submit_rejects_nonpositive_gpu_revision() -> None:
    with pytest.raises(ValidationError) as error:
        BatchSubmitRequest.model_validate(
            {
                "expectedRevision": 1,
                "expectedGpuRevisions": {"GPU0": 1, "GPU1": 0},
            }
        )

    assert error.value.errors()[0]["loc"] == ("expectedGpuRevisions", "GPU1")
    assert error.value.errors()[0]["type"] == "greater_than_equal"


def test_ltx25_precision_reaches_draft_preview_job_and_snapshot(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    _, dataset, content, preset, background = fixed_resources(database)
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    draft = make_batch(
        batches,
        dataset,
        content,
        preset,
        background,
        [GpuSlotName.GPU0],
        quantity=1,
        model=ModelName.LTX_25,
        precision=Precision.INT8,
    )
    preview = asyncio.run(batches.preview_batch(draft.id, draft.revision))
    job = asyncio.run(
        batches.submit_batch(
            draft.id,
            BatchSubmitRequest(
                expectedRevision=draft.revision,
                expectedGpuRevisions=preview.gpu_revisions,
            ),
        )
    )
    items = batches.list_job_items(job.id, 1).items

    assert draft.precision is Precision.INT8
    assert preview.allocations[0].precision is Precision.INT8
    assert job.precision is Precision.INT8
    assert items[0].input.precision is Precision.INT8
    assert items[0].input.frame_count == 121


def test_test_run_creates_one_job_with_two_shared_prompt_items(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    _, _, content, preset, background = fixed_resources(database)
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    live = asyncio.run(batches.list_gpu_slots())
    revisions = {value.slot: value.revision for value in live}
    payload = RunCreate(
        contentScript=SourceSelection(id=content.id, expectedRevision=content.revision),
        promptTemplateVersion=SourceSelection(id=preset.id, expectedRevision=preset.revision),
        scene=SourceSelection(
            id=background.id, expectedRevision=background.revision
        ),
        demographic=DemographicInput(
            age=25,
            gender=Gender.FEMALE,
            ethnicity=Ethnicity.EAST_ASIAN,
        ),
        seed=77,
        comparisons=[
            ComparisonInput(
                model=ModelName.LTX_25,
                precision=Precision.BF16,
                gpuSlot=GpuSlotName.GPU0,
            ),
            ComparisonInput(
                model=ModelName.H3,
                precision=None,
                gpuSlot=GpuSlotName.GPU1,
            ),
        ],
        executionMode=ExecutionMode.PARALLEL,
        expectedGpuRevisions=revisions,
    )

    job = asyncio.run(batches.submit_test_run(payload))
    items = batches.list_job_items(job.id, 1).items

    assert job.source is JobSource.TEST
    assert job.model is None and job.precision is None
    assert job.dataset_id is None and job.batch_draft_id is None
    assert [item.input.model for item in items] == [ModelName.LTX_25, ModelName.H3]
    assert [item.input.precision for item in items] == [Precision.BF16, None]
    assert {item.input.seed for item in items} == {77}
    assert len({item.input.fixed_positive_prompt for item in items}) == 1
    assert len({item.input.negative_prompt for item in items}) == 1


def test_serial_test_requires_switch_confirmation_for_distinct_profiles(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path)
    database.initialize()
    _, _, content, preset, background = fixed_resources(database)
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    live = asyncio.run(batches.list_gpu_slots())
    revision = next(value.revision for value in live if value.slot is GpuSlotName.GPU0)
    values = {
        "contentScript": SourceSelection(
            id=content.id, expectedRevision=content.revision
        ),
        "promptTemplateVersion": SourceSelection(id=preset.id, expectedRevision=preset.revision),
        "scene": SourceSelection(
            id=background.id, expectedRevision=background.revision
        ),
        "demographic": DemographicInput(
            age=25,
            gender=Gender.FEMALE,
            ethnicity=Ethnicity.EAST_ASIAN,
        ),
        "seed": 77,
        "comparisons": [
            ComparisonInput(
                model=ModelName.LTX_25,
                precision=Precision.BF16,
                gpuSlot=GpuSlotName.GPU0,
            ),
            ComparisonInput(
                model=ModelName.LTX_25,
                precision=Precision.INT8,
                gpuSlot=GpuSlotName.GPU0,
            ),
        ],
        "executionMode": ExecutionMode.SERIAL,
        "expectedGpuRevisions": {GpuSlotName.GPU0: revision},
    }
    with pytest.raises(ServiceError) as error:
        asyncio.run(batches.submit_test_run(RunCreate(**values)))
    assert error.value.code == "model_switch_confirmation_required"

    job = asyncio.run(
        batches.submit_test_run(RunCreate(**values, confirmModelSwitch=True))
    )
    assert job.confirm_model_switch is True


def test_submit_reports_gpu_revision_race_with_message_and_details(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = Database(tmp_path)
    database.initialize()
    _, dataset, content, preset, background = fixed_resources(database)
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    draft = make_batch(
        batches,
        dataset,
        content,
        preset,
        background,
        [GpuSlotName.GPU0],
        quantity=1,
        model=ModelName.LTX_25,
        precision=Precision.INT8,
    )
    preview = asyncio.run(batches.preview_batch(draft.id, draft.revision))
    expected_revision = preview.gpu_revisions[GpuSlotName.GPU0]
    actual_revision: list[int] = []
    inspect_slots = batches.gpu_slots._inspect_slots

    async def inspect_then_change(slots: tuple[GpuSlotName, ...]):
        snapshots = await inspect_slots(slots)
        with database.immediate_session() as session:
            row = session.get(GpuSlot, GpuSlotName.GPU0)
            assert row is not None
            row.revision += 1
            actual_revision.append(row.revision)
        return snapshots

    monkeypatch.setattr(batches.gpu_slots, "_inspect_slots", inspect_then_change)

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

    assert error.value.code == "gpu_state_changed"
    assert error.value.message == "The selected GPU state changed"
    assert error.value.details == {
        "slot": "GPU0",
        "expectedRevision": expected_revision,
        "actualRevision": actual_revision[0],
    }
    with database.read_session() as session:
        assert session.exec(select(Job)).all() == []


def test_release_blocks_concurrent_submission_until_the_service_is_stopped(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        database = Database(tmp_path)
        database.initialize()
        _, dataset, content, preset, background = fixed_resources(database)
        renderer = _InterleavingRendererGateway()
        batches = BatchService(
            database,
            PromptService(OpenAICompatiblePromptModel("test")),
            renderer,
        )
        draft = make_batch(
            batches,
            dataset,
            content,
            preset,
            background,
            [GpuSlotName.GPU0],
            quantity=1,
            model=ModelName.LTX_25,
            precision=Precision.INT8,
        )
        preview = await batches.preview_batch(draft.id, draft.revision)
        revision = preview.gpu_revisions[GpuSlotName.GPU0]
        request = BatchSubmitRequest(
            expectedRevision=draft.revision,
            expectedGpuRevisions=preview.gpu_revisions,
        )

        renderer.block_release = True
        release_task = asyncio.create_task(
            batches.release_gpu_slot(GpuSlotName.GPU0, revision)
        )
        await asyncio.wait_for(renderer.release_started.wait(), timeout=1)
        probes_during_release = list(renderer.probe_calls)

        submit_task = asyncio.create_task(batches.submit_batch(draft.id, request))
        await asyncio.sleep(0)

        assert not submit_task.done()
        assert renderer.probe_calls == probes_during_release
        with database.read_session() as session:
            assert session.exec(select(Job)).all() == []

        renderer.continue_release.set()
        released = await release_task
        assert released.loaded_model is None
        with pytest.raises(ServiceError) as error:
            await submit_task
        assert error.value.code == "gpu_state_changed"
        with database.read_session() as session:
            assert session.exec(select(Job)).all() == []

    asyncio.run(scenario())


def test_submission_blocks_concurrent_release_until_the_slot_is_reserved(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        database = Database(tmp_path)
        database.initialize()
        _, dataset, content, preset, background = fixed_resources(database)
        renderer = _InterleavingRendererGateway()
        batches = BatchService(
            database,
            PromptService(OpenAICompatiblePromptModel("test")),
            renderer,
        )
        draft = make_batch(
            batches,
            dataset,
            content,
            preset,
            background,
            [GpuSlotName.GPU0],
            quantity=1,
            model=ModelName.LTX_25,
            precision=Precision.INT8,
        )
        preview = await batches.preview_batch(draft.id, draft.revision)
        revision = preview.gpu_revisions[GpuSlotName.GPU0]
        request = BatchSubmitRequest(
            expectedRevision=draft.revision,
            expectedGpuRevisions=preview.gpu_revisions,
        )

        renderer.block_next_probe = True
        submit_task = asyncio.create_task(batches.submit_batch(draft.id, request))
        await asyncio.wait_for(renderer.probe_started.wait(), timeout=1)

        release_task = asyncio.create_task(
            batches.release_gpu_slot(GpuSlotName.GPU0, revision)
        )
        await asyncio.sleep(0)

        assert not release_task.done()
        assert renderer.release_calls == []

        renderer.continue_probe.set()
        job = await submit_task
        with pytest.raises(ServiceError) as error:
            await release_task
        assert error.value.code == "gpu_unavailable"
        assert renderer.release_calls == []
        with database.read_session() as session:
            slot = session.get(GpuSlot, GpuSlotName.GPU0)
            assert slot is not None
            assert slot.availability is GpuAvailability.RESERVED
            assert slot.active_job_id == job.id

    asyncio.run(scenario())


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
        catalog.update_dataset(
            dataset.id, DatasetUpdate(expectedRevision=1, note="过期写入")
        )
    assert error.value.code == "revision_conflict"

    with pytest.raises(ServiceError) as delete_error:
        catalog.delete_content_script(content.id, content.revision)
    assert delete_error.value.code == "state_conflict"

    reopened = Database(tmp_path)
    reopened.initialize()
    assert reopened.database_path.is_file()
    assert reopened and CatalogService(reopened).list_datasets(1).items[0].note == "已更新"


def test_fixed_prompt_keeps_examples_out_of_final_video_input(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    _, _, content_read, preset_read, background_read = fixed_resources(database)
    with database.read_session() as session:
        from backend.domain.models import (
            ContentScript,
            PromptTemplateVersion,
            Scene,
        )

        content = session.get(ContentScript, content_read.id)
        preset = session.get(PromptTemplateVersion, preset_read.id)
        background = session.get(Scene, background_read.id)
        service = PromptService(OpenAICompatiblePromptModel("test"))
        prepared = service.prepare(
            PromptContext(
                content=content,
                template_version=preset,
                positive_examples=preset_read.positive_examples,
                negative_examples=preset_read.negative_examples,
                scene=background,
                age=25,
                gender=Gender.FEMALE,
                ethnicity=Ethnicity.EAST_ASIAN,
                model=ModelName.LTX,
            )
        )
    result = asyncio.run(service.complete(prepared, Category.A_VA))

    assert result.user_input == ""
    assert "Observable behavior" not in result.final_positive_prompt
    assert "Do not name" not in result.final_positive_prompt
    assert result.final_positive_prompt.startswith("A 25-year-old East Asian woman")
    assert "A small private office" not in result.final_positive_prompt
    assert result.dialogue == "我没事，只是需要一点时间。"
    assert (
        result.negative_prompt
        == "subtitles, captions, exaggerated acting, camera shake"
    )


def test_generative_prompt_uses_one_strict_deepseek_request(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, _, _, _, background_read = fixed_resources(database)
    content_read = catalog.create_content_script(
        ContentScriptCreate(
            nameZh="生成式冲突",
            nameEn="Generative conflict",
            category=Category.C_VA,
            conflictDirection="Audio",
            mode=ContentMode.GENERATIVE,
            status=ContentStatus.ACTIVE,
            trueEmotion="relief",
            apparentEmotion="worry",
            sceneZh="一处诊所候诊区。",
            sceneEn="A clinic waiting area.",
            triggerEventZh="一通电话刚刚结束。",
            triggerEventEn="A call has just ended.",
            psychologicalBackgroundZh="被摄者隐瞒一个好消息。",
            psychologicalBackgroundEn="The subject hides good news.",
            contentRequirementsZh="生成细微冲突的视觉和声音证据。",
            contentRequirementsEn="Create subtle conflicting visual and vocal evidence.",
            sceneSupplementZh="",
            sceneSupplementEn="",
            sceneIds=[background_read.id],
        )
    )
    preset_read = catalog.create_prompt_template_version(
        PromptTemplateVersionCreate(
            name="Conflict Portrait",
            category=Category.C_VA,
            positiveExamples=[
                "The person grips a ceramic cup with the right hand and lowers both shoulders."
            ],
            negativeExamples=["The person sits still with both hands on the table."],
            ltxNegativePrompt="subtitles, exaggerated movement",
            h3NegativePrompt="subtitles, exaggerated movement",
            version=1,
            verificationStatus="Verified",
        )
    )
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://api.deepseek.com/v1/chat/completions"
        calls.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "spokenText": "结果出来了，没什么需要担心的。",
                                    "appearance": (
                                        "She wears a charcoal jacket, and her dark hair remains neatly tucked behind one ear."
                                    ),
                                    "bodyAction": (
                                        "She sits upright, folds both hands on her lap, presses her lips together, raises "
                                        "her chin, and keeps her gaze level through the final word."
                                    ),
                                    "vocalDelivery": (
                                        "She keeps her voice low and steady, with measured pacing and firm articulation."
                                    ),
                                    "environmentalSound": (
                                        "A soft ventilation hum and the even ticking of a wall clock remain audible."
                                    ),
                                    "setting": (
                                        "The private clinic office contains pale walls, a bare wooden table, and one closed window."
                                    ),
                                    "camera": (
                                        "The camera holds a static front-facing close-up head-and-shoulders view."
                                    ),
                                    "lighting": (
                                        "Soft daylight keeps her face bright and evenly lit with gentle highlights across the jacket fabric."
                                    ),
                                    "trueEmotionDescription": "声音中的放松表达真实感受，视觉表现仍显得担忧。",
                                },
                                ensure_ascii=False,
                            )
                        }
                    }
                ]
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    model = OpenAICompatiblePromptModel("test-key", client)
    service = PromptService(model)
    with database.read_session() as session:
        from backend.domain.models import (
            ContentScript,
            PromptTemplateVersion,
            Scene,
        )

        prepared = service.prepare(
            PromptContext(
                content=session.get(ContentScript, content_read.id),
                template_version=session.get(PromptTemplateVersion, preset_read.id),
                positive_examples=preset_read.positive_examples,
                negative_examples=preset_read.negative_examples,
                scene=session.get(Scene, background_read.id),
                age=45,
                gender=Gender.FEMALE,
                ethnicity=Ethnicity.EAST_ASIAN,
                model=ModelName.LTX,
            )
        )
    result = asyncio.run(service.complete(prepared, Category.C_VA))
    asyncio.run(client.aclose())

    assert len(calls) == 1
    assert calls[0]["model"] == "deepseek-v4-flash"
    assert calls[0]["thinking"] == {"type": "disabled"}
    assert calls[0]["response_format"] == {"type": "json_object"}
    assert calls[0]["max_tokens"] == 2048
    assert (
        "The person grips a ceramic cup with the right hand and lowers both shoulders."
        in prepared.user_input
    )
    assert (
        "The person sits still with both hands on the table."
        not in result.final_positive_prompt
    )
    assert "80 to 150 English words" in prepared.system_input
    assert "Use present tense only" in prepared.system_input
    assert (
        "obviously, definitely, unmistakably, undeniably, evidently"
        in prepared.system_input
    )
    assert "Do not use clearly to make an emotion or psychological judgment" in prepared.system_input
    assert "concrete visible body and facial behavior" in prepared.system_input
    assert "Return exactly one JSON object" in prepared.system_input
    assert "A clinic waiting area." in prepared.user_input
    assert (
        "A small private office with a desk and neutral walls." in prepared.user_input
    )
    assert "Age: 45" in prepared.user_input
    assert "The application maps spokenText" in prepared.user_input
    assert result.final_positive_prompt.startswith("A 45-year-old East Asian woman")
    assert "'结果出来了，没什么需要担心的。'" in result.final_positive_prompt
    assert "front-facing close-up head-and-shoulders" in result.final_positive_prompt


def test_prompt_model_requires_only_api_key_and_ignores_removed_endpoint_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CONFLICTSTUDIO_LLM_API_KEY", raising=False)
    monkeypatch.setenv(
        "CONFLICTSTUDIO_LLM_ENDPOINT", "https://removed.example/v1/chat/completions"
    )
    monkeypatch.setenv("CONFLICTSTUDIO_LLM_BASE_URL", "https://removed.example/v1")

    assert isinstance(
        OpenAICompatiblePromptModel.from_environment(), UnconfiguredPromptModel
    )

    monkeypatch.setenv("CONFLICTSTUDIO_LLM_API_KEY", "test-key")
    model = OpenAICompatiblePromptModel.from_environment()

    assert isinstance(model, OpenAICompatiblePromptModel)
    assert model.api_key == "test-key"
    asyncio.run(model.close())


def test_preview_rotates_backgrounds_and_unknown_gpu_blocks_submit(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content, preset, background = fixed_resources(database)
    second = catalog.create_scene(
        SceneCreate(
            nameZh="候车室",
            nameEn="Station waiting room",
            sceneZh="一间安静的车站候车室。",
            sceneEn="A quiet station waiting room.",
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
    prompt_service = PromptService(OpenAICompatiblePromptModel("test"))
    renderer = _ConfiguredRendererGateway(
        availability=GpuAvailability.EXTERNAL_OCCUPIED,
        reason="An unknown process uses the GPU or fixed listener port",
    )
    batches = BatchService(
        database,
        prompt_service,
        renderer,
    )
    draft = batches.create_batch_draft(
        BatchDraftCreate(
            targetDatasetId=dataset.id,
            category=Category.A_VA,
            model=ModelName.LTX,
            quantity=4,
            seed=7,
            contentSelections=[
                BatchContentSelectionInput(contentScriptId=content.id)
            ],
            promptTemplateVersionId=preset.id,
            demographics=[
                DemographicInput(
                    age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.LATINO
                )
            ],
            gpuSlots=[GpuSlotName.GPU0],
        )
    )
    preview = asyncio.run(batches.preview_batch(draft.id, draft.revision))
    assert [item.scene.id for item in preview.allocations] == [
        background.id,
    ] * 4

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
    assert error.value.code == "gpu_occupation_untrusted"
    assert renderer.probe_calls == [GpuSlotName.GPU0, GpuSlotName.GPU0]
    with database.read_session() as session:
        assert session.exec(select(Job)).all() == []
        assert session.exec(select(BatchVideoInputSnapshot)).all() == []


def test_submit_blocks_when_renderer_is_not_configured(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content, preset, background = fixed_resources(database)
    batches = BatchService(database, PromptService(OpenAICompatiblePromptModel("test")))
    draft = make_batch(
        batches,
        dataset,
        content,
        preset,
        background,
        [GpuSlotName.GPU0],
    )
    preview = asyncio.run(batches.preview_batch(draft.id, draft.revision))
    with database.immediate_session() as session:
        for row in session.exec(select(GpuSlot)).all():
            row.availability = GpuAvailability.AVAILABLE
            row.revision += 1

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
    assert error.value.code == "renderer_not_configured"
    with database.read_session() as session:
        assert session.exec(select(Job)).all() == []
        assert session.exec(select(BatchVideoInputSnapshot)).all() == []
        draft_row = session.get(BatchDraft, draft.id)
        assert draft_row is not None
        assert draft_row.status is BatchDraftStatus.DRAFT


def test_submit_rejects_model_switch_without_confirmation_and_succeeds_with_confirmation(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content, preset, background = fixed_resources(database)
    prompt_service = PromptService(OpenAICompatiblePromptModel("test"))
    renderer = _ConfiguredRendererGateway(ModelName.H3)
    batches = BatchService(database, prompt_service, renderer)
    draft = make_batch(
        batches,
        dataset,
        content,
        preset,
        background,
        [GpuSlotName.GPU0],
    )
    with database.immediate_session() as session:
        slot = session.get(GpuSlot, GpuSlotName.GPU0)
        assert slot is not None
        slot.availability = GpuAvailability.AVAILABLE
        slot.loaded_model = ModelName.H3
        slot.revision += 1
    preview = asyncio.run(batches.preview_batch(draft.id, draft.revision))

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
    assert error.value.code == "model_switch_confirmation_required"
    with database.read_session() as session:
        slot = session.get(GpuSlot, GpuSlotName.GPU0)
        assert slot is not None
        assert slot.loaded_model is ModelName.H3

    job = asyncio.run(
        batches.submit_batch(
            draft.id,
            BatchSubmitRequest(
                expectedRevision=draft.revision,
                expectedGpuRevisions=preview.gpu_revisions,
                confirm_model_switch=True,
            ),
        )
    )
    assert job.confirm_model_switch is True
    assert renderer.probe_calls == [
        GpuSlotName.GPU0,
        GpuSlotName.GPU0,
        GpuSlotName.GPU0,
    ]
    with database.read_session() as session:
        slot = session.get(GpuSlot, GpuSlotName.GPU0)
        assert slot is not None
        assert slot.loaded_model is ModelName.H3
        assert slot.availability is GpuAvailability.RESERVED

    with database.immediate_session() as session:
        stale = session.get(GpuSlot, GpuSlotName.GPU0)
        assert stale is not None
        stale.availability = GpuAvailability.AVAILABLE
        stale.active_job_id = None

    reconciled = asyncio.run(batches.list_gpu_slots())[0]
    assert reconciled.active_job_id == job.id
    assert reconciled.availability is GpuAvailability.RESERVED


def test_dual_gpu_submit_is_atomic_and_snapshots_survive_restart(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path)
    database.initialize()
    _, dataset, content, preset, background = fixed_resources(database)
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
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
    preview = asyncio.run(batches.preview_batch(draft.id, draft.revision))
    job = asyncio.run(
        batches.submit_batch(
            draft.id,
            BatchSubmitRequest(
                expectedRevision=draft.revision,
                expectedGpuRevisions=preview.gpu_revisions,
            ),
        )
    )
    items = batches.list_job_items(job.id, 1).items
    events = batches.list_job_events(job.id, 1).items

    assert [item.gpu_slot for item in items] == [
        GpuSlotName.GPU0,
        GpuSlotName.GPU1,
        GpuSlotName.GPU0,
        GpuSlotName.GPU1,
    ]
    assert len({item.input.seed for item in items}) == 4
    first_input = items[0].input
    first_preview = preview.allocations[0]
    assert (first_input.dataset_id, first_input.dataset_revision) == (
        dataset.id,
        dataset.revision,
    )
    assert (first_input.content_script_id, first_input.content_script_revision) == (
        content.id,
        content.revision,
    )
    assert (first_input.prompt_template_version_id, first_input.prompt_template_version_revision) == (
        preset.id,
        preset.revision,
    )
    assert (
        first_input.scene_id,
        first_input.scene_revision,
    ) == (
        background.id,
        background.revision,
    )
    assert (first_input.age, first_input.gender, first_input.ethnicity) == (
        first_preview.demographic.age,
        first_preview.demographic.gender,
        first_preview.demographic.ethnicity,
    )
    assert (
        first_input.width,
        first_input.height,
        first_input.fps,
        first_input.frame_count,
    ) == (1344, 768, 24, 121)
    assert first_input.renderer_profile_version == RENDERER_PROFILE_VERSION
    assert first_input.prompt_model == "deepseek-v4-flash"
    assert first_input.source_has_audio is True
    assert first_input.derive_silent_primary is False
    assert first_input.negative_prompt == first_preview.negative_prompt
    assert first_input.seed == first_preview.seed
    assert first_input.model is ModelName.LTX
    assert items[0].prompt_result is None
    with database.read_session() as session:
        slots = session.exec(select(GpuSlot).order_by(GpuSlot.slot)).all()
        assert all(slot.availability is GpuAvailability.RESERVED for slot in slots)
        assert all(slot.active_job_id == job.id for slot in slots)
        snapshot_id = items[0].input.id
    assert events and events[0].event_type == "JobQueued"
    assert events[0].payload.slot_count == 2
    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            session.exec(
                update(BatchVideoInputSnapshot)
                .where(BatchVideoInputSnapshot.id == snapshot_id)
                .values(negative_prompt="changed")
            )
    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            snapshot = session.get(BatchVideoInputSnapshot, snapshot_id)
            assert snapshot is not None
            session.delete(snapshot)
    with pytest.raises(IntegrityError):
        with database.immediate_session() as session:
            session.exec(
                update(JobEvent)
                .where(JobEvent.id == events[0].id)
                .values(event_type="JobRestarted")
            )
            session.flush()
    with database.immediate_session() as session:
        prompt_result = JobItemPromptResult(
            job_item_id=items[0].id,
            policy_version="test",
            system_input="system",
            user_input="user",
            raw_structured_response="{}",
            final_positive_prompt="a good answer",
            negative_prompt="no subtitles",
            dialogue="",
            vt_text=None,
            true_emotion_description="测试情绪描述",
        )
        session.add(prompt_result)
        session.flush()
        with pytest.raises(IntegrityError):
            session.exec(
                update(JobItemPromptResult)
                .where(JobItemPromptResult.id == prompt_result.id)
                .values(negative_prompt="no music")
            )
            session.flush()

    reopened = Database(tmp_path)
    reopened.initialize()
    restored_service = BatchService(
        reopened,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    restored = restored_service.get_job(job.id)
    restored_items = restored_service.list_job_items(restored.id, 1).items
    assert len(restored_items) == 4
    assert (
        restored_items[0].input.negative_prompt
        == items[0].input.negative_prompt
    )


def test_cartesian_preview_and_submit_cover_all_dimensions_in_order(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, content_one, preset_one, background_one = fixed_resources(
        database
    )
    background_two = catalog.create_scene(
        SceneCreate(
            nameZh="安静办公室二",
            nameEn="Quiet office two",
            sceneZh="一间有书桌和中性墙面的紧凑私人办公室。",
            sceneEn="A compact private office with a desk and neutral walls.",
            ambientSoundZh="低沉的室内底噪和远处的通风声。",
            ambientSoundEn="Low room tone and distant ventilation.",
            participantRelationshipZh="画面中只有被摄者。",
            participantRelationshipEn="The subject remains the only occupant in view.",
            lightingZh="柔和的日光从一侧照入。",
            lightingEn="Soft daylight from one side.",
            framingZh="静止的平视中景。",
            framingEn="Static eye-level medium shot.",
        )
    )
    content_two = catalog.create_content_script(
        ContentScriptCreate(
            nameZh="一致回应二",
            nameEn="Aligned response two",
            category=Category.A_VA,
            mode=ContentMode.FIXED,
            status=ContentStatus.ACTIVE,
            trueEmotion="sadness",
            apparentEmotion="sadness",
            sceneZh="一次艰难会议后的一间安静办公室。",
            sceneEn="A quiet office after a difficult meeting.",
            triggerEventZh="有人问被摄者是否一切都好。",
            triggerEventEn="The subject is asked whether everything is fine.",
            psychologicalBackgroundZh="被摄者想让回答保持简短。",
            psychologicalBackgroundEn="The subject wants to keep the answer brief.",
            dialogue="我没事，只是需要一点时间。",
            trueEmotionDescription="说话者在克制悲伤，语言和可见表现保持一致。",
            baseVideoPrompt=(
                "A restrained adult sits at a desk and answers a direct question with a steady but tired expression."
            ),
            contentRequirementsZh="",
            contentRequirementsEn="",
            sceneSupplementZh="",
            sceneSupplementEn="",
            sceneIds=[background_two.id],
        )
    )
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    demographics = [
        DemographicInput(age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.EAST_ASIAN),
        DemographicInput(age=35, gender=Gender.MALE, ethnicity=Ethnicity.WHITE),
    ]
    selections = {
        "targetDatasetId": dataset.id,
        "category": Category.A_VA,
        "model": ModelName.LTX,
        "seed": 47,
        "contentSelections": [
            BatchContentSelectionInput(contentScriptId=content_one.id),
            BatchContentSelectionInput(contentScriptId=content_two.id),
        ],
        "promptTemplateVersionId": preset_one.id,
        "demographics": demographics,
        "gpuSlots": [GpuSlotName.GPU0, GpuSlotName.GPU1],
    }
    draft = batches.create_batch_draft(BatchDraftCreate(quantity=4, **selections))
    repeating_draft = batches.create_batch_draft(
        BatchDraftCreate(quantity=6, **selections)
    )
    with database.immediate_session() as session:
        for row in session.exec(select(GpuSlot)).all():
            row.availability = GpuAvailability.AVAILABLE
            row.revision += 1

    preview = asyncio.run(batches.preview_batch(draft.id, draft.revision))
    repeating_preview = asyncio.run(
        batches.preview_batch(repeating_draft.id, repeating_draft.revision)
    )

    expected = [
        (
            content_one.id,
            preset_one.id,
            background_one.id,
            (25, Gender.FEMALE, Ethnicity.EAST_ASIAN),
        ),
        (
            content_one.id,
            preset_one.id,
            background_one.id,
            (35, Gender.MALE, Ethnicity.WHITE),
        ),
        (
            content_two.id,
            preset_one.id,
            background_two.id,
            (25, Gender.FEMALE, Ethnicity.EAST_ASIAN),
        ),
        (
            content_two.id,
            preset_one.id,
            background_two.id,
            (35, Gender.MALE, Ethnicity.WHITE),
        ),
    ]

    def preview_signatures(allocations: list[object]) -> list[tuple[object, ...]]:
        return [
            (
                item.content_script.id,
                item.prompt_template_version.id,
                item.scene.id,
                (
                    item.demographic.age,
                    item.demographic.gender,
                    item.demographic.ethnicity,
                ),
            )
            for item in allocations
        ]

    preview_values = preview_signatures(preview.allocations)
    repeating_values = preview_signatures(repeating_preview.allocations)
    assert preview_values == expected
    assert len(set(preview_values)) == 4
    assert repeating_values[:4] == expected
    assert repeating_values[4:] == expected[:2]
    assert [item.gpu_slot for item in preview.allocations] == [
        GpuSlotName.GPU0,
        GpuSlotName.GPU1,
    ] * 2

    job = asyncio.run(
        batches.submit_batch(
            draft.id,
            BatchSubmitRequest(
                expectedRevision=draft.revision,
                expectedGpuRevisions=preview.gpu_revisions,
            ),
        )
    )
    items = batches.list_job_items(job.id, 1).items
    submitted_values = [
        (
            item.input.content_script_id,
            item.input.prompt_template_version_id,
            item.input.scene_id,
            (item.input.age, item.input.gender, item.input.ethnicity),
        )
        for item in items
    ]
    assert submitted_values == preview_values
    assert [item.input.seed for item in items] == [
        item.seed for item in preview.allocations
    ]
    assert [item.input.model for item in items] == [
        item.model for item in preview.allocations
    ]
    assert [item.gpu_slot for item in items] == [
        item.gpu_slot for item in preview.allocations
    ]


def test_h3_vt_snapshot_keeps_negative_constraints_and_silent_primary(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path)
    database.initialize()
    catalog, dataset, _, _, background = fixed_resources(database)
    content = catalog.create_content_script(
        ContentScriptCreate(
            nameZh="文字一致回应",
            nameEn="Aligned text response",
            category=Category.A_VT,
            mode=ContentMode.FIXED,
            status=ContentStatus.ACTIVE,
            trueEmotion="calm",
            apparentEmotion="calm",
            sceneZh="会议后的一间安静办公室。",
            sceneEn="A quiet office after a meeting.",
            triggerEventZh="计时器响起。",
            triggerEventEn="A timer sounds.",
            psychologicalBackgroundZh="被摄者准备作出简短回答。",
            psychologicalBackgroundEn="The subject prepares a brief answer.",
            displayText="我需要再想一想。",
            trueEmotionDescription="说话者的内容和可见表现保持一致。",
            baseVideoPrompt=(
                "A restrained adult sits at a desk and answers with a steady, attentive expression while both hands "
                "remain resting on the desk."
            ),
            contentRequirementsZh="",
            contentRequirementsEn="",
            sceneSupplementZh="",
            sceneSupplementEn="",
            sceneIds=[background.id],
        )
    )
    preset = catalog.create_prompt_template_version(
        PromptTemplateVersionCreate(
            name="Natural Text Interior",
            category=Category.A_VT,
            styleGuidance="Use restrained natural performance and a static medium shot.",
            ltxNegativePrompt="subtitles, captions, exaggerated acting, camera shake",
            h3NegativePrompt="subtitles, captions, exaggerated acting, camera shake",
            version=1,
            verificationStatus="Verified",
        )
    )
    batches = BatchService(
        database,
        PromptService(OpenAICompatiblePromptModel("test")),
        _ConfiguredRendererGateway(),
    )
    draft = batches.create_batch_draft(
        BatchDraftCreate(
            targetDatasetId=dataset.id,
            category=Category.A_VT,
            model=ModelName.H3,
            quantity=1,
            seed=83,
            contentSelections=[
                BatchContentSelectionInput(contentScriptId=content.id)
            ],
            promptTemplateVersionId=preset.id,
            demographics=[
                DemographicInput(
                    age=45, gender=Gender.MALE, ethnicity=Ethnicity.SOUTH_ASIAN
                )
            ],
            gpuSlots=[GpuSlotName.GPU0],
        )
    )
    with database.immediate_session() as session:
        gpu = session.get(GpuSlot, GpuSlotName.GPU0)
        assert gpu is not None
        gpu.availability = GpuAvailability.AVAILABLE
        gpu.revision += 1
    preview = asyncio.run(batches.preview_batch(draft.id, draft.revision))
    job = asyncio.run(
        batches.submit_batch(
            draft.id,
            BatchSubmitRequest(
                expectedRevision=draft.revision,
                expectedGpuRevisions=preview.gpu_revisions,
            ),
        )
    )
    items = batches.list_job_items(job.id, 1).items

    snapshot = items[0].input
    assert (snapshot.width, snapshot.height, snapshot.fps, snapshot.frame_count) == (
        1344,
        768,
        24,
        124,
    )
    assert snapshot.renderer_profile_version == RENDERER_PROFILE_VERSION
    assert snapshot.prompt_model == "deepseek-v4-flash"
    assert snapshot.source_has_audio is True
    assert snapshot.derive_silent_primary is True
    assert snapshot.negative_prompt == preset.h3_negative_prompt
    assert (
        snapshot.negative_prompt == preview.allocations[0].negative_prompt
    )
    assert snapshot.seed == preview.allocations[0].seed
    assert snapshot.model is ModelName.H3
    assert (snapshot.dataset_id, snapshot.dataset_revision) == (
        dataset.id,
        dataset.revision,
    )
    assert (snapshot.content_script_id, snapshot.content_script_revision) == (
        content.id,
        content.revision,
    )
    assert (snapshot.prompt_template_version_id, snapshot.prompt_template_version_revision) == (
        preset.id,
        preset.revision,
    )
    assert (snapshot.scene_id, snapshot.scene_revision) == (
        background.id,
        background.revision,
    )
    assert (snapshot.age, snapshot.gender, snapshot.ethnicity) == (
        45,
        Gender.MALE,
        Ethnicity.SOUTH_ASIAN,
    )
