from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Literal

from fastapi import (
    APIRouter,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from backend.adapters.renderer import RendererInstallationStatus
from backend.domain.enums import (
    Category,
    ConflictDirection,
    ContentStatus,
    GpuSlotName,
    JobSource,
    JobStatus,
    Protocol,
    Relation,
    ResourceStatus,
    ReviewDecision,
    TemplateVersionStatus,
)
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
    ContentScriptCreate,
    ContentScriptSceneRead,
    ContentScriptRead,
    ContentScriptUpdate,
    DatasetCreate,
    DatasetMergeRead,
    DatasetMergeRequest,
    DatasetRead,
    DatasetUpdate,
    GenerationAttemptRead,
    HealthRead,
    JobCancelRequest,
    JobResumeRequest,
    JobRetryFailedRequest,
    JobDetailRead,
    JobEventRead,
    JobItemRead,
    JobSummaryRead,
    PageRead,
    PromptTemplateCreate,
    PromptTemplateRead,
    PromptTemplateUpdate,
    PromptTemplateVersionCreate,
    PromptTemplateVersionRead,
    PromptTemplateVersionVerify,
    PromptPreviewRead,
    PromptPreviewRequest,
    ReviewBatchCreate,
    ReviewCreate,
    ReviewNoteDraftRead,
    ReviewNoteDraftUpdate,
    ReviewQueueFilter,
    ReviewerCreate,
    ReviewerRead,
    ReviewerRename,
    ReviewerStatisticsRead,
    ResourceAssistantApply,
    ResourceAssistantApplyRead,
    ResourceAssistantProposalRead,
    ResourceAssistantPropose,
    ReviewRead,
    ReviewSampleDetailRead,
    ReviewSampleListRead,
    ReviewSubmissionRead,
    SampleClassificationChangeRead,
    SampleClassificationUpdate,
    PromptTestCreate,
    VideoTestCreate,
    SceneCreate,
    SceneRead,
    SceneUpdate,
)
from backend.api.gpu_contracts import GpuMemoryRead, GpuReleaseRequest, GpuSlotRead
from backend.services.assets import AssetService
from backend.services.archives import ArchiveService
from backend.services.batches import BatchService
from backend.services.catalog import CatalogService
from backend.services.resource_assistant import ResourceAssistantService
from backend.services.gpu_slots import GpuSlotSnapshot
from backend.services.job_executor import JobExecutor
from backend.services.samples import SampleService
from backend.services.reviewers import ReviewerService
from backend.services.reviews import ReviewService
from backend.services.statistics import StatisticsService
from backend.services.pagination import PAGE_SIZE


router = APIRouter(prefix="/api")

EVENT_REPLAY_LIMIT = PAGE_SIZE
EVENT_POLL_SECONDS = 0.25
TERMINAL_EVENT_TYPES = {"JobCompleted", "JobFailed", "JobCancelled", "JobInterrupted"}
MEDIA_CHUNK_SIZE = 1024 * 1024


def catalog(request: Request) -> CatalogService:
    return request.app.state.catalog_service


def batches(request: Request) -> BatchService:
    return request.app.state.batch_service


def resource_assistant(request: Request) -> ResourceAssistantService:
    return request.app.state.resource_assistant_service


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


@router.get("/datasets", response_model=PageRead[DatasetRead])
def list_datasets(
    request: Request,
    page: int = Query(default=1, ge=1),
    search: str | None = Query(default=None, min_length=1, max_length=160),
    status_filter: ResourceStatus | None = Query(default=None, alias="status"),
) -> PageRead[DatasetRead]:
    return catalog(request).list_datasets(page, search, status_filter)


@router.get("/datasets/{dataset_id}", response_model=DatasetRead)
def get_dataset(dataset_id: int, request: Request) -> DatasetRead:
    return catalog(request).get_dataset(dataset_id)


@router.post(
    "/datasets", response_model=DatasetRead, status_code=status.HTTP_201_CREATED
)
def create_dataset(payload: DatasetCreate, request: Request) -> DatasetRead:
    return catalog(request).create_dataset(payload)


