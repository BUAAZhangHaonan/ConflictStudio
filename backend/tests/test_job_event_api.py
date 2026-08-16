from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select
from starlette.websockets import WebSocketDisconnect

from backend.adapters.config import Settings
from backend.adapters.llm import PromptModelResponse, PromptResponseMetadata
from backend.app import create_app
from backend.domain.enums import (
    GenerationAttemptStatus,
    GpuSlotName,
    JobStatus,
    ModelName,
)
from backend.domain.models import GenerationAttempt, Job, JobEvent, JobItem, utc_now
from backend.tests.test_job_executor import (
    FakeRenderer,
    RecordingPromptModel,
    create_draft,
    create_resources,
    enqueue,
    make_available,
)


class SchemaFailurePromptModel:
    configured = True

    async def generate(
        self, system_input: str, user_input: str
    ) -> PromptModelResponse:
        return PromptModelResponse(
            content='{"privatePayload":"raw-response-secret"}',
            metadata=PromptResponseMetadata(
                http_status=200,
                finish_reason="length",
                request_id="request-persisted-123",
            ),
        )

    async def close(self) -> None:
        return None


def create_queued_job(
    tmp_path: Path,
    *,
    quantity: int = 3,
    prompt_model=None,  # type: ignore[no-untyped-def]
):  # type: ignore[no-untyped-def]
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    app = create_app(
        Settings(data_root=tmp_path, frontend_dist=frontend),
        prompt_model or RecordingPromptModel(),
        FakeRenderer(),
    )
    resources = create_resources(app.state.database, "event api")
    draft = create_draft(
        app.state.batch_service,
        resources,
        [GpuSlotName.GPU0],
        quantity=quantity,
    )
    make_available(app.state.database, [GpuSlotName.GPU0])
    job = asyncio.run(enqueue(app.state.batch_service, draft))
    return app, job


def test_prompt_failure_details_persist_and_replay_without_sensitive_payloads(
    tmp_path: Path,
) -> None:
    app, job = create_queued_job(
        tmp_path, quantity=1, prompt_model=SchemaFailurePromptModel()
    )
    executor = app.state.job_executor
    assert executor._claim_queued_job(job.id)
    asyncio.run(executor._run_job(job.id))

    details = {
        "httpStatus": 200,
        "finishReason": "length",
        "requestId": "request-persisted-123",
    }
    with app.state.database.read_session() as session:
        stored_item = session.exec(
            select(JobItem).where(JobItem.job_id == job.id)
        ).one()
        stored_event = session.exec(
            select(JobEvent).where(
                JobEvent.job_id == job.id,
                JobEvent.event_type == "ItemFailed",
            )
        ).one()
        assert stored_item.failure_details_json is not None
        stored_details = json.loads(stored_item.failure_details_json)
        stored_payload = json.loads(stored_event.payload_json)

    assert {key: stored_details[key] for key in details} == details
    assert stored_details["fields"]
    assert all(
        set(field) == {"path", "type", "reason"}
        for field in stored_details["fields"]
    )
    assert stored_payload["failureDetails"] == stored_details
    persisted = json.dumps(
        {"item": stored_details, "event": stored_payload}, ensure_ascii=False
    )
    for sensitive in (
        "raw-response-secret",
        "system-prompt-secret",
        "user-prompt-secret",
        "authorization",
        "api-key-secret",
    ):
        assert sensitive not in persisted.casefold()

    events = app.state.batch_service.list_job_events(job.id, 1).items
    failed_event = next(event for event in events if event.event_type == "ItemFailed")
    previous_event_id = max(event.id for event in events if event.id < failed_event.id)
    with TestClient(app) as client:
        item_payload = client.get(
            f"/api/generation-results/{job.id}/items"
        ).json()["items"][0]
        event_payload = client.get(f"/api/jobs/{job.id}/events").json()["items"]
        api_failed_event = next(
            event for event in event_payload if event["eventType"] == "ItemFailed"
        )
        assert item_payload["failureDetails"] == stored_details
        assert api_failed_event["payload"]["failureDetails"] == stored_details

        with client.websocket_connect(
            f"/api/ws/jobs/{job.id}",
            params={"afterEventId": previous_event_id},
        ) as websocket:
            websocket_event = websocket.receive_json()
        assert websocket_event["eventType"] == "ItemFailed"
        assert websocket_event["payload"]["failureDetails"] == stored_details


