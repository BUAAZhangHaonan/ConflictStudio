from __future__ import annotations

from pathlib import Path

import pytest

from backend.adapters.config import (
    DATA_ROOT_VALUE,
    GPU_URL_VALUES,
    H3_WORKFLOW_PATH_VALUE,
    LTX23_WORKFLOW_PATH_VALUE,
    LTX25_BF16_WORKFLOW_PATH_VALUE,
    LTX25_INT8_WORKFLOW_PATH_VALUE,
    RendererSettings,
    Settings,
)
from backend.adapters.gpu import UNIT_DEFINITIONS
from backend.domain.enums import GpuSlotName


RENDERER_ENVIRONMENT = {
    "CONFLICTSTUDIO_LTX23_WORKFLOW_PATH": LTX23_WORKFLOW_PATH_VALUE,
    "CONFLICTSTUDIO_H3_WORKFLOW_PATH": H3_WORKFLOW_PATH_VALUE,
    "CONFLICTSTUDIO_GPU0_URL": GPU_URL_VALUES[GpuSlotName.GPU0],
    "CONFLICTSTUDIO_GPU1_URL": GPU_URL_VALUES[GpuSlotName.GPU1],
}


def set_renderer_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONFLICTSTUDIO_DATA_ROOT", DATA_ROOT_VALUE)
    for name, value in RENDERER_ENVIRONMENT.items():
        monkeypatch.setenv(name, value)


def test_environment_requires_the_shared_data_root_without_app_suffix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CONFLICTSTUDIO_DATA_ROOT", f"{DATA_ROOT_VALUE}/app")

    with pytest.raises(RuntimeError, match="must equal"):
        Settings.from_environment()


def test_environment_accepts_exact_external_and_bundled_workflow_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_renderer_environment(monkeypatch)
    settings = Settings.from_environment()

    assert settings.data_root.as_posix() == DATA_ROOT_VALUE
    assert settings.renderer is not None
    assert settings.renderer.ltx23_template.as_posix() == LTX23_WORKFLOW_PATH_VALUE
    assert settings.renderer.h3_template.as_posix() == H3_WORKFLOW_PATH_VALUE
    assert settings.renderer.ltx25_bf16_template == LTX25_BF16_WORKFLOW_PATH_VALUE
    assert settings.renderer.ltx25_int8_template == LTX25_INT8_WORKFLOW_PATH_VALUE

    monkeypatch.setenv(
        "CONFLICTSTUDIO_LTX23_WORKFLOW_PATH",
        "/home/team/lvshuyang/prompt-make/workflows/another.json",
    )
    with pytest.raises(RuntimeError, match="fixed read-only template"):
        Settings.from_environment()


def test_renderer_settings_reject_arbitrary_external_workflow_paths() -> None:
    with pytest.raises(ValueError, match="fixed read-only template"):
        RendererSettings(
            ltx23_template=Path("/tmp/ltx.json"),
            h3_template=Path(H3_WORKFLOW_PATH_VALUE),
            ltx25_bf16_template=LTX25_BF16_WORKFLOW_PATH_VALUE,
            ltx25_int8_template=LTX25_INT8_WORKFLOW_PATH_VALUE,
            slot_urls=tuple(GPU_URL_VALUES.items()),
            unit_definitions=UNIT_DEFINITIONS,
        )


def test_renderer_settings_reject_arbitrary_ltx25_workflow_paths() -> None:
    with pytest.raises(ValueError, match="bundled resource"):
        RendererSettings(
            ltx23_template=Path(LTX23_WORKFLOW_PATH_VALUE),
            h3_template=Path(H3_WORKFLOW_PATH_VALUE),
            ltx25_bf16_template=Path("/tmp/ltx25-bf16.json"),
            ltx25_int8_template=LTX25_INT8_WORKFLOW_PATH_VALUE,
            slot_urls=tuple(GPU_URL_VALUES.items()),
            unit_definitions=UNIT_DEFINITIONS,
        )
