from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from backend.adapters.config import Settings
from backend.adapters.gpu import SlotInspection
from backend.adapters.renderer import (
    CancelOutcome,
    RenderResult,
    RendererInstallationStatus,
)
from backend.app import create_app
from backend.domain.enums import (
    BatchDraftStatus,
    Category,
    ContentMode,
    ContentStatus,
    Gender,
    GenerationAttemptStatus,
    GpuAvailability,
    GpuSlotName,
    JobItemStage,
    JobSource,
    JobStatus,
    ModelName,
    Precision,
    ResourceStatus,
)
from backend.domain.models import (
    Asset,
    BatchDraft,
    BatchVideoInputSnapshot,
    ContentPlan,
    Dataset,
    GenerationAttempt,
    Job,
    JobItem,
    JobItemPromptResult,
    PromptPreset,
    RENDERER_PROFILE_VERSION,
    Sample,
    VIDEO_FPS,
    VIDEO_HEIGHT,
    VIDEO_WIDTH,
    VideoBackgroundPreset,
    utc_now,
)


class ApiRenderer:
    configured = True
    persists_render_state = False

    async def probe(self, slot: GpuSlotName) -> SlotInspection:
        return SlotInspection(slot, GpuAvailability.AVAILABLE, None)

    async def installation_status(self) -> RendererInstallationStatus:
        return RendererInstallationStatus.INSTALLED

    async def submit(self, request):  # type: ignore[no-untyped-def]
        return f"test-{request.job_item_id}"

    async def wait(self, slot: GpuSlotName, prompt_id: str) -> RenderResult:
        return RenderResult()

    async def cancel(self, slot: GpuSlotName, prompt_id: str) -> CancelOutcome:
        return CancelOutcome.CANCELLED

    async def close(self) -> None:
        return None


class ApiPromptModel:
    configured = True

    async def generate(self, system_input: str, user_input: str) -> str:
        return json.dumps(
            {
                "spokenText": "我没事，只是需要一点时间。",
                "appearance": "She wears a charcoal jacket, and her dark hair remains tucked behind one ear.",
                "bodyAction": (
                    "She sits upright, folds both hands on her lap, presses her lips together, raises her chin, "
                    "and keeps her gaze level through the final word."
                ),
                "vocalDelivery": (
                    "She keeps her voice low and steady, with measured pacing and firm articulation."
                ),
                "environmentalSound": (
                    "A soft ventilation hum and the even ticking of a wall clock remain audible."
                ),
                "setting": (
                    "The private office contains pale walls, a bare wooden table, and one closed window behind the seat."
                ),
                "camera": "The camera holds a static front-facing close-up head-and-shoulders view.",
                "lighting": (
                    "Soft daylight keeps her face bright and evenly lit with gentle highlights across the jacket fabric."
                ),
                "trueEmotionDescription": "说话内容和可见动作共同表明她在平静地回应当前事件。",
            },
            ensure_ascii=False,
        )

    async def close(self) -> None:
        return None


class InvalidApiPromptModel(ApiPromptModel):
    async def generate(self, system_input: str, user_input: str) -> str:
        return json.dumps(
            {
                "spokenText": "我没事，只是需要一点时间。",
                "appearance": "She wears a plain jacket.",
                "bodyAction": "She sits upright.",
                "vocalDelivery": "She speaks slowly.",
                "environmentalSound": "A clock ticks nearby.",
                "setting": "The room contains one table.",
                "camera": "The camera holds a static close-up.",
                "lighting": "Soft light reaches her face.",
                "trueEmotionDescription": "说话内容和可见动作共同表明她在平静地回应当前事件。",
            },
            ensure_ascii=False,
        )


def make_app(tmp_path: Path, prompt_model=None):  # type: ignore[no-untyped-def]
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    return create_app(
        Settings(data_root=tmp_path, frontend_dist=frontend),
        prompt_model or ApiPromptModel(),
        ApiRenderer(),
    )


