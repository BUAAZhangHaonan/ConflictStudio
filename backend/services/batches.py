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
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobSource,
    JobStatus,
    ModelName,
    Precision,
    PromptExampleKind,
    ResourceStatus,
    TemplateVersionStatus,
)
from backend.domain.models import (
    BatchDraft,
    BatchDraftCombination,
    BatchDraftGpuSlot,
    BatchDraftPromptTemplateVersion,
    BatchDraftSeed,
    BatchVideoInputSnapshot,
    ContentScript,
    ContentScriptScene,
    Dataset,
    GenerationAttempt,
    GpuSlot,
    Job,
    JobEvent,
    JobItem,
    JobItemPromptResult,
    PromptTemplate,
    PromptTemplateExample,
    PromptTemplateVersion,
    RENDERER_PROFILE_VERSION,
    Sample,
    VIDEO_FPS,
    VIDEO_HEIGHT,
    VIDEO_WIDTH,
    Scene,
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
    JobProfileRead,
    JobSummaryRead,
    PageRead,
    PromptFailureDetails,
    SelectionRead,
    SnapshotRead,
    SourceSelection,
    PromptTestCreate,
    VideoTestCreate,
)

from .errors import ServiceError, not_found, revision_conflict, state_conflict
from .assets import asset_content_url
from .gpu_slots import GpuSlotService, GpuSlotSnapshot
from .prompts import PreparedPrompt, PromptContext, PromptResult, PromptService
from .pagination import PAGE_SIZE, paginate


@dataclass(frozen=True)
class DraftContentSelection:
    content: ContentScript
    scenes: list[Scene]
    compatible_scenes: list[Scene]
    content_revision: int
    scene_revisions: dict[int, int]


@dataclass(frozen=True)
class DraftAggregate:
    draft: BatchDraft
    dataset: Dataset
    selections: list[DraftContentSelection]
    template: PromptTemplate
    preset: PromptTemplateVersion
    preset_revision: int
    preset_examples: tuple[list[str], list[str]]
    combinations: list["DraftCombination"]
    seeds: list[int]
    gpu_slots: list[GpuSlotName]


@dataclass(frozen=True)
class DraftCombination:
    position: int
    content: ContentScript
    scene: Scene
    content_revision: int
    scene_revision: int
    demographic: DemographicInput


@dataclass(frozen=True)
class Allocation:
    sequence: int
    content: ContentScript
    template: PromptTemplate
    preset: PromptTemplateVersion
    scene: Scene
    demographic: DemographicInput
    gpu_slot: GpuSlotName
    model: ModelName
    precision: Precision | None
    seed: int
    prepared: PreparedPrompt


