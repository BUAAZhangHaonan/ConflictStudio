from __future__ import annotations

import asyncio
import re
import shlex
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from backend.adapters.renderer import RendererSlotState
from backend.domain.enums import GpuAvailability, GpuSlotName, ModelName


SERVICE_USER = "zhanghaonan"
USER_UNIT_DIRECTORY = "/home/team/zhanghaonan/.config/systemd/user"


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str = ""


CommandRunner = Callable[[tuple[str, ...]], Awaitable[CommandResult]]


@dataclass(frozen=True)
class UnitDefinition:
    name: str
    slot: GpuSlotName
    model: ModelName
    python: str
    working_directory: str
    port: int

    @property
    def fragment_path(self) -> str:
        return f"{USER_UNIT_DIRECTORY}/{self.name}"

    @property
    def required_exec_tokens(self) -> tuple[str, ...]:
        gpu_directory = f"/home/team/zhanghaonan/TAFFC/ConflictStudio-data/{self.slot.value.lower()}"
        return (
            self.python,
            f"{self.working_directory}/main.py",
            "--listen",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--disable-auto-launch",
            "--input-directory",
            f"{gpu_directory}/input",
            "--output-directory",
            f"{gpu_directory}/output",
            "--temp-directory",
            f"{gpu_directory}/temp",
            "--user-directory",
            f"{gpu_directory}/user",
        )


UNIT_DEFINITIONS = (
    UnitDefinition(
        "conflictstudio-ltx-gpu0.service",
        GpuSlotName.GPU0,
        ModelName.LTX,
        "/home/team/lvshuyang/anaconda3/envs/comfyui/bin/python",
        "/home/team/lvshuyang/ComfyUI",
        8188,
    ),
    UnitDefinition(
        "conflictstudio-ltx-gpu1.service",
        GpuSlotName.GPU1,
        ModelName.LTX,
        "/home/team/lvshuyang/anaconda3/envs/comfyui/bin/python",
        "/home/team/lvshuyang/ComfyUI",
        8189,
    ),
    UnitDefinition(
        "conflictstudio-h3-gpu0.service",
        GpuSlotName.GPU0,
        ModelName.H3,
        "/home/team/zhanghaonan/H3-ComfyUI/.venv/bin/python",
        "/home/team/zhanghaonan/H3-ComfyUI",
        8188,
    ),
    UnitDefinition(
        "conflictstudio-h3-gpu1.service",
        GpuSlotName.GPU1,
        ModelName.H3,
        "/home/team/zhanghaonan/H3-ComfyUI/.venv/bin/python",
        "/home/team/zhanghaonan/H3-ComfyUI",
        8189,
    ),
)

UNITS_BY_NAME = {unit.name: unit for unit in UNIT_DEFINITIONS}
UNITS_BY_SLOT_MODEL = {(unit.slot, unit.model): unit for unit in UNIT_DEFINITIONS}
PORTS = {GpuSlotName.GPU0: 8188, GpuSlotName.GPU1: 8189}
GPU_INDICES = {GpuSlotName.GPU0: 0, GpuSlotName.GPU1: 1}


@dataclass(frozen=True)
class UnitState:
    definition: UnitDefinition
    load_state: str
    active_state: str
    fragment_path: str
    main_pid: int
    control_group: str
    exec_start: str
    trusted: bool


@dataclass(frozen=True)
class SlotInspection(RendererSlotState):
    owned_unit: str | None = None
    reason: str | None = None


async def run_command(command: tuple[str, ...]) -> CommandResult:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    return CommandResult(
        process.returncode or 0,
        stdout.decode(errors="replace"),
        stderr.decode(errors="replace"),
    )


