from __future__ import annotations

import shlex
from pathlib import Path

import pytest

from backend.adapters.gpu import UNIT_DEFINITIONS


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SYSTEMD_ROOT = PROJECT_ROOT / "deploy" / "systemd"
DATA_ROOT = "/home/team/zhanghaonan/ConflictStudio-data"
PROJECT_PATH = "/home/team/zhanghaonan/LTX-2.5-ComfyUI"
PYTHON_PATH = (
    f"{PROJECT_PATH}/.uv-python/"
    "cpython-3.13.15-linux-x86_64-gnu/bin/python3.13"
)
SITE_PACKAGES = f"{PROJECT_PATH}/.venv/lib/python3.13/site-packages"


PROFILES = (
    ("bf16", "BF16", 0, 8188),
    ("int8", "INT8", 0, 8188),
    ("bf16", "BF16", 1, 8189),
    ("int8", "INT8", 1, 8189),
)


def unit_path(profile: str, gpu: int) -> Path:
    return SYSTEMD_ROOT / f"conflictstudio-ltx25-{profile}-gpu{gpu}.service"


def setting(lines: list[str], name: str) -> str:
    prefix = f"{name}="
    values = [line.removeprefix(prefix) for line in lines if line.startswith(prefix)]
    assert len(values) == 1, f"expected one {name}= setting"
    return values[0]


@pytest.mark.parametrize(("profile", "precision", "gpu", "port"), PROFILES)
def test_ltx25_unit_has_exact_runtime_and_isolated_data_paths(
    profile: str,
    precision: str,
    gpu: int,
    port: int,
) -> None:
    path = unit_path(profile, gpu)
    assert path.is_file()
    lines = path.read_text(encoding="utf-8").splitlines()
    profile_root = f"{DATA_ROOT}/comfyui/gpu{gpu}/ltx25-{profile}"

    assert setting(lines, "WorkingDirectory") == PROJECT_PATH
    assert setting(lines, "ReadOnlyPaths") == PROJECT_PATH
    assert setting(lines, "Restart") == "no"
    assert not any(line.startswith("ExecStop=") for line in lines)
    assert not any(line.startswith("ExecStopPost=") for line in lines)
    assert "[Install]" not in lines
    assert not any(line.startswith("WantedBy=") for line in lines)

    environments = {
        line.removeprefix("Environment=")
        for line in lines
        if line.startswith("Environment=")
    }
    assert environments == {
        f"CUDA_VISIBLE_DEVICES={gpu}",
        "PYTHONDONTWRITEBYTECODE=1",
        f"PYTHONPATH={SITE_PACKAGES}",
        f"XDG_CACHE_HOME={profile_root}/cache",
        f"CONFLICTSTUDIO_LTX25_PRECISION={precision}",
    }

    directories = setting(lines, "ExecStartPre").split()
    assert directories[:2] == ["/usr/bin/mkdir", "-p"]
    assert set(directories[2:]) == {
        f"{profile_root}/input",
        f"{profile_root}/output",
        f"{profile_root}/temp",
        f"{profile_root}/user",
        f"{profile_root}/cache",
        f"{profile_root}/database",
        f"{DATA_ROOT}/logs",
    }

    assert setting(lines, "ExecStart") == (
        f"{PYTHON_PATH} {PROJECT_PATH}/main.py "
        f"--listen 127.0.0.1 --port {port} --disable-auto-launch "
        f"--input-directory {profile_root}/input "
        f"--output-directory {profile_root}/output "
        f"--temp-directory {profile_root}/temp "
        f"--user-directory {profile_root}/user "
        f"--database-url sqlite:////{profile_root.removeprefix('/')}"
        "/database/comfyui.sqlite3"
    )


@pytest.mark.parametrize(("profile", "_precision", "gpu", "_port"), PROFILES)
def test_ltx25_unit_conflicts_with_every_same_slot_renderer(
    profile: str,
    _precision: str,
    gpu: int,
    _port: int,
) -> None:
    lines = unit_path(profile, gpu).read_text(encoding="utf-8").splitlines()
    other_profile = "int8" if profile == "bf16" else "bf16"

    assert set(setting(lines, "Conflicts").split()) == {
        f"conflictstudio-ltx25-{other_profile}-gpu{gpu}.service",
        f"conflictstudio-ltx-gpu{gpu}.service",
        f"conflictstudio-h3-gpu{gpu}.service",
    }


RENDERER_UNITS = tuple(
    f"conflictstudio-{prefix}-gpu{gpu}.service"
    for gpu in (0, 1)
    for prefix in ("ltx", "h3", "ltx25-bf16", "ltx25-int8")
)


def renderer_unit_names(gpu: int) -> set[str]:
    return {
        f"conflictstudio-{prefix}-gpu{gpu}.service"
        for prefix in ("ltx", "h3", "ltx25-bf16", "ltx25-int8")
    }


@pytest.mark.parametrize("unit_name", RENDERER_UNITS)
def test_renderer_unit_conflicts_are_symmetric_and_complete(unit_name: str) -> None:
    gpu = 0 if "gpu0" in unit_name else 1
    lines = (
        (SYSTEMD_ROOT / unit_name).read_text(encoding="utf-8").splitlines()
    )
    conflicts = set(setting(lines, "Conflicts").split())

    assert unit_name not in conflicts
    assert conflicts == renderer_unit_names(gpu) - {unit_name}

    for other in conflicts:
        other_lines = (
            (SYSTEMD_ROOT / other).read_text(encoding="utf-8").splitlines()
        )
        assert unit_name in set(setting(other_lines, "Conflicts").split()), (
            f"{other} does not declare a conflict against {unit_name}"
        )


@pytest.mark.parametrize(
    "unit_name",
    (name for name in RENDERER_UNITS if "ltx25-" not in name),
)
def test_ltx_and_h3_renderer_units_have_no_install_section(
    unit_name: str,
) -> None:
    lines = (
        (SYSTEMD_ROOT / unit_name).read_text(encoding="utf-8").splitlines()
    )
    assert "[Install]" not in lines
    assert not any(line.startswith("WantedBy=") for line in lines)


def test_ltx25_unit_exec_starts_match_the_backend_ownership_allowlist() -> None:
    definitions = {
        definition.name: definition
        for definition in UNIT_DEFINITIONS
        if definition.name.startswith("conflictstudio-ltx25-")
    }
    expected_names = {
        f"conflictstudio-ltx25-{profile}-gpu{gpu}.service"
        for profile, _precision, gpu, _port in PROFILES
    }
    assert set(definitions) == expected_names

    for name, definition in definitions.items():
        lines = (SYSTEMD_ROOT / name).read_text(encoding="utf-8").splitlines()
        assert tuple(shlex.split(setting(lines, "ExecStart"))) == (
            definition.required_exec_tokens
        )