def create_api_sources(
    client: TestClient,
) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    content = client.post(
        "/api/content-plans",
        json={
            "nameZh": "一致回应",
            "nameEn": "Aligned response",
            "category": "A-VA",
            "mode": "Generative",
            "status": "Active",
            "trueEmotion": "calm",
            "apparentEmotion": "calm",
            "sceneZh": "一间私人办公室。",
            "sceneEn": "A private office.",
            "triggerEventZh": "计时器响起。",
            "triggerEventEn": "A timer sounds.",
            "psychologicalBackgroundZh": "被摄者准备作答。",
            "psychologicalBackgroundEn": "The subject prepares to answer.",
            "contentRequirementsZh": "一名成年人平静回应当前事件。",
            "contentRequirementsEn": "One adult responds calmly to the current event.",
            "sceneSupplementZh": "",
            "sceneSupplementEn": "",
        },
    ).json()
    prompt = client.post(
        "/api/prompt-presets",
        json={
            "name": "Natural shot",
            "category": "A-VA",
            "styleGuidance": "Use a static medium shot.",
            "finalRenderNegativeConstraints": "subtitles, captions, distortion",
        },
    ).json()
    background = client.post(
        "/api/video-background-presets",
        json={
            "nameZh": "私人办公室",
            "nameEn": "Private office",
            "sceneZh": "一间只有桌椅的私人办公室。",
            "sceneEn": "A private office containing one desk and one chair.",
            "ambientSoundZh": "稳定的通风声。",
            "ambientSoundEn": "A steady ventilation hum remains audible.",
            "participantRelationshipZh": "画面中只有被摄者。",
            "participantRelationshipEn": "The subject is the only occupant in view.",
            "lightingZh": "柔和的日光。",
            "lightingEn": "Soft daylight enters through one window.",
            "framingZh": "静止中景。",
            "framingEn": "Use a static eye-level medium shot.",
        },
    ).json()
    return content, prompt, background


def test_post_test_runs_creates_real_test_job_and_items(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app) as client:
        content, prompt, background = create_api_sources(client)
        gpu = client.get("/api/gpu-slots").json()[0]
        response = client.post(
            "/api/test-runs",
            json={
                "contentPlan": {
                    "id": content["id"],
                    "expectedRevision": content["revision"],
                },
                "promptPreset": {
                    "id": prompt["id"],
                    "expectedRevision": prompt["revision"],
                },
                "backgroundPreset": {
                    "id": background["id"],
                    "expectedRevision": background["revision"],
                },
                "demographic": {
                    "age": 25,
                    "gender": "Female",
                    "ethnicity": "EastAsian",
                },
                "seed": 77,
                "comparisons": [
                    {"model": "LTX-2.3", "precision": None, "gpuSlot": "GPU0"}
                ],
                "executionMode": "Serial",
                "expectedGpuRevisions": {"GPU0": gpu["revision"]},
                "confirmModelSwitch": False,
            },
        )

    assert response.status_code == 202
    payload = response.json()
    assert response.headers["Location"] == f"/api/jobs/{payload['id']}"
    assert payload["source"] == "Test"
    assert payload["datasetId"] is None and payload["batchDraftId"] is None
    assert payload["model"] is None and payload["precision"] is None
    assert len(payload["items"]) == 1
    assert payload["items"][0]["input"]["seed"] == 77


def test_invalid_generative_prompt_creates_no_job_or_generation_records(
    tmp_path: Path,
) -> None:
    app = make_app(tmp_path, InvalidApiPromptModel())
    with TestClient(app) as client:
        content, prompt, background = create_api_sources(client)
        gpu = client.get("/api/gpu-slots").json()[0]
        response = client.post(
            "/api/test-runs",
            json={
                "contentPlan": {
                    "id": content["id"],
                    "expectedRevision": content["revision"],
                },
                "promptPreset": {
                    "id": prompt["id"],
                    "expectedRevision": prompt["revision"],
                },
                "backgroundPreset": {
                    "id": background["id"],
                    "expectedRevision": background["revision"],
                },
                "demographic": {
                    "age": 25,
                    "gender": "Female",
                    "ethnicity": "EastAsian",
                },
                "seed": 77,
                "comparisons": [
                    {"model": "LTX-2.3", "precision": None, "gpuSlot": "GPU0"}
                ],
                "executionMode": "Serial",
                "expectedGpuRevisions": {"GPU0": gpu["revision"]},
                "confirmModelSwitch": False,
            },
        )

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "invalid_prompt_response"
    with app.state.database.read_session() as session:
        assert session.exec(select(Job)).all() == []
        assert session.exec(select(JobItem)).all() == []
        assert session.exec(select(GenerationAttempt)).all() == []
        assert session.exec(select(Asset)).all() == []
        assert session.exec(select(Sample)).all() == []


