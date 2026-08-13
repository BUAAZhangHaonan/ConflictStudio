from __future__ import annotations

import asyncio
import json
from collections import Counter, defaultdict
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import select

from backend.adapters.config import Settings
from backend.adapters.renderer import (
    CancelOutcome,
    RenderRequest,
    RenderResult,
    RendererGatewayError,
    RendererInstallationStatus,
    RendererSlotState,
)
from backend.app import create_app
from backend.domain.enums import (
    Category,
    ContentMode,
    ContentStatus,
    DatasetPurpose,
    Ethnicity,
    Gender,
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobStatus,
    ModelName,
)
from backend.domain.models import BatchDraft, BatchVideoInputSnapshot, GpuSlot, Job, JobItem
from backend.domain.schemas import (
    BatchDraftCreate,
    BatchSubmitRequest,
    ContentPlanCreate,
    DatasetCreate,
    DemographicInput,
    JobCancelRequest,
    PromptPresetCreate,
    SourceSelection,
    VideoBackgroundPresetCreate,
)
from backend.services.batches import BatchService
from backend.services.catalog import CatalogService
from backend.services.job_executor import JobExecutor
from backend.services.prompts import PromptService


DIALOGUE = "我没事，只是需要一点时间。"
class RecordingPromptModel:
    configured = True

    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, system_input: str, user_input: str) -> str:
        self.calls += 1
        return json.dumps(
            {
                "spokenText": DIALOGUE,
                "visualBehavior": (
                    "The subject sits upright, folds both hands on the lap, presses the lips together, raises the "
                    "chin and keeps a steady gaze through the end of the clip."
                ),
                "vocalDelivery": "in a low, steady voice with a measured pace",
                "environmentalSound": (
                    "The ventilation hums softly while a wall clock ticks at an even pace."
                ),
                "setting": "The private office has pale walls, a bare wooden table and one closed window.",
                "cameraSupplement": "",
                "lightingSupplement": "Soft daylight adds gentle highlights across the plain fabric.",
                "trueEmotionDescription": "说话内容和可见动作共同表达受控状态。",
            },
            ensure_ascii=False,
        )

    async def close(self) -> None:
        return None


class FakeRenderer:
    configured = True

    def __init__(self, *, hold: bool = False) -> None:
        self.hold = hold
        self.requests: dict[str, RenderRequest] = {}
        self.submit_counts: Counter[int] = Counter()
        self.wait_started: set[int] = set()
        self.wait_gates: dict[int, asyncio.Event] = {}
        self.cancel_calls: list[tuple[GpuSlotName, str]] = []
        self.fail_items: set[int] = set()
        self.active_total = 0
        self.max_active_total = 0
        self.active_by_slot: defaultdict[GpuSlotName, int] = defaultdict(int)
        self.max_active_by_slot: defaultdict[GpuSlotName, int] = defaultdict(int)
        self.cancel_outcome = CancelOutcome.CANCELLED

    async def probe(self, slot: GpuSlotName) -> RendererSlotState:
        return RendererSlotState(slot, GpuAvailability.AVAILABLE, None)

    async def installation_status(self) -> RendererInstallationStatus:
        return RendererInstallationStatus.INSTALLED

    async def submit(self, request: RenderRequest) -> str:
        self.submit_counts[request.job_item_id] += 1
        prompt_id = f"{request.job_id}:{request.job_item_id}"
        self.requests[prompt_id] = request
        return prompt_id

    async def wait(self, slot: GpuSlotName, prompt_id: str) -> RenderResult:
        request = self.requests[prompt_id]
        item_id = request.job_item_id
        self.wait_started.add(item_id)
        gate = self.wait_gates.setdefault(item_id, asyncio.Event())
        self.active_total += 1
        self.max_active_total = max(self.max_active_total, self.active_total)
        self.active_by_slot[slot] += 1
        self.max_active_by_slot[slot] = max(self.max_active_by_slot[slot], self.active_by_slot[slot])
        try:
            if self.hold:
                await gate.wait()
            if item_id in self.fail_items:
                raise RendererGatewayError("fake_render_failed", "The fake renderer rejected this item")
            return RenderResult()
        finally:
            self.active_total -= 1
            self.active_by_slot[slot] -= 1

    async def cancel(self, slot: GpuSlotName, prompt_id: str) -> CancelOutcome:
        self.cancel_calls.append((slot, prompt_id))
        request = self.requests[prompt_id]
        gate = self.wait_gates.get(request.job_item_id)
        if gate is not None:
            gate.set()
        return self.cancel_outcome

    async def close(self) -> None:
        return None

    def release(self, item_id: int) -> None:
        self.wait_gates[item_id].set()


