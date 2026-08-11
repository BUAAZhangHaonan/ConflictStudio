from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_root: Path
    frontend_dist: Path

    @classmethod
    def from_environment(cls) -> "Settings":
        value = os.environ.get("CONFLICTSTUDIO_DATA_ROOT", "").strip()
        if not value:
            raise RuntimeError("CONFLICTSTUDIO_DATA_ROOT is required")
        project_root = Path(__file__).resolve().parents[2]
        return cls(data_root=Path(value), frontend_dist=project_root / "frontend" / "dist")

