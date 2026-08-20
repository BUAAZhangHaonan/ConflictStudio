from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath

from sqlmodel import select

from backend.adapters.comfyui import AdapterError, ComfyUIClient
from backend.adapters.config import RendererSettings
from backend.adapters.database import Database
from backend.adapters.gpu import (
    PORTS,
    UNIT_DEFINITIONS,
    UNITS_BY_SLOT_PROFILE,
    SlotInspection,
    SlotInspector,
)
from backend.adapters.media import MediaError, MediaStore, PreparedMedia
from backend.adapters.model_service import ModelServiceController
from backend.adapters.renderer import (
    CancelOutcome,
    RenderRequest,
    RenderResult,
    RendererGatewayError,
    RendererInstallationStatus,
    RendererSlotState,
    ResumeOutcome,
)
from backend.adapters.workflows import (
    H3WorkflowBuilder,
    Ltx23WorkflowBuilder,
    Ltx25WorkflowBuilder,
    WorkflowTemplateError,
)
from backend.domain.enums import (
    GenerationAttemptStatus,
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobStatus,
    ModelName,
    Precision,
    validate_model_precision,
)
from backend.domain.models import (
    BatchVideoInputSnapshot,
    GenerationAttempt,
    GpuSlot,
    Job,
    JobEvent,
    JobItem,
    utc_now,
)


logger = logging.getLogger(__name__)


@dataclass
class _RenderContext:
    request: RenderRequest
    client_id: str
    prompt_id: str
    attempt_id: int
    attempt_number: int
    save_node_id: str
    last_progress: tuple[int, int] | None = None