def create_resources(database, suffix: str):  # type: ignore[no-untyped-def]
    catalog = CatalogService(database)
    dataset = catalog.create_dataset(
        DatasetCreate(name=f"Production {suffix}", purpose=DatasetPurpose.PRODUCTION, note="")
    )
    content = catalog.create_content_plan(
        ContentPlanCreate(
            nameZh=f"内容 {suffix}",
            nameEn=f"Content {suffix}",
            category=Category.A_VA,
            mode=ContentMode.GENERATIVE,
            status=ContentStatus.ACTIVE,
            trueEmotion="contained",
            apparentEmotion="contained",
            sceneZh="短会后的一间私人办公室。",
            sceneEn="A private office after a short meeting.",
            triggerEventZh="计时器响起。",
            triggerEventEn="A timer sounds.",
            psychologicalBackgroundZh="被摄者准备作出克制的回应。",
            psychologicalBackgroundEn="The subject prepares a measured response.",
            contentRequirementsZh="描述一名成年人在房间里回答一个简短问题。",
            contentRequirementsEn="Describe one adult answering a short question in the room.",
            sceneSupplementZh="",
            sceneSupplementEn="",
        )
    )
    preset = catalog.create_prompt_preset(
        PromptPresetCreate(
            name=f"Preset {suffix}",
            category=Category.A_VA,
            styleGuidance="Use restrained movement and a static medium shot.",
            finalRenderNegativeConstraints="subtitles, captions, distortion, exaggerated movement",
        )
    )
    background = catalog.create_background_preset(
        VideoBackgroundPresetCreate(
            nameZh=f"背景 {suffix}",
            nameEn=f"Background {suffix}",
            sceneZh="一间有一把椅子和一张书桌的私人办公室。",
            sceneEn="A private office containing one chair and one desk.",
            ambientSoundZh="能听到稳定的通风声。",
            ambientSoundEn="A steady ventilation hum remains audible.",
            participantRelationshipZh="画面中只有被摄者。",
            participantRelationshipEn="The subject remains the only occupant in view.",
            lightingZh="柔和的日光从一扇窗户照进来。",
            lightingEn="Soft daylight enters through one window.",
            framingZh="使用静止的平视中景。",
            framingEn="Use a static eye-level medium shot.",
        )
    )
    return dataset, content, preset, background


