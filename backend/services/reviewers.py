from __future__ import annotations

import unicodedata

from sqlmodel import select

from backend.adapters.database import Database
from backend.domain.models import Reviewer, utc_now
from backend.domain.schemas import PageRead, ReviewerCreate, ReviewerRead, ReviewerRename

from .errors import invalid_request, not_found, reviewer_name_conflict, revision_conflict
from .pagination import paginate


def normalize_reviewer_name(value: str) -> tuple[str, str]:
    name = " ".join(unicodedata.normalize("NFKC", value).split())
    if not name:
        raise invalid_request("Reviewer name cannot be empty")
    if len(name) > 80:
        raise invalid_request("Reviewer name cannot exceed 80 characters")
    return name, name.casefold()


class ReviewerService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def list_reviewers(self, page: int) -> PageRead[ReviewerRead]:
        with self.database.read_session() as session:
            return paginate(
                session,
                select(Reviewer).order_by(Reviewer.name_key, Reviewer.id),
                page,
                ReviewerRead.model_validate,
            )

    def create(self, payload: ReviewerCreate) -> ReviewerRead:
        name, name_key = normalize_reviewer_name(payload.name)
        with self.database.immediate_session() as session:
            if session.exec(select(Reviewer).where(Reviewer.name_key == name_key)).first() is not None:
                raise reviewer_name_conflict(name)
            timestamp = utc_now()
            row = Reviewer(
                name=name,
                name_key=name_key,
                revision=1,
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(row)
            session.flush()
            return ReviewerRead.model_validate(row)

    def rename(self, reviewer_id: int, payload: ReviewerRename) -> ReviewerRead:
        name, name_key = normalize_reviewer_name(payload.name)
        with self.database.immediate_session() as session:
            row = session.get(Reviewer, reviewer_id)
            if row is None:
                raise not_found("reviewer", reviewer_id)
            if row.revision != payload.expected_revision:
                raise revision_conflict("reviewer", reviewer_id, payload.expected_revision, row.revision)
            if row.name == name:
                raise invalid_request("The reviewer name has not changed")
            existing = session.exec(
                select(Reviewer).where(Reviewer.name_key == name_key, Reviewer.id != reviewer_id)
            ).first()
            if existing is not None:
                raise reviewer_name_conflict(name)
            row.name = name
            row.name_key = name_key
            row.revision += 1
            row.updated_at = utc_now()
            session.flush()
            return ReviewerRead.model_validate(row)
