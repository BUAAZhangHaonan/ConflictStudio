from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from subprocess import CompletedProcess
from typing import Any

import pytest
from sqlmodel import select

from backend.adapters.comfyui import AdapterError
from backend.adapters.database import Database
from backend.adapters.gpu import SlotInspection
from backend.adapters.llm import UnconfiguredPromptModel
from backend.adapters.media import MediaStore
from backend.adapters.production_renderer import ProductionRendererGateway
from backend.adapters.renderer import (
    CancelOutcome,
    RenderRequest,
    RendererGatewayError,
    RendererSlotState,
)
from backend.adapters.workflows import H3WorkflowBuilder, Ltx23WorkflowBuilder
from backend.domain.enums import (
    Category,
    ContentMode,
    ContentStatus,
    DatasetPurpose,
    Ethnicity,
    Gender,
    GenerationAttemptStatus,
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobStatus,
    ModelName,
)
from backend.domain.models import Asset, BatchVideoInputSnapshot, GenerationAttempt, GpuSlot, Job, JobItem
from backend.domain.schemas import (
    BatchDraftCreate,
    BatchSubmitRequest,
    ContentPlanCreate,
    DatasetCreate,
    DemographicInput,
    PromptPresetCreate,
    SourceSelection,
    VideoBackgroundPresetCreate,
)
from backend.services.batches import BatchService
from backend.services.catalog import CatalogService
from backend.services.prompts import PromptService


FIXTURES = Path(__file__).parent / "fixtures" / "workflows"


class ReservationRenderer:
    configured = True


class FakeModelController:
    def __init__(
        self,
        *,
        loaded_model: ModelName | None = None,
        externally_occupied: bool = False,
    ) -> None:
        self.loaded_model = loaded_model
        self.externally_occupied = externally_occupied
        self.calls: list[tuple[GpuSlotName, ModelName, bool]] = []

    async def ensure_model(
        self,
        slot: GpuSlotName,
        model: ModelName,
        *,
        confirm_switch: bool,
    ) -> SlotInspection:
        self.calls.append((slot, model, confirm_switch))
        if self.externally_occupied:
            raise RendererGatewayError(
                "gpu_slot_unavailable",
                "An unknown process occupies the requested GPU",
            )
        if self.loaded_model is not None and self.loaded_model is not model and not confirm_switch:
            raise RendererGatewayError(
                "model_switch_confirmation_required",
                "Explicit confirmation is required to switch the model on this GPU",
            )
        self.loaded_model = model
        slug = "ltx" if model is ModelName.LTX else "h3"
        return SlotInspection(
            slot,
            GpuAvailability.AVAILABLE,
            model,
            f"conflictstudio-{slug}-{slot.value.casefold()}.service",
        )

    async def close(self) -> None:
        return None


class FakeInspector:
    async def inspect(self, slot: GpuSlotName) -> SlotInspection:
        return SlotInspection(slot, GpuAvailability.AVAILABLE, None)


class FakeComfyUIClient:
    def __init__(self) -> None:
        self.submit_calls: list[tuple[dict[str, Any], str]] = []
        self.history: dict[str, Any] = {}
        self.history_calls = 0
        self.cancel_error: AdapterError | None = None
        self.cancel_calls: list[str] = []

    async def submit_prompt(self, workflow: dict[str, Any], client_id: str) -> str:
        self.submit_calls.append((workflow, client_id))
        return f"prompt-{len(self.submit_calls)}"

    @asynccontextmanager
    async def observe_prompt(self, prompt_id: str) -> AsyncIterator[None]:
        yield

    async def websocket_messages(self, client_id: str) -> AsyncIterator[dict[str, Any]]:
        if False:
            yield {}

    async def get_queue(self) -> dict[str, Any]:
        return {"queue_running": [], "queue_pending": []}

    async def get_history(self, prompt_id: str) -> dict[str, Any]:
        self.history_calls += 1
        return self.history

    async def cancel(self, prompt_id: str) -> None:
        self.cancel_calls.append(prompt_id)
        if self.cancel_error is not None:
            raise self.cancel_error

    async def close(self) -> None:
        return None


def run(coroutine):  # type: ignore[no-untyped-def]
    return asyncio.run(coroutine)


