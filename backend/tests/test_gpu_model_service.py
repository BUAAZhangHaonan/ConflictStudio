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
)
from backend.adapters.model_service import ModelServiceController
from backend.adapters.renderer import RendererGatewayError
from backend.domain.enums import GpuAvailability, GpuSlotName, ModelName


def _unit_show(unit: UnitDefinition, *, active: bool) -> str:
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
            f"ExecStart={' '.join(unit.required_exec_tokens)}",
        )
    )


class InspectionCommands:
    def __init__(
        self,
        *,
        active_model: ModelName | None,
        gpu_pids: Iterable[int] = (),
        listener_pids: Iterable[int] = (),
        foreign_pids: Iterable[int] = (),
    ) -> None:
        self.active_model = active_model
        self.gpu_pids = set(gpu_pids)
        self.listener_pids = set(listener_pids)
        self.foreign_pids = set(foreign_pids)
        self.calls: list[tuple[str, ...]] = []

    async def __call__(self, command: tuple[str, ...]) -> CommandResult:
        self.calls.append(command)
        if command[:3] == ("systemctl", "--user", "show"):
            unit = next(value for value in UNIT_DEFINITIONS if value.name == command[3])
            active = unit.slot is GpuSlotName.GPU0 and unit.model is self.active_model
            return CommandResult(0, _unit_show(unit, active=active))
        if command[0] == "nvidia-smi":
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
                if value.slot is GpuSlotName.GPU0 and value.model is self.active_model
            )
            return CommandResult(0, "\0".join(unit.required_exec_tokens) + "\0")
        if command[0] == "cat" and command[-1].endswith("/cgroup"):
            if pid in self.foreign_pids or self.active_model is None:
                return CommandResult(0, "0::/user.slice/foreign.service\n")
            unit = next(
                value
                for value in UNIT_DEFINITIONS
                if value.slot is GpuSlotName.GPU0 and value.model is self.active_model
            )
            return CommandResult(
                0,
                f"0::/user.slice/user-1000.slice/user@1000.service/app.slice/{unit.name}\n",
            )
        raise AssertionError(f"Unexpected command: {command}")


def test_slot_inspector_accepts_exact_owned_process() -> None:
    commands = InspectionCommands(active_model=ModelName.LTX, gpu_pids={4100}, listener_pids={4100})
    result = asyncio.run(SlotInspector(commands).inspect(GpuSlotName.GPU0))

    assert result.availability is GpuAvailability.AVAILABLE
    assert result.loaded_model is ModelName.LTX
    assert result.owned_unit == "conflictstudio-ltx-gpu0.service"
    assert all(isinstance(call, tuple) for call in commands.calls)


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


def _client(handler) -> httpx.AsyncClient:  # type: ignore[no-untyped-def]
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_model_reuse_does_not_start_or_stop_a_unit() -> None:
    inspector = SequenceInspector([_owned(ModelName.LTX)])
    commands = ServiceCommands()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"nodes": {}})

    async def scenario() -> None:
        client = _client(handler)
        controller = ModelServiceController(inspector, commands, client)
        try:
            result = await controller.ensure_model(GpuSlotName.GPU0, ModelName.LTX, confirm_switch=False)
        finally:
            await client.aclose()
        assert result.loaded_model is ModelName.LTX

    asyncio.run(scenario())
    assert commands.calls == []
    assert [request.url.path for request in requests] == ["/object_info"]


def test_unconfirmed_model_switch_is_rejected_without_commands() -> None:
    inspector = SequenceInspector([_owned(ModelName.H3)])
    commands = ServiceCommands()
    client = _client(lambda _: pytest.fail("HTTP must not be called"))

    async def scenario() -> None:
        controller = ModelServiceController(inspector, commands, client)
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.ensure_model(GpuSlotName.GPU0, ModelName.LTX, confirm_switch=False)
            assert error.value.code == "model_switch_required"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []


def test_confirmed_switch_reinspects_then_stops_and_starts_exact_units() -> None:
    inspector = SequenceInspector([_owned(ModelName.H3), _owned(ModelName.H3), _owned(ModelName.LTX)])
    commands = ServiceCommands()
    client = _client(lambda _: httpx.Response(200, json={}))

    async def scenario() -> None:
        controller = ModelServiceController(inspector, commands, client)
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
    assert inspector.calls == [GpuSlotName.GPU0, GpuSlotName.GPU0, GpuSlotName.GPU0]


def test_readiness_timeout_never_falls_back_to_another_slot_or_model() -> None:
    inspector = SequenceInspector(
        [SlotInspection(GpuSlotName.GPU0, GpuAvailability.AVAILABLE, None)]
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
        controller = ModelServiceController(inspector, commands, client)
        try:
            with pytest.raises(RendererGatewayError) as error:
                await controller.ensure_model(GpuSlotName.GPU0, ModelName.LTX, confirm_switch=True)
            assert error.value.code == "gpu_slot_unavailable"
        finally:
            await client.aclose()

    asyncio.run(scenario())
    assert commands.calls == []