@router.patch("/datasets/{dataset_id}", response_model=DatasetRead)
def update_dataset(
    dataset_id: int, payload: DatasetUpdate, request: Request
) -> DatasetRead:
    return catalog(request).update_dataset(dataset_id, payload)


@router.post("/datasets/{dataset_id}/merge", response_model=DatasetMergeRead)
def merge_datasets(
    dataset_id: int,
    payload: DatasetMergeRequest,
    request: Request,
) -> DatasetMergeRead:
    return catalog(request).merge_datasets(dataset_id, payload)


@router.delete("/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(
    dataset_id: int,
    request: Request,
    expected_revision: int = Query(alias="expectedRevision", ge=1),
) -> Response:
    catalog(request).delete_dataset(dataset_id, expected_revision)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/content-scripts", response_model=PageRead[ContentScriptRead])
def list_content_scripts(
    request: Request,
    page: int = Query(default=1, ge=1),
    search: str | None = Query(default=None, min_length=1, max_length=120),
    status_filter: ContentStatus | None = Query(default=None, alias="status"),
    category: Category | None = Query(default=None),
    direction: ConflictDirection | None = Query(default=None),
) -> PageRead[ContentScriptRead]:
    return catalog(request).list_content_scripts(
        page,
        search,
        status_filter,
        category,
        direction,
    )


@router.post(
    "/content-scripts",
    response_model=ContentScriptRead,
    status_code=status.HTTP_201_CREATED,
)
def create_content_script(
    payload: ContentScriptCreate, request: Request
) -> ContentScriptRead:
    return catalog(request).create_content_script(payload)


@router.get("/content-scripts/{content_id}", response_model=ContentScriptRead)
def get_content_script(content_id: int, request: Request) -> ContentScriptRead:
    return catalog(request).get_content_script(content_id)


@router.patch("/content-scripts/{content_id}", response_model=ContentScriptRead)
def update_content_script(
    content_id: int, payload: ContentScriptUpdate, request: Request
) -> ContentScriptRead:
    return catalog(request).update_content_script(content_id, payload)


@router.get(
    "/content-scripts/{content_id}/scenes",
    response_model=ContentScriptSceneRead,
)
def get_content_scenes(
    content_id: int,
    request: Request,
) -> ContentScriptSceneRead:
    return catalog(request).get_content_scenes(content_id)


@router.delete("/content-scripts/{content_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_content_script(
    content_id: int,
    request: Request,
    expected_revision: int = Query(alias="expectedRevision", ge=1),
) -> Response:
    catalog(request).delete_content_script(content_id, expected_revision)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/prompt-templates", response_model=PageRead[PromptTemplateRead])
def list_prompt_templates(
    request: Request,
    page: int = Query(default=1, ge=1),
    category: Category | None = Query(default=None),
) -> PageRead[PromptTemplateRead]:
    return catalog(request).list_prompt_templates(page, category)


@router.post(
    "/prompt-templates",
    response_model=PromptTemplateRead,
    status_code=status.HTTP_201_CREATED,
)
def create_prompt_template(
    payload: PromptTemplateCreate,
    request: Request,
) -> PromptTemplateRead:
    return catalog(request).create_prompt_template(payload)


@router.get("/prompt-templates/{template_id}", response_model=PromptTemplateRead)
def get_prompt_template(
    template_id: int,
    request: Request,
) -> PromptTemplateRead:
    return catalog(request).get_prompt_template(template_id)


@router.patch("/prompt-templates/{template_id}", response_model=PromptTemplateRead)
def update_prompt_template(
    template_id: int,
    payload: PromptTemplateUpdate,
    request: Request,
) -> PromptTemplateRead:
    return catalog(request).update_prompt_template(template_id, payload)


