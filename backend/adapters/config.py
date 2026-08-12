from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from backend.adapters.gpu import UNIT_DEFINITIONS, UnitDefinition
from backend.domain.enums import GpuSlotName


@dataclass(frozen=True)
class RendererSettings:
    workflow_root: Path
    ltx23_template: Path
    h3_template: Path
    slot_urls: tuple[tuple[GpuSlotName, str], ...]
    unit_definitions: tuple[UnitDefinition, ...]

    def urls_by_slot(self) -> dict[GpuSlotName, str]:
        return dict(self.slot_urls)


@dataclass(frozen=True)
class Settings:
    data_root: Path
    frontend_dist: Path
    renderer: RendererSettings | None = None

    @classmethod
    def from_environment(cls) -> "Settings":
        value = os.environ.get("CONFLICTSTUDIO_DATA_ROOT", "").strip()
        if not value:
            raise RuntimeError("CONFLICTSTUDIO_DATA_ROOT is required")
        project_root = Path(__file__).resolve().parents[2]
        data_root = Path(value)
        renderer_values = {
            "ltx23": os.environ.get("CONFLICTSTUDIO_LTX23_WORKFLOW_PATH", "").strip(),
            "h3": os.environ.get("CONFLICTSTUDIO_H3_WORKFLOW_PATH", "").strip(),
            "gpu0": os.environ.get("CONFLICTSTUDIO_GPU0_URL", "").strip(),
            "gpu1": os.environ.get("CONFLICTSTUDIO_GPU1_URL", "").strip(),
        }
        renderer = None
        if all(renderer_values.values()):
            renderer = RendererSettings(
                workflow_root=data_root / "workflows",
                ltx23_template=Path(renderer_values["ltx23"]),
                h3_template=Path(renderer_values["h3"]),
                slot_urls=(
                    (GpuSlotName.GPU0, renderer_values["gpu0"]),
                    (GpuSlotName.GPU1, renderer_values["gpu1"]),
                ),
                unit_definitions=UNIT_DEFINITIONS,
            )
        return cls(
            data_root=data_root,
            frontend_dist=project_root / "frontend" / "dist",
            renderer=renderer,
        )
