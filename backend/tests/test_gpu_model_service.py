from __future__ import annotations

import asyncio
from collections.abc import Iterable

import httpx
import pytest

from backend.adapters.gpu import (
    SERVICE_USER,
    UNIT_DEFINITIONS,
    CommandResult,
    SlotInspection,
    SlotInspector,
    UnitDefinition,
    UNITS_BY_SLOT_PROFILE,
)
from backend.adapters.model_service import ModelServiceController
from backend.adapters.renderer import (
    RendererGatewayError,
    RendererInstallationStatus,
    RendererSlotState,
)
from backend.domain.enums import GpuAvailability, GpuSlotName, ModelName, Precision


REQUIRED_NODE_TYPES = {
    ModelName.LTX: frozenset({"LtxRequiredNode", "SaveVideo"}),
    ModelName.LTX_25: frozenset({"Ltx25RequiredNode", "SaveVideo"}),
    ModelName.H3: frozenset({"H3RequiredNode", "SaveVideo"}),
}
OBJECT_INFO = {
    node_type: {}
    for node_types in REQUIRED_NODE_TYPES.values()
    for node_type in node_types
}


def _unit_show(
    unit: UnitDefinition,
    *,
    active: bool,
    exec_tokens: tuple[str, ...] | None = None,
) -> str:
    control_group = (
        f"/user.slice/user-1000.slice/user@1000.service/app.slice/{unit.name}" if active else ""
    )
    main_pid = 4100 if active else 0
    return "\n".join(
        (
            "LoadState=loaded",
            f"ActiveState={'active' if active else 'inactive'}",
            f"FragmentPath={unit.fragment_path}",
            f"MainPID={main_pid}",
            f"ControlGroup={control_group}",
            f"ExecStart={' '.join(exec_tokens or unit.required_exec_tokens)}",
            f"ExecStartPre={' '.join(unit.required_exec_start_pre_tokens)}",
            "ExecStop=",
            "ExecStopPost=",
            "Environment=" + " ".join(
                f"{name}={value}" for name, value in unit.required_environment.items()
            ),
            f"WorkingDirectory={unit.working_directory}",
            f"ReadOnlyPaths={unit.working_directory}",
            "KillMode=control-group",
            "Restart=no",
        )
    )


class InspectionCommands:
    def __init__(
        self,
        *,
        active_model: ModelName | None,
        active_precision: Precision | None = None,
        gpu_pids: Iterable[int] = (),
        listener_pids: Iterable[int] = (),
        foreign_pids: Iterable[int] = (),
        unit_extra_tokens: Iterable[str] = (),
        process_extra_tokens: Iterable[str] = (),
        memory_used_mib: int | None = None,
        memory_reserved_mib: int = 768,
        gpu_name: str = "NVIDIA RTX 6000 Ada Generation",
    ) -> None:
        self.active_model = active_model
        self.active_precision = active_precision
        self.gpu_pids = set(gpu_pids)
        self.listener_pids = set(listener_pids)
        self.foreign_pids = set(foreign_pids)
        self.unit_extra_tokens = tuple(unit_extra_tokens)
        self.process_extra_tokens = tuple(process_extra_tokens)
        self.memory_used_mib = (
            memory_used_mib
            if memory_used_mib is not None
            else (2048 if self.gpu_pids else 0)
        )
        self.gpu_name = gpu_name
        self.memory_reserved_mib = memory_reserved_mib
        self.calls: list[tuple[str, ...]] = []

    async def __call__(self, command: tuple[str, ...]) -> CommandResult:
        self.calls.append(command)
        if command[:3] == ("systemctl", "--user", "show"):
            unit = next(value for value in UNIT_DEFINITIONS if value.name == command[3])
            active = (
                unit.slot is GpuSlotName.GPU0
                and unit.model is self.active_model
                and unit.precision is self.active_precision
            )
            return CommandResult(
                0,
                _unit_show(
                    unit,
                    active=active,
                    exec_tokens=unit.required_exec_tokens + self.unit_extra_tokens,
                ),
            )
        if command[0] == "nvidia-smi":
            if command[2].startswith("--query-gpu="):
                return CommandResult(
                    0,
                    f"{self.gpu_name}, {self.memory_used_mib}, {self.memory_reserved_mib}, 49140\n",
                )
            return CommandResult(0, "\n".join(str(pid) for pid in sorted(self.gpu_pids)))
        if command[0] == "ss":
            output = "\n".join(
                f'LISTEN 0 128 127.0.0.1:8188 0.0.0.0:* users:(("python",pid={pid},fd=7))'
                for pid in sorted(self.listener_pids)
            )
            return CommandResult(0, output)
        parts = command[-1].split("/")
        pid = int(parts[2])
        if command[0] == "stat":
            return CommandResult(0, "other\n" if pid in self.foreign_pids else f"{SERVICE_USER}\n")
        if command[0] == "cat" and command[-1].endswith("/cmdline"):
            if pid in self.foreign_pids or self.active_model is None:
                return CommandResult(0, "/usr/bin/python\0foreign.py\0")
            unit = next(
                value
                for value in UNIT_DEFINITIONS
                if value.slot is GpuSlotName.GPU0
                and value.model is self.active_model
                and value.precision is self.active_precision
            )
            return CommandResult(
                0,
                "\0".join(unit.required_exec_tokens + self.process_extra_tokens) + "\0",
            )
        if command[0] == "cat" and command[-1].endswith("/cgroup"):
            if pid in self.foreign_pids or self.active_model is None:
                return CommandResult(0, "0::/user.slice/foreign.service\n")
            unit = next(
                value
                for value in UNIT_DEFINITIONS
                if value.slot is GpuSlotName.GPU0
                and value.model is self.active_model
                and value.precision is self.active_precision
            )
            return CommandResult(
                0,
                f"0::/user.slice/user-1000.slice/user@1000.service/app.slice/{unit.name}\n",
            )
        raise AssertionError(f"Unexpected command: {command}")


