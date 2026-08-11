from __future__ import annotations

import json
import random
from dataclasses import dataclass
from datetime import datetime, timezone
from itertools import product
from zoneinfo import ZoneInfo

from sqlalchemy import delete
from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.adapters.llm import PROMPT_MODEL
from backend.adapters.renderer import RendererGateway, UnconfiguredRendererGateway
from backend.domain.enums import (
    BatchDraftStatus,
    Category,
    ContentStatus,
    ExampleKind,
    GpuAvailability,
    GpuSlotName,
    JobSource,
    JobStatus,
    ModelName,
    ResourceStatus,
)
from backend.domain.models import (
    BatchDraft,
    BatchDraftBackgroundPreset,
    BatchDraftContentPlan,
    BatchDraftDemographic,
    BatchDraftGpuSlot,
    BatchDraftPromptPreset,
    BatchVideoInputSnapshot,
    ContentPlan,
    Dataset,
    GpuSlot,
    Job,
    JobEvent,
    JobItem,
    JobItemPromptResult,
    PromptExample,
    PromptPreset,
    RENDERER_PROFILE_VERSION,
    VIDEO_FPS,
    VIDEO_HEIGHT,
    VIDEO_WIDTH,
    VideoBackgroundPreset,
    utc_now,
)
from backend.domain.schemas import (
    BatchAllocationRead,
    BatchDraftCreate,
    BatchDraftRead,
    BatchDraftUpdate,
    BatchPreviewRead,
    BatchSubmitRequest,
    DemographicInput,
    GpuSlotRead,
    JobDetailRead,
    JobItemRead,
    JobItemPromptResultRead,
    JobSummaryRead,
    JobEventRead,
    SelectionRead,
    SnapshotRead,
)

from .errors import ServiceError, not_found, revision_conflict, state_conflict
from .prompts import PreparedPrompt, PromptContext, PromptService


@dataclass(frozen=True)
class DraftAggregate:
    draft: BatchDraft
    dataset: Dataset
    contents: list[ContentPlan]
    presets: list[PromptPreset]
    preset_examples: dict[int, tuple[list[str], list[str]]]
    backgrounds: list[VideoBackgroundPreset]
    demographics: list[BatchDraftDemographic]
    gpu_slots: list[GpuSlotName]
    content_revisions: dict[int, int]
    preset_revisions: dict[int, int]
    background_revisions: dict[int, int]


@dataclass(frozen=True)
class Allocation:
    sequence: int
    content: ContentPlan
    preset: PromptPreset
    background: VideoBackgroundPreset
    demographic: BatchDraftDemographic
    gpu_slot: GpuSlotName
    model: ModelName
    seed: int
    prepared: PreparedPrompt


