from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Column,
    Enum as SqlEnum,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
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
    GenerationAttemptStatus,
    GpuAvailability,
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

CONTENT_EMOTION_CHECK = """
(
  category IN ('A-VA', 'A-VT') AND lower(trim(true_emotion)) = lower(trim(apparent_emotion))
) OR (
  category IN ('C-VA', 'C-VT') AND lower(trim(true_emotion)) <> lower(trim(apparent_emotion))
)
"""

MODEL_PRECISION_CHECK = """
(
  model = 'LTX-2.5' AND precision IS NOT NULL AND precision IN ('BF16', 'INT8')
) OR (
  model IN ('LTX-2.3', 'MiniMax H3') AND precision IS NULL
)
"""

JOB_SOURCE_CHECK = """
(
  source = 'Production'
  AND dataset_id IS NOT NULL
  AND batch_draft_id IS NOT NULL
  AND model IS NOT NULL
) OR (
  source = 'Test'
  AND dataset_id IS NULL
  AND batch_draft_id IS NULL
  AND model IS NULL
)
"""

JOB_MODEL_PRECISION_CHECK = f"""
(model IS NULL AND precision IS NULL) OR ({MODEL_PRECISION_CHECK})
"""

SNAPSHOT_SOURCE_CHECK = """
(
  batch_draft_id IS NOT NULL
  AND dataset_id IS NOT NULL
  AND dataset_revision IS NOT NULL
) OR (
  batch_draft_id IS NULL
  AND dataset_id IS NULL
  AND dataset_revision IS NULL
)
"""

LOADED_MODEL_PRECISION_CHECK = """
(
  loaded_model IS NULL AND loaded_precision IS NULL
) OR (
  loaded_model = 'LTX-2.5' AND loaded_precision IS NOT NULL
  AND loaded_precision IN ('BF16', 'INT8')
) OR (
  loaded_model IN ('LTX-2.3', 'MiniMax H3') AND loaded_precision IS NULL
)
"""

