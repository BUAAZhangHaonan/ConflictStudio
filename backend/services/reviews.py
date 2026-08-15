from __future__ import annotations

from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.domain.enums import ReviewDecision, protocol_for, relation_for
from backend.domain.models import Review, Reviewer, Sample, utc_now
from backend.domain.schemas import PageRead, ReviewBatchCreate, ReviewCreate, ReviewRead, SampleRead

from .errors import invalid_request, not_found, review_revision_conflict, revision_conflict
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

    def create(self, payload: ReviewCreate) -> SampleRead:
        with self.database.immediate_session() as session:
            self._validate_and_append(session, payload)
            sample = session.get(Sample, payload.sample_id)
            if sample is None:
                raise RuntimeError("The reviewed sample disappeared inside its transaction")
            session.flush()
            return self.sample_service.read_in_session(session, sample)

    def create_batch(self, payload: ReviewBatchCreate) -> list[SampleRead]:
        with self.database.immediate_session() as session:
            checked = [self._validate(session, item) for item in payload.items]
            for item, sample in checked:
                self._append(session, item, sample)
            session.flush()
            return [self.sample_service.read_in_session(session, sample) for _, sample in checked]

    def _validate_and_append(self, session: Session, payload: ReviewCreate) -> None:
        item, sample = self._validate(session, payload)
        self._append(session, item, sample)

    @staticmethod
    def _validate(
        session: Session,
        payload: ReviewCreate,
    ) -> tuple[ReviewCreate, Sample]:
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
        current = latest_review(session, sample.id)
        if (
            sample.review_decision is payload.decision
            and current is not None
            and current.note == payload.note
        ):
            raise invalid_request("The review decision and note have not changed")
        return payload, sample

    @staticmethod
    def _append(
        session: Session,
        payload: ReviewCreate,
        sample: Sample,
    ) -> Review:
        if payload.decision is ReviewDecision.PENDING:
            raise invalid_request("Pending is not a review decision")
        timestamp = utc_now()
        row = Review(
            sample_id=sample.id,
            reviewer_id=payload.reviewer_id,
            dataset_id=sample.dataset_id,
            protocol=protocol_for(sample.category),
            relation=relation_for(sample.category),
            decision=payload.decision,
            note=payload.note,
            sample_revision=sample.revision,
            revision=sample.review_revision + 1,
            created_at=timestamp,
        )
        session.add(row)
        sample.review_decision = payload.decision
        sample.review_revision += 1
        sample.revision += 1
        sample.updated_at = timestamp
        return row