class SlotInspector:
    def __init__(self, command_runner: CommandRunner = run_command) -> None:
        self._run = command_runner

    async def inspect(self, slot: GpuSlotName) -> SlotInspection:
        definitions = tuple(unit for unit in UNIT_DEFINITIONS if unit.slot is slot)
        unit_states: list[UnitState] = []
        for definition in definitions:
            state = await self._unit_state(definition)
            if state is None:
                return self._unknown(slot, f"Could not inspect {definition.name}")
            unit_states.append(state)

        accepted_states = {"active", "inactive"}
        if any(
            state.load_state != "loaded"
            or state.active_state not in accepted_states
            or not state.trusted
            for state in unit_states
        ):
            return self._unknown(slot, "A model unit has an untrusted systemd state")
        active = [state for state in unit_states if state.active_state == "active"]
        if len(active) > 1:
            return self._unknown(slot, "More than one model unit is active on the slot")
        if active and not active[0].trusted:
            return self._unknown(slot, "The active model unit does not match its allowlisted definition")

        gpu_pids = await self._gpu_pids(slot)
        listener_pids = await self._listener_pids(slot)
        if gpu_pids is None or listener_pids is None:
            return self._unknown(slot, "Could not inspect GPU processes or the fixed port listener")

        relevant_pids = gpu_pids | listener_pids
        process_owners: dict[int, UnitState | None] = {}
        for pid in relevant_pids:
            process = await self._process(pid)
            if process is None:
                return self._unknown(slot, f"Could not inspect process {pid}")
            process_owners[pid] = self._owner(process, active)

        if any(owner is None for owner in process_owners.values()):
            return SlotInspection(
                slot=slot,
                availability=GpuAvailability.EXTERNAL_OCCUPIED,
                loaded_model=active[0].definition.model if active else None,
                owned_unit=active[0].definition.name if active else None,
                reason="An unknown process uses the GPU or fixed listener port",
            )

        if active:
            state = active[0]
            if state.main_pid not in listener_pids:
                return self._unknown(slot, "The active model unit does not own the fixed listener port")
            return SlotInspection(
                slot=slot,
                availability=GpuAvailability.AVAILABLE,
                loaded_model=state.definition.model,
                owned_unit=state.definition.name,
            )

        if relevant_pids:
            return SlotInspection(
                slot=slot,
                availability=GpuAvailability.EXTERNAL_OCCUPIED,
                loaded_model=None,
                reason="A process uses the GPU or fixed listener port without an active allowlisted unit",
            )
        return SlotInspection(slot=slot, availability=GpuAvailability.AVAILABLE, loaded_model=None)

    async def _unit_state(self, definition: UnitDefinition) -> UnitState | None:
        command = (
            "systemctl",
            "--user",
            "show",
            definition.name,
            "--property=LoadState,ActiveState,FragmentPath,MainPID,ControlGroup,ExecStart",
            "--no-pager",
        )
        result = await self._run(command)
        if result.returncode != 0:
            return None
        values: dict[str, str] = {}
        for line in result.stdout.splitlines():
            key, separator, value = line.partition("=")
            if separator:
                values[key] = value
        try:
            main_pid = int(values["MainPID"])
        except (KeyError, ValueError):
            return None
        exec_start = values.get("ExecStart", "")
        control_group = values.get("ControlGroup", "")
        configuration_matches = (
            values.get("FragmentPath") == definition.fragment_path
            and self._parse_exec_start(exec_start) == definition.required_exec_tokens
        )
        process_metadata_matches = (
            values.get("ActiveState") == "inactive"
            and main_pid == 0
            and not control_group
        ) or (
            values.get("ActiveState") == "active"
            and main_pid > 0
            and control_group.endswith(f"/{definition.name}")
        )
        trusted = configuration_matches and process_metadata_matches
        return UnitState(
            definition=definition,
            load_state=values.get("LoadState", ""),
            active_state=values.get("ActiveState", ""),
            fragment_path=values.get("FragmentPath", ""),
            main_pid=main_pid,
            control_group=control_group,
            exec_start=exec_start,
            trusted=trusted,
        )

    @staticmethod
    def _parse_exec_start(value: str) -> tuple[str, ...] | None:
        value = value.strip()
        if not value:
            return None
        if value.startswith("{"):
            match = re.fullmatch(
                r"\{\s*path=.*?;\s*argv\[\]=(.*?);\s*.*\}",
                value,
            )
            if match is None:
                return None
            value = match.group(1).strip()
        try:
            return tuple(shlex.split(value, posix=True))
        except ValueError:
            return None

    async def _gpu_pids(self, slot: GpuSlotName) -> set[int] | None:
        command = (
            "nvidia-smi",
            f"--id={GPU_INDICES[slot]}",
            "--query-compute-apps=pid",
            "--format=csv,noheader,nounits",
        )
        result = await self._run(command)
        if result.returncode != 0:
            return None
        return self._parse_pid_lines(result.stdout)

    async def _listener_pids(self, slot: GpuSlotName) -> set[int] | None:
        command = ("ss", "-H", "-ltnp", "sport", "=", f":{PORTS[slot]}")
        result = await self._run(command)
        if result.returncode != 0:
            return None
        pids = {int(value) for value in re.findall(r"\bpid=(\d+)\b", result.stdout)}
        if result.stdout.strip() and not pids:
            return None
        return pids

    @staticmethod
    def _parse_pid_lines(output: str) -> set[int] | None:
        pids: set[int] = set()
        for line in output.splitlines():
            value = line.strip()
            if not value:
                continue
            if not value.isdecimal():
                return None
            pids.add(int(value))
        return pids

    @dataclass(frozen=True)
    class _Process:
        pid: int
        user: str
        argv: tuple[str, ...]
        cgroup: str

    async def _process(self, pid: int) -> _Process | None:
        if pid <= 0:
            return None
        stat = await self._run(("stat", "--format=%U", f"/proc/{pid}"))
        cmdline = await self._run(("cat", f"/proc/{pid}/cmdline"))
        cgroup = await self._run(("cat", f"/proc/{pid}/cgroup"))
        if stat.returncode != 0 or cmdline.returncode != 0 or cgroup.returncode != 0:
            return None
        argv = tuple(value for value in cmdline.stdout.split("\0") if value)
        if not argv:
            return None
        return self._Process(pid, stat.stdout.strip(), argv, cgroup.stdout)

    @staticmethod
    def _owner(process: _Process, active: list[UnitState]) -> UnitState | None:
        for state in active:
            required = state.definition.required_exec_tokens
            command_matches = process.argv == required
            if (
                state.trusted
                and process.user == SERVICE_USER
                and state.control_group in process.cgroup
                and command_matches
            ):
                return state
        return None

    @staticmethod
    def _unknown(slot: GpuSlotName, reason: str) -> SlotInspection:
        return SlotInspection(
            slot=slot,
            availability=GpuAvailability.UNKNOWN,
            loaded_model=None,
            reason=reason,
        )
