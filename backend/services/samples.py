from __future__ import annotations

from sqlalchemy import func, or_
from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.domain.enums import (
    archive_status_for,
    GenerationAttemptStatus,
    Category,
    JobSource,
    JobStatus,
    Relation,
    Protocol,
    ReviewDecision,
    protocol_for,
    relation_for,
)
from backend.domain.models import (
    ArchiveItem,
    BatchVideoInputSnapshot,
    Dataset,
    GenerationAttempt,
    Job,
    JobItem,
    JobItemPromptResult,
    Sample,
    utc_now,
)
from backend.domain.schemas import (
    BilingualSelectionRead,
    emotion_key,
    GenerationAttemptRead,
    PageRead,
    SampleRead,
    SampleClassificationUpdate,
)

from .assets import asset_content_url
from .errors import invalid_request, not_found, revision_conflict, state_conflict
from .generation_compatibility import generation_compatibility
from .reviews import latest_review, review_read
from .pagination import paginate


def create_sample_for_completed_item(
    session: Session,
    job: Job,
    item: JobItem,
    dataset_id: int,
) -> Sample:
    existing = session.exec(select(Sample).where(Sample.job_item_id == item.id)).one_or_none()
    if existing is not None:
        return existing
    if (
        job.source is not JobSource.PRODUCTION
        or job.dataset_id != dataset_id
        or item.status is not JobStatus.COMPLETED
        or item.primary_asset_id is None
        or item.gpu_slot is None
    ):
        raise state_conflict("jobItem", item.id, "Only a completed result can become a formal sample")
    snapshot = session.get(BatchVideoInputSnapshot, item.input_snapshot_id)
    prompt = session.exec(
        select(JobItemPromptResult).where(JobItemPromptResult.job_item_id == item.id)
    ).one_or_none()
    if snapshot is None or prompt is None:
        raise state_conflict("jobItem", item.id, "The completed result has incomplete provenance")
    timestamp = utc_now()
    sample = Sample(
        job_item_id=item.id,
        dataset_id=dataset_id,
        category=snapshot.category,
        conflict_direction=snapshot.conflict_direction,
        model=snapshot.model,
        gpu_slot=item.gpu_slot,
        content_script_id=snapshot.content_script_id,
        content_script_revision=snapshot.content_script_revision,
        prompt_template_version_id=snapshot.prompt_template_version_id,
        source_asset_id=item.source_asset_id,
        primary_asset_id=item.primary_asset_id,
        dialogue=prompt.dialogue,
        display_text=prompt.vt_text,
        video_prompt=prompt.final_positive_prompt,
        negative_prompt=prompt.negative_prompt,
        true_emotion_description=prompt.true_emotion_description,
        true_emotion=snapshot.true_emotion,
        apparent_emotion=snapshot.apparent_emotion,
        content_script_name_zh=snapshot.content_script_name_zh,
        content_script_name_en=snapshot.content_script_name_en,
        scene_zh=snapshot.content_scene_zh,
        scene_en=snapshot.content_scene_en,
        trigger_event_zh=snapshot.trigger_event_zh,
        trigger_event_en=snapshot.trigger_event_en,
        psychological_background_zh=snapshot.psychological_background_zh,
        psychological_background_en=snapshot.psychological_background_en,
        age=snapshot.age,
        gender=snapshot.gender,
        ethnicity=snapshot.ethnicity,
        seed=snapshot.seed,
        created_at=timestamp,
        updated_at=timestamp,
    )
    session.add(sample)
    session.flush()
    return sample


