from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Query, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from backend.adapters.renderer import RendererInstallationStatus
from backend.domain.enums import GpuSlotName, ReviewDecision
from backend.domain.schemas import (
    ArchivePreviewRead,
    ArchivePreviewRequest,
    ArchiveRead,
    ArchiveSyncRequest,
    BatchDraftCreate,
    BatchDraftRead,
    BatchDraftUpdate,
    BatchPreviewRead,
    BatchPreviewRequest,
    BatchSubmitRequest,
    ContentPlanCreate,
    ContentPlanRead,
    ContentPlanUpdate,
    DatasetCreate,
    DatasetRead,
    DatasetUpdate,
    HealthRead,
    JobCancelRequest,
    JobDetailRead,
    JobEventRead,
    JobItemRead,
    JobSummaryRead,
    KeepTestResultRequest,
    PromptPresetCreate,
    PromptPresetRead,
    PromptPresetUpdate,
    PromptPreviewRead,
    PromptPreviewRequest,
    ReviewBatchCreate,
    ReviewCreate,
    ReviewerCreate,
    ReviewerRead,
    ReviewerRename,
    ReviewerStatisticsRead,
    ReviewRead,
    SampleClassificationUpdate,
    SampleRead,
    TestRunCreate,
    VideoBackgroundPresetCreate,
    VideoBackgroundPresetRead,
    VideoBackgroundPresetUpdate,
)
from backend.api.gpu_contracts import GpuMemoryRead, GpuReleaseRequest, GpuSlotRead
from backend.services.assets import AssetService
from backend.services.archives import ArchiveService
from backend.services.batches import BatchService
from backend.services.catalog import CatalogService
from backend.services.gpu_slots import GpuSlotSnapshot
from backend.services.job_executor import JobExecutor
from backend.services.samples import SampleService
from backend.services.reviewers import ReviewerService
from backend.services.reviews import ReviewService
from backend.services.statistics import StatisticsService


router = APIRouter(prefix="/api")

EVENT_REPLAY_LIMIT = 200
EVENT_POLL_SECONDS = 0.25
TERMINAL_EVENT_TYPES = {"JobCompleted", "JobFailed", "JobCancelled"}
MEDIA_CHUNK_SIZE = 1024 * 1024


def catalog(request: Request) -> CatalogService:
    return request.app.state.catalog_service


def batches(request: Request) -> BatchService:
    return request.app.state.batch_service


def assets(request: Request) -> AssetService:
    return request.app.state.asset_service


def executor(request: Request) -> JobExecutor:
    return request.app.state.job_executor


def samples(request: Request) -> SampleService:
    return request.app.state.sample_service


def reviewers(request: Request) -> ReviewerService:
    return request.app.state.reviewer_service


def reviews(request: Request) -> ReviewService:
    return request.app.state.review_service


def archives(request: Request) -> ArchiveService:
    return request.app.state.archive_service


def statistics(request: Request) -> StatisticsService:
    return request.app.state.statistics_service


async def notify_executor(job_executor: JobExecutor) -> None:
    job_executor.notify()
    job_executor.notify_events()


@router.get("/health", response_model=HealthRead)
async def health(request: Request) -> HealthRead:
    database = request.app.state.database
    renderer_installation = await request.app.state.renderer.installation_status()
    return HealthRead(
        ok=(
            database.foreign_keys_enabled()
            and renderer_installation is RendererInstallationStatus.INSTALLED
        ),
        database="ready",
        prompt_service_configured=request.app.state.prompt_model.configured,
        renderer_installation=renderer_installation.value,
    )


@router.get("/datasets", response_model=list[DatasetRead])
def list_datasets(request: Request) -> list[DatasetRead]:
    return catalog(request).list_datasets()


@router.post("/datasets", response_model=DatasetRead, status_code=status.HTTP_201_CREATED)
def create_dataset(payload: DatasetCreate, request: Request) -> DatasetRead:
    return catalog(request).create_dataset(payload)


@router.patch("/datasets/{dataset_id}", response_model=DatasetRead)
def update_dataset(dataset_id: int, payload: DatasetUpdate, request: Request) -> DatasetRead:
    return catalog(request).update_dataset(dataset_id, payload)


@router.get("/content-plans", response_model=list[ContentPlanRead])
def list_content_plans(request: Request) -> list[ContentPlanRead]:
    return catalog(request).list_content_plans()


@router.post("/content-plans", response_model=ContentPlanRead, status_code=status.HTTP_201_CREATED)
def create_content_plan(payload: ContentPlanCreate, request: Request) -> ContentPlanRead:
    return catalog(request).create_content_plan(payload)


