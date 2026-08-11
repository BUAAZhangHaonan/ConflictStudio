from __future__ import annotations

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
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobSource,
    JobStatus,
    ModelName,
    ResourceStatus,
    validate_direction,
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


class DatasetCreate(ApiModel):
    name: Name
    purpose: DatasetPurpose
    note: str = ""


class DatasetUpdate(UpdateWithChanges):
    name: Name | None = None
    purpose: DatasetPurpose | None = None
    note: str | None = None
    status: ResourceStatus | None = None

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
    name: Name
    category: Category
    conflict_direction: ConflictDirection | None = None
    mode: ContentMode
    status: ContentStatus = ContentStatus.DRAFT
    true_emotion: EmotionValue
    apparent_emotion: EmotionValue
    scene: TextValue
    trigger_event: TextValue
    psychological_background: TextValue
    dialogue: str | None = None
    display_text: str | None = None
    true_emotion_description: str = ""
    base_video_prompt: str = ""
    content_instruction: str = ""
    scene_supplement: str = ""

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
        if self.mode is ContentMode.GENERATIVE and not self.content_instruction.strip():
            raise ValueError("Generative content requires a content instruction")
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
    name: Name | None = None
    conflict_direction: ConflictDirection | None = None
    mode: ContentMode | None = None
    status: ContentStatus | None = None
    true_emotion: EmotionValue | None = None
    apparent_emotion: EmotionValue | None = None
    scene: TextValue | None = None
    trigger_event: TextValue | None = None
    psychological_background: TextValue | None = None
    dialogue: str | None = None
    display_text: str | None = None
    true_emotion_description: str | None = None
    base_video_prompt: str | None = None
    content_instruction: str | None = None
    scene_supplement: str | None = None


class ContentPlanRead(ContentPlanFields):
    id: int
    revision: int
    created_at: str
    updated_at: str


class PromptPresetFields(ApiModel):
    name: Name
    category: Category
    style_instruction: str = ""
    scene_supplement: str = ""
    positive_examples: list[TextValue] = Field(default_factory=list)
    negative_examples: list[TextValue] = Field(default_factory=list)
    final_negative_prompt: TextValue
    status: ResourceStatus = ResourceStatus.ACTIVE


class PromptPresetCreate(PromptPresetFields):
    pass


class PromptPresetUpdate(UpdateWithChanges):
    name: Name | None = None
    style_instruction: str | None = None
    scene_supplement: str | None = None
    positive_examples: list[TextValue] | None = None
    negative_examples: list[TextValue] | None = None
    final_negative_prompt: TextValue | None = None
    status: ResourceStatus | None = None


class PromptPresetRead(PromptPresetFields):
    id: int
    revision: int
    created_at: str
    updated_at: str


class VideoBackgroundPresetFields(ApiModel):
    name: Name
    scene: TextValue
    ambient_audio: str = ""
    relationship: str = ""
    lighting: str = ""
    framing_supplement: str = ""
    status: ResourceStatus = ResourceStatus.ACTIVE

    @field_validator("scene", "ambient_audio", "relationship", "lighting", "framing_supplement")
    @classmethod
    def validate_background_text(cls, value: str, info: ValidationInfo) -> str:
        return validate_background_policy_text(value, info.field_name)


class VideoBackgroundPresetCreate(VideoBackgroundPresetFields):
    pass


class VideoBackgroundPresetUpdate(UpdateWithChanges):
    name: Name | None = None
    scene: TextValue | None = None
    ambient_audio: str | None = None
    relationship: str | None = None
    lighting: str | None = None
    framing_supplement: str | None = None
    status: ResourceStatus | None = None

    @field_validator("scene", "ambient_audio", "relationship", "lighting", "framing_supplement")
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
    model: ModelName
    quantity: int = Field(gt=0, le=10000)
    seed: int | None = Field(default=None, ge=0, lt=2**31)
    content_plans: list[SourceSelection] = Field(min_length=1)
    prompt_presets: list[SourceSelection] = Field(min_length=1)
    background_presets: list[SourceSelection] = Field(min_length=1)
    demographics: list[DemographicInput] = Field(min_length=1)
    gpu_slots: list[GpuSlotName] = Field(min_length=1, max_length=2)

    @model_validator(mode="after")
    def validate_batch(self) -> Self:
        if not validate_direction(self.category, self.conflict_direction):
            raise ValueError("Conflict direction does not match the category")
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


class BatchDraftRead(ApiModel):
    id: int
    dataset_id: int
    dataset_revision: int
    category: Category
    conflict_direction: ConflictDirection | None
    model: ModelName
    quantity: int
    seed: int
    status: BatchDraftStatus
    content_plans: list[SelectionRead]
    prompt_presets: list[SelectionRead]
    background_presets: list[SelectionRead]
    demographics: list[DemographicInput]
    gpu_slots: list[GpuSlotName]
    revision: int
    created_at: str
    updated_at: str


class BatchPreviewRequest(ExpectedRevision):
    pass


class BatchSubmitRequest(ExpectedRevision):
    expected_gpu_revisions: dict[GpuSlotName, int]
    confirm_model_switch: bool = False


class JobCancelRequest(ExpectedRevision):
    pass


class BatchAllocationRead(ApiModel):
    sequence: int
    content_plan: SelectionRead
    prompt_preset: SelectionRead
    background_preset: SelectionRead
    demographic: DemographicInput
    gpu_slot: GpuSlotName
    model: ModelName
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


class SnapshotRead(ApiModel):
    id: int
    sequence: int
    dataset_id: int
    dataset_revision: int
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


class JobItemRead(ApiModel):
    id: int
    sequence: int
    gpu_slot: GpuSlotName
    stage: JobItemStage
    status: JobStatus
    failure_code: str | None
    failure_reason: str | None
    renderer_prompt_id: str | None
    revision: int
    created_at: str
    updated_at: str
    input: SnapshotRead
    prompt_result: JobItemPromptResultRead | None


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


JobEventType = Literal[
    "JobQueued",
    "JobStarted",
    "CancelRequested",
    "ItemPromptStarted",
    "ItemPromptReady",
    "ItemRenderStarted",
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
    dataset_id: int
    batch_draft_id: int
    category: Category
    conflict_direction: ConflictDirection | None
    model: ModelName
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