class SampleService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def list_samples(
        self,
        page: int,
        decision: ReviewDecision | None = None,
        dataset_id: int | None = None,
        protocol: Protocol | None = None,
        category: Category | None = None,
        search: str | None = None,
    ) -> PageRead[SampleRead]:
        with self.database.read_session() as session:
            statement = select(Sample)
            if decision is not None:
                statement = statement.where(Sample.review_decision == decision)
            if dataset_id is not None:
                statement = statement.where(Sample.dataset_id == dataset_id)
            if protocol is Protocol.VA:
                statement = statement.where(Sample.category.in_([Category.A_VA, Category.C_VA]))
            elif protocol is Protocol.VT:
                statement = statement.where(Sample.category.in_([Category.A_VT, Category.C_VT]))
            if category is not None:
                statement = statement.where(Sample.category == category)
            if search is not None and search.strip():
                needle = search.strip().casefold()
                dataset_ids = select(Dataset.id).where(
                    func.lower(Dataset.name).contains(needle)
                )
                statement = statement.where(
                    or_(
                        func.lower(func.printf("CS-%06d", Sample.id)).contains(needle),
                        Sample.dataset_id.in_(dataset_ids),
                    )
                )
            return paginate(
                session,
                statement.order_by(Sample.created_at, Sample.id),
                page,
                lambda row: self._read(session, row),
            )

    def get_sample(self, sample_id: int) -> SampleRead:
        with self.database.read_session() as session:
            row = session.get(Sample, sample_id)
            if row is None:
                raise not_found("sample", sample_id)
            return self._read(session, row)

    def update_classification(
        self,
        sample_id: int,
        payload: SampleClassificationUpdate,
    ) -> SampleRead:
        with self.database.immediate_session() as session:
            row = session.get(Sample, sample_id)
            if row is None:
                raise not_found("sample", sample_id)
            if row.revision != payload.expected_revision:
                raise revision_conflict("sample", sample_id, payload.expected_revision, row.revision)
            if protocol_for(row.category) is not protocol_for(payload.target_category):
                raise invalid_request("A sample cannot be moved between VA and VT")
            if relation_for(row.category) is relation_for(payload.target_category):
                raise invalid_request("The target category does not change the sample relation")
            if (
                relation_for(payload.target_category) is Relation.CONFLICT
                and payload.apparent_emotion == emotion_key(row.true_emotion)
            ):
                raise invalid_request("The apparent emotion must differ from the true emotion")
            row.category = payload.target_category
            row.conflict_direction = payload.conflict_direction
            row.apparent_emotion = (
                payload.apparent_emotion
                if payload.apparent_emotion is not None
                else row.true_emotion
            )
            row.true_emotion_description = payload.true_emotion_description
            row.review_decision = ReviewDecision.PENDING
            row.revision += 1
            row.updated_at = utc_now()
            session.flush()
            return self.read_in_session(session, row)

    @staticmethod
    def read_in_session(session: Session, row: Sample) -> SampleRead:
        if row.id is None:
            raise RuntimeError("A persisted sample must have an id")
        item = session.get(JobItem, row.job_item_id)
        if item is None:
            raise state_conflict("sample", row.id, "The sample job item does not exist")
        attempt = session.exec(
            select(GenerationAttempt)
            .where(
                GenerationAttempt.job_item_id == item.id,
                GenerationAttempt.status == GenerationAttemptStatus.COMPLETED,
                GenerationAttempt.primary_asset_id == item.primary_asset_id,
                GenerationAttempt.renderer_prompt_id == item.renderer_prompt_id,
            )
            .order_by(GenerationAttempt.attempt_number.desc())
        ).first()
        if attempt is None:
            raise state_conflict("sample", row.id, "The sample has no current successful generation attempt")
        current = None if row.review_decision is ReviewDecision.PENDING else latest_review(session, row.id)
        archive_item = session.get(ArchiveItem, (row.dataset_id, row.id))
        archive_sync_status = archive_status_for(
            row.review_decision,
            row.revision,
            archive_item.sample_revision if archive_item is not None else None,
        )
        dataset = session.get(Dataset, row.dataset_id)
        if dataset is None:
            raise state_conflict("sample", row.id, "The sample dataset does not exist")
        compatibility = generation_compatibility(session, row)
        return SampleRead(
            **row.model_dump(),
            display_id=f"CS-{row.id:06d}",
            dataset_name=dataset.name,
            source_asset_url=asset_content_url(row.source_asset_id),
            primary_asset_url=asset_content_url(row.primary_asset_id),
            generation_record=GenerationAttemptRead(
                **attempt.model_dump(exclude={"job_item_id"}),
                source_asset_url=asset_content_url(attempt.source_asset_id),
                primary_asset_url=asset_content_url(attempt.primary_asset_id),
            ),
            actual_content_summary=BilingualSelectionRead(
                id=compatibility.snapshot.content_script_id,
                name_zh=row.content_script_name_zh,
                name_en=row.content_script_name_en,
                revision=compatibility.snapshot.content_script_revision,
            ),
            actual_scene_summary=BilingualSelectionRead(
                id=compatibility.snapshot.scene_id,
                name_zh=compatibility.snapshot.shooting_scene_name_zh,
                name_en=compatibility.snapshot.shooting_scene_name_en,
                revision=compatibility.snapshot.scene_revision,
            ),
            generation_compatibility=compatibility.status,
            current_review=review_read(session, current) if current is not None else None,
            in_archive=archive_item is not None,
            archive_sync_status=archive_sync_status,
        )

    _read = read_in_session
