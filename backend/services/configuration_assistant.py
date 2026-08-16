from __future__ import annotations

import json
import re
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from pydantic import ValidationError
from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.adapters.llm import PROMPT_MODEL, PromptAdapterError, PromptModel
from backend.domain.enums import (
    BatchDraftStatus,
    Category,
    ConfigurationAssistantField,
    ConfigurationAssistantStatus,
    ConfigurationCandidateKind,
    ContentMode,
    DatasetPurpose,
    JobSource,
    JobStatus,
    ModelName,
    ResourceStatus,
    TemplateVersionStatus,
    TestExecutionMode,
)
from backend.domain.models import (
    BatchDraft,
    ConfigurationAssistant,
    ContentScript,
    ContentScriptScene,
    Dataset,
    GenerationTestDraft,
    Job,
    PromptTemplate,
    PromptTemplateVersion,
    Scene,
    utc_now,
)
from backend.domain.schemas import (
    AssistantFormState,
    AssistantSourceSelection,
    BatchContentSelectionInput,
    BatchDraftUpdate,
    ConfigurationAssistantApply,
    ConfigurationAssistantCreate,
    ConfigurationAssistantRead,
    ConfigurationAssistantResult,
    ConfigurationCandidateGroup,
    ConfigurationSuggestion,
    ContentScriptCreate,
    GenerationTestDraftRead,
    PromptTestCreate,
    SourceSelection,
    VideoTestCreate,
)

from .batches import BatchService
from .catalog import CatalogService
from .errors import ServiceError, not_found, revision_conflict, state_conflict
from .prompts import DuplicatePromptKeyError, _load_unique_json


URI_SCHEME_PATTERN = re.compile(
    r"(?i)(?<![A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9+.-]{0,31}):\S"
)
WWW_ADDRESS_PATTERN = re.compile(r"(?i)(?<![A-Za-z0-9])www\.")
INTERPRETER_COMMAND_PATTERN = re.compile(
    r"(?i)(?:^|[\s;&|])"
    r"(?:python(?:\d+(?:\.\d+)?)?|py|sh|bash|dash|zsh|ksh|fish|"
    r"pwsh|powershell|cmd(?:\.exe)?|node|deno|bun|perl|ruby|php|lua)"
    r"\s+(?:-[A-Za-z]*[ce]\b|/c\b)"
)
COMMAND_CONTROL_PATTERN = re.compile(
    r"&&|\|\||;|\$\(|`|(?<!\w)\d*>>?(?!\w)|(?<!\w)<<?(?!\w)|\|"
)
REQUEST_PATH_PATTERN = re.compile(
    r"(?i)(?:\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/|"
    r"(?:^|\s)/(?:[A-Za-z0-9._~-]+/)+[A-Za-z0-9._~/?=&%-]*)"
)


