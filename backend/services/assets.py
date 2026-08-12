from __future__ import annotations

from os import stat_result
from pathlib import Path

from backend.adapters.database import Database
from backend.adapters.media import MediaError, MediaStore
from backend.domain.models import Asset

from .errors import ServiceError, not_found


def asset_content_url(asset_id: int | None) -> str | None:
    return f"/api/media/{asset_id}" if asset_id is not None else None


class AssetService:
    def __init__(self, database: Database) -> None:
        self.database = database
        self.media_store = MediaStore(database.data_root)

    def content(self, asset_id: int) -> tuple[Path, str, stat_result]:
        with self.database.read_session() as session:
            asset = session.get(Asset, asset_id)
            if asset is None:
                raise not_found("asset", asset_id)
            if Path(asset.storage_root).resolve() != self.media_store.data_root:
                raise self._unavailable(asset_id)
            try:
                path = self.media_store.resolve(asset.relative_path)
            except MediaError as error:
                raise self._unavailable(asset_id) from error
            if not path.is_file():
                raise self._unavailable(asset_id)
            evidence = path.stat()
            if evidence.st_size != asset.byte_size:
                raise self._unavailable(asset_id)
            return path, asset.media_type, evidence

    @staticmethod
    def _unavailable(asset_id: int) -> ServiceError:
        return ServiceError(
            404,
            "asset_unavailable",
            "The requested media is not available",
            {"resource": "asset", "id": asset_id},
        )