async def create_running_request(
    data_root: Path,
    *,
    category: Category,
    model: ModelName = ModelName.LTX,
    confirm_model_switch: bool = False,
) -> tuple[Database, RenderRequest]:
    data_root.mkdir()
    database = Database(data_root)
    database.initialize()
    catalog = CatalogService(database)
    dataset = catalog.create_dataset(
        DatasetCreate(name="Renderer gateway", purpose=DatasetPurpose.PRODUCTION, note="")
    )
    content = catalog.create_content_plan(
        ContentPlanCreate(
            name="One subject",
            category=category,
            mode=ContentMode.GENERATIVE,
            status=ContentStatus.ACTIVE,
            trueEmotion="calm",
            apparentEmotion="calm",
            scene="A private office after a short meeting.",
            triggerEvent="A timer sounds.",
            psychologicalBackground="The subject prepares a brief response.",
            contentRequirements="Describe one adult responding alone in the room.",
        )
    )
    preset = catalog.create_prompt_preset(
        PromptPresetCreate(
            name="Static portrait",
            category=category,
            styleGuidance="Use a static eye-level medium shot.",
            finalRenderNegativeConstraints="subtitles, captions, distortion",
        )
    )
    background = catalog.create_background_preset(
        VideoBackgroundPresetCreate(
            name="Private office",
            scene="A private office containing one chair and one desk.",
            ambientSound="A steady ventilation hum remains audible.",
            participantRelationship="The subject remains the only occupant in view.",
            lighting="Soft daylight enters through one window.",
            framing="Use a static eye-level medium shot.",
        )
    )
    prompts = PromptService(UnconfiguredPromptModel())
    batches = BatchService(database, prompts, ReservationRenderer())  # type: ignore[arg-type]
    draft = batches.create_batch_draft(
        BatchDraftCreate(
            datasetId=dataset.id,
            category=category,
            model=model,
            quantity=1,
            seed=1208,
            contentPlans=[SourceSelection(id=content.id, expectedRevision=content.revision)],
            promptPresets=[SourceSelection(id=preset.id, expectedRevision=preset.revision)],
            backgroundPresets=[SourceSelection(id=background.id, expectedRevision=background.revision)],
            demographics=[
                DemographicInput(age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.EAST_ASIAN)
            ],
            gpuSlots=[GpuSlotName.GPU0],
        )
    )
    with database.immediate_session() as session:
        slot = session.get(GpuSlot, GpuSlotName.GPU0)
        assert slot is not None
        slot.availability = GpuAvailability.AVAILABLE
        slot.revision += 1
    preview = batches.preview_batch(draft.id, draft.revision)
    submitted = await batches.submit_batch(
        draft.id,
        BatchSubmitRequest(
            expectedRevision=draft.revision,
            expectedGpuRevisions=preview.gpu_revisions,
            confirmModelSwitch=confirm_model_switch,
        ),
    )
    with database.immediate_session() as session:
        job = session.get(Job, submitted.id)
        item = session.exec(select(JobItem).where(JobItem.job_id == submitted.id)).one()
        snapshot = session.get(BatchVideoInputSnapshot, item.input_snapshot_id)
        slot = session.get(GpuSlot, GpuSlotName.GPU0)
        assert job is not None and snapshot is not None and slot is not None
        job.status = JobStatus.RUNNING
        item.status = JobStatus.RUNNING
        item.stage = JobItemStage.PROMPT_READY
        slot.availability = GpuAvailability.BUSY
        request = RenderRequest(
            job_id=job.id,
            job_item_id=item.id,
            item_sequence=item.sequence,
            gpu_slot=item.gpu_slot,
            model=job.model,
            category=job.category,
            confirm_model_switch=job.confirm_model_switch,
            seed=snapshot.seed,
            width=snapshot.width,
            height=snapshot.height,
            fps=snapshot.fps,
            frame_count=snapshot.frame_count,
            positive_prompt="One adult sits alone in a quiet private office.",
            negative_prompt="subtitles, captions, distortion",
            dialogue="I am ready." if category is Category.A_VA else None,
            vt_text="I am ready." if category is Category.A_VT else None,
            expected_has_audio=category is Category.A_VA,
        )
    return database, request


