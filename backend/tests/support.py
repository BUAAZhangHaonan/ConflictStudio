from __future__ import annotations

from backend.adapters.database import Database
from backend.domain.enums import TemplateVersionStatus
from backend.domain.models import PromptTemplateVersion, utc_now


def mark_prompt_version_verified(
    database: Database,
    version_id: int,
) -> None:
    """Seed a verified version for tests that do not exercise verification."""
    with database.immediate_session() as session:
        row = session.get(PromptTemplateVersion, version_id)
        assert row is not None
        assert row.verification_status is TemplateVersionStatus.DRAFT
        row.verification_status = TemplateVersionStatus.VERIFIED
        row.revision += 1
        row.verified_at = utc_now()
        session.flush()
