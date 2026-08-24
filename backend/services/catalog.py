from __future__ import annotations

from typing import Any

from pydantic import ValidationError
from sqlalchemy import delete, func, or_, update
from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.domain.enums import (
    Category,
    ConflictDirection,
    ContentMode,
    ContentStatus,
    DatasetPurpose,
    JobItemStage,
    JobSource,
    JobStatus,
    PromptExampleKind,
    ResourceStatus,
    TemplateVersionStatus,
)
from backend.domain.models import (
    Archive,
    ArchiveItem,
    BatchDraft,
    BatchDraftCombination,
    BatchVideoInputSnapshot,
    ContentScript,
    ContentScriptScene,
    Dataset,
    DatasetMergeOperation,
    DatasetMergeSource,
    Job,
    JobItem,
    JobItemPromptResult,
    PromptTemplate,
    PromptTemplateExample,
    PromptTemplateVersion,
    Sample,
    Scene,
    utc_now,
)
from backend.domain.schemas import (
    BilingualSelectionRead,
    ContentScriptSceneRead,
    ContentScriptCreate,
    ContentScriptFields,
    ContentScriptRead,
    ContentScriptUpdate,
    DatasetCreate,
    DatasetMergeRead,
    DatasetMergeRequest,
    DatasetRead,
    DatasetUpdate,
    PromptTemplateCreate,
    PromptTemplateRead,
    PromptTemplateUpdate,
    PromptTemplateVersionCreate,
    PromptTemplateVersionRead,
    PromptTemplateVersionVerify,
    PageRead,
    SceneCreate,
    SceneRead,
    SceneUpdate,
    validate_content_scene_ids,
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

    def merge_datasets(
        self,
        target_dataset_id: int,
        payload: DatasetMergeRequest,
    ) -> DatasetMergeRead:
        with self.database.immediate_session() as session:
            target = self._get(session, Dataset, target_dataset_id, "dataset")
            self._check_revision(
                target,
                payload.target_expected_revision,
                "dataset",
            )
            if (
                target.purpose is not DatasetPurpose.FORMAL
                or target.status is not ResourceStatus.ACTIVE
            ):
                raise ServiceError(
                    422,
                    "invalid_target_dataset",
                    "The merge target must be an active formal dataset",
                )

            sources: list[Dataset] = []
            for selected in payload.sources:
                if selected.id == target_dataset_id:
                    raise invalid_request("The target dataset cannot also be a source")
                source = self._get(session, Dataset, selected.id, "dataset")
                self._check_revision(
                    source,
                    selected.expected_revision,
                    "dataset",
                )
                sources.append(source)

            source_ids = [source.id for source in sources]
            samples = session.exec(
                select(Sample)
                .where(Sample.dataset_id.in_(source_ids))
                .order_by(Sample.id)
            ).all()
            sample_counts = {
                source.id: sum(
                    sample.dataset_id == source.id for sample in samples
                )
                for source in sources
            }
            operation = DatasetMergeOperation(
                target_dataset_id=target.id,
                target_revision_before=target.revision,
                source_count=len(sources),
            )
            session.add(operation)
            session.flush()
            session.add_all(
                [
                    DatasetMergeSource(
                        operation_id=operation.id,
                        source_dataset_id=source.id,
                        source_revision_before=source.revision,
                        sample_count=sample_counts[source.id],
                    )
                    for source in sources
                ]
            )
            session.flush()
            timestamp = utc_now()
            session.exec(
                update(DatasetMergeOperation)
                .where(DatasetMergeOperation.id == operation.id)
                .values(executing=True, executed_at=timestamp)
            )
            session.flush()
            session.expire_all()
            target = self._get(session, Dataset, target_dataset_id, "dataset")
            sources = [
                self._get(session, Dataset, source_id, "dataset")
                for source_id in source_ids
            ]
            return DatasetMergeRead(
                target_dataset=DatasetRead.model_validate(target),
                source_datasets=[
                    DatasetRead.model_validate(source) for source in sources
                ],
                moved_sample_count=len(samples),
            )

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

    def list_content_scripts(
        self,
        page: int,
        search: str | None = None,
        status: ContentStatus | None = None,
        category: Category | None = None,
        direction: ConflictDirection | None = None,
    ) -> PageRead[ContentScriptRead]:
        with self.database.read_session() as session:
            statement = select(ContentScript)
            if search is not None and search.strip():
                needle = search.strip().casefold()
                statement = statement.where(
                    or_(
                        func.lower(ContentScript.name_zh).contains(needle),
                        func.lower(ContentScript.name_en).contains(needle),
                    )
                )
            if status is not None:
                statement = statement.where(ContentScript.status == status)
            if category is not None:
                statement = statement.where(ContentScript.category == category)
            if direction is not None:
                statement = statement.where(
                    ContentScript.conflict_direction == direction
                )
            return paginate(
                session,
                statement.order_by(
                    ContentScript.category,
                    ContentScript.name_zh,
                    ContentScript.name_en,
                    ContentScript.id,
                ),
                page,
                lambda row: self._content_script_read(session, row),
            )

    def get_content_script(self, content_id: int) -> ContentScriptRead:
        with self.database.read_session() as session:
            return self._content_script_read(
                session,
                self._get(session, ContentScript, content_id, "contentScript"),
            )

    def create_content_script(self, payload: ContentScriptCreate) -> ContentScriptRead:
        with self.database.immediate_session() as session:
            self._ensure_content_names_available(
                session,
                payload.category,
                payload.name_zh,
                payload.name_en,
            )
            scenes = self._content_scene_rows(
                session,
                payload.scene_ids,
                payload.mode,
                payload.status,
            )
            requested_status = payload.status
            values = payload.model_dump(exclude={"scene_ids", "status"})
            row = ContentScript(
                **values,
                status=(
                    ContentStatus.DRAFT
                    if requested_status is ContentStatus.ACTIVE
                    else requested_status
                ),
                name_zh_key=name_key(payload.name_zh),
                name_en_key=name_key(payload.name_en),
            )
            session.add(row)
            session.flush()
            self._replace_content_scene_links(session, row.id, scenes)
            if requested_status is ContentStatus.ACTIVE:
                row.status = ContentStatus.ACTIVE
                session.flush()
            return self._content_script_read(session, row)

    def update_content_script(self, content_id: int, payload: ContentScriptUpdate) -> ContentScriptRead:
        with self.database.immediate_session() as session:
            row = self._get(session, ContentScript, content_id, "contentScript")
            self._check_revision(row, payload.expected_revision, "contentScript")
            values = payload.model_dump(
                exclude_unset=True,
                exclude={"expected_revision", "scene_ids"},
            )
            try:
                candidate = ContentScriptFields.model_validate(
                    {**ContentScriptFields.model_validate(row).model_dump(), **values}
                )
            except ValidationError as error:
                raise ServiceError(422, "validation_error", "The content script is not valid") from error
            self._ensure_content_names_available(
                session,
                row.category,
                candidate.name_zh,
                candidate.name_en,
                content_id,
            )
            scenes = self._content_scene_rows(
                session,
                payload.scene_ids,
                candidate.mode,
                candidate.status,
            )
            values = candidate.model_dump()
            values["name_zh_key"] = name_key(candidate.name_zh)
            values["name_en_key"] = name_key(candidate.name_en)
            requested_status = candidate.status
            if row.status is ContentStatus.ACTIVE:
                row.status = ContentStatus.DRAFT
                session.flush()
            values["status"] = (
                ContentStatus.DRAFT
                if requested_status is ContentStatus.ACTIVE
                else requested_status
            )
            self._apply_update(row, values)
            self._replace_content_scene_links(session, row.id, scenes)
            if requested_status is ContentStatus.ACTIVE:
                row.status = ContentStatus.ACTIVE
                session.flush()
            return self._content_script_read(session, row)

    def delete_content_script(self, content_id: int, expected_revision: int) -> None:
        with self.database.immediate_session() as session:
            row = self._get(session, ContentScript, content_id, "contentScript")
            self._check_revision(row, expected_revision, "contentScript")
            if row.status is not ContentStatus.DRAFT:
                raise state_conflict("contentScript", content_id, "Only an unused draft content script can be deleted")
            if self._content_referenced(session, content_id):
                raise state_conflict("contentScript", content_id, "The content script is already used by a batch")
            session.delete(row)

    def get_content_scenes(self, content_id: int) -> ContentScriptSceneRead:
        with self.database.read_session() as session:
            content = self._get(session, ContentScript, content_id, "contentScript")
            return self._content_scene_read(session, content)

    def list_prompt_templates(
        self,
        page: int,
        category: Category | None = None,
    ) -> PageRead[PromptTemplateRead]:
        with self.database.read_session() as session:
            statement = select(PromptTemplate)
            if category is not None:
                statement = statement.where(PromptTemplate.category == category)
            return paginate(
                session,
                statement.order_by(
                    PromptTemplate.category,
                    PromptTemplate.name,
                    PromptTemplate.id,
                ),
                page,
                PromptTemplateRead.model_validate,
            )

    def get_prompt_template(self, template_id: int) -> PromptTemplateRead:
        with self.database.read_session() as session:
            return PromptTemplateRead.model_validate(
                self._get(session, PromptTemplate, template_id, "promptTemplate")
            )

    def create_prompt_template(
        self,
        payload: PromptTemplateCreate,
    ) -> PromptTemplateRead:
        with self.database.immediate_session() as session:
            self._ensure_template_name_available(
                session, payload.category, payload.name
            )
            row = PromptTemplate(
                name=payload.name,
                name_key=name_key(payload.name),
                category=payload.category,
            )
            session.add(row)
            session.flush()
            return PromptTemplateRead.model_validate(row)

    def update_prompt_template(
        self,
        template_id: int,
        payload: PromptTemplateUpdate,
    ) -> PromptTemplateRead:
        with self.database.immediate_session() as session:
            row = self._get(session, PromptTemplate, template_id, "promptTemplate")
            self._check_revision(row, payload.expected_revision, "promptTemplate")
            self._ensure_template_name_available(
                session,
                row.category,
                payload.name,
                exclude_id=template_id,
            )
            row.name = payload.name
            row.name_key = name_key(payload.name)
            row.revision += 1
            row.updated_at = utc_now()
            session.flush()
            return PromptTemplateRead.model_validate(row)

    def list_prompt_template_versions(
        self,
        template_id: int,
        page: int,
        verification_status: TemplateVersionStatus | None = None,
    ) -> PageRead[PromptTemplateVersionRead]:
        with self.database.read_session() as session:
            template = self._get(
                session, PromptTemplate, template_id, "promptTemplate"
            )
            statement = select(PromptTemplateVersion).where(
                PromptTemplateVersion.template_id == template_id
            )
            if verification_status is not None:
                statement = statement.where(
                    PromptTemplateVersion.verification_status == verification_status
                )
            return paginate(
                session,
                statement
                .order_by(
                    PromptTemplateVersion.version.desc(),
                    PromptTemplateVersion.id,
                ),
                page,
                lambda row: self._prompt_template_version_read(
                    session, template, row
                ),
            )

    def get_prompt_template_version(self, version_id: int) -> PromptTemplateVersionRead:
        with self.database.read_session() as session:
            row = self._get(
                session,
                PromptTemplateVersion,
                version_id,
                "promptTemplateVersion",
            )
            template = self._get(
                session,
                PromptTemplate,
                row.template_id,
                "promptTemplate",
            )
            return self._prompt_template_version_read(session, template, row)

    def create_prompt_template_version(
        self,
        template_id: int,
        payload: PromptTemplateVersionCreate,
    ) -> PromptTemplateVersionRead:
        with self.database.immediate_session() as session:
            return self.create_prompt_template_version_in_session(
                session,
                template_id,
                payload,
            )

    def get_prompt_template_in_session(
        self,
        session: Session,
        template_id: int,
        expected_revision: int,
    ) -> PromptTemplateRead:
        template = self._get(
            session,
            PromptTemplate,
            template_id,
            "promptTemplate",
        )
        self._check_revision(template, expected_revision, "promptTemplate")
        return PromptTemplateRead.model_validate(template)

    def create_prompt_template_version_in_session(
        self,
        session: Session,
        template_id: int,
        payload: PromptTemplateVersionCreate,
    ) -> PromptTemplateVersionRead:
        template = self._get(
            session,
            PromptTemplate,
            template_id,
            "promptTemplate",
        )
        self._check_revision(
            template,
            payload.expected_template_revision,
            "promptTemplate",
        )
        latest = session.exec(
            select(PromptTemplateVersion.version)
            .where(PromptTemplateVersion.template_id == template_id)
            .order_by(PromptTemplateVersion.version.desc())
        ).first()
        row = PromptTemplateVersion(
            template_id=template_id,
            version=(latest or 0) + 1,
            organization_instruction=payload.organization_instruction.strip(),
            style_instruction=payload.style_instruction.strip(),
            ltx_negative_prompt=payload.ltx_negative_prompt,
            h3_negative_prompt=payload.h3_negative_prompt,
        )
        session.add(row)
        session.flush()
        for kind, values in (
            (PromptExampleKind.POSITIVE, payload.positive_examples),
            (PromptExampleKind.NEGATIVE, payload.negative_examples),
        ):
            for position, text in enumerate(values):
                session.add(
                    PromptTemplateExample(
                        prompt_template_version_id=row.id,
                        kind=kind,
                        position=position,
                        text=text,
                    )
                )
        template.revision += 1
        template.updated_at = utc_now()
        session.flush()
        return self._prompt_template_version_read(session, template, row)

    def verify_prompt_template_version(
        self,
        version_id: int,
        payload: PromptTemplateVersionVerify,
    ) -> PromptTemplateVersionRead:
        with self.database.immediate_session() as session:
            row = self._get(
                session,
                PromptTemplateVersion,
                version_id,
                "promptTemplateVersion",
            )
            self._check_revision(
                row,
                payload.expected_revision,
                "promptTemplateVersion",
            )
            if row.verification_status is TemplateVersionStatus.VERIFIED:
                raise state_conflict(
                    "promptTemplateVersion",
                    version_id,
                    "The prompt template version is already verified",
                )
            successful_prompt_test = session.exec(
                select(JobItem.id)
                .join(Job, Job.id == JobItem.job_id)
                .join(
                    BatchVideoInputSnapshot,
                    BatchVideoInputSnapshot.id == JobItem.input_snapshot_id,
                )
                .join(
                    JobItemPromptResult,
                    JobItemPromptResult.job_item_id == JobItem.id,
                )
                .where(
                    Job.source == JobSource.PROMPT_TEST,
                    Job.status == JobStatus.COMPLETED,
                    JobItem.status == JobStatus.COMPLETED,
                    JobItem.stage == JobItemStage.COMPLETED,
                    BatchVideoInputSnapshot.prompt_template_version_id == row.id,
                    BatchVideoInputSnapshot.prompt_template_version_revision
                    == row.revision,
                )
            ).first()
            if successful_prompt_test is None:
                raise state_conflict(
                    "promptTemplateVersion",
                    version_id,
                    "Complete a successful Prompt Test with this draft version before verification",
                )
            row.verification_status = TemplateVersionStatus.VERIFIED
            row.revision += 1
            row.verified_at = utc_now()
            session.flush()
            template = self._get(
                session,
                PromptTemplate,
                row.template_id,
                "promptTemplate",
            )
            return self._prompt_template_version_read(session, template, row)

    def list_scenes(
        self,
        page: int,
    ) -> PageRead[SceneRead]:
        with self.database.read_session() as session:
            return paginate(
                session,
                select(Scene).order_by(
                    Scene.name_zh,
                    Scene.name_en,
                    Scene.id,
                ),
                page,
                SceneRead.model_validate,
            )

    def get_scene(self, preset_id: int) -> SceneRead:
        with self.database.read_session() as session:
            return SceneRead.model_validate(
                self._get(session, Scene, preset_id, "scene")
            )

    def create_scene(self, payload: SceneCreate) -> SceneRead:
        with self.database.immediate_session() as session:
            self._ensure_scene_names_available(session, payload.name_zh, payload.name_en)
            row = Scene(
                **payload.model_dump(),
                name_zh_key=name_key(payload.name_zh),
                name_en_key=name_key(payload.name_en),
            )
            session.add(row)
            session.flush()
            return SceneRead.model_validate(row)

    def create_draft_scene_in_session(
        self,
        session: Session,
        payload: SceneCreate,
    ) -> SceneRead:
        if payload.status is not ResourceStatus.DRAFT:
            raise invalid_request("Resource assistant scenes must remain Draft")
        self._ensure_scene_names_available(session, payload.name_zh, payload.name_en)
        row = Scene(
            **payload.model_dump(),
            name_zh_key=name_key(payload.name_zh),
            name_en_key=name_key(payload.name_en),
        )
        session.add(row)
        session.flush()
        return SceneRead.model_validate(row)

    def create_draft_content_in_session(
        self,
        session: Session,
        payload: ContentScriptCreate,
    ) -> ContentScriptRead:
        if payload.status is not ContentStatus.DRAFT:
            raise invalid_request("Resource assistant content must remain Draft")
        self._ensure_content_names_available(
            session,
            payload.category,
            payload.name_zh,
            payload.name_en,
        )
        scenes = self._content_scene_rows(
            session,
            payload.scene_ids,
            payload.mode,
            payload.status,
        )
        row = ContentScript(
            **payload.model_dump(exclude={"scene_ids"}),
            name_zh_key=name_key(payload.name_zh),
            name_en_key=name_key(payload.name_en),
        )
        session.add(row)
        session.flush()
        self._replace_content_scene_links(session, row.id, scenes)
        return self._content_script_read(session, row)

    def update_scene(
        self,
        preset_id: int,
        payload: SceneUpdate,
    ) -> SceneRead:
        with self.database.immediate_session() as session:
            row = self._get(session, Scene, preset_id, "scene")
            self._check_revision(row, payload.expected_revision, "scene")
            values = payload.model_dump(exclude_unset=True, exclude={"expected_revision"})
            candidate = SceneCreate.model_validate(
                {**SceneCreate.model_validate(row).model_dump(), **values}
            )
            self._ensure_scene_names_available(
                session,
                candidate.name_zh,
                candidate.name_en,
                preset_id,
            )
            values = candidate.model_dump()
            values["name_zh_key"] = name_key(candidate.name_zh)
            values["name_en_key"] = name_key(candidate.name_en)
            self._apply_update(row, values)
            return SceneRead.model_validate(row)

    def delete_scene(self, preset_id: int, expected_revision: int) -> None:
        with self.database.immediate_session() as session:
            row = self._get(session, Scene, preset_id, "scene")
            self._check_revision(row, expected_revision, "scene")
            if row.status is not ResourceStatus.DISABLED:
                raise state_conflict("scene", preset_id, "Disable the scene before deleting it")
            if session.exec(
                select(BatchDraftCombination).where(
                    BatchDraftCombination.scene_id == preset_id
                )
            ).first() or session.exec(
                select(ContentScriptScene).where(
                    ContentScriptScene.scene_id == preset_id
                )
            ).first():
                raise state_conflict("scene", preset_id, "The scene is already used by a batch")
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
            (ContentScript.name_zh_key, name_zh),
            (ContentScript.name_en_key, name_en),
        ):
            statement = select(ContentScript).where(ContentScript.category == category, column == name_key(value))
            if exclude_id is not None:
                statement = statement.where(ContentScript.id != exclude_id)
            if session.exec(statement).first():
                self._raise_name_conflict("contentScript")

    def _ensure_template_name_available(
        self,
        session: Session,
        category: Any,
        name: str,
        exclude_id: int | None = None,
    ) -> None:
        statement = select(PromptTemplate).where(
            PromptTemplate.category == category,
            PromptTemplate.name_key == name_key(name),
        )
        if exclude_id is not None:
            statement = statement.where(PromptTemplate.id != exclude_id)
        if session.exec(statement).first():
            self._raise_name_conflict("promptTemplate")

    def _ensure_scene_names_available(
        self,
        session: Session,
        name_zh: str,
        name_en: str,
        exclude_id: int | None = None,
    ) -> None:
        for column, value in (
            (Scene.name_zh_key, name_zh),
            (Scene.name_en_key, name_en),
        ):
            statement = select(Scene).where(column == name_key(value))
            if exclude_id is not None:
                statement = statement.where(Scene.id != exclude_id)
            if session.exec(statement).first():
                self._raise_name_conflict("scene")

    @staticmethod
    def _prompt_template_version_read(
        session: Session,
        template: PromptTemplate,
        row: PromptTemplateVersion,
    ) -> PromptTemplateVersionRead:
        examples = session.exec(
            select(PromptTemplateExample)
            .where(
                PromptTemplateExample.prompt_template_version_id == row.id
            )
            .order_by(
                PromptTemplateExample.kind,
                PromptTemplateExample.position,
                PromptTemplateExample.id,
            )
        ).all()
        return PromptTemplateVersionRead(
            id=row.id,
            template_id=template.id,
            template_name=template.name,
            category=template.category,
            version=row.version,
            organization_instruction=row.organization_instruction,
            style_instruction=row.style_instruction,
            positive_examples=[
                example.text
                for example in examples
                if example.kind is PromptExampleKind.POSITIVE
            ],
            negative_examples=[
                example.text
                for example in examples
                if example.kind is PromptExampleKind.NEGATIVE
            ],
            ltx_negative_prompt=row.ltx_negative_prompt,
            h3_negative_prompt=row.h3_negative_prompt,
            verification_status=row.verification_status,
            revision=row.revision,
            created_at=row.created_at,
            verified_at=row.verified_at,
        )

    @staticmethod
    def _content_scene_rows(
        session: Session,
        scene_ids: list[int],
        mode: ContentMode,
        status: ContentStatus,
    ) -> list[Scene]:
        try:
            validate_content_scene_ids(scene_ids, mode, status)
        except ValueError as error:
            raise invalid_request(str(error)) from error
        scenes = [
            CatalogService._get(session, Scene, scene_id, "scene")
            for scene_id in scene_ids
        ]
        if status is ContentStatus.ACTIVE and any(
            scene.status is not ResourceStatus.ACTIVE for scene in scenes
        ):
            raise invalid_request("Active content scripts require active scenes")
        return scenes

    @staticmethod
    def _replace_content_scene_links(
        session: Session,
        content_id: int,
        scenes: list[Scene],
    ) -> None:
        session.exec(
            delete(ContentScriptScene).where(
                ContentScriptScene.content_script_id == content_id
            )
        )
        session.flush()
        session.add_all(
            [
                ContentScriptScene(
                    content_script_id=content_id,
                    scene_id=scene.id,
                    position=position,
                )
                for position, scene in enumerate(scenes)
            ]
        )
        session.flush()

    @staticmethod
    def _content_script_read(session: Session, content: ContentScript) -> ContentScriptRead:
        links = session.exec(
            select(ContentScriptScene)
            .where(ContentScriptScene.content_script_id == content.id)
            .order_by(ContentScriptScene.position)
        ).all()
        return ContentScriptRead(
            **ContentScriptFields.model_validate(content).model_dump(),
            id=content.id,
            revision=content.revision,
            created_at=content.created_at,
            updated_at=content.updated_at,
            scene_ids=[link.scene_id for link in links],
        )

    @staticmethod
    def _content_scene_read(
        session: Session,
        content: ContentScript,
    ) -> ContentScriptSceneRead:
        links = session.exec(
            select(ContentScriptScene)
            .where(ContentScriptScene.content_script_id == content.id)
            .order_by(ContentScriptScene.position)
        ).all()
        scenes = [
            session.get(Scene, link.scene_id)
            for link in links
        ]
        if any(scene is None for scene in scenes):
            raise ServiceError(
                409,
                "state_conflict",
                "A registered scene no longer exists",
            )
        return ContentScriptSceneRead(
            content_script_id=content.id,
            content_script_revision=content.revision,
            scenes=[
                BilingualSelectionRead(
                    id=scene.id,
                    name_zh=scene.name_zh,
                    name_en=scene.name_en,
                    revision=scene.revision,
                )
                for scene in scenes
                if scene is not None
            ],
        )

    @staticmethod
    def _content_referenced(session: Session, content_id: int) -> bool:
        return bool(
            session.exec(
                select(BatchDraftCombination).where(
                    BatchDraftCombination.content_script_id == content_id
                )
            ).first()
            or session.exec(
                select(BatchVideoInputSnapshot).where(BatchVideoInputSnapshot.content_script_id == content_id)
            ).first()
        )
