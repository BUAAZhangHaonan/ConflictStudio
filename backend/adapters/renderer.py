from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from backend.domain.enums import Category, GpuAvailability, GpuSlotName, ModelName, Precision


class RendererGatewayError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class CancelOutcome(str, Enum):
    CANCELLED = "cancelled"
    ALREADY_COMPLETED = "already_completed"


class RendererInstallationStatus(str, Enum):
    INSTALLED = "installed"
    NOT_INSTALLED = "notInstalled"
    UNKNOWN = "unknown"
    NOT_CONFIGURED = "notConfigured"


@dataclass(frozen=True)
class RendererSlotState:
    slot: GpuSlotName
    availability: GpuAvailability
    loaded_model: ModelName | None
    owned_unit: str | None = None
    reason: str | None = None
    installation_status: RendererInstallationStatus = RendererInstallationStatus.UNKNOWN
    loaded_precision: Precision | None = None
    service_status: str = "unknown"
    gpu_name: str | None = None
    memory_used_mib: int | None = None
    memory_total_mib: int | None = None


@dataclass(frozen=True)
class RenderRequest:
    job_id: int
    job_item_id: int
    item_sequence: int
    gpu_slot: GpuSlotName
    model: ModelName
    category: Category
    confirm_model_switch: bool
    seed: int
    width: int
    height: int
    fps: int
    frame_count: int
    positive_prompt: str
    negative_prompt: str
    dialogue: str | None
    vt_text: str | None
    source_has_audio: bool
    derive_silent_primary: bool
    precision: Precision | None = None


@dataclass(frozen=True)
class RenderResult:
    output_references: tuple[str, ...] = ()


class RendererGateway(Protocol):
    configured: bool
    persists_render_state: bool

    async def probe(self, slot: GpuSlotName) -> RendererSlotState: ...

    async def installation_status(self) -> RendererInstallationStatus: ...

    async def submit(self, request: RenderRequest) -> str: ...

    async def wait(self, slot: GpuSlotName, prompt_id: str) -> RenderResult: ...

    async def cancel(self, slot: GpuSlotName, prompt_id: str) -> CancelOutcome: ...

    async def release(
        self,
        slot: GpuSlotName,
        *,
        expected_model: ModelName,
        expected_precision: Precision | None,
        expected_unit: str,
    ) -> RendererSlotState: ...

    async def close(self) -> None: ...


class UnconfiguredRendererGateway:
    configured = False
    persists_render_state = False

    async def probe(self, slot: GpuSlotName) -> RendererSlotState:
        return RendererSlotState(
            slot=slot,
            availability=GpuAvailability.UNKNOWN,
            loaded_model=None,
            installation_status=RendererInstallationStatus.NOT_CONFIGURED,
            service_status="notConfigured",
        )

    async def installation_status(self) -> RendererInstallationStatus:
        return RendererInstallationStatus.NOT_CONFIGURED

    async def submit(self, request: RenderRequest) -> str:
        raise RendererGatewayError(
            "renderer_not_configured",
            "Rendering requires a configured renderer gateway",
        )

    async def wait(self, slot: GpuSlotName, prompt_id: str) -> RenderResult:
        raise RendererGatewayError(
            "renderer_not_configured",
            "Rendering requires a configured renderer gateway",
        )

    async def cancel(self, slot: GpuSlotName, prompt_id: str) -> CancelOutcome:
        raise RendererGatewayError(
            "renderer_not_configured",
            "Rendering requires a configured renderer gateway",
        )

    async def release(
        self,
        slot: GpuSlotName,
        *,
        expected_model: ModelName,
        expected_precision: Precision | None,
        expected_unit: str,
    ) -> RendererSlotState:
        raise RendererGatewayError(
            "renderer_not_configured",
            "Rendering requires a configured renderer gateway",
        )

    async def close(self) -> None:
        return None


def __getattr__(name: str) -> object:
    if name == "ProductionRendererGateway":
        from backend.adapters.production_renderer import ProductionRendererGateway

        return ProductionRendererGateway
    raise AttributeError(name)