def make_gateway(
    database: Database,
    *,
    controller: FakeModelController | None = None,
) -> tuple[ProductionRendererGateway, FakeComfyUIClient, FakeComfyUIClient, FakeModelController]:
    gpu0 = FakeComfyUIClient()
    gpu1 = FakeComfyUIClient()
    resolved_controller = controller or FakeModelController()
    gateway = ProductionRendererGateway(
        database,
        FakeInspector(),  # type: ignore[arg-type]
        resolved_controller,  # type: ignore[arg-type]
        {GpuSlotName.GPU0: gpu0, GpuSlotName.GPU1: gpu1},  # type: ignore[dict-item]
        {
            ModelName.LTX: Ltx23WorkflowBuilder(FIXTURES / "ltx23_minimal.json"),
            ModelName.H3: H3WorkflowBuilder(FIXTURES / "h3_minimal.json"),
        },
        MediaStore(database.data_root),
        render_timeout_seconds=0.1,
        status_poll_seconds=0.001,
    )
    return gateway, gpu0, gpu1, resolved_controller


def success_history(request: RenderRequest, prompt_id: str, *, subfolder: str | None = None) -> dict[str, Any]:
    save_node_id = "save_video" if request.model is ModelName.LTX else "14"
    return {
        prompt_id: {
            "status": {"completed": True, "status_str": "success", "messages": []},
            "outputs": {
                save_node_id: {
                    "videos": [
                        {
                            "filename": f"{request.item_sequence}_00001_.mp4",
                            "subfolder": str(request.job_id) if subfolder is None else subfolder,
                            "type": "output",
                        }
                    ]
                }
            },
        }
    }


def source_path(database: Database, request: RenderRequest) -> Path:
    return (
        database.data_root
        / request.gpu_slot.value.casefold()
        / "output"
        / str(request.job_id)
        / f"{request.item_sequence}_00001_.mp4"
    )


def install_media_tools(
    monkeypatch: pytest.MonkeyPatch,
    *,
    fail_frame_probe: bool = False,
    frame_count: str = "121",
    duration: str = "5.0416667",
) -> None:
    def fake_run(args: list[str], **_: object) -> CompletedProcess[str]:
        target = Path(args[-1])
        probed_frame_count = "120" if fail_frame_probe else frame_count
        has_audio = target.read_bytes().startswith(b"audio")
        streams: list[dict[str, object]] = [
            {
                "codec_type": "video",
                "width": 1344,
                "height": 768,
                "r_frame_rate": "24/1",
                "nb_frames": probed_frame_count,
            }
        ]
        if has_audio:
            streams.append({"codec_type": "audio"})
        payload = json.dumps({"streams": streams, "format": {"duration": duration}})
        return CompletedProcess(args, 0, payload, "")

    monkeypatch.setattr("backend.adapters.media.subprocess.run", fake_run)


@pytest.mark.parametrize(
    "category",
    [Category.A_VA, Category.A_VT],
)
def test_gateway_persists_va_and_vt_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    category: Category,
) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(tmp_path / category.value, category=category)
        gateway, gpu0, _, _ = make_gateway(database)
        source = source_path(database, request)
        source.parent.mkdir(parents=True)
        source.write_bytes(b"audio-source" if request.expected_has_audio else b"silent-source")
        prompt_id = await gateway.submit(request)
        workflow = gpu0.submit_calls[0][0]
        assert "empty_audio" in workflow
        if request.expected_has_audio:
            assert workflow["create_video"]["inputs"]["audio"] == ["vae_audio", 0]
        else:
            assert "vae_audio" not in workflow
            assert "audio" not in workflow["create_video"]["inputs"]
        gpu0.history = success_history(request, prompt_id)

        result = await gateway.wait(GpuSlotName.GPU0, prompt_id)

        with database.read_session() as session:
            assets = session.exec(select(Asset).order_by(Asset.id)).all()
            attempt = session.exec(select(GenerationAttempt)).one()
        assert len(assets) == 1
        assert attempt.status is GenerationAttemptStatus.COMPLETED
        assert all(asset.storage_root == str(database.data_root) for asset in assets)
        assert all(not Path(asset.relative_path).is_absolute() for asset in assets)
        assert result.output_references[0].startswith("gpu0/output/")
        assert assets[0].has_audio is request.expected_has_audio
        assert result.output_references[0] == result.output_references[1]

    install_media_tools(monkeypatch)
    run(scenario())


