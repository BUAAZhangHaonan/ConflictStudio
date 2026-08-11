from __future__ import annotations

from fastapi import APIRouter, Query, Request, Response, status
from fastapi.responses import JSONResponse
from starlette.background import BackgroundTask

from backend.domain.schemas import (
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
    GpuSlotRead,
    HealthRead,
    JobCancelRequest,
    JobDetailRead,
    JobSummaryRead,
    PromptPresetCreate,
    PromptPresetRead,
    PromptPresetUpdate,
    VideoBackgroundPresetCreate,
    VideoBackgroundPresetRead,
    VideoBackgroundPresetUpdate,
)
from backend.services.batches import BatchService
from backend.services.catalog import CatalogService
from backend.services.job_executor import JobExecutor


router = APIRouter(prefix="/api")


def catalog(request: Request) -> CatalogService:
    return request.app.state.catalog_service


def batches(request: Request) -> BatchService:
    return request.app.state.batch_service


def executor(request: Request) -> JobExecutor:
    return request.app.state.job_executor


async def notify_executor(job_executor: JobExecutor) -> None:
    job_executor.notify()


@router.get("/health", response_model=HealthRead)
def health(request: Request) -> HealthRead:
    database = request.app.state.database
    return HealthRead(
        ok=database.foreign_keys_enabled(),
        database="ready",
        prompt_service_configured=request.app.state.prompt_model.configured,
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
def preview_batch(draft_id: int, payload: BatchPreviewRequest, request: Request) -> BatchPreviewRead:
    return batches(request).preview_batch(draft_id, payload.expected_revision)


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


@router.post("/jobs/{job_id}/cancel", response_model=JobDetailRead, status_code=status.HTTP_202_ACCEPTED)
async def cancel_job(job_id: int, payload: JobCancelRequest, request: Request) -> JobDetailRead:
    await executor(request).cancel_job(job_id, payload)
    return batches(request).get_job(job_id)


@router.get("/gpu-slots", response_model=list[GpuSlotRead])
def list_gpu_slots(request: Request) -> list[GpuSlotRead]:
    return batches(request).list_gpu_slots()