@router.get(
    "/prompt-templates/{template_id}/versions",
    response_model=PageRead[PromptTemplateVersionRead],
)
def list_prompt_template_versions(
    template_id: int,
    request: Request,
    page: int = Query(default=1, ge=1),
    verification_status: TemplateVersionStatus | None = Query(
        default=None, alias="verificationStatus"
    ),
) -> PageRead[PromptTemplateVersionRead]:
    return catalog(request).list_prompt_template_versions(
        template_id, page, verification_status
    )


@router.post(
    "/prompt-templates/{template_id}/versions",
    response_model=PromptTemplateVersionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_prompt_template_version(
    template_id: int,
    payload: PromptTemplateVersionCreate,
    request: Request,
) -> PromptTemplateVersionRead:
    return catalog(request).create_prompt_template_version(template_id, payload)


@router.get(
    "/prompt-template-versions/{version_id}",
    response_model=PromptTemplateVersionRead,
)
def get_prompt_template_version(
    version_id: int,
    request: Request,
) -> PromptTemplateVersionRead:
    return catalog(request).get_prompt_template_version(version_id)


@router.post(
    "/prompt-template-versions/{version_id}/verify",
    response_model=PromptTemplateVersionRead,
)
def verify_prompt_template_version(
    version_id: int,
    payload: PromptTemplateVersionVerify,
    request: Request,
) -> PromptTemplateVersionRead:
    return catalog(request).verify_prompt_template_version(version_id, payload)


@router.get(
    "/scenes",
    response_model=PageRead[SceneRead],
)
def list_scenes(
    request: Request,
    page: int = Query(default=1, ge=1),
) -> PageRead[SceneRead]:
    return catalog(request).list_scenes(page)


@router.post(
    "/scenes",
    response_model=SceneRead,
    status_code=status.HTTP_201_CREATED,
)
def create_scene(
    payload: SceneCreate,
    request: Request,
) -> SceneRead:
    return catalog(request).create_scene(payload)


@router.get("/scenes/{preset_id}", response_model=SceneRead)
def get_scene(preset_id: int, request: Request) -> SceneRead:
    return catalog(request).get_scene(preset_id)


@router.patch("/scenes/{preset_id}", response_model=SceneRead)
def update_scene(
    preset_id: int,
    payload: SceneUpdate,
    request: Request,
) -> SceneRead:
    return catalog(request).update_scene(preset_id, payload)


@router.delete("/scenes/{preset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_scene(
    preset_id: int,
    request: Request,
    expected_revision: int = Query(alias="expectedRevision", ge=1),
) -> Response:
    catalog(request).delete_scene(preset_id, expected_revision)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/prompt-preview", response_model=PromptPreviewRead)
def preview_prompt(
    payload: PromptPreviewRequest, request: Request
) -> PromptPreviewRead:
    return batches(request).preview_prompt(payload)


@router.post(
    "/resource-assistant/propose",
    response_model=ResourceAssistantProposalRead,
)
async def propose_resources(
    payload: ResourceAssistantPropose,
    request: Request,
) -> ResourceAssistantProposalRead:
    return await resource_assistant(request).propose(payload)


@router.post(
    "/resource-assistant/apply",
    response_model=ResourceAssistantApplyRead,
    status_code=status.HTTP_201_CREATED,
)
def apply_resources(
    payload: ResourceAssistantApply,
    request: Request,
) -> ResourceAssistantApplyRead:
    return resource_assistant(request).apply(payload)


@router.post(
    "/test-runs/prompt",
    response_model=JobDetailRead,
    status_code=status.HTTP_201_CREATED,
)
async def submit_prompt_test(
    payload: PromptTestCreate,
    request: Request,
) -> Response:
    job = await batches(request).submit_prompt_test(payload)
    return JSONResponse(
        status_code=status.HTTP_201_CREATED,
        content=job.model_dump(mode="json", by_alias=True),
        headers={"Location": f"/api/test-results/{job.id}"},
    )


@router.post(
    "/test-runs/video",
    response_model=JobDetailRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_video_test(payload: VideoTestCreate, request: Request) -> Response:
    job = await batches(request).submit_video_test(payload)
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content=job.model_dump(mode="json", by_alias=True),
        headers={"Location": f"/api/test-results/{job.id}"},
        background=BackgroundTask(notify_executor, executor(request)),
    )


@router.post(
    "/batch-drafts", response_model=BatchDraftRead, status_code=status.HTTP_201_CREATED
)
def create_batch_draft(payload: BatchDraftCreate, request: Request) -> BatchDraftRead:
    return batches(request).create_batch_draft(payload)


@router.put("/batch-drafts/{draft_id}", response_model=BatchDraftRead)
def update_batch_draft(
    draft_id: int, payload: BatchDraftUpdate, request: Request
) -> BatchDraftRead:
    return batches(request).update_batch_draft(draft_id, payload)


@router.post("/batch-drafts/{draft_id}/preview", response_model=BatchPreviewRead)
async def preview_batch(
    draft_id: int, payload: BatchPreviewRequest, request: Request
) -> BatchPreviewRead:
    return await batches(request).preview_batch(draft_id, payload.expected_revision)


@router.post(
    "/batch-drafts/{draft_id}/submit",
    response_model=JobDetailRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_batch(
    draft_id: int, payload: BatchSubmitRequest, request: Request
) -> Response:
    job = await batches(request).submit_batch(draft_id, payload)
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content=job.model_dump(mode="json", by_alias=True),
        headers={"Location": f"/api/generation-results/{job.id}"},
        background=BackgroundTask(notify_executor, executor(request)),
    )


@router.get("/test-results", response_model=PageRead[JobSummaryRead])
def list_test_results(
    request: Request,
    page: int = Query(default=1, ge=1),
    source: JobSource | None = Query(default=None),
    status_filter: list[JobStatus] | None = Query(default=None, alias="status"),
) -> PageRead[JobSummaryRead]:
    return batches(request).list_test_results(page, source, status_filter)


@router.get("/test-results/{job_id}", response_model=JobDetailRead)
def get_test_result(job_id: int, request: Request) -> JobDetailRead:
    return batches(request).get_test_result(job_id)


@router.get("/test-results/{job_id}/items", response_model=PageRead[JobItemRead])
def list_test_result_items(
    job_id: int,
    request: Request,
    page: int = Query(default=1, ge=1),
) -> PageRead[JobItemRead]:
    return batches(request).list_test_result_items(job_id, page)


@router.get("/generation-results", response_model=PageRead[JobSummaryRead])
def list_production_results(
    request: Request,
    page: int = Query(default=1, ge=1),
    status_filter: list[JobStatus] | None = Query(default=None, alias="status"),
) -> PageRead[JobSummaryRead]:
    return batches(request).list_production_results(page, status_filter)


@router.get("/generation-results/{job_id}", response_model=JobDetailRead)
def get_production_result(job_id: int, request: Request) -> JobDetailRead:
    return batches(request).get_production_result(job_id)


@router.get(
    "/generation-results/{job_id}/items",
    response_model=PageRead[JobItemRead],
)
def list_production_result_items(
    job_id: int,
    request: Request,
    page: int = Query(default=1, ge=1),
) -> PageRead[JobItemRead]:
    return batches(request).list_production_result_items(job_id, page)


@router.get(
    "/job-items/{item_id}/attempts",
    response_model=PageRead[GenerationAttemptRead],
)
def list_job_attempts(
    item_id: int,
    request: Request,
    page: int = Query(default=1, ge=1),
) -> PageRead[GenerationAttemptRead]:
    return batches(request).list_job_attempts(item_id, page)


@router.get("/samples", response_model=PageRead[ReviewSampleListRead])
def list_samples(
    request: Request,
    decision: Literal[
        "All",
        ReviewDecision.PENDING,
        ReviewDecision.ACCEPTED,
        ReviewDecision.REJECTED,
    ] = Query(default="All"),
    dataset_id: int | None = Query(default=None, alias="datasetId", gt=0),
    protocol: Protocol | None = Query(default=None),
    relation: Relation | None = Query(default=None),
    direction: ConflictDirection | None = Query(default=None),
    search: str | None = Query(
        default=None,
        min_length=1,
        max_length=160,
        pattern=r".*\S.*",
    ),
    in_archive: bool | None = Query(default=None, alias="inArchive"),
    page: int = Query(default=1, ge=1),
) -> PageRead[ReviewSampleListRead]:
    return samples(request).list_samples(
        page,
        ReviewQueueFilter(
            decision=decision,
            dataset_id=dataset_id,
            protocol=protocol,
            relation=relation,
            direction=direction,
            search=search,
            in_archive=in_archive,
        ),
    )


@router.get("/samples/{sample_id}", response_model=ReviewSampleDetailRead)
def get_sample(sample_id: int, request: Request) -> ReviewSampleDetailRead:
    return samples(request).get_sample(sample_id)


@router.get(
    "/samples/{sample_id}/classification-history",
    response_model=PageRead[SampleClassificationChangeRead],
)
def list_sample_classification_history(
    sample_id: int,
    request: Request,
    page: int = Query(default=1, ge=1),
) -> PageRead[SampleClassificationChangeRead]:
    return samples(request).list_classification_history(sample_id, page)


@router.patch(
    "/samples/{sample_id}/classification",
    response_model=ReviewSampleDetailRead,
)
def update_sample_classification(
    sample_id: int,
    payload: SampleClassificationUpdate,
    request: Request,
) -> ReviewSampleDetailRead:
    return samples(request).update_classification(sample_id, payload)


@router.get("/reviewers", response_model=PageRead[ReviewerRead])
def list_reviewers(
    request: Request,
    page: int = Query(default=1, ge=1),
) -> PageRead[ReviewerRead]:
    return reviewers(request).list_reviewers(page)


@router.get("/reviewers/{reviewer_id}", response_model=ReviewerRead)
def get_reviewer(reviewer_id: int, request: Request) -> ReviewerRead:
    return reviewers(request).get(reviewer_id)


@router.post(
    "/reviewers", response_model=ReviewerRead, status_code=status.HTTP_201_CREATED
)
def create_reviewer(payload: ReviewerCreate, request: Request) -> ReviewerRead:
    return reviewers(request).create(payload)


@router.patch("/reviewers/{reviewer_id}", response_model=ReviewerRead)
def rename_reviewer(
    reviewer_id: int,
    payload: ReviewerRename,
    request: Request,
) -> ReviewerRead:
    return reviewers(request).rename(reviewer_id, payload)


@router.get(
    "/samples/{sample_id}/review-note-draft",
    response_model=ReviewNoteDraftRead,
)
def get_review_note_draft(
    sample_id: int,
    request: Request,
    reviewer_id: int = Query(alias="reviewerId", gt=0),
) -> ReviewNoteDraftRead:
    return reviews(request).get_note_draft(sample_id, reviewer_id)


@router.put(
    "/samples/{sample_id}/review-note-draft",
    response_model=ReviewNoteDraftRead,
)
def put_review_note_draft(
    sample_id: int,
    payload: ReviewNoteDraftUpdate,
    request: Request,
) -> ReviewNoteDraftRead:
    return reviews(request).put_note_draft(sample_id, payload)


@router.get("/reviews", response_model=PageRead[ReviewRead])
def list_reviews(
    request: Request,
    sample_id: int = Query(alias="sampleId", gt=0),
    page: int = Query(default=1, ge=1),
) -> PageRead[ReviewRead]:
    return reviews(request).list_for_sample(sample_id, page)


@router.post(
    "/reviews",
    response_model=ReviewSubmissionRead,
    status_code=status.HTTP_201_CREATED,
)
def create_review(
    payload: ReviewCreate,
    request: Request,
) -> ReviewSubmissionRead:
    return reviews(request).create(payload)


@router.post(
    "/reviews/batch",
    response_model=list[ReviewSampleDetailRead],
    status_code=status.HTTP_201_CREATED,
)
def create_reviews_batch(
    payload: ReviewBatchCreate, request: Request
) -> list[ReviewSampleDetailRead]:
    return reviews(request).create_batch(payload)


@router.get(
    "/reviewers/{reviewer_id}/statistics", response_model=ReviewerStatisticsRead
)
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


@router.get("/archives", response_model=PageRead[ArchiveRead])
def list_archives(
    request: Request,
    page: int = Query(default=1, ge=1),
) -> PageRead[ArchiveRead]:
    return archives(request).list_archives(page)


@router.post("/archives/preview", response_model=ArchivePreviewRead)
def preview_archive(
    payload: ArchivePreviewRequest, request: Request
) -> ArchivePreviewRead:
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
        headers={
            "Content-Disposition": f'attachment; filename="dataset-{dataset_id}-manifest.jsonl"'
        },
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


def _read_media_asset(
    asset_id: int, request: Request, *, include_body: bool
) -> Response:
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
                status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                headers=_media_headers(
                    media_type,
                    0,
                    content_range=f"bytes */{evidence.st_size}",
                ),
            )
        except _UnsatisfiableRangeError:
            return Response(
                status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
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
        if not _is_ascii_digits(start_text) or (
            end_text and not _is_ascii_digits(end_text)
        ):
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


@router.get("/jobs/{job_id}/events", response_model=PageRead[JobEventRead])
def list_job_events(
    job_id: int,
    request: Request,
    page: int = Query(default=1, ge=1),
    order: Literal["asc", "desc"] = Query(default="asc"),
) -> PageRead[JobEventRead]:
    return batches(request).list_job_events(job_id, page, order)


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
        replaying = True
        while True:
            signal.clear()
            events, job_terminal = batch_service.list_job_events_snapshot(
                job_id,
                cursor,
            )
            terminal_sent = False
            for event in events:
                if event.id <= cursor:
                    continue
                await websocket.send_json(event.model_dump(mode="json", by_alias=True))
                cursor = event.id
                terminal_sent = (
                    terminal_sent or event.event_type in TERMINAL_EVENT_TYPES
                )

            replay_exhausted = len(events) < EVENT_REPLAY_LIMIT
            if replaying and not replay_exhausted:
                await websocket.close(
                    code=1000,
                    reason="Job event history page completed",
                )
                return
            replaying = False
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
        pending = [
            task
            for task in (receive_task, signal_task, poll_task)
            if task is not None and not task.done()
        ]
        for task in pending:
            task.cancel()
        job_executor.unsubscribe_events(signal)
        if pending:
            try:
                await asyncio.gather(*pending, return_exceptions=True)
            except asyncio.CancelledError:
                pass


@router.post(
    "/jobs/{job_id}/cancel",
    response_model=JobDetailRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def cancel_job(
    job_id: int, payload: JobCancelRequest, request: Request
) -> JobDetailRead:
    await executor(request).cancel_job(job_id, payload)
    return batches(request).get_job(job_id)


@router.post(
    "/jobs/{job_id}/resume",
    response_model=JobDetailRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def resume_job(
    job_id: int, payload: JobResumeRequest, request: Request
) -> JobDetailRead:
    await executor(request).resume_job(job_id, payload)
    return batches(request).get_job(job_id)


@router.post(
    "/jobs/{job_id}/retry-failed",
    response_model=JobDetailRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_failed_job_items(
    job_id: int,
    payload: JobRetryFailedRequest,
    request: Request,
) -> JobDetailRead:
    await executor(request).retry_failed_items(job_id, payload)
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
    return [
        _gpu_slot_read(snapshot) for snapshot in await batches(request).list_gpu_slots()
    ]


@router.post("/gpu-slots/{slot}/release", response_model=GpuSlotRead)
async def release_gpu_slot(
    slot: GpuSlotName, payload: GpuReleaseRequest, request: Request
) -> GpuSlotRead:
    snapshot = await batches(request).release_gpu_slot(slot, payload.expected_revision)
    return _gpu_slot_read(snapshot)
