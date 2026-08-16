from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.domain.enums import (
    ArchiveSyncStatus,
    Protocol,
    ReviewDecision,
    archive_status_for,
)
from backend.domain.models import ArchiveItem, Dataset, Review, Reviewer, Sample
from backend.domain.schemas import ReviewerActivityRead, ReviewerStatisticsRead

from .errors import invalid_request, not_found


SHANGHAI = ZoneInfo("Asia/Shanghai")


def utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class StatisticsService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def reviewer_statistics(
        self,
        reviewer_id: int,
        dataset_id: int | None,
        start_date: date | None,
        end_date: date | None,
    ) -> ReviewerStatisticsRead:
        today = datetime.now(SHANGHAI).date()
        resolved_end = end_date or today
        resolved_start = start_date or (resolved_end - timedelta(days=29))
        if resolved_start > resolved_end:
            raise invalid_request("The start date cannot be after the end date")
        lower = utc_text(datetime.combine(resolved_start, time.min, tzinfo=SHANGHAI))
        upper = utc_text(
            datetime.combine(resolved_end + timedelta(days=1), time.min, tzinfo=SHANGHAI)
        )
        with self.database.read_session() as session:
            if session.get(Reviewer, reviewer_id) is None:
                raise not_found("reviewer", reviewer_id)
            if dataset_id is not None and session.get(Dataset, dataset_id) is None:
                raise not_found("dataset", dataset_id)
            all_rows = self._review_rows(session, reviewer_id, dataset_id, upper)
            rows = [row for row in all_rows if row.created_at >= lower]
            latest: dict[int, Review] = {}
            for row in rows:
                latest[row.sample_id] = row

            revised_sample_ids: set[int] = set()
            previous_decisions: dict[int, ReviewDecision] = {}
            for row in all_rows:
                previous = previous_decisions.get(row.sample_id)
                if row.created_at >= lower and previous is not None and previous != row.decision:
                    revised_sample_ids.add(row.sample_id)
                previous_decisions[row.sample_id] = row.decision

            activity_counts = {
                resolved_start + timedelta(days=offset): 0
                for offset in range((resolved_end - resolved_start).days + 1)
            }
            for row in rows:
                day = parse_utc(row.created_at).astimezone(SHANGHAI).date()
                activity_counts[day] += 1

            archived_current_count, needs_update_count = self._archive_counts(
                session,
                set(latest),
            )
            latest_rows = list(latest.values())
            return ReviewerStatisticsRead(
                reviewer_id=reviewer_id,
                dataset_id=dataset_id,
                start_date=resolved_start,
                end_date=resolved_end,
                unique_reviewed_count=len(latest_rows),
                accepted_count=sum(row.decision is ReviewDecision.ACCEPTED for row in latest_rows),
                rejected_count=sum(row.decision is ReviewDecision.REJECTED for row in latest_rows),
                va_count=sum(row.protocol is Protocol.VA for row in latest_rows),
                vt_count=sum(row.protocol is Protocol.VT for row in latest_rows),
                revised_sample_count=len(revised_sample_ids),
                archived_current_count=archived_current_count,
                needs_update_count=needs_update_count,
                activity=[
                    ReviewerActivityRead(date=day, reviewed_count=count)
                    for day, count in activity_counts.items()
                ],
            )

    @staticmethod
    def _review_rows(
        session: Session,
        reviewer_id: int,
        dataset_id: int | None,
        upper: str,
    ) -> list[Review]:
        statement = select(Review).join(Sample, Sample.id == Review.sample_id).where(
            Review.reviewer_id == reviewer_id,
            Review.created_at < upper,
        )
        if dataset_id is not None:
            statement = statement.where(Sample.dataset_id == dataset_id)
        return list(session.exec(statement.order_by(Review.created_at, Review.id)).all())

    @staticmethod
    def _archive_counts(session: Session, sample_ids: set[int]) -> tuple[int, int]:
        if not sample_ids:
            return 0, 0
        samples = session.exec(select(Sample).where(Sample.id.in_(sample_ids))).all()
        archived_current = 0
        needs_update = 0
        for sample in samples:
            item = session.get(ArchiveItem, (sample.dataset_id, sample.id))
            status = archive_status_for(
                sample.review_decision,
                sample.revision,
                item.sample_revision if item is not None else None,
            )
            if status is ArchiveSyncStatus.NEEDS_UPDATE:
                needs_update += 1
            elif item is not None and sample.review_decision is ReviewDecision.ACCEPTED:
                archived_current += 1
        return archived_current, needs_update