RENDERER_PROFILE_VERSION = "2026-08-12.1"
VIDEO_WIDTH = 1344
VIDEO_HEIGHT = 768
VIDEO_FPS = 24


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
        UniqueConstraint("category", "name_zh_key", name="uq_content_plans_category_name_zh"),
        UniqueConstraint("category", "name_en_key", name="uq_content_plans_category_name_en"),
        CheckConstraint(CATEGORY_DIRECTION_CHECK, name="ck_content_plans_direction"),
        CheckConstraint(CONTENT_EMOTION_CHECK, name="ck_content_plans_emotion_relation"),
        CheckConstraint(
            "(mode = 'Fixed' AND length(trim(base_video_prompt)) > 0) OR "
            "(mode = 'Generative' AND length(trim(content_requirements_zh)) > 0 "
            "AND length(trim(content_requirements_en)) > 0)",
            name="ck_content_plans_mode_input",
        ),
        CheckConstraint(
            "length(trim(name_zh)) > 0 AND length(trim(name_en)) > 0 "
            "AND length(trim(scene_zh)) > 0 AND length(trim(scene_en)) > 0 "
            "AND length(trim(trigger_event_zh)) > 0 AND length(trim(trigger_event_en)) > 0 "
            "AND length(trim(psychological_background_zh)) > 0 "
            "AND length(trim(psychological_background_en)) > 0",
            name="ck_content_plans_bilingual_text",
        ),
        CheckConstraint("revision >= 1", name="ck_content_plans_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    name_zh: str = Field(sa_column=Column(String(160), nullable=False))
    name_zh_key: str = Field(sa_column=Column(String(160), nullable=False))
    name_en: str = Field(sa_column=Column(String(160), nullable=False))
    name_en_key: str = Field(sa_column=Column(String(160), nullable=False))
    category: Category = Field(sa_column=enum_column(Category))
    conflict_direction: ConflictDirection | None = Field(default=None, sa_column=enum_column(ConflictDirection, nullable=True))
    mode: ContentMode = Field(sa_column=enum_column(ContentMode))
    status: ContentStatus = Field(default=ContentStatus.DRAFT, sa_column=enum_column(ContentStatus))
    true_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    apparent_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    scene_zh: str = Field(sa_column=Column(Text, nullable=False))
    scene_en: str = Field(sa_column=Column(Text, nullable=False))
    trigger_event_zh: str = Field(sa_column=Column(Text, nullable=False))
    trigger_event_en: str = Field(sa_column=Column(Text, nullable=False))
    psychological_background_zh: str = Field(sa_column=Column(Text, nullable=False))
    psychological_background_en: str = Field(sa_column=Column(Text, nullable=False))
    dialogue: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    display_text: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    true_emotion_description: str = Field(sa_column=Column(Text, nullable=False))
    base_video_prompt: str = Field(default="", sa_column=Column(Text, nullable=False))
    content_requirements_zh: str = Field(default="", sa_column=Column(Text, nullable=False))
    content_requirements_en: str = Field(default="", sa_column=Column(Text, nullable=False))
    scene_supplement_zh: str = Field(default="", sa_column=Column(Text, nullable=False))
    scene_supplement_en: str = Field(default="", sa_column=Column(Text, nullable=False))
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
        UniqueConstraint("name_zh_key", name="uq_video_background_presets_name_zh"),
        UniqueConstraint("name_en_key", name="uq_video_background_presets_name_en"),
        CheckConstraint(
            "length(trim(name_zh)) > 0 AND length(trim(name_en)) > 0 "
            "AND length(trim(scene_zh)) > 0 AND length(trim(scene_en)) > 0",
            name="ck_background_presets_bilingual_text",
        ),
        CheckConstraint("revision >= 1", name="ck_background_presets_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    name_zh: str = Field(sa_column=Column(String(160), nullable=False))
    name_zh_key: str = Field(sa_column=Column(String(160), nullable=False))
    name_en: str = Field(sa_column=Column(String(160), nullable=False))
    name_en_key: str = Field(sa_column=Column(String(160), nullable=False))
    scene_zh: str = Field(sa_column=Column(Text, nullable=False))
    scene_en: str = Field(sa_column=Column(Text, nullable=False))
    ambient_sound_zh: str = Field(default="", sa_column=Column(Text, nullable=False))
    ambient_sound_en: str = Field(default="", sa_column=Column(Text, nullable=False))
    participant_relationship_zh: str = Field(default="", sa_column=Column(Text, nullable=False))
    participant_relationship_en: str = Field(default="", sa_column=Column(Text, nullable=False))
    lighting_zh: str = Field(default="", sa_column=Column(Text, nullable=False))
    lighting_en: str = Field(default="", sa_column=Column(Text, nullable=False))
    framing_zh: str = Field(default="", sa_column=Column(Text, nullable=False))
    framing_en: str = Field(default="", sa_column=Column(Text, nullable=False))
    status: ResourceStatus = Field(default=ResourceStatus.ACTIVE, sa_column=enum_column(ResourceStatus))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class ContentPlanBackground(SQLModel, table=True):
    __tablename__ = "content_plan_backgrounds"
    __table_args__ = (
        UniqueConstraint(
            "content_plan_id",
            "background_preset_id",
            name="uq_content_plan_background_pair",
        ),
        UniqueConstraint(
            "content_plan_id",
            "position",
            name="uq_content_plan_background_position",
        ),
        CheckConstraint("position >= 0", name="ck_content_plan_background_position"),
    )

    id: int | None = Field(default=None, primary_key=True)
    content_plan_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("content_plans.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    background_preset_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("video_background_presets.id", ondelete="RESTRICT"),
            nullable=False,
        )
    )
    position: int = Field(ge=0)


class BatchDraft(SQLModel, table=True):
    __tablename__ = "batch_drafts"
    __table_args__ = (
        CheckConstraint(CATEGORY_DIRECTION_CHECK, name="ck_batch_drafts_direction"),
        CheckConstraint(MODEL_PRECISION_CHECK, name="ck_batch_drafts_model_precision"),
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
    model: ModelName = Field(default=ModelName.LTX_25, sa_column=enum_column(ModelName))
    precision: Precision | None = Field(default=Precision.INT8, sa_column=enum_column(Precision, nullable=True))
    quantity: int = Field(gt=0)
    seed_base: int = Field(ge=0, lt=2**31)
    status: BatchDraftStatus = Field(default=BatchDraftStatus.DRAFT, sa_column=enum_column(BatchDraftStatus))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))

    def __init__(self, **data: Any) -> None:
        if "precision" not in data:
            selected_model = data.get("model", ModelName.LTX_25)
            data["precision"] = (
                Precision.INT8
                if selected_model in {ModelName.LTX_25, ModelName.LTX_25.value}
                else None
            )
        super().__init__(**data)


