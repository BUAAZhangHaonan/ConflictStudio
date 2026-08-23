from __future__ import annotations

from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.domain.enums import GenerationCompatibility, ReviewDecision, protocol_for, relation_for
from backend.domain.models import Review, Reviewer, ReviewNoteDraft, Sample, utc_now
from backend.domain.schemas import (
    PageRead,
    ReviewBatchCreate,
    ReviewBatchItem,
    ReviewCreate,
    ReviewNoteDraftRead,
    ReviewNoteDraftUpdate,
    ReviewRead,
    ReviewSampleDetailRead,
    ReviewSubmissionRead,
)

from .errors import (
    incompatible_generation,
    invalid_request,
    not_found,
    note_draft_revision_conflict,
    review_revision_conflict,
    revision_conflict,
)
from .generation_compatibility import generation_compatibility
from .pagination import paginate


def latest_review(session: Session, sample_id: int) -> Review | None:
    return session.exec(
        select(Review)
        .where(Review.sample_id == sample_id)
        .order_by(Review.revision.desc())
    ).first()


def review_read(session: Session, row: Review) -> ReviewRead:
    reviewer = session.get(Reviewer, row.reviewer_id)
    if reviewer is None:
        raise RuntimeError("A persisted review must reference a reviewer")
    return ReviewRead(**row.model_dump(), reviewer_name=reviewer.name)


