from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import CheckConstraint, Column, Enum as SqlEnum, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlmodel import Field, SQLModel

from .enums import (
    AGES,
    BatchDraftStatus,
    Category,
    ConflictDirection,
    ContentMode,
    ContentStatus,
    DatasetPurpose,
    Ethnicity,
    ExampleKind,
    Gender,
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobSource,
    JobStatus,
    ModelName,
    ResourceStatus,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def enum_column(
    enum_type: type[Any],
    *,
    nullable: bool = False,
    primary_key: bool = False,
    foreign_key: str | None = None,
    ondelete: str | None = None,
) -> Column[Any]:
    column_args: list[Any] = [
        SqlEnum(
            enum_type,
            values_callable=lambda members: [member.value for member in members],
            native_enum=False,
            validate_strings=True,
            create_constraint=True,
        )
    ]
    if foreign_key is not None:
        column_args.append(ForeignKey(foreign_key, ondelete=ondelete))
    return Column(
        *column_args,
        nullable=nullable,
        primary_key=primary_key,
    )


CATEGORY_DIRECTION_CHECK = """
(
  category IN ('A-VA', 'A-VT') AND conflict_direction IS NULL
) OR (
  category = 'C-VA' AND conflict_direction IN ('Vision', 'Audio')
) OR (
  category = 'C-VT' AND conflict_direction IN ('Vision', 'Text')
)
"""


class Dataset(SQLModel, table=True):
    __tablename__ = "datasets"
    __table_args__ = (
        UniqueConstraint("name_key", name="uq_datasets_name_key"),
        CheckConstraint("revision >= 1", name="ck_datasets_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(sa_column=Column(String(160), nullable=False))
    name_key: str = Field(sa_column=Column(String(160), nullable=False))
    purpose: DatasetPurpose = Field(sa_column=enum_column(DatasetPurpose))
    note: str = Field(default="", sa_column=Column(Text, nullable=False))
    status: ResourceStatus = Field(default=ResourceStatus.ACTIVE, sa_column=enum_column(ResourceStatus))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class ContentPlan(SQLModel, table=True):
    __tablename__ = "content_plans"
    __table_args__ = (
        UniqueConstraint("category", "name_key", name="uq_content_plans_category_name"),
        CheckConstraint(CATEGORY_DIRECTION_CHECK, name="ck_content_plans_direction"),
        CheckConstraint(
            "(mode = 'Fixed' AND length(trim(base_video_prompt)) > 0) OR "
            "(mode = 'Generative' AND length(trim(content_instruction)) > 0)",
            name="ck_content_plans_mode_input",
        ),
        CheckConstraint("revision >= 1", name="ck_content_plans_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(sa_column=Column(String(160), nullable=False))
    name_key: str = Field(sa_column=Column(String(160), nullable=False))
    category: Category = Field(sa_column=enum_column(Category))
    conflict_direction: ConflictDirection | None = Field(default=None, sa_column=enum_column(ConflictDirection, nullable=True))
    mode: ContentMode = Field(sa_column=enum_column(ContentMode))
    status: ContentStatus = Field(default=ContentStatus.DRAFT, sa_column=enum_column(ContentStatus))
    true_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    apparent_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    scene: str = Field(sa_column=Column(Text, nullable=False))
    trigger_event: str = Field(sa_column=Column(Text, nullable=False))
    psychological_background: str = Field(sa_column=Column(Text, nullable=False))
    dialogue: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    display_text: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    true_emotion_description: str = Field(sa_column=Column(Text, nullable=False))
    base_video_prompt: str = Field(default="", sa_column=Column(Text, nullable=False))
    content_instruction: str = Field(default="", sa_column=Column(Text, nullable=False))
    scene_supplement: str = Field(default="", sa_column=Column(Text, nullable=False))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class PromptPreset(SQLModel, table=True):
    __tablename__ = "prompt_presets"
    __table_args__ = (
        UniqueConstraint("category", "name_key", name="uq_prompt_presets_category_name"),
        CheckConstraint("revision >= 1", name="ck_prompt_presets_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(sa_column=Column(String(160), nullable=False))
    name_key: str = Field(sa_column=Column(String(160), nullable=False))
    category: Category = Field(sa_column=enum_column(Category))
    style_instruction: str = Field(default="", sa_column=Column(Text, nullable=False))
    scene_supplement: str = Field(default="", sa_column=Column(Text, nullable=False))
    final_negative_prompt: str = Field(sa_column=Column(Text, nullable=False))
    status: ResourceStatus = Field(default=ResourceStatus.ACTIVE, sa_column=enum_column(ResourceStatus))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class PromptExample(SQLModel, table=True):
    __tablename__ = "prompt_examples"
    __table_args__ = (
        UniqueConstraint("preset_id", "kind", "position", name="uq_prompt_examples_position"),
        CheckConstraint("position >= 0", name="ck_prompt_examples_position"),
    )

    id: int | None = Field(default=None, primary_key=True)
    preset_id: int = Field(sa_column=Column(Integer, ForeignKey("prompt_presets.id", ondelete="CASCADE"), nullable=False))
    kind: ExampleKind = Field(sa_column=enum_column(ExampleKind))
    position: int = Field(ge=0)
    text: str = Field(sa_column=Column(Text, nullable=False))


class VideoBackgroundPreset(SQLModel, table=True):
    __tablename__ = "video_background_presets"
    __table_args__ = (
        UniqueConstraint("name_key", name="uq_video_background_presets_name"),
        CheckConstraint("revision >= 1", name="ck_background_presets_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(sa_column=Column(String(160), nullable=False))
    name_key: str = Field(sa_column=Column(String(160), nullable=False))
    scene: str = Field(sa_column=Column(Text, nullable=False))
    ambient_audio: str = Field(default="", sa_column=Column(Text, nullable=False))
    relationship: str = Field(default="", sa_column=Column(Text, nullable=False))
    lighting: str = Field(default="", sa_column=Column(Text, nullable=False))
    framing_supplement: str = Field(default="", sa_column=Column(Text, nullable=False))
    status: ResourceStatus = Field(default=ResourceStatus.ACTIVE, sa_column=enum_column(ResourceStatus))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class BatchDraft(SQLModel, table=True):
    __tablename__ = "batch_drafts"
    __table_args__ = (
        CheckConstraint(CATEGORY_DIRECTION_CHECK, name="ck_batch_drafts_direction"),
        CheckConstraint("quantity > 0", name="ck_batch_drafts_quantity"),
        CheckConstraint("seed_base >= 0 AND seed_base < 2147483648", name="ck_batch_drafts_seed"),
        CheckConstraint("dataset_revision >= 1", name="ck_batch_drafts_dataset_revision"),
        CheckConstraint("revision >= 1", name="ck_batch_drafts_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    dataset_id: int = Field(sa_column=Column(Integer, ForeignKey("datasets.id", ondelete="RESTRICT"), nullable=False))
    dataset_revision: int = Field(ge=1)
    category: Category = Field(sa_column=enum_column(Category))
    conflict_direction: ConflictDirection | None = Field(default=None, sa_column=enum_column(ConflictDirection, nullable=True))
    model: ModelName = Field(sa_column=enum_column(ModelName))
    quantity: int = Field(gt=0)
    seed_base: int = Field(ge=0, lt=2**31)
    status: BatchDraftStatus = Field(default=BatchDraftStatus.DRAFT, sa_column=enum_column(BatchDraftStatus))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class BatchDraftContentPlan(SQLModel, table=True):
    __tablename__ = "batch_draft_content_plans"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", "position", name="uq_batch_content_position"),
        CheckConstraint("position >= 0", name="ck_batch_content_position"),
        CheckConstraint("source_revision >= 1", name="ck_batch_content_revision"),
    )

    batch_draft_id: int = Field(sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="CASCADE"), primary_key=True))
    content_plan_id: int = Field(sa_column=Column(Integer, ForeignKey("content_plans.id", ondelete="RESTRICT"), primary_key=True))
    position: int = Field(ge=0)
    source_revision: int = Field(ge=1)


class BatchDraftPromptPreset(SQLModel, table=True):
    __tablename__ = "batch_draft_prompt_presets"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", "position", name="uq_batch_preset_position"),
        CheckConstraint("position >= 0", name="ck_batch_preset_position"),
        CheckConstraint("source_revision >= 1", name="ck_batch_preset_revision"),
    )

    batch_draft_id: int = Field(sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="CASCADE"), primary_key=True))
    prompt_preset_id: int = Field(sa_column=Column(Integer, ForeignKey("prompt_presets.id", ondelete="RESTRICT"), primary_key=True))
    position: int = Field(ge=0)
    source_revision: int = Field(ge=1)


class BatchDraftBackgroundPreset(SQLModel, table=True):
    __tablename__ = "batch_draft_background_presets"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", "position", name="uq_batch_background_position"),
        CheckConstraint("position >= 0", name="ck_batch_background_position"),
        CheckConstraint("source_revision >= 1", name="ck_batch_background_revision"),
    )

    batch_draft_id: int = Field(sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="CASCADE"), primary_key=True))
    background_preset_id: int = Field(sa_column=Column(Integer, ForeignKey("video_background_presets.id", ondelete="RESTRICT"), primary_key=True))
    position: int = Field(ge=0)
    source_revision: int = Field(ge=1)


class BatchDraftDemographic(SQLModel, table=True):
    __tablename__ = "batch_draft_demographics"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", "position", name="uq_batch_demographic_position"),
        CheckConstraint(f"age IN {AGES}", name="ck_batch_demographics_age"),
        CheckConstraint("position >= 0", name="ck_batch_demographics_position"),
    )

    id: int | None = Field(default=None, primary_key=True)
    batch_draft_id: int = Field(sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="CASCADE"), nullable=False))
    position: int = Field(ge=0)
    age: int
    gender: Gender = Field(sa_column=enum_column(Gender))
    ethnicity: Ethnicity = Field(sa_column=enum_column(Ethnicity))


