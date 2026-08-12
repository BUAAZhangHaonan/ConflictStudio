from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping

import httpx

from backend.adapters.gpu import (
    PORTS,
    UNITS_BY_NAME,
    UNITS_BY_SLOT_MODEL,
    CommandRunner,
    SlotInspection,
    SlotInspector,
    run_command,
)
from backend.adapters.renderer import RendererGatewayError
from backend.domain.enums import GpuAvailability, GpuSlotName, ModelName


class ModelServiceController:
    def __init__(
        self,
        inspector: SlotInspector,
        command_runner: CommandRunner = run_command,
        http_client: httpx.AsyncClient | None = None,
        *,
        required_node_types: Mapping[ModelName, frozenset[str]],
        slot_urls: Mapping[GpuSlotName, str] | None = None,
        readiness_timeout_seconds: float = 60.0,
        readiness_poll_seconds: float = 0.5,
    ) -> None:
        if readiness_timeout_seconds <= 0 or readiness_poll_seconds <= 0:
            raise ValueError("Readiness timing must be positive")
        self._inspector = inspector
        self._run = command_runner
        self._client = http_client or httpx.AsyncClient()
        self._owns_client = http_client is None
        self._slot_urls = dict(slot_urls) if slot_urls is not None else {
            slot: f"http://127.0.0.1:{port}" for slot, port in PORTS.items()
        }
        self._required_node_types = {
            model: frozenset(node_types)
            for model, node_types in required_node_types.items()
        }
        if set(self._required_node_types) != set(ModelName) or any(
            not node_types
            or any(type(node_type) is not str or not node_type for node_type in node_types)
            for node_types in self._required_node_types.values()
        ):
            raise ValueError("Every renderer model requires a non-empty node class set")
        if set(self._slot_urls) != set(GpuSlotName) or any(
            not isinstance(url, str) or not url for url in self._slot_urls.values()
        ):
            raise ValueError("One model service URL is required for every GPU slot")
        self._readiness_timeout = readiness_timeout_seconds
        self._readiness_poll = readiness_poll_seconds

    async def ensure_model(
        self,
        slot: GpuSlotName,
        model: ModelName,
        *,
        confirm_switch: bool,
    ) -> SlotInspection:
        target = UNITS_BY_SLOT_MODEL[(slot, model)]
        inspection = await self._inspector.inspect(slot)
        self._require_available(inspection)

        if inspection.loaded_model is model:
            if inspection.owned_unit != target.name:
                raise RendererGatewayError("model_service_untrusted", "The loaded model unit is not owned")
            await self._wait_ready(slot, model)
            return inspection

        if inspection.loaded_model is not None:
            if not confirm_switch:
                raise RendererGatewayError(
                    "model_switch_confirmation_required",
                    "Explicit confirmation is required to switch the model on this GPU",
                )
            await self._stop_owned_model(slot, inspection)

        result = await self._run(("systemctl", "--user", "start", target.name))
        if result.returncode != 0:
            raise RendererGatewayError(
                "model_service_start_failed",
                f"Could not start {target.name}: {result.stderr.strip() or 'systemctl failed'}",
            )
        await self._wait_ready(slot, model)
        ready = await self._inspector.inspect(slot)
        self._require_available(ready)
        if ready.loaded_model is not model or ready.owned_unit != target.name:
            raise RendererGatewayError(
                "model_service_untrusted",
                "The started model service does not match the requested allowlisted unit",
            )
        return ready

    async def _stop_owned_model(self, slot: GpuSlotName, previous: SlotInspection) -> None:
        current = await self._inspector.inspect(slot)
        self._require_available(current)
        unit_name = current.owned_unit
        if (
            unit_name is None
            or unit_name != previous.owned_unit
            or current.loaded_model is not previous.loaded_model
        ):
            raise RendererGatewayError(
                "model_service_changed",
                "The model service ownership changed before it could be stopped",
            )
        definition = UNITS_BY_NAME.get(unit_name)
        if definition is None or definition.slot is not slot:
            raise RendererGatewayError("model_service_untrusted", "The model unit is not allowlisted for this GPU")
        result = await self._run(("systemctl", "--user", "stop", definition.name))
        if result.returncode != 0:
            raise RendererGatewayError(
                "model_service_stop_failed",
                f"Could not stop {definition.name}: {result.stderr.strip() or 'systemctl failed'}",
            )

    @staticmethod
    def _require_available(inspection: SlotInspection) -> None:
        if inspection.availability is not GpuAvailability.AVAILABLE:
            raise RendererGatewayError(
                "gpu_slot_unavailable",
                inspection.reason or "The requested GPU slot is not safely available",
            )

    async def _wait_ready(self, slot: GpuSlotName, model: ModelName) -> None:
        deadline = time.monotonic() + self._readiness_timeout
        url = f"{self._slot_urls[slot].rstrip('/')}/object_info"
        last_error = "no successful response"
        required = self._required_node_types[model]
        while True:
            try:
                response = await self._client.get(url)
                if response.is_success:
                    try:
                        payload = response.json()
                    except ValueError:
                        last_error = "invalid JSON"
                    else:
                        if (
                            isinstance(payload, dict)
                            and required <= set(payload)
                            and all(isinstance(payload[node_type], dict) for node_type in required)
                        ):
                            return
                        last_error = "required workflow nodes are missing"
                else:
                    last_error = f"HTTP {response.status_code}"
            except httpx.HTTPError as error:
                last_error = str(error)
            if time.monotonic() >= deadline:
                raise RendererGatewayError(
                    "model_service_readiness_timeout",
                    f"The model service did not become ready: {last_error}",
                )
            await asyncio.sleep(self._readiness_poll)

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()
