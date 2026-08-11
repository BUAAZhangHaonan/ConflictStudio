from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from subprocess import CompletedProcess

import pytest

from backend.adapters.database import Database
from backend.adapters.media import MediaError, MediaStore
from backend.domain.enums import Category, GpuSlotName, ModelName


def compact_probe(*, frames: str | None = "121", width: int = 1344, height: int = 768, fps: str = "24/1", duration: str = "5.0416667", audio: bool = True, read_frames: str | None = None, wrapper: bool = False) -> str:
    stream = {"codec_type": "video", "width": width, "height": height, "r_frame_rate": fps}
    if frames is not None:
        stream["nb_frames"] = frames
    if read_frames is not None:
        stream["nb_read_frames"] = read_frames
    streams = [stream]
    if audio:
        streams.append({"codec_type": "audio"})
    payload = {"streams": streams, "format": {"duration": duration}}
    if wrapper:
        payload["programs"] = []
        payload["version"] = {"version": "6.1"}
    return str(payload).replace("'", '"')


def test_media_paths_reject_absolute_dotdot_and_symlink_escape(tmp_path: Path) -> None:
    store = MediaStore(tmp_path)
    for path in ("/outside.mp4", "../outside.mp4", "a/../outside.mp4", r"a\\outside.mp4"):
        with pytest.raises(MediaError):
            store.resolve(path)
    outside = tmp_path.parent / "outside"
    outside.mkdir(exist_ok=True)
    link = tmp_path / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are unavailable")
    with pytest.raises(MediaError):
        store.resolve("link/outside.mp4")


def test_probe_rejects_zero_byte_and_every_required_media_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = MediaStore(tmp_path)
    media = tmp_path / "media.mp4"
    media.touch()
    with pytest.raises(MediaError, match="nonzero"):
        store.probe(media, require_audio=True, model=ModelName.LTX)
    media.write_bytes(b"x")

    def install(payload: str) -> None:
        monkeypatch.setattr("backend.adapters.media.subprocess.run", lambda *args, **kwargs: CompletedProcess(args[0], 0, payload, ""))

    failures = (
        compact_probe(width=1),
        compact_probe(height=1),
        compact_probe(fps="25/1"),
        compact_probe(frames="120"),
        compact_probe(duration="0"),
        compact_probe(audio=False),
        "{}",
        "not json",
    )
    for payload in failures:
        install(payload)
        with pytest.raises(MediaError):
            store.probe(media, require_audio=True, model=ModelName.LTX)
    install(compact_probe(frames="124"))
    with pytest.raises(MediaError):
        store.probe(media, require_audio=True, model=ModelName.LTX)
    install(compact_probe(frames="121"))
    assert store.probe(media, require_audio=True, model=ModelName.LTX).has_audio
    install(compact_probe(frames="121", read_frames="121", wrapper=True))
    assert store.probe(media, require_audio=True, model=ModelName.LTX).frame_count == 121
    install(compact_probe(frames="121", read_frames=None).replace('"nb_frames": "121"', '"nb_read_frames": "121"'))
    assert store.probe(media, require_audio=True, model=ModelName.LTX).frame_count == 121
    install(compact_probe(frames="121", duration="4.9"))
    with pytest.raises(MediaError, match="duration"):
        store.probe(media, require_audio=True, model=ModelName.LTX)
    install(compact_probe(frames=None))
    with pytest.raises(MediaError, match="frame count"):
        store.probe(media, require_audio=True, model=ModelName.LTX)


