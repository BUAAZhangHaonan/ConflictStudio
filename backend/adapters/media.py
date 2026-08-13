from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path, PurePosixPath

from sqlmodel import Session

from backend.domain.enums import GenerationAttemptStatus, ModelName
from backend.domain.models import Asset, GenerationAttempt


VIDEO_WIDTH = 1344
VIDEO_HEIGHT = 768
VIDEO_FPS = 24
MEDIA_TYPE_MP4 = "video/mp4"


class MediaError(ValueError):
    pass


@dataclass(frozen=True)
class ProbeEvidence:
    byte_size: int
    width: int
    height: int
    fps: int
    frame_count: int
    duration_seconds: float
    has_audio: bool


@dataclass(frozen=True)
class PreparedMedia:
    source_path: Path
    source_evidence: ProbeEvidence
    primary_path: Path
    primary_evidence: ProbeEvidence
    derived_primary: bool


class MediaStore:
    """Owns generation media below one explicitly configured data root."""

    def __init__(self, data_root: Path, *, ffprobe_binary: str = "ffprobe", ffmpeg_binary: str = "ffmpeg") -> None:
        if not data_root.is_dir():
            raise MediaError("A configured existing data root is required")
        self.data_root = data_root.resolve()
        self.ffprobe_binary = ffprobe_binary
        self.ffmpeg_binary = ffmpeg_binary

    def relative_path(self, path: Path) -> str:
        resolved = path.resolve()
        try:
            return resolved.relative_to(self.data_root).as_posix()
        except ValueError as error:
            raise MediaError("Media path escapes the configured data root") from error

    def resolve(self, relative_path: str) -> Path:
        if not relative_path or "\\" in relative_path:
            raise MediaError("Media path must be a non-empty relative POSIX path")
        relative = PurePosixPath(relative_path)
        if relative.is_absolute() or ".." in relative.parts:
            raise MediaError("Media path must not be absolute or contain dot-dot")
        candidate = self.data_root.joinpath(*relative.parts)
        resolved = candidate.resolve()
        try:
            resolved.relative_to(self.data_root)
        except ValueError as error:
            raise MediaError("Media path escapes the configured data root") from error
        return resolved

    def attempt_paths(self, job_id: int, item_sequence: int, attempt_number: int) -> tuple[Path, Path, Path]:
        if job_id <= 0 or item_sequence <= 0 or attempt_number <= 0:
            raise MediaError("Job id, item sequence, and attempt number must be positive")
        directory = self.resolve(f"media/jobs/{job_id}/items/{item_sequence}/attempts/{attempt_number}")
        return directory / "source.mp4", directory / "primary.mp4", directory / ".primary.tmp.mp4"

    def probe(self, path: Path, *, require_audio: bool, model: ModelName) -> ProbeEvidence:
        relative_path = self.relative_path(path)
        checked_path = self.resolve(relative_path)
        if not checked_path.is_file() or checked_path.stat().st_size <= 0:
            raise MediaError("Media file must exist and be nonzero")
        try:
            result = subprocess.run(
                [
                    self.ffprobe_binary,
                    "-v",
                    "error",
                    "-print_format",
                    "json",
                    "-show_entries",
                    "stream=codec_type,width,height,r_frame_rate,nb_frames,nb_read_frames:format=duration",
                    str(checked_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError as error:
            raise MediaError("ffprobe is unavailable") from error
        except OSError as error:
            raise MediaError("ffprobe could not be started") from error
        if result.returncode != 0:
            raise MediaError("ffprobe failed")
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise MediaError("ffprobe returned invalid JSON") from error
        if not isinstance(payload, dict) or not {"streams", "format"} <= set(payload):
            raise MediaError("ffprobe JSON has an unexpected shape")
        streams = payload["streams"]
        format_info = payload["format"]
        if not isinstance(streams, list) or not isinstance(format_info, dict):
            raise MediaError("ffprobe JSON has an unexpected shape")
        video_streams = [stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "video"]
        audio_streams = [stream for stream in streams if isinstance(stream, dict) and stream.get("codec_type") == "audio"]
        if len(video_streams) != 1:
            raise MediaError("Media must contain exactly one video stream")
        video = video_streams[0]
        required_video = {"codec_type", "width", "height", "r_frame_rate"}
        if not required_video <= set(video):
            raise MediaError("ffprobe video stream is incomplete")
        if (
            not isinstance(video["codec_type"], str)
            or type(video["width"]) is not int
            or type(video["height"]) is not int
            or not isinstance(video["r_frame_rate"], str)
        ):
            raise MediaError("ffprobe video stream is incomplete")
        if video["width"] != VIDEO_WIDTH or video["height"] != VIDEO_HEIGHT:
            raise MediaError("Video must be 1344x768")
        try:
            fps = Fraction(video["r_frame_rate"])
        except (TypeError, ValueError, ZeroDivisionError) as error:
            raise MediaError("Video fps is invalid") from error
        if fps != VIDEO_FPS:
            raise MediaError("Video must be 24fps")
        frame_values = [video.get(name) for name in ("nb_frames", "nb_read_frames") if name in video]
        usable_frame_values = [self._positive_int(value, "frame count") for value in frame_values if value not in (None, "N/A")]
        if not usable_frame_values:
            raise MediaError("Video frame count is missing or unusable")
        if len(set(usable_frame_values)) != 1:
            raise MediaError("Video frame counts are inconsistent")
        frame_count = usable_frame_values[0]
        expected_frames = 121 if model in {ModelName.LTX, ModelName.LTX_25} else 124
        if frame_count != expected_frames:
            raise MediaError("Video frame count does not match the model")
        duration_value = format_info.get("duration")
        if not isinstance(duration_value, str):
            raise MediaError("Media duration is invalid")
        try:
            duration_seconds = float(duration_value)
        except (TypeError, ValueError) as error:
            raise MediaError("Media duration is invalid") from error
        if duration_seconds <= 0:
            raise MediaError("Media duration must be positive")
        expected_duration = expected_frames / VIDEO_FPS
        if abs(duration_seconds - expected_duration) > 1 / VIDEO_FPS:
            raise MediaError("Media duration does not match the model frame count")
        if require_audio and not audio_streams:
            raise MediaError("Source media must contain audio")
        return ProbeEvidence(
            byte_size=checked_path.stat().st_size,
            width=VIDEO_WIDTH,
            height=VIDEO_HEIGHT,
            fps=VIDEO_FPS,
            frame_count=frame_count,
            duration_seconds=duration_seconds,
            has_audio=bool(audio_streams),
        )

    @staticmethod
    def _positive_int(value: object, name: str) -> int:
        if not isinstance(value, str) or not value.isdecimal() or int(value) <= 0:
            raise MediaError(f"Video {name} is missing or invalid")
        return int(value)

    def make_vt_primary(
        self,
        source_path: Path,
        primary_path: Path,
        temporary_path: Path,
        *,
        model: ModelName,
    ) -> Path:
        self.relative_path(source_path)
        self.relative_path(primary_path)
        self.relative_path(temporary_path)
        resolved_paths = {
            source_path.resolve(),
            primary_path.resolve(),
            temporary_path.resolve(),
        }
        if len(resolved_paths) != 3:
            raise MediaError("Source, primary, and temporary media paths must be distinct")
        self.probe(source_path, require_audio=True, model=model)
        primary_path.parent.mkdir(parents=True, exist_ok=True)
        if primary_path.exists() or temporary_path.exists():
            raise MediaError("VT primary output path already exists")
        try:
            try:
                result = subprocess.run(
                    [self.ffmpeg_binary, "-n", "-i", str(source_path), "-map", "0:v:0", "-c:v", "copy", "-an", str(temporary_path)],
                    check=False,
                    capture_output=True,
                    text=True,
                )
            except FileNotFoundError as error:
                raise MediaError("ffmpeg is unavailable") from error
            except OSError as error:
                raise MediaError("ffmpeg could not be started") from error
            if result.returncode != 0:
                raise MediaError("ffmpeg failed while making a silent primary")
            evidence = self.probe(temporary_path, require_audio=False, model=model)
            if evidence.has_audio:
                raise MediaError("Silent primary unexpectedly contains audio")
            os.replace(temporary_path, primary_path)
        except Exception:
            temporary_path.unlink(missing_ok=True)
            primary_path.unlink(missing_ok=True)
            raise
        return primary_path

    def prepare_attempt(
        self,
        *,
        source_relative_path: str,
        job_id: int,
        item_sequence: int,
        attempt_number: int,
        model: ModelName,
        derive_silent_primary: bool,
    ) -> PreparedMedia:
        source_path = self.resolve(source_relative_path)
        source_evidence = self.probe(source_path, require_audio=True, model=model)
        if not derive_silent_primary:
            return PreparedMedia(
                source_path=source_path,
                source_evidence=source_evidence,
                primary_path=source_path,
                primary_evidence=source_evidence,
                derived_primary=False,
            )

        _, primary_path, temporary_path = self.attempt_paths(job_id, item_sequence, attempt_number)
        self.make_vt_primary(
            source_path,
            primary_path,
            temporary_path,
            model=model,
        )
        try:
            primary_evidence = self.probe(primary_path, require_audio=False, model=model)
            if primary_evidence.has_audio:
                raise MediaError("Silent primary unexpectedly contains audio")
        except Exception:
            primary_path.unlink(missing_ok=True)
            raise
        return PreparedMedia(
            source_path=source_path,
            source_evidence=source_evidence,
            primary_path=primary_path,
            primary_evidence=primary_evidence,
            derived_primary=True,
        )

    def persist_completed_attempt(
        self,
        session: Session,
        attempt: GenerationAttempt,
        prepared: PreparedMedia,
        *,
        finished_at: str,
    ) -> tuple[Asset, Asset]:
        if attempt.status is not GenerationAttemptStatus.RUNNING:
            raise MediaError("Generation attempt is not running")
        source_asset = self._asset(prepared.source_path, prepared.source_evidence)
        session.add(source_asset)
        session.flush()
        if prepared.derived_primary:
            primary_asset = self._asset(prepared.primary_path, prepared.primary_evidence)
            session.add(primary_asset)
            session.flush()
        else:
            primary_asset = source_asset
        attempt.source_asset_id = source_asset.id
        attempt.primary_asset_id = primary_asset.id
        attempt.status = GenerationAttemptStatus.COMPLETED
        attempt.finished_at = finished_at
        return source_asset, primary_asset

    @staticmethod
    def discard_prepared(prepared: PreparedMedia) -> None:
        if prepared.derived_primary:
            prepared.primary_path.unlink(missing_ok=True)

    def _asset(self, path: Path, evidence: ProbeEvidence) -> Asset:
        return Asset(
            storage_root=str(self.data_root),
            relative_path=self.relative_path(path),
            media_type=MEDIA_TYPE_MP4,
            byte_size=evidence.byte_size,
            width=evidence.width,
            height=evidence.height,
            fps=evidence.fps,
            frame_count=evidence.frame_count,
            duration_seconds=evidence.duration_seconds,
            has_audio=evidence.has_audio,
        )