@pytest.mark.parametrize(
    "category",
    [Category.A_VA, Category.A_VT],
)
def test_h3_gateway_persists_native_va_and_vt_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    category: Category,
) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(
            tmp_path / category.value,
            category=category,
            model=ModelName.H3,
        )
        gateway, gpu0, _, _ = make_gateway(database)
        source = source_path(database, request)
        source.parent.mkdir(parents=True)
        media_bytes = b"audio-source" if request.expected_has_audio else b"native-silent-source"
        source.write_bytes(media_bytes)

        prompt_id = await gateway.submit(request)
        workflow = gpu0.submit_calls[0][0]
        assert workflow["5"]["inputs"]["width"] == 1344
        assert workflow["5"]["inputs"]["height"] == 768
        assert workflow["5"]["inputs"]["length"] == 124
        assert workflow["13"]["inputs"]["fps"] == 24.0
        if request.expected_has_audio:
            assert workflow["12"]["class_type"] == "VAEDecodeAudio"
            assert workflow["13"]["inputs"]["audio"] == ["12", 0]
        else:
            assert "12" not in workflow
            assert "audio" not in workflow["13"]["inputs"]
        gpu0.history = success_history(request, prompt_id)

        result = await gateway.wait(GpuSlotName.GPU0, prompt_id)

        with database.read_session() as session:
            assets = session.exec(select(Asset)).all()
            attempt = session.exec(select(GenerationAttempt)).one()
        assert len(assets) == 1
        assert assets[0].has_audio is request.expected_has_audio
        assert attempt.status is GenerationAttemptStatus.COMPLETED
        assert attempt.source_asset_id == attempt.primary_asset_id == assets[0].id
        assert result.output_references == (assets[0].relative_path, assets[0].relative_path)
        assert source.read_bytes() == media_bytes
        assert list(database.data_root.rglob("*.mp4")) == [source]

    install_media_tools(monkeypatch, frame_count="124", duration="5.1666667")
    run(scenario())


@pytest.mark.parametrize(
    ("confirm_switch", "expected_error"),
    [(False, "model_switch_confirmation_required"), (True, None)],
)
def test_gateway_requires_explicit_model_switch_confirmation(
    tmp_path: Path,
    confirm_switch: bool,
    expected_error: str | None,
) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(
            tmp_path / str(confirm_switch),
            category=Category.A_VA,
            confirm_model_switch=confirm_switch,
        )
        controller = FakeModelController(loaded_model=ModelName.H3)
        gateway, gpu0, _, _ = make_gateway(database, controller=controller)
        if expected_error is not None:
            with pytest.raises(RendererGatewayError) as error:
                await gateway.submit(request)
            assert error.value.code == expected_error
            assert gpu0.submit_calls == []
            return

        prompt_id = await gateway.submit(request)
        assert len(gpu0.submit_calls) == 1
        assert controller.calls == [(GpuSlotName.GPU0, ModelName.LTX, True)]
        assert await gateway.cancel(GpuSlotName.GPU0, prompt_id) is CancelOutcome.CANCELLED

    run(scenario())