@dataclass(frozen=True)
class PromptSelection:
    content: ContentScript
    template: PromptTemplate
    preset: PromptTemplateVersion
    scene: Scene
    prepared: PreparedPrompt


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

    def create_batch_draft(self, payload: BatchDraftCreate) -> BatchDraftRead:
        with self.database.immediate_session() as session:
            dataset, selections, preset = self._resolve_selections(session, payload)
            row = BatchDraft(
                dataset_id=dataset.id,
                dataset_revision=dataset.revision,
                category=payload.category,
                conflict_direction=payload.conflict_direction,
                model=payload.model,
                precision=payload.precision,
                display_name=payload.display_name,
            )
            session.add(row)
            session.flush()
            self._replace_links(session, row.id, payload, selections, preset)
            session.flush()
            return self._draft_read(self._load_aggregate(session, row.id))

    def update_batch_draft(
        self, draft_id: int, payload: BatchDraftUpdate
    ) -> BatchDraftRead:
        with self.database.immediate_session() as session:
            return self.apply_confirmed_batch_draft(session, draft_id, payload)

    def apply_confirmed_batch_draft(
        self,
        session: Session,
        draft_id: int,
        payload: BatchDraftUpdate,
    ) -> BatchDraftRead:
        row = self._get_draft(session, draft_id)
        self._check_draft_revision(row, payload.expected_revision)
        if row.status is not BatchDraftStatus.DRAFT:
            raise state_conflict(
                "batchDraft",
                draft_id,
                "A submitted batch cannot be changed",
            )
        dataset, selections, preset = self._resolve_selections(session, payload)
        row.dataset_id = dataset.id
        row.dataset_revision = dataset.revision
        row.category = payload.category
        row.conflict_direction = payload.conflict_direction
        row.model = payload.model
        row.precision = payload.precision
        row.display_name = payload.display_name
        row.revision += 1
        row.updated_at = utc_now()
        self._delete_links(session, draft_id)
        self._replace_links(session, draft_id, payload, selections, preset)
        session.flush()
        return self._draft_read(self._load_aggregate(session, draft_id))

    async def preview_batch(
        self, draft_id: int, expected_revision: int
    ) -> BatchPreviewRead:
        with self.database.read_session() as session:
            aggregate = self._load_aggregate(session, draft_id)
            self._check_draft_revision(aggregate.draft, expected_revision)
            self._validate_aggregate(aggregate)
            allocations = self._build_allocations(aggregate)

        live_gpu_slots = await self.gpu_slots.inspect_slots(aggregate.gpu_slots)
        return BatchPreviewRead(
            batch_draft_id=draft_id,
            expected_revision=aggregate.draft.revision,
            combination_count=len(aggregate.combinations),
            seed_count=len(aggregate.seeds),
            total_count=len(allocations),
            gpu_revisions={
                slot: snapshot.revision for slot, snapshot in live_gpu_slots.items()
            },
            allocations=[self._allocation_read(value) for value in allocations],
        )

    async def submit_prompt_test(self, payload: PromptTestCreate) -> JobDetailRead:
        with self.database.read_session() as session:
            selection = self._prepare_prompt_selection(
                session,
                payload.content_script,
                payload.prompt_template_version,
                payload.scene,
                payload.demographic,
                payload.model,
            )
        prompt_result = await self.prompts.complete(
            selection.prepared,
            selection.content.category,
        )
        timestamp = utc_now()
        seed = random.SystemRandom().randrange(0, 2**31)
        with self.database.immediate_session() as session:
            current = self._prepare_prompt_selection(
                session,
                payload.content_script,
                payload.prompt_template_version,
                payload.scene,
                payload.demographic,
                payload.model,
            )
            job = Job(
                display_name=self._job_name(current.content.category),
                source=JobSource.PROMPT_TEST,
                dataset_id=None,
                batch_draft_id=None,
                category=current.content.category,
                conflict_direction=current.content.conflict_direction,
                model=None,
                precision=None,
                status=JobStatus.COMPLETED,
                total_count=1,
                prepared_count=1,
                completed_count=1,
                started_at=timestamp,
                finished_at=timestamp,
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(job)
            session.flush()
            snapshot = self._test_snapshot(
                current,
                payload.demographic,
                payload.model,
                payload.precision,
                seed,
                prompt_result,
                1,
                timestamp,
            )
            session.add(snapshot)
            session.flush()
            item = JobItem(
                job_id=job.id,
                sequence=1,
                input_snapshot_id=snapshot.id,
                gpu_slot=None,
                stage=JobItemStage.COMPLETED,
                status=JobStatus.COMPLETED,
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(item)
            session.flush()
            self._add_prompt_result(
                session,
                item.id,
                prompt_result,
                self._negative_prompt(current.preset, payload.model),
                timestamp,
            )
            self._append_job_event(session, job, "JobCompleted", item)
            session.flush()
            return self._job_detail(session, job)

    async def submit_video_test(self, payload: VideoTestCreate) -> JobDetailRead:
        if not self.renderer.configured:
            raise ServiceError(
                503,
                "renderer_not_configured",
                "Rendering requires a configured renderer gateway",
            )

        with self.database.read_session() as session:
            selection = self._prepare_prompt_selection(
                session,
                payload.content_script,
                payload.prompt_template_version,
                payload.scene,
                payload.demographic,
                payload.comparisons[0].model,
            )
        prompt_result = await self.prompts.complete(
            selection.prepared, selection.content.category
        )
        seed = (
            payload.seed
            if payload.seed is not None
            else random.SystemRandom().randrange(0, 2**31)
        )
        selected_slots = list(
            dict.fromkeys(value.gpu_slot for value in payload.comparisons)
        )
        async with self.gpu_slots.submission_inspection(
            selected_slots
        ) as live_gpu_slots:
            with self.database.immediate_session() as session:
                current = self._prepare_prompt_selection(
                    session,
                    payload.content_script,
                    payload.prompt_template_version,
                    payload.scene,
                    payload.demographic,
                    payload.comparisons[0].model,
                )
                requested_profiles: dict[
                    GpuSlotName, list[tuple[ModelName, Precision | None]]
                ] = {slot: [] for slot in selected_slots}
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
                    source=JobSource.VIDEO_TEST,
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
                        dataset_name=None,
                        sequence=sequence,
                        content_script_id=current.content.id,
                        content_script_revision=current.content.revision,
                        prompt_template_version_id=current.preset.id,
                        prompt_template_version_revision=current.preset.revision,
                        scene_id=current.scene.id,
                        scene_revision=current.scene.revision,
                        policy_version=prompt_result.policy_version,
                        category=current.content.category,
                        conflict_direction=current.content.conflict_direction,
                        age=payload.demographic.age,
                        gender=payload.demographic.gender,
                        ethnicity=payload.demographic.ethnicity,
                        language=payload.demographic.language,
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
                        negative_prompt=(
                            self._negative_prompt(current.preset, comparison.model)
                        ),
                        true_emotion=current.content.true_emotion,
                        apparent_emotion=current.content.apparent_emotion,
                        **self._snapshot_catalog_fields(
                            current.content,
                            current.scene,
                        ),
                        created_at=timestamp,
                    )
                    session.add(snapshot)
                    snapshots.append(snapshot)
                session.flush()

                for sequence, (comparison, snapshot) in enumerate(
                    zip(payload.comparisons, snapshots, strict=True),
                    start=1,
                ):
                    item = JobItem(
                        job_id=job.id,
                        sequence=sequence,
                        input_snapshot_id=snapshot.id,
                        gpu_slot=comparison.gpu_slot,
                        stage=JobItemStage.PROMPT_READY,
                        status=JobStatus.QUEUED,
                        created_at=timestamp,
                        updated_at=timestamp,
                    )
                    session.add(item)
                    session.flush()
                    self._add_prompt_result(
                        session,
                        item.id,
                        prompt_result,
                        self._negative_prompt(current.preset, comparison.model),
                        timestamp,
                    )
                job.prepared_count = len(payload.comparisons)
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

    async def submit_batch(
        self, draft_id: int, payload: BatchSubmitRequest
    ) -> JobDetailRead:
        if not self.renderer.configured:
            raise ServiceError(
                503,
                "renderer_not_configured",
                "Rendering requires a configured renderer gateway",
            )
        if not self.prompts.configured:
            raise ServiceError(
                503,
                "external_configuration_missing",
                "Prompt generation requires a configured service key",
            )


        with self.database.read_session() as session:
            aggregate = self._load_aggregate(session, draft_id)
            self._check_draft_revision(aggregate.draft, payload.expected_revision)
            self._validate_aggregate(aggregate)
            allocations = self._build_allocations(aggregate)

        async with self.gpu_slots.submission_inspection(
            aggregate.gpu_slots
        ) as live_gpu_slots:
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
                current.draft.status = BatchDraftStatus.SUBMITTED
                current.draft.revision += 1
                current.draft.updated_at = timestamp
                session.flush()
                job = Job(
                    display_name=current.draft.display_name
                    or self._job_name(current.draft.category),
                    source=JobSource.PRODUCTION,
                    dataset_id=current.dataset.id,
                    dataset_name_snapshot=current.dataset.name,
                    batch_draft_id=draft_id,
                    category=current.draft.category,
                    conflict_direction=current.draft.conflict_direction,
                    model=current.draft.model,
                    precision=current.draft.precision,
                    status=JobStatus.QUEUED,
                    total_count=len(allocations),
                    confirm_model_switch=payload.confirm_model_switch,
                    created_at=timestamp,
                    updated_at=timestamp,
                )
                session.add(job)
                session.flush()

                snapshots: list[BatchVideoInputSnapshot] = []
                selections_by_content = {
                    selection.content.id: selection for selection in current.selections
                }
                for allocation in allocations:
                    selection = selections_by_content[allocation.content.id]
                    snapshot = BatchVideoInputSnapshot(
                        batch_draft_id=draft_id,
                        dataset_id=current.dataset.id,
                        dataset_revision=current.draft.dataset_revision,
                        dataset_name=current.dataset.name,
                        sequence=allocation.sequence,
                        content_script_id=allocation.content.id,
                        content_script_revision=selection.content_revision,
                        prompt_template_version_id=allocation.preset.id,
                        prompt_template_version_revision=current.preset_revision,
                        scene_id=allocation.scene.id,
                        scene_revision=selection.scene_revisions[allocation.scene.id],
                        policy_version=allocation.prepared.policy_version,
                        category=current.draft.category,
                        conflict_direction=current.draft.conflict_direction,
                        age=allocation.demographic.age,
                        gender=allocation.demographic.gender,
                        ethnicity=allocation.demographic.ethnicity,
                        language=allocation.demographic.language,
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
                        derive_silent_primary=current.draft.category
                        in {Category.A_VT, Category.C_VT},
                        system_input=allocation.prepared.system_input,
                        user_input=allocation.prepared.user_input,
                        negative_prompt=allocation.prepared.negative_prompt,
                        true_emotion=allocation.content.true_emotion,
                        apparent_emotion=allocation.content.apparent_emotion,
                        **self._snapshot_catalog_fields(
                            allocation.content,
                            allocation.scene,
                        ),
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
                session.flush()
                return self._job_detail(session, job)

    def list_test_results(
        self,
        page: int,
        source: JobSource | None = None,
        statuses: list[JobStatus] | None = None,
    ) -> PageRead[JobSummaryRead]:
        if source is JobSource.PRODUCTION:
            raise ServiceError(
                422,
                "validation_error",
                "Test results can only contain prompt tests or video tests",
            )
        sources = (
            [source]
            if source is not None
            else [JobSource.PROMPT_TEST, JobSource.VIDEO_TEST]
        )
        with self.database.read_session() as session:
            statement = select(Job).where(Job.source.in_(sources))
            if statuses:
                statement = statement.where(Job.status.in_(statuses))
            return self._result_page(session, statement, page)

    def list_production_results(
        self,
        page: int,
        statuses: list[JobStatus] | None = None,
    ) -> PageRead[JobSummaryRead]:
        with self.database.read_session() as session:
            statement = select(Job).where(Job.source == JobSource.PRODUCTION)
            if statuses:
                statement = statement.where(Job.status.in_(statuses))
            return self._result_page(session, statement, page)

    def get_test_result(self, job_id: int) -> JobDetailRead:
        return self._get_result(job_id, {JobSource.PROMPT_TEST, JobSource.VIDEO_TEST})

    def get_production_result(self, job_id: int) -> JobDetailRead:
        return self._get_result(job_id, {JobSource.PRODUCTION})

    def get_job(self, job_id: int) -> JobDetailRead:
        with self.database.read_session() as session:
            job = session.get(Job, job_id)
            if job is None:
                raise not_found("job", job_id)
            return self._job_detail(session, job)

    def job_exists(self, job_id: int) -> bool:
        with self.database.read_session() as session:
            return session.get(Job, job_id) is not None

    def list_test_result_items(
        self,
        job_id: int,
        page: int,
    ) -> PageRead[JobItemRead]:
        return self._list_result_items(
            job_id,
            page,
            {JobSource.PROMPT_TEST, JobSource.VIDEO_TEST},
        )

    def list_production_result_items(
        self,
        job_id: int,
        page: int,
    ) -> PageRead[JobItemRead]:
        return self._list_result_items(job_id, page, {JobSource.PRODUCTION})

    def _list_result_items(
        self,
        job_id: int,
        page: int,
        sources: set[JobSource],
    ) -> PageRead[JobItemRead]:
        with self.database.read_session() as session:
            job = self._required(session, Job, job_id, "job")
            if job.source not in sources:
                raise not_found("job", job_id)
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

    def _get_result(
        self,
        job_id: int,
        sources: set[JobSource],
    ) -> JobDetailRead:
        with self.database.read_session() as session:
            job = session.get(Job, job_id)
            if job is None or job.source not in sources:
                raise not_found("job", job_id)
            return self._job_detail(session, job)

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

    def list_job_events(
        self, job_id: int, page: int, order: str = "asc"
    ) -> PageRead[JobEventRead]:
        with self.database.read_session() as session:
            self._required(session, Job, job_id, "job")
            ordering = JobEvent.id.desc() if order == "desc" else JobEvent.id
            return paginate(
                session,
                select(JobEvent).where(JobEvent.job_id == job_id).order_by(ordering),
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
                JobStatus.INTERRUPTED,
            }

    async def list_gpu_slots(self) -> list[GpuSlotSnapshot]:
        return await self.gpu_slots.inspect_all()

    async def release_gpu_slot(
        self,
        slot: GpuSlotName,
        expected_revision: int,
    ) -> GpuSlotSnapshot:
        if not self.renderer.configured:
            raise ServiceError(
                503,
                "renderer_not_configured",
                "Rendering requires a configured renderer gateway",
            )
        return await self.gpu_slots.release(slot, expected_revision)

    def _prepare_prompt_selection(
        self,
        session: Session,
        content_selection: SourceSelection,
        preset_selection: SourceSelection,
        scene_selection: SourceSelection,
        demographic: DemographicInput,
        model: ModelName,
    ) -> PromptSelection:
        content = self._required(
            session, ContentScript, content_selection.id, "contentScript"
        )
        preset = self._required(
            session, PromptTemplateVersion, preset_selection.id, "promptTemplateVersion"
        )
        template = self._required(
            session,
            PromptTemplate,
            preset.template_id,
            "promptTemplate",
        )
        scene = self._required(
            session,
            Scene,
            scene_selection.id,
            "scene",
        )
        self._check_source(
            content, content_selection.expected_revision, "contentScript"
        )
        self._check_source(
            preset, preset_selection.expected_revision, "promptTemplateVersion"
        )
        self._check_source(scene, scene_selection.expected_revision, "scene")
        if content.status is not ContentStatus.ACTIVE:
            raise state_conflict(
                "contentScript", content.id, "The selected content script is not active"
            )
        if scene.status is not ResourceStatus.ACTIVE:
            raise state_conflict(
                "scene",
                scene.id,
                "The selected scene is disabled",
            )
        if template.category is not content.category:
            raise ServiceError(
                422,
                "validation_error",
                "The prompt template version category does not match the content",
            )
        if (
            session.exec(
                select(ContentScriptScene).where(
                    ContentScriptScene.content_script_id == content.id,
                    ContentScriptScene.scene_id == scene.id,
                )
            ).first()
            is None
        ):
            raise ServiceError(
                422,
                "incompatible_content_scene",
                "The selected scene is not registered for this content script",
            )
        positive_examples, negative_examples = self._version_examples(
            session, preset.id
        )
        prepared = self.prompts.prepare(
            PromptContext(
                content=content,
                template_version=preset,
                positive_examples=positive_examples,
                negative_examples=negative_examples,
                scene=scene,
                age=demographic.age,
                gender=demographic.gender,
                ethnicity=demographic.ethnicity,
                language=demographic.language,
                model=model,
            )
        )
        return PromptSelection(content, template, preset, scene, prepared)

    def _resolve_selections(
        self,
        session: Session,
        payload: BatchDraftCreate | BatchDraftUpdate,
    ) -> tuple[Dataset, list[DraftContentSelection], PromptTemplateVersion]:
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

        preset = session.get(PromptTemplateVersion, payload.prompt_template_version_id)
        if preset is None:
            raise not_found("promptTemplateVersion", payload.prompt_template_version_id)
        template = self._required(
            session,
            PromptTemplate,
            preset.template_id,
            "promptTemplate",
        )
        if template.category is not payload.category:
            raise ServiceError(
                422,
                "validation_error",
                "The prompt template version category does not match the batch",
            )
        if preset.verification_status is not TemplateVersionStatus.VERIFIED:
            raise ServiceError(
                422,
                "validation_error",
                "The selected prompt template version is not verified",
            )

        selections: list[DraftContentSelection] = []
        for requested in payload.content_selections:
            content = session.get(ContentScript, requested.content_script_id)
            if content is None:
                raise not_found("contentScript", requested.content_script_id)
            if (
                content.category is not payload.category
                or content.conflict_direction is not payload.conflict_direction
            ):
                raise ServiceError(
                    422,
                    "validation_error",
                    "The content category and direction must match the batch",
                )
            if content.status is not ContentStatus.ACTIVE:
                raise ServiceError(
                    422,
                    "validation_error",
                    "The selected content script is not active",
                )
            mappings = session.exec(
                select(ContentScriptScene)
                .where(ContentScriptScene.content_script_id == content.id)
                .order_by(ContentScriptScene.position)
            ).all()
            mapped_ids = [mapping.scene_id for mapping in mappings]
            compatible_scenes = [
                self._required(
                    session,
                    Scene,
                    scene_id,
                    "scene",
                )
                for scene_id in mapped_ids
            ]
            if content.mode is ContentMode.FIXED:
                if requested.scene_ids:
                    raise ServiceError(
                        422,
                        "fixed_scene_is_automatic",
                        "Fixed content does not accept a scene selection",
                    )
                if len(mapped_ids) != 1:
                    raise ServiceError(
                        422,
                        "content_scene_missing",
                        "Fixed content requires exactly one registered source scene",
                    )
                selected_ids = mapped_ids
            else:
                if not requested.scene_ids:
                    raise ServiceError(
                        422,
                        "content_scene_required",
                        "Generative content requires at least one registered scene",
                    )
                if any(scene_id not in mapped_ids for scene_id in requested.scene_ids):
                    raise ServiceError(
                        422,
                        "incompatible_content_scene",
                        "A selected scene is not registered for this content script",
                    )
                selected_ids = requested.scene_ids
            scenes = [
                self._required(
                    session,
                    Scene,
                    scene_id,
                    "scene",
                )
                for scene_id in selected_ids
            ]
            if any(scene.status is not ResourceStatus.ACTIVE for scene in scenes):
                raise ServiceError(
                    422,
                    "validation_error",
                    "A selected scene is not active",
                )
            selections.append(
                DraftContentSelection(
                    content=content,
                    scenes=scenes,
                    compatible_scenes=compatible_scenes,
                    content_revision=content.revision,
                    scene_revisions={scene.id: scene.revision for scene in scenes},
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
        preset: PromptTemplateVersion,
    ) -> None:
        combination_position = 0
        for selection in selections:
            for scene in selection.scenes:
                for demographic in payload.demographics:
                    session.add(
                        BatchDraftCombination(
                            batch_draft_id=draft_id,
                            position=combination_position,
                            content_script_id=selection.content.id,
                            content_script_revision=selection.content_revision,
                            scene_id=scene.id,
                            scene_revision=selection.scene_revisions[scene.id],
                            age=demographic.age,
                            gender=demographic.gender,
                            ethnicity=demographic.ethnicity,
                            language=demographic.language,
                        )
                    )
                    combination_position += 1
        session.add(
            BatchDraftPromptTemplateVersion(
                batch_draft_id=draft_id,
                prompt_template_version_id=preset.id,
                position=0,
                source_revision=preset.revision,
            )
        )
        for position, seed in enumerate(payload.seeds):
            session.add(
                BatchDraftSeed(
                    batch_draft_id=draft_id,
                    position=position,
                    seed=seed,
                )
            )
        gpu_slots = (
            [GpuSlotName.GPU0, GpuSlotName.GPU1]
            if set(payload.gpu_slots) == {GpuSlotName.GPU0, GpuSlotName.GPU1}
            else payload.gpu_slots
        )
        for position, value in enumerate(gpu_slots):
            session.add(
                BatchDraftGpuSlot(
                    batch_draft_id=draft_id, gpu_slot=value, position=position
                )
            )

    @staticmethod
    def _delete_links(session: Session, draft_id: int) -> None:
        for model in (
            BatchDraftCombination,
            BatchDraftPromptTemplateVersion,
            BatchDraftSeed,
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
        combination_rows = session.exec(
            select(BatchDraftCombination)
            .where(BatchDraftCombination.batch_draft_id == draft_id)
            .order_by(BatchDraftCombination.position)
        ).all()
        preset_links = session.exec(
            select(BatchDraftPromptTemplateVersion)
            .where(BatchDraftPromptTemplateVersion.batch_draft_id == draft_id)
            .order_by(BatchDraftPromptTemplateVersion.position)
        ).all()
        seed_rows = session.exec(
            select(BatchDraftSeed)
            .where(BatchDraftSeed.batch_draft_id == draft_id)
            .order_by(BatchDraftSeed.position)
        ).all()
        gpu_links = session.exec(
            select(BatchDraftGpuSlot)
            .where(BatchDraftGpuSlot.batch_draft_id == draft_id)
            .order_by(BatchDraftGpuSlot.position)
        ).all()
        combinations: list[DraftCombination] = []
        content_order: list[int] = []
        contents: dict[int, ContentScript] = {}
        scenes_by_content: dict[int, list[Scene]] = {}
        content_revisions: dict[int, int] = {}
        scene_revisions: dict[tuple[int, int], int] = {}
        for row in combination_rows:
            if row.content_script_id not in contents:
                content_order.append(row.content_script_id)
                contents[row.content_script_id] = self._required(
                    session,
                    ContentScript,
                    row.content_script_id,
                    "contentScript",
                )
                scenes_by_content[row.content_script_id] = []
                content_revisions[row.content_script_id] = row.content_script_revision
            content = contents[row.content_script_id]
            scene = self._required(session, Scene, row.scene_id, "scene")
            if all(
                current.id != scene.id
                for current in scenes_by_content[row.content_script_id]
            ):
                scenes_by_content[row.content_script_id].append(scene)
                scene_revisions[(row.content_script_id, row.scene_id)] = (
                    row.scene_revision
                )
            combinations.append(
                DraftCombination(
                    position=row.position,
                    content=content,
                    scene=scene,
                    content_revision=row.content_script_revision,
                    scene_revision=row.scene_revision,
                    demographic=DemographicInput(
                        age=row.age,
                        gender=row.gender,
                        ethnicity=row.ethnicity,
                        language=row.language,
                    ),
                )
            )

        selections: list[DraftContentSelection] = []
        for content_id in content_order:
            content = contents[content_id]
            scenes = scenes_by_content[content_id]
            compatible_links = session.exec(
                select(ContentScriptScene)
                .where(ContentScriptScene.content_script_id == content.id)
                .order_by(ContentScriptScene.position)
            ).all()
            compatible_scenes = [
                self._required(
                    session,
                    Scene,
                    link.scene_id,
                    "scene",
                )
                for link in compatible_links
            ]
            compatible_ids = {scene.id for scene in compatible_scenes}
            if any(scene.id not in compatible_ids for scene in scenes):
                raise state_conflict(
                    "batchDraft",
                    draft_id,
                    "A saved content and scene selection is no longer compatible",
                )
            selections.append(
                DraftContentSelection(
                    content=content,
                    scenes=scenes,
                    compatible_scenes=compatible_scenes,
                    content_revision=content_revisions[content_id],
                    scene_revisions={
                        scene.id: scene_revisions[(content_id, scene.id)]
                        for scene in scenes
                    },
                )
            )
        if len(preset_links) != 1:
            raise ServiceError(
                409,
                "state_conflict",
                "The batch draft requires exactly one prompt template version",
            )
        preset_link = preset_links[0]
        preset = self._required(
            session,
            PromptTemplateVersion,
            preset_link.prompt_template_version_id,
            "promptTemplateVersion",
        )
        template = self._required(
            session,
            PromptTemplate,
            preset.template_id,
            "promptTemplate",
        )
        aggregate = DraftAggregate(
            draft=draft,
            dataset=dataset,
            selections=selections,
            template=template,
            preset=preset,
            preset_revision=preset_link.source_revision,
            preset_examples=self._version_examples(session, preset.id),
            combinations=combinations,
            seeds=[row.seed for row in seed_rows],
            gpu_slots=[link.gpu_slot for link in gpu_links],
        )
        return aggregate

    @staticmethod
    def _ensure_complete_aggregate(aggregate: DraftAggregate) -> None:
        if not aggregate.selections or any(
            not selection.scenes for selection in aggregate.selections
        ):
            raise ServiceError(
                409,
                "state_conflict",
                "The batch draft has incomplete source selections",
            )
        if not aggregate.combinations or not aggregate.seeds or not aggregate.gpu_slots:
            raise ServiceError(
                409,
                "state_conflict",
                "The batch draft has incomplete allocation settings",
            )

    def _validate_aggregate(self, aggregate: DraftAggregate) -> None:
        self._ensure_complete_aggregate(aggregate)
        if aggregate.draft.status is not BatchDraftStatus.DRAFT:
            raise state_conflict(
                "batchDraft", aggregate.draft.id, "The batch has already been submitted"
            )
        if (
            aggregate.dataset.revision != aggregate.draft.dataset_revision
            or aggregate.dataset.status is not ResourceStatus.ACTIVE
            or aggregate.dataset.purpose is not DatasetPurpose.FORMAL
        ):
            self._source_changed("dataset", aggregate.dataset.id)
        if (
            aggregate.preset.revision != aggregate.preset_revision
            or aggregate.preset.verification_status
            is not TemplateVersionStatus.VERIFIED
        ):
            self._source_changed("promptTemplateVersion", aggregate.preset.id)
        for selection in aggregate.selections:
            if (
                selection.content.revision != selection.content_revision
                or selection.content.status is not ContentStatus.ACTIVE
            ):
                self._source_changed("contentScript", selection.content.id)
            for scene in selection.scenes:
                if (
                    scene.revision != selection.scene_revisions[scene.id]
                    or scene.status is not ResourceStatus.ACTIVE
                ):
                    self._source_changed("scene", scene.id)

    def _build_allocations(self, aggregate: DraftAggregate) -> list[Allocation]:
        values: list[Allocation] = []
        for seed in aggregate.seeds:
            for combination in aggregate.combinations:
                offset = len(values)
                preset = aggregate.preset
                positive, negative = aggregate.preset_examples
                demographic = combination.demographic
                prepared = self.prompts.prepare(
                    PromptContext(
                        content=combination.content,
                        template_version=preset,
                        positive_examples=positive,
                        negative_examples=negative,
                        scene=combination.scene,
                        age=demographic.age,
                        gender=demographic.gender,
                        ethnicity=demographic.ethnicity,
                        language=demographic.language,
                        model=aggregate.draft.model,
                    )
                )
                values.append(
                    Allocation(
                        sequence=offset + 1,
                        content=combination.content,
                        template=aggregate.template,
                        preset=preset,
                        scene=combination.scene,
                        demographic=demographic,
                        gpu_slot=aggregate.gpu_slots[offset % len(aggregate.gpu_slots)],
                        model=aggregate.draft.model,
                        precision=aggregate.draft.precision,
                        seed=seed,
                        prepared=prepared,
                    )
                )
        return values

    @staticmethod
    def _allocation_read(allocation: Allocation) -> BatchAllocationRead:
        return BatchAllocationRead(
            sequence=allocation.sequence,
            content_script=BilingualSelectionRead(
                id=allocation.content.id,
                name_zh=allocation.content.name_zh,
                name_en=allocation.content.name_en,
                revision=allocation.content.revision,
            ),
            prompt_template_version=SelectionRead(
                id=allocation.preset.id,
                name=f"{allocation.template.name} v{allocation.preset.version}",
                revision=allocation.preset.revision,
            ),
            scene=BilingualSelectionRead(
                id=allocation.scene.id,
                name_zh=allocation.scene.name_zh,
                name_en=allocation.scene.name_en,
                revision=allocation.scene.revision,
            ),
            demographic=DemographicInput(
                age=allocation.demographic.age,
                gender=allocation.demographic.gender,
                ethnicity=allocation.demographic.ethnicity,
                language=allocation.demographic.language,
            ),
            gpu_slot=allocation.gpu_slot,
            model=allocation.model,
            precision=allocation.precision,
            seed=allocation.seed,
            requires_prompt_generation=True,
            system_input=allocation.prepared.system_input,
            user_input=allocation.prepared.user_input,
            final_positive_prompt=None,
            negative_prompt=allocation.prepared.negative_prompt,
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
            display_name=aggregate.draft.display_name,
            category=aggregate.draft.category,
            conflict_direction=aggregate.draft.conflict_direction,
            model=aggregate.draft.model,
            precision=aggregate.draft.precision,
            combination_count=len(aggregate.combinations),
            total_count=len(aggregate.combinations) * len(aggregate.seeds),
            seeds=aggregate.seeds,
            status=aggregate.draft.status,
            content_selections=[
                BatchContentSelectionRead(
                    content_script=BilingualSelectionRead(
                        id=selection.content.id,
                        name_zh=selection.content.name_zh,
                        name_en=selection.content.name_en,
                        revision=selection.content_revision,
                    ),
                    mode=selection.content.mode,
                    scenes=[
                        BilingualSelectionRead(
                            id=scene.id,
                            name_zh=scene.name_zh,
                            name_en=scene.name_en,
                            revision=selection.scene_revisions[scene.id],
                        )
                        for scene in selection.scenes
                    ],
                    compatible_scenes=[
                        BilingualSelectionRead(
                            id=scene.id,
                            name_zh=scene.name_zh,
                            name_en=scene.name_en,
                            revision=scene.revision,
                        )
                        for scene in selection.compatible_scenes
                    ],
                )
                for selection in aggregate.selections
            ],
            prompt_template_version=SelectionRead(
                id=aggregate.preset.id,
                name=f"{aggregate.template.name} v{aggregate.preset.version}",
                revision=aggregate.preset_revision,
            ),
            demographics=[
                DemographicInput(age=age, gender=gender, ethnicity=ethnicity)
                for age, gender, ethnicity in dict.fromkeys(
                    (
                        row.demographic.age,
                        row.demographic.gender,
                        row.demographic.ethnicity,
                    )
                    for row in aggregate.combinations
                )
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
                            scene.id,
                            selection.scene_revisions[scene.id],
                        )
                        for scene in selection.scenes
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
                            scene.id,
                            selection.scene_revisions[scene.id],
                        )
                        for scene in selection.scenes
                    ],
                )
                for selection in after.selections
            ]
            and before.gpu_slots == after.gpu_slots
            and before.seeds == after.seeds
            and [
                (
                    row.position,
                    row.content.id,
                    row.content_revision,
                    row.scene.id,
                    row.scene_revision,
                    row.demographic.age,
                    row.demographic.gender,
                    row.demographic.ethnicity,
                )
                for row in before.combinations
            ]
            == [
                (
                    row.position,
                    row.content.id,
                    row.content_revision,
                    row.scene.id,
                    row.scene_revision,
                    row.demographic.age,
                    row.demographic.gender,
                    row.demographic.ethnicity,
                )
                for row in after.combinations
            ]
        )

    @staticmethod
    def _job_name(category: Category) -> str:
        local = datetime.now(timezone.utc).astimezone(ZoneInfo("Asia/Shanghai"))
        return f"{category.value}-{local:%Y%m%d%H%M%S}"

    @staticmethod
    def _negative_prompt(
        preset: PromptTemplateVersion,
        model: ModelName,
    ) -> str:
        return (
            preset.h3_negative_prompt
            if model is ModelName.H3
            else preset.ltx_negative_prompt
        )

    @staticmethod
    def _version_examples(
        session: Session,
        version_id: int,
    ) -> tuple[list[str], list[str]]:
        rows = session.exec(
            select(PromptTemplateExample)
            .where(PromptTemplateExample.prompt_template_version_id == version_id)
            .order_by(
                PromptTemplateExample.kind,
                PromptTemplateExample.position,
            )
        ).all()
        return (
            [row.text for row in rows if row.kind is PromptExampleKind.POSITIVE],
            [row.text for row in rows if row.kind is PromptExampleKind.NEGATIVE],
        )

    @classmethod
    def _test_snapshot(
        cls,
        selection: PromptSelection,
        demographic: DemographicInput,
        model: ModelName,
        precision: Precision | None,
        seed: int,
        prompt_result: PromptResult,
        sequence: int,
        timestamp: str,
    ) -> BatchVideoInputSnapshot:
        return BatchVideoInputSnapshot(
            batch_draft_id=None,
            dataset_id=None,
            dataset_revision=None,
            dataset_name=None,
            sequence=sequence,
            content_script_id=selection.content.id,
            content_script_revision=selection.content.revision,
            prompt_template_version_id=selection.preset.id,
            prompt_template_version_revision=selection.preset.revision,
            scene_id=selection.scene.id,
            scene_revision=selection.scene.revision,
            policy_version=prompt_result.policy_version,
            category=selection.content.category,
            conflict_direction=selection.content.conflict_direction,
            age=demographic.age,
            gender=demographic.gender,
            ethnicity=demographic.ethnicity,
            language=demographic.language,
            model=model,
            precision=precision,
            seed=seed,
            width=VIDEO_WIDTH,
            height=VIDEO_HEIGHT,
            fps=VIDEO_FPS,
            frame_count=124 if model is ModelName.H3 else 121,
            renderer_profile_version=RENDERER_PROFILE_VERSION,
            prompt_model=PROMPT_MODEL,
            source_has_audio=True,
            derive_silent_primary=selection.content.category
            in {Category.A_VT, Category.C_VT},
            system_input=prompt_result.system_input,
            user_input=prompt_result.user_input,
            negative_prompt=cls._negative_prompt(selection.preset, model),
            true_emotion=selection.content.true_emotion,
            apparent_emotion=selection.content.apparent_emotion,
            **cls._snapshot_catalog_fields(selection.content, selection.scene),
            created_at=timestamp,
        )

    @staticmethod
    def _snapshot_catalog_fields(
        content: ContentScript,
        scene: Scene,
    ) -> dict[str, str]:
        return {
            "content_script_name_zh": content.name_zh,
            "content_script_name_en": content.name_en,
            "content_scene_zh": content.scene_zh,
            "content_scene_en": content.scene_en,
            "trigger_event_zh": content.trigger_event_zh,
            "trigger_event_en": content.trigger_event_en,
            "psychological_background_zh": content.psychological_background_zh,
            "psychological_background_en": content.psychological_background_en,
            "shooting_scene_name_zh": scene.name_zh,
            "shooting_scene_name_en": scene.name_en,
            "shooting_scene_zh": scene.scene_zh,
            "shooting_scene_en": scene.scene_en,
            "ambient_sound_zh": scene.ambient_sound_zh,
            "ambient_sound_en": scene.ambient_sound_en,
            "participant_relationship_zh": scene.participant_relationship_zh,
            "participant_relationship_en": scene.participant_relationship_en,
            "lighting_zh": scene.lighting_zh,
            "lighting_en": scene.lighting_en,
            "framing_zh": scene.framing_zh,
            "framing_en": scene.framing_en,
        }

    @staticmethod
    def _add_prompt_result(
        session: Session,
        item_id: int,
        result: PromptResult,
        negative_prompt: str,
        timestamp: str,
    ) -> None:
        session.add(
            JobItemPromptResult(
                job_item_id=item_id,
                policy_version=result.policy_version,
                system_input=result.system_input,
                user_input=result.user_input,
                raw_structured_response=result.raw_structured_response,
                final_positive_prompt=result.final_positive_prompt,
                negative_prompt=negative_prompt,
                dialogue=result.dialogue,
                vt_text=result.vt_text,
                true_emotion_description=result.true_emotion_description,
                created_at=timestamp,
            )
        )

    @staticmethod
    def _append_job_event(
        session: Session,
        job: Job,
        event_type: str,
        item: JobItem | None = None,
    ) -> None:
        session.add(
            JobEvent(
                job_id=job.id,
                item_id=item.id if item is not None else None,
                event_type=event_type,
                payload_json=json.dumps(
                    {
                        "preparedCount": job.prepared_count,
                        "completedCount": job.completed_count,
                        "failedCount": job.failed_count,
                        "totalCount": job.total_count,
                        **({"sequence": item.sequence} if item is not None else {}),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                created_at=utc_now(),
            )
        )

    @staticmethod
    def _result_page(
        session: Session,
        statement: object,
        page: int,
    ) -> PageRead[JobSummaryRead]:
        rows: PageRead[Job] = paginate(
            session,
            statement.order_by(Job.created_at.desc(), Job.id.desc()),  # type: ignore[attr-defined]
            page,
            lambda job: job,
        )
        job_ids = [job.id for job in rows.items if job.id is not None]
        profiles = BatchService._job_profiles_by_id(session, job_ids)
        return PageRead(
            items=[
                BatchService._job_summary(job, profiles.get(job.id, []))
                for job in rows.items
            ],
            page=rows.page,
            page_size=rows.page_size,
            total=rows.total,
            total_pages=rows.total_pages,
        )

    @staticmethod
    def _job_profiles_by_id(
        session: Session,
        job_ids: list[int],
    ) -> dict[int, list[JobProfileRead]]:
        if not job_ids:
            return {}
        rows = session.exec(
            select(
                JobItem.job_id,
                BatchVideoInputSnapshot.model,
                BatchVideoInputSnapshot.precision,
            )
            .join(
                BatchVideoInputSnapshot,
                JobItem.input_snapshot_id == BatchVideoInputSnapshot.id,
            )
            .where(JobItem.job_id.in_(job_ids))
            .distinct()
            .order_by(
                JobItem.job_id,
                BatchVideoInputSnapshot.model,
                BatchVideoInputSnapshot.precision,
            )
        ).all()
        profiles: dict[int, list[JobProfileRead]] = {}
        for job_id, model, precision in rows:
            profiles.setdefault(job_id, []).append(
                JobProfileRead(model=model, precision=precision)
            )
        return profiles

    @staticmethod
    def _job_summary(job: Job, profiles: list[JobProfileRead]) -> JobSummaryRead:
        return JobSummaryRead(**job.model_dump(), profiles=profiles)

    @staticmethod
    def _job_detail(session: Session, job: Job) -> JobDetailRead:
        if job.id is None:
            raise ValueError("Persisted jobs must have an identifier")
        profiles = BatchService._job_profiles_by_id(session, [job.id])
        return JobDetailRead(**job.model_dump(), profiles=profiles.get(job.id, []))

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
                .order_by(
                    GenerationAttempt.job_item_id, GenerationAttempt.attempt_number
                )
            ).all()
            if items
            else []
        )
        attempts_by_item: dict[int, list[GenerationAttempt]] = {}
        for attempt in attempts:
            attempts_by_item.setdefault(attempt.job_item_id, []).append(attempt)
        samples = (
            session.exec(
                select(Sample).where(
                    Sample.job_item_id.in_([item.id for item in items])
                )
            ).all()
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
                    failure_details=(
                        PromptFailureDetails.model_validate_json(
                            item.failure_details_json
                        )
                        if item.failure_details_json is not None
                        else None
                    ),
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
                {
                    "resource": resource,
                    "id": row.id,
                    "expectedRevision": expected,
                    "actualRevision": actual,
                },  # type: ignore[attr-defined]
            )

    @staticmethod
    def _source_changed(resource: str, identifier: int) -> None:
        raise ServiceError(
            409,
            "referenced_resource_changed",
            "A selected record changed after the batch draft was saved",
            {"resource": resource, "id": identifier},
        )
