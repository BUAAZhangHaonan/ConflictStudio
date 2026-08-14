from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable


class ArchiveManifestStore:
    def __init__(self, data_root: Path) -> None:
        self.root = data_root.resolve() / "archives"

    def path(self, dataset_id: int) -> Path:
        if dataset_id <= 0:
            raise ValueError("dataset_id must be positive")
        return self.root / f"dataset-{dataset_id}" / "manifest.jsonl"

    def exists(self, dataset_id: int) -> bool:
        return self.path(dataset_id).is_file()

    def read_optional(self, dataset_id: int) -> bytes | None:
        path = self.path(dataset_id)
        return path.read_bytes() if path.is_file() else None

    def write_records(self, dataset_id: int, records: Iterable[dict[str, Any]]) -> Path:
        payload = b"".join(
            (
                json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
            ).encode("utf-8")
            for record in records
        )
        return self.write_bytes(dataset_id, payload)

    def write_bytes(self, dataset_id: int, payload: bytes) -> Path:
        path = self.path(dataset_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.parent / ".manifest.jsonl.tmp"
        try:
            with temporary.open("wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return path

    def restore(self, dataset_id: int, previous: bytes | None) -> None:
        path = self.path(dataset_id)
        if previous is None:
            path.unlink(missing_ok=True)
            return
        self.write_bytes(dataset_id, previous)
