from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pydantic import ValidationError
from sqlalchemy import delete, func, or_
from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.domain.enums import ContentMode, ContentStatus, DatasetPurpose, ExampleKind, ResourceStatus
from backend.domain.models import (
    Archive,
    ArchiveItem,
    BatchDraft,
    BatchDraftContentBackground,
    BatchDraftContentSelection,
    BatchDraftPromptPreset,
    BatchVideoInputSnapshot,
    ContentPlan,
    ContentPlanBackground,
    Dataset,
    Job,
    PromptExample,
    PromptPreset,
    Sample,
    VideoBackgroundPreset,
    utc_now,
)
from backend.domain.schemas import (
    BilingualSelectionRead,
    ContentPlanBackgroundRead,
    ContentPlanCreate,
    ContentPlanFields,
    ContentPlanRead,
    ContentPlanUpdate,
    DatasetCreate,
    DatasetRead,
    DatasetUpdate,
    PromptPresetCreate,
    PromptPresetRead,
    PromptPresetUpdate,
    PageRead,
    VideoBackgroundPresetCreate,
    VideoBackgroundPresetRead,
    VideoBackgroundPresetUpdate,
    validate_content_background_ids,
)

from .errors import ServiceError, invalid_request, not_found, revision_conflict, state_conflict
from .pagination import paginate


def name_key(value: str) -> str:
    return value.strip().casefold()