@router.get("/content-plans/{content_id}", response_model=ContentPlanRead)
def get_content_plan(content_id: int, request: Request) -> ContentPlanRead:
    return catalog(request).get_content_plan(content_id)


@router.patch("/content-plans/{content_id}", response_model=ContentPlanRead)
def update_content_plan(content_id: int, payload: ContentPlanUpdate, request: Request) -> ContentPlanRead:
    return catalog(request).update_content_plan(content_id, payload)


@router.delete("/content-plans/{content_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_content_plan(
    content_id: int,
    request: Request,
    expected_revision: int = Query(alias="expectedRevision", ge=1),
) -> Response:
    catalog(request).delete_content_plan(content_id, expected_revision)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/prompt-presets", response_model=list[PromptPresetRead])
def list_prompt_presets(request: Request) -> list[PromptPresetRead]:
    return catalog(request).list_prompt_presets()


@router.post("/prompt-presets", response_model=PromptPresetRead, status_code=status.HTTP_201_CREATED)
def create_prompt_preset(payload: PromptPresetCreate, request: Request) -> PromptPresetRead:
    return catalog(request).create_prompt_preset(payload)


@router.get("/prompt-presets/{preset_id}", response_model=PromptPresetRead)
def get_prompt_preset(preset_id: int, request: Request) -> PromptPresetRead:
    return catalog(request).get_prompt_preset(preset_id)


@router.patch("/prompt-presets/{preset_id}", response_model=PromptPresetRead)
def update_prompt_preset(preset_id: int, payload: PromptPresetUpdate, request: Request) -> PromptPresetRead:
    return catalog(request).update_prompt_preset(preset_id, payload)


@router.delete("/prompt-presets/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_prompt_preset(
    preset_id: int,
    request: Request,
    expected_revision: int = Query(alias="expectedRevision", ge=1),
) -> Response:
    catalog(request).delete_prompt_preset(preset_id, expected_revision)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/video-background-presets", response_model=list[VideoBackgroundPresetRead])
def list_background_presets(request: Request) -> list[VideoBackgroundPresetRead]:
    return catalog(request).list_background_presets()


@router.post(
    "/video-background-presets",
    response_model=VideoBackgroundPresetRead,
    status_code=status.HTTP_201_CREATED,
)
def create_background_preset(
    payload: VideoBackgroundPresetCreate,
    request: Request,
) -> VideoBackgroundPresetRead:
    return catalog(request).create_background_preset(payload)


@router.get("/video-background-presets/{preset_id}", response_model=VideoBackgroundPresetRead)
def get_background_preset(preset_id: int, request: Request) -> VideoBackgroundPresetRead:
    return catalog(request).get_background_preset(preset_id)


@router.patch("/video-background-presets/{preset_id}", response_model=VideoBackgroundPresetRead)
def update_background_preset(
    preset_id: int,
    payload: VideoBackgroundPresetUpdate,
    request: Request,
) -> VideoBackgroundPresetRead:
    return catalog(request).update_background_preset(preset_id, payload)


@router.delete("/video-background-presets/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_background_preset(
    preset_id: int,
    request: Request,
    expected_revision: int = Query(alias="expectedRevision", ge=1),
) -> Response:
    catalog(request).delete_background_preset(preset_id, expected_revision)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/prompt-preview", response_model=PromptPreviewRead)
def preview_prompt(payload: PromptPreviewRequest, request: Request) -> PromptPreviewRead:
    return batches(request).preview_prompt(payload)


@router.post("/test-runs", response_model=JobDetailRead, status_code=status.HTTP_202_ACCEPTED)
async def submit_test_run(payload: TestRunCreate, request: Request) -> Response:
    job = await batches(request).submit_test_run(payload)
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content=job.model_dump(mode="json", by_alias=True),
        headers={"Location": f"/api/jobs/{job.id}"},
        background=BackgroundTask(notify_executor, executor(request)),
    )


@router.get("/batch-drafts", response_model=list[BatchDraftRead])
def list_batch_drafts(request: Request) -> list[BatchDraftRead]:
    return batches(request).list_batch_drafts()


@router.post("/batch-drafts", response_model=BatchDraftRead, status_code=status.HTTP_201_CREATED)
def create_batch_draft(payload: BatchDraftCreate, request: Request) -> BatchDraftRead:
    return batches(request).create_batch_draft(payload)


@router.get("/batch-drafts/{draft_id}", response_model=BatchDraftRead)
def get_batch_draft(draft_id: int, request: Request) -> BatchDraftRead:
    return batches(request).get_batch_draft(draft_id)