def test_gateway_blocks_unknown_gpu_occupancy_without_submission(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(tmp_path / "occupied", category=Category.A_VA)
        controller = FakeModelController(externally_occupied=True)
        gateway, gpu0, gpu1, _ = make_gateway(database, controller=controller)

        with pytest.raises(RendererGatewayError) as error:
            await gateway.submit(request)

        assert error.value.code == "gpu_slot_unavailable"
        assert gpu0.submit_calls == [] and gpu1.submit_calls == []

    run(scenario())


@pytest.mark.parametrize(
    "change",
    [
        {"expected_has_audio": False},
        {"width": 768},
        {"height": 432},
        {"fps": 25},
        {"frame_count": 124},
        {"seed": 9},
    ],
)
def test_gateway_rejects_request_that_differs_from_immutable_snapshot(
    tmp_path: Path,
    change: dict[str, object],
) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(tmp_path / next(iter(change)), category=Category.A_VA)
        gateway, gpu0, _, controller = make_gateway(database)

        with pytest.raises(RendererGatewayError) as error:
            await gateway.submit(replace(request, **change))

        assert error.value.code == "renderer_state_invalid"
        assert gpu0.submit_calls == []
        assert controller.calls == []

    run(scenario())


def test_gateway_cancel_completion_race_persists_completed_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(tmp_path / "race", category=Category.A_VA)
        gateway, gpu0, _, _ = make_gateway(database)
        source = source_path(database, request)
        source.parent.mkdir(parents=True)
        source.write_bytes(b"audio-source")
        prompt_id = await gateway.submit(request)
        gpu0.history = success_history(request, prompt_id)
        gpu0.cancel_error = AdapterError(
            "already_completed",
            "The ComfyUI prompt already completed normally",
        )

        outcome = await gateway.cancel(GpuSlotName.GPU0, prompt_id)

        with database.read_session() as session:
            assets = session.exec(select(Asset)).all()
            attempt = session.exec(select(GenerationAttempt)).one()
        assert outcome is CancelOutcome.ALREADY_COMPLETED
        assert len(assets) == 1
        assert attempt.status is GenerationAttemptStatus.COMPLETED
        assert (GpuSlotName.GPU0, prompt_id) not in gateway._contexts

    install_media_tools(monkeypatch)
    run(scenario())


def test_gateway_rejects_out_of_root_output_reference(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(tmp_path / "escape", category=Category.A_VA)
        gateway, gpu0, _, _ = make_gateway(database)
        prompt_id = await gateway.submit(request)
        gpu0.history = success_history(request, prompt_id, subfolder="../outside")

        with pytest.raises(RendererGatewayError) as error:
            await gateway.wait(GpuSlotName.GPU0, prompt_id)

        assert error.value.code == "renderer_output_invalid"
        with database.read_session() as session:
            assert session.exec(select(Asset)).all() == []
            attempt = session.exec(select(GenerationAttempt)).one()
        assert attempt.status is GenerationAttemptStatus.FAILED

    run(scenario())


def test_gateway_rejects_vt_output_with_invalid_native_media(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(tmp_path / "media", category=Category.A_VT)
        gateway, gpu0, _, _ = make_gateway(database)
        source = source_path(database, request)
        source.parent.mkdir(parents=True)
        source.write_bytes(b"silent-source")
        prompt_id = await gateway.submit(request)
        gpu0.history = success_history(request, prompt_id)

        with pytest.raises(RendererGatewayError) as error:
            await gateway.wait(GpuSlotName.GPU0, prompt_id)

        assert error.value.code == "media_validation_failed"
        assert source.read_bytes() == b"silent-source"
        assert list(database.data_root.rglob("*.mp4")) == [source]
        with database.read_session() as session:
            assert session.exec(select(Asset)).all() == []

    install_media_tools(monkeypatch, fail_frame_probe=True)
    run(scenario())


@pytest.mark.parametrize(
    ("category", "media_bytes"),
    [
        (Category.A_VA, b"silent-source"),
        (Category.A_VT, b"audio-source"),
    ],
)
def test_gateway_enforces_category_audio_on_rendered_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    category: Category,
    media_bytes: bytes,
) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(tmp_path / category.value, category=category)
        gateway, gpu0, _, _ = make_gateway(database)
        source = source_path(database, request)
        source.parent.mkdir(parents=True)
        source.write_bytes(media_bytes)
        prompt_id = await gateway.submit(request)
        gpu0.history = success_history(request, prompt_id)

        with pytest.raises(RendererGatewayError) as error:
            await gateway.wait(GpuSlotName.GPU0, prompt_id)

        assert error.value.code == "media_validation_failed"
        with database.read_session() as session:
            assert session.exec(select(Asset)).all() == []

    install_media_tools(monkeypatch)
    run(scenario())


def test_gateway_execution_failure_is_not_retried_on_any_model_or_slot(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, request = await create_running_request(tmp_path / "failure", category=Category.A_VA)
        gateway, gpu0, gpu1, controller = make_gateway(database)
        prompt_id = await gateway.submit(request)
        gpu0.history = {
            prompt_id: {
                "status": {
                    "completed": False,
                    "status_str": "error",
                    "messages": [["execution_error", {"prompt_id": prompt_id}]],
                }
            }
        }

        with pytest.raises(RendererGatewayError) as error:
            await gateway.wait(GpuSlotName.GPU0, prompt_id)

        assert error.value.code == "renderer_execution_failed"
        assert len(gpu0.submit_calls) == 1
        assert gpu0.history_calls == 1
        assert gpu1.submit_calls == []
        assert controller.calls == [(GpuSlotName.GPU0, ModelName.LTX, False)]
        with database.read_session() as session:
            attempts = session.exec(select(GenerationAttempt)).all()
        assert len(attempts) == 1
        assert attempts[0].attempt_number == 1
        assert attempts[0].status is GenerationAttemptStatus.FAILED

    run(scenario())
