from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from contextlib import contextmanager
from threading import Lock
from typing import Iterator

from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.adapters.renderer import (
    CancelOutcome,
    RenderRequest,
    RendererGateway,
    RendererGatewayError,
)
from backend.domain.enums import (
    GenerationAttemptStatus,
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobStatus,
)
from backend.domain.models import (
    BatchVideoInputSnapshot,
    GpuSlot,
    GenerationAttempt,
    Job,
    JobEvent,
    JobItem,
    JobItemPromptResult,
    utc_now,
)
from backend.domain.schemas import JobCancelRequest

from .errors import ServiceError, not_found, revision_conflict, state_conflict
from .prompts import GeneratedPrompt, PreparedPrompt, PromptResult, PromptService


TERMINAL_STATUSES = {JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED}


class JobExecutor:
    def __init__(
        self,
        database: Database,
        prompts: PromptService,
        renderer: RendererGateway,
        *,
        scan_interval_seconds: float = 1.0,
    ) -> None:
        if scan_interval_seconds <= 0:
            raise ValueError("The scan interval must be positive")
        self.database = database
        self.prompts = prompts
        self.renderer = renderer
        self.scan_interval_seconds = scan_interval_seconds
        self._wake = asyncio.Event()
        self._loop_task: asyncio.Task[None] | None = None
        self._active_tasks: dict[int, asyncio.Task[None]] = {}
        self._event_subscribers: dict[asyncio.Event, asyncio.AbstractEventLoop] = {}
        self._event_subscribers_lock = Lock()
        self._stopping = False

    async def start(self) -> None:
        if self._loop_task is not None:
            return
        self._stopping = False
        self.recover()
        self._loop_task = asyncio.create_task(self._run_loop(), name="conflictstudio-job-executor")
        self.notify()

    async def stop(self) -> None:
        loop_task = self._loop_task
        if loop_task is None:
            return
        self._stopping = True
        self._wake.set()
        await loop_task
        active = list(self._active_tasks.values())
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)
        self._active_tasks.clear()
        self._loop_task = None

    def notify(self) -> None:
        if not self._stopping:
            self._wake.set()

    def subscribe_events(self) -> asyncio.Event:
        signal = asyncio.Event()
        with self._event_subscribers_lock:
            self._event_subscribers[signal] = asyncio.get_running_loop()
        return signal

    def unsubscribe_events(self, signal: asyncio.Event) -> None:
        with self._event_subscribers_lock:
            self._event_subscribers.pop(signal, None)

    def notify_events(self) -> None:
        with self._event_subscribers_lock:
            subscribers = tuple(self._event_subscribers.items())
        stale: list[asyncio.Event] = []
        for signal, loop in subscribers:
            try:
                loop.call_soon_threadsafe(signal.set)
            except RuntimeError:
                stale.append(signal)
        if stale:
            with self._event_subscribers_lock:
                for signal in stale:
                    self._event_subscribers.pop(signal, None)

    @contextmanager
    def _event_session(self) -> Iterator[Session]:
        with self.database.immediate_session() as session:
            yield session
        self.notify_events()

    async def cancel_job(self, job_id: int, payload: JobCancelRequest) -> None:
        task_to_cancel: asyncio.Task[None] | None = None
        with self._event_session() as session:
            job = session.get(Job, job_id)
            if job is None:
                raise not_found("job", job_id)
            if job.revision != payload.expected_revision:
                raise revision_conflict("job", job_id, payload.expected_revision, job.revision)
            if job.status in TERMINAL_STATUSES:
                raise state_conflict("job", job_id, "A finished job cannot be cancelled")

            timestamp = utc_now()
            if job.status is JobStatus.QUEUED:
                self._cancel_items(session, job, timestamp)
                job.status = JobStatus.CANCELLED
                job.cancel_requested_at = timestamp
                job.finished_at = timestamp
                job.updated_at = timestamp
                job.revision += 1
                self._release_owned_slots(session, job.id, GpuAvailability.AVAILABLE, timestamp)
                self._append_event(
                    session,
                    job,
                    "JobCancelled",
                    reason="The job was cancelled before it started",
                )
            elif job.cancel_requested_at is None:
                task_to_cancel = self._active_tasks.get(job_id)
                if task_to_cancel is None:
                    raise state_conflict("job", job_id, "The running job is not owned by this executor")
                job.cancel_requested_at = timestamp
                job.updated_at = timestamp
                job.revision += 1
                self._append_event(session, job, "CancelRequested")
            else:
                task_to_cancel = self._active_tasks.get(job_id)
                if task_to_cancel is None:
                    raise state_conflict("job", job_id, "The running job is not owned by this executor")

        if task_to_cancel is not None:
            task_to_cancel.cancel()

    def recover(self) -> None:
        with self._event_session() as session:
            running_jobs = session.exec(
                select(Job).where(Job.status == JobStatus.RUNNING).order_by(Job.id)
            ).all()
            for job in running_jobs:
                timestamp = utc_now()
                self._fail_unfinished_items(
                    session,
                    job,
                    "interrupted_by_restart",
                    "The application stopped while this job was running",
                    timestamp,
                )
                job.status = JobStatus.FAILED
                job.failure_code = "interrupted_by_restart"
                job.failure_reason = "The application stopped while this job was running"
                job.finished_at = timestamp
                job.updated_at = timestamp
                job.revision += 1
                self._sync_counts(session, job)
                self._release_owned_slots(session, job.id, GpuAvailability.UNKNOWN, timestamp)
                self._append_event(session, job, "JobInterrupted", code=job.failure_code)
                self._append_event(session, job, "JobFailed", code=job.failure_code, reason=job.failure_reason)

            queued_jobs = session.exec(
                select(Job).where(Job.status == JobStatus.QUEUED).order_by(Job.id)
            ).all()
            for job in queued_jobs:
                if not self._reservations_match(session, job):
                    self._fail_queued_reservation(session, job)

            occupied_slots = session.exec(
                select(GpuSlot).where(
                    GpuSlot.availability.in_([GpuAvailability.RESERVED, GpuAvailability.BUSY])
                )
            ).all()
            for slot in occupied_slots:
                owner = session.get(Job, slot.active_job_id) if slot.active_job_id is not None else None
                if owner is None or owner.status not in {JobStatus.QUEUED, JobStatus.RUNNING}:
                    slot.availability = GpuAvailability.UNKNOWN
                    slot.active_job_id = None
                    slot.revision += 1
                    slot.checked_at = utc_now()

    async def _run_loop(self) -> None:
        while not self._stopping:
            if self.renderer.configured:
                for job_id in self._claim_queued_jobs():
                    if job_id in self._active_tasks:
                        continue
                    task = asyncio.create_task(self._run_job(job_id), name=f"conflictstudio-job-{job_id}")
                    self._active_tasks[job_id] = task
                    task.add_done_callback(lambda completed, value=job_id: self._task_finished(value, completed))
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self.scan_interval_seconds)
            except TimeoutError:
                pass

    def _task_finished(self, job_id: int, task: asyncio.Task[None]) -> None:
        if self._active_tasks.get(job_id) is task:
            self._active_tasks.pop(job_id, None)
        if not task.cancelled():
            task.exception()
        self.notify()

    def _claim_queued_jobs(self) -> list[int]:
        claimed: list[int] = []
        with self._event_session() as session:
            jobs = session.exec(select(Job).where(Job.status == JobStatus.QUEUED).order_by(Job.id)).all()
            for job in jobs:
                if not self._reservations_match(session, job):
                    self._fail_queued_reservation(session, job)
                    continue
                timestamp = utc_now()
                job.status = JobStatus.RUNNING
                job.started_at = timestamp
                job.updated_at = timestamp
                job.revision += 1
                for slot in self._job_slots(session, job.id):
                    row = session.get(GpuSlot, slot)
                    if row is None:
                        raise RuntimeError(f"Missing GPU slot {slot.value}")
                    row.availability = GpuAvailability.BUSY
                    row.revision += 1
                    row.checked_at = timestamp
                self._append_event(session, job, "JobStarted")
                claimed.append(job.id)
        return claimed

    async def _run_job(self, job_id: int) -> None:
        try:
            with self.database.read_session() as session:
                items = session.exec(
                    select(JobItem).where(JobItem.job_id == job_id).order_by(JobItem.sequence)
                ).all()
                channels: dict[GpuSlotName, list[int]] = defaultdict(list)
                for item in items:
                    channels[item.gpu_slot].append(item.id)
            await asyncio.gather(
                *(self._run_channel(job_id, item_ids) for item_ids in channels.values())
            )
            self._finalize_job(job_id)
        except asyncio.CancelledError:
            if self._stopping:
                raise
            self._finish_cancelled_job(job_id)
        except Exception:
            self._fail_job_execution(job_id)

    async def _run_channel(self, job_id: int, item_ids: list[int]) -> None:
        for item_id in item_ids:
            if self._cancel_requested(job_id):
                raise asyncio.CancelledError
            await self._run_item(job_id, item_id)

    async def _run_item(self, job_id: int, item_id: int) -> None:
        prompt_id: str | None = None
        gpu_slot: GpuSlotName | None = None
        try:
            job, item, snapshot = self._begin_item(job_id, item_id)
            gpu_slot = item.gpu_slot
            prepared = self._prepared_prompt(snapshot)
            result = await self.prompts.complete(prepared, snapshot.category)
            self._store_prompt_result(job_id, item_id, result)

            request = RenderRequest(
                job_id=job_id,
                job_item_id=item_id,
                item_sequence=item.sequence,
                gpu_slot=item.gpu_slot,
                model=snapshot.model,
                category=snapshot.category,
                confirm_model_switch=job.confirm_model_switch,
                seed=snapshot.seed,
                width=snapshot.width,
                height=snapshot.height,
                fps=snapshot.fps,
                frame_count=snapshot.frame_count,
                positive_prompt=result.final_positive_prompt,
                negative_prompt=result.final_negative_prompt,
                dialogue=result.dialogue,
                vt_text=result.vt_text,
                expected_has_audio=snapshot.expected_has_audio,
            )
            prompt_id = await self.renderer.submit(request)
            if not getattr(self.renderer, "persists_render_state", False):
                self._record_rendering(job_id, item_id, prompt_id)
            await self.renderer.wait(item.gpu_slot, prompt_id)
            self._complete_item(job_id, item_id)
        except asyncio.CancelledError:
            cancel_outcome: CancelOutcome | None = None
            if gpu_slot is not None and prompt_id is not None:
                try:
                    cancel_outcome = await self.renderer.cancel(gpu_slot, prompt_id)
                except Exception as error:
                    code, reason = self._failure_details(error)
                    self._fail_item(job_id, item_id, code, reason)
                    raise
            if cancel_outcome is CancelOutcome.ALREADY_COMPLETED:
                self._complete_item(job_id, item_id)
            elif not self._stopping:
                self._cancel_item(job_id, item_id)
            raise
        except Exception as error:
            code, reason = self._failure_details(error)
            self._fail_item(job_id, item_id, code, reason)

    def _begin_item(
        self,
        job_id: int,
        item_id: int,
    ) -> tuple[Job, JobItem, BatchVideoInputSnapshot]:
        with self._event_session() as session:
            job = session.get(Job, job_id)
            item = session.get(JobItem, item_id)
            if job is None or item is None or item.job_id != job_id:
                raise RuntimeError("The queued job item no longer exists")
            if job.cancel_requested_at is not None:
                raise asyncio.CancelledError
            if job.status is not JobStatus.RUNNING:
                raise RuntimeError("The queued job is no longer running")
            if item.status is not JobStatus.QUEUED:
                raise RuntimeError("The queued job item is not ready to start")
            snapshot = session.get(BatchVideoInputSnapshot, item.input_snapshot_id)
            if snapshot is None:
                raise RuntimeError("The immutable job input no longer exists")
            timestamp = utc_now()
            item.status = JobStatus.RUNNING
            item.stage = JobItemStage.PROMPT_GENERATING
            item.updated_at = timestamp
            item.revision += 1
            self._append_event(session, job, "ItemPromptStarted", item=item)
            session.flush()
            return job, item, snapshot

    @staticmethod
    def _prepared_prompt(snapshot: BatchVideoInputSnapshot) -> PreparedPrompt:
        fixed_output: GeneratedPrompt | None = None
        if snapshot.fixed_positive_prompt is not None:
            fixed_output = GeneratedPrompt(
                positivePrompt=snapshot.fixed_positive_prompt,
                dialogue=snapshot.fixed_dialogue,
                vtText=snapshot.fixed_vt_text,
                trueEmotionDescription=snapshot.fixed_true_emotion_description,
            )
        return PreparedPrompt(
            policy_version=snapshot.policy_version,
            category=snapshot.category,
            true_emotion=snapshot.true_emotion,
            apparent_emotion=snapshot.apparent_emotion,
            gender=snapshot.gender,
            ethnicity=snapshot.ethnicity,
            system_input=snapshot.system_input,
            user_input=snapshot.user_input,
            final_negative_prompt=snapshot.final_negative_prompt,
            fixed_output=fixed_output,
        )

    def _store_prompt_result(self, job_id: int, item_id: int, result: PromptResult) -> None:
        with self._event_session() as session:
            job = session.get(Job, job_id)
            item = session.get(JobItem, item_id)
            if job is None or item is None:
                raise RuntimeError("The running job item no longer exists")
            timestamp = utc_now()
            session.add(
                JobItemPromptResult(
                    job_item_id=item_id,
                    policy_version=result.policy_version,
                    system_input=result.system_input,
                    user_input=result.user_input,
                    raw_structured_response=result.raw_structured_response,
                    final_positive_prompt=result.final_positive_prompt,
                    final_negative_prompt=result.final_negative_prompt,
                    dialogue=result.dialogue,
                    vt_text=result.vt_text,
                    true_emotion_description=result.true_emotion_description,
                    created_at=timestamp,
                )
            )
            item.stage = JobItemStage.PROMPT_READY
            item.updated_at = timestamp
            item.revision += 1
            job.prepared_count += 1
            job.updated_at = timestamp
            job.revision += 1
            self._append_event(session, job, "ItemPromptReady", item=item)

    def _record_rendering(self, job_id: int, item_id: int, prompt_id: str) -> None:
        with self._event_session() as session:
            job = session.get(Job, job_id)
            item = session.get(JobItem, item_id)
            if job is None or item is None:
                raise RuntimeError("The running job item no longer exists")
            timestamp = utc_now()
            item.stage = JobItemStage.RENDERING
            item.renderer_prompt_id = prompt_id
            item.updated_at = timestamp
            item.revision += 1
            self._append_event(session, job, "ItemRenderStarted", item=item)

    def _complete_item(self, job_id: int, item_id: int) -> None:
        with self._event_session() as session:
            job = session.get(Job, job_id)
            item = session.get(JobItem, item_id)
            if job is None or item is None:
                raise RuntimeError("The running job item no longer exists")
            if getattr(self.renderer, "persists_render_state", False) and (
                item.source_asset_id is None or item.primary_asset_id is None
            ):
                raise RuntimeError("The renderer did not persist completed media")
            timestamp = utc_now()
            item.status = JobStatus.COMPLETED
            item.stage = JobItemStage.COMPLETED
            item.updated_at = timestamp
            item.revision += 1
            job.completed_count += 1
            job.updated_at = timestamp
            job.revision += 1
            self._append_event(session, job, "ItemCompleted", item=item)

    def _fail_item(self, job_id: int, item_id: int, code: str, reason: str) -> None:
        with self._event_session() as session:
            job = session.get(Job, job_id)
            item = session.get(JobItem, item_id)
            if job is None or item is None or item.status in TERMINAL_STATUSES:
                return
            timestamp = utc_now()
            attempt = session.exec(
                select(GenerationAttempt).where(
                    GenerationAttempt.job_item_id == item_id,
                    GenerationAttempt.status == GenerationAttemptStatus.RUNNING,
                )
            ).one_or_none()
            if attempt is not None:
                attempt.status = GenerationAttemptStatus.FAILED
                attempt.failure_reason = reason
                attempt.finished_at = timestamp
            item.status = JobStatus.FAILED
            item.failure_code = code
            item.failure_reason = reason
            item.updated_at = timestamp
            item.revision += 1
            job.failed_count += 1
            job.updated_at = timestamp
            job.revision += 1
            self._append_event(session, job, "ItemFailed", item=item, code=code, reason=reason)

    def _cancel_item(self, job_id: int, item_id: int) -> None:
        with self._event_session() as session:
            job = session.get(Job, job_id)
            item = session.get(JobItem, item_id)
            if job is None or item is None or item.status in TERMINAL_STATUSES:
                return
            timestamp = utc_now()
            attempt = session.exec(
                select(GenerationAttempt).where(
                    GenerationAttempt.job_item_id == item_id,
                    GenerationAttempt.status == GenerationAttemptStatus.RUNNING,
                )
            ).one_or_none()
            if attempt is not None:
                attempt.status = GenerationAttemptStatus.FAILED
                attempt.failure_reason = "The render was cancelled"
                attempt.finished_at = timestamp
            item.status = JobStatus.CANCELLED
            item.updated_at = timestamp
            item.revision += 1
            self._append_event(session, job, "ItemCancelled", item=item)

    def _finalize_job(self, job_id: int) -> None:
        with self._event_session() as session:
            job = session.get(Job, job_id)
            if job is None or job.status in TERMINAL_STATUSES:
                return
            if job.cancel_requested_at is not None:
                self._finish_cancelled_job_in_session(session, job)
                return
            timestamp = utc_now()
            self._sync_counts(session, job)
            job.status = JobStatus.FAILED if job.failed_count else JobStatus.COMPLETED
            job.failure_code = "item_failed" if job.failed_count else None
            job.failure_reason = (
                f"{job.failed_count} of {job.total_count} job items failed" if job.failed_count else None
            )
            job.finished_at = timestamp
            job.updated_at = timestamp
            job.revision += 1
            self._release_owned_slots(session, job.id, GpuAvailability.AVAILABLE, timestamp)
            self._append_event(
                session,
                job,
                "JobFailed" if job.failed_count else "JobCompleted",
                code=job.failure_code,
                reason=job.failure_reason,
            )

    def _finish_cancelled_job(self, job_id: int) -> None:
        with self._event_session() as session:
            job = session.get(Job, job_id)
            if job is None or job.status in TERMINAL_STATUSES:
                return
            self._finish_cancelled_job_in_session(session, job)

    def _finish_cancelled_job_in_session(self, session: Session, job: Job) -> None:
        timestamp = utc_now()
        self._cancel_items(session, job, timestamp)
        job.status = JobStatus.CANCELLED
        job.cancel_requested_at = job.cancel_requested_at or timestamp
        job.finished_at = timestamp
        job.updated_at = timestamp
        job.revision += 1
        self._sync_counts(session, job)
        self._release_owned_slots(session, job.id, GpuAvailability.AVAILABLE, timestamp)
        self._append_event(session, job, "JobCancelled")

    def _fail_job_execution(self, job_id: int) -> None:
        with self._event_session() as session:
            job = session.get(Job, job_id)
            if job is None or job.status in TERMINAL_STATUSES:
                return
            timestamp = utc_now()
            self._fail_unfinished_items(
                session,
                job,
                "job_execution_failed",
                "The job stopped because its execution state became invalid",
                timestamp,
            )
            job.status = JobStatus.FAILED
            job.failure_code = "job_execution_failed"
            job.failure_reason = "The job stopped because its execution state became invalid"
            job.finished_at = timestamp
            job.updated_at = timestamp
            job.revision += 1
            self._sync_counts(session, job)
            self._release_owned_slots(session, job.id, GpuAvailability.UNKNOWN, timestamp)
            self._append_event(session, job, "JobFailed", code=job.failure_code, reason=job.failure_reason)

    def _fail_queued_reservation(self, session: Session, job: Job) -> None:
        timestamp = utc_now()
        self._fail_unfinished_items(
            session,
            job,
            "gpu_reservation_lost",
            "The GPU reservation no longer matches this queued job",
            timestamp,
        )
        job.status = JobStatus.FAILED
        job.failure_code = "gpu_reservation_lost"
        job.failure_reason = "The GPU reservation no longer matches this queued job"
        job.finished_at = timestamp
        job.updated_at = timestamp
        job.revision += 1
        self._sync_counts(session, job)
        self._release_owned_slots(session, job.id, GpuAvailability.UNKNOWN, timestamp)
        self._append_event(session, job, "JobFailed", code=job.failure_code, reason=job.failure_reason)

    def _reservations_match(self, session: Session, job: Job) -> bool:
        slots = self._job_slots(session, job.id)
        if not slots:
            return False
        for slot in slots:
            row = session.get(GpuSlot, slot)
            if (
                row is None
                or row.availability is not GpuAvailability.RESERVED
                or row.active_job_id != job.id
            ):
                return False
        return True

    @staticmethod
    def _job_slots(session: Session, job_id: int) -> list[GpuSlotName]:
        items = session.exec(
            select(JobItem).where(JobItem.job_id == job_id).order_by(JobItem.sequence)
        ).all()
        return list(dict.fromkeys(item.gpu_slot for item in items))

    def _cancel_requested(self, job_id: int) -> bool:
        with self.database.read_session() as session:
            job = session.get(Job, job_id)
            return job is None or job.cancel_requested_at is not None or job.status is not JobStatus.RUNNING

    def _cancel_items(self, session: Session, job: Job, timestamp: str) -> None:
        items = session.exec(select(JobItem).where(JobItem.job_id == job.id)).all()
        for item in items:
            if item.status not in TERMINAL_STATUSES:
                item.status = JobStatus.CANCELLED
                item.updated_at = timestamp
                item.revision += 1
                self._append_event(session, job, "ItemCancelled", item=item)

    def _fail_unfinished_items(
        self,
        session: Session,
        job: Job,
        code: str,
        reason: str,
        timestamp: str,
    ) -> None:
        items = session.exec(select(JobItem).where(JobItem.job_id == job.id)).all()
        changed: list[JobItem] = []
        for item in items:
            if item.status not in TERMINAL_STATUSES:
                attempt = session.exec(
                    select(GenerationAttempt).where(
                        GenerationAttempt.job_item_id == item.id,
                        GenerationAttempt.status == GenerationAttemptStatus.RUNNING,
                    )
                ).one_or_none()
                if attempt is not None:
                    attempt.status = GenerationAttemptStatus.FAILED
                    attempt.failure_reason = reason
                    attempt.finished_at = timestamp
                item.status = JobStatus.FAILED
                item.failure_code = code
                item.failure_reason = reason
                item.updated_at = timestamp
                item.revision += 1
                changed.append(item)
        self._sync_counts(session, job)
        for item in changed:
            self._append_event(session, job, "ItemFailed", item=item, code=code, reason=reason)

    @staticmethod
    def _sync_counts(session: Session, job: Job) -> None:
        items = session.exec(select(JobItem).where(JobItem.job_id == job.id)).all()
        prompt_results = session.exec(
            select(JobItemPromptResult).where(
                JobItemPromptResult.job_item_id.in_([item.id for item in items])
            )
        ).all()
        job.prepared_count = len(prompt_results)
        job.completed_count = sum(item.status is JobStatus.COMPLETED for item in items)
        job.failed_count = sum(item.status is JobStatus.FAILED for item in items)

    @staticmethod
    def _release_owned_slots(
        session: Session,
        job_id: int,
        availability: GpuAvailability,
        timestamp: str,
    ) -> None:
        rows = session.exec(select(GpuSlot).where(GpuSlot.active_job_id == job_id)).all()
        for row in rows:
            row.availability = availability
            row.active_job_id = None
            row.revision += 1
            row.checked_at = timestamp

    @staticmethod
    def _append_event(
        session: Session,
        job: Job,
        event_type: str,
        *,
        item: JobItem | None = None,
        code: str | None = None,
        reason: str | None = None,
    ) -> None:
        payload: dict[str, int | str | None] = {
            "preparedCount": job.prepared_count,
            "completedCount": job.completed_count,
            "failedCount": job.failed_count,
            "totalCount": job.total_count,
        }
        if item is not None:
            payload["sequence"] = item.sequence
            payload["gpuSlot"] = item.gpu_slot.value
        if code is not None:
            payload["failureCode"] = code
        if reason is not None:
            payload["failureReason"] = reason
        session.add(
            JobEvent(
                job_id=job.id,
                item_id=item.id if item is not None else None,
                event_type=event_type,
                payload_json=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                created_at=utc_now(),
            )
        )

    @staticmethod
    def _failure_details(error: Exception) -> tuple[str, str]:
        if isinstance(error, ServiceError):
            return error.code, error.message
        if isinstance(error, RendererGatewayError):
            return error.code, error.message
        return "item_execution_failed", "The job item failed during execution"
