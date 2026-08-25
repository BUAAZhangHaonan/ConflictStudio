from __future__ import annotations

import re
from datetime import date
from typing import Annotated, Any, Generic, Literal, Self, TypeVar

from pydantic import (
    BeforeValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationInfo,
    field_validator,
    model_validator,
)

from .enums import (
    AGES,
    ArchiveSyncStatus,
    BatchDraftStatus,
    Category,
    ConflictDirection,
    ContentMode,
    ContentStatus,
    DatasetPurpose,
    Ethnicity,
    Gender,
    GenerationAttemptStatus,
    GenerationCompatibility,
    GpuSlotName,
    JobItemStage,
    JobSource,
    JobStatus,
    ModelName,
    Precision,
    Protocol,
    Relation,
    ReviewDecision,
    ResourceStatus,
    TestExecutionMode,
    TemplateVersionStatus,
    relation_for,
    validate_direction,
    validate_model_precision,
)
from .display_names import EnglishDisplayName
from .prompt_policy import validate_scene_policy_text


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
        extra="forbid",
    )


PageItem = TypeVar("PageItem")


class PageRead(ApiModel, Generic[PageItem]):
    items: list[PageItem]
    page: int
    page_size: int
    total: int
    total_pages: int


Name = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)
]
ReviewerName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)
]
TextValue = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
OptionalTextValue = Annotated[str, StringConstraints(strip_whitespace=True)]
ReviewNote = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def validate_english_video_prompt(value: str, field_name: str) -> str:
    if _CJK_RE.search(value):
        raise ValueError(f"{field_name} must use English")
    return value


def normalize_emotion(value: object) -> object:
    if isinstance(value, str):
        return emotion_key(value)
    return value


def emotion_key(value: str) -> str:
    return value.strip().casefold()


EmotionValue = Annotated[
    str,
    BeforeValidator(normalize_emotion),
    StringConstraints(min_length=1, max_length=120),
]
EmotionDescription = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=2000),
]


def validate_content_scene_ids(
    values: list[int],
    mode: ContentMode,
    status: ContentStatus,
) -> None:
    if len(values) != len(set(values)):
        raise ValueError("A scene can be registered only once")
    if any(identifier <= 0 for identifier in values):
        raise ValueError("Scene ids must be positive")
    if mode is ContentMode.FIXED and len(values) != 1:
        raise ValueError("Fixed content script requires exactly one scene")
    if mode is ContentMode.GENERATIVE and status is ContentStatus.ACTIVE and not values:
        raise ValueError("Active generative content script requires at least one scene")


