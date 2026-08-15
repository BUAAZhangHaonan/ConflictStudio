from __future__ import annotations

import json
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import delete
from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.adapters.llm import PROMPT_MODEL
from backend.adapters.renderer import RendererGateway, UnconfiguredRendererGateway
from backend.domain.enums import (
    BatchDraftStatus,
    Category,
    ContentMode,
    ContentStatus,
    DatasetPurpose,
    ExampleKind,
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobSource,
    JobStatus,
    ModelName,
    Precision,
    ResourceStatus,
)
from backend.domain.models import (
    BatchDraft,
    BatchDraftContentBackground,
    BatchDraftContentSelection,
    BatchDraftDemographic,
    BatchDraftGpuSlot,
    BatchDraftPromptPreset,
    BatchVideoInputSnapshot,
    ContentPlan,
    ContentPlanBackground,
    Dataset,
    GenerationAttempt,
    GpuSlot,
    Job,
    JobEvent,
    JobItem,
    JobItemPromptResult,
    PromptExample,
    PromptPreset,
    RENDERER_PROFILE_VERSION,
    Sample,
    VIDEO_FPS,
    VIDEO_HEIGHT,
    VIDEO_WIDTH,
    VideoBackgroundPreset,
    utc_now,
)
from backend.domain.schemas import (
    BatchAllocationRead,
    BatchContentSelectionRead,
    BatchDraftCreate,
    BatchDraftRead,
    BatchDraftUpdate,
    BatchPreviewRead,
    BatchSubmitRequest,
    BilingualSelectionRead,
    DemographicInput,
    GenerationAttemptRead,
    JobDetailRead,
    JobEventPayloadRead,
    JobEventRead,
    JobItemRead,
    JobItemPromptResultRead,
    JobSummaryRead,
    PageRead,
    PromptPreviewRead,
    PromptPreviewRequest,
    SelectionRead,
    SnapshotRead,
    SourceSelection,
    TestRunCreate,
)

from .errors import ServiceError, not_found, revision_conflict, state_conflict
from .assets import asset_content_url
from .gpu_slots import GpuSlotService, GpuSlotSnapshot
from .prompts import PreparedPrompt, PromptContext, PromptService
from .pagination import PAGE_SIZE, paginate


@dataclass(frozen=True)
class DraftContentSelection:
    content: ContentPlan
    backgrounds: list[VideoBackgroundPreset]
    compatible_backgrounds: list[VideoBackgroundPreset]
    content_revision: int
    background_revisions: dict[int, int]


@dataclass(frozen=True)
class DraftAggregate:
    draft: BatchDraft
    dataset: Dataset
    selections: list[DraftContentSelection]
    preset: PromptPreset
    preset_revision: int
    preset_examples: tuple[list[str], list[str]]
    demographics: list[BatchDraftDemographic]
    gpu_slots: list[GpuSlotName]


@dataclass(frozen=True)
class Allocation:
    sequence: int
    content: ContentPlan
    preset: PromptPreset
    background: VideoBackgroundPreset
    demographic: BatchDraftDemographic
    gpu_slot: GpuSlotName
    model: ModelName
    precision: Precision | None
    seed: int
    prepared: PreparedPrompt


@dataclass(frozen=True)
class PromptSelection:
    content: ContentPlan
    preset: PromptPreset
    background: VideoBackgroundPreset
    prepared: PreparedPrompt


def allocation_inputs(
    selections: list[DraftContentSelection],
    demographics: list[BatchDraftDemographic],
    quantity: int,
) -> list[tuple[ContentPlan, VideoBackgroundPreset, BatchDraftDemographic]]:
    combinations = [
        (selection.content, background, demographic)
        for selection in selections
        for background in selection.backgrounds
        for demographic in demographics
    ]
    return [combinations[index % len(combinations)] for index in range(quantity)]