class BatchDraftContentSelection(SQLModel, table=True):
    __tablename__ = "batch_draft_content_selections"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", "position", name="uq_batch_content_selection_position"),
        CheckConstraint("position >= 0", name="ck_batch_content_selection_position"),
        CheckConstraint("source_revision >= 1", name="ck_batch_content_selection_revision"),
    )

    batch_draft_id: int = Field(sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="CASCADE"), primary_key=True))
    content_plan_id: int = Field(sa_column=Column(Integer, ForeignKey("content_plans.id", ondelete="RESTRICT"), primary_key=True))
    position: int = Field(ge=0)
    source_revision: int = Field(ge=1)


class BatchDraftPromptPreset(SQLModel, table=True):
    __tablename__ = "batch_draft_prompt_presets"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", "position", name="uq_batch_preset_position"),
        CheckConstraint("position = 0", name="ck_batch_single_prompt_preset"),
        CheckConstraint("source_revision >= 1", name="ck_batch_preset_revision"),
    )

    batch_draft_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("batch_drafts.id", ondelete="CASCADE"),
            primary_key=True,
        )
    )
    prompt_preset_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("prompt_presets.id", ondelete="RESTRICT"),
            primary_key=True,
        )
    )
    position: int = Field(default=0, ge=0, le=0)
    source_revision: int = Field(ge=1)