class ErrorValue(ApiModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(ApiModel):
    error: ErrorValue


class PromptSchemaFieldDetail(ApiModel):
    model_config = ConfigDict(strict=True)

    path: str
    type: str
    reason: str


class PromptFailureDetails(ApiModel):
    model_config = ConfigDict(strict=True)

    http_status: int | None = Field(default=None, ge=100, le=599)
    finish_reason: str | None = Field(default=None, min_length=1, max_length=160)
    request_id: str | None = Field(default=None, min_length=1, max_length=200)
    fields: list[PromptSchemaFieldDetail] | None = Field(default=None, min_length=1)


class ExpectedRevision(ApiModel):
    expected_revision: int = Field(ge=1)


class UpdateWithChanges(ExpectedRevision):
    @model_validator(mode="after")
    def require_change(self) -> Self:
        if not self.model_fields_set.difference({"expected_revision"}):
            raise ValueError("At least one field must be provided")
        return self

    def reject_explicit_nulls(
        self, nullable_fields: frozenset[str] = frozenset()
    ) -> Self:
        null_fields = {
            field_name
            for field_name in self.model_fields_set.difference(nullable_fields)
            if field_name != "expected_revision" and getattr(self, field_name) is None
        }
        if null_fields:
            fields = ", ".join(
                sorted(to_camel(field_name) for field_name in null_fields)
            )
            raise ValueError(f"Fields cannot be null: {fields}")
        return self


class DatasetCreate(ApiModel):
    name: Name
    note: str = ""


class DatasetUpdate(UpdateWithChanges):
    name: Name | None = None
    note: str | None = None
    status: ResourceStatus | None = None

    @model_validator(mode="after")
    def reject_null_fields(self) -> Self:
        self.reject_explicit_nulls()
        if self.status is not None and self.status not in {
            ResourceStatus.ACTIVE,
            ResourceStatus.INACTIVE,
        }:
            raise ValueError("Dataset status must be Active or Inactive")
        return self


class DatasetRead(ApiModel):
    id: int
    name: str
    purpose: DatasetPurpose
    note: str
    status: ResourceStatus
    revision: int
    created_at: str
    updated_at: str


class ContentScriptFields(ApiModel):
    name_zh: Name
    name_en: EnglishDisplayName
    category: Category
    conflict_direction: ConflictDirection | None = None
    mode: ContentMode
    status: ContentStatus = ContentStatus.DRAFT
    true_emotion: EmotionValue
    apparent_emotion: EmotionValue
    scene_zh: TextValue
    scene_en: TextValue
    trigger_event_zh: TextValue
    trigger_event_en: TextValue
    psychological_background_zh: TextValue
    psychological_background_en: TextValue
    dialogue: str | None = None
    display_text: str | None = None
    true_emotion_description: str = ""
    base_video_prompt: str = ""
    content_requirements_zh: OptionalTextValue
    content_requirements_en: OptionalTextValue
    scene_supplement_zh: OptionalTextValue
    scene_supplement_en: OptionalTextValue

    @field_validator("base_video_prompt")
    @classmethod
    def validate_base_video_prompt(cls, value: str) -> str:
        return validate_english_video_prompt(value, "baseVideoPrompt")

    @model_validator(mode="after")
    def validate_content(self) -> Self:
        if not validate_direction(self.category, self.conflict_direction):
            raise ValueError("Conflict direction does not match the category")
        if (
            self.category in {Category.A_VA, Category.A_VT}
            and self.true_emotion != self.apparent_emotion
        ):
            raise ValueError(
                "Aligned content requires true emotion to equal apparent emotion"
            )
        if (
            self.category in {Category.C_VA, Category.C_VT}
            and self.true_emotion == self.apparent_emotion
        ):
            raise ValueError(
                "Conflict content requires true emotion to differ from apparent emotion"
            )
        if self.mode is ContentMode.FIXED and not self.base_video_prompt.strip():
            raise ValueError("Fixed content requires a base video prompt")
        if self.mode is ContentMode.GENERATIVE and (
            not self.content_requirements_zh or not self.content_requirements_en
        ):
            raise ValueError(
                "Generative content requires Chinese and English content requirements"
            )
        if (
            self.category in {Category.A_VA, Category.C_VA}
            and self.mode is ContentMode.FIXED
        ):
            if not (self.dialogue or "").strip():
                raise ValueError("Fixed VA content requires dialogue")
        if (
            self.category in {Category.A_VT, Category.C_VT}
            and self.mode is ContentMode.FIXED
        ):
            if not (self.display_text or "").strip():
                raise ValueError("Fixed VT content requires display text")
        if self.mode is ContentMode.FIXED and not self.true_emotion_description.strip():
            raise ValueError("Fixed content requires a true emotion description")
        return self


class ContentScriptCreate(ContentScriptFields):
    scene_ids: list[int] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_scenes(self) -> Self:
        validate_content_scene_ids(self.scene_ids, self.mode, self.status)
        return self


class ContentScriptUpdate(UpdateWithChanges):
    scene_ids: list[int] = Field(default_factory=list)
    name_zh: Name | None = None
    name_en: EnglishDisplayName | None = None
    conflict_direction: ConflictDirection | None = None
    mode: ContentMode | None = None
    status: ContentStatus | None = None
    true_emotion: EmotionValue | None = None
    apparent_emotion: EmotionValue | None = None
    scene_zh: TextValue | None = None
    scene_en: TextValue | None = None
    trigger_event_zh: TextValue | None = None
    trigger_event_en: TextValue | None = None
    psychological_background_zh: TextValue | None = None
    psychological_background_en: TextValue | None = None
    dialogue: str | None = None
    display_text: str | None = None
    true_emotion_description: str | None = None
    base_video_prompt: str | None = None
    content_requirements_zh: OptionalTextValue | None = None
    content_requirements_en: OptionalTextValue | None = None
    scene_supplement_zh: OptionalTextValue | None = None
    scene_supplement_en: OptionalTextValue | None = None

    @model_validator(mode="after")
    def reject_null_fields(self) -> Self:
        self.reject_explicit_nulls(
            frozenset({"conflict_direction", "dialogue", "display_text"})
        )
        if len(self.scene_ids) != len(set(self.scene_ids)):
            raise ValueError("A scene can be registered only once")
        if any(identifier <= 0 for identifier in self.scene_ids):
            raise ValueError("Scene ids must be positive")
        return self

    @field_validator("base_video_prompt")
    @classmethod
    def validate_base_video_prompt(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_english_video_prompt(value, "baseVideoPrompt")


class ContentScriptRead(ContentScriptFields):
    id: int
    scene_ids: list[int]
    revision: int
    created_at: str
    updated_at: str


class PromptTemplateVersionFields(ApiModel):
    organization_instruction: str = Field(default="", alias="organizationRules")
    style_instruction: str = Field(default="", alias="styleGuidance")
    positive_examples: list[TextValue] = Field(default_factory=list, max_length=20)
    negative_examples: list[TextValue] = Field(default_factory=list, max_length=20)
    ltx_negative_prompt: TextValue = Field(alias="ltxNegativePrompt")
    h3_negative_prompt: TextValue = Field(alias="h3NegativePrompt")

    @field_validator("ltx_negative_prompt", "h3_negative_prompt")
    @classmethod
    def validate_negative_prompt(cls, value: str, info: ValidationInfo) -> str:
        return validate_english_video_prompt(value, to_camel(info.field_name))


class PromptTemplateCreate(ApiModel):
    name: EnglishDisplayName
    category: Category


class PromptTemplateRead(ApiModel):
    id: int
    name: str
    category: Category
    revision: int
    created_at: str
    updated_at: str


class PromptTemplateVersionCreate(PromptTemplateVersionFields):
    expected_template_revision: int = Field(ge=1)


class PromptTemplateVersionVerify(ExpectedRevision):
    pass


class PromptTemplateVersionRead(PromptTemplateVersionFields):
    id: int
    template_id: int
    template_name: str
    category: Category
    version: int
    verification_status: TemplateVersionStatus
    revision: int
    created_at: str
    verified_at: str | None


class SceneFields(ApiModel):
    name_zh: Name
    name_en: EnglishDisplayName
    scene_zh: TextValue
    scene_en: TextValue
    ambient_sound_zh: OptionalTextValue
    ambient_sound_en: OptionalTextValue
    participant_relationship_zh: OptionalTextValue
    participant_relationship_en: OptionalTextValue
    lighting_zh: OptionalTextValue
    lighting_en: OptionalTextValue
    framing_zh: OptionalTextValue
    framing_en: OptionalTextValue
    status: ResourceStatus = ResourceStatus.ACTIVE

    @field_validator(
        "scene_en",
        "ambient_sound_en",
        "participant_relationship_en",
        "lighting_en",
        "framing_en",
    )
    @classmethod
    def validate_scene_text(cls, value: str, info: ValidationInfo) -> str:
        return validate_scene_policy_text(value, info.field_name)


class SceneCreate(SceneFields):
    pass


class SceneUpdate(UpdateWithChanges):
    name_zh: Name | None = None
    name_en: EnglishDisplayName | None = None
    scene_zh: TextValue | None = None
    scene_en: TextValue | None = None
    ambient_sound_zh: OptionalTextValue | None = None
    ambient_sound_en: OptionalTextValue | None = None
    participant_relationship_zh: OptionalTextValue | None = None
    participant_relationship_en: OptionalTextValue | None = None
    lighting_zh: OptionalTextValue | None = None
    lighting_en: OptionalTextValue | None = None
    framing_zh: OptionalTextValue | None = None
    framing_en: OptionalTextValue | None = None
    status: ResourceStatus | None = None

    @model_validator(mode="after")
    def reject_null_fields(self) -> Self:
        return self.reject_explicit_nulls()

    @field_validator(
        "scene_en",
        "ambient_sound_en",
        "participant_relationship_en",
        "lighting_en",
        "framing_en",
    )
    @classmethod
    def validate_scene_text(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None:
            return None
        return validate_scene_policy_text(value, info.field_name)


class SceneRead(SceneFields):
    id: int
    revision: int
    created_at: str
    updated_at: str


class ResourceAssistantTemplateTarget(ApiModel):
    id: int = Field(gt=0)
    expected_revision: int = Field(ge=1)


class ResourceAssistantContentDraft(ContentScriptFields):
    status: Literal[ContentStatus.DRAFT] = ContentStatus.DRAFT


class ResourceAssistantSceneDraft(SceneFields):
    status: Literal[ResourceStatus.DRAFT] = ResourceStatus.DRAFT


class ResourceAssistantPromptTemplateVersionDraft(PromptTemplateVersionFields):
    pass


class ResourceAssistantBundle(ApiModel):
    content_script: ResourceAssistantContentDraft
    scenes: list[ResourceAssistantSceneDraft] = Field(min_length=1)
    prompt_template_version: ResourceAssistantPromptTemplateVersionDraft

    @model_validator(mode="after")
    def validate_bundle(self) -> Self:
        if self.content_script.mode is ContentMode.FIXED and len(self.scenes) != 1:
            raise ValueError("Fixed content script requires exactly one scene")
        for field_name in ("name_zh", "name_en"):
            names = [
                getattr(scene, field_name).strip().casefold()
                for scene in self.scenes
            ]
            if len(names) != len(set(names)):
                raise ValueError("Proposed scene names must be unique")
        for value in self._text_values(self.model_dump(mode="json")):
            if any(
                ord(character) < 32 and character not in "\t\n\r"
                for character in value
            ) or "\x7f" in value:
                raise ValueError(
                    "Resource assistant text cannot contain control characters"
                )
        return self

    @staticmethod
    def _text_values(value: object):  # type: ignore[no-untyped-def]
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for nested in value.values():
                yield from ResourceAssistantBundle._text_values(nested)
        elif isinstance(value, list):
            for nested in value:
                yield from ResourceAssistantBundle._text_values(nested)


class ResourceAssistantPropose(ApiModel):
    user_requirement: str = Field(min_length=1, max_length=4000)
    prompt_template: ResourceAssistantTemplateTarget

    @field_validator("user_requirement")
    @classmethod
    def reject_credentials(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("The resource requirement must not be blank")
        if re.search(r"\bsk-[A-Za-z0-9_-]{16,}\b", stripped):
            raise ValueError("Credentials are not allowed in assistant requests")
        return stripped


class ResourceAssistantProposalRead(ApiModel):
    prompt_template: PromptTemplateRead
    bundle: ResourceAssistantBundle


class ResourceAssistantApply(ApiModel):
    prompt_template: ResourceAssistantTemplateTarget
    bundle: ResourceAssistantBundle


class ResourceAssistantApplyRead(ApiModel):
    content_script: ContentScriptRead
    scenes: list[SceneRead]
    prompt_template_version: PromptTemplateVersionRead


class SourceSelection(ApiModel):
    id: int = Field(gt=0)
    expected_revision: int = Field(ge=1)


class DemographicInput(ApiModel):
    age: int
    gender: Gender
    ethnicity: Ethnicity

    @model_validator(mode="after")
    def validate_age(self) -> Self:
        if self.age not in AGES:
            raise ValueError("Age must be one of 25, 35, 45 or 60")
        return self


class BatchContentSelectionInput(ApiModel):
    content_script_id: int = Field(gt=0)
    scene_ids: list[int] = Field(default_factory=list)

    @model_validator(mode="after")
    def reject_duplicate_scenes(self) -> Self:
        if len(self.scene_ids) != len(set(self.scene_ids)):
            raise ValueError("A scene can be selected only once per content script")
        if any(identifier <= 0 for identifier in self.scene_ids):
            raise ValueError("Scene ids must be positive")
        return self


class BatchDraftFields(ApiModel):
    target_dataset_id: int = Field(gt=0)
    display_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=40,
        pattern=r"^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff _-]*$",
    )
    category: Category
    conflict_direction: ConflictDirection | None = None
    model: ModelName = ModelName.LTX_25
    precision: Precision | None = Precision.INT8
    content_selections: list[BatchContentSelectionInput] = Field(min_length=1)
    prompt_template_version_id: int = Field(gt=0)
    demographics: list[DemographicInput] = Field(min_length=1)
    gpu_slots: list[GpuSlotName] = Field(min_length=1, max_length=2)
    seeds: list[Annotated[int, Field(ge=0, lt=2**31)]] = Field(min_length=1)

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str | None) -> str | None:
        if value is not None and value != value.strip():
            raise ValueError("Batch name cannot start or end with a space")
        return value

    @model_validator(mode="before")
    @classmethod
    def default_precision_for_selected_model(cls, values: Any) -> Any:
        if isinstance(values, dict) and "precision" not in values:
            selected_model = values.get("model", ModelName.LTX_25)
            if selected_model != ModelName.LTX_25:
                values = {**values, "precision": None}
        return values

    @model_validator(mode="after")
    def validate_batch(self) -> Self:
        if not validate_direction(self.category, self.conflict_direction):
            raise ValueError("Conflict direction does not match the category")
        if not validate_model_precision(self.model, self.precision):
            raise ValueError(
                "LTX-2.5 requires BF16 or INT8 precision; older models require null precision"
            )
        identifiers = [value.content_script_id for value in self.content_selections]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("Duplicate content script selection")
        if len(self.gpu_slots) != len(set(self.gpu_slots)):
            raise ValueError("Duplicate GPU selection")
        if len(self.seeds) != len(set(self.seeds)):
            raise ValueError("Duplicate seed selection")
        demographics = [
            (value.age, value.gender, value.ethnicity) for value in self.demographics
        ]
        if len(demographics) != len(set(demographics)):
            raise ValueError("Duplicate demographic selection")
        return self


class BatchDraftCreate(BatchDraftFields):
    pass


class BatchDraftUpdate(BatchDraftFields, ExpectedRevision):
    pass


class SelectionRead(ApiModel):
    id: int
    name: str
    revision: int


class BilingualSelectionRead(ApiModel):
    id: int
    name_zh: str
    name_en: str
    revision: int


class ContentScriptSceneRead(ApiModel):
    content_script_id: int
    content_script_revision: int
    scenes: list[BilingualSelectionRead]


class BatchContentSelectionRead(ApiModel):
    content_script: BilingualSelectionRead
    mode: ContentMode
    scenes: list[BilingualSelectionRead]
    compatible_scenes: list[BilingualSelectionRead]


class BatchDraftRead(ApiModel):
    id: int
    target_dataset_id: int
    dataset_revision: int
    display_name: str | None
    category: Category
    conflict_direction: ConflictDirection | None
    model: ModelName
    precision: Precision | None
    combination_count: int
    total_count: int
    seeds: list[int]
    status: BatchDraftStatus
    content_selections: list[BatchContentSelectionRead]
    prompt_template_version: SelectionRead
    demographics: list[DemographicInput]
    gpu_slots: list[GpuSlotName]
    revision: int
    created_at: str
    updated_at: str


class BatchPreviewRequest(ExpectedRevision):
    pass


class BatchSubmitRequest(ExpectedRevision):
    expected_gpu_revisions: dict[GpuSlotName, Annotated[int, Field(ge=1)]]
    confirm_model_switch: bool = False


class JobCancelRequest(ExpectedRevision):
    pass


class JobResumeRequest(ExpectedRevision):
    pass


class JobRetryFailedRequest(ExpectedRevision):
    item_revisions: dict[Annotated[int, Field(gt=0)], Annotated[int, Field(ge=1)]]

    @model_validator(mode="after")
    def require_items(self) -> Self:
        if not self.item_revisions:
            raise ValueError("Select at least one failed item")
        return self


class BatchAllocationRead(ApiModel):
    sequence: int
    content_script: BilingualSelectionRead
    prompt_template_version: SelectionRead
    scene: BilingualSelectionRead
    demographic: DemographicInput
    gpu_slot: GpuSlotName
    model: ModelName
    precision: Precision | None
    seed: int
    requires_prompt_generation: bool
    system_input: str
    user_input: str
    final_positive_prompt: str | None
    negative_prompt: str


class BatchPreviewRead(ApiModel):
    batch_draft_id: int
    expected_revision: int
    combination_count: int
    seed_count: int
    total_count: int
    gpu_revisions: dict[GpuSlotName, int]
    allocations: list[BatchAllocationRead]


class TestComparisonInput(ApiModel):
    model: ModelName
    precision: Precision | None = None
    gpu_slot: GpuSlotName

    @model_validator(mode="after")
    def validate_profile(self) -> Self:
        if not validate_model_precision(self.model, self.precision):
            raise ValueError("Model and precision do not match")
        return self


class PromptTestCreate(ApiModel):
    content_script: SourceSelection
    prompt_template_version: SourceSelection
    scene: SourceSelection
    demographic: DemographicInput
    model: ModelName
    precision: Precision | None = None

    @model_validator(mode="after")
    def validate_profile(self) -> Self:
        if not validate_model_precision(self.model, self.precision):
            raise ValueError("Model and precision do not match")
        return self


class VideoTestCreate(ApiModel):
    content_script: SourceSelection
    prompt_template_version: SourceSelection
    scene: SourceSelection
    demographic: DemographicInput
    seed: int | None = Field(default=None, ge=0, lt=2**31)
    comparisons: list[TestComparisonInput] = Field(min_length=1, max_length=2)
    execution_mode: TestExecutionMode
    expected_gpu_revisions: dict[GpuSlotName, Annotated[int, Field(ge=1)]]
    confirm_model_switch: bool = False

    @model_validator(mode="after")
    def validate_comparisons(self) -> Self:
        profiles = [(value.model, value.precision) for value in self.comparisons]
        if len(profiles) != len(set(profiles)):
            raise ValueError("Test comparisons must use distinct model profiles")
        slots = [value.gpu_slot for value in self.comparisons]
        selected_slots = set(slots)
        if set(self.expected_gpu_revisions) != selected_slots:
            raise ValueError("GPU revisions must match the selected GPU slots")
        if self.execution_mode is TestExecutionMode.PARALLEL and len(slots) > 1:
            if len(selected_slots) != len(slots):
                raise ValueError("Parallel comparisons must use different GPU slots")
        if self.execution_mode is TestExecutionMode.SERIAL and len(selected_slots) != 1:
            raise ValueError("Serial comparisons must use one GPU slot")
        return self


class SnapshotRead(ApiModel):
    id: int
    sequence: int
    dataset_id: int | None
    dataset_revision: int | None
    dataset_name: str | None
    content_script_id: int
    content_script_revision: int
    prompt_template_version_id: int
    prompt_template_version_revision: int
    scene_id: int
    scene_revision: int
    policy_version: str
    category: Category
    conflict_direction: ConflictDirection | None
    age: int
    gender: Gender
    ethnicity: Ethnicity
    model: ModelName
    precision: Precision | None
    seed: int
    width: int
    height: int
    fps: int
    frame_count: int
    renderer_profile_version: str
    prompt_model: str
    source_has_audio: bool
    derive_silent_primary: bool
    system_input: str
    user_input: str
    negative_prompt: str
    true_emotion: str
    apparent_emotion: str
    content_script_name_zh: str
    content_script_name_en: str
    content_scene_zh: str
    content_scene_en: str
    trigger_event_zh: str
    trigger_event_en: str
    psychological_background_zh: str
    psychological_background_en: str
    shooting_scene_name_zh: str
    shooting_scene_name_en: str
    shooting_scene_zh: str
    shooting_scene_en: str
    ambient_sound_zh: str
    ambient_sound_en: str
    participant_relationship_zh: str
    participant_relationship_en: str
    lighting_zh: str
    lighting_en: str
    framing_zh: str
    framing_en: str
    created_at: str


class JobItemPromptResultRead(ApiModel):
    id: int
    job_item_id: int
    policy_version: str
    system_input: str
    user_input: str
    raw_structured_response: str
    final_positive_prompt: str
    negative_prompt: str
    dialogue: str | None
    vt_text: str | None
    true_emotion_description: str
    created_at: str


class GenerationAttemptRead(ApiModel):
    id: int
    attempt_number: int
    model: ModelName
    precision: Precision | None
    gpu_slot: GpuSlotName
    seed: int
    source_asset_id: int | None
    source_asset_url: str | None
    primary_asset_id: int | None
    primary_asset_url: str | None
    renderer_prompt_id: str
    status: GenerationAttemptStatus
    failure_reason: str | None
    started_at: str
    finished_at: str | None


class JobItemRead(ApiModel):
    id: int
    sequence: int
    gpu_slot: GpuSlotName | None
    stage: JobItemStage
    status: JobStatus
    failure_code: str | None
    failure_reason: str | None
    failure_details: PromptFailureDetails | None
    renderer_prompt_id: str | None
    source_asset_id: int | None
    source_asset_url: str | None
    primary_asset_id: int | None
    primary_asset_url: str | None
    revision: int
    created_at: str
    updated_at: str
    input: SnapshotRead
    prompt_result: JobItemPromptResultRead | None
    latest_attempt: GenerationAttemptRead | None = None
    attempt_count: int = 0
    sample_id: int | None = None


class ReviewerCreate(ApiModel):
    name: ReviewerName


class ReviewerRename(ExpectedRevision):
    name: ReviewerName


class ReviewerRead(ApiModel):
    id: int
    name: str
    revision: int
    created_at: str
    updated_at: str


class ReviewQueueFilter(ApiModel):
    decision: Literal[
        "All",
        ReviewDecision.PENDING,
        ReviewDecision.ACCEPTED,
        ReviewDecision.REJECTED,
    ] = "All"
    dataset_id: int | None = Field(default=None, gt=0)
    protocol: Protocol | None = None
    relation: Relation | None = None
    direction: ConflictDirection | None = None
    search: str | None = Field(
        default=None,
        min_length=1,
        max_length=160,
        pattern=r".*\S.*",
    )
    in_archive: bool | None = None


class ReviewMutation(ApiModel):
    sample_id: int = Field(gt=0)
    reviewer_id: int = Field(gt=0)
    expected_revision: int = Field(ge=1)
    expected_review_revision: int = Field(ge=0)
    expected_note_draft_revision: int = Field(ge=0)


class ReviewCreate(ReviewMutation):
    decision: ReviewDecision
    queue: ReviewQueueFilter


class ReviewBatchItem(ReviewMutation):
    decision: Literal[ReviewDecision.ACCEPTED, ReviewDecision.REJECTED]


class ReviewBatchCreate(ApiModel):
    items: list[ReviewBatchItem] = Field(min_length=1)

    @model_validator(mode="after")
    def reject_duplicate_samples(self) -> Self:
        sample_ids = [item.sample_id for item in self.items]
        if len(sample_ids) != len(set(sample_ids)):
            raise ValueError("A batch cannot contain the same sample more than once")
        return self


class ReviewRead(ApiModel):
    id: int
    sample_id: int
    reviewer_id: int
    reviewer_name: str
    protocol: Protocol
    relation: Relation
    decision: ReviewDecision
    note: str
    sample_revision: int
    revision: int
    created_at: str


class ReviewNoteDraftUpdate(ApiModel):
    reviewer_id: int = Field(gt=0)
    note: ReviewNote = ""
    expected_revision: int = Field(ge=0)
    expected_sample_revision: int = Field(ge=1)


class ReviewNoteDraftRead(ApiModel):
    sample_id: int
    reviewer_id: int
    sample_revision: int
    note: str
    revision: int = Field(ge=0)
    updated_at: str | None


class SampleClassificationUpdate(ExpectedRevision):
    reviewer_id: int = Field(gt=0)
    target_category: Category
    conflict_direction: ConflictDirection | None = None
    apparent_emotion: EmotionValue | None = None
    true_emotion_description: EmotionDescription

    @model_validator(mode="after")
    def validate_target(self) -> Self:
        if not validate_direction(self.target_category, self.conflict_direction):
            raise ValueError(
                "The conflict direction does not match the target category"
            )
        if (
            relation_for(self.target_category) is Relation.CONFLICT
            and self.apparent_emotion is None
        ):
            raise ValueError("A conflict category requires an apparent emotion")
        if (
            relation_for(self.target_category) is Relation.ALIGNED
            and "apparent_emotion" in self.model_fields_set
        ):
            raise ValueError(
                "An aligned category sets the apparent emotion automatically"
            )
        return self


class ReviewerActivityRead(ApiModel):
    date: date
    reviewed_count: int = Field(ge=0)


class ReviewerStatisticsRead(ApiModel):
    reviewer_id: int
    dataset_id: int | None
    start_date: date
    end_date: date
    unique_reviewed_count: int = Field(ge=0)
    accepted_count: int = Field(ge=0)
    rejected_count: int = Field(ge=0)
    va_count: int = Field(ge=0)
    vt_count: int = Field(ge=0)
    revised_sample_count: int = Field(ge=0)
    archived_current_count: int = Field(ge=0)
    needs_update_count: int = Field(ge=0)
    activity: list[ReviewerActivityRead]


class ArchiveChangeRead(ApiModel):
    sample_id: int
    display_id: str
    expected_revision: int = Field(ge=1)
    dataset_id: int
    dataset_name: str
    category: Category
    protocol: Protocol
    relation: Relation
    primary_asset_id: int
    primary_asset_url: str


class ArchivePreviewRequest(ApiModel):
    dataset_id: int = Field(gt=0)


class ArchivePreviewRead(ApiModel):
    dataset_id: int
    added: list[ArchiveChangeRead]
    updated: list[ArchiveChangeRead]
    removed: list[ArchiveChangeRead]
    unchanged_count: int = Field(ge=0)
    expected_archive_revision: int = Field(ge=0)


class ArchiveSyncRequest(ArchivePreviewRead):
    @model_validator(mode="after")
    def reject_duplicate_samples(self) -> Self:
        sample_ids = [
            item.sample_id for item in self.added + self.updated + self.removed
        ]
        if len(sample_ids) != len(set(sample_ids)):
            raise ValueError(
                "An archive preview cannot contain the same sample more than once"
            )
        return self


class ArchiveRead(ApiModel):
    dataset_id: int
    revision: int = Field(ge=0)
    last_synced_at: str | None
    manifest_available: bool
    current_count: int = Field(ge=0)
    needs_update_count: int = Field(ge=0)


class SampleRead(ApiModel):
    id: int
    display_id: str
    job_item_id: int
    dataset_id: int
    dataset_name: str
    category: Category
    conflict_direction: ConflictDirection | None
    review_decision: ReviewDecision
    review_revision: int
    current_review: ReviewRead | None
    in_archive: bool
    archive_sync_status: ArchiveSyncStatus
    model: ModelName
    generation_record: GenerationAttemptRead
    actual_content_summary: BilingualSelectionRead
    actual_scene_summary: BilingualSelectionRead
    generation_compatibility: GenerationCompatibility
    gpu_slot: GpuSlotName
    content_script_id: int
    content_script_revision: int
    prompt_template_version_id: int
    source_asset_id: int | None
    source_asset_url: str | None
    primary_asset_id: int
    primary_asset_url: str
    dialogue: str | None
    display_text: str | None
    video_prompt: str
    negative_prompt: str
    true_emotion_description: str
    true_emotion: str
    apparent_emotion: str
    content_script_name_zh: str
    content_script_name_en: str
    scene_zh: str
    scene_en: str
    trigger_event_zh: str
    trigger_event_en: str
    psychological_background_zh: str
    psychological_background_en: str
    age: int
    gender: Gender
    ethnicity: Ethnicity
    seed: int
    revision: int
    created_at: str
    updated_at: str


class ReviewMediaRead(ApiModel):
    url: str
    has_audio: bool


class ReviewSampleListRead(ApiModel):
    id: int
    display_id: str
    dataset_id: int
    dataset_name: str
    category: Category
    protocol: Protocol
    relation: Relation
    conflict_direction: ConflictDirection | None
    review_decision: ReviewDecision
    review_revision: int
    current_review: ReviewRead | None
    in_archive: bool
    archive_sync_status: ArchiveSyncStatus
    generation_compatibility: GenerationCompatibility
    primary_media: ReviewMediaRead
    true_emotion: str
    apparent_emotion: str
    content_script_name_zh: str
    content_script_name_en: str
    gender: Gender
    revision: int
    created_at: str
    updated_at: str


class ReviewSampleDetailRead(ReviewSampleListRead):
    source_media: ReviewMediaRead | None
    dialogue: str | None
    display_text: str | None
    true_emotion_description: str
    scene_zh: str
    scene_en: str
    trigger_event_zh: str
    trigger_event_en: str
    psychological_background_zh: str
    psychological_background_en: str
    age: int
    ethnicity: Ethnicity
    model: ModelName
    precision: Precision | None
    compatible_scene_count: int = Field(ge=0)


class ReviewSampleReferenceRead(ApiModel):
    id: int
    display_id: str
    page: int = Field(ge=1)


class ReviewSubmissionRead(ReviewSampleDetailRead):
    next_reference: ReviewSampleReferenceRead | None


class SampleClassificationChangeRead(ApiModel):
    id: int
    sample_id: int
    operator_id: int
    operator_name: str
    before_protocol: Protocol
    after_protocol: Protocol
    before_relation: Relation
    after_relation: Relation
    before_direction: ConflictDirection | None
    after_direction: ConflictDirection | None
    before_apparent_emotion: str
    after_apparent_emotion: str
    before_true_emotion_description: str
    after_true_emotion_description: str
    before_sample_revision: int
    after_sample_revision: int
    created_at: str


class JobEventPayloadRead(ApiModel):
    prepared_count: int | None = Field(default=None, ge=0)
    completed_count: int | None = Field(default=None, ge=0)
    failed_count: int | None = Field(default=None, ge=0)
    total_count: int | None = Field(default=None, ge=1)
    slot_count: int | None = Field(default=None, ge=1, le=2)
    sequence: int | None = Field(default=None, ge=1)
    gpu_slot: GpuSlotName | None = None
    failure_code: str | None = None
    failure_reason: str | None = None
    failure_details: PromptFailureDetails | None = None
    progress_value: int | None = Field(default=None, ge=0)
    progress_maximum: int | None = Field(default=None, ge=1)


JobEventType = Literal[
    "JobQueued",
    "JobStarted",
    "JobResumed",
    "JobRetryQueued",
    "CancelRequested",
    "ItemPromptStarted",
    "ItemPromptReady",
    "ItemRenderStarted",
    "ItemRenderMissing",
    "ItemRenderProgress",
    "ItemMediaProcessing",
    "ItemCompleted",
    "ItemFailed",
    "ItemCancelled",
    "JobInterrupted",
    "JobCompleted",
    "JobFailed",
    "JobCancelled",
]


class JobEventRead(ApiModel):
    id: int
    job_id: int
    item_id: int | None
    event_type: JobEventType
    payload: JobEventPayloadRead
    created_at: str


class JobProfileRead(ApiModel):
    model: ModelName
    precision: Precision | None


class JobSummaryRead(ApiModel):
    id: int
    display_name: str
    source: JobSource
    dataset_id: int | None
    dataset_name_snapshot: str | None
    batch_draft_id: int | None
    category: Category
    conflict_direction: ConflictDirection | None
    model: ModelName | None
    precision: Precision | None
    profiles: list[JobProfileRead]
    status: JobStatus
    total_count: int
    prepared_count: int
    completed_count: int
    failed_count: int
    confirm_model_switch: bool
    cancel_requested_at: str | None
    failure_code: str | None
    failure_reason: str | None
    started_at: str | None
    finished_at: str | None
    revision: int
    created_at: str
    updated_at: str


class JobDetailRead(JobSummaryRead):
    pass


class HealthRead(ApiModel):
    ok: bool
    database: str
    prompt_service_configured: bool
    renderer_installation: Literal[
        "installed", "notInstalled", "unknown", "notConfigured"
    ]
