from __future__ import annotations

from typing import Any

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
    Asset,
    BatchVideoInputSnapshot,
    ContentScriptScene,
    Dataset,
    GenerationAttempt,
    Job,
    JobItem,
    JobItemPromptResult,
    Reviewer,
    ReviewNoteDraft,
    Sample,
    SampleClassificationChange,
    utc_now,
)
from backend.domain.schemas import (
    BilingualSelectionRead,
    emotion_key,
    GenerationAttemptRead,
    PageRead,
    ReviewMediaRead,
    ReviewQueueFilter,
    ReviewSampleDetailRead,
    ReviewSampleListRead,
    ReviewSampleReferenceRead,
    SampleClassificationChangeRead,
    SampleRead,
    SampleClassificationUpdate,
)

from .assets import asset_content_url
from .errors import invalid_request, not_found, revision_conflict, state_conflict
from .generation_compatibility import generation_compatibility
from .reviews import latest_review, review_read
from .pagination import PAGE_SIZE, paginate


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
        language=snapshot.language,
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

    def list_samples(self, page: int, filters: ReviewQueueFilter) -> PageRead[ReviewSampleListRead]:
        with self.database.read_session() as session:
            return paginate(
                session,
                self.review_statement(filters),
                page,
                lambda row: self.review_list_read_in_session(session, row),
            )

    def get_sample(self, sample_id: int) -> ReviewSampleDetailRead:
        with self.database.read_session() as session:
            row = session.get(Sample, sample_id)
            if row is None:
                raise not_found("sample", sample_id)
            return self.review_detail_read_in_session(session, row)

    def update_classification(
        self,
        sample_id: int,
        payload: SampleClassificationUpdate,
    ) -> ReviewSampleDetailRead:
        with self.database.immediate_session() as session:
            row = session.get(Sample, sample_id)
            if row is None:
                raise not_found("sample", sample_id)
            if session.get(Reviewer, payload.reviewer_id) is None:
                raise not_found("reviewer", payload.reviewer_id)
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
            after_apparent_emotion = (
                payload.apparent_emotion
                if payload.apparent_emotion is not None
                else row.true_emotion
            )
            timestamp = utc_now()
            change = SampleClassificationChange(
                sample_id=row.id,
                operator_id=payload.reviewer_id,
                before_protocol=protocol_for(row.category),
                after_protocol=protocol_for(payload.target_category),
                before_relation=relation_for(row.category),
                after_relation=relation_for(payload.target_category),
                before_direction=row.conflict_direction,
                after_direction=payload.conflict_direction,
                before_apparent_emotion=row.apparent_emotion,
                after_apparent_emotion=after_apparent_emotion,
                before_true_emotion_description=row.true_emotion_description,
                after_true_emotion_description=payload.true_emotion_description,
                before_sample_revision=row.revision,
                after_sample_revision=row.revision + 1,
                created_at=timestamp,
            )
            session.add(change)
            session.flush([change])
            session.refresh(row)
            drafts = session.exec(
                select(ReviewNoteDraft).where(
                    ReviewNoteDraft.sample_id == row.id
                )
            ).all()
            for draft in drafts:
                session.delete(draft)
            return self.review_detail_read_in_session(session, row)

    @staticmethod
    def review_statement(filters: ReviewQueueFilter) -> Any:
        statement = select(Sample)
        if filters.decision != "All":
            statement = statement.where(Sample.review_decision == filters.decision)
        if filters.dataset_id is not None:
            statement = statement.where(Sample.dataset_id == filters.dataset_id)
        if filters.protocol is Protocol.VA:
            statement = statement.where(Sample.category.in_([Category.A_VA, Category.C_VA]))
        elif filters.protocol is Protocol.VT:
            statement = statement.where(Sample.category.in_([Category.A_VT, Category.C_VT]))
        if filters.relation is Relation.ALIGNED:
            statement = statement.where(Sample.category.in_([Category.A_VA, Category.A_VT]))
        elif filters.relation is Relation.CONFLICT:
            statement = statement.where(Sample.category.in_([Category.C_VA, Category.C_VT]))
        if filters.direction is not None:
            statement = statement.where(Sample.conflict_direction == filters.direction)
        if filters.in_archive is not None:
            archived_ids = select(ArchiveItem.sample_id)
            statement = statement.where(
                Sample.id.in_(archived_ids)
                if filters.in_archive
                else Sample.id.not_in(archived_ids)
            )
        if filters.search is not None:
            needle = filters.search.strip().casefold()
            dataset_ids = select(Dataset.id).where(func.lower(Dataset.name).contains(needle))
            statement = statement.where(
                or_(
                    func.lower(func.printf("CS-%06d", Sample.id)).contains(needle),
                    Sample.dataset_id.in_(dataset_ids),
                    func.lower(Sample.true_emotion).contains(needle),
                    func.lower(Sample.apparent_emotion).contains(needle),
                    func.lower(Sample.dialogue).contains(needle),
                    func.lower(Sample.display_text).contains(needle),
                )
            )
        return statement.order_by(Sample.id)

    def next_sample_id(
        self,
        session: Session,
        sample_id: int,
        filters: ReviewQueueFilter,
    ) -> int | None:
        current = session.exec(
            self.review_statement(filters).where(Sample.id == sample_id)
        ).first()
        if current is None:
            raise invalid_request("The sample is not part of the supplied review queue")
        next_row = session.exec(
            self.review_statement(filters).where(Sample.id > sample_id).limit(1)
        ).first()
        return next_row.id if next_row is not None else None

    def reference_for_sample(
        self,
        session: Session,
        sample_id: int | None,
        filters: ReviewQueueFilter,
    ) -> ReviewSampleReferenceRead | None:
        if sample_id is None:
            return None
        row = session.exec(
            self.review_statement(filters).where(Sample.id == sample_id)
        ).first()
        if row is None:
            return None
        position = int(
            session.exec(
                select(func.count()).select_from(
                    self.review_statement(filters)
                    .where(Sample.id <= sample_id)
                    .order_by(None)
                    .subquery()
                )
            ).one()
        )
        return ReviewSampleReferenceRead(
            id=row.id,
            display_id=f"CS-{row.id:06d}",
            page=((position - 1) // PAGE_SIZE) + 1,
        )

    @staticmethod
    def _classification_change_read(
        session: Session,
        row: SampleClassificationChange,
    ) -> SampleClassificationChangeRead:
        operator = session.get(Reviewer, row.operator_id)
        if operator is None:
            raise RuntimeError("A classification change must reference an operator")
        return SampleClassificationChangeRead(
            **row.model_dump(),
            operator_name=operator.name,
        )

    def review_list_read_in_session(
        self,
        session: Session,
        row: Sample,
    ) -> ReviewSampleListRead:
        values = self._review_common_values(session, row)
        return ReviewSampleListRead(**values)

    def review_detail_read_in_session(
        self,
        session: Session,
        row: Sample,
    ) -> ReviewSampleDetailRead:
        values = self._review_common_values(session, row)
        attempt = self._current_completed_attempt(session, row)
        compatible_scene_count = int(
            session.exec(
                select(func.count()).select_from(ContentScriptScene).where(
                    ContentScriptScene.content_script_id == row.content_script_id
                )
            ).one()
        )
        protocol = protocol_for(row.category)
        source_media = None
        if protocol is Protocol.VT:
            if row.source_asset_id is None:
                raise state_conflict("sample", row.id, "The VT source media is missing")
            source_media = self._review_media(session, row.source_asset_id)
            if not source_media.has_audio:
                raise state_conflict("sample", row.id, "The VT source media must contain audio")
        return ReviewSampleDetailRead(
            **values,
            source_media=source_media,
            dialogue=row.dialogue,
            display_text=row.display_text,
            true_emotion_description=row.true_emotion_description,
            scene_zh=row.scene_zh,
            scene_en=row.scene_en,
            trigger_event_zh=row.trigger_event_zh,
            trigger_event_en=row.trigger_event_en,
            psychological_background_zh=row.psychological_background_zh,
            psychological_background_en=row.psychological_background_en,
            age=row.age,
            ethnicity=row.ethnicity,
            language=row.language,
            model=attempt.model,
            precision=attempt.precision,
            compatible_scene_count=compatible_scene_count,
        )

    def _review_common_values(self, session: Session, row: Sample) -> dict[str, object]:
        if row.id is None:
            raise RuntimeError("A persisted sample must have an id")
        dataset = session.get(Dataset, row.dataset_id)
        if dataset is None:
            raise state_conflict("sample", row.id, "The sample dataset does not exist")
        primary_media = self._review_media(session, row.primary_asset_id)
        protocol = protocol_for(row.category)
        if protocol is Protocol.VA and not primary_media.has_audio:
            raise state_conflict("sample", row.id, "The VA primary media must contain audio")
        if protocol is Protocol.VT and primary_media.has_audio:
            raise state_conflict("sample", row.id, "The VT primary media must be silent")
        current = None if row.review_decision is ReviewDecision.PENDING else latest_review(session, row.id)
        archive_item = session.get(ArchiveItem, (row.dataset_id, row.id))
        return {
            "id": row.id,
            "display_id": f"CS-{row.id:06d}",
            "dataset_id": row.dataset_id,
            "dataset_name": dataset.name,
            "category": row.category,
            "protocol": protocol,
            "relation": relation_for(row.category),
            "conflict_direction": row.conflict_direction,
            "review_decision": row.review_decision,
            "review_revision": row.review_revision,
            "current_review": review_read(session, current) if current is not None else None,
            "in_archive": archive_item is not None,
            "archive_sync_status": archive_status_for(
                row.review_decision,
                row.revision,
                archive_item.sample_revision if archive_item is not None else None,
            ),
            "generation_compatibility": generation_compatibility(session, row).status,
            "primary_media": primary_media,
            "true_emotion": row.true_emotion,
            "apparent_emotion": row.apparent_emotion,
            "content_script_name_zh": row.content_script_name_zh,
            "content_script_name_en": row.content_script_name_en,
            "gender": row.gender,
            "revision": row.revision,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }

    @staticmethod
    def _review_media(session: Session, asset_id: int) -> ReviewMediaRead:
        asset = session.get(Asset, asset_id)
        if asset is None:
            raise state_conflict("asset", asset_id, "The sample media does not exist")
        url = asset_content_url(asset.id)
        if url is None:
            raise RuntimeError("A persisted asset must have an id")
        return ReviewMediaRead(url=url, has_audio=asset.has_audio)

    @staticmethod
    def _current_completed_attempt(
        session: Session,
        row: Sample,
    ) -> GenerationAttempt:
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
        return attempt

    @staticmethod
    def read_in_session(session: Session, row: Sample) -> SampleRead:
        if row.id is None:
            raise RuntimeError("A persisted sample must have an id")
        attempt = SampleService._current_completed_attempt(session, row)
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