def cartesian_allocation_inputs(
    contents: list[ContentPlan],
    presets: list[PromptPreset],
    backgrounds: list[VideoBackgroundPreset],
    demographics: list[BatchDraftDemographic],
    quantity: int,
) -> list[tuple[ContentPlan, PromptPreset, VideoBackgroundPreset, BatchDraftDemographic]]:
    combinations = list(product(contents, presets, backgrounds, demographics))
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

    def list_batch_drafts(self) -> list[BatchDraftRead]:
        with self.database.read_session() as session:
            rows = session.exec(select(BatchDraft).order_by(BatchDraft.created_at.desc(), BatchDraft.id.desc())).all()
            return [self._draft_read(self._load_aggregate(session, row.id)) for row in rows]

    def get_batch_draft(self, draft_id: int) -> BatchDraftRead:
        with self.database.read_session() as session:
            return self._draft_read(self._load_aggregate(session, draft_id))

    def create_batch_draft(self, payload: BatchDraftCreate) -> BatchDraftRead:
        with self.database.immediate_session() as session:
            dataset, contents, presets, backgrounds = self._resolve_selections(session, payload)
            seed = payload.seed if payload.seed is not None else random.SystemRandom().randrange(0, 2**31)
            row = BatchDraft(
                dataset_id=dataset.id,
                dataset_revision=dataset.revision,
                category=payload.category,
                conflict_direction=payload.conflict_direction,
                model=payload.model,
                quantity=payload.quantity,
                seed_base=seed,
            )
            session.add(row)
            session.flush()
            self._replace_links(session, row.id, payload, contents, presets, backgrounds)
            session.flush()
            return self._draft_read(self._load_aggregate(session, row.id))

    def update_batch_draft(self, draft_id: int, payload: BatchDraftUpdate) -> BatchDraftRead:
        with self.database.immediate_session() as session:
            row = self._get_draft(session, draft_id)
            self._check_draft_revision(row, payload.expected_revision)
            if row.status is not BatchDraftStatus.DRAFT:
                raise state_conflict("batchDraft", draft_id, "A submitted batch cannot be changed")
            dataset, contents, presets, backgrounds = self._resolve_selections(session, payload)
            row.dataset_id = dataset.id
            row.dataset_revision = dataset.revision
            row.category = payload.category
            row.conflict_direction = payload.conflict_direction
            row.model = payload.model
            row.quantity = payload.quantity
            if payload.seed is not None:
                row.seed_base = payload.seed
            row.revision += 1
            row.updated_at = utc_now()
            self._delete_links(session, draft_id)
            self._replace_links(session, draft_id, payload, contents, presets, backgrounds)
            session.flush()
            return self._draft_read(self._load_aggregate(session, draft_id))

    def delete_batch_draft(self, draft_id: int, expected_revision: int) -> None:
        with self.database.immediate_session() as session:
            row = self._get_draft(session, draft_id)
            self._check_draft_revision(row, expected_revision)
            if row.status is not BatchDraftStatus.DRAFT:
                raise state_conflict("batchDraft", draft_id, "A submitted batch cannot be deleted")
            session.delete(row)

    def preview_batch(self, draft_id: int, expected_revision: int) -> BatchPreviewRead:
        with self.database.read_session() as session:
            aggregate = self._load_aggregate(session, draft_id)
            self._check_draft_revision(aggregate.draft, expected_revision)
            self._validate_aggregate(aggregate)
            gpu_rows = self._gpu_rows(session, aggregate.gpu_slots)
            allocations = self._build_allocations(aggregate)
            return BatchPreviewRead(
                batch_draft_id=draft_id,
                expected_revision=aggregate.draft.revision,
                gpu_revisions={row.slot: row.revision for row in gpu_rows},
                allocations=[self._allocation_read(value) for value in allocations],
            )

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
            self._validate_gpu_request(session, aggregate, payload)
            allocations = self._build_allocations(aggregate)

        with self.database.immediate_session() as session:
            current = self._load_aggregate(session, draft_id)
            self._check_draft_revision(current.draft, payload.expected_revision)
            self._validate_aggregate(current)
            self._validate_gpu_request(session, current, payload)
            if not self._same_allocations(aggregate, current):
                raise ServiceError(
                    409,
                    "referenced_resource_changed",
                    "A selected record changed before the batch was submitted",
                    {"resource": "batchDraft", "id": draft_id},
                )

            timestamp = utc_now()
            job = Job(
                display_name=self._job_name(current.draft.category),
                source=JobSource.PRODUCTION,
                dataset_id=current.dataset.id,
                batch_draft_id=draft_id,
                category=current.draft.category,
                conflict_direction=current.draft.conflict_direction,
                model=current.draft.model,
                status=JobStatus.QUEUED,
                total_count=current.draft.quantity,
                confirm_model_switch=payload.confirm_model_switch,
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(job)
            session.flush()

            snapshots: list[BatchVideoInputSnapshot] = []
            for allocation in allocations:
                snapshot = BatchVideoInputSnapshot(
                    batch_draft_id=draft_id,
                    dataset_id=current.dataset.id,
                    dataset_revision=current.draft.dataset_revision,
                    sequence=allocation.sequence,
                    content_plan_id=allocation.content.id,
                    content_plan_revision=current.content_revisions[allocation.content.id],
                    prompt_preset_id=allocation.preset.id,
                    prompt_preset_revision=current.preset_revisions[allocation.preset.id],
                    background_preset_id=allocation.background.id,
                    background_preset_revision=current.background_revisions[allocation.background.id],
                    policy_version=allocation.prepared.policy_version,
                    category=current.draft.category,
                    conflict_direction=current.draft.conflict_direction,
                    age=allocation.demographic.age,
                    gender=allocation.demographic.gender,
                    ethnicity=allocation.demographic.ethnicity,
                    model=current.draft.model,
                    seed=allocation.seed,
                    width=VIDEO_WIDTH,
                    height=VIDEO_HEIGHT,
                    fps=VIDEO_FPS,
                    frame_count=121 if current.draft.model is ModelName.LTX else 124,
                    renderer_profile_version=RENDERER_PROFILE_VERSION,
                    prompt_model=PROMPT_MODEL,
                    source_has_audio=True,
                    derive_silent_primary=current.draft.category in {Category.A_VT, Category.C_VT},
                    system_input=allocation.prepared.system_input,
                    user_input=allocation.prepared.user_input,
                    final_negative_prompt=allocation.prepared.final_negative_prompt,
                    true_emotion=allocation.content.true_emotion,
                    apparent_emotion=allocation.content.apparent_emotion,
                    created_at=timestamp,
                )
                session.add(snapshot)
                snapshots.append(snapshot)

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

    def list_jobs(self) -> list[JobSummaryRead]:
        with self.database.read_session() as session:
            rows = session.exec(select(Job).order_by(Job.created_at.desc(), Job.id.desc())).all()
            return [JobSummaryRead.model_validate(row) for row in rows]

    def get_job(self, job_id: int) -> JobDetailRead:
        with self.database.read_session() as session:
            job = session.get(Job, job_id)
            if job is None:
                raise not_found("job", job_id)
            return self._job_detail(session, job)

    def list_gpu_slots(self) -> list[GpuSlotRead]:
        with self.database.read_session() as session:
            rows = session.exec(select(GpuSlot).order_by(GpuSlot.slot)).all()
            return [GpuSlotRead.model_validate(row) for row in rows]

    def _resolve_selections(
        self,
        session: Session,
        payload: BatchDraftCreate | BatchDraftUpdate,
    ) -> tuple[Dataset, list[ContentPlan], list[PromptPreset], list[VideoBackgroundPreset]]:
        dataset = session.get(Dataset, payload.dataset_id)
        if dataset is None:
            raise not_found("dataset", payload.dataset_id)
        if dataset.status is not ResourceStatus.ACTIVE:
            raise state_conflict("dataset", dataset.id, "The selected dataset is disabled")
        contents: list[ContentPlan] = []
        for selection in payload.content_plans:
            row = session.get(ContentPlan, selection.id)
            if row is None:
                raise not_found("contentPlan", selection.id)
            self._check_source(row, selection.expected_revision, "contentPlan")
            if row.category is not payload.category:
                raise ServiceError(422, "validation_error", "The content category does not match the batch")
            if row.status is not ContentStatus.ACTIVE:
                raise state_conflict("contentPlan", row.id, "The selected content plan is not active")
            contents.append(row)
        presets: list[PromptPreset] = []
        for selection in payload.prompt_presets:
            row = session.get(PromptPreset, selection.id)
            if row is None:
                raise not_found("promptPreset", selection.id)
            self._check_source(row, selection.expected_revision, "promptPreset")
            if row.category is not payload.category:
                raise ServiceError(422, "validation_error", "The prompt preset category does not match the batch")
            if row.status is not ResourceStatus.ACTIVE:
                raise state_conflict("promptPreset", row.id, "The selected prompt preset is disabled")
            presets.append(row)
        backgrounds: list[VideoBackgroundPreset] = []
        for selection in payload.background_presets:
            row = session.get(VideoBackgroundPreset, selection.id)
            if row is None:
                raise not_found("videoBackgroundPreset", selection.id)
            self._check_source(row, selection.expected_revision, "videoBackgroundPreset")
            if row.status is not ResourceStatus.ACTIVE:
                raise state_conflict("videoBackgroundPreset", row.id, "The selected background preset is disabled")
            backgrounds.append(row)
        for slot in payload.gpu_slots:
            if session.get(GpuSlot, slot) is None:
                raise not_found("gpuSlot", slot.value)
        return dataset, contents, presets, backgrounds

    @staticmethod
    def _replace_links(
        session: Session,
        draft_id: int,
        payload: BatchDraftCreate | BatchDraftUpdate,
        contents: list[ContentPlan],
        presets: list[PromptPreset],
        backgrounds: list[VideoBackgroundPreset],
    ) -> None:
        for position, row in enumerate(contents):
            session.add(
                BatchDraftContentPlan(
                    batch_draft_id=draft_id,
                    content_plan_id=row.id,
                    position=position,
                    source_revision=row.revision,
                )
            )
        for position, row in enumerate(presets):
            session.add(
                BatchDraftPromptPreset(
                    batch_draft_id=draft_id,
                    prompt_preset_id=row.id,
                    position=position,
                    source_revision=row.revision,
                )
            )
        for position, row in enumerate(backgrounds):
            session.add(
                BatchDraftBackgroundPreset(
                    batch_draft_id=draft_id,
                    background_preset_id=row.id,
                    position=position,
                    source_revision=row.revision,
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
            BatchDraftContentPlan,
            BatchDraftPromptPreset,
            BatchDraftBackgroundPreset,
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
            select(BatchDraftContentPlan)
            .where(BatchDraftContentPlan.batch_draft_id == draft_id)
            .order_by(BatchDraftContentPlan.position)
        ).all()
        preset_links = session.exec(
            select(BatchDraftPromptPreset)
            .where(BatchDraftPromptPreset.batch_draft_id == draft_id)
            .order_by(BatchDraftPromptPreset.position)
        ).all()
        background_links = session.exec(
            select(BatchDraftBackgroundPreset)
            .where(BatchDraftBackgroundPreset.batch_draft_id == draft_id)
            .order_by(BatchDraftBackgroundPreset.position)
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
        contents = [self._required(session, ContentPlan, link.content_plan_id, "contentPlan") for link in content_links]
        presets = [self._required(session, PromptPreset, link.prompt_preset_id, "promptPreset") for link in preset_links]
        backgrounds = [
            self._required(session, VideoBackgroundPreset, link.background_preset_id, "videoBackgroundPreset")
            for link in background_links
        ]
        examples: dict[int, tuple[list[str], list[str]]] = {}
        for preset in presets:
            rows = session.exec(
                select(PromptExample)
                .where(PromptExample.preset_id == preset.id)
                .order_by(PromptExample.kind, PromptExample.position)
            ).all()
            examples[preset.id] = (
                [row.text for row in rows if row.kind is ExampleKind.POSITIVE],
                [row.text for row in rows if row.kind is ExampleKind.NEGATIVE],
            )
        aggregate = DraftAggregate(
            draft=draft,
            dataset=dataset,
            contents=contents,
            presets=presets,
            preset_examples=examples,
            backgrounds=backgrounds,
            demographics=demographics,
            gpu_slots=[link.gpu_slot for link in gpu_links],
            content_revisions={link.content_plan_id: link.source_revision for link in content_links},
            preset_revisions={link.prompt_preset_id: link.source_revision for link in preset_links},
            background_revisions={link.background_preset_id: link.source_revision for link in background_links},
        )
        self._ensure_complete_aggregate(aggregate)
        return aggregate

    @staticmethod
    def _ensure_complete_aggregate(aggregate: DraftAggregate) -> None:
        if not aggregate.contents or not aggregate.presets or not aggregate.backgrounds:
            raise ServiceError(409, "state_conflict", "The batch draft has incomplete source selections")
        if not aggregate.demographics or not aggregate.gpu_slots:
            raise ServiceError(409, "state_conflict", "The batch draft has incomplete allocation settings")

    def _validate_aggregate(self, aggregate: DraftAggregate) -> None:
        if aggregate.draft.status is not BatchDraftStatus.DRAFT:
            raise state_conflict("batchDraft", aggregate.draft.id, "The batch has already been submitted")
        if aggregate.dataset.revision != aggregate.draft.dataset_revision or aggregate.dataset.status is not ResourceStatus.ACTIVE:
            self._source_changed("dataset", aggregate.dataset.id)
        for row in aggregate.contents:
            if row.revision != aggregate.content_revisions[row.id] or row.status is not ContentStatus.ACTIVE:
                self._source_changed("contentPlan", row.id)
        for row in aggregate.presets:
            if row.revision != aggregate.preset_revisions[row.id] or row.status is not ResourceStatus.ACTIVE:
                self._source_changed("promptPreset", row.id)
        for row in aggregate.backgrounds:
            if row.revision != aggregate.background_revisions[row.id] or row.status is not ResourceStatus.ACTIVE:
                self._source_changed("videoBackgroundPreset", row.id)

    def _build_allocations(self, aggregate: DraftAggregate) -> list[Allocation]:
        seed_source = random.Random(aggregate.draft.seed_base)
        values: list[Allocation] = []
        inputs = cartesian_allocation_inputs(
            aggregate.contents,
            aggregate.presets,
            aggregate.backgrounds,
            aggregate.demographics,
            aggregate.draft.quantity,
        )
        for offset, (content, preset, background, demographic) in enumerate(inputs):
            positive, negative = aggregate.preset_examples[preset.id]
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
            content_plan=SelectionRead(
                id=allocation.content.id,
                name=allocation.content.name,
                revision=allocation.content.revision,
            ),
            prompt_preset=SelectionRead(
                id=allocation.preset.id,
                name=allocation.preset.name,
                revision=allocation.preset.revision,
            ),
            background_preset=SelectionRead(
                id=allocation.background.id,
                name=allocation.background.name,
                revision=allocation.background.revision,
            ),
            demographic=DemographicInput(
                age=allocation.demographic.age,
                gender=allocation.demographic.gender,
                ethnicity=allocation.demographic.ethnicity,
            ),
            gpu_slot=allocation.gpu_slot,
            model=allocation.model,
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
    ) -> None:
        selected = set(aggregate.gpu_slots)
        if set(payload.expected_gpu_revisions) != selected:
            raise ServiceError(422, "validation_error", "GPU revisions must match the selected GPU slots")
        for row in self._gpu_rows(session, aggregate.gpu_slots):
            expected = payload.expected_gpu_revisions[row.slot]
            if row.revision != expected:
                raise ServiceError(
                    409,
                    "gpu_state_changed",
                    "The selected GPU state changed",
                    {"slot": row.slot.value, "expectedRevision": expected, "actualRevision": row.revision},
                )
            if row.availability is not GpuAvailability.AVAILABLE:
                raise ServiceError(
                    409,
                    "gpu_unavailable",
                    "The selected GPU is not available",
                    {"slot": row.slot.value, "availability": row.availability.value},
                )
            if (
                row.loaded_model is not None
                and row.loaded_model is not aggregate.draft.model
                and not payload.confirm_model_switch
            ):
                raise ServiceError(
                    409,
                    "model_switch_required",
                    "The GPU is loaded with a different model",
                    {
                        "slot": row.slot.value,
                        "loadedModel": row.loaded_model.value,
                        "requestedModel": aggregate.draft.model.value,
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
            dataset_id=aggregate.draft.dataset_id,
            dataset_revision=aggregate.draft.dataset_revision,
            category=aggregate.draft.category,
            conflict_direction=aggregate.draft.conflict_direction,
            model=aggregate.draft.model,
            quantity=aggregate.draft.quantity,
            seed=aggregate.draft.seed_base,
            status=aggregate.draft.status,
            content_plans=[
                SelectionRead(id=row.id, name=row.name, revision=aggregate.content_revisions[row.id])
                for row in aggregate.contents
            ],
            prompt_presets=[
                SelectionRead(id=row.id, name=row.name, revision=aggregate.preset_revisions[row.id])
                for row in aggregate.presets
            ],
            background_presets=[
                SelectionRead(id=row.id, name=row.name, revision=aggregate.background_revisions[row.id])
                for row in aggregate.backgrounds
            ],
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
            and [(row.id, row.revision) for row in before.contents]
            == [(row.id, row.revision) for row in after.contents]
            and [(row.id, row.revision) for row in before.presets]
            == [(row.id, row.revision) for row in after.presets]
            and [(row.id, row.revision) for row in before.backgrounds]
            == [(row.id, row.revision) for row in after.backgrounds]
            and before.gpu_slots == after.gpu_slots
        )

    @staticmethod
    def _job_name(category: Category) -> str:
        local = datetime.now(timezone.utc).astimezone(ZoneInfo("Asia/Shanghai"))
        return f"{category.value}-{local:%Y%m%d-%H%M%S}"

    @staticmethod
    def _job_detail(session: Session, job: Job) -> JobDetailRead:
        items = session.exec(select(JobItem).where(JobItem.job_id == job.id).order_by(JobItem.sequence)).all()
        prompt_results = session.exec(
            select(JobItemPromptResult).where(
                JobItemPromptResult.job_item_id.in_([item.id for item in items]),
            )
        ).all()
        prompt_by_item = {row.job_item_id: row for row in prompt_results}
        events = session.exec(select(JobEvent).where(JobEvent.job_id == job.id).order_by(JobEvent.id)).all()
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
                    revision=item.revision,
                    created_at=item.created_at,
                    updated_at=item.updated_at,
                    input=SnapshotRead.model_validate(snapshot),
                    prompt_result=JobItemPromptResultRead.model_validate(prompt_result)
                    if prompt_result is not None
                    else None,
                )
            )
        event_reads = [
            JobEventRead(
                id=event.id,
                job_id=event.job_id,
                item_id=event.item_id,
                event_type=event.event_type,
                payload=json.loads(event.payload_json),
                created_at=event.created_at,
            )
            for event in events
        ]
        return JobDetailRead(**JobSummaryRead.model_validate(job).model_dump(), items=item_reads, events=event_reads)

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