def add_completed_result(
    app,
    source: JobSource,
    model: ModelName = ModelName.LTX,
    precision: Precision | None = None,
) -> tuple[int, int, int]:  # type: ignore[no-untyped-def]
    timestamp = utc_now()
    frame_count = 124 if model is ModelName.H3 else 121
    with app.state.database.immediate_session() as session:
        dataset = Dataset(
            name="Formal",
            name_key="formal",
            purpose="Production",
            status=ResourceStatus.ACTIVE,
        )
        content = ContentPlan(
            name_zh="一致回应",
            name_zh_key="一致回应",
            name_en="Aligned response",
            name_en_key="aligned response",
            category=Category.A_VA,
            mode=ContentMode.FIXED,
            status=ContentStatus.ACTIVE,
            true_emotion="calm",
            apparent_emotion="calm",
            scene_zh="一间办公室。",
            scene_en="A private office.",
            trigger_event_zh="计时器响起。",
            trigger_event_en="A timer sounds.",
            psychological_background_zh="被摄者准备作答。",
            psychological_background_en="The subject prepares to answer.",
            dialogue="我很好。",
            true_emotion_description="说话者保持平静。",
            base_video_prompt="An adult answers calmly.",
        )
        prompt = PromptPreset(
            name="Natural",
            name_key="natural",
            category=Category.A_VA,
            final_negative_prompt="subtitles",
        )
        background = VideoBackgroundPreset(
            name_zh="办公室",
            name_zh_key="办公室",
            name_en="Office",
            name_en_key="office",
            scene_zh="一间办公室。",
            scene_en="A private office.",
        )
        session.add_all([dataset, content, prompt, background])
        session.flush()
        draft = None
        if source is JobSource.PRODUCTION:
            draft = BatchDraft(
                dataset_id=dataset.id,
                dataset_revision=dataset.revision,
                category=Category.A_VA,
                model=model,
                precision=precision,
                quantity=1,
                seed_base=77,
                status=BatchDraftStatus.SUBMITTED,
            )
            session.add(draft)
            session.flush()
        snapshot = BatchVideoInputSnapshot(
            batch_draft_id=draft.id if draft else None,
            dataset_id=dataset.id if draft else None,
            dataset_revision=dataset.revision if draft else None,
            sequence=1,
            content_plan_id=content.id,
            content_plan_revision=content.revision,
            prompt_preset_id=prompt.id,
            prompt_preset_revision=prompt.revision,
            background_preset_id=background.id,
            background_preset_revision=background.revision,
            policy_version="test",
            category=Category.A_VA,
            age=25,
            gender=Gender.FEMALE,
            ethnicity="EastAsian",
            model=model,
            precision=precision,
            seed=77,
            width=VIDEO_WIDTH,
            height=VIDEO_HEIGHT,
            fps=VIDEO_FPS,
            frame_count=frame_count,
            renderer_profile_version=RENDERER_PROFILE_VERSION,
            prompt_model="test",
            source_has_audio=True,
            derive_silent_primary=False,
            system_input="system",
            user_input="user",
            final_negative_prompt="subtitles",
            fixed_positive_prompt="An adult answers calmly.",
            fixed_dialogue="我很好。",
            fixed_true_emotion_description="说话者保持平静。",
            true_emotion="calm",
            apparent_emotion="calm",
        )
        session.add(snapshot)
        session.flush()
        job = Job(
            display_name="A-VA-test",
            source=source,
            dataset_id=dataset.id if draft else None,
            batch_draft_id=draft.id if draft else None,
            category=Category.A_VA,
            model=model if draft else None,
            precision=precision if draft else None,
            status=JobStatus.RUNNING,
            total_count=1,
            prepared_count=1,
            started_at=timestamp,
        )
        session.add(job)
        session.flush()
        relative_path = f"media/{source.value.casefold()}.mp4"
        (app.state.database.data_root / relative_path).parent.mkdir(
            parents=True, exist_ok=True
        )
        (app.state.database.data_root / relative_path).write_bytes(b"video")
        asset = Asset(
            storage_root=str(app.state.database.data_root),
            relative_path=relative_path,
            media_type="video/mp4",
            byte_size=5,
            width=VIDEO_WIDTH,
            height=VIDEO_HEIGHT,
            fps=VIDEO_FPS,
            frame_count=frame_count,
            duration_seconds=frame_count / VIDEO_FPS,
            has_audio=True,
        )
        session.add(asset)
        session.flush()
        item = JobItem(
            job_id=job.id,
            sequence=1,
            input_snapshot_id=snapshot.id,
            gpu_slot=GpuSlotName.GPU0,
            stage=JobItemStage.MEDIA_PROCESSING,
            status=JobStatus.RUNNING,
            source_asset_id=asset.id,
            primary_asset_id=asset.id,
            renderer_prompt_id="prompt-1",
        )
        session.add(item)
        session.flush()
        session.add(
            JobItemPromptResult(
                job_item_id=item.id,
                policy_version="test",
                system_input="system",
                user_input="user",
                raw_structured_response="{}",
                final_positive_prompt="An adult answers calmly.",
                final_negative_prompt="subtitles",
                dialogue="我很好。",
                true_emotion_description="说话者保持平静。",
            )
        )
        session.add(
            GenerationAttempt(
                job_item_id=item.id,
                attempt_number=1,
                model=model,
                precision=precision,
                gpu_slot=GpuSlotName.GPU0,
                seed=77,
                source_asset_id=asset.id,
                primary_asset_id=asset.id,
                renderer_prompt_id="prompt-1",
                status=GenerationAttemptStatus.COMPLETED,
                started_at=timestamp,
                finished_at=timestamp,
            )
        )
        session.flush()
        return job.id, item.id, dataset.id