@router.put("/batch-drafts/{draft_id}", response_model=BatchDraftRead)
def update_batch_draft(draft_id: int, payload: BatchDraftUpdate, request: Request) -> BatchDraftRead:
    return batches(request).update_batch_draft(draft_id, payload)


@router.delete("/batch-drafts/{draft_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_batch_draft(
    draft_id: int,
    request: Request,
    expected_revision: int = Query(alias="expectedRevision", ge=1),
) -> Response:
    batches(request).delete_batch_draft(draft_id, expected_revision)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/batch-drafts/{draft_id}/preview", response_model=BatchPreviewRead)
async def preview_batch(draft_id: int, payload: BatchPreviewRequest, request: Request) -> BatchPreviewRead:
    return await batches(request).preview_batch(draft_id, payload.expected_revision)


@router.post("/batch-drafts/{draft_id}/submit", response_model=JobDetailRead, status_code=status.HTTP_202_ACCEPTED)
async def submit_batch(draft_id: int, payload: BatchSubmitRequest, request: Request) -> Response:
    job = await batches(request).submit_batch(draft_id, payload)
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content=job.model_dump(mode="json", by_alias=True),
        headers={"Location": f"/api/jobs/{job.id}"},
        background=BackgroundTask(notify_executor, executor(request)),
    )


@router.get("/jobs", response_model=list[JobSummaryRead])
def list_jobs(request: Request) -> list[JobSummaryRead]:
    return batches(request).list_jobs()


@router.get("/jobs/{job_id}", response_model=JobDetailRead)
def get_job(job_id: int, request: Request) -> JobDetailRead:
    return batches(request).get_job(job_id)


