from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.adapters.config import Settings
from backend.app import create_app
from backend.domain.enums import GpuSlotName, JobStatus
from backend.domain.models import JobEvent
from backend.tests.test_job_executor import (
    FakeRenderer,
    RecordingPromptModel,
    create_draft,
    create_resources,
    enqueue,
    make_available,
)


def create_queued_job(tmp_path: Path, *, quantity: int = 3):  # type: ignore[no-untyped-def]
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    app = create_app(
        Settings(data_root=tmp_path, frontend_dist=frontend),
        RecordingPromptModel(),
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


def test_job_items_and_events_are_stably_paginated_and_validated(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    queued_id = job.events[0].id
    first_id = append_event(app, job.id, "ItemPromptStarted", sequence=1)
    code, reason = app.state.job_executor._failure_details(RuntimeError("private database detail"))
    second_id = append_event(
        app,
        job.id,
        "ItemFailed",
        sequence=1,
        failure_code=code,
        failure_reason=reason,
    )
    third_id = append_event(app, job.id, "ItemPromptStarted", sequence=2)

    client = TestClient(app)
    try:
        first_page = client.get(f"/api/jobs/{job.id}/items", params={"offset": 1, "limit": 1})
        repeated_page = client.get(f"/api/jobs/{job.id}/items", params={"offset": 1, "limit": 1})
        event_page = client.get(
            f"/api/jobs/{job.id}/events",
            params={"afterEventId": queued_id, "limit": 2},
        )

        assert first_page.status_code == 200
        assert first_page.json() == repeated_page.json()
        assert [item["sequence"] for item in first_page.json()] == [2]
        assert [event["id"] for event in event_page.json()] == [first_id, second_id]
        assert all(event["id"] > queued_id for event in event_page.json())
        assert event_page.json()[1]["payload"]["failureReason"] == "The job item failed during execution"
        assert "private database detail" not in event_page.text
        assert "eventType" in event_page.json()[0]
        assert "event_type" not in event_page.json()[0]

        final_page = client.get(
            f"/api/jobs/{job.id}/events",
            params={"afterEventId": second_id, "limit": 2},
        )
        assert [event["id"] for event in final_page.json()] == [third_id]

        invalid_requests = [
            client.get(f"/api/jobs/{job.id}/items", params={"offset": -1}),
            client.get(f"/api/jobs/{job.id}/items", params={"limit": 0}),
            client.get(f"/api/jobs/{job.id}/items", params={"limit": 501}),
            client.get(f"/api/jobs/{job.id}/events", params={"afterEventId": -1}),
            client.get(f"/api/jobs/{job.id}/events", params={"limit": 0}),
            client.get(f"/api/jobs/{job.id}/events", params={"limit": 501}),
        ]
        assert all(response.status_code == 422 for response in invalid_requests)
        assert client.get("/api/jobs/999999/items").status_code == 404
        assert client.get("/api/jobs/999999/events").status_code == 404
    finally:
        client.close()


def test_websocket_replays_initial_events_and_resumes_after_cursor(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    queued_id = job.events[0].id
    continued_id = append_event(app, job.id, "ItemPromptStarted", sequence=1)
    client = TestClient(app)
    try:
        with client.websocket_connect(f"/api/ws/jobs/{job.id}") as websocket:
            assert websocket.receive_json()["id"] == queued_id

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


def test_websocket_subscribes_before_replay_and_keeps_new_event(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    queued_id = job.events[0].id
    service = app.state.batch_service
    executor = app.state.job_executor
    original = service.list_job_events
    inserted_id: list[int] = []

    def insert_during_first_replay(job_id: int, after_event_id: int, limit: int):  # type: ignore[no-untyped-def]
        events = original(job_id, after_event_id, limit)
        if not inserted_id:
            with executor._event_subscribers_lock:
                assert len(executor._event_subscribers) == 1
            inserted_id.append(append_event(app, job_id, "ItemPromptStarted", sequence=1))
            executor.notify_events()
        return events

    service.list_job_events = insert_during_first_replay
    client = TestClient(app)
    try:
        with client.websocket_connect(f"/api/ws/jobs/{job.id}") as websocket:
            assert websocket.receive_json()["id"] == queued_id
            assert websocket.receive_json()["id"] == inserted_id[0]
    finally:
        service.list_job_events = original
        client.close()


def test_websocket_polling_recovers_a_lost_notification(tmp_path: Path) -> None:
    app, job = create_queued_job(tmp_path)
    queued_id = job.events[0].id
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
    queued_id = job.events[0].id
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