class BatchService:
    def __init__(
        self,
        database: Database,
        prompts: PromptService,
        renderer: RendererGateway | None = None,
    ) -> None:
        self.database = database
        self.prompts = prompts
        self.renderer = renderer or UnconfiguredRendererGateway()
        self.gpu_slots = GpuSlotService(database, self.renderer)

    def list_batch_drafts(self, page: int) -> PageRead[BatchDraftRead]:
        with self.database.read_session() as session:
            return paginate(
                session,
                select(BatchDraft).order_by(
                    BatchDraft.created_at.desc(),
                    BatchDraft.id.desc(),
                ),
                page,
                lambda row: self._draft_read(self._load_aggregate(session, row.id)),
            )

    def get_batch_draft(self, draft_id: int) -> BatchDraftRead:
        with self.database.read_session() as session:
            return self._draft_read(self._load_aggregate(session, draft_id))

    def create_batch_draft(self, payload: BatchDraftCreate) -> BatchDraftRead:
        with self.database.immediate_session() as session:
            dataset, selections, preset = self._resolve_selections(session, payload)
            seed = payload.seed if payload.seed is not None else random.SystemRandom().randrange(0, 2**31)
            row = BatchDraft(
                dataset_id=dataset.id,
                dataset_revision=dataset.revision,
                category=payload.category,
                conflict_direction=payload.conflict_direction,
                model=payload.model,
                precision=payload.precision,
                quantity=payload.quantity,
                seed_base=seed,
            )
            session.add(row)
            session.flush()
            self._replace_links(session, row.id, payload, selections, preset)
            session.flush()
            return self._draft_read(self._load_aggregate(session, row.id))

    def update_batch_draft(self, draft_id: int, payload: BatchDraftUpdate) -> BatchDraftRead:
        with self.database.immediate_session() as session:
            row = self._get_draft(session, draft_id)
            self._check_draft_revision(row, payload.expected_revision)
            if row.status is not BatchDraftStatus.DRAFT:
                raise state_conflict("batchDraft", draft_id, "A submitted batch cannot be changed")
            dataset, selections, preset = self._resolve_selections(session, payload)
            row.dataset_id = dataset.id
            row.dataset_revision = dataset.revision
            row.category = payload.category
            row.conflict_direction = payload.conflict_direction
            row.model = payload.model
            row.precision = payload.precision
            row.quantity = payload.quantity
            if payload.seed is not None:
                row.seed_base = payload.seed
            row.revision += 1
            row.updated_at = utc_now()
            self._delete_links(session, draft_id)
            self._replace_links(session, draft_id, payload, selections, preset)
            session.flush()
            return self._draft_read(self._load_aggregate(session, draft_id))

    def delete_batch_draft(self, draft_id: int, expected_revision: int) -> None:
        with self.database.immediate_session() as session:
            row = self._get_draft(session, draft_id)
            self._check_draft_revision(row, expected_revision)
            if row.status is not BatchDraftStatus.DRAFT:
                raise state_conflict("batchDraft", draft_id, "A submitted batch cannot be deleted")
            session.delete(row)

    async def preview_batch(self, draft_id: int, expected_revision: int) -> BatchPreviewRead:
        with self.database.read_session() as session:
            aggregate = self._load_aggregate(session, draft_id)
            self._check_draft_revision(aggregate.draft, expected_revision)
            self._validate_aggregate(aggregate)
            allocations = self._build_allocations(aggregate)

        live_gpu_slots = await self.gpu_slots.inspect_slots(aggregate.gpu_slots)
        return BatchPreviewRead(
            batch_draft_id=draft_id,
            expected_revision=aggregate.draft.revision,
            gpu_revisions={slot: snapshot.revision for slot, snapshot in live_gpu_slots.items()},
            allocations=[self._allocation_read(value) for value in allocations],
        )

    def preview_prompt(self, payload: PromptPreviewRequest) -> PromptPreviewRead:
        with self.database.read_session() as session:
            selection = self._prepare_prompt_selection(
                session,
                payload.content_plan,
                payload.prompt_preset,
                payload.background_preset,
                payload.demographic,
            )
            content = selection.content
            preset = selection.preset
            background = selection.background
            fixed = selection.prepared.fixed_output
            return PromptPreviewRead(
                content_plan=BilingualSelectionRead(
                    id=content.id,
                    name_zh=content.name_zh,
                    name_en=content.name_en,
                    revision=content.revision,
                ),
                prompt_preset=SelectionRead(id=preset.id, name=preset.name, revision=preset.revision),
                background_preset=BilingualSelectionRead(
                    id=background.id,
                    name_zh=background.name_zh,
                    name_en=background.name_en,
                    revision=background.revision,
                ),
                category=content.category,
                conflict_direction=content.conflict_direction,
                demographic=payload.demographic,
                requires_prompt_generation=fixed is None,
                system_input=selection.prepared.system_input,
                user_input=selection.prepared.user_input,
                final_positive_prompt=fixed.positive_prompt if fixed else None,
                final_negative_prompt=selection.prepared.final_negative_prompt,
            )

    async def submit_test_run(self, payload: TestRunCreate) -> JobDetailRead:
        if not self.renderer.configured:
            raise ServiceError(
                503,
                "renderer_not_configured",
                "Rendering requires a configured renderer gateway",
            )

        with self.database.read_session() as session:
            selection = self._prepare_prompt_selection(
                session,
                payload.content_plan,
                payload.prompt_preset,
                payload.background_preset,
                payload.demographic,
            )
        prompt_result = await self.prompts.complete(selection.prepared, selection.content.category)
        seed = payload.seed if payload.seed is not None else random.SystemRandom().randrange(0, 2**31)
        selected_slots = list(dict.fromkeys(value.gpu_slot for value in payload.comparisons))
        async with self.gpu_slots.submission_inspection(selected_slots) as live_gpu_slots:
            with self.database.immediate_session() as session:
                current = self._prepare_prompt_selection(
                    session,
                    payload.content_plan,
                    payload.prompt_preset,
                    payload.background_preset,
                    payload.demographic,
                )
                requested_profiles: dict[GpuSlotName, list[tuple[ModelName, Precision | None]]] = {
                    slot: [] for slot in selected_slots
                }
                for comparison in payload.comparisons:
                    requested_profiles[comparison.gpu_slot].append(
                        (comparison.model, comparison.precision)
                    )
                self.gpu_slots.validate_profiles(
                    live_gpu_slots,
                    expected_revisions=payload.expected_gpu_revisions,
                    requested_profiles=requested_profiles,
                    confirm_model_switch=payload.confirm_model_switch,
                )
                self._validate_live_gpu_rows(session, selected_slots, live_gpu_slots)

                timestamp = utc_now()
                job = Job(
                    display_name=self._job_name(current.content.category),
                    source=JobSource.TEST,
                    dataset_id=None,
                    batch_draft_id=None,
                    category=current.content.category,
                    conflict_direction=current.content.conflict_direction,
                    model=None,
                    precision=None,
                    status=JobStatus.QUEUED,
                    total_count=len(payload.comparisons),
                    confirm_model_switch=payload.confirm_model_switch,
                    created_at=timestamp,
                    updated_at=timestamp,
                )
                session.add(job)
                session.flush()

                snapshots: list[BatchVideoInputSnapshot] = []
                for sequence, comparison in enumerate(payload.comparisons, start=1):
                    snapshot = BatchVideoInputSnapshot(
                        batch_draft_id=None,
                        dataset_id=None,
                        dataset_revision=None,
                        sequence=sequence,
                        content_plan_id=current.content.id,
                        content_plan_revision=current.content.revision,
                        prompt_preset_id=current.preset.id,
                        prompt_preset_revision=current.preset.revision,
                        background_preset_id=current.background.id,
                        background_preset_revision=current.background.revision,
                        policy_version=prompt_result.policy_version,
                        category=current.content.category,
                        conflict_direction=current.content.conflict_direction,
                        age=payload.demographic.age,
                        gender=payload.demographic.gender,
                        ethnicity=payload.demographic.ethnicity,
                        model=comparison.model,
                        precision=comparison.precision,
                        seed=seed,
                        width=VIDEO_WIDTH,
                        height=VIDEO_HEIGHT,
                        fps=VIDEO_FPS,
                        frame_count=124 if comparison.model is ModelName.H3 else 121,
                        renderer_profile_version=RENDERER_PROFILE_VERSION,
                        prompt_model=PROMPT_MODEL,
                        source_has_audio=True,
                        derive_silent_primary=current.content.category
                        in {Category.A_VT, Category.C_VT},
                        system_input=prompt_result.system_input,
                        user_input=prompt_result.user_input,
                        final_negative_prompt=prompt_result.final_negative_prompt,
                        fixed_positive_prompt=prompt_result.final_positive_prompt,
                        fixed_dialogue=prompt_result.dialogue,
                        fixed_vt_text=prompt_result.vt_text,
                        fixed_true_emotion_description=prompt_result.true_emotion_description,
                        true_emotion=current.content.true_emotion,
                        apparent_emotion=current.content.apparent_emotion,
                        created_at=timestamp,
                    )
                    session.add(snapshot)
                    snapshots.append(snapshot)
                session.flush()

                for sequence, (comparison, snapshot) in enumerate(
                    zip(payload.comparisons, snapshots, strict=True),
                    start=1,
                ):
                    session.add(
                        JobItem(
                            job_id=job.id,
                            sequence=sequence,
                            input_snapshot_id=snapshot.id,
                            gpu_slot=comparison.gpu_slot,
                            stage=JobItemStage.PROMPT_QUEUED,
                            status=JobStatus.QUEUED,
                            created_at=timestamp,
                            updated_at=timestamp,
                        )
                    )
                session.add(
                    JobEvent(
                        job_id=job.id,
                        item_id=None,
                        event_type="JobQueued",
                        payload_json=json.dumps({"slotCount": len(selected_slots)}),
                    )
                )
                for gpu in self._gpu_rows(session, selected_slots):
                    gpu.availability = GpuAvailability.RESERVED
                    gpu.active_job_id = job.id
                    gpu.revision += 1
                    gpu.checked_at = timestamp
                session.flush()
                return self._job_detail(session, job)

    async def submit_batch(self, draft_id: int, payload: BatchSubmitRequest) -> JobDetailRead:
        if not self.renderer.configured:
            raise ServiceError(
                503,
                "renderer_not_configured",
                "Rendering requires a configured renderer gateway",
            )

        with self.database.read_session() as session:
            aggregate = self._load_aggregate(session, draft_id)
            self._check_draft_revision(aggregate.draft, payload.expected_revision)
            self._validate_aggregate(aggregate)
            allocations = self._build_allocations(aggregate)

        async with self.gpu_slots.submission_inspection(aggregate.gpu_slots) as live_gpu_slots:
            with self.database.immediate_session() as session:
                current = self._load_aggregate(session, draft_id)
                self._check_draft_revision(current.draft, payload.expected_revision)
                self._validate_aggregate(current)
                if not self._same_allocations(aggregate, current):
                    raise ServiceError(
                        409,
                        "referenced_resource_changed",
                        "A selected record changed before the batch was submitted",
                        {"resource": "batchDraft", "id": draft_id},
                    )
                self._validate_gpu_request(session, current, payload, live_gpu_slots)

                timestamp = utc_now()
                job = Job(
                    display_name=self._job_name(current.draft.category),
                    source=JobSource.PRODUCTION,
                    dataset_id=current.dataset.id,
                    batch_draft_id=draft_id,
                    category=current.draft.category,
                    conflict_direction=current.draft.conflict_direction,
                    model=current.draft.model,
                    precision=current.draft.precision,
                    status=JobStatus.QUEUED,
                    total_count=current.draft.quantity,
                    confirm_model_switch=payload.confirm_model_switch,
                    created_at=timestamp,
                    updated_at=timestamp,
                )
                session.add(job)
                session.flush()

                snapshots: list[BatchVideoInputSnapshot] = []
                selections_by_content = {
                    selection.content.id: selection
                    for selection in current.selections
                }
                for allocation in allocations:
                    fixed = allocation.prepared.fixed_output
                    selection = selections_by_content[allocation.content.id]
                    snapshot = BatchVideoInputSnapshot(
                        batch_draft_id=draft_id,
                        dataset_id=current.dataset.id,
                        dataset_revision=current.draft.dataset_revision,
                        sequence=allocation.sequence,
                        content_plan_id=allocation.content.id,
                        content_plan_revision=selection.content_revision,
                        prompt_preset_id=allocation.preset.id,
                        prompt_preset_revision=current.preset_revision,
                        background_preset_id=allocation.background.id,
                        background_preset_revision=selection.background_revisions[
                            allocation.background.id
                        ],
                        policy_version=allocation.prepared.policy_version,
                        category=current.draft.category,
                        conflict_direction=current.draft.conflict_direction,
                        age=allocation.demographic.age,
                        gender=allocation.demographic.gender,
                        ethnicity=allocation.demographic.ethnicity,
                        model=current.draft.model,
                        precision=current.draft.precision,
                        seed=allocation.seed,
                        width=VIDEO_WIDTH,
                        height=VIDEO_HEIGHT,
                        fps=VIDEO_FPS,
                        frame_count=124 if current.draft.model is ModelName.H3 else 121,
                        renderer_profile_version=RENDERER_PROFILE_VERSION,
                        prompt_model=PROMPT_MODEL,
                        source_has_audio=True,
                        derive_silent_primary=current.draft.category in {Category.A_VT, Category.C_VT},
                        system_input=allocation.prepared.system_input,
                        user_input=allocation.prepared.user_input,
                        final_negative_prompt=allocation.prepared.final_negative_prompt,
                        fixed_positive_prompt=fixed.positive_prompt if fixed is not None else None,
                        fixed_dialogue=fixed.dialogue if fixed is not None else None,
                        fixed_vt_text=fixed.vt_text if fixed is not None else None,
                        fixed_true_emotion_description=(
                            fixed.true_emotion_description if fixed is not None else None
                        ),
                        true_emotion=allocation.content.true_emotion,
                        apparent_emotion=allocation.content.apparent_emotion,
                        created_at=timestamp,
                    )
                    session.add(snapshot)
                    snapshots.append(snapshot)

                session.flush()

                for allocation, snapshot in zip(allocations, snapshots, strict=True):
                    session.add(
                        JobItem(
                            job_id=job.id,
                            sequence=allocation.sequence,
                            input_snapshot_id=snapshot.id,
                            gpu_slot=allocation.gpu_slot,
                            stage=JobItemStage.PROMPT_QUEUED,
                            status=JobStatus.QUEUED,
                            created_at=timestamp,
                            updated_at=timestamp,
                        )
                    )

                session.add(
                    JobEvent(
                        job_id=job.id,
                        item_id=None,
                        event_type="JobQueued",
                        payload_json=json.dumps({"slotCount": len(current.gpu_slots)}),
                    )
                )

                for gpu in self._gpu_rows(session, current.gpu_slots):
                    gpu.availability = GpuAvailability.RESERVED
                    gpu.active_job_id = job.id
                    gpu.revision += 1
                    gpu.checked_at = timestamp
                current.draft.status = BatchDraftStatus.SUBMITTED
                current.draft.revision += 1
                current.draft.updated_at = timestamp
                session.flush()
                return self._job_detail(session, job)

    def list_jobs(
        self,
        page: int,
        statuses: list[JobStatus] | None = None,
    ) -> PageRead[JobSummaryRead]:
        with self.database.read_session() as session:
            statement = select(Job)
            if statuses:
                statement = statement.where(Job.status.in_(statuses))
            return paginate(
                session,
                statement.order_by(Job.created_at.desc(), Job.id.desc()),
                page,
                JobSummaryRead.model_validate,
            )

    def get_job(self, job_id: int) -> JobDetailRead:
        with self.database.read_session() as session:
            job = session.get(Job, job_id)
            if job is None:
                raise not_found("job", job_id)
            return self._job_detail(session, job)

    def job_exists(self, job_id: int) -> bool:
        with self.database.read_session() as session:
            return session.get(Job, job_id) is not None

    def list_job_items(self, job_id: int, page: int) -> PageRead[JobItemRead]:
        with self.database.read_session() as session:
            self._required(session, Job, job_id, "job")
            rows = paginate(
                session,
                select(JobItem)
                .where(JobItem.job_id == job_id)
                .order_by(JobItem.sequence, JobItem.id),
                page,
                lambda item: item,
            )
            return PageRead(
                items=self._job_item_reads(session, rows.items),
                page=rows.page,
                page_size=rows.page_size,
                total=rows.total,
                total_pages=rows.total_pages,
            )

    def list_job_attempts(
        self,
        item_id: int,
        page: int,
    ) -> PageRead[GenerationAttemptRead]:
        with self.database.read_session() as session:
            self._required(session, JobItem, item_id, "jobItem")
            return paginate(
                session,
                select(GenerationAttempt)
                .where(GenerationAttempt.job_item_id == item_id)
                .order_by(GenerationAttempt.attempt_number, GenerationAttempt.id),
                page,
                self._generation_attempt_read,
            )

    def list_job_events(self, job_id: int, page: int) -> PageRead[JobEventRead]:
        with self.database.read_session() as session:
            self._required(session, Job, job_id, "job")
            return paginate(
                session,
                select(JobEvent)
                .where(JobEvent.job_id == job_id)
                .order_by(JobEvent.id),
                page,
                self._job_event_read,
            )

    def list_job_events_snapshot(
        self,
        job_id: int,
        after_event_id: int,
    ) -> tuple[list[JobEventRead], bool]:
        with self.database.read_session() as session:
            job = self._required(session, Job, job_id, "job")
            events = session.exec(
                select(JobEvent)
                .where(JobEvent.job_id == job_id, JobEvent.id > after_event_id)
                .order_by(JobEvent.id)
                .limit(PAGE_SIZE)
            ).all()
            return [self._job_event_read(event) for event in events], job.status in {
                JobStatus.COMPLETED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
            }

    async def list_gpu_slots(self) -> list[GpuSlotSnapshot]:
        return await self.gpu_slots.inspect_all()

    async def release_gpu_slot(
        self,
        slot: GpuSlotName,
        expected_revision: int,
    ) -> GpuSlotSnapshot:
        if not self.renderer.configured:
            raise ServiceError(503, "renderer_not_configured", "Rendering requires a configured renderer gateway")
        return await self.gpu_slots.release(slot, expected_revision)

    def _prepare_prompt_selection(
        self,
        session: Session,
        content_selection: SourceSelection,
        preset_selection: SourceSelection,
        background_selection: SourceSelection,
        demographic: DemographicInput,
    ) -> PromptSelection:
        content = self._required(session, ContentPlan, content_selection.id, "contentPlan")
        preset = self._required(session, PromptPreset, preset_selection.id, "promptPreset")
        background = self._required(
            session,
            VideoBackgroundPreset,
            background_selection.id,
            "videoBackgroundPreset",
        )
        self._check_source(content, content_selection.expected_revision, "contentPlan")
        self._check_source(preset, preset_selection.expected_revision, "promptPreset")
        self._check_source(background, background_selection.expected_revision, "videoBackgroundPreset")
        if content.status is not ContentStatus.ACTIVE:
            raise state_conflict("contentPlan", content.id, "The selected content plan is not active")
        if preset.status is not ResourceStatus.ACTIVE:
            raise state_conflict("promptPreset", preset.id, "The selected prompt preset is disabled")
        if background.status is not ResourceStatus.ACTIVE:
            raise state_conflict(
                "videoBackgroundPreset",
                background.id,
                "The selected background preset is disabled",
            )
        if preset.category is not content.category:
            raise ServiceError(422, "validation_error", "The prompt preset category does not match the content")
        if session.exec(
            select(ContentPlanBackground).where(
                ContentPlanBackground.content_plan_id == content.id,
                ContentPlanBackground.background_preset_id == background.id,
            )
        ).first() is None:
            raise ServiceError(
                422,
                "incompatible_content_background",
                "The selected background is not registered for this content plan",
            )
        examples = session.exec(
            select(PromptExample)
            .where(PromptExample.preset_id == preset.id)
            .order_by(PromptExample.kind, PromptExample.position)
        ).all()
        prepared = self.prompts.prepare(
            PromptContext(
                content=content,
                preset=preset,
                positive_examples=[row.text for row in examples if row.kind is ExampleKind.POSITIVE],
                negative_examples=[row.text for row in examples if row.kind is ExampleKind.NEGATIVE],
                background=background,
                age=demographic.age,
                gender=demographic.gender,
                ethnicity=demographic.ethnicity,
            )
        )
        return PromptSelection(content, preset, background, prepared)

    def _resolve_selections(
        self,
        session: Session,
        payload: BatchDraftCreate | BatchDraftUpdate,
    ) -> tuple[Dataset, list[DraftContentSelection], PromptPreset]:
        dataset = session.get(Dataset, payload.target_dataset_id)
        if dataset is None:
            raise not_found("dataset", payload.target_dataset_id)
        if dataset.purpose is not DatasetPurpose.FORMAL:
            raise ServiceError(
                422,
                "invalid_target_dataset",
                "A formal batch requires a formal dataset",
            )
        if dataset.status is not ResourceStatus.ACTIVE:
            raise ServiceError(
                422,
                "invalid_target_dataset",
                "A formal batch requires an active dataset",
            )

        preset = session.get(PromptPreset, payload.prompt_preset_id)
        if preset is None:
            raise not_found("promptPreset", payload.prompt_preset_id)
        if preset.category is not payload.category:
            raise ServiceError(
                422,
                "validation_error",
                "The prompt preset category does not match the batch",
            )
        if preset.status is not ResourceStatus.ACTIVE:
            raise ServiceError(
                422,
                "validation_error",
                "The selected prompt preset is not active",
            )

        selections: list[DraftContentSelection] = []
        for requested in payload.content_selections:
            content = session.get(ContentPlan, requested.content_plan_id)
            if content is None:
                raise not_found("contentPlan", requested.content_plan_id)
            if content.category is not payload.category:
                raise ServiceError(422, "validation_error", "The content category does not match the batch")
            if content.status is not ContentStatus.ACTIVE:
                raise ServiceError(
                    422,
                    "validation_error",
                    "The selected content plan is not active",
                )
            mappings = session.exec(
                select(ContentPlanBackground)
                .where(ContentPlanBackground.content_plan_id == content.id)
                .order_by(ContentPlanBackground.position)
            ).all()
            mapped_ids = [mapping.background_preset_id for mapping in mappings]
            compatible_backgrounds = [
                self._required(
                    session,
                    VideoBackgroundPreset,
                    background_id,
                    "videoBackgroundPreset",
                )
                for background_id in mapped_ids
            ]
            if content.mode is ContentMode.FIXED:
                if requested.background_preset_ids:
                    raise ServiceError(
                        422,
                        "fixed_background_is_automatic",
                        "Fixed content does not accept a background selection",
                    )
                if len(mapped_ids) != 1:
                    raise ServiceError(
                        422,
                        "content_background_missing",
                        "Fixed content requires exactly one registered source background",
                    )
                selected_ids = mapped_ids
            else:
                if not requested.background_preset_ids:
                    raise ServiceError(
                        422,
                        "content_background_required",
                        "Generative content requires at least one registered background",
                    )
                if any(
                    background_id not in mapped_ids
                    for background_id in requested.background_preset_ids
                ):
                    raise ServiceError(
                        422,
                        "incompatible_content_background",
                        "A selected background is not registered for this content plan",
                    )
                selected_ids = requested.background_preset_ids
            backgrounds = [
                self._required(
                    session,
                    VideoBackgroundPreset,
                    background_id,
                    "videoBackgroundPreset",
                )
                for background_id in selected_ids
            ]
            if any(background.status is not ResourceStatus.ACTIVE for background in backgrounds):
                raise ServiceError(
                    422,
                    "validation_error",
                    "A selected background preset is not active",
                )
            selections.append(
                DraftContentSelection(
                    content=content,
                    backgrounds=backgrounds,
                    compatible_backgrounds=compatible_backgrounds,
                    content_revision=content.revision,
                    background_revisions={
                        background.id: background.revision for background in backgrounds
                    },
                )
            )
        for slot in payload.gpu_slots:
            if session.get(GpuSlot, slot) is None:
                raise not_found("gpuSlot", slot.value)
        return dataset, selections, preset

    @staticmethod
    def _replace_links(
        session: Session,
        draft_id: int,
        payload: BatchDraftCreate | BatchDraftUpdate,
        selections: list[DraftContentSelection],
        preset: PromptPreset,
    ) -> None:
        for position, selection in enumerate(selections):
            session.add(
                BatchDraftContentSelection(
                    batch_draft_id=draft_id,
                    content_plan_id=selection.content.id,
                    position=position,
                    source_revision=selection.content_revision,
                )
            )
            session.flush()
            for background_position, background in enumerate(selection.backgrounds):
                session.add(
                    BatchDraftContentBackground(
                        batch_draft_id=draft_id,
                        content_plan_id=selection.content.id,
                        background_preset_id=background.id,
                        position=background_position,
                        source_revision=selection.background_revisions[background.id],
                    )
                )
        session.add(
            BatchDraftPromptPreset(
                batch_draft_id=draft_id,
                prompt_preset_id=preset.id,
                position=0,
                source_revision=preset.revision,
            )
        )
        for position, value in enumerate(payload.demographics):
            session.add(
                BatchDraftDemographic(
                    batch_draft_id=draft_id,
                    position=position,
                    age=value.age,
                    gender=value.gender,
                    ethnicity=value.ethnicity,
                )
            )
        for position, value in enumerate(payload.gpu_slots):
            session.add(BatchDraftGpuSlot(batch_draft_id=draft_id, gpu_slot=value, position=position))

    @staticmethod
    def _delete_links(session: Session, draft_id: int) -> None:
        for model in (
            BatchDraftContentBackground,
            BatchDraftContentSelection,
            BatchDraftPromptPreset,
            BatchDraftDemographic,
            BatchDraftGpuSlot,
        ):
            session.exec(delete(model).where(model.batch_draft_id == draft_id))
        session.flush()

    def _load_aggregate(self, session: Session, draft_id: int | None) -> DraftAggregate:
        if draft_id is None:
            raise not_found("batchDraft", "missing")
        draft = self._get_draft(session, draft_id)
        dataset = session.get(Dataset, draft.dataset_id)
        if dataset is None:
            raise not_found("dataset", draft.dataset_id)
        content_links = session.exec(
            select(BatchDraftContentSelection)
            .where(BatchDraftContentSelection.batch_draft_id == draft_id)
            .order_by(BatchDraftContentSelection.position)
        ).all()
        preset_links = session.exec(
            select(BatchDraftPromptPreset)
            .where(BatchDraftPromptPreset.batch_draft_id == draft_id)
            .order_by(BatchDraftPromptPreset.position)
        ).all()
        background_links = session.exec(
            select(BatchDraftContentBackground)
            .where(BatchDraftContentBackground.batch_draft_id == draft_id)
            .order_by(
                BatchDraftContentBackground.content_plan_id,
                BatchDraftContentBackground.position,
            )
        ).all()
        demographics = session.exec(
            select(BatchDraftDemographic)
            .where(BatchDraftDemographic.batch_draft_id == draft_id)
            .order_by(BatchDraftDemographic.position)
        ).all()
        gpu_links = session.exec(
            select(BatchDraftGpuSlot)
            .where(BatchDraftGpuSlot.batch_draft_id == draft_id)
            .order_by(BatchDraftGpuSlot.position)
        ).all()
        selections: list[DraftContentSelection] = []
        for content_link in content_links:
            content = self._required(
                session,
                ContentPlan,
                content_link.content_plan_id,
                "contentPlan",
            )
            selected_links = [
                link
                for link in background_links
                if link.content_plan_id == content.id
            ]
            backgrounds = [
                self._required(
                    session,
                    VideoBackgroundPreset,
                    link.background_preset_id,
                    "videoBackgroundPreset",
                )
                for link in selected_links
            ]
            compatible_links = session.exec(
                select(ContentPlanBackground)
                .where(ContentPlanBackground.content_plan_id == content.id)
                .order_by(ContentPlanBackground.position)
            ).all()
            compatible_backgrounds = [
                self._required(
                    session,
                    VideoBackgroundPreset,
                    link.background_preset_id,
                    "videoBackgroundPreset",
                )
                for link in compatible_links
            ]
            compatible_ids = {background.id for background in compatible_backgrounds}
            if any(background.id not in compatible_ids for background in backgrounds):
                raise state_conflict(
                    "batchDraft",
                    draft_id,
                    "A saved content and scene selection is no longer compatible",
                )
            selections.append(
                DraftContentSelection(
                    content=content,
                    backgrounds=backgrounds,
                    compatible_backgrounds=compatible_backgrounds,
                    content_revision=content_link.source_revision,
                    background_revisions={
                        link.background_preset_id: link.source_revision
                        for link in selected_links
                    },
                )
            )
        if len(preset_links) != 1:
            raise ServiceError(
                409,
                "state_conflict",
                "The batch draft requires exactly one prompt preset",
            )
        preset_link = preset_links[0]
        preset = self._required(
            session,
            PromptPreset,
            preset_link.prompt_preset_id,
            "promptPreset",
        )
        rows = session.exec(
            select(PromptExample)
            .where(PromptExample.preset_id == preset.id)
            .order_by(PromptExample.kind, PromptExample.position)
        ).all()
        aggregate = DraftAggregate(
            draft=draft,
            dataset=dataset,
            selections=selections,
            preset=preset,
            preset_revision=preset_link.source_revision,
            preset_examples=(
                [row.text for row in rows if row.kind is ExampleKind.POSITIVE],
                [row.text for row in rows if row.kind is ExampleKind.NEGATIVE],
            ),
            demographics=demographics,
            gpu_slots=[link.gpu_slot for link in gpu_links],
        )
        return aggregate

    @staticmethod
    def _ensure_complete_aggregate(aggregate: DraftAggregate) -> None:
        if not aggregate.selections or any(
            not selection.backgrounds for selection in aggregate.selections
        ):
            raise ServiceError(409, "state_conflict", "The batch draft has incomplete source selections")
        if not aggregate.demographics or not aggregate.gpu_slots:
            raise ServiceError(409, "state_conflict", "The batch draft has incomplete allocation settings")

    def _validate_aggregate(self, aggregate: DraftAggregate) -> None:
        self._ensure_complete_aggregate(aggregate)
        if aggregate.draft.status is not BatchDraftStatus.DRAFT:
            raise state_conflict("batchDraft", aggregate.draft.id, "The batch has already been submitted")
        if (
            aggregate.dataset.revision != aggregate.draft.dataset_revision
            or aggregate.dataset.status is not ResourceStatus.ACTIVE
            or aggregate.dataset.purpose is not DatasetPurpose.FORMAL
        ):
            self._source_changed("dataset", aggregate.dataset.id)
        if (
            aggregate.preset.revision != aggregate.preset_revision
            or aggregate.preset.status is not ResourceStatus.ACTIVE
        ):
            self._source_changed("promptPreset", aggregate.preset.id)
        for selection in aggregate.selections:
            if (
                selection.content.revision != selection.content_revision
                or selection.content.status is not ContentStatus.ACTIVE
            ):
                self._source_changed("contentPlan", selection.content.id)
            for background in selection.backgrounds:
                if (
                    background.revision
                    != selection.background_revisions[background.id]
                    or background.status is not ResourceStatus.ACTIVE
                ):
                    self._source_changed("videoBackgroundPreset", background.id)

    def _build_allocations(self, aggregate: DraftAggregate) -> list[Allocation]:
        seed_source = random.Random(aggregate.draft.seed_base)
        values: list[Allocation] = []
        inputs = allocation_inputs(
            aggregate.selections,
            aggregate.demographics,
            aggregate.draft.quantity,
        )
        for offset, (content, background, demographic) in enumerate(inputs):
            preset = aggregate.preset
            positive, negative = aggregate.preset_examples
            prepared = self.prompts.prepare(
                PromptContext(
                    content=content,
                    preset=preset,
                    positive_examples=positive,
                    negative_examples=negative,
                    background=background,
                    age=demographic.age,
                    gender=demographic.gender,
                    ethnicity=demographic.ethnicity,
                )
            )
            values.append(
                Allocation(
                    sequence=offset + 1,
                    content=content,
                    preset=preset,
                    background=background,
                    demographic=demographic,
                    gpu_slot=aggregate.gpu_slots[offset % len(aggregate.gpu_slots)],
                    model=aggregate.draft.model,
                    precision=aggregate.draft.precision,
                    seed=seed_source.randrange(0, 2**31),
                    prepared=prepared,
                )
            )
        return values

    @staticmethod
    def _allocation_read(allocation: Allocation) -> BatchAllocationRead:
        fixed = allocation.prepared.fixed_output
        return BatchAllocationRead(
            sequence=allocation.sequence,
            content_plan=BilingualSelectionRead(
                id=allocation.content.id,
                name_zh=allocation.content.name_zh,
                name_en=allocation.content.name_en,
                revision=allocation.content.revision,
            ),
            prompt_preset=SelectionRead(
                id=allocation.preset.id,
                name=allocation.preset.name,
                revision=allocation.preset.revision,
            ),
            background_preset=BilingualSelectionRead(
                id=allocation.background.id,
                name_zh=allocation.background.name_zh,
                name_en=allocation.background.name_en,
                revision=allocation.background.revision,
            ),
            demographic=DemographicInput(
                age=allocation.demographic.age,
                gender=allocation.demographic.gender,
                ethnicity=allocation.demographic.ethnicity,
            ),
            gpu_slot=allocation.gpu_slot,
            model=allocation.model,
            precision=allocation.precision,
            seed=allocation.seed,
            requires_prompt_generation=fixed is None,
            system_input=allocation.prepared.system_input,
            user_input=allocation.prepared.user_input,
            final_positive_prompt=fixed.positive_prompt if fixed else None,
            final_negative_prompt=allocation.prepared.final_negative_prompt,
        )

    def _validate_gpu_request(
        self,
        session: Session,
        aggregate: DraftAggregate,
        payload: BatchSubmitRequest,
        live_slots: dict[GpuSlotName, GpuSlotSnapshot],
    ) -> None:
        self.gpu_slots.validate_submission(
            live_slots,
            expected_revisions=payload.expected_gpu_revisions,
            requested_model=aggregate.draft.model,
            requested_precision=aggregate.draft.precision,
            confirm_model_switch=payload.confirm_model_switch,
        )
        self._validate_live_gpu_rows(session, aggregate.gpu_slots, live_slots)

    def _validate_live_gpu_rows(
        self,
        session: Session,
        slots: list[GpuSlotName],
        live_slots: dict[GpuSlotName, GpuSlotSnapshot],
    ) -> None:
        for row in self._gpu_rows(session, slots):
            live = live_slots[row.slot]
            if row.revision != live.revision:
                raise ServiceError(
                    409,
                    "gpu_state_changed",
                    "The selected GPU state changed",
                    {
                        "slot": row.slot.value,
                        "expectedRevision": live.revision,
                        "actualRevision": row.revision,
                    },
                )

    @staticmethod
    def _gpu_rows(session: Session, slots: list[GpuSlotName]) -> list[GpuSlot]:
        values: list[GpuSlot] = []
        for slot in slots:
            row = session.get(GpuSlot, slot)
            if row is None:
                raise not_found("gpuSlot", slot.value)
            values.append(row)
        return values

    def _draft_read(self, aggregate: DraftAggregate) -> BatchDraftRead:
        return BatchDraftRead(
            id=aggregate.draft.id,
            target_dataset_id=aggregate.draft.dataset_id,
            dataset_revision=aggregate.draft.dataset_revision,
            category=aggregate.draft.category,
            conflict_direction=aggregate.draft.conflict_direction,
            model=aggregate.draft.model,
            precision=aggregate.draft.precision,
            quantity=aggregate.draft.quantity,
            seed=aggregate.draft.seed_base,
            status=aggregate.draft.status,
            content_selections=[
                BatchContentSelectionRead(
                    content_plan=BilingualSelectionRead(
                        id=selection.content.id,
                        name_zh=selection.content.name_zh,
                        name_en=selection.content.name_en,
                        revision=selection.content_revision,
                    ),
                    mode=selection.content.mode,
                    background_presets=[
                        BilingualSelectionRead(
                            id=background.id,
                            name_zh=background.name_zh,
                            name_en=background.name_en,
                            revision=selection.background_revisions[background.id],
                        )
                        for background in selection.backgrounds
                    ],
                    compatible_backgrounds=[
                        BilingualSelectionRead(
                            id=background.id,
                            name_zh=background.name_zh,
                            name_en=background.name_en,
                            revision=background.revision,
                        )
                        for background in selection.compatible_backgrounds
                    ],
                )
                for selection in aggregate.selections
            ],
            prompt_preset=SelectionRead(
                id=aggregate.preset.id,
                name=aggregate.preset.name,
                revision=aggregate.preset_revision,
            ),
            demographics=[
                DemographicInput(age=row.age, gender=row.gender, ethnicity=row.ethnicity)
                for row in aggregate.demographics
            ],
            gpu_slots=aggregate.gpu_slots,
            revision=aggregate.draft.revision,
            created_at=aggregate.draft.created_at,
            updated_at=aggregate.draft.updated_at,
        )

    @staticmethod
    def _same_allocations(before: DraftAggregate, after: DraftAggregate) -> bool:
        return (
            before.draft.revision == after.draft.revision
            and before.dataset.revision == after.dataset.revision
            and (
                before.preset.id,
                before.preset_revision,
            )
            == (
                after.preset.id,
                after.preset_revision,
            )
            and [
                (
                    selection.content.id,
                    selection.content_revision,
                    [
                        (
                            background.id,
                            selection.background_revisions[background.id],
                        )
                        for background in selection.backgrounds
                    ],
                )
                for selection in before.selections
            ]
            == [
                (
                    selection.content.id,
                    selection.content_revision,
                    [
                        (
                            background.id,
                            selection.background_revisions[background.id],
                        )
                        for background in selection.backgrounds
                    ],
                )
                for selection in after.selections
            ]
            and before.gpu_slots == after.gpu_slots
        )

    @staticmethod
    def _job_name(category: Category) -> str:
        local = datetime.now(timezone.utc).astimezone(ZoneInfo("Asia/Shanghai"))
        return f"{category.value}-{local:%Y%m%d-%H%M%S}"

    @staticmethod
    def _job_detail(session: Session, job: Job) -> JobDetailRead:
        return JobDetailRead.model_validate(job)

    @staticmethod
    def _job_item_reads(session: Session, items: list[JobItem]) -> list[JobItemRead]:
        prompt_results = (
            session.exec(
                select(JobItemPromptResult).where(
                    JobItemPromptResult.job_item_id.in_([item.id for item in items]),
                )
            ).all()
            if items
            else []
        )
        prompt_by_item = {row.job_item_id: row for row in prompt_results}
        attempts = (
            session.exec(
                select(GenerationAttempt)
                .where(GenerationAttempt.job_item_id.in_([item.id for item in items]))
                .order_by(GenerationAttempt.job_item_id, GenerationAttempt.attempt_number)
            ).all()
            if items
            else []
        )
        attempts_by_item: dict[int, list[GenerationAttempt]] = {}
        for attempt in attempts:
            attempts_by_item.setdefault(attempt.job_item_id, []).append(attempt)
        samples = (
            session.exec(select(Sample).where(Sample.job_item_id.in_([item.id for item in items]))).all()
            if items
            else []
        )
        sample_by_item = {row.job_item_id: row.id for row in samples}
        item_reads: list[JobItemRead] = []
        for item in items:
            snapshot = session.get(BatchVideoInputSnapshot, item.input_snapshot_id)
            if snapshot is None:
                raise not_found("batchVideoInputSnapshot", item.input_snapshot_id)
            prompt_result = prompt_by_item.get(item.id)
            item_reads.append(
                JobItemRead(
                    id=item.id,
                    sequence=item.sequence,
                    gpu_slot=item.gpu_slot,
                    stage=item.stage,
                    status=item.status,
                    failure_reason=item.failure_reason,
                    failure_code=item.failure_code,
                    renderer_prompt_id=item.renderer_prompt_id,
                    source_asset_id=item.source_asset_id,
                    source_asset_url=asset_content_url(item.source_asset_id),
                    primary_asset_id=item.primary_asset_id,
                    primary_asset_url=asset_content_url(item.primary_asset_id),
                    revision=item.revision,
                    created_at=item.created_at,
                    updated_at=item.updated_at,
                    input=SnapshotRead.model_validate(snapshot),
                    prompt_result=JobItemPromptResultRead.model_validate(prompt_result)
                    if prompt_result is not None
                    else None,
                    latest_attempt=(
                        BatchService._generation_attempt_read(
                            attempts_by_item[item.id][-1]
                        )
                        if attempts_by_item.get(item.id)
                        else None
                    ),
                    attempt_count=len(attempts_by_item.get(item.id, [])),
                    sample_id=sample_by_item.get(item.id),
                )
            )
        return item_reads

    @staticmethod
    def _generation_attempt_read(
        attempt: GenerationAttempt,
    ) -> GenerationAttemptRead:
        return GenerationAttemptRead(
            **attempt.model_dump(exclude={"job_item_id"}),
            source_asset_url=asset_content_url(attempt.source_asset_id),
            primary_asset_url=asset_content_url(attempt.primary_asset_id),
        )

    @staticmethod
    def _job_event_read(event: JobEvent) -> JobEventRead:
        return JobEventRead(
            id=event.id,
            job_id=event.job_id,
            item_id=event.item_id,
            event_type=event.event_type,
            payload=JobEventPayloadRead.model_validate(json.loads(event.payload_json)),
            created_at=event.created_at,
        )

    @staticmethod
    def _get_draft(session: Session, draft_id: int) -> BatchDraft:
        row = session.get(BatchDraft, draft_id)
        if row is None:
            raise not_found("batchDraft", draft_id)
        return row

    @staticmethod
    def _required(session: Session, model: type, identifier: int, resource: str):
        row = session.get(model, identifier)
        if row is None:
            raise not_found(resource, identifier)
        return row

    @staticmethod
    def _check_draft_revision(row: BatchDraft, expected: int) -> None:
        if row.revision != expected:
            raise revision_conflict("batchDraft", row.id, expected, row.revision)

    @staticmethod
    def _check_source(row: object, expected: int, resource: str) -> None:
        actual = row.revision  # type: ignore[attr-defined]
        if actual != expected:
            raise ServiceError(
                409,
                "referenced_resource_changed",
                "A selected record has changed",
                {"resource": resource, "id": row.id, "expectedRevision": expected, "actualRevision": actual},  # type: ignore[attr-defined]
            )

    @staticmethod
    def _source_changed(resource: str, identifier: int) -> None:
        raise ServiceError(
            409,
            "referenced_resource_changed",
            "A selected record changed after the batch draft was saved",
            {"resource": resource, "id": identifier},
        )
