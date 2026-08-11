from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from backend.domain.enums import GpuAvailability, GpuSlotName, ModelName


class RendererGatewayError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class RendererSlotState:
    slot: GpuSlotName
    availability: GpuAvailability
    loaded_model: ModelName | None


@dataclass(frozen=True)
class RenderRequest:
    job_id: int
    job_item_id: int
    gpu_slot: GpuSlotName
    model: ModelName
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


@dataclass(frozen=True)
class RenderResult:
    output_references: tuple[str, ...] = ()


class RendererGateway(Protocol):
    configured: bool

    async def probe(self, slot: GpuSlotName) -> RendererSlotState: ...

    async def submit(self, request: RenderRequest) -> str: ...

    async def wait(self, slot: GpuSlotName, prompt_id: str) -> RenderResult: ...

    async def cancel(self, slot: GpuSlotName, prompt_id: str) -> None: ...

    async def close(self) -> None: ...


class UnconfiguredRendererGateway:
    configured = False

    async def probe(self, slot: GpuSlotName) -> RendererSlotState:
        return RendererSlotState(
            slot=slot,
            availability=GpuAvailability.UNKNOWN,
            loaded_model=None,
        )

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

    async def cancel(self, slot: GpuSlotName, prompt_id: str) -> None:
        raise RendererGatewayError(
            "renderer_not_configured",
            "Rendering requires a configured renderer gateway",
        )

    async def close(self) -> None:
        return None
