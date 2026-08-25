from __future__ import annotations

from pathlib import Path

import pytest

from backend.adapters.config import (
    DEFAULT_DATA_ROOT,
    DEFAULT_H3_WORKFLOW_PATH,
    DEFAULT_LTX23_WORKFLOW_PATH,
    ENV_FILE_VALUE,
    GPU_URL_VALUES,
    LTX25_BF16_WORKFLOW_PATH_VALUE,
    LTX25_INT8_WORKFLOW_PATH_VALUE,
    RendererSettings,
    Settings,
)
from backend.adapters.gpu import UNIT_DEFINITIONS
from backend.domain.enums import GpuSlotName


RENDERER_ENVIRONMENT = {
    "CONFLICTSTUDIO_LTX23_WORKFLOW_PATH": DEFAULT_LTX23_WORKFLOW_PATH,
    "CONFLICTSTUDIO_H3_WORKFLOW_PATH": DEFAULT_H3_WORKFLOW_PATH,
    "CONFLICTSTUDIO_GPU0_URL": GPU_URL_VALUES[GpuSlotName.GPU0],
    "CONFLICTSTUDIO_GPU1_URL": GPU_URL_VALUES[GpuSlotName.GPU1],
}


def set_renderer_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONFLICTSTUDIO_DATA_ROOT", DEFAULT_DATA_ROOT)
    for name, value in RENDERER_ENVIRONMENT.items():
        monkeypatch.setenv(name, value)


def test_defaults_apply_when_environment_is_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("CONFLICTSTUDIO_DATA_ROOT", raising=False)
    for name in RENDERER_ENVIRONMENT:
        monkeypatch.delenv(name, raising=False)

    settings = Settings.from_environment()

    assert settings.data_root.as_posix() == DEFAULT_DATA_ROOT
    assert settings.renderer is None
    assert ENV_FILE_VALUE == "/home/team/zhanghaonan/ConflictStudio/ConflictStudio.env"


def test_environment_overrides_data_root_and_both_workflow_templates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_renderer_environment(monkeypatch)
    monkeypatch.setenv("CONFLICTSTUDIO_DATA_ROOT", "/somewhere/else/data")
    monkeypatch.setenv(
        "CONFLICTSTUDIO_LTX23_WORKFLOW_PATH",
        "/home/team/lvshuyang/prompt-make/workflows/another.json",
    )
    monkeypatch.setenv(
        "CONFLICTSTUDIO_H3_WORKFLOW_PATH",
        "/home/team/zhanghaonan/H3-ComfyUI/output/other/h3/payload.json",
    )

    settings = Settings.from_environment()

    assert settings.data_root.as_posix() == "/somewhere/else/data"
    assert settings.renderer is not None
    assert (
        settings.renderer.ltx23_template.as_posix()
        == "/home/team/lvshuyang/prompt-make/workflows/another.json"
    )
    assert (
        settings.renderer.h3_template.as_posix()
        == "/home/team/zhanghaonan/H3-ComfyUI/output/other/h3/payload.json"
    )
    assert settings.renderer.ltx25_bf16_template == LTX25_BF16_WORKFLOW_PATH_VALUE
    assert settings.renderer.ltx25_int8_template == LTX25_INT8_WORKFLOW_PATH_VALUE
    assert settings.renderer.urls_by_slot() == GPU_URL_VALUES


def test_data_root_override_moves_renderer_unit_output_directories(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    set_renderer_environment(monkeypatch)
    monkeypatch.setenv("CONFLICTSTUDIO_DATA_ROOT", "/somewhere/else/data")

    settings = Settings.from_environment()

    assert settings.renderer is not None
    assert settings.renderer.unit_definitions != UNIT_DEFINITIONS
    for definition, default in zip(
        settings.renderer.unit_definitions, UNIT_DEFINITIONS, strict=True
    ):
        assert definition.name == default.name
        assert definition.relative_data_directory == default.relative_data_directory
        assert definition.absolute_data_directory == (
            f"/somewhere/else/data/{definition.relative_data_directory}"
        )
        assert (
            f"{definition.absolute_data_directory}/output"
            in definition.required_exec_tokens
        )


def test_settings_reject_renderer_definitions_from_another_data_root() -> None:
    with pytest.raises(ValueError, match="configured data root"):
        Settings(
            data_root=Path("/somewhere/else/data"),
            frontend_dist=Path("/tmp/frontend"),
            renderer=RendererSettings(
                ltx23_template=Path(DEFAULT_LTX23_WORKFLOW_PATH),
                h3_template=Path(DEFAULT_H3_WORKFLOW_PATH),
                ltx25_bf16_template=LTX25_BF16_WORKFLOW_PATH_VALUE,
                ltx25_int8_template=LTX25_INT8_WORKFLOW_PATH_VALUE,
                slot_urls=tuple(GPU_URL_VALUES.items()),
                unit_definitions=UNIT_DEFINITIONS,
            ),
        )


def test_renderer_environment_group_is_all_or_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "CONFLICTSTUDIO_LTX23_WORKFLOW_PATH",
        DEFAULT_LTX23_WORKFLOW_PATH,
    )

    with pytest.raises(RuntimeError, match="required together"):
        Settings.from_environment()


def test_renderer_settings_reject_arbitrary_ltx25_workflow_paths() -> None:
    with pytest.raises(ValueError, match="bundled resource"):
        RendererSettings(
            ltx23_template=Path(DEFAULT_LTX23_WORKFLOW_PATH),
            h3_template=Path(DEFAULT_H3_WORKFLOW_PATH),
            ltx25_bf16_template=Path("/tmp/ltx25-bf16.json"),
            ltx25_int8_template=LTX25_INT8_WORKFLOW_PATH_VALUE,
            slot_urls=tuple(GPU_URL_VALUES.items()),
            unit_definitions=UNIT_DEFINITIONS,
        )


def test_renderer_settings_reject_changed_gpu_urls() -> None:
    with pytest.raises(ValueError, match="fixed local service ports"):
        RendererSettings(
            ltx23_template=Path(DEFAULT_LTX23_WORKFLOW_PATH),
            h3_template=Path(DEFAULT_H3_WORKFLOW_PATH),
            ltx25_bf16_template=LTX25_BF16_WORKFLOW_PATH_VALUE,
            ltx25_int8_template=LTX25_INT8_WORKFLOW_PATH_VALUE,
            slot_urls=(
                (GpuSlotName.GPU0, "http://127.0.0.1:9999"),
                (GpuSlotName.GPU1, GPU_URL_VALUES[GpuSlotName.GPU1]),
            ),
            unit_definitions=UNIT_DEFINITIONS,
        )
