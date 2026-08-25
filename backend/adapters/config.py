from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from backend.adapters.gpu import UnitDefinition, unit_definitions
from backend.domain.enums import GpuSlotName


DEFAULT_DATA_ROOT = "/home/team/zhanghaonan/ConflictStudio-data"
ENV_FILE_VALUE = "/home/team/zhanghaonan/ConflictStudio/ConflictStudio.env"
DEFAULT_LTX23_WORKFLOW_PATH = (
    "/home/team/lvshuyang/prompt-make/workflows/ltx23_t2v_audio_single_stage_api.json"
)
DEFAULT_H3_WORKFLOW_PATH = (
    "/home/team/zhanghaonan/H3-ComfyUI/output/compare-vt-va-20260806/"
    "h3/va_aligned/payload.json"
)
PROJECT_ROOT = Path(__file__).resolve().parents[2]
LTX25_BF16_WORKFLOW_PATH_VALUE = (
    PROJECT_ROOT / "backend" / "resources" / "workflows" / "ltx25_bf16.json"
)
LTX25_INT8_WORKFLOW_PATH_VALUE = (
    PROJECT_ROOT / "backend" / "resources" / "workflows" / "ltx25_int8.json"
)
GPU_URL_VALUES = {
    GpuSlotName.GPU0: "http://127.0.0.1:8188",
    GpuSlotName.GPU1: "http://127.0.0.1:8189",
}


@dataclass(frozen=True)
class RendererSettings:
    ltx23_template: Path
    h3_template: Path
    ltx25_bf16_template: Path
    ltx25_int8_template: Path
    slot_urls: tuple[tuple[GpuSlotName, str], ...]
    unit_definitions: tuple[UnitDefinition, ...]

    def __post_init__(self) -> None:
        if self.ltx25_bf16_template != LTX25_BF16_WORKFLOW_PATH_VALUE:
            raise ValueError("The LTX-2.5 BF16 workflow must use the bundled resource")
        if self.ltx25_int8_template != LTX25_INT8_WORKFLOW_PATH_VALUE:
            raise ValueError("The LTX-2.5 INT8 workflow must use the bundled resource")
        if self.urls_by_slot() != GPU_URL_VALUES:
            raise ValueError("Renderer URLs must match the fixed local service ports")

    def urls_by_slot(self) -> dict[GpuSlotName, str]:
        return dict(self.slot_urls)


@dataclass(frozen=True)
class Settings:
    data_root: Path
    frontend_dist: Path
    renderer: RendererSettings | None = None

    def __post_init__(self) -> None:
        if self.renderer is not None and self.renderer.unit_definitions != unit_definitions(
            self.data_root.as_posix()
        ):
            raise ValueError(
                "Renderer unit definitions must match the allowlist for the configured data root"
            )

    @classmethod
    def from_environment(cls) -> "Settings":
        data_root = Path(
            os.environ.get("CONFLICTSTUDIO_DATA_ROOT", DEFAULT_DATA_ROOT)
        ).resolve()
        renderer_values = {
            "ltx23": os.environ.get("CONFLICTSTUDIO_LTX23_WORKFLOW_PATH", ""),
            "h3": os.environ.get("CONFLICTSTUDIO_H3_WORKFLOW_PATH", ""),
            "gpu0": os.environ.get("CONFLICTSTUDIO_GPU0_URL", ""),
            "gpu1": os.environ.get("CONFLICTSTUDIO_GPU1_URL", ""),
        }
        renderer = None
        configured_values = tuple(bool(item) for item in renderer_values.values())
        if any(configured_values) and not all(configured_values):
            raise RuntimeError("Every renderer environment value is required together")
        if all(configured_values):
            renderer = RendererSettings(
                ltx23_template=Path(renderer_values["ltx23"]).resolve(),
                h3_template=Path(renderer_values["h3"]).resolve(),
                ltx25_bf16_template=LTX25_BF16_WORKFLOW_PATH_VALUE,
                ltx25_int8_template=LTX25_INT8_WORKFLOW_PATH_VALUE,
                slot_urls=(
                    (GpuSlotName.GPU0, renderer_values["gpu0"]),
                    (GpuSlotName.GPU1, renderer_values["gpu1"]),
                ),
                unit_definitions=unit_definitions(data_root.as_posix()),
            )
        return cls(
            data_root=data_root,
            frontend_dist=PROJECT_ROOT / "frontend" / "dist",
            renderer=renderer,
        )
