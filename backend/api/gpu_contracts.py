from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from backend.domain.enums import GpuAvailability, GpuSlotName, ModelName, Precision


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class GpuApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        from_attributes=True,
        extra="forbid",
    )


class GpuMemoryRead(GpuApiModel):
    used_mib: int | None = Field(alias="usedMiB", ge=0)
    total_mib: int | None = Field(alias="totalMiB", ge=0)


class GpuSlotRead(GpuApiModel):
    slot: GpuSlotName
    availability: GpuAvailability
    loaded_model: ModelName | None
    loaded_precision: Precision | None
    service_status: Literal["running", "stopped", "unknown", "notInstalled", "notConfigured"]
    gpu_name: str | None
    memory: GpuMemoryRead
    active_job_id: int | None
    revision: int = Field(ge=1)
    checked_at: str
    status_reason: str | None


class GpuReleaseRequest(GpuApiModel):
    expected_revision: int = Field(ge=1)