class BatchDraftContentBackground(SQLModel, table=True):
    __tablename__ = "batch_draft_content_backgrounds"
    __table_args__ = (
        ForeignKeyConstraint(
            ["batch_draft_id", "content_plan_id"],
            [
                "batch_draft_content_selections.batch_draft_id",
                "batch_draft_content_selections.content_plan_id",
            ],
            ondelete="CASCADE",
            name="fk_batch_content_background_selection",
        ),
        UniqueConstraint(
            "batch_draft_id",
            "content_plan_id",
            "background_preset_id",
            name="uq_batch_content_background_pair",
        ),
        UniqueConstraint(
            "batch_draft_id",
            "content_plan_id",
            "position",
            name="uq_batch_content_background_position",
        ),
        CheckConstraint("position >= 0", name="ck_batch_content_background_position"),
        CheckConstraint("source_revision >= 1", name="ck_batch_content_background_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    batch_draft_id: int = Field(nullable=False)
    content_plan_id: int = Field(nullable=False)
    background_preset_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("video_background_presets.id", ondelete="RESTRICT"),
            nullable=False,
        )
    )
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
        CheckConstraint(MODEL_PRECISION_CHECK, name="ck_batch_snapshots_model_precision"),
        CheckConstraint(SNAPSHOT_SOURCE_CHECK, name="ck_batch_snapshots_source"),
        CheckConstraint(f"age IN {AGES}", name="ck_batch_snapshots_age"),
        CheckConstraint("seed >= 0 AND seed < 2147483648", name="ck_batch_snapshots_seed"),
        CheckConstraint("sequence > 0", name="ck_batch_snapshots_sequence"),
        CheckConstraint("content_plan_revision >= 1", name="ck_batch_snapshots_content_revision"),
        CheckConstraint("prompt_preset_revision >= 1", name="ck_batch_snapshots_preset_revision"),
        CheckConstraint("background_preset_revision >= 1", name="ck_batch_snapshots_background_revision"),
        CheckConstraint("dataset_revision IS NULL OR dataset_revision >= 1", name="ck_batch_snapshots_dataset_revision"),
        CheckConstraint(
            f"width = {VIDEO_WIDTH} AND height = {VIDEO_HEIGHT} AND fps = {VIDEO_FPS}",
            name="ck_batch_snapshots_video_format",
        ),
        CheckConstraint(
            "(model IN ('LTX-2.3', 'LTX-2.5') AND frame_count = 121) OR "
            "(model = 'MiniMax H3' AND frame_count = 124)",
            name="ck_batch_snapshots_model_frames",
        ),
        CheckConstraint(
            "derive_silent_primary = (category IN ('A-VT', 'C-VT'))",
            name="ck_batch_snapshots_silent_primary",
        ),
        CheckConstraint("source_has_audio = 1", name="ck_batch_snapshots_source_audio"),
        CheckConstraint(
            f"renderer_profile_version = '{RENDERER_PROFILE_VERSION}'",
            name="ck_batch_snapshots_renderer_profile",
        ),
        CheckConstraint(
            "(fixed_positive_prompt IS NULL AND fixed_dialogue IS NULL AND fixed_vt_text IS NULL "
            "AND fixed_true_emotion_description IS NULL) OR "
            "(fixed_positive_prompt IS NOT NULL AND fixed_true_emotion_description IS NOT NULL AND "
            "((category IN ('A-VA', 'C-VA') AND fixed_dialogue IS NOT NULL AND fixed_vt_text IS NULL) OR "
            "(category IN ('A-VT', 'C-VT') AND fixed_dialogue IS NULL AND fixed_vt_text IS NOT NULL)))",
            name="ck_batch_snapshots_fixed_prompt",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    batch_draft_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="RESTRICT"), nullable=True),
    )
    dataset_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("datasets.id", ondelete="RESTRICT"), nullable=True),
    )
    dataset_revision: int | None = Field(default=None, ge=1)
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
    precision: Precision | None = Field(default=None, sa_column=enum_column(Precision, nullable=True))
    seed: int = Field(ge=0, lt=2**31)
    width: int
    height: int
    fps: int
    frame_count: int
    renderer_profile_version: str = Field(sa_column=Column(String(40), nullable=False))
    prompt_model: str = Field(sa_column=Column(String(80), nullable=False))
    source_has_audio: bool
    derive_silent_primary: bool
    system_input: str = Field(sa_column=Column(Text, nullable=False))
    user_input: str = Field(sa_column=Column(Text, nullable=False))
    final_negative_prompt: str = Field(sa_column=Column(Text, nullable=False))
    fixed_positive_prompt: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    fixed_dialogue: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    fixed_vt_text: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    fixed_true_emotion_description: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    true_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    apparent_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class Job(SQLModel, table=True):
    __tablename__ = "jobs"
    __table_args__ = (
        UniqueConstraint("batch_draft_id", name="uq_jobs_batch_draft"),
        CheckConstraint(CATEGORY_DIRECTION_CHECK, name="ck_jobs_direction"),
        CheckConstraint(JOB_SOURCE_CHECK, name="ck_jobs_source"),
        CheckConstraint(JOB_MODEL_PRECISION_CHECK, name="ck_jobs_model_precision"),
        CheckConstraint(
            "total_count > 0 AND prepared_count >= 0 AND completed_count >= 0 AND failed_count >= 0 "
            "AND prepared_count <= total_count "
            "AND completed_count + failed_count <= total_count",
            name="ck_jobs_counts",
        ),
        CheckConstraint("revision >= 1", name="ck_jobs_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    display_name: str = Field(sa_column=Column(String(80), nullable=False))
    source: JobSource = Field(default=JobSource.PRODUCTION, sa_column=enum_column(JobSource))
    dataset_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("datasets.id", ondelete="RESTRICT"), nullable=True),
    )
    batch_draft_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("batch_drafts.id", ondelete="RESTRICT"), nullable=True),
    )
    category: Category = Field(sa_column=enum_column(Category))
    conflict_direction: ConflictDirection | None = Field(default=None, sa_column=enum_column(ConflictDirection, nullable=True))
    model: ModelName | None = Field(default=None, sa_column=enum_column(ModelName, nullable=True))
    precision: Precision | None = Field(default=None, sa_column=enum_column(Precision, nullable=True))
    status: JobStatus = Field(default=JobStatus.QUEUED, sa_column=enum_column(JobStatus))
    total_count: int = Field(gt=0)
    prepared_count: int = Field(default=0, ge=0)
    completed_count: int = Field(default=0, ge=0)
    failed_count: int = Field(default=0, ge=0)
    confirm_model_switch: bool = False
    cancel_requested_at: str | None = Field(default=None, sa_column=Column(String(32), nullable=True))
    failure_code: str | None = Field(default=None, sa_column=Column(String(80), nullable=True))
    failure_reason: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    started_at: str | None = Field(default=None, sa_column=Column(String(32), nullable=True))
    finished_at: str | None = Field(default=None, sa_column=Column(String(32), nullable=True))
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
    stage: JobItemStage = Field(default=JobItemStage.PROMPT_QUEUED, sa_column=enum_column(JobItemStage))
    status: JobStatus = Field(default=JobStatus.QUEUED, sa_column=enum_column(JobStatus))
    failure_code: str | None = Field(default=None, sa_column=Column(String(80), nullable=True))
    failure_reason: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    failure_details_json: str | None = Field(
        default=None, sa_column=Column(Text, nullable=True)
    )
    renderer_prompt_id: str | None = Field(default=None, sa_column=Column(String(160), nullable=True))
    source_asset_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("assets.id", ondelete="RESTRICT"), nullable=True),
    )
    primary_asset_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("assets.id", ondelete="RESTRICT"), nullable=True),
    )
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class JobItemPromptResult(SQLModel, table=True):
    __tablename__ = "job_item_prompt_results"
    __table_args__ = (UniqueConstraint("job_item_id", name="uq_job_item_prompt_results_item"),)

    id: int | None = Field(default=None, primary_key=True)
    job_item_id: int = Field(
        sa_column=Column(Integer, ForeignKey("job_items.id", ondelete="CASCADE"), nullable=False)
    )
    policy_version: str = Field(sa_column=Column(String(40), nullable=False))
    system_input: str = Field(sa_column=Column(Text, nullable=False))
    user_input: str = Field(sa_column=Column(Text, nullable=False))
    raw_structured_response: str = Field(sa_column=Column(Text, nullable=False))
    final_positive_prompt: str = Field(sa_column=Column(Text, nullable=False))
    final_negative_prompt: str = Field(sa_column=Column(Text, nullable=False))
    dialogue: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    vt_text: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    true_emotion_description: str = Field(sa_column=Column(Text, nullable=False))
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class Asset(SQLModel, table=True):
    __tablename__ = "assets"
    __table_args__ = (
        UniqueConstraint("storage_root", "relative_path", name="uq_assets_storage_path"),
        CheckConstraint("length(trim(storage_root)) > 0", name="ck_assets_storage_root"),
        CheckConstraint(
            "length(trim(relative_path)) > 0 AND relative_path NOT LIKE '/%' "
            "AND relative_path NOT LIKE '%\\\\%' AND relative_path NOT LIKE '%..%'",
            name="ck_assets_relative_path",
        ),
        CheckConstraint("media_type = 'video/mp4'", name="ck_assets_media_type"),
        CheckConstraint("byte_size > 0", name="ck_assets_byte_size"),
        CheckConstraint("width = 1344 AND height = 768", name="ck_assets_video_size"),
        CheckConstraint("fps = 24", name="ck_assets_fps"),
        CheckConstraint("frame_count IN (121, 124)", name="ck_assets_frame_count"),
        CheckConstraint("duration_seconds > 0", name="ck_assets_duration"),
    )

    id: int | None = Field(default=None, primary_key=True)
    storage_root: str = Field(sa_column=Column(String(1024), nullable=False))
    relative_path: str = Field(sa_column=Column(String(1024), nullable=False))
    media_type: str = Field(sa_column=Column(String(80), nullable=False))
    byte_size: int = Field(gt=0)
    width: int
    height: int
    fps: int
    frame_count: int
    duration_seconds: float = Field(gt=0)
    has_audio: bool
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class GenerationAttempt(SQLModel, table=True):
    __tablename__ = "generation_attempts"
    __table_args__ = (
        UniqueConstraint("job_item_id", "attempt_number", name="uq_generation_attempts_item_number"),
        CheckConstraint("attempt_number > 0", name="ck_generation_attempts_number"),
        CheckConstraint("seed >= 0 AND seed < 2147483648", name="ck_generation_attempts_seed"),
        CheckConstraint(MODEL_PRECISION_CHECK, name="ck_generation_attempts_model_precision"),
        CheckConstraint(
            "(status = 'Running' AND source_asset_id IS NULL AND primary_asset_id IS NULL "
            "AND renderer_prompt_id IS NOT NULL AND failure_reason IS NULL "
            "AND started_at IS NOT NULL AND finished_at IS NULL) OR "
            "(status = 'Completed' AND source_asset_id IS NOT NULL AND primary_asset_id IS NOT NULL "
            "AND renderer_prompt_id IS NOT NULL AND failure_reason IS NULL "
            "AND started_at IS NOT NULL AND finished_at IS NOT NULL) OR "
            "(status = 'Failed' AND source_asset_id IS NULL AND primary_asset_id IS NULL "
            "AND renderer_prompt_id IS NOT NULL AND failure_reason IS NOT NULL "
            "AND started_at IS NOT NULL AND finished_at IS NOT NULL)",
            name="ck_generation_attempts_status",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    job_item_id: int = Field(sa_column=Column(Integer, ForeignKey("job_items.id", ondelete="CASCADE"), nullable=False))
    attempt_number: int = Field(gt=0)
    model: ModelName = Field(sa_column=enum_column(ModelName))
    precision: Precision | None = Field(default=None, sa_column=enum_column(Precision, nullable=True))
    gpu_slot: GpuSlotName = Field(sa_column=enum_column(GpuSlotName, foreign_key="gpu_slots.slot", ondelete="RESTRICT"))
    seed: int = Field(ge=0, lt=2**31)
    source_asset_id: int | None = Field(default=None, sa_column=Column(Integer, ForeignKey("assets.id", ondelete="RESTRICT"), nullable=True))
    primary_asset_id: int | None = Field(default=None, sa_column=Column(Integer, ForeignKey("assets.id", ondelete="RESTRICT"), nullable=True))
    renderer_prompt_id: str | None = Field(default=None, sa_column=Column(String(160), nullable=True))
    status: GenerationAttemptStatus = Field(
        default=GenerationAttemptStatus.RUNNING,
        sa_column=enum_column(GenerationAttemptStatus),
    )
    failure_reason: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    started_at: str | None = Field(default=None, sa_column=Column(String(32), nullable=True))
    finished_at: str | None = Field(default=None, sa_column=Column(String(32), nullable=True))


class Sample(SQLModel, table=True):
    __tablename__ = "samples"
    __table_args__ = (
        UniqueConstraint("job_item_id", name="uq_samples_job_item"),
        CheckConstraint(CATEGORY_DIRECTION_CHECK, name="ck_samples_direction"),
        CheckConstraint(f"age IN {AGES}", name="ck_samples_age"),
        CheckConstraint("content_plan_revision >= 1", name="ck_samples_content_revision"),
        CheckConstraint("seed >= 0 AND seed < 2147483648", name="ck_samples_seed"),
        CheckConstraint("review_revision >= 0", name="ck_samples_review_revision"),
        CheckConstraint("revision >= 1", name="ck_samples_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    job_item_id: int = Field(
        sa_column=Column(Integer, ForeignKey("job_items.id", ondelete="RESTRICT"), nullable=False)
    )
    dataset_id: int = Field(
        sa_column=Column(Integer, ForeignKey("datasets.id", ondelete="RESTRICT"), nullable=False)
    )
    category: Category = Field(sa_column=enum_column(Category))
    conflict_direction: ConflictDirection | None = Field(
        default=None,
        sa_column=enum_column(ConflictDirection, nullable=True),
    )
    review_decision: ReviewDecision = Field(
        default=ReviewDecision.PENDING,
        sa_column=enum_column(ReviewDecision),
    )
    review_revision: int = Field(default=0, ge=0)
    model: ModelName = Field(sa_column=enum_column(ModelName))
    gpu_slot: GpuSlotName = Field(
        sa_column=enum_column(GpuSlotName, foreign_key="gpu_slots.slot", ondelete="RESTRICT")
    )
    content_plan_id: int = Field(
        sa_column=Column(Integer, ForeignKey("content_plans.id", ondelete="RESTRICT"), nullable=False)
    )
    content_plan_revision: int = Field(ge=1)
    prompt_preset_id: int = Field(
        sa_column=Column(Integer, ForeignKey("prompt_presets.id", ondelete="RESTRICT"), nullable=False)
    )
    source_asset_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("assets.id", ondelete="RESTRICT"), nullable=True),
    )
    primary_asset_id: int = Field(
        sa_column=Column(Integer, ForeignKey("assets.id", ondelete="RESTRICT"), nullable=False)
    )
    dialogue: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    display_text: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    video_prompt: str = Field(sa_column=Column(Text, nullable=False))
    negative_prompt: str = Field(sa_column=Column(Text, nullable=False))
    true_emotion_description: str = Field(sa_column=Column(Text, nullable=False))
    true_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    apparent_emotion: str = Field(sa_column=Column(String(120), nullable=False))
    content_plan_name_zh: str = Field(sa_column=Column(String(160), nullable=False))
    content_plan_name_en: str = Field(sa_column=Column(String(160), nullable=False))
    scene_zh: str = Field(sa_column=Column(Text, nullable=False))
    scene_en: str = Field(sa_column=Column(Text, nullable=False))
    trigger_event_zh: str = Field(sa_column=Column(Text, nullable=False))
    trigger_event_en: str = Field(sa_column=Column(Text, nullable=False))
    psychological_background_zh: str = Field(sa_column=Column(Text, nullable=False))
    psychological_background_en: str = Field(sa_column=Column(Text, nullable=False))
    age: int
    gender: Gender = Field(sa_column=enum_column(Gender))
    ethnicity: Ethnicity = Field(sa_column=enum_column(Ethnicity))
    seed: int = Field(ge=0, lt=2**31)
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class Reviewer(SQLModel, table=True):
    __tablename__ = "reviewers"
    __table_args__ = (
        UniqueConstraint("name_key", name="uq_reviewers_name_key"),
        CheckConstraint("length(trim(name)) > 0 AND length(name) <= 80", name="ck_reviewers_name"),
        CheckConstraint("length(trim(name_key)) > 0 AND length(name_key) <= 80", name="ck_reviewers_name_key"),
        CheckConstraint("revision >= 1", name="ck_reviewers_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(sa_column=Column(String(80), nullable=False))
    name_key: str = Field(sa_column=Column(String(80), nullable=False))
    revision: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class Review(SQLModel, table=True):
    __tablename__ = "reviews"
    __table_args__ = (
        UniqueConstraint("sample_id", "revision", name="uq_reviews_sample_revision"),
        CheckConstraint("decision IN ('Accepted', 'Rejected')", name="ck_reviews_decision"),
        CheckConstraint("length(note) <= 2000", name="ck_reviews_note"),
        CheckConstraint("sample_revision >= 1", name="ck_reviews_sample_revision"),
        CheckConstraint("revision >= 1", name="ck_reviews_revision"),
    )

    id: int | None = Field(default=None, primary_key=True)
    sample_id: int = Field(
        sa_column=Column(Integer, ForeignKey("samples.id", ondelete="RESTRICT"), nullable=False)
    )
    reviewer_id: int = Field(
        sa_column=Column(Integer, ForeignKey("reviewers.id", ondelete="RESTRICT"), nullable=False)
    )
    dataset_id: int = Field(
        sa_column=Column(Integer, ForeignKey("datasets.id", ondelete="RESTRICT"), nullable=False)
    )
    protocol: Protocol = Field(sa_column=enum_column(Protocol))
    relation: Relation = Field(sa_column=enum_column(Relation))
    decision: ReviewDecision = Field(sa_column=enum_column(ReviewDecision))
    note: str = Field(default="", sa_column=Column(Text, nullable=False))
    sample_revision: int = Field(ge=1)
    revision: int = Field(ge=1)
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class Archive(SQLModel, table=True):
    __tablename__ = "archives"
    __table_args__ = (CheckConstraint("revision >= 1", name="ck_archives_revision"),)

    dataset_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("datasets.id", ondelete="RESTRICT"),
            primary_key=True,
            nullable=False,
        )
    )
    revision: int = Field(default=1, ge=1)
    last_synced_at: str = Field(sa_column=Column(String(32), nullable=False))
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
    updated_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class ArchiveItem(SQLModel, table=True):
    __tablename__ = "archive_items"
    __table_args__ = (CheckConstraint("sample_revision >= 1", name="ck_archive_items_sample_revision"),)

    dataset_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("datasets.id", ondelete="RESTRICT"),
            primary_key=True,
            nullable=False,
        )
    )
    sample_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("samples.id", ondelete="RESTRICT"),
            primary_key=True,
            nullable=False,
        )
    )
    sample_revision: int = Field(ge=1)
    synced_at: str = Field(sa_column=Column(String(32), nullable=False))


