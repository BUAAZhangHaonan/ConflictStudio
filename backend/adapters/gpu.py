from __future__ import annotations

import asyncio
import re
import shlex
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import PurePosixPath

from backend.adapters.renderer import RendererInstallationStatus, RendererSlotState
from backend.domain.enums import GpuAvailability, GpuSlotName, ModelName, Precision


SERVICE_USER = "zhanghaonan"
USER_UNIT_DIRECTORY = "/home/team/zhanghaonan/.config/systemd/user"
DEFAULT_DATA_ROOT = "/home/team/zhanghaonan/ConflictStudio-data"
COMMAND_TIMEOUT_SECONDS = 30


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
    precision: Precision | None = None
    data_directory: str | None = None
    data_root: str = DEFAULT_DATA_ROOT

    @property
    def fragment_path(self) -> str:
        return f"{USER_UNIT_DIRECTORY}/{self.name}"

    @property
    def required_exec_tokens(self) -> tuple[str, ...]:
        gpu_directory = self.absolute_data_directory
        tokens = (
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
        if self.data_directory is not None:
            tokens += (
                "--database-url",
                f"sqlite:///{gpu_directory}/database/comfyui.sqlite3",
            )
        return tokens

    @property
    def required_environment(self) -> dict[str, str]:
        environment = {
            "CUDA_VISIBLE_DEVICES": str(GPU_INDICES[self.slot]),
            "PYTHONDONTWRITEBYTECODE": "1",
            "XDG_CACHE_HOME": f"{self.absolute_data_directory}/cache",
        }
        if self.precision is not None:
            environment.update(
                {
                    "PYTHONPATH": (
                        "/home/team/zhanghaonan/LTX-2.5-ComfyUI/"
                        ".venv/lib/python3.13/site-packages"
                    ),
                    "CONFLICTSTUDIO_LTX25_PRECISION": self.precision.value,
                }
            )
        return environment

    @property
    def required_exec_start_pre_tokens(self) -> tuple[str, ...]:
        directories = [
            f"{self.absolute_data_directory}/input",
            f"{self.absolute_data_directory}/output",
            f"{self.absolute_data_directory}/temp",
            f"{self.absolute_data_directory}/user",
            f"{self.absolute_data_directory}/cache",
        ]
        if self.data_directory is not None:
            directories.append(f"{self.absolute_data_directory}/database")
        directories.append(f"{self.data_root}/logs")
        return "/usr/bin/mkdir", "-p", *directories

    @property
    def absolute_data_directory(self) -> str:
        directory = self.data_directory or self.slot.value.lower()
        return f"{self.data_root}/{directory}"

    @property
    def relative_data_directory(self) -> str:
        root = PurePosixPath(self.data_root)
        path = PurePosixPath(self.absolute_data_directory)
        try:
            return path.relative_to(root).as_posix()
        except ValueError as error:
            raise ValueError("Renderer data directories must stay below the data root") from error


def unit_definitions(data_root: str = DEFAULT_DATA_ROOT) -> tuple[UnitDefinition, ...]:
    ltx_python = "/home/team/lvshuyang/anaconda3/envs/comfyui/bin/python"
    ltx_working_directory = "/home/team/lvshuyang/ComfyUI"
    ltx25_python = (
        "/home/team/zhanghaonan/LTX-2.5-ComfyUI/.uv-python/"
        "cpython-3.13.15-linux-x86_64-gnu/bin/python3.13"
    )
    ltx25_working_directory = "/home/team/zhanghaonan/LTX-2.5-ComfyUI"
    h3_python = "/home/team/zhanghaonan/H3-ComfyUI/.venv/bin/python"
    h3_working_directory = "/home/team/zhanghaonan/H3-ComfyUI"
    return (
        UnitDefinition(
            "conflictstudio-ltx-gpu0.service",
            GpuSlotName.GPU0,
            ModelName.LTX,
            ltx_python,
            ltx_working_directory,
            8188,
            data_root=data_root,
        ),
        UnitDefinition(
            "conflictstudio-ltx-gpu1.service",
            GpuSlotName.GPU1,
            ModelName.LTX,
            ltx_python,
            ltx_working_directory,
            8189,
            data_root=data_root,
        ),
        UnitDefinition(
            "conflictstudio-h3-gpu0.service",
            GpuSlotName.GPU0,
            ModelName.H3,
            h3_python,
            h3_working_directory,
            8188,
            data_root=data_root,
        ),
        UnitDefinition(
            "conflictstudio-h3-gpu1.service",
            GpuSlotName.GPU1,
            ModelName.H3,
            h3_python,
            h3_working_directory,
            8189,
            data_root=data_root,
        ),
        UnitDefinition(
            "conflictstudio-ltx25-bf16-gpu0.service",
            GpuSlotName.GPU0,
            ModelName.LTX_25,
            ltx25_python,
            ltx25_working_directory,
            8188,
            Precision.BF16,
            "comfyui/gpu0/ltx25-bf16",
            data_root=data_root,
        ),
        UnitDefinition(
            "conflictstudio-ltx25-int8-gpu0.service",
            GpuSlotName.GPU0,
            ModelName.LTX_25,
            ltx25_python,
            ltx25_working_directory,
            8188,
            Precision.INT8,
            "comfyui/gpu0/ltx25-int8",
            data_root=data_root,
        ),
        UnitDefinition(
            "conflictstudio-ltx25-bf16-gpu1.service",
            GpuSlotName.GPU1,
            ModelName.LTX_25,
            ltx25_python,
            ltx25_working_directory,
            8189,
            Precision.BF16,
            "comfyui/gpu1/ltx25-bf16",
            data_root=data_root,
        ),
        UnitDefinition(
            "conflictstudio-ltx25-int8-gpu1.service",
            GpuSlotName.GPU1,
            ModelName.LTX_25,
            ltx25_python,
            ltx25_working_directory,
            8189,
            Precision.INT8,
            "comfyui/gpu1/ltx25-int8",
            data_root=data_root,
        ),
    )


UNIT_DEFINITIONS = unit_definitions()

UNITS_BY_NAME = {unit.name: unit for unit in UNIT_DEFINITIONS}
UNITS_BY_SLOT_PROFILE = {
    (unit.slot, unit.model, unit.precision): unit for unit in UNIT_DEFINITIONS
}
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
    installation_status: RendererInstallationStatus = RendererInstallationStatus.INSTALLED
    listener_pids: tuple[int, ...] = ()


@dataclass(frozen=True)
class GpuDetails:
    name: str
    memory_used_mib: int
    memory_reserved_mib: int
    memory_total_mib: int


class _UnitNotInstalled(RuntimeError):
    pass


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
    def __init__(
        self,
        command_runner: CommandRunner = run_command,
        unit_definitions: tuple[UnitDefinition, ...] = UNIT_DEFINITIONS,
    ) -> None:
        self._run = command_runner
        self._unit_definitions = unit_definitions

    async def inspect(self, slot: GpuSlotName) -> SlotInspection:
        gpu_details = await self._gpu_details(slot)
        definitions = tuple(unit for unit in self._unit_definitions if unit.slot is slot)
        unit_states: list[UnitState] = []
        missing_definition: UnitDefinition | None = None
        failed_definition: UnitDefinition | None = None
        for definition in definitions:
            try:
                state = await self._unit_state(definition)
            except _UnitNotInstalled:
                missing_definition = missing_definition or definition
                continue
            if state is None:
                failed_definition = failed_definition or definition
                continue
            unit_states.append(state)

        gpu_pids = await self._gpu_pids(slot)
        listener_pids = await self._listener_pids(slot)
        if gpu_details is None:
            return self._unknown(
                slot,
                "Could not inspect GPU model or memory",
                listener_pids=listener_pids,
            )
        gpu_name = gpu_details.name
        memory_used_mib = gpu_details.memory_used_mib
        memory_total_mib = gpu_details.memory_total_mib
        if missing_definition is not None:
            return SlotInspection(
                slot=slot,
                availability=GpuAvailability.UNKNOWN,
                loaded_model=None,
                reason=f"{missing_definition.name} is not installed",
                installation_status=RendererInstallationStatus.NOT_INSTALLED,
                gpu_name=gpu_name,
                memory_used_mib=memory_used_mib,
                memory_total_mib=memory_total_mib,
                service_status="notInstalled",
                listener_pids=tuple(sorted(listener_pids or ())),
            )
        if failed_definition is not None:
            return self._unknown(
                slot,
                f"Could not inspect {failed_definition.name}",
                gpu_details=gpu_details,
                listener_pids=listener_pids,
            )

        accepted_states = {"active", "inactive"}
        if any(
            state.load_state != "loaded"
            or state.active_state not in accepted_states
            or not state.trusted
            for state in unit_states
        ):
            return self._unknown(
                slot,
                "A model unit has an untrusted systemd state",
                gpu_details=gpu_details,
            )
        active = [state for state in unit_states if state.active_state == "active"]
        if len(active) > 1:
            return self._unknown(
                slot,
                "More than one model unit is active on the slot",
                gpu_details=gpu_details,
            )
        if active and not active[0].trusted:
            return self._unknown(
                slot,
                "The active model unit does not match its allowlisted definition",
                gpu_details=gpu_details,
            )

        if gpu_pids is None or listener_pids is None:
            return self._unknown(
                slot,
                "Could not inspect GPU processes or the fixed port listener",
                gpu_details=gpu_details,
            )

        relevant_pids = gpu_pids | listener_pids
        process_owners: dict[int, UnitState | None] = {}
        for pid in relevant_pids:
            process = await self._process(pid)
            if process is None:
                return self._unknown(
                    slot,
                    f"Could not inspect process {pid}",
                    gpu_details=gpu_details,
                    listener_pids=listener_pids,
                )
            process_owners[pid] = self._owner(process, active)

        if any(owner is None for owner in process_owners.values()):
            return SlotInspection(
                slot=slot,
                availability=GpuAvailability.EXTERNAL_OCCUPIED,
                loaded_model=active[0].definition.model if active else None,
                owned_unit=active[0].definition.name if active else None,
                reason="An unknown process uses the GPU or fixed listener port",
                loaded_precision=active[0].definition.precision if active else None,
                gpu_name=gpu_name,
                memory_used_mib=memory_used_mib,
                memory_total_mib=memory_total_mib,
                service_status="running" if active else "stopped",
                listener_pids=tuple(sorted(listener_pids)),
            )

        if memory_used_mib > gpu_details.memory_reserved_mib and not gpu_pids:
            return SlotInspection(
                slot=slot,
                availability=GpuAvailability.EXTERNAL_OCCUPIED,
                loaded_model=active[0].definition.model if active else None,
                owned_unit=active[0].definition.name if active else None,
                reason="GPU memory is used without an attributable compute process",
                loaded_precision=active[0].definition.precision if active else None,
                gpu_name=gpu_name,
                memory_used_mib=memory_used_mib,
                memory_total_mib=memory_total_mib,
                service_status="running" if active else "stopped",
                listener_pids=tuple(sorted(listener_pids)),
            )

        if active:
            state = active[0]
            if state.main_pid not in listener_pids:
                return self._unknown(
                    slot,
                    "The active model unit does not own the fixed listener port",
                    gpu_details=gpu_details,
                    listener_pids=listener_pids,
                )
            return SlotInspection(
                slot=slot,
                availability=GpuAvailability.AVAILABLE,
                loaded_model=state.definition.model,
                owned_unit=state.definition.name,
                loaded_precision=state.definition.precision,
                gpu_name=gpu_name,
                memory_used_mib=memory_used_mib,
                memory_total_mib=memory_total_mib,
                service_status="running",
                listener_pids=tuple(sorted(listener_pids)),
            )

        if relevant_pids:
            return SlotInspection(
                slot=slot,
                availability=GpuAvailability.EXTERNAL_OCCUPIED,
                loaded_model=None,
                reason="A process uses the GPU or fixed listener port without an active allowlisted unit",
                gpu_name=gpu_name,
                memory_used_mib=memory_used_mib,
                memory_total_mib=memory_total_mib,
                service_status="stopped",
                listener_pids=tuple(sorted(listener_pids)),
            )
        return SlotInspection(
            slot=slot,
            availability=GpuAvailability.AVAILABLE,
            loaded_model=None,
            gpu_name=gpu_name,
            memory_used_mib=memory_used_mib,
            memory_total_mib=memory_total_mib,
            service_status="stopped",
        )

    async def _unit_state(self, definition: UnitDefinition) -> UnitState | None:
        command = (
            "systemctl",
            "--user",
            "show",
            definition.name,
            (
                "--property=LoadState,ActiveState,FragmentPath,MainPID,ControlGroup,"
                "ExecStart,ExecStartPre,ExecStop,ExecStopPost,Environment,WorkingDirectory,"
                "ReadOnlyPaths,KillMode,Restart"
            ),
            "--no-pager",
        )
        result = await self._run(command)
        if result.returncode != 0:
            message = f"{result.stdout}\n{result.stderr}".casefold()
            if "not-found" in message or "not found" in message or "could not be found" in message:
                raise _UnitNotInstalled(definition.name)
            return None
        values: dict[str, str] = {}
        for line in result.stdout.splitlines():
            key, separator, value = line.partition("=")
            if separator:
                values[key] = value
        if values.get("LoadState") == "not-found":
            raise _UnitNotInstalled(definition.name)
        try:
            main_pid = int(values["MainPID"])
        except (KeyError, ValueError):
            return None
        exec_start = values.get("ExecStart", "")
        control_group = values.get("ControlGroup", "")
        environment = self._parse_environment(values.get("Environment", ""))
        configuration_matches = (
            values.get("FragmentPath") == definition.fragment_path
            and self._parse_exec_start(exec_start) == definition.required_exec_tokens
            and self._parse_exec_start(values.get("ExecStartPre", ""))
            == definition.required_exec_start_pre_tokens
            and values.get("ExecStop", "") == ""
            and values.get("ExecStopPost", "") == ""
            and environment is not None
            and environment == definition.required_environment
            and values.get("WorkingDirectory") == definition.working_directory
            and values.get("ReadOnlyPaths") == definition.working_directory
            and values.get("KillMode") == "control-group"
            and values.get("Restart") == "no"
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

    @staticmethod
    def _parse_environment(value: str) -> dict[str, str] | None:
        try:
            tokens = shlex.split(value.strip(), posix=True)
        except ValueError:
            return None
        environment: dict[str, str] = {}
        for token in tokens:
            name, separator, setting = token.partition("=")
            if not separator or not name or name in environment:
                return None
            environment[name] = setting
        return environment

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

    async def _gpu_details(self, slot: GpuSlotName) -> GpuDetails | None:
        command = (
            "nvidia-smi",
            f"--id={GPU_INDICES[slot]}",
            "--query-gpu=name,memory.used,memory.reserved,memory.total",
            "--format=csv,noheader,nounits",
        )
        result = await self._run(command)
        if result.returncode != 0:
            return None
        rows = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if len(rows) != 1:
            return None
        values = [value.strip() for value in rows[0].split(",")]
        if (
            len(values) != 4
            or not values[0]
            or any(not value.isdecimal() for value in values[1:])
        ):
            return None
        memory_used_mib = int(values[1])
        memory_reserved_mib = int(values[2])
        memory_total_mib = int(values[3])
        if (
            memory_total_mib <= 0
            or memory_used_mib < 0
            or memory_reserved_mib < 0
            or memory_used_mib > memory_total_mib
            or memory_reserved_mib > memory_total_mib
        ):
            return None
        return GpuDetails(values[0], memory_used_mib, memory_reserved_mib, memory_total_mib)

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
        process_cgroups = {
            line.rpartition(":")[2]
            for line in process.cgroup.splitlines()
            if line.rpartition(":")[2]
        }
        for state in active:
            required = state.definition.required_exec_tokens
            command_matches = process.argv == required
            if (
                state.trusted
                and process.user == SERVICE_USER
                and state.control_group in process_cgroups
                and command_matches
            ):
                return state
        return None

    @staticmethod
    def _unknown(
        slot: GpuSlotName,
        reason: str,
        *,
        gpu_details: GpuDetails | None = None,
        listener_pids: set[int] | None = None,
    ) -> SlotInspection:
        gpu_name = gpu_details.name if gpu_details is not None else None
        memory_used_mib = gpu_details.memory_used_mib if gpu_details is not None else None
        memory_total_mib = gpu_details.memory_total_mib if gpu_details is not None else None
        return SlotInspection(
            slot=slot,
            availability=GpuAvailability.UNKNOWN,
            loaded_model=None,
            reason=reason,
            gpu_name=gpu_name,
            memory_used_mib=memory_used_mib,
            memory_total_mib=memory_total_mib,
            service_status="unknown",
            listener_pids=tuple(sorted(listener_pids or ())),
        )
