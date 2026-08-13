from __future__ import annotations

import re
from typing import Annotated, Any, Literal, Self

from pydantic import BeforeValidator, BaseModel, ConfigDict, Field, StringConstraints, ValidationInfo, field_validator, model_validator

from .enums import (
    AGES,
    BatchDraftStatus,
    Category,
    ConflictDirection,
    ContentMode,
    ContentStatus,
    DatasetPurpose,
    Ethnicity,
    Gender,
    GenerationAttemptStatus,
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobSource,
    JobStatus,
    ModelName,
    Precision,
    ReviewDecision,
    ResourceStatus,
    TestExecutionMode,
    validate_direction,
    validate_model_precision,
)
from .prompt_policy import validate_background_policy_text


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


Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
TextValue = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
OptionalTextValue = Annotated[str, StringConstraints(strip_whitespace=True)]
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def validate_english_video_prompt(value: str, field_name: str) -> str:
    if _CJK_RE.search(value):
        raise ValueError(f"{field_name} must use English")
    return value


def normalize_emotion(value: object) -> object:
    if isinstance(value, str):
        return value.strip().casefold()
    return value


EmotionValue = Annotated[
    str,
    BeforeValidator(normalize_emotion),
    StringConstraints(min_length=1, max_length=120),
]


class ErrorValue(ApiModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(ApiModel):
    error: ErrorValue


class ExpectedRevision(ApiModel):
    expected_revision: int = Field(ge=1)


class UpdateWithChanges(ExpectedRevision):
    @model_validator(mode="after")
    def require_change(self) -> Self:
        if not self.model_fields_set.difference({"expected_revision"}):
            raise ValueError("At least one field must be provided")
        return self

    def reject_explicit_nulls(self, nullable_fields: frozenset[str] = frozenset()) -> Self:
        null_fields = {
            field_name
            for field_name in self.model_fields_set.difference(nullable_fields)
            if field_name != "expected_revision" and getattr(self, field_name) is None
        }
        if null_fields:
            fields = ", ".join(sorted(to_camel(field_name) for field_name in null_fields))
            raise ValueError(f"Fields cannot be null: {fields}")
        return self


class DatasetCreate(ApiModel):
    name: Name
    purpose: DatasetPurpose
    note: str = ""


class DatasetUpdate(UpdateWithChanges):
    name: Name | None = None
    purpose: DatasetPurpose | None = None
    note: str | None = None
    status: ResourceStatus | None = None

    @model_validator(mode="after")
    def reject_null_fields(self) -> Self:
        return self.reject_explicit_nulls()


class DatasetRead(ApiModel):
    id: int
    name: str
    purpose: DatasetPurpose
    note: str
    status: ResourceStatus
    revision: int
    created_at: str
    updated_at: str


class ContentPlanFields(ApiModel):
    name_zh: Name
    name_en: Name
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
        if self.category in {Category.A_VA, Category.A_VT} and self.true_emotion != self.apparent_emotion:
            raise ValueError("Aligned content requires true emotion to equal apparent emotion")
        if self.category in {Category.C_VA, Category.C_VT} and self.true_emotion == self.apparent_emotion:
            raise ValueError("Conflict content requires true emotion to differ from apparent emotion")
        if self.mode is ContentMode.FIXED and not self.base_video_prompt.strip():
            raise ValueError("Fixed content requires a base video prompt")
        if self.mode is ContentMode.GENERATIVE and (
            not self.content_requirements_zh or not self.content_requirements_en
        ):
            raise ValueError("Generative content requires Chinese and English content requirements")
        if self.category in {Category.A_VA, Category.C_VA} and self.mode is ContentMode.FIXED:
            if not (self.dialogue or "").strip():
                raise ValueError("Fixed VA content requires dialogue")
        if self.category in {Category.A_VT, Category.C_VT} and self.mode is ContentMode.FIXED:
            if not (self.display_text or "").strip():
                raise ValueError("Fixed VT content requires display text")
        if self.mode is ContentMode.FIXED and not self.true_emotion_description.strip():
            raise ValueError("Fixed content requires a true emotion description")
        return self


class ContentPlanCreate(ContentPlanFields):
    pass


class ContentPlanUpdate(UpdateWithChanges):
    name_zh: Name | None = None
    name_en: Name | None = None
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
        return self.reject_explicit_nulls(frozenset({"conflict_direction", "dialogue", "display_text"}))

    @field_validator("base_video_prompt")
    @classmethod
    def validate_base_video_prompt(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_english_video_prompt(value, "baseVideoPrompt")


class ContentPlanRead(ContentPlanFields):
    id: int
    revision: int
    created_at: str
    updated_at: str


class PromptPresetFields(ApiModel):
    name: Name
    category: Category
    style_instruction: str = Field(default="", alias="styleGuidance")
    scene_supplement: str = ""
    positive_examples: list[TextValue] = Field(default_factory=list)
    negative_examples: list[TextValue] = Field(default_factory=list)
    final_negative_prompt: TextValue = Field(alias="finalRenderNegativeConstraints")
    status: ResourceStatus = ResourceStatus.ACTIVE

    @field_validator("final_negative_prompt")
    @classmethod
    def validate_final_negative_prompt(cls, value: str) -> str:
        return validate_english_video_prompt(value, "finalRenderNegativeConstraints")


class PromptPresetCreate(PromptPresetFields):
    pass


class PromptPresetUpdate(UpdateWithChanges):
    name: Name | None = None
    style_instruction: str | None = Field(default=None, alias="styleGuidance")
    scene_supplement: str | None = None
    positive_examples: list[TextValue] | None = None
    negative_examples: list[TextValue] | None = None
    final_negative_prompt: TextValue | None = Field(default=None, alias="finalRenderNegativeConstraints")
    status: ResourceStatus | None = None

    @model_validator(mode="after")
    def reject_null_fields(self) -> Self:
        return self.reject_explicit_nulls()

    @field_validator("final_negative_prompt")
    @classmethod
    def validate_final_negative_prompt(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_english_video_prompt(value, "finalRenderNegativeConstraints")


class PromptPresetRead(PromptPresetFields):
    id: int
    revision: int
    created_at: str
    updated_at: str


class VideoBackgroundPresetFields(ApiModel):
    name_zh: Name
    name_en: Name
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

    @field_validator("scene_en", "ambient_sound_en", "participant_relationship_en", "lighting_en", "framing_en")
    @classmethod
    def validate_background_text(cls, value: str, info: ValidationInfo) -> str:
        return validate_background_policy_text(value, info.field_name)


class VideoBackgroundPresetCreate(VideoBackgroundPresetFields):
    pass


class VideoBackgroundPresetUpdate(UpdateWithChanges):
    name_zh: Name | None = None
    name_en: Name | None = None
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

    @field_validator("scene_en", "ambient_sound_en", "participant_relationship_en", "lighting_en", "framing_en")
    @classmethod
    def validate_background_text(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None:
            return None
        return validate_background_policy_text(value, info.field_name)


class VideoBackgroundPresetRead(VideoBackgroundPresetFields):
    id: int
    revision: int
    created_at: str
    updated_at: str


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


class BatchDraftFields(ApiModel):
    dataset_id: int = Field(gt=0)
    category: Category
    conflict_direction: ConflictDirection | None = None
    model: ModelName = ModelName.LTX_25
    precision: Precision | None = Precision.INT8
    quantity: int = Field(gt=0, le=10000)
    seed: int | None = Field(default=None, ge=0, lt=2**31)
    content_plans: list[SourceSelection] = Field(min_length=1)
    prompt_presets: list[SourceSelection] = Field(min_length=1)
    background_presets: list[SourceSelection] = Field(min_length=1)
    demographics: list[DemographicInput] = Field(min_length=1)
    gpu_slots: list[GpuSlotName] = Field(min_length=1, max_length=2)

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
            raise ValueError("LTX-2.5 requires BF16 or INT8 precision; older models require null precision")
        for values, label in (
            (self.content_plans, "content plan"),
            (self.prompt_presets, "prompt preset"),
            (self.background_presets, "background preset"),
        ):
            identifiers = [value.id for value in values]
            if len(identifiers) != len(set(identifiers)):
                raise ValueError(f"Duplicate {label} selection")
        if len(self.gpu_slots) != len(set(self.gpu_slots)):
            raise ValueError("Duplicate GPU selection")
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


class BatchDraftRead(ApiModel):
    id: int
    dataset_id: int
    dataset_revision: int
    category: Category
    conflict_direction: ConflictDirection | None
    model: ModelName
    precision: Precision | None
    quantity: int
    seed: int
    status: BatchDraftStatus
    content_plans: list[BilingualSelectionRead]
    prompt_presets: list[SelectionRead]
    background_presets: list[BilingualSelectionRead]
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


class BatchAllocationRead(ApiModel):
    sequence: int
    content_plan: BilingualSelectionRead
    prompt_preset: SelectionRead
    background_preset: BilingualSelectionRead
    demographic: DemographicInput
    gpu_slot: GpuSlotName
    model: ModelName
    precision: Precision | None
    seed: int
    requires_prompt_generation: bool
    system_input: str
    user_input: str
    final_positive_prompt: str | None
    final_negative_prompt: str


class BatchPreviewRead(ApiModel):
    batch_draft_id: int
    expected_revision: int
    gpu_revisions: dict[GpuSlotName, int]
    allocations: list[BatchAllocationRead]


class PromptPreviewRequest(ApiModel):
    content_plan: SourceSelection
    prompt_preset: SourceSelection
    background_preset: SourceSelection
    demographic: DemographicInput


class PromptPreviewRead(ApiModel):
    content_plan: BilingualSelectionRead
    prompt_preset: SelectionRead
    background_preset: BilingualSelectionRead
    category: Category
    conflict_direction: ConflictDirection | None
    demographic: DemographicInput
    requires_prompt_generation: bool
    system_input: str
    user_input: str
    final_positive_prompt: str | None
    final_negative_prompt: str


class TestComparisonInput(ApiModel):
    model: ModelName
    precision: Precision | None = None
    gpu_slot: GpuSlotName

    @model_validator(mode="after")
    def validate_profile(self) -> Self:
        if not validate_model_precision(self.model, self.precision):
            raise ValueError("Model and precision do not match")
        return self


class TestRunCreate(ApiModel):
    content_plan: SourceSelection
    prompt_preset: SourceSelection
    background_preset: SourceSelection
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
    content_plan_id: int
    content_plan_revision: int
    prompt_preset_id: int
    prompt_preset_revision: int
    background_preset_id: int
    background_preset_revision: int
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
    final_negative_prompt: str
    fixed_positive_prompt: str | None
    fixed_dialogue: str | None
    fixed_vt_text: str | None
    fixed_true_emotion_description: str | None
    true_emotion: str
    apparent_emotion: str
    created_at: str


class JobItemPromptResultRead(ApiModel):
    id: int
    job_item_id: int
    policy_version: str
    system_input: str
    user_input: str
    raw_structured_response: str
    final_positive_prompt: str
    final_negative_prompt: str
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
    gpu_slot: GpuSlotName
    stage: JobItemStage
    status: JobStatus
    failure_code: str | None
    failure_reason: str | None
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
    attempts: list[GenerationAttemptRead] = Field(default_factory=list)
    sample_id: int | None = None


class KeepTestResultRequest(ExpectedRevision):
    dataset_id: int = Field(gt=0)


class SampleReviewUpdate(ExpectedRevision):
    decision: ReviewDecision


class SampleRead(ApiModel):
    id: int
    display_id: str
    job_item_id: int
    dataset_id: int
    category: Category
    conflict_direction: ConflictDirection | None
    review_decision: ReviewDecision
    review_revision: int
    model: ModelName
    precision: Precision | None
    gpu_slot: GpuSlotName
    content_plan_id: int
    content_plan_revision: int
    prompt_preset_id: int
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
    content_plan_name_zh: str
    content_plan_name_en: str
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
    progress_value: int | None = Field(default=None, ge=0)
    progress_maximum: int | None = Field(default=None, ge=1)


JobEventType = Literal[
    "JobQueued",
    "JobStarted",
    "CancelRequested",
    "ItemPromptStarted",
    "ItemPromptReady",
    "ItemRenderStarted",
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


class JobSummaryRead(ApiModel):
    id: int
    display_name: str
    source: JobSource
    dataset_id: int | None
    batch_draft_id: int | None
    category: Category
    conflict_direction: ConflictDirection | None
    model: ModelName | None
    precision: Precision | None
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
    items: list[JobItemRead]
    events: list[JobEventRead] = Field(default_factory=list)


class GpuSlotRead(ApiModel):
    slot: GpuSlotName
    availability: GpuAvailability
    loaded_model: ModelName | None
    active_job_id: int | None
    revision: int
    checked_at: str


class HealthRead(ApiModel):
    ok: bool
    database: str
    prompt_service_configured: bool
    renderer_installation: Literal["installed", "notInstalled", "unknown", "notConfigured"]
