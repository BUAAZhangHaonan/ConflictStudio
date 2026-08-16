from __future__ import annotations

from pathlib import Path

from sqlalchemy import delete
from sqlmodel import Session, select

from backend.adapters.archive_manifest import ArchiveManifestStore
from backend.adapters.database import Database
from backend.domain.enums import (
    ArchiveSyncStatus,
    Protocol,
    Relation,
    ReviewDecision,
    archive_status_for,
    protocol_for,
    relation_for,
)
from backend.domain.models import (
    Archive,
    ArchiveItem,
    Asset,
    Dataset,
    Review,
    Reviewer,
    Sample,
    utc_now,
)
from backend.domain.schemas import (
    ArchiveChangeRead,
    ArchivePreviewRead,
    ArchivePreviewRequest,
    ArchiveRead,
    ArchiveSyncRequest,
    emotion_key,
    PageRead,
)

from .assets import asset_content_url
from .errors import archive_preview_stale, not_found, state_conflict
from .reviews import latest_review
from .pagination import paginate


class ArchiveService:
    def __init__(self, database: Database) -> None:
        self.database = database
        self.manifests = ArchiveManifestStore(database.data_root)

    def list_archives(self, page: int) -> PageRead[ArchiveRead]:
        with self.database.read_session() as session:
            return paginate(
                session,
                select(Dataset).order_by(Dataset.id),
                page,
                lambda row: self._read_archive(session, row.id),
            )

    def preview(self, payload: ArchivePreviewRequest) -> ArchivePreviewRead:
        with self.database.read_session() as session:
            return self._calculate_preview(session, payload.dataset_id)

    def sync(self, payload: ArchiveSyncRequest) -> ArchiveRead:
        previous = self.manifests.read_optional(payload.dataset_id)
        manifest_replaced = False
        try:
            with self.database.immediate_session() as session:
                current = self._calculate_preview(session, payload.dataset_id)
                if self._preview_signature(current) != self._preview_signature(payload):
                    raise archive_preview_stale(payload.dataset_id)
                samples = session.exec(
                    select(Sample)
                    .where(
                        Sample.dataset_id == payload.dataset_id,
                        Sample.review_decision == ReviewDecision.ACCEPTED,
                    )
                    .order_by(Sample.id)
                ).all()
                records = [self._manifest_record(session, sample) for sample in samples]
                self.manifests.write_records(payload.dataset_id, records)
                manifest_replaced = True

                timestamp = utc_now()
                session.exec(delete(ArchiveItem).where(ArchiveItem.dataset_id == payload.dataset_id))
                session.add_all(
                    [
                        ArchiveItem(
                            dataset_id=payload.dataset_id,
                            sample_id=sample.id,
                            sample_revision=sample.revision,
                            synced_at=timestamp,
                        )
                        for sample in samples
                    ]
                )
                archive = session.get(Archive, payload.dataset_id)
                if archive is None:
                    archive = Archive(
                        dataset_id=payload.dataset_id,
                        revision=1,
                        last_synced_at=timestamp,
                        created_at=timestamp,
                        updated_at=timestamp,
                    )
                    session.add(archive)
                else:
                    archive.revision += 1
                    archive.last_synced_at = timestamp
                    archive.updated_at = timestamp
                session.flush()
                result = ArchiveRead(
                    dataset_id=payload.dataset_id,
                    revision=archive.revision,
                    last_synced_at=timestamp,
                    manifest_available=True,
                    current_count=len(samples),
                    needs_update_count=0,
                )
            return result
        except BaseException:
            if manifest_replaced:
                self.manifests.restore(payload.dataset_id, previous)
            raise

    def manifest_path(self, dataset_id: int) -> Path:
        with self.database.read_session() as session:
            if session.get(Dataset, dataset_id) is None:
                raise not_found("dataset", dataset_id)
        path = self.manifests.path(dataset_id)
        if not path.is_file():
            raise not_found("manifest", dataset_id)
        return path

    def _read_archive(self, session: Session, dataset_id: int) -> ArchiveRead:
        archive = session.get(Archive, dataset_id)
        samples = {
            row.id: row
            for row in session.exec(
                select(Sample).where(Sample.dataset_id == dataset_id)
            ).all()
        }
        items = {
            row.sample_id: row
            for row in session.exec(
                select(ArchiveItem).where(ArchiveItem.dataset_id == dataset_id)
            ).all()
        }
        current_count = 0
        needs_update_count = 0
        for sample_id in sorted(set(samples) | set(items)):
            sample = samples.get(sample_id) or session.get(Sample, sample_id)
            if sample is None:
                raise RuntimeError("An archive item must reference a sample")
            item = items.get(sample_id)
            if sample.dataset_id != dataset_id:
                needs_update_count += 1
                continue
            status = archive_status_for(
                sample.review_decision,
                sample.revision,
                item.sample_revision if item is not None else None,
            )
            if status is ArchiveSyncStatus.NEEDS_UPDATE:
                needs_update_count += 1
            elif item is not None and sample.review_decision is ReviewDecision.ACCEPTED:
                current_count += 1
        return ArchiveRead(
            dataset_id=dataset_id,
            revision=archive.revision if archive is not None else 0,
            last_synced_at=archive.last_synced_at if archive is not None else None,
            manifest_available=self.manifests.exists(dataset_id),
            current_count=current_count,
            needs_update_count=needs_update_count,
        )

    @classmethod
    def _calculate_preview(cls, session: Session, dataset_id: int) -> ArchivePreviewRead:
        dataset = session.get(Dataset, dataset_id)
        if dataset is None:
            raise not_found("dataset", dataset_id)
        archive = session.get(Archive, dataset_id)
        samples = {
            row.id: row
            for row in session.exec(select(Sample).where(Sample.dataset_id == dataset_id)).all()
        }
        items = {
            row.sample_id: row
            for row in session.exec(
                select(ArchiveItem).where(ArchiveItem.dataset_id == dataset_id)
            ).all()
        }
        added: list[ArchiveChangeRead] = []
        updated: list[ArchiveChangeRead] = []
        removed: list[ArchiveChangeRead] = []
        unchanged_count = 0
        for sample_id in sorted(set(samples) | set(items)):
            sample = samples.get(sample_id) or session.get(Sample, sample_id)
            if sample is None:
                raise RuntimeError("An archive item must reference a sample")
            item = items.get(sample_id)
            if sample.dataset_id != dataset_id:
                if item is not None:
                    removed.append(cls._archive_change(dataset, sample))
                continue
            if sample.review_decision is ReviewDecision.ACCEPTED:
                change = cls._archive_change(dataset, sample)
                if item is None:
                    added.append(change)
                elif item.sample_revision != sample.revision:
                    updated.append(change)
                else:
                    unchanged_count += 1
            elif item is not None:
                removed.append(cls._archive_change(dataset, sample))
        return ArchivePreviewRead(
            dataset_id=dataset_id,
            added=added,
            updated=updated,
            removed=removed,
            unchanged_count=unchanged_count,
            expected_archive_revision=archive.revision if archive is not None else 0,
        )

    @staticmethod
    def _archive_change(dataset: Dataset, sample: Sample) -> ArchiveChangeRead:
        if sample.id is None:
            raise RuntimeError("A persisted sample must have an id")
        return ArchiveChangeRead(
            sample_id=sample.id,
            display_id=f"CS-{sample.id:06d}",
            expected_revision=sample.revision,
            dataset_id=dataset.id,
            dataset_name=dataset.name,
            category=sample.category,
            protocol=protocol_for(sample.category),
            relation=relation_for(sample.category),
            primary_asset_id=sample.primary_asset_id,
            primary_asset_url=asset_content_url(sample.primary_asset_id),
        )

    @staticmethod
    def _preview_signature(payload: ArchivePreviewRead | ArchiveSyncRequest) -> tuple[object, ...]:
        def changes(values: list[ArchiveChangeRead]) -> tuple[tuple[int, int], ...]:
            return tuple((row.sample_id, row.expected_revision) for row in values)

        return (
            payload.dataset_id,
            payload.expected_archive_revision,
            changes(payload.added),
            changes(payload.updated),
            changes(payload.removed),
            payload.unchanged_count,
        )

    @staticmethod
    def _manifest_record(session: Session, sample: Sample) -> dict[str, object]:
        if sample.id is None:
            raise RuntimeError("A persisted sample must have an id")
        asset = session.get(Asset, sample.primary_asset_id)
        if asset is None:
            raise state_conflict("sample", sample.id, "The primary media does not exist")
        protocol = protocol_for(sample.category)
        relation = relation_for(sample.category)
        emotions_match = emotion_key(sample.true_emotion) == emotion_key(sample.apparent_emotion)
        if relation is Relation.ALIGNED and not emotions_match:
            raise state_conflict("sample", sample.id, "Aligned samples require matching emotions")
        if relation is Relation.CONFLICT and emotions_match:
            raise state_conflict("sample", sample.id, "Conflict samples require different emotions")
        if protocol is Protocol.VA and not asset.has_audio:
            raise state_conflict("sample", sample.id, "VA primary media must contain audio")
        if protocol is Protocol.VT and asset.has_audio:
            raise state_conflict("sample", sample.id, "VT primary media must be silent")
        review = latest_review(session, sample.id)
        if review is None or review.decision is not ReviewDecision.ACCEPTED:
            raise state_conflict("sample", sample.id, "An accepted sample must have a current review")
        reviewer = session.get(Reviewer, review.reviewer_id)
        if reviewer is None:
            raise RuntimeError("A persisted review must reference a reviewer")
        return {
            "sampleId": sample.id,
            "displayId": f"CS-{sample.id:06d}",
            "datasetId": sample.dataset_id,
            "category": sample.category.value,
            "protocol": protocol.value,
            "relation": relation.value,
            "conflictDirection": (
                sample.conflict_direction.value if sample.conflict_direction is not None else None
            ),
            "model": sample.model.value,
            "primaryMedia": {
                "assetId": asset.id,
                "relativePath": asset.relative_path,
                "mediaType": asset.media_type,
                "byteSize": asset.byte_size,
                "width": asset.width,
                "height": asset.height,
                "fps": asset.fps,
                "frameCount": asset.frame_count,
                "durationSeconds": asset.duration_seconds,
                "hasAudio": asset.has_audio,
            },
            "dialogue": sample.dialogue,
            "displayText": sample.display_text,
            "videoPrompt": sample.video_prompt,
            "negativePrompt": sample.negative_prompt,
            "trueEmotion": sample.true_emotion,
            "apparentEmotion": sample.apparent_emotion,
            "trueEmotionDescription": sample.true_emotion_description,
            "contentScript": {
                "id": sample.content_script_id,
                "revision": sample.content_script_revision,
                "nameZh": sample.content_script_name_zh,
                "nameEn": sample.content_script_name_en,
                "sceneZh": sample.scene_zh,
                "sceneEn": sample.scene_en,
                "triggerEventZh": sample.trigger_event_zh,
                "triggerEventEn": sample.trigger_event_en,
                "psychologicalBackgroundZh": sample.psychological_background_zh,
                "psychologicalBackgroundEn": sample.psychological_background_en,
            },
            "demographic": {
                "age": sample.age,
                "gender": sample.gender.value,
                "ethnicity": sample.ethnicity.value,
            },
            "review": {
                "id": review.id,
                "reviewerId": reviewer.id,
                "reviewerName": reviewer.name,
                "decision": review.decision.value,
                "note": review.note,
                "createdAt": review.created_at,
                "revision": review.revision,
            },
            "sampleRevision": sample.revision,
        }