def test_slot_inspector_accepts_exact_owned_process() -> None:
    commands = InspectionCommands(active_model=ModelName.LTX, gpu_pids={4100}, listener_pids={4100})
    result = asyncio.run(SlotInspector(commands).inspect(GpuSlotName.GPU0))

    assert isinstance(result, RendererSlotState)
    assert result.availability is GpuAvailability.AVAILABLE
    assert result.loaded_model is ModelName.LTX
    assert result.owned_unit == "conflictstudio-ltx-gpu0.service"
    assert result.gpu_name == "NVIDIA RTX 6000 Ada Generation"
    assert result.memory_used_mib == 2048
    assert result.memory_total_mib == 49140
    assert result.service_status == "running"
    assert result.listener_pids == (4100,)
    assert all(isinstance(call, tuple) for call in commands.calls)


def test_slot_inspector_identifies_exact_ltx25_precision_profile() -> None:
    commands = InspectionCommands(
        active_model=ModelName.LTX_25,
        active_precision=Precision.INT8,
        gpu_pids={4100},
        listener_pids={4100},
    )
    result = asyncio.run(SlotInspector(commands).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.AVAILABLE
    assert result.loaded_model is ModelName.LTX_25
    assert result.loaded_precision is Precision.INT8
    assert result.owned_unit == "conflictstudio-ltx25-int8-gpu0.service"


def test_exec_start_parser_accepts_systemd_show_format() -> None:
    unit = next(unit for unit in UNIT_DEFINITIONS if unit.model is ModelName.LTX)
    value = (
        "{ path=/home/team/lvshuyang/anaconda3/envs/comfyui/bin/python ; "
        f"argv[]={' '.join(unit.required_exec_tokens)} ; "
        "ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; }"
    )

    assert SlotInspector._parse_exec_start(value) == unit.required_exec_tokens


@pytest.mark.parametrize("extra_argument", ["--port", "--output-directory"])
def test_slot_inspector_rejects_extra_unit_arguments(extra_argument: str) -> None:
    commands = InspectionCommands(
        active_model=ModelName.LTX,
        unit_extra_tokens=(extra_argument, "9999"),
    )
    result = asyncio.run(SlotInspector(commands).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.UNKNOWN


@pytest.mark.parametrize("extra_argument", ["--port", "--output-directory"])
def test_slot_inspector_rejects_extra_process_arguments(extra_argument: str) -> None:
    commands = InspectionCommands(
        active_model=ModelName.LTX,
        gpu_pids={4100},
        listener_pids={4100},
        process_extra_tokens=(extra_argument, "9999"),
    )
    result = asyncio.run(SlotInspector(commands).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.EXTERNAL_OCCUPIED


@pytest.mark.parametrize(
    ("gpu_pids", "listener_pids", "foreign_pids"),
    [
        ({4100, 9900}, {4100}, {9900}),
        ({4100}, {9900}, {9900}),
    ],
)
def test_slot_inspector_blocks_unknown_gpu_pid_or_listener(
    gpu_pids: set[int],
    listener_pids: set[int],
    foreign_pids: set[int],
) -> None:
    commands = InspectionCommands(
        active_model=ModelName.LTX,
        gpu_pids=gpu_pids,
        listener_pids=listener_pids,
        foreign_pids=foreign_pids,
    )
    result = asyncio.run(SlotInspector(commands).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.EXTERNAL_OCCUPIED
    assert result.reason == "An unknown process uses the GPU or fixed listener port"


def test_slot_inspector_rejects_mismatched_unit_metadata() -> None:
    commands = InspectionCommands(active_model=ModelName.LTX, listener_pids={4100})
    original = commands.__call__

    async def mismatched(command: tuple[str, ...]) -> CommandResult:
        result = await original(command)
        if command[:4] == ("systemctl", "--user", "show", "conflictstudio-ltx-gpu0.service"):
            return CommandResult(0, result.stdout.replace("FragmentPath=", "FragmentPath=/tmp/"))
        return result

    result = asyncio.run(SlotInspector(mismatched).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.UNKNOWN
    assert result.owned_unit is None


def test_slot_inspector_requires_an_exact_process_cgroup() -> None:
    commands = InspectionCommands(
        active_model=ModelName.LTX,
        gpu_pids={4100},
        listener_pids={4100},
    )
    original = commands.__call__

    async def mismatched(command: tuple[str, ...]) -> CommandResult:
        result = await original(command)
        if command[0] == "cat" and command[-1].endswith("/cgroup"):
            return CommandResult(0, result.stdout.replace(".service\n", ".service-shadow\n"))
        return result

    result = asyncio.run(SlotInspector(mismatched).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.EXTERNAL_OCCUPIED
    assert result.reason == "An unknown process uses the GPU or fixed listener port"


def test_slot_inspector_rejects_ltx25_precision_environment_mismatch() -> None:
    commands = InspectionCommands(
        active_model=ModelName.LTX_25,
        active_precision=Precision.BF16,
        gpu_pids={4100},
        listener_pids={4100},
    )
    original = commands.__call__

    async def mismatched(command: tuple[str, ...]) -> CommandResult:
        result = await original(command)
        if command[:4] == (
            "systemctl",
            "--user",
            "show",
            "conflictstudio-ltx25-bf16-gpu0.service",
        ):
            return CommandResult(
                0,
                result.stdout.replace(
                    "CONFLICTSTUDIO_LTX25_PRECISION=BF16",
                    "CONFLICTSTUDIO_LTX25_PRECISION=INT8",
                ),
            )
        return result

    result = asyncio.run(SlotInspector(mismatched).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.UNKNOWN
    assert result.loaded_model is None


def test_slot_inspector_rejects_an_extra_unit_environment_setting() -> None:
    commands = InspectionCommands(
        active_model=ModelName.LTX_25,
        active_precision=Precision.INT8,
        gpu_pids={4100},
        listener_pids={4100},
    )
    original = commands.__call__

    async def changed(command: tuple[str, ...]) -> CommandResult:
        result = await original(command)
        if command[:4] == (
            "systemctl",
            "--user",
            "show",
            "conflictstudio-ltx25-int8-gpu0.service",
        ):
            return CommandResult(0, result.stdout.replace("Environment=", "Environment=LD_PRELOAD=/tmp/x "))
        return result

    result = asyncio.run(SlotInspector(changed).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.UNKNOWN
    assert result.loaded_model is None


@pytest.mark.parametrize(
    ("property_name", "replacement"),
    [
        ("ExecStop=", "ExecStop=/usr/bin/kill 9999"),
        ("KillMode=control-group", "KillMode=process"),
        ("WorkingDirectory=", "WorkingDirectory=/tmp/"),
        ("ReadOnlyPaths=", "ReadOnlyPaths=/tmp/"),
    ],
)
def test_slot_inspector_rejects_unsafe_unit_service_properties(
    property_name: str,
    replacement: str,
) -> None:
    commands = InspectionCommands(active_model=ModelName.LTX)
    original = commands.__call__

    async def changed(command: tuple[str, ...]) -> CommandResult:
        result = await original(command)
        if command[:4] == (
            "systemctl",
            "--user",
            "show",
            "conflictstudio-ltx-gpu0.service",
        ):
            return CommandResult(0, result.stdout.replace(property_name, replacement, 1))
        return result

    result = asyncio.run(SlotInspector(changed).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.UNKNOWN
    assert result.loaded_model is None


def test_slot_inspector_reports_missing_unit_as_not_installed() -> None:
    async def missing(command: tuple[str, ...]) -> CommandResult:
        if command[0] == "nvidia-smi":
            return CommandResult(
                0,
                (
                    "NVIDIA RTX 6000 Ada Generation, 0, 768, 49140\n"
                    if command[2].startswith("--query-gpu=")
                    else ""
                ),
            )
        if command[0] == "ss":
            return CommandResult(0, "")
        assert command[:3] == ("systemctl", "--user", "show")
        return CommandResult(4, "LoadState=not-found\n", "Unit could not be found")

    result = asyncio.run(SlotInspector(missing).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.UNKNOWN
    assert result.installation_status is RendererInstallationStatus.NOT_INSTALLED
    assert result.reason == "conflictstudio-ltx-gpu0.service is not installed"


def test_slot_inspector_runs_all_live_sources_when_gpu_details_fail() -> None:
    commands = InspectionCommands(active_model=None)
    original = commands.__call__

    async def gpu_failure(command: tuple[str, ...]) -> CommandResult:
        if command[0] == "nvidia-smi" and command[2].startswith("--query-gpu="):
            commands.calls.append(command)
            return CommandResult(1, "", "nvidia-smi failed")
        return await original(command)

    result = asyncio.run(SlotInspector(gpu_failure).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.UNKNOWN
    assert result.reason == "Could not inspect GPU model or memory"
    systemd_calls = [
        call
        for call in commands.calls
        if call[:3] == ("systemctl", "--user", "show")
    ]
    assert len(systemd_calls) == 4
    assert any(call[0] == "ss" for call in commands.calls)
    assert len([call for call in commands.calls if call[0] == "nvidia-smi"]) == 2


def test_slot_inspector_blocks_unattributed_gpu_memory() -> None:
    commands = InspectionCommands(active_model=None, memory_used_mib=1536)
    result = asyncio.run(SlotInspector(commands).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.EXTERNAL_OCCUPIED
    assert result.reason == "GPU memory is used without an attributable compute process"
    assert result.memory_used_mib == 1536


def test_slot_inspector_accepts_idle_driver_memory_below_reserved_memory() -> None:
    commands = InspectionCommands(
        active_model=None,
        memory_used_mib=14,
        memory_reserved_mib=768,
    )
    result = asyncio.run(SlotInspector(commands).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.AVAILABLE
    assert result.memory_used_mib == 14


@pytest.mark.parametrize(
    ("slot", "precision", "unit_name", "port", "profile_path"),
    [
        (
            GpuSlotName.GPU0,
            Precision.BF16,
            "conflictstudio-ltx25-bf16-gpu0.service",
            8188,
            "/comfyui/gpu0/ltx25-bf16",
        ),
        (
            GpuSlotName.GPU0,
            Precision.INT8,
            "conflictstudio-ltx25-int8-gpu0.service",
            8188,
            "/comfyui/gpu0/ltx25-int8",
        ),
        (
            GpuSlotName.GPU1,
            Precision.BF16,
            "conflictstudio-ltx25-bf16-gpu1.service",
            8189,
            "/comfyui/gpu1/ltx25-bf16",
        ),
        (
            GpuSlotName.GPU1,
            Precision.INT8,
            "conflictstudio-ltx25-int8-gpu1.service",
            8189,
            "/comfyui/gpu1/ltx25-int8",
        ),
    ],
)
def test_ltx25_profile_allowlist_has_exact_runtime_and_data_paths(
    slot: GpuSlotName,
    precision: Precision,
    unit_name: str,
    port: int,
    profile_path: str,
) -> None:
    unit = UNITS_BY_SLOT_PROFILE[(slot, ModelName.LTX_25, precision)]

    assert unit.name == unit_name
    assert unit.port == port
    assert unit.python == (
        "/home/team/zhanghaonan/LTX-2.5-ComfyUI/"
        ".uv-python/cpython-3.13.15-linux-x86_64-gnu/bin/python3.13"
    )
    assert unit.working_directory == "/home/team/zhanghaonan/LTX-2.5-ComfyUI"
    assert any(value.endswith(profile_path + "/input") for value in unit.required_exec_tokens)
    assert unit.required_exec_tokens[-2:] == (
        "--database-url",
        "sqlite:////home/team/zhanghaonan/TAFFC/ConflictStudio-data"
        f"{profile_path}/database/comfyui.sqlite3",
    )


class SequenceInspector:
    def __init__(self, values: list[SlotInspection]) -> None:
        self.values = values
        self.calls: list[GpuSlotName] = []

    async def inspect(self, slot: GpuSlotName) -> SlotInspection:
        self.calls.append(slot)
        if not self.values:
            raise AssertionError("Unexpected inspection")
        return self.values.pop(0)


class ServiceCommands:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    async def __call__(self, command: tuple[str, ...]) -> CommandResult:
        self.calls.append(command)
        return CommandResult(0, "")


def _owned(model: ModelName) -> SlotInspection:
    slug = "ltx" if model is ModelName.LTX else "h3"
    return SlotInspection(
        GpuSlotName.GPU0,
        GpuAvailability.AVAILABLE,
        model,
        f"conflictstudio-{slug}-gpu0.service",
    )


def _owned_profile(precision: Precision) -> SlotInspection:
    definition = UNITS_BY_SLOT_PROFILE[(GpuSlotName.GPU0, ModelName.LTX_25, precision)]
    return SlotInspection(
        GpuSlotName.GPU0,
        GpuAvailability.AVAILABLE,
        ModelName.LTX_25,
        definition.name,
        loaded_precision=precision,
    )


def _client(handler) -> httpx.AsyncClient:  # type: ignore[no-untyped-def]
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_model_reuse_does_not_start_or_stop_a_unit() -> None:
    initial = _owned_profile(Precision.INT8)
    ready = _owned_profile(Precision.INT8)
    inspector = SequenceInspector([initial, ready])
    commands = ServiceCommands()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=OBJECT_INFO)

    async def scenario() -> None:
        client = _client(handler)
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            result = await controller.ensure_model(
                GpuSlotName.GPU0,
                ModelName.LTX_25,
                precision=Precision.INT8,
                confirm_switch=False,
            )
        finally:
            await client.aclose()
        assert result is ready

    asyncio.run(scenario())
    assert commands.calls == []
    assert inspector.calls == [GpuSlotName.GPU0, GpuSlotName.GPU0]
    assert [request.url.path for request in requests] == ["/object_info"]


@pytest.mark.parametrize(
    ("changed", "expected_code"),
    [
        (_owned(ModelName.H3), "model_service_changed"),
        (_owned_profile(Precision.BF16), "model_service_changed"),
        (
            SlotInspection(
                GpuSlotName.GPU0,
                GpuAvailability.AVAILABLE,
                ModelName.LTX_25,
                UNITS_BY_SLOT_PROFILE[
                    (GpuSlotName.GPU0, ModelName.LTX_25, Precision.BF16)
                ].name,
                loaded_precision=Precision.INT8,
            ),
            "model_service_changed",
        ),
        (
            SlotInspection(
                GpuSlotName.GPU0,
                GpuAvailability.EXTERNAL_OCCUPIED,
                ModelName.LTX_25,
                UNITS_BY_SLOT_PROFILE[
                    (GpuSlotName.GPU0, ModelName.LTX_25, Precision.INT8)
                ].name,
                reason="An unknown process uses the GPU",
                loaded_precision=Precision.INT8,
            ),
            "gpu_slot_unavailable",
        ),
    ],
)
def test_model_reuse_rejects_service_drift_after_readiness(
    changed: SlotInspection,
    expected_code: str,
) -> None:
    inspector = SequenceInspector([_owned_profile(Precision.INT8), changed])
    commands = ServiceCommands()

    async def scenario() -> None:
        client = _client(lambda _: httpx.Response(200, json=OBJECT_INFO))
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.ensure_model(
                    GpuSlotName.GPU0,
                    ModelName.LTX_25,
                    precision=Precision.INT8,
                    confirm_switch=False,
                )
            assert error.value.code == expected_code
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []
    assert inspector.calls == [GpuSlotName.GPU0, GpuSlotName.GPU0]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"LtxRequiredNode": {}},
        {"LtxRequiredNode": {}, "SaveVideo": []},
    ],
)
def test_model_readiness_rejects_empty_missing_or_invalid_required_nodes(
    payload: object,
) -> None:
    inspector = SequenceInspector([_owned(ModelName.LTX)])
    commands = ServiceCommands()

    async def scenario() -> None:
        client = _client(lambda _: httpx.Response(200, json=payload))
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
            readiness_timeout_seconds=0.003,
            readiness_poll_seconds=0.001,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.ensure_model(
                    GpuSlotName.GPU0,
                    ModelName.LTX,
                    confirm_switch=False,
                )
            assert error.value.code == "model_service_readiness_timeout"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []


def test_unconfirmed_model_switch_is_rejected_without_commands() -> None:
    inspector = SequenceInspector([_owned(ModelName.H3)])
    commands = ServiceCommands()
    client = _client(lambda _: pytest.fail("HTTP must not be called"))

    async def scenario() -> None:
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.ensure_model(GpuSlotName.GPU0, ModelName.LTX, confirm_switch=False)
            assert error.value.code == "model_switch_confirmation_required"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []


def test_unconfirmed_precision_switch_is_rejected_without_commands() -> None:
    inspector = SequenceInspector([_owned_profile(Precision.BF16)])
    commands = ServiceCommands()
    client = _client(lambda _: pytest.fail("HTTP must not be called"))

    async def scenario() -> None:
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.ensure_model(
                    GpuSlotName.GPU0,
                    ModelName.LTX_25,
                    precision=Precision.INT8,
                    confirm_switch=False,
                )
            assert error.value.code == "model_switch_confirmation_required"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []


def test_confirmed_switch_reinspects_then_stops_and_starts_exact_units() -> None:
    inspector = SequenceInspector(
        [
            _owned(ModelName.H3),
            _owned(ModelName.H3),
            SlotInspection(GpuSlotName.GPU0, GpuAvailability.AVAILABLE, None),
            _owned(ModelName.LTX),
        ]
    )
    commands = ServiceCommands()
    client = _client(lambda _: httpx.Response(200, json=OBJECT_INFO))

    async def scenario() -> None:
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            result = await controller.ensure_model(GpuSlotName.GPU0, ModelName.LTX, confirm_switch=True)
        finally:
            await client.aclose()
        assert result.loaded_model is ModelName.LTX

    asyncio.run(scenario())
    assert commands.calls == [
        ("systemctl", "--user", "stop", "conflictstudio-h3-gpu0.service"),
        ("systemctl", "--user", "start", "conflictstudio-ltx-gpu0.service"),
    ]
    assert inspector.calls == [GpuSlotName.GPU0] * 4


def test_readiness_timeout_never_falls_back_to_another_slot_or_model() -> None:
    inspector = SequenceInspector(
        [
            SlotInspection(GpuSlotName.GPU0, GpuAvailability.AVAILABLE, None),
            SlotInspection(GpuSlotName.GPU0, GpuAvailability.AVAILABLE, None),
        ]
    )
    commands = ServiceCommands()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(503)

    async def scenario() -> None:
        client = _client(handler)
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
            readiness_timeout_seconds=0.003,
            readiness_poll_seconds=0.001,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.ensure_model(GpuSlotName.GPU0, ModelName.LTX, confirm_switch=False)
            assert error.value.code == "model_service_readiness_timeout"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == [
        ("systemctl", "--user", "start", "conflictstudio-ltx-gpu0.service")
    ]
    assert requests
    assert {request.url for request in requests} == {httpx.URL("http://127.0.0.1:8188/object_info")}


def test_model_start_rechecks_and_blocks_a_new_external_occupant() -> None:
    inspector = SequenceInspector(
        [
            SlotInspection(GpuSlotName.GPU0, GpuAvailability.AVAILABLE, None),
            SlotInspection(
                GpuSlotName.GPU0,
                GpuAvailability.EXTERNAL_OCCUPIED,
                None,
                reason="An unknown process uses the GPU",
            ),
        ]
    )
    commands = ServiceCommands()
    client = _client(lambda _: pytest.fail("HTTP must not be called"))

    async def scenario() -> None:
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.ensure_model(
                    GpuSlotName.GPU0,
                    ModelName.LTX_25,
                    precision=Precision.INT8,
                    confirm_switch=False,
                )
            assert error.value.code == "gpu_slot_unavailable"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []


def test_model_controller_never_stops_a_changed_or_unknown_unit() -> None:
    changed = SlotInspection(
        GpuSlotName.GPU0,
        GpuAvailability.EXTERNAL_OCCUPIED,
        ModelName.H3,
        "conflictstudio-h3-gpu0.service",
        "unknown listener",
    )
    inspector = SequenceInspector([_owned(ModelName.H3), changed])
    commands = ServiceCommands()
    client = _client(lambda _: pytest.fail("HTTP must not be called"))

    async def scenario() -> None:
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.ensure_model(GpuSlotName.GPU0, ModelName.LTX, confirm_switch=True)
            assert error.value.code == "gpu_slot_unavailable"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []


def test_release_model_stops_only_the_reinspected_owned_unit() -> None:
    inspector = SequenceInspector(
        [
            _owned(ModelName.LTX),
            _owned(ModelName.LTX),
            SlotInspection(GpuSlotName.GPU0, GpuAvailability.AVAILABLE, None),
        ]
    )
    commands = ServiceCommands()
    client = _client(lambda _: pytest.fail("HTTP must not be called"))

    async def scenario() -> None:
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            released = await controller.release_model(
                GpuSlotName.GPU0,
                expected_model=ModelName.LTX,
                expected_precision=None,
                expected_unit="conflictstudio-ltx-gpu0.service",
            )
        finally:
            await client.aclose()
        assert released.loaded_model is None

    asyncio.run(scenario())
    assert commands.calls == [
        ("systemctl", "--user", "stop", "conflictstudio-ltx-gpu0.service"),
    ]


def test_release_model_rejects_an_empty_slot_without_commands() -> None:
    inspector = SequenceInspector(
        [SlotInspection(GpuSlotName.GPU0, GpuAvailability.AVAILABLE, None)]
    )
    commands = ServiceCommands()
    client = _client(lambda _: pytest.fail("HTTP must not be called"))

    async def scenario() -> None:
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.release_model(
                    GpuSlotName.GPU0,
                    expected_model=ModelName.LTX,
                    expected_precision=None,
                    expected_unit="conflictstudio-ltx-gpu0.service",
                )
            assert error.value.code == "model_not_loaded"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []


def test_release_model_rejects_precision_change_during_ownership_reinspection() -> None:
    inspector = SequenceInspector(
        [_owned_profile(Precision.BF16), _owned_profile(Precision.INT8)]
    )
    commands = ServiceCommands()
    client = _client(lambda _: pytest.fail("HTTP must not be called"))

    async def scenario() -> None:
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.release_model(
                    GpuSlotName.GPU0,
                    expected_model=ModelName.LTX_25,
                    expected_precision=Precision.BF16,
                    expected_unit="conflictstudio-ltx25-bf16-gpu0.service",
                )
            assert error.value.code == "model_service_changed"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []


def test_release_model_rejects_a_profile_changed_before_the_first_inspection() -> None:
    inspector = SequenceInspector([_owned_profile(Precision.INT8)])
    commands = ServiceCommands()
    client = _client(lambda _: pytest.fail("HTTP must not be called"))

    async def scenario() -> None:
        controller = ModelServiceController(
            inspector,
            commands,
            client,
            required_node_types=REQUIRED_NODE_TYPES,
        )
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.release_model(
                    GpuSlotName.GPU0,
                    expected_model=ModelName.LTX_25,
                    expected_precision=Precision.BF16,
                    expected_unit="conflictstudio-ltx25-bf16-gpu0.service",
                )
            assert error.value.code == "model_service_changed"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []
