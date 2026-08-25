from __future__ import annotations

from typing import Any

from fastapi import FastAPI

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


def create_prompt_template(app: FastAPI, name: str, category: str) -> dict[str, Any]:
    """Create a prompt template through the catalog service (no public POST route)."""
    from backend.domain.schemas import PromptTemplateCreate

    read = app.state.catalog_service.create_prompt_template(
        PromptTemplateCreate(name=name, category=category)
    )
    return read.model_dump(mode="json", by_alias=True)