class JobEvent(SQLModel, table=True):
    __tablename__ = "job_events"
    __table_args__ = (CheckConstraint("length(event_type) > 0", name="ck_job_events_type"),)

    id: int | None = Field(default=None, primary_key=True)
    job_id: int = Field(sa_column=Column(Integer, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False))
    item_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("job_items.id", ondelete="SET NULL"), nullable=True),
    )
    event_type: str = Field(sa_column=Column(String(80), nullable=False))
    payload_json: str = Field(default="{}", sa_column=Column(Text, nullable=False))
    created_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))


class GpuSlot(SQLModel, table=True):
    __tablename__ = "gpu_slots"
    __table_args__ = (
        CheckConstraint("revision >= 1", name="ck_gpu_slots_revision"),
        CheckConstraint(LOADED_MODEL_PRECISION_CHECK, name="ck_gpu_slots_loaded_model_precision"),
        CheckConstraint(
            "(availability IN ('Reserved', 'Busy') AND active_job_id IS NOT NULL) OR "
            "(availability IN ('Available', 'ExternalOccupied', 'Unknown') AND active_job_id IS NULL)",
            name="ck_gpu_slots_active_job",
        ),
    )

    slot: GpuSlotName = Field(sa_column=enum_column(GpuSlotName, primary_key=True))
    availability: GpuAvailability = Field(default=GpuAvailability.UNKNOWN, sa_column=enum_column(GpuAvailability))
    loaded_model: ModelName | None = Field(default=None, sa_column=enum_column(ModelName, nullable=True))
    loaded_precision: Precision | None = Field(default=None, sa_column=enum_column(Precision, nullable=True))
    active_job_id: int | None = Field(
        default=None,
        sa_column=Column(Integer, ForeignKey("jobs.id", ondelete="RESTRICT"), nullable=True),
    )
    revision: int = Field(default=1, ge=1)
    checked_at: str = Field(default_factory=utc_now, sa_column=Column(String(32), nullable=False))