@router.get("/jobs/{job_id}/items", response_model=list[JobItemRead])
def list_job_items(
    job_id: int,
    request: Request,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[JobItemRead]:
    return batches(request).list_job_items(job_id, offset, limit)


@router.post("/job-items/{item_id}/keep", response_model=SampleRead, status_code=status.HTTP_201_CREATED)
def keep_test_result(item_id: int, payload: KeepTestResultRequest, request: Request) -> SampleRead:
    return samples(request).keep_test_result(item_id, payload)


@router.get("/samples", response_model=list[SampleRead])
def list_samples(
    request: Request,
    decision: ReviewDecision | None = Query(default=None),
) -> list[SampleRead]:
    return samples(request).list_samples(decision)


@router.get("/samples/{sample_id}", response_model=SampleRead)
def get_sample(sample_id: int, request: Request) -> SampleRead:
    return samples(request).get_sample(sample_id)


@router.patch("/samples/{sample_id}/classification", response_model=SampleRead)
def update_sample_classification(
    sample_id: int,
    payload: SampleClassificationUpdate,
    request: Request,
) -> SampleRead:
    return samples(request).update_classification(sample_id, payload)


@router.get("/reviewers", response_model=list[ReviewerRead])
def list_reviewers(request: Request) -> list[ReviewerRead]:
    return reviewers(request).list_reviewers()


@router.post("/reviewers", response_model=ReviewerRead, status_code=status.HTTP_201_CREATED)
def create_reviewer(payload: ReviewerCreate, request: Request) -> ReviewerRead:
    return reviewers(request).create(payload)


@router.patch("/reviewers/{reviewer_id}", response_model=ReviewerRead)
def rename_reviewer(
    reviewer_id: int,
    payload: ReviewerRename,
    request: Request,
) -> ReviewerRead:
    return reviewers(request).rename(reviewer_id, payload)


@router.get("/reviews", response_model=list[ReviewRead])
def list_reviews(
    request: Request,
    sample_id: int = Query(alias="sampleId", gt=0),
) -> list[ReviewRead]:
    return reviews(request).list_for_sample(sample_id)


@router.post("/reviews", response_model=SampleRead, status_code=status.HTTP_201_CREATED)
def create_review(payload: ReviewCreate, request: Request) -> SampleRead:
    return reviews(request).create(payload)


@router.post("/reviews/batch", response_model=list[SampleRead], status_code=status.HTTP_201_CREATED)
def create_reviews_batch(payload: ReviewBatchCreate, request: Request) -> list[SampleRead]:
    return reviews(request).create_batch(payload)


@router.get("/reviewers/{reviewer_id}/statistics", response_model=ReviewerStatisticsRead)
def reviewer_statistics(
    reviewer_id: int,
    request: Request,
    dataset_id: int | None = Query(default=None, alias="datasetId", gt=0),
    start_date: date | None = Query(default=None, alias="startDate"),
    end_date: date | None = Query(default=None, alias="endDate"),
) -> ReviewerStatisticsRead:
    return statistics(request).reviewer_statistics(
        reviewer_id,
        dataset_id,
        start_date,
        end_date,
    )


@router.get("/archives", response_model=list[ArchiveRead])
def list_archives(request: Request) -> list[ArchiveRead]:
    return archives(request).list_archives()


@router.post("/archives/preview", response_model=ArchivePreviewRead)
def preview_archive(payload: ArchivePreviewRequest, request: Request) -> ArchivePreviewRead:
    return archives(request).preview(payload)


@router.post("/archives/sync", response_model=ArchiveRead)
def sync_archive(payload: ArchiveSyncRequest, request: Request) -> ArchiveRead:
    return archives(request).sync(payload)


@router.get("/archives/{dataset_id}/manifest", response_class=Response)
def download_archive_manifest(dataset_id: int, request: Request) -> Response:
    path = archives(request).manifest_path(dataset_id)
    return Response(
        path.read_bytes(),
        media_type="application/x-ndjson",
        headers={"Content-Disposition": f'attachment; filename="dataset-{dataset_id}-manifest.jsonl"'},
    )


@router.get(
    "/media/{asset_id}",
    response_class=Response,
    operation_id="get_media_asset",
)
def get_media_asset(asset_id: int, request: Request) -> Response:
    return _read_media_asset(asset_id, request, include_body=True)


@router.head(
    "/media/{asset_id}",
    response_class=Response,
    operation_id="head_media_asset",
)
def head_media_asset(asset_id: int, request: Request) -> Response:
    return _read_media_asset(asset_id, request, include_body=False)


def _read_media_asset(asset_id: int, request: Request, *, include_body: bool) -> Response:
    path, media_type, evidence = assets(request).content(asset_id)
    range_header = request.headers.get("range")
    if range_header is None:
        start = 0
        end = evidence.st_size - 1
        response_status = status.HTTP_200_OK
    else:
        try:
            start, end = _parse_byte_range(range_header, evidence.st_size)
        except _MalformedRangeError:
            return Response(
                status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
                headers=_media_headers(
                    media_type,
                    0,
                    content_range=f"bytes */{evidence.st_size}",
                ),
            )
        except _UnsatisfiableRangeError:
            return Response(
                status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
                headers=_media_headers(
                    media_type,
                    0,
                    content_range=f"bytes */{evidence.st_size}",
                ),
            )
        response_status = status.HTTP_206_PARTIAL_CONTENT

    content_length = end - start + 1
    content_range = (
        f"bytes {start}-{end}/{evidence.st_size}"
        if response_status == status.HTTP_206_PARTIAL_CONTENT
        else None
    )
    headers = _media_headers(media_type, content_length, content_range=content_range)
    if not include_body:
        return Response(status_code=response_status, headers=headers)
    return StreamingResponse(
        _stream_file(path, start, content_length),
        status_code=response_status,
        headers=headers,
    )


def _parse_byte_range(value: str, size: int) -> tuple[int, int]:
    unit, separator, specification = value.partition("=")
    if separator != "=" or unit != "bytes" or not specification or "," in specification:
        raise _MalformedRangeError
    start_text, dash, end_text = specification.partition("-")
    if dash != "-" or "-" in end_text or (not start_text and not end_text):
        raise _MalformedRangeError

    if start_text:
        if not _is_ascii_digits(start_text) or (end_text and not _is_ascii_digits(end_text)):
            raise _MalformedRangeError
        start = int(start_text)
        if start >= size:
            raise _UnsatisfiableRangeError
        end = min(int(end_text), size - 1) if end_text else size - 1
        if end < start:
            raise _UnsatisfiableRangeError
        return start, end

    if not _is_ascii_digits(end_text):
        raise _MalformedRangeError
    suffix_length = int(end_text)
    if suffix_length == 0 or size == 0:
        raise _UnsatisfiableRangeError
    return max(size - suffix_length, 0), size - 1


def _is_ascii_digits(value: str) -> bool:
    return value.isascii() and value.isdigit()


def _media_headers(
    media_type: str,
    content_length: int,
    *,
    content_range: str | None = None,
) -> dict[str, str]:
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        "Content-Length": str(content_length),
        "Content-Type": media_type,
    }
    if content_range is not None:
        headers["Content-Range"] = content_range
    return headers


def _stream_file(path: Path, start: int, content_length: int) -> Iterator[bytes]:
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = content_length
        while remaining:
            chunk = handle.read(min(MEDIA_CHUNK_SIZE, remaining))
            if not chunk:
                return
            remaining -= len(chunk)
            yield chunk


class _MalformedRangeError(ValueError):
    pass