def create_draft(
    batches: BatchService,
    resources: tuple[object, object, object, object],
    slots: list[GpuSlotName],
    *,
    model: ModelName = ModelName.LTX,
    quantity: int = 1,
):
    dataset, content, preset, background = resources
    return batches.create_batch_draft(
        BatchDraftCreate(
            datasetId=dataset.id,
            category=Category.A_VA,
            model=model,
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


def make_available(database, slots: list[GpuSlotName]) -> None:  # type: ignore[no-untyped-def]
    with database.immediate_session() as session:
        for slot in slots:
            row = session.get(GpuSlot, slot)
            assert row is not None
            row.availability = GpuAvailability.AVAILABLE
            row.active_job_id = None
            row.revision += 1


async def enqueue(batches: BatchService, draft):  # type: ignore[no-untyped-def]
    preview = await batches.preview_batch(draft.id, draft.revision)
    return await batches.submit_batch(
        draft.id,
        BatchSubmitRequest(
            expectedRevision=draft.revision,
            expectedGpuRevisions=preview.gpu_revisions,
        ),
    )


async def wait_for_status(
    batches: BatchService,
    job_id: int,
    statuses: set[JobStatus],
    *,
    timeout: float = 5.0,
):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        job = batches.get_job(job_id)
        if job.status in statuses:
            return job
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError(f"Job {job_id} did not reach {statuses}; current status is {job.status}")
        await asyncio.sleep(0.01)


async def wait_until(predicate, *, timeout: float = 5.0) -> None:  # type: ignore[no-untyped-def]
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("The asynchronous condition was not reached")
        await asyncio.sleep(0.01)


def test_executor_persists_results_and_runs_two_gpu_channels(tmp_path: Path) -> None:
    async def scenario() -> None:
        from backend.adapters.database import Database

        database = Database(tmp_path)
        database.initialize()
        model = RecordingPromptModel()
        renderer = FakeRenderer(hold=True)
        prompts = PromptService(model)
        batches = BatchService(database, prompts, renderer)
        resources = create_resources(database, "dual")
        draft = create_draft(
            batches,
            resources,
            [GpuSlotName.GPU0, GpuSlotName.GPU1],
            quantity=4,
        )
        make_available(database, [GpuSlotName.GPU0, GpuSlotName.GPU1])
        job = await enqueue(batches, draft)
        items = {item.sequence: item.id for item in job.items}
        executor = JobExecutor(database, prompts, renderer, scan_interval_seconds=0.05)
        await executor.start()
        try:
            await wait_until(lambda: {items[1], items[2]} <= renderer.wait_started)
            assert items[3] not in renderer.wait_started
            assert items[4] not in renderer.wait_started

            renderer.release(items[1])
            await wait_until(lambda: items[3] in renderer.wait_started)
            assert items[4] not in renderer.wait_started

            renderer.release(items[2])
            await wait_until(lambda: items[4] in renderer.wait_started)
            renderer.release(items[3])
            renderer.release(items[4])
            completed = await wait_for_status(batches, job.id, {JobStatus.COMPLETED})
        finally:
            await executor.stop()

        assert model.calls == 4
        assert all(renderer.submit_counts[item_id] == 1 for item_id in items.values())
        assert renderer.max_active_total == 2
        assert renderer.max_active_by_slot == {GpuSlotName.GPU0: 1, GpuSlotName.GPU1: 1}
        assert (completed.prepared_count, completed.completed_count, completed.failed_count) == (4, 4, 0)
        assert all(item.prompt_result is not None for item in completed.items)
        assert all(item.prompt_result.final_positive_prompt for item in completed.items)
        assert completed.events[-1].event_type == "JobCompleted"
        assert completed.events[-1].payload.model_dump(by_alias=True, exclude_none=True) == {
            "preparedCount": 4,
            "completedCount": 4,
            "failedCount": 0,
            "totalCount": 4,
        }
        with database.read_session() as session:
            slots = session.exec(select(GpuSlot).order_by(GpuSlot.slot)).all()
            assert all(slot.availability is GpuAvailability.AVAILABLE for slot in slots)
            assert all(slot.active_job_id is None for slot in slots)

    asyncio.run(scenario())


def test_two_single_gpu_jobs_with_different_models_run_concurrently(tmp_path: Path) -> None:
    async def scenario() -> None:
        from backend.adapters.database import Database

        database = Database(tmp_path)
        database.initialize()
        model = RecordingPromptModel()
        renderer = FakeRenderer(hold=True)
        prompts = PromptService(model)
        batches = BatchService(database, prompts, renderer)
        draft_ltx = create_draft(
            batches,
            create_resources(database, "ltx"),
            [GpuSlotName.GPU0],
            model=ModelName.LTX,
        )
        draft_h3 = create_draft(
            batches,
            create_resources(database, "h3"),
            [GpuSlotName.GPU1],
            model=ModelName.H3,
        )
        make_available(database, [GpuSlotName.GPU0, GpuSlotName.GPU1])
        ltx_job = await enqueue(batches, draft_ltx)
        h3_job = await enqueue(batches, draft_h3)
        executor = JobExecutor(database, prompts, renderer, scan_interval_seconds=0.05)
        await executor.start()
        try:
            await wait_until(lambda: len(renderer.wait_started) == 2)
            assert {request.model for request in renderer.requests.values()} == {ModelName.LTX, ModelName.H3}
            assert renderer.max_active_total == 2
            for item_id in list(renderer.wait_started):
                renderer.release(item_id)
            await wait_for_status(batches, ltx_job.id, {JobStatus.COMPLETED})
            await wait_for_status(batches, h3_job.id, {JobStatus.COMPLETED})
        finally:
            await executor.stop()

    asyncio.run(scenario())


def test_single_item_failure_is_not_retried_and_other_items_continue(tmp_path: Path) -> None:
    async def scenario() -> None:
        from backend.adapters.database import Database

        database = Database(tmp_path)
        database.initialize()
        model = RecordingPromptModel()
        renderer = FakeRenderer()
        prompts = PromptService(model)
        batches = BatchService(database, prompts, renderer)
        draft = create_draft(
            batches,
            create_resources(database, "failure"),
            [GpuSlotName.GPU0],
            quantity=3,
        )
        make_available(database, [GpuSlotName.GPU0])
        job = await enqueue(batches, draft)
        failed_item_id = next(item.id for item in job.items if item.sequence == 2)
        renderer.fail_items.add(failed_item_id)
        executor = JobExecutor(database, prompts, renderer, scan_interval_seconds=0.05)
        await executor.start()
        try:
            failed = await wait_for_status(batches, job.id, {JobStatus.FAILED})
        finally:
            await executor.stop()

        assert model.calls == 3
        assert renderer.submit_counts == Counter({item.id: 1 for item in job.items})
        assert (failed.prepared_count, failed.completed_count, failed.failed_count) == (3, 2, 1)
        failed_item = next(item for item in failed.items if item.id == failed_item_id)
        assert failed_item.failure_code == "fake_render_failed"
        assert failed_item.failure_reason == "The fake renderer rejected this item"
        assert [event.event_type for event in failed.events].count("ItemFailed") == 1
        with database.read_session() as session:
            slot = session.get(GpuSlot, GpuSlotName.GPU0)
            assert slot is not None
            assert slot.availability is GpuAvailability.AVAILABLE
            assert slot.active_job_id is None

    asyncio.run(scenario())


def test_queued_job_resumes_and_running_job_fails_during_startup_recovery(tmp_path: Path) -> None:
    async def scenario() -> None:
        from backend.adapters.database import Database

        queued_root = tmp_path / "queued"
        queued_root.mkdir()
        queued_database = Database(queued_root)
        queued_database.initialize()
        queued_model = RecordingPromptModel()
        queued_renderer = FakeRenderer()
        queued_prompts = PromptService(queued_model)
        queued_batches = BatchService(queued_database, queued_prompts, queued_renderer)
        queued_draft = create_draft(
            queued_batches,
            create_resources(queued_database, "resume"),
            [GpuSlotName.GPU0],
        )
        make_available(queued_database, [GpuSlotName.GPU0])
        queued_job = await enqueue(queued_batches, queued_draft)
        resumed = JobExecutor(queued_database, queued_prompts, queued_renderer, scan_interval_seconds=0.05)
        await resumed.start()
        try:
            completed = await wait_for_status(queued_batches, queued_job.id, {JobStatus.COMPLETED})
        finally:
            await resumed.stop()
        assert completed.completed_count == 1

        running_root = tmp_path / "running"
        running_root.mkdir()
        running_database = Database(running_root)
        running_database.initialize()
        running_model = RecordingPromptModel()
        running_renderer = FakeRenderer()
        running_prompts = PromptService(running_model)
        running_batches = BatchService(running_database, running_prompts, running_renderer)
        running_draft = create_draft(
            running_batches,
            create_resources(running_database, "restart"),
            [GpuSlotName.GPU0],
        )
        make_available(running_database, [GpuSlotName.GPU0])
        running_job = await enqueue(running_batches, running_draft)
        with running_database.immediate_session() as session:
            job_row = session.get(Job, running_job.id)
            assert job_row is not None
            job_row.status = JobStatus.RUNNING
            job_row.started_at = job_row.updated_at
            for item in session.exec(select(JobItem).where(JobItem.job_id == running_job.id)).all():
                item.status = JobStatus.RUNNING
                item.stage = JobItemStage.PROMPT_GENERATING
            slot = session.get(GpuSlot, GpuSlotName.GPU0)
            assert slot is not None
            slot.availability = GpuAvailability.BUSY

        recovered = JobExecutor(running_database, running_prompts, running_renderer, scan_interval_seconds=0.05)
        await recovered.start()
        try:
            interrupted = running_batches.get_job(running_job.id)
        finally:
            await recovered.stop()
        assert interrupted.status is JobStatus.FAILED
        assert interrupted.failure_code == "interrupted_by_restart"
        assert all(item.failure_code == "interrupted_by_restart" for item in interrupted.items)
        assert "JobInterrupted" in [event.event_type for event in interrupted.events]
        with running_database.read_session() as session:
            slot = session.get(GpuSlot, GpuSlotName.GPU0)
            assert slot is not None
            assert slot.availability is GpuAvailability.UNKNOWN
            assert slot.active_job_id is None

    asyncio.run(scenario())


def test_queued_and_running_cancellation_only_release_owned_slots(tmp_path: Path) -> None:
    async def scenario() -> None:
        from backend.adapters.database import Database

        database = Database(tmp_path)
        database.initialize()
        model = RecordingPromptModel()
        renderer = FakeRenderer(hold=True)
        prompts = PromptService(model)
        batches = BatchService(database, prompts, renderer)
        first_draft = create_draft(
            batches,
            create_resources(database, "cancel queued"),
            [GpuSlotName.GPU0],
        )
        second_draft = create_draft(
            batches,
            create_resources(database, "other owner"),
            [GpuSlotName.GPU1],
        )
        make_available(database, [GpuSlotName.GPU0, GpuSlotName.GPU1])
        first_job = await enqueue(batches, first_draft)
        second_job = await enqueue(batches, second_draft)
        executor = JobExecutor(database, prompts, renderer, scan_interval_seconds=0.05)
        await executor.cancel_job(first_job.id, JobCancelRequest(expectedRevision=first_job.revision))
        cancelled_before_start = batches.get_job(first_job.id)
        assert cancelled_before_start.status is JobStatus.CANCELLED
        with database.read_session() as session:
            gpu0 = session.get(GpuSlot, GpuSlotName.GPU0)
            gpu1 = session.get(GpuSlot, GpuSlotName.GPU1)
            assert gpu0 is not None and gpu1 is not None
            assert gpu0.availability is GpuAvailability.AVAILABLE and gpu0.active_job_id is None
            assert gpu1.availability is GpuAvailability.RESERVED and gpu1.active_job_id == second_job.id

        await executor.start()
        try:
            second_item_id = second_job.items[0].id
            await wait_until(lambda: second_item_id in renderer.wait_started)
            running = batches.get_job(second_job.id)
            await executor.cancel_job(
                second_job.id,
                JobCancelRequest(expectedRevision=running.revision),
            )
            cancelled_running = await wait_for_status(batches, second_job.id, {JobStatus.CANCELLED})
        finally:
            await executor.stop()

        prompt_id = f"{second_job.id}:{second_item_id}"
        assert renderer.cancel_calls == [(GpuSlotName.GPU1, prompt_id)]
        assert cancelled_running.cancel_requested_at is not None
        assert cancelled_running.items[0].status is JobStatus.CANCELLED
        event_types = [event.event_type for event in cancelled_running.events]
        assert "CancelRequested" in event_types
        assert event_types[-1] == "JobCancelled"
        with database.read_session() as session:
            gpu1 = session.get(GpuSlot, GpuSlotName.GPU1)
            assert gpu1 is not None
            assert gpu1.availability is GpuAvailability.AVAILABLE
            assert gpu1.active_job_id is None

    asyncio.run(scenario())


def test_cancel_race_keeps_an_already_completed_item(tmp_path: Path) -> None:
    async def scenario() -> None:
        from backend.adapters.database import Database

        database = Database(tmp_path)
        database.initialize()
        renderer = FakeRenderer(hold=True)
        renderer.cancel_outcome = CancelOutcome.ALREADY_COMPLETED
        prompts = PromptService(RecordingPromptModel())
        batches = BatchService(database, prompts, renderer)
        draft = create_draft(
            batches,
            create_resources(database, "cancel completion race"),
            [GpuSlotName.GPU0],
        )
        make_available(database, [GpuSlotName.GPU0])
        job = await enqueue(batches, draft)
        executor = JobExecutor(database, prompts, renderer, scan_interval_seconds=0.05)
        await executor.start()
        try:
            item_id = job.items[0].id
            await wait_until(lambda: item_id in renderer.wait_started)
            running = batches.get_job(job.id)
            await executor.cancel_job(
                job.id,
                JobCancelRequest(expectedRevision=running.revision),
            )
            cancelled = await wait_for_status(batches, job.id, {JobStatus.CANCELLED})
        finally:
            await executor.stop()

        assert cancelled.completed_count == 1
        assert cancelled.items[0].status is JobStatus.COMPLETED
        assert cancelled.items[0].stage is JobItemStage.COMPLETED
        assert "ItemCompleted" in [event.event_type for event in cancelled.events]

    asyncio.run(scenario())


def test_submit_is_non_blocking_and_unconfigured_renderer_writes_nothing(tmp_path: Path) -> None:
    from backend.adapters.database import Database

    configured_root = tmp_path / "configured"
    configured_root.mkdir()
    configured_frontend = configured_root / "frontend"
    configured_frontend.mkdir()
    model = RecordingPromptModel()
    renderer = FakeRenderer()
    app = create_app(
        Settings(data_root=configured_root, frontend_dist=configured_frontend),
        model,
        renderer,
    )
    resources = create_resources(app.state.database, "http")
    draft = create_draft(app.state.batch_service, resources, [GpuSlotName.GPU0])
    make_available(app.state.database, [GpuSlotName.GPU0])
    preview = asyncio.run(app.state.batch_service.preview_batch(draft.id, draft.revision))
    client = TestClient(app)
    try:
        response = client.post(
            f"/api/batch-drafts/{draft.id}/submit",
            json={
                "expectedRevision": draft.revision,
                "expectedGpuRevisions": {
                    slot.value: revision for slot, revision in preview.gpu_revisions.items()
                },
            },
        )
        assert response.status_code == 202
        assert model.calls == 0
        cancel = client.post(
            f"/api/jobs/{response.json()['id']}/cancel",
            json={"expectedRevision": response.json()["revision"]},
        )
        assert cancel.status_code == 202
        assert cancel.json()["status"] == "Cancelled"
    finally:
        client.close()

    unconfigured_root = tmp_path / "unconfigured"
    unconfigured_root.mkdir()
    unconfigured_frontend = unconfigured_root / "frontend"
    unconfigured_frontend.mkdir()
    unconfigured_model = RecordingPromptModel()
    unconfigured_app = create_app(
        Settings(data_root=unconfigured_root, frontend_dist=unconfigured_frontend),
        unconfigured_model,
    )
    unconfigured_resources = create_resources(unconfigured_app.state.database, "missing renderer")
    unconfigured_draft = create_draft(
        unconfigured_app.state.batch_service,
        unconfigured_resources,
        [GpuSlotName.GPU0],
    )
    make_available(unconfigured_app.state.database, [GpuSlotName.GPU0])
    unconfigured_preview = asyncio.run(
        unconfigured_app.state.batch_service.preview_batch(
            unconfigured_draft.id,
            unconfigured_draft.revision,
        )
    )
    unconfigured_client = TestClient(unconfigured_app)
    try:
        rejected = unconfigured_client.post(
            f"/api/batch-drafts/{unconfigured_draft.id}/submit",
            json={
                "expectedRevision": unconfigured_draft.revision,
                "expectedGpuRevisions": {
                    slot.value: revision
                    for slot, revision in unconfigured_preview.gpu_revisions.items()
                },
            },
        )
    finally:
        unconfigured_client.close()

    assert rejected.status_code == 503
    assert rejected.json()["error"]["code"] == "renderer_not_configured"
    assert unconfigured_model.calls == 0
    with unconfigured_app.state.database.read_session() as session:
        assert session.exec(select(Job)).all() == []
        assert session.exec(select(BatchVideoInputSnapshot)).all() == []
        draft_row = session.get(BatchDraft, unconfigured_draft.id)
        assert draft_row is not None
        assert draft_row.status.value == "Draft"