@pytest.mark.parametrize("failure", ("ffmpeg", "silent_probe", "replace"))
def test_vt_failure_persists_source_and_failed_attempt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    store = MediaStore(tmp_path)
    source, primary, temporary = store.attempt_paths(1, 1, 1)
    source.parent.mkdir(parents=True)
    source.write_bytes(b"source")

    def fake_run(args: list[str], **kwargs: object) -> CompletedProcess[str]:
        if args[0] == "ffmpeg":
            if failure == "ffmpeg":
                return CompletedProcess(args, 1, "", "")
            temporary.write_bytes(b"silent")
            return CompletedProcess(args, 0, "", "")
        if failure == "silent_probe" and str(args[-1]) == str(temporary):
            return CompletedProcess(args, 0, compact_probe(frames=None), "")
        has_audio = str(args[-1]) == str(source)
        return CompletedProcess(args, 0, compact_probe(audio=has_audio), "")

    monkeypatch.setattr("backend.adapters.media.subprocess.run", fake_run)
    if failure == "replace":
        monkeypatch.setattr("backend.adapters.media.os.replace", lambda *_: (_ for _ in ()).throw(OSError("replace failed")))
    session = type("SessionStub", (), {"rows": [], "add": lambda self, row: (setattr(row, "id", len(self.rows) + 1) if getattr(row, "id", None) is None else None) or self.rows.append(row), "flush": lambda self: None})()
    attempt = store.finalize_attempt(session, job_item_id=1, job_id=1, item_sequence=1, attempt_number=1, category=Category.A_VT, model=ModelName.LTX, gpu_slot=GpuSlotName.GPU0, seed=1, renderer_prompt_id=None, started_at="2026-08-12T00:00:00Z")
    assert attempt.status.value == "Failed"
    assert attempt.failure_reason
    assert any(getattr(row, "relative_path", "") == "media/jobs/1/items/1/attempts/1/source.mp4" for row in session.rows)
    assert attempt.primary_asset_id is None
    assert not any(getattr(row, "relative_path", "") == "media/jobs/1/items/1/attempts/1/primary.mp4" for row in session.rows)
    assert not primary.exists()
    assert not temporary.exists()


def test_va_and_vt_assets_preserve_rerender_attempt_history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = MediaStore(tmp_path)

    class SessionStub:
        def __init__(self) -> None:
            self.rows: list[object] = []

        def add(self, row: object) -> None:
            if getattr(row, "id", None) is None:
                row.id = len(self.rows) + 1  # type: ignore[attr-defined]
            self.rows.append(row)

        def flush(self) -> None:
            return None

    def fake_run(args: list[str], **kwargs: object) -> CompletedProcess[str]:
        output = Path(str(args[-1]))
        if args[0] == "ffmpeg":
            output.write_bytes(b"silent")
            return CompletedProcess(args, 0, "", "")
        source = output.name == "source.mp4"
        return CompletedProcess(args, 0, compact_probe(audio=source), "")

    monkeypatch.setattr("backend.adapters.media.subprocess.run", fake_run)
    session = SessionStub()
    for attempt_number, category in ((1, Category.A_VA), (2, Category.A_VT)):
        source, _, _ = store.attempt_paths(7, 3, attempt_number)
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b"source")
        attempt = store.finalize_attempt(
            session,  # type: ignore[arg-type]
            job_item_id=99,
            job_id=7,
            item_sequence=3,
            attempt_number=attempt_number,
            category=category,
            model=ModelName.LTX,
            gpu_slot=GpuSlotName.GPU0,
            seed=11,
            renderer_prompt_id="renderer-1",
            started_at="2026-08-12T00:00:00Z",
        )
        if category is Category.A_VA:
            assert attempt.source_asset_id == attempt.primary_asset_id
        else:
            assert attempt.source_asset_id != attempt.primary_asset_id
    attempts = [row for row in session.rows if hasattr(row, "attempt_number")]
    assert [row.attempt_number for row in attempts] == [1, 2]  # type: ignore[attr-defined]


def test_asset_schema_has_checks_foreign_keys_and_immutability(tmp_path: Path) -> None:
    database = Database(tmp_path)
    database.initialize()
    connection = sqlite3.connect(database.database_path)
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO assets (storage_root, relative_path, media_type, byte_size, width, height, fps, frame_count, duration_seconds, has_audio, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (str(tmp_path), "../escape.mp4", "video/mp4", 1, 1344, 768, 24, 121, 1.0, 1, "2026-08-12T00:00:00Z"),
            )
        connection.execute(
            "INSERT INTO assets (storage_root, relative_path, media_type, byte_size, width, height, fps, frame_count, duration_seconds, has_audio, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (str(tmp_path), "media/source.mp4", "video/mp4", 1, 1344, 768, 24, 121, 1.0, 1, "2026-08-12T00:00:00Z"),
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("UPDATE assets SET byte_size = 2 WHERE id = 1")
        foreign_keys = connection.execute("PRAGMA foreign_key_list(generation_attempts)").fetchall()
        assert {("job_items", "job_item_id"), ("assets", "source_asset_id"), ("assets", "primary_asset_id")} <= {(row[2], row[3]) for row in foreign_keys}
    finally:
        connection.close()