class _UnsatisfiableRangeError(ValueError):
    pass


@router.get("/jobs/{job_id}/events", response_model=list[JobEventRead])
def list_job_events(
    job_id: int,
    request: Request,
    after_event_id: int = Query(default=0, alias="afterEventId", ge=0),
    limit: int = Query(default=200, ge=1, le=500),
) -> list[JobEventRead]:
    return batches(request).list_job_events(job_id, after_event_id, limit)


@router.websocket("/ws/jobs/{job_id}")
async def replay_job_events(
    websocket: WebSocket,
    job_id: int,
    after_event_id: int = Query(default=0, alias="afterEventId", ge=0),
) -> None:
    batch_service: BatchService = websocket.app.state.batch_service
    job_executor: JobExecutor = websocket.app.state.job_executor
    signal = job_executor.subscribe_events()
    receive_task: asyncio.Task[dict[str, object]] | None = None
    signal_task: asyncio.Task[bool] | None = None
    poll_task: asyncio.Task[None] | None = None
    try:
        if not batch_service.job_exists(job_id):
            await websocket.accept()
            await websocket.close(code=4404, reason="The requested job does not exist")
            return

        await websocket.accept()
        cursor = after_event_id
        while True:
            signal.clear()
            events, job_terminal = batch_service.list_job_events_snapshot(job_id, cursor, EVENT_REPLAY_LIMIT)
            terminal_sent = False
            for event in events:
                if event.id <= cursor:
                    continue
                await websocket.send_json(event.model_dump(mode="json", by_alias=True))
                cursor = event.id
                terminal_sent = terminal_sent or event.event_type in TERMINAL_EVENT_TYPES

            replay_exhausted = len(events) < EVENT_REPLAY_LIMIT
            if terminal_sent or (job_terminal and replay_exhausted):
                await websocket.close(code=1000, reason="Job event stream completed")
                return
            if not replay_exhausted:
                continue

            if receive_task is None:
                receive_task = asyncio.create_task(websocket.receive())
            signal_task = asyncio.create_task(signal.wait())
            poll_task = asyncio.create_task(asyncio.sleep(EVENT_POLL_SECONDS))
            done, _ = await asyncio.wait(
                {signal_task, receive_task, poll_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if receive_task in done:
                message = receive_task.result()
                if message["type"] == "websocket.disconnect":
                    return
                receive_task = asyncio.create_task(websocket.receive())
            iteration_tasks = (signal_task, poll_task)
            for task in iteration_tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*iteration_tasks, return_exceptions=True)
            signal_task = None
            poll_task = None
    except (WebSocketDisconnect, asyncio.CancelledError):
        return
    finally:
        pending = [task for task in (receive_task, signal_task, poll_task) if task is not None and not task.done()]
        for task in pending:
            task.cancel()
        job_executor.unsubscribe_events(signal)
        if pending:
            try:
                await asyncio.gather(*pending, return_exceptions=True)
            except asyncio.CancelledError:
                pass


@router.post("/jobs/{job_id}/cancel", response_model=JobDetailRead, status_code=status.HTTP_202_ACCEPTED)
async def cancel_job(job_id: int, payload: JobCancelRequest, request: Request) -> JobDetailRead:
    await executor(request).cancel_job(job_id, payload)
    return batches(request).get_job(job_id)


def _gpu_slot_read(snapshot: GpuSlotSnapshot) -> GpuSlotRead:
    return GpuSlotRead(
        slot=snapshot.slot,
        availability=snapshot.availability,
        loaded_model=snapshot.loaded_model,
        loaded_precision=snapshot.loaded_precision,
        service_status=snapshot.service_status,
        gpu_name=snapshot.gpu_name,
        memory=GpuMemoryRead(
            usedMiB=snapshot.memory_used_mib,
            totalMiB=snapshot.memory_total_mib,
        ),
        active_job_id=snapshot.active_job_id,
        revision=snapshot.revision,
        checked_at=snapshot.checked_at,
        status_reason=snapshot.status_reason,
    )


@router.get("/gpu-slots", response_model=list[GpuSlotRead])
async def list_gpu_slots(request: Request) -> list[GpuSlotRead]:
    return [_gpu_slot_read(snapshot) for snapshot in await batches(request).list_gpu_slots()]


@router.post("/gpu-slots/{slot}/release", response_model=GpuSlotRead)
async def release_gpu_slot(slot: GpuSlotName, payload: GpuReleaseRequest, request: Request) -> GpuSlotRead:
    snapshot = await batches(request).release_gpu_slot(slot, payload.expected_revision)
    return _gpu_slot_read(snapshot)