def append_event(
    app,  # type: ignore[no-untyped-def]
    job_id: int,
    event_type: str,
    *,
    sequence: int | None = None,
    failure_code: str | None = None,
    failure_reason: str | None = None,
) -> int:
    job = app.state.batch_service.get_job(job_id)
    payload: dict[str, int | str] = {
        "preparedCount": job.prepared_count,
        "completedCount": job.completed_count,
        "failedCount": job.failed_count,
        "totalCount": job.total_count,
    }
    if sequence is not None:
        payload["sequence"] = sequence
        payload["gpuSlot"] = GpuSlotName.GPU0.value
    if failure_code is not None:
        payload["failureCode"] = failure_code
    if failure_reason is not None:
        payload["failureReason"] = failure_reason
    with app.state.database.immediate_session() as session:
        row = JobEvent(
            job_id=job_id,
            event_type=event_type,
            payload_json=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        )
        session.add(row)
        session.flush()
        assert row.id is not None
        return row.id


def first_event_id(app, job_id: int) -> int:  # type: ignore[no-untyped-def]
    events = app.state.batch_service.list_job_events(job_id, 1)
    assert events.items
    return events.items[0].id


def test_job_items_and_events_are_stably_paginated_and_validated(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path, quantity=21)
    queued_id = first_event_id(app, job.id)
    first_id = append_event(app, job.id, "ItemPromptStarted", sequence=1)
    failure = app.state.job_executor._failure_details(
        RuntimeError("private database detail")
    )
    second_id = append_event(
        app,
        job.id,
        "ItemFailed",
        sequence=1,
        failure_code=failure.code,
        failure_reason=failure.reason,
    )
    added_ids = [
        append_event(app, job.id, "ItemPromptStarted", sequence=sequence)
        for sequence in range(2, 22)
    ]

    client = TestClient(app)
    try:
        first_page = client.get(f"/api/generation-results/{job.id}/items", params={"page": 1})
        repeated_page = client.get(f"/api/generation-results/{job.id}/items", params={"page": 1})
        last_page = client.get(f"/api/generation-results/{job.id}/items", params={"page": 2})
        empty_page = client.get(f"/api/generation-results/{job.id}/items", params={"page": 3})
        event_page = client.get(f"/api/jobs/{job.id}/events", params={"page": 1})

        assert first_page.status_code == 200
        assert first_page.json() == repeated_page.json()
        assert first_page.json()["pageSize"] == 20
        assert first_page.json()["total"] == 21
        assert first_page.json()["totalPages"] == 2
        assert [item["sequence"] for item in first_page.json()["items"]] == list(range(1, 21))
        assert [item["sequence"] for item in last_page.json()["items"]] == [21]
        assert empty_page.json() == {
            "items": [],
            "page": 3,
            "pageSize": 20,
            "total": 21,
            "totalPages": 2,
        }
        assert [event["id"] for event in event_page.json()["items"]] == [
            queued_id,
            first_id,
            second_id,
            *added_ids[:17],
        ]
        assert event_page.json()["items"][2]["payload"]["failureReason"] == "The job item failed during execution"
        assert "private database detail" not in event_page.text
        assert "eventType" in event_page.json()["items"][0]
        assert "event_type" not in event_page.json()["items"][0]

        final_page = client.get(
            f"/api/jobs/{job.id}/events",
            params={"page": 2},
        )
        assert [event["id"] for event in final_page.json()["items"]] == added_ids[17:]
        assert final_page.json()["total"] == 23
        assert client.get(f"/api/generation-results/{job.id}").json().keys().isdisjoint({"items", "events"})

        invalid_requests = [
            client.get(f"/api/generation-results/{job.id}/items", params={"page": 0}),
            client.get(f"/api/jobs/{job.id}/events", params={"page": 0}),
        ]
        assert all(response.status_code == 422 for response in invalid_requests)
        assert client.get("/api/generation-results/999999/items").status_code == 404
        assert client.get("/api/jobs/999999/events").status_code == 404
    finally:
        client.close()