class ReviewService:
    def __init__(self, database: Database, sample_service: object) -> None:
        self.database = database
        self.sample_service = sample_service

    def list_for_sample(self, sample_id: int, page: int) -> PageRead[ReviewRead]:
        with self.database.read_session() as session:
            if session.get(Sample, sample_id) is None:
                raise not_found("sample", sample_id)
            return paginate(
                session,
                select(Review)
                .where(Review.sample_id == sample_id)
                .order_by(Review.revision),
                page,
                lambda row: review_read(session, row),
            )

    def get_note_draft(
        self,
        sample_id: int,
        reviewer_id: int,
    ) -> ReviewNoteDraftRead:
        with self.database.read_session() as session:
            sample = session.get(Sample, sample_id)
            if sample is None:
                raise not_found("sample", sample_id)
            if session.get(Reviewer, reviewer_id) is None:
                raise not_found("reviewer", reviewer_id)
            row = session.get(ReviewNoteDraft, (sample_id, reviewer_id))
            if row is None:
                return ReviewNoteDraftRead(
                    sample_id=sample_id,
                    reviewer_id=reviewer_id,
                    sample_revision=sample.revision,
                    note="",
                    revision=0,
                    updated_at=None,
                )
            return ReviewNoteDraftRead.model_validate(row)

    def put_note_draft(
        self,
        sample_id: int,
        payload: ReviewNoteDraftUpdate,
    ) -> ReviewNoteDraftRead:
        with self.database.immediate_session() as session:
            sample = session.get(Sample, sample_id)
            if sample is None:
                raise not_found("sample", sample_id)
            if session.get(Reviewer, payload.reviewer_id) is None:
                raise not_found("reviewer", payload.reviewer_id)
            if sample.revision != payload.expected_sample_revision:
                raise revision_conflict(
                    "sample",
                    sample_id,
                    payload.expected_sample_revision,
                    sample.revision,
                )
            row = session.get(ReviewNoteDraft, (sample_id, payload.reviewer_id))
            actual_revision = row.revision if row is not None else 0
            if actual_revision != payload.expected_revision:
                raise note_draft_revision_conflict(
                    sample_id,
                    payload.reviewer_id,
                    payload.expected_revision,
                    actual_revision,
                )
            if (
                row is not None
                and row.note == payload.note
                and row.sample_revision == sample.revision
            ):
                return ReviewNoteDraftRead.model_validate(row)
            timestamp = utc_now()
            if row is None:
                row = ReviewNoteDraft(
                    sample_id=sample_id,
                    reviewer_id=payload.reviewer_id,
                    sample_revision=sample.revision,
                    note=payload.note,
                    revision=1,
                    updated_at=timestamp,
                )
                session.add(row)
            else:
                row.sample_revision = sample.revision
                row.note = payload.note
                row.revision += 1
                row.updated_at = timestamp
            session.flush()
            return ReviewNoteDraftRead.model_validate(row)

    def create(self, payload: ReviewCreate) -> ReviewSubmissionRead:
        with self.database.immediate_session() as session:
            next_sample_id = self.sample_service.next_sample_id(
                session,
                payload.sample_id,
                payload.queue,
            )
            item, sample, note, draft = self._validate(session, payload)
            self._append(session, item, sample, note, draft)
            session.flush()
            detail = self.sample_service.review_detail_read_in_session(session, sample)
            return ReviewSubmissionRead(
                **detail.model_dump(),
                next_reference=self.sample_service.reference_for_sample(
                    session,
                    next_sample_id,
                    payload.queue,
                ),
            )

    def create_batch(self, payload: ReviewBatchCreate) -> list[ReviewSampleDetailRead]:
        with self.database.immediate_session() as session:
            checked = [self._validate(session, item) for item in payload.items]
            for item, sample, note, draft in checked:
                self._append(session, item, sample, note, draft)
            session.flush()
            return [
                self.sample_service.review_detail_read_in_session(session, sample)
                for _, sample, _, _ in checked
            ]

    @staticmethod
    def _validate(
        session: Session,
        payload: ReviewCreate | ReviewBatchItem,
    ) -> tuple[ReviewCreate | ReviewBatchItem, Sample, str, ReviewNoteDraft | None]:
        sample = session.get(Sample, payload.sample_id)
        if sample is None:
            raise not_found("sample", payload.sample_id)
        if session.get(Reviewer, payload.reviewer_id) is None:
            raise not_found("reviewer", payload.reviewer_id)
        if sample.revision != payload.expected_revision:
            raise revision_conflict("sample", sample.id, payload.expected_revision, sample.revision)
        if sample.review_revision != payload.expected_review_revision:
            raise review_revision_conflict(
                sample.id,
                payload.expected_review_revision,
                sample.review_revision,
            )
        if (
            payload.decision is ReviewDecision.PENDING
            and sample.review_decision is ReviewDecision.PENDING
        ):
            raise invalid_request(
                "Only an accepted or rejected review can be withdrawn"
            )
        if (
            payload.decision is ReviewDecision.ACCEPTED
            and generation_compatibility(session, sample).status
            is GenerationCompatibility.NEEDS_REGENERATION
        ):
            raise incompatible_generation(sample.id)
        draft = session.get(
            ReviewNoteDraft,
            (payload.sample_id, payload.reviewer_id),
        )
        actual_draft_revision = draft.revision if draft is not None else 0
        if actual_draft_revision != payload.expected_note_draft_revision:
            raise note_draft_revision_conflict(
                payload.sample_id,
                payload.reviewer_id,
                payload.expected_note_draft_revision,
                actual_draft_revision,
            )
        if draft is not None and draft.sample_revision != sample.revision:
            raise revision_conflict(
                "sample",
                sample.id,
                draft.sample_revision,
                sample.revision,
            )
        note = draft.note if draft is not None else ""
        current = latest_review(session, sample.id)
        if (
            sample.review_decision is payload.decision
            and current is not None
            and current.note == note
        ):
            raise invalid_request("The review decision and note have not changed")
        return payload, sample, note, draft

    @staticmethod
    def _append(
        session: Session,
        payload: ReviewCreate | ReviewBatchItem,
        sample: Sample,
        note: str,
        draft: ReviewNoteDraft | None,
    ) -> Review:
        timestamp = utc_now()
        row = Review(
            sample_id=sample.id,
            reviewer_id=payload.reviewer_id,
            protocol=protocol_for(sample.category),
            relation=relation_for(sample.category),
            decision=payload.decision,
            note=note,
            sample_revision=sample.revision,
            revision=sample.review_revision + 1,
            created_at=timestamp,
        )
        session.add(row)
        session.flush([row])
        session.refresh(sample)
        if draft is not None:
            session.delete(draft)
        return row