class CatalogService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def list_datasets(
        self,
        page: int,
        search: str | None = None,
        status: ResourceStatus | None = None,
    ) -> PageRead[DatasetRead]:
        with self.database.read_session() as session:
            statement = select(Dataset)
            if search is not None and search.strip():
                needle = search.strip().casefold()
                statement = statement.where(
                    or_(
                        func.lower(Dataset.name).contains(needle),
                        func.lower(Dataset.note).contains(needle),
                    )
                )
            if status is not None:
                statement = statement.where(Dataset.status == status)
            return paginate(
                session,
                statement.order_by(Dataset.created_at, Dataset.id),
                page,
                DatasetRead.model_validate,
            )

    def get_dataset(self, dataset_id: int) -> DatasetRead:
        with self.database.read_session() as session:
            return DatasetRead.model_validate(
                self._get(session, Dataset, dataset_id, "dataset")
            )

    def create_dataset(self, payload: DatasetCreate) -> DatasetRead:
        with self.database.immediate_session() as session:
            self._ensure_dataset_name_available(session, payload.name)
            row = Dataset(
                name=payload.name,
                name_key=name_key(payload.name),
                purpose=DatasetPurpose.FORMAL,
                note=payload.note.strip(),
            )
            session.add(row)
            session.flush()
            return DatasetRead.model_validate(row)

    def update_dataset(self, dataset_id: int, payload: DatasetUpdate) -> DatasetRead:
        with self.database.immediate_session() as session:
            row = self._get(session, Dataset, dataset_id, "dataset")
            self._check_revision(row, payload.expected_revision, "dataset")
            values = payload.model_dump(exclude_unset=True, exclude={"expected_revision"})
            if "name" in values:
                self._ensure_dataset_name_available(session, values["name"], dataset_id)
                values["name_key"] = name_key(values["name"])
            self._apply_update(row, values)
            return DatasetRead.model_validate(row)

    def delete_dataset(self, dataset_id: int, expected_revision: int) -> None:
        with self.database.immediate_session() as session:
            row = self._get(session, Dataset, dataset_id, "dataset")
            self._check_revision(row, expected_revision, "dataset")
            references = {
                "samples": self._reference_count(session, Sample, Sample.dataset_id, dataset_id),
                "jobs": self._reference_count(session, Job, Job.dataset_id, dataset_id),
                "archives": self._reference_count(session, Archive, Archive.dataset_id, dataset_id),
                "archiveItems": self._reference_count(
                    session,
                    ArchiveItem,
                    ArchiveItem.dataset_id,
                    dataset_id,
                ),
                "batchDrafts": self._reference_count(
                    session,
                    BatchDraft,
                    BatchDraft.dataset_id,
                    dataset_id,
                ),
            }
            if any(references.values()):
                raise ServiceError(
                    409,
                    "dataset_not_empty",
                    "The dataset is still referenced and cannot be deleted",
                    {"references": references},
                )
            session.delete(row)

    def list_content_plans(self, page: int) -> PageRead[ContentPlanRead]:
        with self.database.read_session() as session:
            return paginate(
                session,
                select(ContentPlan).order_by(
                    ContentPlan.category,
                    ContentPlan.name_zh,
                    ContentPlan.name_en,
                    ContentPlan.id,
                ),
                page,
                lambda row: self._content_plan_read(session, row),
            )

    def get_content_plan(self, content_id: int) -> ContentPlanRead:
        with self.database.read_session() as session:
            return self._content_plan_read(
                session,
                self._get(session, ContentPlan, content_id, "contentPlan"),
            )

    def create_content_plan(self, payload: ContentPlanCreate) -> ContentPlanRead:
        with self.database.immediate_session() as session:
            self._ensure_content_names_available(
                session,
                payload.category,
                payload.name_zh,
                payload.name_en,
            )
            backgrounds = self._content_background_rows(
                session,
                payload.background_preset_ids,
                payload.mode,
            )
            row = ContentPlan(
                **payload.model_dump(exclude={"background_preset_ids"}),
                name_zh_key=name_key(payload.name_zh),
                name_en_key=name_key(payload.name_en),
            )
            session.add(row)
            session.flush()
            self._replace_content_background_links(session, row.id, backgrounds)
            return self._content_plan_read(session, row)

    def update_content_plan(self, content_id: int, payload: ContentPlanUpdate) -> ContentPlanRead:
        with self.database.immediate_session() as session:
            row = self._get(session, ContentPlan, content_id, "contentPlan")
            self._check_revision(row, payload.expected_revision, "contentPlan")
            values = payload.model_dump(
                exclude_unset=True,
                exclude={"expected_revision", "background_preset_ids"},
            )
            try:
                candidate = ContentPlanFields.model_validate(
                    {**ContentPlanFields.model_validate(row).model_dump(), **values}
                )
            except ValidationError as error:
                raise ServiceError(422, "validation_error", "The content plan is not valid") from error
            self._ensure_content_names_available(
                session,
                row.category,
                candidate.name_zh,
                candidate.name_en,
                content_id,
            )
            backgrounds = self._content_background_rows(
                session,
                payload.background_preset_ids,
                candidate.mode,
            )
            values = candidate.model_dump()
            values["name_zh_key"] = name_key(candidate.name_zh)
            values["name_en_key"] = name_key(candidate.name_en)
            self._apply_update(row, values)
            self._replace_content_background_links(session, row.id, backgrounds)
            return self._content_plan_read(session, row)

    def delete_content_plan(self, content_id: int, expected_revision: int) -> None:
        with self.database.immediate_session() as session:
            row = self._get(session, ContentPlan, content_id, "contentPlan")
            self._check_revision(row, expected_revision, "contentPlan")
            if row.status is not ContentStatus.DRAFT:
                raise state_conflict("contentPlan", content_id, "Only an unused draft content plan can be deleted")
            if self._content_referenced(session, content_id):
                raise state_conflict("contentPlan", content_id, "The content plan is already used by a batch")
            session.delete(row)

    def get_content_backgrounds(self, content_id: int) -> ContentPlanBackgroundRead:
        with self.database.read_session() as session:
            content = self._get(session, ContentPlan, content_id, "contentPlan")
            return self._content_background_read(session, content)

    def list_prompt_presets(self, page: int) -> PageRead[PromptPresetRead]:
        with self.database.read_session() as session:
            return paginate(
                session,
                select(PromptPreset).order_by(
                    PromptPreset.category,
                    PromptPreset.name,
                    PromptPreset.id,
                ),
                page,
                lambda row: self._prompt_preset_read(session, row),
            )

    def get_prompt_preset(self, preset_id: int) -> PromptPresetRead:
        with self.database.read_session() as session:
            return self._prompt_preset_read(session, self._get(session, PromptPreset, preset_id, "promptPreset"))

    def create_prompt_preset(self, payload: PromptPresetCreate) -> PromptPresetRead:
        with self.database.immediate_session() as session:
            self._ensure_preset_name_available(session, payload.category, payload.name)
            row = PromptPreset(
                name=payload.name,
                name_key=name_key(payload.name),
                category=payload.category,
                style_instruction=payload.style_instruction.strip(),
                final_negative_prompt=payload.final_negative_prompt,
                status=payload.status,
            )
            session.add(row)
            session.flush()
            self._replace_examples(session, row.id, payload.positive_examples, payload.negative_examples)
            return self._prompt_preset_read(session, row)

    def update_prompt_preset(self, preset_id: int, payload: PromptPresetUpdate) -> PromptPresetRead:
        with self.database.immediate_session() as session:
            row = self._get(session, PromptPreset, preset_id, "promptPreset")
            self._check_revision(row, payload.expected_revision, "promptPreset")
            values = payload.model_dump(exclude_unset=True, exclude={"expected_revision", "positive_examples", "negative_examples"})
            if "name" in values:
                self._ensure_preset_name_available(session, row.category, values["name"], preset_id)
                values["name_key"] = name_key(values["name"])
            self._apply_update(row, values)
            if payload.positive_examples is not None or payload.negative_examples is not None:
                current = self._prompt_preset_read(session, row)
                self._replace_examples(
                    session,
                    preset_id,
                    payload.positive_examples if payload.positive_examples is not None else current.positive_examples,
                    payload.negative_examples if payload.negative_examples is not None else current.negative_examples,
                )
            return self._prompt_preset_read(session, row)

    def delete_prompt_preset(self, preset_id: int, expected_revision: int) -> None:
        with self.database.immediate_session() as session:
            row = self._get(session, PromptPreset, preset_id, "promptPreset")
            self._check_revision(row, expected_revision, "promptPreset")
            if row.status is not ResourceStatus.DISABLED:
                raise state_conflict("promptPreset", preset_id, "Disable the prompt preset before deleting it")
            if session.exec(
                select(BatchDraftPromptPreset).where(
                    BatchDraftPromptPreset.prompt_preset_id == preset_id
                )
            ).first():
                raise state_conflict("promptPreset", preset_id, "The prompt preset is already used by a batch")
            session.delete(row)

    def list_background_presets(
        self,
        page: int,
    ) -> PageRead[VideoBackgroundPresetRead]:
        with self.database.read_session() as session:
            return paginate(
                session,
                select(VideoBackgroundPreset).order_by(
                    VideoBackgroundPreset.name_zh,
                    VideoBackgroundPreset.name_en,
                    VideoBackgroundPreset.id,
                ),
                page,
                VideoBackgroundPresetRead.model_validate,
            )

    def get_background_preset(self, preset_id: int) -> VideoBackgroundPresetRead:
        with self.database.read_session() as session:
            return VideoBackgroundPresetRead.model_validate(
                self._get(session, VideoBackgroundPreset, preset_id, "videoBackgroundPreset")
            )

    def create_background_preset(self, payload: VideoBackgroundPresetCreate) -> VideoBackgroundPresetRead:
        with self.database.immediate_session() as session:
            self._ensure_background_names_available(session, payload.name_zh, payload.name_en)
            row = VideoBackgroundPreset(
                **payload.model_dump(),
                name_zh_key=name_key(payload.name_zh),
                name_en_key=name_key(payload.name_en),
            )
            session.add(row)
            session.flush()
            return VideoBackgroundPresetRead.model_validate(row)

    def update_background_preset(
        self,
        preset_id: int,
        payload: VideoBackgroundPresetUpdate,
    ) -> VideoBackgroundPresetRead:
        with self.database.immediate_session() as session:
            row = self._get(session, VideoBackgroundPreset, preset_id, "videoBackgroundPreset")
            self._check_revision(row, payload.expected_revision, "videoBackgroundPreset")
            values = payload.model_dump(exclude_unset=True, exclude={"expected_revision"})
            candidate = VideoBackgroundPresetCreate.model_validate(
                {**VideoBackgroundPresetCreate.model_validate(row).model_dump(), **values}
            )
            self._ensure_background_names_available(
                session,
                candidate.name_zh,
                candidate.name_en,
                preset_id,
            )
            values = candidate.model_dump()
            values["name_zh_key"] = name_key(candidate.name_zh)
            values["name_en_key"] = name_key(candidate.name_en)
            self._apply_update(row, values)
            return VideoBackgroundPresetRead.model_validate(row)

    def delete_background_preset(self, preset_id: int, expected_revision: int) -> None:
        with self.database.immediate_session() as session:
            row = self._get(session, VideoBackgroundPreset, preset_id, "videoBackgroundPreset")
            self._check_revision(row, expected_revision, "videoBackgroundPreset")
            if row.status is not ResourceStatus.DISABLED:
                raise state_conflict("videoBackgroundPreset", preset_id, "Disable the background preset before deleting it")
            if session.exec(
                select(BatchDraftContentBackground).where(
                    BatchDraftContentBackground.background_preset_id == preset_id
                )
            ).first() or session.exec(
                select(ContentPlanBackground).where(
                    ContentPlanBackground.background_preset_id == preset_id
                )
            ).first():
                raise state_conflict("videoBackgroundPreset", preset_id, "The background preset is already used by a batch")
            session.delete(row)

    @staticmethod
    def _get(session: Session, model: type[Any], identifier: int, resource: str) -> Any:
        row = session.get(model, identifier)
        if row is None:
            raise not_found(resource, identifier)
        return row

    @staticmethod
    def _reference_count(
        session: Session,
        model: type[Any],
        column: Any,
        dataset_id: int,
    ) -> int:
        return int(
            session.exec(
                select(func.count()).select_from(model).where(column == dataset_id)
            ).one()
        )

    @staticmethod
    def _check_revision(row: Any, expected: int, resource: str) -> None:
        if row.revision != expected:
            raise revision_conflict(resource, row.id, expected, row.revision)

    @staticmethod
    def _apply_update(row: Any, values: dict[str, Any]) -> None:
        for key, value in values.items():
            setattr(row, key, value.strip() if isinstance(value, str) else value)
        row.revision += 1
        row.updated_at = utc_now()

    @staticmethod
    def _raise_name_conflict(resource: str) -> None:
        raise ServiceError(409, "name_conflict", "A record with this name already exists", {"resource": resource})

    def _ensure_dataset_name_available(self, session: Session, name: str, exclude_id: int | None = None) -> None:
        statement = select(Dataset).where(Dataset.name_key == name_key(name))
        if exclude_id is not None:
            statement = statement.where(Dataset.id != exclude_id)
        if session.exec(statement).first():
            self._raise_name_conflict("dataset")

    def _ensure_content_names_available(
        self,
        session: Session,
        category: Any,
        name_zh: str,
        name_en: str,
        exclude_id: int | None = None,
    ) -> None:
        for column, value in (
            (ContentPlan.name_zh_key, name_zh),
            (ContentPlan.name_en_key, name_en),
        ):
            statement = select(ContentPlan).where(ContentPlan.category == category, column == name_key(value))
            if exclude_id is not None:
                statement = statement.where(ContentPlan.id != exclude_id)
            if session.exec(statement).first():
                self._raise_name_conflict("contentPlan")

    def _ensure_preset_name_available(
        self,
        session: Session,
        category: Any,
        name: str,
        exclude_id: int | None = None,
    ) -> None:
        statement = select(PromptPreset).where(PromptPreset.category == category, PromptPreset.name_key == name_key(name))
        if exclude_id is not None:
            statement = statement.where(PromptPreset.id != exclude_id)
        if session.exec(statement).first():
            self._raise_name_conflict("promptPreset")

    def _ensure_background_names_available(
        self,
        session: Session,
        name_zh: str,
        name_en: str,
        exclude_id: int | None = None,
    ) -> None:
        for column, value in (
            (VideoBackgroundPreset.name_zh_key, name_zh),
            (VideoBackgroundPreset.name_en_key, name_en),
        ):
            statement = select(VideoBackgroundPreset).where(column == name_key(value))
            if exclude_id is not None:
                statement = statement.where(VideoBackgroundPreset.id != exclude_id)
            if session.exec(statement).first():
                self._raise_name_conflict("videoBackgroundPreset")

    @staticmethod
    def _replace_examples(
        session: Session,
        preset_id: int,
        positive_examples: Sequence[str],
        negative_examples: Sequence[str],
    ) -> None:
        for row in session.exec(select(PromptExample).where(PromptExample.preset_id == preset_id)).all():
            session.delete(row)
        session.flush()
        for kind, examples in (
            (ExampleKind.POSITIVE, positive_examples),
            (ExampleKind.NEGATIVE, negative_examples),
        ):
            for position, value in enumerate(examples):
                session.add(PromptExample(preset_id=preset_id, kind=kind, position=position, text=value.strip()))
        session.flush()

    @staticmethod
    def _prompt_preset_read(session: Session, row: PromptPreset) -> PromptPresetRead:
        examples = session.exec(
            select(PromptExample)
            .where(PromptExample.preset_id == row.id)
            .order_by(PromptExample.kind, PromptExample.position)
        ).all()
        values = {
            **PromptPresetRead.model_validate(row).model_dump(),
            "positive_examples": [entry.text for entry in examples if entry.kind is ExampleKind.POSITIVE],
            "negative_examples": [entry.text for entry in examples if entry.kind is ExampleKind.NEGATIVE],
        }
        return PromptPresetRead.model_validate(values)

    @staticmethod
    def _content_background_rows(
        session: Session,
        background_ids: list[int],
        mode: ContentMode,
    ) -> list[VideoBackgroundPreset]:
        try:
            validate_content_background_ids(background_ids, mode)
        except ValueError as error:
            raise invalid_request(str(error)) from error
        return [
            CatalogService._get(
                session,
                VideoBackgroundPreset,
                background_id,
                "videoBackgroundPreset",
            )
            for background_id in background_ids
        ]

    @staticmethod
    def _replace_content_background_links(
        session: Session,
        content_id: int,
        backgrounds: list[VideoBackgroundPreset],
    ) -> None:
        session.exec(
            delete(ContentPlanBackground).where(
                ContentPlanBackground.content_plan_id == content_id
            )
        )
        session.flush()
        session.add_all(
            [
                ContentPlanBackground(
                    content_plan_id=content_id,
                    background_preset_id=background.id,
                    position=position,
                )
                for position, background in enumerate(backgrounds)
            ]
        )
        session.flush()

    @staticmethod
    def _content_plan_read(session: Session, content: ContentPlan) -> ContentPlanRead:
        links = session.exec(
            select(ContentPlanBackground)
            .where(ContentPlanBackground.content_plan_id == content.id)
            .order_by(ContentPlanBackground.position)
        ).all()
        return ContentPlanRead(
            **ContentPlanFields.model_validate(content).model_dump(),
            id=content.id,
            revision=content.revision,
            created_at=content.created_at,
            updated_at=content.updated_at,
            background_preset_ids=[link.background_preset_id for link in links],
        )

    @staticmethod
    def _content_background_read(
        session: Session,
        content: ContentPlan,
    ) -> ContentPlanBackgroundRead:
        links = session.exec(
            select(ContentPlanBackground)
            .where(ContentPlanBackground.content_plan_id == content.id)
            .order_by(ContentPlanBackground.position)
        ).all()
        backgrounds = [
            session.get(VideoBackgroundPreset, link.background_preset_id)
            for link in links
        ]
        if any(background is None for background in backgrounds):
            raise ServiceError(
                409,
                "state_conflict",
                "A registered background no longer exists",
            )
        return ContentPlanBackgroundRead(
            content_plan_id=content.id,
            content_plan_revision=content.revision,
            backgrounds=[
                BilingualSelectionRead(
                    id=background.id,
                    name_zh=background.name_zh,
                    name_en=background.name_en,
                    revision=background.revision,
                )
                for background in backgrounds
                if background is not None
            ],
        )

    @staticmethod
    def _content_referenced(session: Session, content_id: int) -> bool:
        return bool(
            session.exec(
                select(BatchDraftContentSelection).where(
                    BatchDraftContentSelection.content_plan_id == content_id
                )
            ).first()
            or session.exec(
                select(BatchVideoInputSnapshot).where(BatchVideoInputSnapshot.content_plan_id == content_id)
            ).first()
        )