def test_completed_production_result_enters_pending_review_queue(
    tmp_path: Path,
) -> None:
    app = make_app(tmp_path)
    job_id, item_id, _ = add_completed_result(app, JobSource.PRODUCTION)
    app.state.job_executor._complete_item(job_id, item_id)

    with TestClient(app) as client:
        queue = client.get("/api/samples", params={"decision": "Pending"})
        item = client.get(f"/api/jobs/{job_id}/items").json()[0]

    assert queue.status_code == 200
    assert len(queue.json()) == 1
    sample = queue.json()[0]
    assert sample["jobItemId"] == item_id
    assert sample["reviewDecision"] == "Pending"
    assert sample["primaryAssetId"] == item["primaryAssetId"]
    assert item["sampleId"] == sample["id"]


@pytest.mark.parametrize(
    ("model", "precision"),
    [
        (ModelName.LTX_25, Precision.INT8),
        (ModelName.LTX, None),
        (ModelName.H3, None),
    ],
)
def test_sample_api_reads_precision_only_from_current_successful_attempt(
    tmp_path: Path,
    model: ModelName,
    precision: Precision | None,
) -> None:
    app = make_app(tmp_path)
    job_id, item_id, _ = add_completed_result(app, JobSource.PRODUCTION, model, precision)
    app.state.job_executor._complete_item(job_id, item_id)

    with TestClient(app) as client:
        response = client.get("/api/samples", params={"decision": "Pending"})

    assert response.status_code == 200
    sample = response.json()[0]
    assert sample["model"] == model.value
    assert "precision" not in sample
    assert sample["generationRecord"]["model"] == model.value
    assert sample["generationRecord"]["precision"] == (precision.value if precision else None)
    assert sample["generationRecord"]["gpuSlot"] == "GPU0"
    assert sample["generationRecord"]["seed"] == 77
    assert sample["generationRecord"]["id"] > 0


def test_test_result_keep_reuses_assets_and_review_history_is_revisioned(
    tmp_path: Path,
) -> None:
    app = make_app(tmp_path)
    job_id, item_id, dataset_id = add_completed_result(app, JobSource.TEST)
    app.state.job_executor._complete_item(job_id, item_id)

    with TestClient(app) as client:
        item = client.get(f"/api/jobs/{job_id}/items").json()[0]
        kept = client.post(
            f"/api/job-items/{item_id}/keep",
            json={"datasetId": dataset_id, "expectedRevision": item["revision"]},
        )
        reviewer = client.post("/api/reviewers", json={"name": "Reviewer One"})
        reviewed = client.post(
            "/api/reviews",
            json={
                "sampleId": kept.json()["id"],
                "reviewerId": reviewer.json()["id"],
                "expectedRevision": kept.json()["revision"],
                "expectedReviewRevision": kept.json()["reviewRevision"],
                "decision": "Accepted",
                "note": "",
            },
        )

    assert kept.status_code == 201
    assert len(item["attempts"]) == 1
    assert item["attempts"][0]["status"] == "Completed"
    assert item["attempts"][0]["primaryAssetUrl"] == item["primaryAssetUrl"]
    assert kept.json()["primaryAssetId"] == item["primaryAssetId"]
    assert kept.json()["sourceAssetId"] == item["sourceAssetId"]
    assert reviewer.status_code == 201
    assert reviewed.status_code == 201
    assert reviewed.json()["reviewDecision"] == "Accepted"
    assert reviewed.json()["reviewRevision"] == 1
    with app.state.database.read_session() as session:
        assert len(session.exec(select(Asset)).all()) == 1
        assert len(session.exec(select(Sample)).all()) == 1