class ProductionRendererGateway:
    configured = True
    persists_render_state = True

    def __init__(
        self,
        database: Database,
        inspector: SlotInspector,
        model_controller: ModelServiceController,
        clients: Mapping[GpuSlotName, ComfyUIClient],
        workflow_builders: Mapping[
            ModelName,
            Ltx23WorkflowBuilder | Ltx25WorkflowBuilder | H3WorkflowBuilder,
        ],
        media_store: MediaStore,
        *,
        render_timeout_seconds: float = 60 * 60,
        status_poll_seconds: float = 0.5,
    ) -> None:
        if set(clients) != set(GpuSlotName):
            raise ValueError("One ComfyUI client is required for every GPU slot")
        controlled_models = {definition.model for definition in UNIT_DEFINITIONS}
        if set(workflow_builders) != controlled_models:
            raise ValueError(
                "One workflow builder is required for every controlled renderer model"
            )
        if render_timeout_seconds <= 0 or status_poll_seconds <= 0:
            raise ValueError("Renderer timing must be positive")
        if media_store.data_root != database.data_root:
            raise ValueError("Renderer media and database roots must match")
        self.database = database
        self.inspector = inspector
        self.model_controller = model_controller
        self.clients = dict(clients)
        self.workflow_builders = dict(workflow_builders)
        self.media_store = media_store
        self.render_timeout_seconds = render_timeout_seconds
        self.status_poll_seconds = status_poll_seconds
        self._contexts: dict[tuple[GpuSlotName, str], _RenderContext] = {}
        self._event_notifier: Callable[[], None] | None = None

    @classmethod
    def from_settings(
        cls,
        database: Database,
        settings: RendererSettings,
    ) -> ProductionRendererGateway:
        if settings.unit_definitions != UNIT_DEFINITIONS:
            raise ValueError("Renderer unit definitions must match the fixed allowlist")
        urls = settings.urls_by_slot()
        if set(urls) != set(GpuSlotName):
            raise ValueError("One renderer URL is required for every GPU slot")
        for slot, port in PORTS.items():
            if urls[slot] != f"http://127.0.0.1:{port}":
                raise ValueError(
                    "Renderer URLs must match the fixed local service ports"
                )

        workflow_builders = {
            ModelName.LTX: Ltx23WorkflowBuilder(settings.ltx23_template),
            ModelName.LTX_25: Ltx25WorkflowBuilder(
                settings.ltx25_bf16_template,
                settings.ltx25_int8_template,
            ),
            ModelName.H3: H3WorkflowBuilder(settings.h3_template),
        }
        inspector = SlotInspector()
        controller = ModelServiceController(
            inspector,
            required_node_types={
                model: builder.required_class_types
                for model, builder in workflow_builders.items()
            },
            slot_urls=urls,
        )
        return cls(
            database,
            inspector,
            controller,
            {slot: ComfyUIClient(url) for slot, url in urls.items()},
            workflow_builders,
            MediaStore(database.data_root),
        )

    def set_event_notifier(self, notifier: Callable[[], None]) -> None:
        self._event_notifier = notifier

    async def probe(self, slot: GpuSlotName) -> RendererSlotState:
        return await self.inspector.inspect(slot)

    async def installation_status(self) -> RendererInstallationStatus:
        states = [await self.inspector.inspect(slot) for slot in GpuSlotName]
        statuses = {state.installation_status for state in states}
        if RendererInstallationStatus.NOT_INSTALLED in statuses:
            return RendererInstallationStatus.NOT_INSTALLED
        if statuses == {RendererInstallationStatus.INSTALLED}:
            return RendererInstallationStatus.INSTALLED
        return RendererInstallationStatus.UNKNOWN

    async def submit(self, request: RenderRequest) -> str:
        self._validate_request(request)
        try:
            ready = await self.model_controller.ensure_model(
                request.gpu_slot,
                request.model,
                precision=request.precision,
                confirm_switch=request.confirm_model_switch,
            )
            if (
                ready.availability is not GpuAvailability.AVAILABLE
                or ready.loaded_model is not request.model
                or ready.loaded_precision is not request.precision
                or ready.owned_unit is None
            ):
                raise RendererGatewayError(
                    "model_service_untrusted",
                    "The ready model service does not match the requested controlled unit",
                )
            self._record_live_model(request, ready)
            builder = self.workflow_builders[request.model]
            build_arguments = {
                "final_positive_prompt": request.positive_prompt,
                "negative_prompt": request.negative_prompt,
                "seed": request.seed,
                "job_id": request.job_id,
                "sequence": request.item_sequence,
            }
            if isinstance(builder, Ltx25WorkflowBuilder):
                if request.precision is None:
                    raise RendererGatewayError(
                        "renderer_input_invalid",
                        "LTX-2.5 rendering requires a precision profile",
                    )
                workflow = builder.build(precision=request.precision, **build_arguments)
            else:
                workflow = builder.build(**build_arguments)
            client_id = f"conflictstudio-{request.job_id}-{request.job_item_id}"
            prompt_id = await self.clients[request.gpu_slot].submit_prompt(
                workflow, client_id
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise self._safe_error(error) from error

        try:
            attempt_id, attempt_number = self._record_running(request, prompt_id)
        except Exception as error:
            cancel_error: BaseException | None = None
            try:
                await self.clients[request.gpu_slot].cancel(prompt_id)
            except asyncio.CancelledError as caught:
                cancel_error = caught
            except Exception as caught:
                cancel_error = caught
            failure_code = (
                "renderer_compensation_failed"
                if cancel_error is not None
                else "renderer_state_persist_failed"
            )
            failure_reason = (
                "The accepted render could not be recorded or cancelled"
                if cancel_error is not None
                else "The accepted render could not be recorded and was cancelled"
            )
            try:
                self._record_submit_failure(request, failure_code, failure_reason)
            except Exception as persist_error:
                logger.exception(
                    "Could not record renderer submission failure for job %s item %s",
                    request.job_id,
                    request.job_item_id,
                )
                raise RendererGatewayError(
                    "renderer_failure_record_failed",
                    "The render request failed, but the failure could not be recorded",
                ) from persist_error
            raise RendererGatewayError(failure_code, failure_reason) from (
                cancel_error or error
            )

        context = _RenderContext(
            request=request,
            client_id=client_id,
            prompt_id=prompt_id,
            attempt_id=attempt_id,
            attempt_number=attempt_number,
            save_node_id={
                ModelName.LTX: "save_video",
                ModelName.LTX_25: "4852",
                ModelName.H3: "14",
            }[request.model],
        )
        self._contexts[(request.gpu_slot, prompt_id)] = context
        return prompt_id

    async def wait(self, slot: GpuSlotName, prompt_id: str) -> RenderResult:
        context = self._contexts.get((slot, prompt_id))
        if context is None:
            raise RendererGatewayError(
                "renderer_prompt_unknown",
                "The renderer prompt is not owned by this process",
            )
        try:
            source_relative_path = await self._wait_for_output(context)
            result = self._persist_output(context, source_relative_path)
            self._contexts.pop((slot, prompt_id), None)
            return result
        except asyncio.CancelledError:
            raise
        except Exception as error:
            safe = self._safe_error(error)
            self._fail_context(context, safe.message)
            raise safe from error

    async def resume(
        self,
        request: RenderRequest,
        prompt_id: str,
        attempt_id: int,
        attempt_number: int,
    ) -> ResumeOutcome:
        self._validate_resume_request(request, prompt_id, attempt_id, attempt_number)
        context = _RenderContext(
            request=request,
            client_id=f"conflictstudio-{request.job_id}-{request.job_item_id}",
            prompt_id=prompt_id,
            attempt_id=attempt_id,
            attempt_number=attempt_number,
            save_node_id={
                ModelName.LTX: "save_video",
                ModelName.LTX_25: "4852",
                ModelName.H3: "14",
            }[request.model],
        )
        try:
            history = await self.clients[request.gpu_slot].get_history(prompt_id)
            source_relative_path = self._history_output(context, history)
            if source_relative_path is not None:
                self._persist_output(context, source_relative_path)
                return ResumeOutcome.COMPLETED
            queue = await self.clients[request.gpu_slot].get_queue()
            if not self._validate_queue_prompt(queue, prompt_id):
                return ResumeOutcome.MISSING
            self._contexts[(request.gpu_slot, prompt_id)] = context
            return ResumeOutcome.RUNNING
        except asyncio.CancelledError:
            raise
        except Exception as error:
            safe = self._safe_error(error)
            self._fail_context(context, safe.message)
            raise safe from error

    async def cancel(self, slot: GpuSlotName, prompt_id: str) -> CancelOutcome:
        context = self._contexts.get((slot, prompt_id))
        try:
            await self.clients[slot].cancel(prompt_id)
        except asyncio.CancelledError:
            raise
        except AdapterError as error:
            if (
                error.code == CancelOutcome.ALREADY_COMPLETED.value
                and context is not None
            ):
                try:
                    history = await self.clients[slot].get_history(prompt_id)
                    source_relative_path = self._history_output(context, history)
                    if source_relative_path is None:
                        raise RendererGatewayError(
                            "renderer_output_invalid",
                            "ComfyUI completed without the expected video output",
                        )
                    self._persist_output(context, source_relative_path)
                except Exception as completion_error:
                    safe = self._safe_error(completion_error)
                    self._fail_context(context, safe.message)
                    raise safe from completion_error
                self._contexts.pop((slot, prompt_id), None)
                return CancelOutcome.ALREADY_COMPLETED
            safe = self._safe_error(error)
            if context is not None:
                self._fail_context(context, safe.message)
            raise safe from error
        except Exception as error:
            safe = self._safe_error(error)
            if context is not None:
                self._fail_context(context, safe.message)
            raise safe from error
        if context is not None:
            self._fail_context(context, "The render was cancelled")
        return CancelOutcome.CANCELLED

    async def close(self) -> None:
        await asyncio.gather(
            *(client.close() for client in self.clients.values()),
            self.model_controller.close(),
        )

    async def release(
        self,
        slot: GpuSlotName,
        *,
        expected_model: ModelName,
        expected_precision: Precision | None,
        expected_unit: str,
    ) -> RendererSlotState:
        return await self.model_controller.release_model(
            slot,
            expected_model=expected_model,
            expected_precision=expected_precision,
            expected_unit=expected_unit,
        )

    def _validate_request(self, request: RenderRequest) -> None:
        with self.database.read_session() as session:
            job = session.get(Job, request.job_id)
            item = session.get(JobItem, request.job_item_id)
            snapshot = (
                session.get(BatchVideoInputSnapshot, item.input_snapshot_id)
                if item is not None
                else None
            )
            slot = session.get(GpuSlot, request.gpu_slot)
            if (
                job is None
                or item is None
                or snapshot is None
                or item.job_id != request.job_id
                or item.sequence != request.item_sequence
                or item.gpu_slot is not request.gpu_slot
                or snapshot.model is not request.model
                or snapshot.precision is not request.precision
                or snapshot.category is not request.category
                or job.category is not request.category
                or job.confirm_model_switch is not request.confirm_model_switch
                or job.status is not JobStatus.RUNNING
                or item.status is not JobStatus.RUNNING
                or item.stage is not JobItemStage.PROMPT_READY
                or slot is None
                or slot.active_job_id != job.id
                or slot.availability is not GpuAvailability.BUSY
            ):
                raise RendererGatewayError(
                    "renderer_state_invalid",
                    "The job item is not ready for rendering",
                )
        if not request.source_has_audio:
            raise RendererGatewayError(
                "renderer_input_invalid",
                "Renderer source video must contain audio",
            )
        if not validate_model_precision(request.model, request.precision):
            raise RendererGatewayError(
                "renderer_input_invalid",
                "The renderer model and precision do not match",
            )
        expected_silent = request.category.value.endswith("VT")
        if request.derive_silent_primary is not expected_silent:
            raise RendererGatewayError(
                "renderer_input_invalid",
                "Renderer media mode does not match the item category",
            )

    def _validate_resume_request(
        self,
        request: RenderRequest,
        prompt_id: str,
        attempt_id: int,
        attempt_number: int,
    ) -> None:
        with self.database.read_session() as session:
            job = session.get(Job, request.job_id)
            item = session.get(JobItem, request.job_item_id)
            attempt = session.get(GenerationAttempt, attempt_id)
            snapshot = (
                session.get(BatchVideoInputSnapshot, item.input_snapshot_id)
                if item is not None
                else None
            )
            slot = session.get(GpuSlot, request.gpu_slot)
            if (
                job is None
                or item is None
                or attempt is None
                or snapshot is None
                or item.job_id != job.id
                or job.status is not JobStatus.RUNNING
                or item.status is not JobStatus.RUNNING
                or item.stage
                not in {
                    JobItemStage.RENDERING,
                    JobItemStage.MEDIA_PROCESSING,
                }
                or item.renderer_prompt_id != prompt_id
                or attempt.job_item_id != item.id
                or attempt.attempt_number != attempt_number
                or attempt.renderer_prompt_id != prompt_id
                or attempt.status is not GenerationAttemptStatus.RUNNING
                or attempt.model is not request.model
                or attempt.precision is not request.precision
                or attempt.gpu_slot is not request.gpu_slot
                or attempt.seed != request.seed
                or snapshot.model is not request.model
                or snapshot.precision is not request.precision
                or slot is None
                or slot.active_job_id != job.id
                or slot.availability is not GpuAvailability.BUSY
            ):
                raise RendererGatewayError(
                    "renderer_state_invalid",
                    "The interrupted render state does not match this job item",
                )

    def _record_live_model(
        self, request: RenderRequest, inspection: SlotInspection
    ) -> None:
        with self.database.immediate_session() as session:
            slot = session.get(GpuSlot, request.gpu_slot)
            if (
                slot is None
                or slot.active_job_id != request.job_id
                or slot.availability is not GpuAvailability.BUSY
            ):
                raise RendererGatewayError(
                    "gpu_reservation_lost",
                    "The GPU reservation changed before rendering",
                )
            slot.loaded_model = inspection.loaded_model
            slot.loaded_precision = request.precision
            slot.checked_at = utc_now()
            slot.revision += 1

    def _record_running(
        self,
        request: RenderRequest,
        prompt_id: str,
    ) -> tuple[int, int]:
        with self.database.immediate_session() as session:
            job = session.get(Job, request.job_id)
            item = session.get(JobItem, request.job_item_id)
            attempts = session.exec(
                select(GenerationAttempt).where(
                    GenerationAttempt.job_item_id == request.job_item_id
                )
            ).all()
            attempt_number = (
                max(
                    (attempt.attempt_number for attempt in attempts),
                    default=0,
                )
                + 1
            )
            if (
                job is None
                or item is None
                or item.status is not JobStatus.RUNNING
                or item.stage is not JobItemStage.PROMPT_READY
                or item.renderer_prompt_id is not None
                or any(
                    attempt.status is GenerationAttemptStatus.RUNNING
                    for attempt in attempts
                )
            ):
                raise RendererGatewayError(
                    "renderer_state_invalid",
                    "The job item is not ready to record a render",
                )
            timestamp = utc_now()
            attempt = GenerationAttempt(
                job_item_id=item.id,
                attempt_number=attempt_number,
                model=request.model,
                precision=request.precision,
                gpu_slot=request.gpu_slot,
                seed=request.seed,
                renderer_prompt_id=prompt_id,
                status=GenerationAttemptStatus.RUNNING,
                started_at=timestamp,
            )
            session.add(attempt)
            item.stage = JobItemStage.RENDERING
            item.renderer_prompt_id = prompt_id
            item.updated_at = timestamp
            item.revision += 1
            session.add(self._event(job, item, "ItemRenderStarted"))
            session.flush()
            attempt_id = attempt.id
        self._notify_events()
        if attempt_id is None:
            raise RuntimeError("The running generation attempt has no id")
        return attempt_id, attempt_number

    async def _wait_for_output(self, context: _RenderContext) -> str:
        messages: asyncio.Queue[tuple[str, object]] = asyncio.Queue()
        client = self.clients[context.request.gpu_slot]

        async def consume_websocket() -> None:
            try:
                async for message in client.websocket_messages(context.client_id):
                    await messages.put(("message", message))
            except asyncio.CancelledError:
                raise
            except Exception as error:
                await messages.put(("error", error))
            finally:
                await messages.put(("closed", None))

        async with client.observe_prompt(context.prompt_id):
            websocket_task = asyncio.create_task(consume_websocket())
            deadline = time.monotonic() + self.render_timeout_seconds
            try:
                while True:
                    while not messages.empty():
                        kind, value = messages.get_nowait()
                        if kind == "error":
                            if isinstance(value, BaseException):
                                raise value
                            raise RuntimeError("Invalid websocket error")
                        if kind == "message" and isinstance(value, dict):
                            self._handle_websocket_message(context, value)

                    queue = await client.get_queue()
                    self._validate_queue_prompt(queue, context.prompt_id)
                    history = await client.get_history(context.prompt_id)
                    output = self._history_output(context, history)
                    if output is not None:
                        return output

                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RendererGatewayError(
                            "renderer_timeout",
                            "Rendering did not finish before the deadline",
                        )
                    try:
                        kind, value = await asyncio.wait_for(
                            messages.get(),
                            timeout=min(self.status_poll_seconds, remaining),
                        )
                    except TimeoutError:
                        continue
                    if kind == "error":
                        if isinstance(value, BaseException):
                            raise value
                        raise RuntimeError("Invalid websocket error")
                    if kind == "message" and isinstance(value, dict):
                        self._handle_websocket_message(context, value)
            finally:
                websocket_task.cancel()
                await asyncio.gather(websocket_task, return_exceptions=True)

    def _persist_output(
        self, context: _RenderContext, source_relative_path: str
    ) -> RenderResult:
        prepared: PreparedMedia | None = None
        try:
            self._record_media_processing(context)
            prepared = self.media_store.prepare_attempt(
                source_relative_path=source_relative_path,
                job_id=context.request.job_id,
                item_sequence=context.request.item_sequence,
                attempt_number=context.attempt_number,
                model=context.request.model,
                derive_silent_primary=context.request.derive_silent_primary,
            )
            source_asset_path, primary_asset_path = self._complete_attempt(
                context, prepared
            )
            return RenderResult((source_asset_path, primary_asset_path))
        except Exception:
            if prepared is not None:
                self.media_store.discard_prepared(prepared)
            raise

    def _handle_websocket_message(
        self, context: _RenderContext, payload: dict[str, object]
    ) -> None:
        event_type = payload.get("type")
        data = payload.get("data")
        if not isinstance(data, dict):
            return
        prompt_id = data.get("prompt_id")
        if prompt_id is not None and prompt_id != context.prompt_id:
            return
        if event_type == "execution_error":
            raise RendererGatewayError(
                "renderer_execution_failed",
                "ComfyUI reported that rendering failed",
            )
        if event_type == "execution_interrupted":
            raise RendererGatewayError(
                "renderer_interrupted",
                "ComfyUI reported that rendering was interrupted",
            )
        if event_type != "progress":
            return
        value = data.get("value")
        maximum = data.get("max")
        if (
            type(value) is not int
            or type(maximum) is not int
            or value < 0
            or maximum <= 0
            or value > maximum
        ):
            return
        progress = (value, maximum)
        if context.last_progress == progress:
            return
        context.last_progress = progress
        self._record_progress(context, value, maximum)

    @staticmethod
    def _validate_queue_prompt(queue: dict[str, object], prompt_id: str) -> bool:
        occurrences = 0
        for key in ("queue_running", "queue_pending"):
            entries = queue.get(key)
            if not isinstance(entries, list):
                raise RendererGatewayError(
                    "comfyui_invalid_response",
                    "ComfyUI returned an invalid response",
                )
            occurrences += sum(
                isinstance(entry, list) and len(entry) >= 2 and entry[1] == prompt_id
                for entry in entries
            )
        if occurrences > 1:
            raise RendererGatewayError(
                "comfyui_invalid_response",
                "ComfyUI returned an invalid response",
            )
        return occurrences == 1

    def _history_output(
        self, context: _RenderContext, history: dict[str, object]
    ) -> str | None:
        record = history.get(context.prompt_id)
        if record is None:
            return None
        if not isinstance(record, dict):
            raise RendererGatewayError(
                "comfyui_invalid_response",
                "ComfyUI returned an invalid response",
            )
        status = record.get("status")
        if not isinstance(status, dict):
            raise RendererGatewayError(
                "comfyui_invalid_response",
                "ComfyUI returned an invalid response",
            )
        status_text = status.get("status_str")
        messages = status.get("messages")
        if status_text in {"error", "interrupted"} or self._history_has_failure(
            messages
        ):
            raise RendererGatewayError(
                "renderer_execution_failed"
                if status_text != "interrupted"
                else "renderer_interrupted",
                "ComfyUI reported that rendering did not complete successfully",
            )
        if status.get("completed") is not True and status_text != "success":
            return None
        outputs = record.get("outputs")
        if not isinstance(outputs, dict):
            raise RendererGatewayError(
                "renderer_output_invalid",
                "ComfyUI did not return the expected video output",
            )
        node_output = outputs.get(context.save_node_id)
        if not isinstance(node_output, dict) or set(node_output) != {
            "images",
            "animated",
        }:
            raise RendererGatewayError(
                "renderer_output_invalid",
                "ComfyUI did not return the expected video output",
            )
        images = node_output.get("images")
        animated = node_output.get("animated")
        if (
            type(images) is not list
            or len(images) != 1
            or type(images[0]) is not dict
            or type(animated) is not list
            or len(animated) != 1
            or animated[0] is not True
        ):
            raise RendererGatewayError(
                "renderer_output_invalid",
                "ComfyUI did not return exactly one video output",
            )
        return self._resolve_output(context, images[0])

    @staticmethod
    def _history_has_failure(messages: object) -> bool:
        if not isinstance(messages, list):
            return False
        return any(
            isinstance(message, list)
            and bool(message)
            and message[0] in {"execution_error", "execution_interrupted"}
            for message in messages
        )

    def _resolve_output(
        self, context: _RenderContext, output: dict[str, object]
    ) -> str:
        if set(output) != {"filename", "subfolder", "type"}:
            raise RendererGatewayError(
                "renderer_output_invalid",
                "ComfyUI returned an invalid output reference",
            )
        filename = output.get("filename")
        subfolder = output.get("subfolder")
        output_type = output.get("type")
        if (
            type(filename) is not str
            or type(subfolder) is not str
            or output_type != "output"
            or not filename
            or PurePosixPath(filename).name != filename
            or "\\" in filename
            or not filename.casefold().endswith(".mp4")
            or subfolder != str(context.request.job_id)
            or not filename.startswith(f"{context.request.item_sequence}_")
        ):
            raise RendererGatewayError(
                "renderer_output_invalid",
                "ComfyUI returned an unexpected video output path",
            )
        definition = UNITS_BY_SLOT_PROFILE.get(
            (
                context.request.gpu_slot,
                context.request.model,
                context.request.precision,
            )
        )
        if definition is None:
            raise RendererGatewayError(
                "renderer_output_invalid",
                "The renderer profile is not allowlisted",
            )
        output_root_relative = f"{definition.relative_data_directory}/output"
        relative = f"{output_root_relative}/{subfolder}/{filename}"
        try:
            resolved = self.media_store.resolve(relative)
            output_root = self.media_store.resolve(output_root_relative)
            resolved.relative_to(output_root)
        except (MediaError, ValueError) as error:
            raise RendererGatewayError(
                "renderer_output_invalid",
                "ComfyUI returned an output path outside the configured data root",
            ) from error
        return self.media_store.relative_path(resolved)

    def _record_media_processing(self, context: _RenderContext) -> None:
        with self.database.immediate_session() as session:
            job = session.get(Job, context.request.job_id)
            item = session.get(JobItem, context.request.job_item_id)
            if (
                job is None
                or item is None
                or item.renderer_prompt_id != context.prompt_id
            ):
                raise RendererGatewayError(
                    "renderer_state_invalid",
                    "The rendered item state changed unexpectedly",
                )
            item.stage = JobItemStage.MEDIA_PROCESSING
            item.updated_at = utc_now()
            item.revision += 1
            session.add(self._event(job, item, "ItemMediaProcessing"))
        self._notify_events()

    def _complete_attempt(
        self,
        context: _RenderContext,
        prepared: PreparedMedia,
    ) -> tuple[str, str]:
        try:
            with self.database.immediate_session() as session:
                job = session.get(Job, context.request.job_id)
                item = session.get(JobItem, context.request.job_item_id)
                attempt = session.get(GenerationAttempt, context.attempt_id)
                if (
                    job is None
                    or item is None
                    or attempt is None
                    or attempt.status is not GenerationAttemptStatus.RUNNING
                    or item.renderer_prompt_id != context.prompt_id
                    or attempt.renderer_prompt_id != context.prompt_id
                ):
                    raise RendererGatewayError(
                        "renderer_state_invalid",
                        "The generation attempt state changed unexpectedly",
                    )
                timestamp = utc_now()
                source, primary = self.media_store.persist_completed_attempt(
                    session,
                    attempt,
                    prepared,
                    finished_at=timestamp,
                )
                item.source_asset_id = source.id
                item.primary_asset_id = primary.id
                item.updated_at = timestamp
                item.revision += 1
                session.flush()
                source_path = source.relative_path
                primary_path = primary.relative_path
        except RendererGatewayError:
            raise
        except Exception as error:
            raise RendererGatewayError(
                "renderer_state_persist_failed",
                "The completed render could not be recorded",
            ) from error
        self._notify_events()
        return source_path, primary_path

    def _record_progress(
        self, context: _RenderContext, value: int, maximum: int
    ) -> None:
        with self.database.immediate_session() as session:
            job = session.get(Job, context.request.job_id)
            item = session.get(JobItem, context.request.job_item_id)
            if (
                job is None
                or item is None
                or item.renderer_prompt_id != context.prompt_id
            ):
                return
            payload = self._event_payload(job, item)
            payload["progressValue"] = value
            payload["progressMaximum"] = maximum
            session.add(
                JobEvent(
                    job_id=job.id,
                    item_id=item.id,
                    event_type="ItemRenderProgress",
                    payload_json=json.dumps(
                        payload, ensure_ascii=False, separators=(",", ":")
                    ),
                    created_at=utc_now(),
                )
            )
        self._notify_events()

    def _mark_attempt_failed(self, context: _RenderContext, reason: str) -> None:
        try:
            with self.database.immediate_session() as session:
                attempt = session.get(GenerationAttempt, context.attempt_id)
                if (
                    attempt is None
                    or attempt.status is not GenerationAttemptStatus.RUNNING
                ):
                    return
                attempt.status = GenerationAttemptStatus.FAILED
                attempt.failure_reason = reason
                attempt.finished_at = utc_now()
        except Exception as error:
            logger.exception(
                "Could not record renderer failure for job %s item %s",
                context.request.job_id,
                context.request.job_item_id,
            )
            raise RendererGatewayError(
                "renderer_failure_record_failed",
                "The render failed, but the failure could not be recorded",
            ) from error

    def _record_submit_failure(
        self,
        request: RenderRequest,
        code: str,
        reason: str,
    ) -> None:
        with self.database.immediate_session() as session:
            job = session.get(Job, request.job_id)
            item = session.get(JobItem, request.job_item_id)
            if job is None or item is None or item.job_id != request.job_id:
                raise RuntimeError("The renderer job state no longer exists")
            if item.status in {
                JobStatus.COMPLETED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
            }:
                return

            timestamp = utc_now()
            item.status = JobStatus.FAILED
            item.failure_code = code
            item.failure_reason = reason
            item.failure_details_json = None
            item.updated_at = timestamp
            item.revision += 1

            items = session.exec(
                select(JobItem).where(JobItem.job_id == request.job_id)
            ).all()
            job.status = JobStatus.FAILED
            job.failed_count = sum(row.status is JobStatus.FAILED for row in items)
            job.failure_code = code
            job.failure_reason = reason
            job.finished_at = timestamp
            job.updated_at = timestamp
            job.revision += 1

            payload = self._event_payload(job, item)
            payload["failureCode"] = code
            payload["failureReason"] = reason
            session.add(
                JobEvent(
                    job_id=job.id,
                    item_id=item.id,
                    event_type="ItemFailed",
                    payload_json=json.dumps(
                        payload, ensure_ascii=False, separators=(",", ":")
                    ),
                    created_at=timestamp,
                )
            )
        self._notify_events()

    def _fail_context(self, context: _RenderContext, reason: str) -> None:
        try:
            self._mark_attempt_failed(context, reason)
        finally:
            self._contexts.pop(
                (context.request.gpu_slot, context.prompt_id),
                None,
            )


    @staticmethod
    def _event(job: Job, item: JobItem, event_type: str) -> JobEvent:
        return JobEvent(
            job_id=job.id,
            item_id=item.id,
            event_type=event_type,
            payload_json=json.dumps(
                ProductionRendererGateway._event_payload(job, item),
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            created_at=utc_now(),
        )

    @staticmethod
    def _event_payload(job: Job, item: JobItem) -> dict[str, int | str]:
        return {
            "preparedCount": job.prepared_count,
            "completedCount": job.completed_count,
            "failedCount": job.failed_count,
            "totalCount": job.total_count,
            "sequence": item.sequence,
            "gpuSlot": item.gpu_slot.value,
        }

    def _notify_events(self) -> None:
        if self._event_notifier is not None:
            self._event_notifier()

    @staticmethod
    def _safe_error(error: Exception) -> RendererGatewayError:
        if isinstance(error, RendererGatewayError):
            return error
        if isinstance(error, AdapterError):
            return RendererGatewayError(error.code, error.message)
        if isinstance(error, WorkflowTemplateError):
            return RendererGatewayError(error.code, error.message)
        if isinstance(error, MediaError):
            return RendererGatewayError("media_validation_failed", str(error))
        return RendererGatewayError(
            "renderer_failed",
            "The renderer failed while processing the item",
        )