class BatchDraftGpuSlot(SQLModel, table=True):
    __tablename__ = "batch_draft_gpu_slots"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", "position", name="uq_batch_gpu_position"),
        CheckConstraint("position >= 0", name="ck_batch_gpu_position"),
    )

    batch_draft_id: int = Field(sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="CASCADE"), primary_key=True))
    gpu_slot: GpuSlotName = Field(
        sa_column=enum_column(
            GpuSlotName,
            primary_key=True,
            foreign_key="gpu_slots.slot",
            ondelete="RESTRICT",
        )
    )
    position: int = Field(ge=0)


class BatchVideoInputSnapshot(SQLModel, table=True):
    __tablename__ = "batch_video_input_snapshots"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", "sequence", name="uq_batch_snapshots_sequence"),
        CheckConstraint(CATEGORY_DIRECTION_CHECK, name="ck_batch_snapshots_direction"),
        CheckConstraint(f"age IN {AGES}", name="ck_batch_snapshots_age"),
        CheckConstraint("seed >= 0 AND seed < 2147483648", name="ck_batch_snapshots_seed"),
        CheckConstraint("sequence > 0", name="ck_batch_snapshots_sequence"),
        CheckConstraint("content_plan_revision >= 1", name="ck_batch_snapshots_content_revision"),
        CheckConstraint("prompt_preset_revision >= 1", name="ck_batch_snapshots_preset_revision"),
        CheckConstraint("background_preset_revision >= 1", name="ck_batch_snapshots_background_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    batch_draft_id: int = Field(sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="RESTRICT"), nullable=False))
    sequence: int = Field(gt=0)
    content_plan_id: int = Field(sa_column=Column(Integer, ForeignKey("content_plans.id", ondelete="RESTRICT"), nullable=False))
    content_plan_revision: int = Field(ge=1)
    prompt_preset_id: int = Field(sa_column=Column(Integer, ForeignKey("prompt_presets.id", ondelete="RESTRICT"), nullable=False))
    prompt_preset_revision: int = Field(ge=1)
    background_preset_id: int = Field(sa_column=Column(Integer, ForeignKey("video_background_presets.id", ondelete="RESTRICT"), nullable=False))
    background_preset_revision: int = Field(ge=1)
    policy_version: str = Field(sa_column=Column(String(40), nullable=False))
    category: Category = Field(sa_column=enum_column(Category))
    conflict_direction: ConflictDirection | None = Field(default=None, sa_column=enum_column(ConflictDirection, nullable=True))
    age: int
    gender: Gender = Field(sa_column=enum_column(Gender))
    ethnicity: Ethnicity = Field(sa_column=enum_column(Ethnicity))
    model: ModelName = Field(sa_column=enum_column(ModelName))
    seed: int = Field(ge=0, lt=2**31)
    system_input: str = Field(sa_column=Column(Text, nullable=False))
    user_input: str = Field(sa_column=Column(Text, nullable=False))
    raw_structured_response: str = Field(sa_column=Column(Text, nullable=False))
    final_positive_prompt: str = Field(sa_column=Column(Text, nullable=False))
    final_negative_prompt: str = Field(sa_column=Column(Text, nullable=False))
    dialogue: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    vt_text: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    true_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    apparent_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    true_emotion_description: str = Field(sa_column=Column(Text, nullable=False))
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class Job(SQLModel, table=True):
    __tablename__ = "jobs"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", name="uq_jobs_batch_draft"),
        CheckConstraint(CATEGORY_DIRECTION_CHECK, name="ck_jobs_direction"),
        CheckConstraint(
            "total_count > 0 AND completed_count >= 0 AND failed_count >= 0 "
            "AND completed_count + failed_count <= total_count",
            name="ck_jobs_counts",
        ),
        CheckConstraint("revision >= 1", name="ck_jobs_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    display_name: str = Field(sa_column=Column(String(80), nullable=False))
    source: JobSource = Field(default=JobSource.PRODUCTION, sa_column=enum_column(JobSource))
    dataset_id: int = Field(sa_column=Column(Integer, ForeignKey("datasets.id", ondelete="RESTRICT"), nullable=False))
    batch_draft_id: int = Field(sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="RESTRICT"), nullable=False))
    category: Category = Field(sa_column=enum_column(Category))
    conflict_direction: ConflictDirection | None = Field(default=None, sa_column=enum_column(ConflictDirection, nullable=True))
    model: ModelName = Field(sa_column=enum_column(ModelName))
    status: JobStatus = Field(default=JobStatus.QUEUED, sa_column=enum_column(JobStatus))
    total_count: int = Field(gt=0)
    completed_count: int = Field(default=0, ge=0)
    failed_count: int = Field(default=0, ge=0)
    failure_reason: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class JobItem(SQLModel, table=True):
    __tablename__ = "job_items"
    __table_args__ = (
        UniqueConstraint("job_id", "sequence", name="uq_job_items_sequence"),
        UniqueConstraint("input_snapshot_id", name="uq_job_items_snapshot"),
        CheckConstraint("sequence > 0", name="ck_job_items_sequence"),
        CheckConstraint("revision >= 1", name="ck_job_items_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    job_id: int = Field(sa_column=Column(Integer, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False))
    sequence: int = Field(gt=0)
    input_snapshot_id: int = Field(sa_column=Column(Integer, ForeignKey("batch_video_input_snapshots.id", ondelete="RESTRICT"), nullable=False))
    gpu_slot: GpuSlotName = Field(
        sa_column=enum_column(
            GpuSlotName,
            foreign_key="gpu_slots.slot",
            ondelete="RESTRICT",
        )
    )
    stage: JobItemStage = Field(default=JobItemStage.PROMPT_READY, sa_column=enum_column(JobItemStage))
    status: JobStatus = Field(default=JobStatus.QUEUED, sa_column=enum_column(JobStatus))
    failure_reason: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class GpuSlot(SQLModel, table=True):
    __tablename__ = "gpu_slots"
    __table_args__ = (CheckConstraint("revision >= 1", name="ck_gpu_slots_revision"),)

    slot: GpuSlotName = Field(sa_column=enum_column(GpuSlotName, primary_key=True))
    availability: GpuAvailability = Field(default=GpuAvailability.UNKNOWN, sa_column=enum_column(GpuAvailability))
    loaded_model: ModelName | None = Field(default=None, sa_column=enum_column(ModelName, nullable=True))
    active_job_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("jobs.id", ondelete="RESTRICT"), nullable=True),
    )
    revision: int = Field(default=1, ge=1)
    checked_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
