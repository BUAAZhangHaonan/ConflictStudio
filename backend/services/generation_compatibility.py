from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session, select

from backend.domain.enums import ContentMode, GenerationCompatibility
from backend.domain.models import (
    BatchVideoInputSnapshot,
    ContentPlan,
    ContentPlanBackground,
    JobItem,
    Sample,
    VideoBackgroundPreset,
)

from .errors import state_conflict


@dataclass(frozen=True)
class GenerationCompatibilityResult:
    snapshot: BatchVideoInputSnapshot
    content: ContentPlan
    scene: VideoBackgroundPreset
    status: GenerationCompatibility


def generation_compatibility(
    session: Session,
    sample: Sample,
) -> GenerationCompatibilityResult:
    if sample.id is None:
        raise RuntimeError("A persisted sample must have an id")
    item = session.get(JobItem, sample.job_item_id)
    if item is None:
        raise state_conflict("sample", sample.id, "The sample job item does not exist")
    snapshot = session.get(BatchVideoInputSnapshot, item.input_snapshot_id)
    if snapshot is None:
        raise state_conflict("sample", sample.id, "The sample generation input does not exist")
    content = session.get(ContentPlan, snapshot.content_plan_id)
    scene = session.get(VideoBackgroundPreset, snapshot.background_preset_id)
    if content is None or scene is None:
        raise state_conflict("sample", sample.id, "The sample generation sources do not exist")

    mappings = session.exec(
        select(ContentPlanBackground)
        .where(ContentPlanBackground.content_plan_id == snapshot.content_plan_id)
        .order_by(ContentPlanBackground.position)
    ).all()
    scene_is_mapped = any(
        mapping.background_preset_id == snapshot.background_preset_id
        for mapping in mappings
    )
    fixed_source_matches = content.mode is not ContentMode.FIXED or (
        len(mappings) == 1 and scene_is_mapped
    )
    status = (
        GenerationCompatibility.COMPATIBLE
        if scene_is_mapped and fixed_source_matches
        else GenerationCompatibility.NEEDS_REGENERATION
    )
    return GenerationCompatibilityResult(snapshot, content, scene, status)