def test_websocket_replays_initial_events_and_resumes_after_cursor(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    queued_id = first_event_id(app, job.id)
    continued_id = append_event(app, job.id, "ItemPromptStarted", sequence=1)
    client = TestClient(app)
    try:
        with client.websocket_connect(f"/api/ws/jobs/{job.id}") as websocket:
            assert websocket.receive_json()["id"] == queued_id
            assert websocket.receive_json()["id"] == continued_id

        with client.websocket_connect(
            f"/api/ws/jobs/{job.id}",
            params={"afterEventId": queued_id},
        ) as websocket:
            event = websocket.receive_json()
            assert event["id"] == continued_id
            assert event["eventType"] == "ItemPromptStarted"

        current = app.state.batch_service.get_job(job.id)
        assert current.status is JobStatus.QUEUED
        assert current.cancel_requested_at is None
    finally:
        client.close()


def test_websocket_reconnect_replays_at_most_twenty_events(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    queued_id = first_event_id(app, job.id)
    expected_ids = [
        append_event(app, job.id, "ItemPromptStarted", sequence=sequence)
        for sequence in range(1, 22)
    ]
    client = TestClient(app)
    try:
        with client.websocket_connect(
            f"/api/ws/jobs/{job.id}",
            params={"afterEventId": queued_id},
        ) as websocket:
            received = [websocket.receive_json()["id"] for _ in range(20)]
            with pytest.raises(WebSocketDisconnect) as closed:
                websocket.receive_json()

        assert received == expected_ids[:20]
        assert closed.value.code == 1000
        assert closed.value.reason == "Job event history page completed"
    finally:
        client.close()


def test_websocket_unsubscribes_when_idle_client_disconnects(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    executor = app.state.job_executor
    client = TestClient(app)
    try:
        with client.websocket_connect(
            f"/api/ws/jobs/{job.id}",
            params={"afterEventId": first_event_id(app, job.id)},
        ):
            with executor._event_subscribers_lock:
                assert len(executor._event_subscribers) == 1
        with executor._event_subscribers_lock:
            assert executor._event_subscribers == {}
    finally:
        client.close()


def test_websocket_terminal_job_closes_when_cursor_already_consumed_terminal_event(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    with app.state.database.immediate_session() as session:
        stored = session.get(Job, job.id)
        assert stored is not None
        stored.status = JobStatus.COMPLETED
    terminal_id = append_event(app, job.id, "JobCompleted")
    client = TestClient(app)
    try:
        with client.websocket_connect(
            f"/api/ws/jobs/{job.id}",
            params={"afterEventId": terminal_id},
        ) as websocket:
            with pytest.raises(WebSocketDisconnect) as closed:
                websocket.receive_json()
        assert closed.value.code == 1000
        assert closed.value.reason == "Job event stream completed"
    finally:
        client.close()


def test_websocket_subscribes_before_replay_and_keeps_new_event(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    queued_id = first_event_id(app, job.id)
    service = app.state.batch_service
    executor = app.state.job_executor
    original = service.list_job_events_snapshot
    inserted_id: list[int] = []

    def insert_during_first_replay(job_id: int, after_event_id: int):  # type: ignore[no-untyped-def]
        events, terminal = original(job_id, after_event_id)
        if not inserted_id:
            with executor._event_subscribers_lock:
                assert len(executor._event_subscribers) == 1
            inserted_id.append(append_event(app, job_id, "ItemPromptStarted", sequence=1))
            executor.notify_events()
        return events, terminal

    service.list_job_events_snapshot = insert_during_first_replay
    client = TestClient(app)
    try:
        with client.websocket_connect(f"/api/ws/jobs/{job.id}") as websocket:
            assert websocket.receive_json()["id"] == queued_id
            assert websocket.receive_json()["id"] == inserted_id[0]
    finally:
        service.list_job_events_snapshot = original
        client.close()


def test_websocket_polling_recovers_a_lost_notification(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    queued_id = first_event_id(app, job.id)
    client = TestClient(app)
    try:
        with client.websocket_connect(
            f"/api/ws/jobs/{job.id}",
            params={"afterEventId": queued_id},
        ) as websocket:
            event_id = append_event(app, job.id, "ItemPromptStarted", sequence=1)
            assert websocket.receive_json()["id"] == event_id
    finally:
        client.close()


def test_websocket_deduplicates_notifications_and_closes_after_terminal_event(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    queued_id = first_event_id(app, job.id)
    executor = app.state.job_executor
    client = TestClient(app)
    try:
        with client.websocket_connect(
            f"/api/ws/jobs/{job.id}",
            params={"afterEventId": queued_id},
        ) as websocket:
            running_id = append_event(app, job.id, "ItemPromptStarted", sequence=1)
            executor.notify_events()
            executor.notify_events()
            assert websocket.receive_json()["id"] == running_id

            terminal_id = append_event(app, job.id, "JobCompleted")
            executor.notify_events()
            executor.notify_events()
            terminal = websocket.receive_json()
            assert terminal["id"] == terminal_id
            assert terminal["eventType"] == "JobCompleted"
            with pytest.raises(WebSocketDisconnect) as closed:
                websocket.receive_json()
            assert closed.value.code == 1000
            assert closed.value.reason == "Job event stream completed"
    finally:
        client.close()


def test_websocket_unknown_job_uses_explicit_close(tmp_path: Path) -> None:
    app, _ = create_queued_job(tmp_path)
    client = TestClient(app)
    try:
        with client.websocket_connect("/api/ws/jobs/999999") as websocket:
            with pytest.raises(WebSocketDisconnect) as closed:
                websocket.receive_json()
        assert closed.value.code == 4404
        assert closed.value.reason == "The requested job does not exist"
    finally:
        client.close()


def test_generation_attempts_are_paginated_independently(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path, quantity=1)
    item = app.state.batch_service.list_production_result_items(job.id, 1).items[0]
    with app.state.database.immediate_session() as session:
        for attempt_number in range(1, 22):
            session.add(
                GenerationAttempt(
                    job_item_id=item.id,
                    attempt_number=attempt_number,
                    model=ModelName.LTX,
                    gpu_slot=GpuSlotName.GPU0,
                    seed=attempt_number,
                    renderer_prompt_id=f"attempt-{attempt_number}",
                    status=GenerationAttemptStatus.FAILED,
                    failure_reason="Test failure",
                    started_at=utc_now(),
                    finished_at=utc_now(),
                )
            )

    client = TestClient(app)
    try:
        first = client.get(f"/api/job-items/{item.id}/attempts", params={"page": 1})
        last = client.get(f"/api/job-items/{item.id}/attempts", params={"page": 2})
        empty = client.get(f"/api/job-items/{item.id}/attempts", params={"page": 3})

        assert [row["attemptNumber"] for row in first.json()["items"]] == list(range(1, 21))
        assert [row["attemptNumber"] for row in last.json()["items"]] == [21]
        assert empty.json()["items"] == []
        assert empty.json()["totalPages"] == 2
        assert client.get(f"/api/job-items/{item.id}/attempts", params={"page": 0}).status_code == 422
        assert client.get("/api/job-items/999999/attempts").status_code == 404
    finally:
        client.close()
