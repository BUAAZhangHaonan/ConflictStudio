from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass

from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.adapters.renderer import (
    RendererGateway,
    RendererGatewayError,
    RendererInstallationStatus,
    RendererSlotState,
)
from backend.domain.enums import (
    GpuAvailability,
    GpuSlotName,
    JobStatus,
    ModelName,
    Precision,
    validate_model_precision,
)
from backend.domain.models import GpuSlot, Job, JobItem, utc_now

from .errors import ServiceError, not_found, revision_conflict


ACTIVE_JOB_STATUSES = {JobStatus.QUEUED, JobStatus.RUNNING}


@dataclass(frozen=True)
class GpuSlotSnapshot:
    slot: GpuSlotName
    availability: GpuAvailability
    loaded_model: ModelName | None
    loaded_precision: Precision | None
    service_status: str
    gpu_name: str | None
    memory_used_mib: int | None
    memory_total_mib: int | None
    active_job_id: int | None
    revision: int
    checked_at: str
    owned_unit: str | None
    live_availability: GpuAvailability
    status_reason: str | None


class GpuSlotService:
    def __init__(self, database: Database, renderer: RendererGateway) -> None:
        self.database = database
        self.renderer = renderer
        self._operation_locks = {slot: asyncio.Lock() for slot in GpuSlotName}

    async def inspect_all(self) -> list[GpuSlotSnapshot]:
        snapshots = await self.inspect_slots(list(GpuSlotName))
        return [snapshots[slot] for slot in GpuSlotName]

    async def inspect_slots(
        self,
        slots: list[GpuSlotName],
    ) -> dict[GpuSlotName, GpuSlotSnapshot]:
        ordered_slots = self._ordered_slots(slots)
        async with self._serialize(ordered_slots):
            return await self._inspect_slots(ordered_slots)

    @asynccontextmanager
    async def submission_inspection(
        self,
        slots: list[GpuSlotName],
    ) -> AsyncIterator[dict[GpuSlotName, GpuSlotSnapshot]]:
        ordered_slots = self._ordered_slots(slots)
        async with self._serialize(ordered_slots):
            yield await self._inspect_slots(ordered_slots)

    async def _inspect_slots(
        self,
        slots: tuple[GpuSlotName, ...],
    ) -> dict[GpuSlotName, GpuSlotSnapshot]:
        inspections: dict[GpuSlotName, RendererSlotState] = {}
        for slot in slots:
            inspections[slot] = await self.renderer.probe(slot)
        return self._reconcile(inspections)

    async def release(
        self,
        slot: GpuSlotName,
        expected_revision: int,
    ) -> GpuSlotSnapshot:
        async with self._serialize((slot,)):
            snapshot = (await self._inspect_slots((slot,)))[slot]
            self._require_releasable(snapshot, expected_revision)

            with self.database.immediate_session() as session:
                row = session.get(GpuSlot, slot)
                if row is None:
                    raise not_found("gpuSlot", slot.value)
                if row.revision != snapshot.revision:
                    raise revision_conflict("gpuSlot", slot.value, snapshot.revision, row.revision)
                row.availability = GpuAvailability.UNKNOWN
                row.active_job_id = None
                row.revision += 1
                row.checked_at = utc_now()
                release_revision = row.revision
                session.flush()

            try:
                released = await self.renderer.release(
                    slot,
                    expected_model=snapshot.loaded_model,
                    expected_precision=snapshot.loaded_precision,
                    expected_unit=snapshot.owned_unit,
                )
            except RendererGatewayError as error:
                raise self._release_error(error) from error
            except Exception as error:
                raise ServiceError(
                    503,
                    "model_service_unavailable",
                    "The model service could not be released",
                ) from error

            result = self._reconcile({slot: released}, expected_revisions={slot: release_revision})[slot]
            if (
                result.live_availability is not GpuAvailability.AVAILABLE
                or result.loaded_model is not None
                or result.loaded_precision is not None
                or result.owned_unit is not None
            ):
                raise ServiceError(
                    409,
                    "gpu_state_changed",
                    "The GPU state changed during model release",
                    {"slot": slot.value, "reason": result.status_reason},
                )
            return result

    @staticmethod
    def _ordered_slots(slots: list[GpuSlotName]) -> tuple[GpuSlotName, ...]:
        selected = set(slots)
        return tuple(slot for slot in GpuSlotName if slot in selected)

    @asynccontextmanager
    async def _serialize(
        self,
        slots: tuple[GpuSlotName, ...],
    ) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            for slot in slots:
                await stack.enter_async_context(self._operation_locks[slot])
            yield

    def validate_submission(
        self,
        snapshots: dict[GpuSlotName, GpuSlotSnapshot],
        *,
        expected_revisions: dict[GpuSlotName, int],
        requested_model: ModelName,
        requested_precision: Precision | None,
        confirm_model_switch: bool,
    ) -> None:
        requested_profiles = {
            slot: [(requested_model, requested_precision)]
            for slot in snapshots
        }
        self.validate_profiles(
            snapshots,
            expected_revisions=expected_revisions,
            requested_profiles=requested_profiles,
            confirm_model_switch=confirm_model_switch,
        )

    def validate_profiles(
        self,
        snapshots: dict[GpuSlotName, GpuSlotSnapshot],
        *,
        expected_revisions: dict[GpuSlotName, int],
        requested_profiles: dict[GpuSlotName, list[tuple[ModelName, Precision | None]]],
        confirm_model_switch: bool,
    ) -> None:
        if set(expected_revisions) != set(snapshots):
            raise ServiceError(422, "validation_error", "GPU revisions must match the selected GPU slots")
        if set(requested_profiles) != set(snapshots) or any(not values for values in requested_profiles.values()):
            raise ServiceError(422, "validation_error", "GPU profiles must match the selected GPU slots")

        for slot, snapshot in snapshots.items():
            if snapshot.live_availability is not GpuAvailability.AVAILABLE:
                raise ServiceError(
                    409,
                    "gpu_occupation_untrusted",
                    snapshot.status_reason or "The selected GPU has an unknown or external occupation",
                    {
                        "slot": slot.value,
                        "availability": snapshot.live_availability.value,
                        "reason": snapshot.status_reason,
                    },
                )
            if snapshot.active_job_id is not None:
                raise ServiceError(
                    409,
                    "gpu_unavailable",
                    "The selected GPU is assigned to an active job",
                    {"slot": slot.value, "activeJobId": snapshot.active_job_id},
                )
            expected = expected_revisions[slot]
            if snapshot.revision != expected:
                raise ServiceError(
                    409,
                    "gpu_state_changed",
                    "The selected GPU state changed",
                    {
                        "slot": slot.value,
                        "expectedRevision": expected,
                        "actualRevision": snapshot.revision,
                    },
                )
            profiles = requested_profiles[slot]
            if any(not validate_model_precision(model, precision) for model, precision in profiles):
                raise ServiceError(422, "validation_error", "A requested model and precision do not match")
            loaded_profile = (snapshot.loaded_model, snapshot.loaded_precision)
            requested_profile = profiles[0]
            if (
                snapshot.loaded_model is not None
                and loaded_profile != requested_profile
                and not confirm_model_switch
            ):
                raise ServiceError(
                    409,
                    "model_switch_confirmation_required",
                    "The GPU is loaded with a different model or precision",
                    {
                        "slot": slot.value,
                        "loadedModel": snapshot.loaded_model.value,
                        "loadedPrecision": (
                            snapshot.loaded_precision.value if snapshot.loaded_precision else None
                        ),
                        "requestedModel": requested_profile[0].value,
                        "requestedPrecision": requested_profile[1].value if requested_profile[1] else None,
                    },
                )
            if len(set(profiles)) > 1 and not confirm_model_switch:
                next_profile = next(profile for profile in profiles[1:] if profile != profiles[0])
                raise ServiceError(
                    409,
                    "model_switch_confirmation_required",
                    "The serial test changes the model or precision between comparisons",
                    {
                        "slot": slot.value,
                        "loadedModel": requested_profile[0].value,
                        "loadedPrecision": requested_profile[1].value if requested_profile[1] else None,
                        "requestedModel": next_profile[0].value,
                        "requestedPrecision": next_profile[1].value if next_profile[1] else None,
                    },
                )

    def _require_releasable(
        self,
        snapshot: GpuSlotSnapshot,
        expected_revision: int,
    ) -> None:
        if snapshot.live_availability is not GpuAvailability.AVAILABLE:
            raise ServiceError(
                409,
                "gpu_ownership_unproven",
                snapshot.status_reason or "The GPU process ownership could not be proven",
                {
                    "slot": snapshot.slot.value,
                    "availability": snapshot.live_availability.value,
                    "reason": snapshot.status_reason,
                },
            )
        if snapshot.active_job_id is not None:
            raise ServiceError(
                409,
                "gpu_unavailable",
                "The GPU is assigned to an active job",
                {"slot": snapshot.slot.value, "activeJobId": snapshot.active_job_id},
            )
        if snapshot.revision != expected_revision:
            raise revision_conflict(
                "gpuSlot",
                snapshot.slot.value,
                expected_revision,
                snapshot.revision,
            )
        if snapshot.loaded_model is None:
            raise ServiceError(
                409,
                "model_not_loaded",
                "No controlled model is loaded on this GPU",
                {"slot": snapshot.slot.value},
            )
        if snapshot.owned_unit is None:
            raise ServiceError(
                409,
                "gpu_ownership_unproven",
                "The loaded process is not proven to belong to the configured ConflictStudio user unit",
                {"slot": snapshot.slot.value},
            )

    def _reconcile(
        self,
        inspections: dict[GpuSlotName, RendererSlotState],
        *,
        expected_revisions: dict[GpuSlotName, int] | None = None,
    ) -> dict[GpuSlotName, GpuSlotSnapshot]:
        timestamp = utc_now()
        snapshots: dict[GpuSlotName, GpuSlotSnapshot] = {}
        with self.database.immediate_session() as session:
            active_jobs, conflicting_slots = self._active_jobs(session, set(inspections))
            for slot, inspection in inspections.items():
                row = session.get(GpuSlot, slot)
                if row is None:
                    raise not_found("gpuSlot", slot.value)
                if expected_revisions is not None:
                    expected = expected_revisions[slot]
                    if row.revision != expected:
                        raise revision_conflict("gpuSlot", slot.value, expected, row.revision)

                self._validate_inspection(inspection, slot)
                live_availability = inspection.availability
                loaded_model = inspection.loaded_model
                loaded_precision = inspection.loaded_precision
                if loaded_model is None and loaded_precision is not None:
                    raise ServiceError(
                        503,
                        "invalid_gpu_inspection",
                        "The live GPU inspection returned precision without a loaded model",
                        {"slot": slot.value},
                    )
                if loaded_model is not None and not validate_model_precision(loaded_model, loaded_precision):
                    raise ServiceError(
                        503,
                        "invalid_gpu_inspection",
                        "The live GPU inspection returned an invalid model and precision pair",
                        {"slot": slot.value},
                    )

                active_job = active_jobs.get(slot)
                status_reason = inspection.reason
                if slot in conflicting_slots:
                    availability = GpuAvailability.UNKNOWN
                    active_job_id = None
                    status_reason = "Multiple active jobs claim this GPU slot"
                elif active_job is not None:
                    active_job_id, job_status = active_job
                    availability = (
                        GpuAvailability.RESERVED
                        if job_status is JobStatus.QUEUED
                        else GpuAvailability.BUSY
                    )
                else:
                    active_job_id = None
                    availability = live_availability

                persisted_active_job_id = (
                    active_job_id
                    if availability in {GpuAvailability.RESERVED, GpuAvailability.BUSY}
                    else None
                )
                current = (
                    row.availability,
                    row.loaded_model,
                    row.loaded_precision,
                    row.active_job_id,
                )
                reconciled = (
                    availability,
                    loaded_model,
                    loaded_precision,
                    persisted_active_job_id,
                )
                if current != reconciled:
                    row.availability = availability
                    row.loaded_model = loaded_model
                    row.loaded_precision = loaded_precision
                    row.active_job_id = persisted_active_job_id
                    row.revision += 1
                row.checked_at = timestamp
                session.flush()

                snapshots[slot] = GpuSlotSnapshot(
                    slot=slot,
                    availability=availability,
                    loaded_model=loaded_model,
                    loaded_precision=loaded_precision,
                    service_status=inspection.service_status,
                    gpu_name=inspection.gpu_name,
                    memory_used_mib=inspection.memory_used_mib,
                    memory_total_mib=inspection.memory_total_mib,
                    active_job_id=active_job_id,
                    revision=row.revision,
                    checked_at=timestamp,
                    owned_unit=inspection.owned_unit,
                    live_availability=live_availability,
                    status_reason=status_reason,
                )
        return snapshots

    @staticmethod
    def _active_jobs(
        session: Session,
        slots: set[GpuSlotName],
    ) -> tuple[
        dict[GpuSlotName, tuple[int, JobStatus]],
        set[GpuSlotName],
    ]:
        rows = session.exec(
            select(JobItem.gpu_slot, Job.id, Job.status)
            .join(Job, Job.id == JobItem.job_id)
            .where(JobItem.gpu_slot.in_(slots), Job.status.in_(ACTIVE_JOB_STATUSES))
            .distinct()
            .order_by(Job.id)
        ).all()
        found: dict[GpuSlotName, tuple[int, JobStatus]] = {}
        conflicts: set[GpuSlotName] = set()
        for slot, job_id, status in rows:
            if slot in found and found[slot][0] != job_id:
                conflicts.add(slot)
                continue
            found[slot] = (job_id, status)
        return found, conflicts

    @staticmethod
    def _validate_inspection(
        inspection: RendererSlotState,
        slot: GpuSlotName,
    ) -> None:
        valid_statuses = {"running", "stopped", "unknown", "notInstalled", "notConfigured"}
        optional_text = (inspection.owned_unit, inspection.reason, inspection.gpu_name)
        memory = (inspection.memory_used_mib, inspection.memory_total_mib)
        valid = (
            inspection.slot is slot
            and isinstance(inspection.availability, GpuAvailability)
            and (inspection.loaded_model is None or isinstance(inspection.loaded_model, ModelName))
            and (
                inspection.loaded_precision is None
                or isinstance(inspection.loaded_precision, Precision)
            )
            and isinstance(inspection.installation_status, RendererInstallationStatus)
            and inspection.service_status in valid_statuses
            and all(value is None or (isinstance(value, str) and bool(value)) for value in optional_text)
            and all(value is None or (type(value) is int and value >= 0) for value in memory)
            and (memory[0] is None) == (memory[1] is None)
            and (
                memory[0] is None
                or memory[1] is None
                or memory[0] <= memory[1]
            )
        )
        if not valid:
            raise ServiceError(
                503,
                "invalid_gpu_inspection",
                "The renderer did not return a valid live GPU inspection",
                {"slot": slot.value},
            )

    @staticmethod
    def _release_error(error: RendererGatewayError) -> ServiceError:
        conflict_codes = {
            "gpu_slot_unavailable",
            "model_not_loaded",
            "model_service_changed",
            "model_service_untrusted",
        }
        status_code = 409 if error.code in conflict_codes else 503
        return ServiceError(status_code, error.code, error.message)
