from __future__ import annotations

from enum import Enum


class ValueEnum(str, Enum):
    def __str__(self) -> str:
        return self.value


class Category(ValueEnum):
    A_VA = "A-VA"
    A_VT = "A-VT"
    C_VA = "C-VA"
    C_VT = "C-VT"


class ConflictDirection(ValueEnum):
    VISION = "Vision"
    AUDIO = "Audio"
    TEXT = "Text"


class ModelName(ValueEnum):
    LTX = "LTX-2.3"
    LTX_25 = "LTX-2.5"
    H3 = "MiniMax H3"


class Precision(ValueEnum):
    BF16 = "BF16"
    INT8 = "INT8"


class DatasetPurpose(ValueEnum):
    FORMAL = "Formal"
    PRODUCTION = "Production"
    VALIDATION = "Validation"


class ResourceStatus(ValueEnum):
    ACTIVE = "Active"
    INACTIVE = "Inactive"
    DISABLED = "Disabled"


class ContentStatus(ValueEnum):
    DRAFT = "Draft"
    ACTIVE = "Active"
    DISABLED = "Disabled"


class ContentMode(ValueEnum):
    FIXED = "Fixed"
    GENERATIVE = "Generative"


class ExampleKind(ValueEnum):
    POSITIVE = "Positive"
    NEGATIVE = "Negative"


class BatchDraftStatus(ValueEnum):
    DRAFT = "Draft"
    SUBMITTED = "Submitted"


class JobSource(ValueEnum):
    PRODUCTION = "Production"
    TEST = "Test"


class TestExecutionMode(ValueEnum):
    PARALLEL = "Parallel"
    SERIAL = "Serial"


class JobStatus(ValueEnum):
    QUEUED = "Queued"
    RUNNING = "Running"
    COMPLETED = "Completed"
    FAILED = "Failed"
    CANCELLED = "Cancelled"


class JobItemStage(ValueEnum):
    PROMPT_QUEUED = "PromptQueued"
    PROMPT_GENERATING = "PromptGenerating"
    PROMPT_READY = "PromptReady"
    RENDERING = "Rendering"
    MEDIA_PROCESSING = "MediaProcessing"
    COMPLETED = "Completed"


class GenerationAttemptStatus(ValueEnum):
    RUNNING = "Running"
    COMPLETED = "Completed"
    FAILED = "Failed"


class ReviewDecision(ValueEnum):
    PENDING = "Pending"
    ACCEPTED = "Accepted"
    REJECTED = "Rejected"


class Protocol(ValueEnum):
    VA = "VA"
    VT = "VT"


class Relation(ValueEnum):
    ALIGNED = "Aligned"
    CONFLICT = "Conflict"


class ArchiveSyncStatus(ValueEnum):
    CURRENT = "Current"
    NEEDS_UPDATE = "NeedsUpdate"


class GpuSlotName(ValueEnum):
    GPU0 = "GPU0"
    GPU1 = "GPU1"


class GpuAvailability(ValueEnum):
    AVAILABLE = "Available"
    RESERVED = "Reserved"
    BUSY = "Busy"
    EXTERNAL_OCCUPIED = "ExternalOccupied"
    UNKNOWN = "Unknown"


class Gender(ValueEnum):
    MALE = "Male"
    FEMALE = "Female"


class Ethnicity(ValueEnum):
    EAST_ASIAN = "EastAsian"
    WHITE = "White"
    BLACK = "Black"
    SOUTH_ASIAN = "SouthAsian"
    LATINO = "Latino"


AGES = (25, 35, 45, 60)


def validate_direction(category: Category, direction: ConflictDirection | None) -> bool:
    if category in {Category.A_VA, Category.A_VT}:
        return direction is None
    if category is Category.C_VA:
        return direction in {ConflictDirection.VISION, ConflictDirection.AUDIO}
    return direction in {ConflictDirection.VISION, ConflictDirection.TEXT}


def validate_model_precision(model: ModelName, precision: Precision | None) -> bool:
    if model is ModelName.LTX_25:
        return precision in {Precision.BF16, Precision.INT8}
    return precision is None


def protocol_for(category: Category) -> Protocol:
    return Protocol.VA if category in {Category.A_VA, Category.C_VA} else Protocol.VT


def relation_for(category: Category) -> Relation:
    return Relation.ALIGNED if category in {Category.A_VA, Category.A_VT} else Relation.CONFLICT


def archive_status_for(
    decision: ReviewDecision,
    sample_revision: int,
    archived_revision: int | None,
) -> ArchiveSyncStatus:
    if decision is ReviewDecision.ACCEPTED:
        return (
            ArchiveSyncStatus.CURRENT
            if archived_revision == sample_revision
            else ArchiveSyncStatus.NEEDS_UPDATE
        )
    return (
        ArchiveSyncStatus.NEEDS_UPDATE
        if archived_revision is not None
        else ArchiveSyncStatus.CURRENT
    )
