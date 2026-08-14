from __future__ import annotations

from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.domain.enums import (
    GenerationAttemptStatus,
    JobSource,
    JobStatus,
    ResourceStatus,
    ReviewDecision,
)
from backend.domain.models import (
    BatchVideoInputSnapshot,
    ContentPlan,
    Dataset,
    GenerationAttempt,
    Job,
    JobItem,
    JobItemPromptResult,
    Sample,
    utc_now,
)
from backend.domain.schemas import (
    GenerationAttemptRead,
    KeepTestResultRequest,
    SampleRead,
    SampleReviewUpdate,
)

from .assets import asset_content_url
from .errors import not_found, revision_conflict, state_conflict


def create_sample_for_completed_item(
    session: Session,
    job: Job,
    item: JobItem,
    dataset_id: int,
) -> Sample:
    existing = session.exec(select(Sample).where(Sample.job_item_id == item.id)).one_or_none()
    if existing is not None:
        return existing
    if item.status is not JobStatus.COMPLETED or item.primary_asset_id is None:
        raise state_conflict("jobItem", item.id, "Only a completed result can become a formal sample")
    snapshot = session.get(BatchVideoInputSnapshot, item.input_snapshot_id)
    prompt = session.exec(
        select(JobItemPromptResult).where(JobItemPromptResult.job_item_id == item.id)
    ).one_or_none()
    content = session.get(ContentPlan, snapshot.content_plan_id) if snapshot is not None else None
    if snapshot is None or prompt is None or content is None:
        raise state_conflict("jobItem", item.id, "The completed result has incomplete provenance")
    timestamp = utc_now()
    sample = Sample(
        job_item_id=item.id,
        dataset_id=dataset_id,
        category=snapshot.category,
        conflict_direction=snapshot.conflict_direction,
        model=snapshot.model,
        gpu_slot=item.gpu_slot,
        content_plan_id=snapshot.content_plan_id,
        content_plan_revision=snapshot.content_plan_revision,
        prompt_preset_id=snapshot.prompt_preset_id,
        source_asset_id=item.source_asset_id,
        primary_asset_id=item.primary_asset_id,
        dialogue=prompt.dialogue,
        display_text=prompt.vt_text,
        video_prompt=prompt.final_positive_prompt,
        negative_prompt=prompt.final_negative_prompt,
        true_emotion_description=prompt.true_emotion_description,
        true_emotion=snapshot.true_emotion,
        apparent_emotion=snapshot.apparent_emotion,
        content_plan_name_zh=content.name_zh,
        content_plan_name_en=content.name_en,
        scene_zh=content.scene_zh,
        scene_en=content.scene_en,
        trigger_event_zh=content.trigger_event_zh,
        trigger_event_en=content.trigger_event_en,
        psychological_background_zh=content.psychological_background_zh,
        psychological_background_en=content.psychological_background_en,
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

    def list_samples(self, decision: ReviewDecision | None = None) -> list[SampleRead]:
        with self.database.read_session() as session:
            statement = select(Sample)
            if decision is not None:
                statement = statement.where(Sample.review_decision == decision)
            rows = session.exec(statement.order_by(Sample.created_at, Sample.id)).all()
            return [self._read(session, row) for row in rows]

    def get_sample(self, sample_id: int) -> SampleRead:
        with self.database.read_session() as session:
            row = session.get(Sample, sample_id)
            if row is None:
                raise not_found("sample", sample_id)
            return self._read(session, row)

    def keep_test_result(self, item_id: int, payload: KeepTestResultRequest) -> SampleRead:
        with self.database.immediate_session() as session:
            item = session.get(JobItem, item_id)
            if item is None:
                raise not_found("jobItem", item_id)
            if item.revision != payload.expected_revision:
                raise revision_conflict("jobItem", item_id, payload.expected_revision, item.revision)
            job = session.get(Job, item.job_id)
            if job is None or job.source is not JobSource.TEST:
                raise state_conflict("jobItem", item_id, "Only a test result can be kept manually")
            dataset = session.get(Dataset, payload.dataset_id)
            if dataset is None:
                raise not_found("dataset", payload.dataset_id)
            if dataset.status is not ResourceStatus.ACTIVE:
                raise state_conflict("dataset", dataset.id, "The destination dataset is not active")
            if session.exec(select(Sample).where(Sample.job_item_id == item.id)).one_or_none() is not None:
                raise state_conflict("jobItem", item.id, "The test result is already a formal sample")
            return self._read(session, create_sample_for_completed_item(session, job, item, dataset.id))

    def update_review(self, sample_id: int, payload: SampleReviewUpdate) -> SampleRead:
        with self.database.immediate_session() as session:
            row = session.get(Sample, sample_id)
            if row is None:
                raise not_found("sample", sample_id)
            if row.revision != payload.expected_revision:
                raise revision_conflict("sample", sample_id, payload.expected_revision, row.revision)
            row.review_decision = payload.decision
            row.review_revision += 1
            row.revision += 1
            row.updated_at = utc_now()
            session.flush()
            return self._read(session, row)

    @staticmethod
    def _read(session: Session, row: Sample) -> SampleRead:
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
        return SampleRead(
            **row.model_dump(),
            display_id=f"CS-{row.id:06d}",
            source_asset_url=asset_content_url(row.source_asset_id),
            primary_asset_url=asset_content_url(row.primary_asset_id),
            generation_record=GenerationAttemptRead(
                **attempt.model_dump(exclude={"job_item_id"}),
                source_asset_url=asset_content_url(attempt.source_asset_id),
                primary_asset_url=asset_content_url(attempt.primary_asset_id),
            ),
        )