class ConfigurationAssistantService:
    def __init__(
        self,
        database: Database,
        model: PromptModel,
        batches: BatchService,
        catalog: CatalogService,
    ) -> None:
        self.database = database
        self.model = model
        self.batches = batches
        self.catalog = catalog
        template_root = Path(__file__).with_name("templates")
        environment = Environment(
            loader=FileSystemLoader(template_root),
            undefined=StrictUndefined,
            autoescape=False,
            keep_trailing_newline=False,
        )
        self.system_template = environment.get_template("assistant_system.j2")
        self.user_template = environment.get_template("assistant_user.j2")

    async def create(
        self,
        payload: ConfigurationAssistantCreate,
    ) -> ConfigurationAssistantRead:
        self._validate_form_scope(payload.target_source, payload.current_form)
        with self.database.read_session() as session:
            batch_revision = self._read_target_batch_revision(session, payload)
            self._validate_form_references(
                session,
                payload.target_source,
                payload.current_form,
            )
            catalog_snapshot = self._catalog_snapshot(session)
            failure_reasons = self._recent_failure_reasons(session)
        expected_missing = self._missing_fields(
            payload.target_source,
            payload.current_form,
        )
        user_input = self.user_template.render(
            target_source=payload.target_source.value,
            user_requirement=payload.user_requirement,
            current_form_json=self._json(payload.current_form),
            catalog_json=json.dumps(
                catalog_snapshot, ensure_ascii=False, separators=(",", ":")
            ),
            failure_reasons_json=json.dumps(
                failure_reasons, ensure_ascii=False, separators=(",", ":")
            ),
            required_missing_json=json.dumps(
                [value.value for value in expected_missing],
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        ).strip()
        try:
            response = await self.model.generate(
                self.system_template.render().strip(),
                user_input,
            )
        except PromptAdapterError as error:
            status = 503 if error.code == "external_configuration_missing" else 502
            raise ServiceError(status, error.code, error.message) from error
        suggestion = self._parse_suggestion(response.content)
        self._validate_safe_suggestion(suggestion)
        self._validate_form_scope(payload.target_source, suggestion.prefill)
        if suggestion.missing_fields != expected_missing:
            raise self._invalid_response(
                "The assistant did not return the complete missing field list"
            )
        self._validate_prefill(suggestion, payload.current_form)
        with self.database.immediate_session() as session:
            self._validate_form_references(
                session,
                payload.target_source,
                payload.current_form,
            )
            if payload.target_source is JobSource.PRODUCTION:
                current_revision = self._batch_revision(
                    session, payload.batch_draft_id
                )
                if current_revision != batch_revision:
                    raise revision_conflict(
                        "batchDraft",
                        payload.batch_draft_id or 0,
                        batch_revision or 0,
                        current_revision,
                    )
                test_draft = None
            else:
                test_draft = GenerationTestDraft(
                    source=payload.target_source,
                    form_state_json=self._json(payload.current_form),
                )
                session.add(test_draft)
                session.flush()
            self._validate_candidates(session, suggestion.candidates, creating=True)
            self._validate_form_references(
                session,
                payload.target_source,
                suggestion.prefill,
            )
            timestamp = utc_now()
            row = ConfigurationAssistant(
                target_source=payload.target_source,
                batch_draft_id=payload.batch_draft_id,
                batch_draft_revision=batch_revision,
                test_draft_id=test_draft.id if test_draft is not None else None,
                test_draft_revision=(
                    test_draft.revision if test_draft is not None else None
                ),
                user_requirement=payload.user_requirement,
                model_name=PROMPT_MODEL,
                current_form_json=self._json(payload.current_form),
                suggestion_json=self._json(suggestion),
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(row)
            session.flush()
            return self._read(session, row)

    def get(self, assistant_id: int) -> ConfigurationAssistantRead:
        with self.database.read_session() as session:
            return self._read(session, self._get(session, assistant_id))

    def apply(
        self,
        assistant_id: int,
        payload: ConfigurationAssistantApply,
    ) -> ConfigurationAssistantRead:
        with self.database.immediate_session() as session:
            row = self._get(session, assistant_id)
            self._require_pending(row, payload.expected_revision)
            suggestion = ConfigurationSuggestion.model_validate_json(
                row.suggestion_json
            )
            self._validate_candidates(
                session, suggestion.candidates, creating=False
            )
            self._validate_form_scope(row.target_source, payload.values)
            self._validate_form_references(
                session,
                row.target_source,
                payload.values,
            )
            created_scene = None
            if payload.create_shooting_scene:
                if suggestion.new_shooting_scene_draft is None:
                    raise ServiceError(
                        422,
                        "validation_error",
                        "There is no shooting scene draft to confirm",
                    )
                created_scene = self.catalog.create_draft_scene_in_session(
                    session, suggestion.new_shooting_scene_draft
                )
            created_content = None
            if payload.create_content_script:
                if suggestion.new_content_script_draft is None:
                    raise ServiceError(
                        422,
                        "validation_error",
                        "There is no content script draft to confirm",
                    )
                content_payload = suggestion.new_content_script_draft
                if payload.link_new_scene_to_content:
                    assert created_scene is not None
                    content_payload = ContentScriptCreate.model_validate(
                        {
                            **content_payload.model_dump(by_alias=True),
                            "sceneIds": [
                                *content_payload.scene_ids,
                                created_scene.id,
                            ],
                        }
                    )
                created_content = self.catalog.create_draft_content_in_session(
                    session, content_payload
                )
            target_revision = (
                self._apply_production(session, row, payload)
                if row.target_source is JobSource.PRODUCTION
                else self._apply_test_draft(session, row, payload)
            )
            result = ConfigurationAssistantResult(
                target_revision=target_revision,
                created_content_script_id=(
                    created_content.id if created_content is not None else None
                ),
                created_shooting_scene_id=(
                    created_scene.id if created_scene is not None else None
                ),
                discarded=False,
            )
            row.applied_values_json = payload.values.model_dump_json(
                by_alias=True,
                exclude_unset=True,
            )
            row.result_json = self._json(result)
            row.status = ConfigurationAssistantStatus.APPLIED
            row.revision += 1
            row.updated_at = utc_now()
            session.flush()
            return self._read(session, row)

    def discard(
        self,
        assistant_id: int,
        expected_revision: int,
    ) -> ConfigurationAssistantRead:
        with self.database.immediate_session() as session:
            row = self._get(session, assistant_id)
            self._require_pending(row, expected_revision)
            row.result_json = self._json(
                ConfigurationAssistantResult(
                    target_revision=None,
                    created_content_script_id=None,
                    created_shooting_scene_id=None,
                    discarded=True,
                )
            )
            row.status = ConfigurationAssistantStatus.DISCARDED
            row.revision += 1
            row.updated_at = utc_now()
            session.flush()
            return self._read(session, row)

    def _apply_production(
        self,
        session: Session,
        row: ConfigurationAssistant,
        payload: ConfigurationAssistantApply,
    ) -> int:
        if row.batch_draft_id is None or row.batch_draft_revision is None:
            raise state_conflict(
                "configurationAssistant",
                row.id or 0,
                "The assistant target is incomplete",
            )
        draft = session.get(BatchDraft, row.batch_draft_id)
        if draft is None:
            raise not_found("batchDraft", row.batch_draft_id)
        if (
            payload.expected_target_revision != row.batch_draft_revision
            or draft.revision != row.batch_draft_revision
        ):
            raise revision_conflict(
                "batchDraft",
                draft.id or 0,
                payload.expected_target_revision,
                draft.revision,
            )
        current = self.batches._draft_read(
            self.batches._load_aggregate(session, draft.id)
        )
        values: dict[str, object] = {
            "targetDatasetId": current.target_dataset_id,
            "displayName": current.display_name,
            "category": current.category,
            "conflictDirection": current.conflict_direction,
            "model": current.model,
            "precision": current.precision,
            "contentSelections": [
                {
                    "contentScriptId": selection.content_script.id,
                    "sceneIds": (
                        []
                        if selection.mode is ContentMode.FIXED
                        else [scene.id for scene in selection.scenes]
                    ),
                }
                for selection in current.content_selections
            ],
            "promptTemplateVersionId": current.prompt_template_version.id,
            "demographics": [
                value.model_dump(by_alias=True) for value in current.demographics
            ],
            "gpuSlots": current.gpu_slots,
            "seeds": current.seeds,
            "expectedRevision": payload.expected_target_revision,
        }
        confirmed = payload.values
        if "target_dataset" in confirmed.model_fields_set:
            assert confirmed.target_dataset is not None
            values["targetDatasetId"] = confirmed.target_dataset.id
        if "display_name" in confirmed.model_fields_set:
            values["displayName"] = confirmed.display_name
        for field_name, target_name in (
            ("category", "category"),
            ("conflict_direction", "conflictDirection"),
            ("model", "model"),
            ("precision", "precision"),
            ("demographics", "demographics"),
            ("gpu_slots", "gpuSlots"),
            ("seeds", "seeds"),
        ):
            if field_name in confirmed.model_fields_set:
                values[target_name] = getattr(confirmed, field_name)
        if "content_selections" in confirmed.model_fields_set:
            content_values: list[dict[str, object]] = []
            for selection in confirmed.content_selections or []:
                content = session.get(ContentScript, selection.content_script.id)
                assert content is not None
                content_values.append(
                    BatchContentSelectionInput(
                        content_script_id=content.id,
                        scene_ids=(
                            []
                            if content.mode is ContentMode.FIXED
                            else [scene.id for scene in selection.scenes]
                        ),
                    ).model_dump(by_alias=True)
                )
            values["contentSelections"] = content_values
        if "prompt_template_version" in confirmed.model_fields_set:
            assert confirmed.prompt_template_version is not None
            values["promptTemplateVersionId"] = (
                confirmed.prompt_template_version.id
            )
        if {"comparisons", "execution_mode"} & confirmed.model_fields_set:
            raise ServiceError(
                422,
                "validation_error",
                "Test comparison settings cannot be applied to a formal batch",
            )
        updated = self.batches.apply_confirmed_batch_draft(
            session,
            draft.id or 0,
            BatchDraftUpdate.model_validate(values),
        )
        return updated.revision

    def _apply_test_draft(
        self,
        session: Session,
        row: ConfigurationAssistant,
        payload: ConfigurationAssistantApply,
    ) -> int:
        if row.test_draft_id is None or row.test_draft_revision is None:
            raise state_conflict(
                "configurationAssistant", row.id or 0, "The assistant target is incomplete"
            )
        draft = session.get(GenerationTestDraft, row.test_draft_id)
        if draft is None:
            raise not_found("generationTestDraft", row.test_draft_id)
        if (
            payload.expected_target_revision != row.test_draft_revision
            or draft.revision != row.test_draft_revision
        ):
            raise revision_conflict(
                "generationTestDraft",
                draft.id or 0,
                payload.expected_target_revision,
                draft.revision,
            )
        current = AssistantFormState.model_validate_json(draft.form_state_json)
        values = current.model_dump(by_alias=True, exclude_none=True)
        for field_name in payload.values.model_fields_set:
            alias = AssistantFormState.model_fields[field_name].alias
            value = getattr(payload.values, field_name)
            if hasattr(value, "model_dump"):
                values[alias] = value.model_dump(by_alias=True)
            elif isinstance(value, list):
                values[alias] = [
                    item.model_dump(by_alias=True)
                    if hasattr(item, "model_dump")
                    else item
                    for item in value
                ]
            else:
                values[alias] = value
        merged = AssistantFormState.model_validate(values)
        self._validate_form_scope(row.target_source, merged)
        self._validate_complete_test_form(row.target_source, merged)
        self._validate_form_references(session, row.target_source, merged)
        draft.form_state_json = self._json(merged)
        draft.revision += 1
        draft.updated_at = utc_now()
        session.flush()
        return draft.revision

    def _read_target_batch_revision(
        self,
        session: Session,
        payload: ConfigurationAssistantCreate,
    ) -> int | None:
        if payload.target_source is not JobSource.PRODUCTION:
            return None
        revision = self._batch_revision(session, payload.batch_draft_id)
        if revision != payload.batch_draft_expected_revision:
            raise revision_conflict(
                "batchDraft",
                payload.batch_draft_id or 0,
                payload.batch_draft_expected_revision or 0,
                revision,
            )
        row = session.get(BatchDraft, payload.batch_draft_id)
        assert row is not None
        if row.status is not BatchDraftStatus.DRAFT:
            raise state_conflict(
                "batchDraft",
                row.id or 0,
                "A submitted batch cannot use configuration assistance",
            )
        return revision

    @staticmethod
    def _batch_revision(session: Session, draft_id: int | None) -> int:
        row = session.get(BatchDraft, draft_id) if draft_id is not None else None
        if row is None:
            raise not_found("batchDraft", draft_id or 0)
        return row.revision

    def _validate_form_references(
        self,
        session: Session,
        target: JobSource,
        form: AssistantFormState,
    ) -> None:
        if form.target_dataset is not None:
            dataset = self._check_reference(
                session,
                Dataset,
                form.target_dataset.id,
                form.target_dataset.expected_revision,
                "dataset",
            )
            if (
                dataset.purpose is not DatasetPurpose.FORMAL
                or dataset.status is not ResourceStatus.ACTIVE
            ):
                raise ServiceError(
                    422,
                    "invalid_target_dataset",
                    "A formal batch requires an active formal dataset",
                )
        if form.prompt_template_version is not None:
            preset = self._check_reference(
                session,
                PromptTemplateVersion,
                form.prompt_template_version.id,
                form.prompt_template_version.expected_revision,
                "promptTemplateVersion",
            )
            template = session.get(PromptTemplate, preset.template_id)
            if template is None:
                raise not_found("promptTemplate", preset.template_id)
            if (
                target is JobSource.PRODUCTION
                and preset.verification_status is not TemplateVersionStatus.VERIFIED
            ):
                raise ServiceError(
                    422,
                    "template_not_verified",
                    "Formal batches require a verified prompt template version",
                )
            if form.category is not None and template.category is not form.category:
                raise ServiceError(
                    422,
                    "validation_error",
                    "The prompt template does not match the selected category",
                )
        else:
            template = None
        for selection in form.content_selections or []:
            content = self._check_reference(
                session,
                ContentScript,
                selection.content_script.id,
                selection.content_script.expected_revision,
                "contentScript",
            )
            if content.status.value != "Active":
                raise state_conflict(
                    "contentScript",
                    content.id,
                    "The selected content script is not active",
                )
            if form.category is not None and content.category is not form.category:
                raise ServiceError(
                    422,
                    "validation_error",
                    "The selected content does not match the selected category",
                )
            if (
                form.category in {Category.A_VA, Category.A_VT}
                or form.conflict_direction is not None
            ) and content.conflict_direction is not form.conflict_direction:
                raise ServiceError(
                    422,
                    "validation_error",
                    "The selected content does not match the conflict direction",
                )
            if template is not None and template.category is not content.category:
                raise ServiceError(
                    422,
                    "validation_error",
                    "The prompt template does not match the selected content",
                )
            for scene_selection in selection.scenes:
                scene = self._check_reference(
                    session,
                    Scene,
                    scene_selection.id,
                    scene_selection.expected_revision,
                    "scene",
                )
                if scene.status is not ResourceStatus.ACTIVE:
                    raise state_conflict(
                        "scene",
                        scene.id,
                        "The selected shooting scene is not active",
                    )
                if session.exec(
                    select(ContentScriptScene).where(
                        ContentScriptScene.content_script_id == content.id,
                        ContentScriptScene.scene_id == scene.id,
                    )
                ).first() is None:
                    raise ServiceError(
                        422,
                        "incompatible_content_scene",
                        "The selected shooting scene is not available for this content",
                    )
        if target is JobSource.PRODUCTION:
            return

    @staticmethod
    def _check_reference(
        session: Session,
        model: type,
        identifier: int,
        expected_revision: int,
        resource: str,
    ):
        row = session.get(model, identifier)
        if row is None:
            raise not_found(resource, identifier)
        if row.revision != expected_revision:
            raise revision_conflict(
                resource, identifier, expected_revision, row.revision
            )
        return row

    @staticmethod
    def _validate_form_scope(
        target: JobSource,
        form: AssistantFormState,
    ) -> None:
        if target is JobSource.PRODUCTION and (
            form.comparisons is not None or form.execution_mode is not None
        ):
            raise ServiceError(
                422,
                "validation_error",
                "Formal batches do not accept test comparison settings",
            )
        if target is not JobSource.PRODUCTION and form.target_dataset is not None:
            raise ServiceError(
                422,
                "validation_error",
                "Test drafts do not accept a target dataset",
            )
        if target is not JobSource.PRODUCTION:
            if form.content_selections is not None and (
                len(form.content_selections) != 1
                or len(form.content_selections[0].scenes) != 1
            ):
                raise ServiceError(
                    422,
                    "validation_error",
                    "A test uses one content script and one shooting scene",
                )
            if form.demographics is not None and len(form.demographics) != 1:
                raise ServiceError(
                    422,
                    "validation_error",
                    "A test uses one person configuration",
                )
        if target is JobSource.PROMPT_TEST and (
            form.comparisons is not None
            or form.execution_mode is not None
            or form.gpu_slots is not None
            or form.seeds is not None
        ):
            raise ServiceError(
                422,
                "validation_error",
                "Prompt tests do not accept video comparison settings",
            )
        if target is JobSource.VIDEO_TEST and (
            form.model is not None
            or form.precision is not None
            or form.gpu_slots is not None
        ):
            raise ServiceError(
                422,
                "validation_error",
                "Video tests use model and GPU values from their comparisons",
            )
        if target is JobSource.VIDEO_TEST and form.seeds is not None:
            if len(form.seeds) != 1:
                raise ServiceError(
                    422,
                    "validation_error",
                    "A video test accepts exactly one seed",
                )
        if target is JobSource.VIDEO_TEST and form.comparisons is not None:
            profiles = [
                (comparison.model, comparison.precision)
                for comparison in form.comparisons
            ]
            if len(profiles) != len(set(profiles)):
                raise ServiceError(
                    422,
                    "validation_error",
                    "Video test comparisons require different model profiles",
                )
            slots = [comparison.gpu_slot for comparison in form.comparisons]
            if (
                form.execution_mode is TestExecutionMode.PARALLEL
                and len(slots) > 1
                and len(slots) != len(set(slots))
            ):
                raise ServiceError(
                    422,
                    "validation_error",
                    "Parallel comparisons require different GPU slots",
                )
            if (
                form.execution_mode is TestExecutionMode.SERIAL
                and len(set(slots)) != 1
            ):
                raise ServiceError(
                    422,
                    "validation_error",
                    "Serial comparisons require one GPU slot",
                )

    @staticmethod
    def _missing_fields(
        target: JobSource,
        form: AssistantFormState,
    ) -> list[ConfigurationAssistantField]:
        common = [
            (
                ConfigurationAssistantField.CONFLICT_DIRECTION,
                form.category not in {Category.C_VA, Category.C_VT}
                or form.conflict_direction is not None,
            ),
            (
                ConfigurationAssistantField.CONTENT_SELECTIONS,
                bool(form.content_selections),
            ),
            (
                ConfigurationAssistantField.PROMPT_TEMPLATE_VERSION,
                form.prompt_template_version is not None,
            ),
            (
                ConfigurationAssistantField.DEMOGRAPHICS,
                bool(form.demographics),
            ),
        ]
        if target is JobSource.PRODUCTION:
            required = [
                (
                    ConfigurationAssistantField.TARGET_DATASET,
                    form.target_dataset is not None,
                ),
                (
                    ConfigurationAssistantField.CATEGORY,
                    form.category is not None,
                ),
                (
                    ConfigurationAssistantField.MODEL,
                    form.model is not None,
                ),
                (
                    ConfigurationAssistantField.PRECISION,
                    form.model is not ModelName.LTX_25
                    or form.precision is not None,
                ),
                *common,
                (ConfigurationAssistantField.GPU_SLOTS, bool(form.gpu_slots)),
                (ConfigurationAssistantField.SEEDS, bool(form.seeds)),
            ]
        elif target is JobSource.PROMPT_TEST:
            required = [
                *common,
                (ConfigurationAssistantField.MODEL, form.model is not None),
                (
                    ConfigurationAssistantField.PRECISION,
                    form.model is not ModelName.LTX_25
                    or form.precision is not None,
                ),
            ]
        else:
            required = [
                *common,
                (ConfigurationAssistantField.COMPARISONS, bool(form.comparisons)),
                (
                    ConfigurationAssistantField.EXECUTION_MODE,
                    form.execution_mode is not None,
                ),
                (ConfigurationAssistantField.SEEDS, bool(form.seeds)),
            ]
        return [field for field, present in required if not present]

    @staticmethod
    def _validate_complete_test_form(
        target: JobSource,
        form: AssistantFormState,
    ) -> None:
        if target is JobSource.PRODUCTION:
            return
        missing = ConfigurationAssistantService._missing_fields(target, form)
        if missing:
            raise ServiceError(
                422,
                "incomplete_test_configuration",
                "Confirm every required test setting before applying the assistant",
            )
        assert form.content_selections is not None
        assert form.prompt_template_version is not None
        assert form.demographics is not None
        content = form.content_selections[0]
        content_source = SourceSelection(
            id=content.content_script.id,
            expected_revision=content.content_script.expected_revision,
        )
        scene_source = SourceSelection(
            id=content.scenes[0].id,
            expected_revision=content.scenes[0].expected_revision,
        )
        template_source = SourceSelection(
            id=form.prompt_template_version.id,
            expected_revision=form.prompt_template_version.expected_revision,
        )
        try:
            if target is JobSource.PROMPT_TEST:
                assert form.model is not None
                PromptTestCreate(
                    content_script=content_source,
                    prompt_template_version=template_source,
                    scene=scene_source,
                    demographic=form.demographics[0],
                    model=form.model,
                    precision=form.precision,
                )
                return
            assert form.comparisons is not None
            assert form.execution_mode is not None
            assert form.seeds is not None
            VideoTestCreate(
                content_script=content_source,
                prompt_template_version=template_source,
                scene=scene_source,
                demographic=form.demographics[0],
                seed=form.seeds[0],
                comparisons=form.comparisons,
                execution_mode=form.execution_mode,
                expected_gpu_revisions={
                    comparison.gpu_slot: 1 for comparison in form.comparisons
                },
            )
        except ValidationError as error:
            raise ServiceError(
                422,
                "invalid_test_configuration",
                "The confirmed test settings are not valid",
            ) from error

    def _parse_suggestion(self, raw: str) -> ConfigurationSuggestion:
        try:
            payload = _load_unique_json(raw)
        except DuplicatePromptKeyError as error:
            raise self._invalid_response(
                "The assistant returned JSON with a duplicate key"
            ) from error
        except json.JSONDecodeError as error:
            raise self._invalid_response(
                "The assistant returned invalid JSON"
            ) from error
        try:
            return ConfigurationSuggestion.model_validate(payload)
        except ValidationError as error:
            raise self._invalid_response(
                "The assistant response does not match the required structure"
            ) from error

    def _validate_safe_suggestion(
        self,
        suggestion: ConfigurationSuggestion,
    ) -> None:
        payload = suggestion.model_dump(mode="json", by_alias=True)
        for text in self._text_values(payload):
            if any(
                pattern.search(text)
                for pattern in (
                    URI_SCHEME_PATTERN,
                    WWW_ADDRESS_PATTERN,
                    INTERPRETER_COMMAND_PATTERN,
                    COMMAND_CONTROL_PATTERN,
                    REQUEST_PATH_PATTERN,
                )
            ):
                raise self._invalid_response(
                    "The assistant returned executable or linked text"
                )

    @staticmethod
    def _text_values(value: object):  # type: ignore[no-untyped-def]
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for nested in value.values():
                yield from ConfigurationAssistantService._text_values(nested)
        elif isinstance(value, list):
            for nested in value:
                yield from ConfigurationAssistantService._text_values(nested)

    def _validate_candidates(
        self,
        session: Session,
        groups: list[ConfigurationCandidateGroup],
        *,
        creating: bool,
    ) -> None:
        for group in groups:
            for candidate in group.items:
                model, label_reader = self._candidate_source(group.kind)
                row = session.get(model, candidate.id)
                if row is None or row.revision != candidate.revision:
                    self._candidate_changed(group.kind, candidate.id, creating)
                assert row is not None
                if label_reader(row, session) != candidate.label:
                    self._candidate_changed(group.kind, candidate.id, creating)

    @staticmethod
    def _candidate_source(kind: ConfigurationCandidateKind) -> tuple[type, object]:
        if kind is ConfigurationCandidateKind.DATASET:
            return Dataset, lambda row, _: row.name
        if kind is ConfigurationCandidateKind.CONTENT_SCRIPT:
            return ContentScript, lambda row, _: f"{row.name_zh} / {row.name_en}"
        if kind is ConfigurationCandidateKind.SHOOTING_SCENE:
            return Scene, lambda row, _: f"{row.name_zh} / {row.name_en}"

        def template_label(row, current_session):  # type: ignore[no-untyped-def]
            template = current_session.get(PromptTemplate, row.template_id)
            return "" if template is None else f"{template.name} v{row.version}"

        return PromptTemplateVersion, template_label

    def _candidate_changed(
        self,
        kind: ConfigurationCandidateKind,
        identifier: int,
        creating: bool,
    ) -> None:
        if creating:
            raise self._invalid_response(
                "The assistant returned a candidate that is not available"
            )
        raise ServiceError(
            409,
            "referenced_resource_changed",
            "A suggested record has changed",
            {"resource": kind.value, "id": identifier},
        )

    def _validate_prefill(
        self,
        suggestion: ConfigurationSuggestion,
        current: AssistantFormState,
    ) -> None:
        groups = {group.kind: group for group in suggestion.candidates}
        for kind in ConfigurationCandidateKind:
            references = self._prefill_references(suggestion.prefill, kind)
            group = groups.get(kind)
            if references and (group is None or len(group.items) != 1):
                raise self._invalid_response(
                    "A prefilled catalog value requires one matching candidate"
                )
            if references:
                if len(references) != 1:
                    raise self._invalid_response(
                        "A prefilled catalog value must be unambiguous"
                    )
                assert group is not None
                candidate = group.items[0]
                reference = references[0]
                if (
                    reference.id != candidate.id
                    or reference.expected_revision != candidate.revision
                    or reference.label != candidate.label
                ):
                    raise self._invalid_response(
                        "A prefilled catalog value does not match its candidate"
                    )
            if (
                group is not None
                and len(group.items) == 1
                and not self._prefill_has_kind(current, kind)
                and not references
            ):
                raise self._invalid_response(
                    "The assistant did not prefill the unique candidate"
                )
            if (
                group is not None
                and len(group.items) > 1
                and references
            ):
                raise self._invalid_response(
                    "The assistant selected from multiple candidates"
                )

    @staticmethod
    def _prefill_references(
        form: AssistantFormState,
        kind: ConfigurationCandidateKind,
    ) -> list[AssistantSourceSelection]:
        if kind is ConfigurationCandidateKind.DATASET:
            return [form.target_dataset] if form.target_dataset is not None else []
        if kind is ConfigurationCandidateKind.PROMPT_TEMPLATE_VERSION:
            return (
                [form.prompt_template_version]
                if form.prompt_template_version is not None
                else []
            )
        if kind is ConfigurationCandidateKind.CONTENT_SCRIPT:
            return [
                selection.content_script
                for selection in form.content_selections or []
            ]
        return [
            scene
            for selection in form.content_selections or []
            for scene in selection.scenes
        ]

    @staticmethod
    def _prefill_has_kind(
        form: AssistantFormState,
        kind: ConfigurationCandidateKind,
    ) -> bool:
        if kind is ConfigurationCandidateKind.DATASET:
            return form.target_dataset is not None
        if kind is ConfigurationCandidateKind.PROMPT_TEMPLATE_VERSION:
            return form.prompt_template_version is not None
        if kind is ConfigurationCandidateKind.CONTENT_SCRIPT:
            return bool(form.content_selections)
        return any(
            selection.scenes for selection in form.content_selections or []
        )

    @staticmethod
    def _catalog_snapshot(session: Session) -> dict[str, object]:
        templates = {
            row.id: row for row in session.exec(select(PromptTemplate)).all()
        }
        scenes_by_content: dict[int, list[int]] = {}
        for link in session.exec(select(ContentScriptScene)).all():
            scenes_by_content.setdefault(link.content_script_id, []).append(
                link.scene_id
            )
        return {
            "datasets": [
                {
                    "id": row.id,
                    "revision": row.revision,
                    "name": row.name,
                    "purpose": row.purpose.value,
                    "status": row.status.value,
                }
                for row in session.exec(select(Dataset)).all()
            ],
            "contentScripts": [
                {
                    "id": row.id,
                    "revision": row.revision,
                    "label": f"{row.name_zh} / {row.name_en}",
                    "category": row.category.value,
                    "direction": (
                        row.conflict_direction.value
                        if row.conflict_direction is not None
                        else None
                    ),
                    "status": row.status.value,
                    "sceneIds": scenes_by_content.get(row.id or 0, []),
                }
                for row in session.exec(select(ContentScript)).all()
            ],
            "shootingScenes": [
                {
                    "id": row.id,
                    "revision": row.revision,
                    "label": f"{row.name_zh} / {row.name_en}",
                    "status": row.status.value,
                }
                for row in session.exec(select(Scene)).all()
            ],
            "promptTemplateVersions": [
                {
                    "id": row.id,
                    "revision": row.revision,
                    "label": f"{templates[row.template_id].name} v{row.version}",
                    "category": templates[row.template_id].category.value,
                    "status": row.verification_status.value,
                }
                for row in session.exec(select(PromptTemplateVersion)).all()
                if row.template_id in templates
            ],
        }

    @staticmethod
    def _recent_failure_reasons(session: Session) -> list[str]:
        rows = session.exec(
            select(Job)
            .where(
                Job.status == JobStatus.FAILED,
                Job.failure_reason.is_not(None),
            )
            .order_by(Job.updated_at.desc(), Job.id.desc())
            .limit(20)
        ).all()
        return [row.failure_reason for row in rows if row.failure_reason]

    def _read(
        self,
        session: Session,
        row: ConfigurationAssistant,
    ) -> ConfigurationAssistantRead:
        test_draft_read = None
        if row.test_draft_id is not None:
            test_draft = session.get(GenerationTestDraft, row.test_draft_id)
            if test_draft is None:
                raise state_conflict(
                    "configurationAssistant",
                    row.id or 0,
                    "The linked test draft does not exist",
                )
            test_draft_read = GenerationTestDraftRead(
                id=test_draft.id,
                source=test_draft.source,
                form_state=AssistantFormState.model_validate_json(
                    test_draft.form_state_json
                ),
                revision=test_draft.revision,
                created_at=test_draft.created_at,
                updated_at=test_draft.updated_at,
            )
        return ConfigurationAssistantRead(
            id=row.id,
            target_source=row.target_source,
            batch_draft_id=row.batch_draft_id,
            test_draft=test_draft_read,
            user_requirement=row.user_requirement,
            model_name=row.model_name,
            current_form=AssistantFormState.model_validate_json(
                row.current_form_json
            ),
            suggestion=ConfigurationSuggestion.model_validate_json(
                row.suggestion_json
            ),
            applied_values=(
                AssistantFormState.model_validate_json(row.applied_values_json)
                if row.applied_values_json is not None
                else None
            ),
            result=(
                ConfigurationAssistantResult.model_validate_json(row.result_json)
                if row.result_json is not None
                else None
            ),
            status=row.status,
            revision=row.revision,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    @staticmethod
    def _get(session: Session, assistant_id: int) -> ConfigurationAssistant:
        row = session.get(ConfigurationAssistant, assistant_id)
        if row is None:
            raise not_found("configurationAssistant", assistant_id)
        return row

    @staticmethod
    def _require_pending(
        row: ConfigurationAssistant,
        expected_revision: int,
    ) -> None:
        if row.revision != expected_revision:
            raise revision_conflict(
                "configurationAssistant",
                row.id or 0,
                expected_revision,
                row.revision,
            )
        if row.status is not ConfigurationAssistantStatus.PENDING:
            raise state_conflict(
                "configurationAssistant",
                row.id or 0,
                "The assistant request is already finished",
            )

    @staticmethod
    def _json(value: object) -> str:
        if hasattr(value, "model_dump_json"):
            return value.model_dump_json(
                by_alias=True,
            )
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _invalid_response(message: str) -> ServiceError:
        return ServiceError(502, "invalid_assistant_response", message)
