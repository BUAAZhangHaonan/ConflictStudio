from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIST = ROOT / "frontend" / "dist"


@dataclass
class Sample:
    id: str
    dataset_id: str
    protocol: str
    relation: str
    payload: dict[str, Any]
    revision: int
    archive_status: str


SAMPLES = [
    Sample("sample-001", "dataset-a", "VA", "Conflict", {"asset_id": "asset-001"}, 1, "queued"),
    Sample("sample-002", "dataset-b", "VT", "Aligned", {"asset_id": "asset-002"}, 2, "reviewed"),
]


def json_bytes(payload: Any, status: HTTPStatus = HTTPStatus.OK) -> tuple[int, list[tuple[str, str]], bytes]:
    body = json.dumps(payload).encode("utf-8")
    return status, [("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(body)))], body


def text_bytes(payload: bytes, content_type: str) -> tuple[int, list[tuple[str, str]], bytes]:
    return HTTPStatus.OK, [("Content-Type", content_type), ("Content-Length", str(len(payload)))], payload


def not_found() -> tuple[int, list[tuple[str, str]], bytes]:
    return json_bytes({"detail": "not found"}, HTTPStatus.NOT_FOUND)


class Handler(BaseHTTPRequestHandler):
    server_version = "ConflictStudio/0.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send(self, status: int, headers: list[tuple[str, str]], body: bytes) -> None:
        self.send_response(status)
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/health":
            status, headers, body = json_bytes({"ok": True})
            self._send(status, headers, body)
            return
        if path == "/api/samples":
            status, headers, body = json_bytes([asdict(sample) for sample in SAMPLES])
            self._send(status, headers, body)
            return
        if path == "/api/reviewers/me/statistics":
            status, headers, body = json_bytes(
                {
                    "unique_reviewed": 2,
                    "decision_counts": {"Conflict": 1, "Aligned": 1},
                    "protocol_counts": {"VA": 1, "VT": 1},
                    "activity_30d": 2,
                    "revised_count": 1,
                    "archived_count": 1,
                    "needs_update_count": 0,
                }
            )
            self._send(status, headers, body)
            return
        if path.startswith("/api/media/"):
            asset_id = path.rsplit("/", 1)[-1]
            media = ROOT / "backend" / "data" / f"{asset_id}.bin"
            if not media.is_file():
                status, headers, body = json_bytes({"detail": "media not found"}, HTTPStatus.NOT_FOUND)
                self._send(status, headers, body)
                return
            data = media.read_bytes()
            status, headers, body = text_bytes(data, "application/octet-stream")
            self._send(status, headers, body)
            return
        if path.startswith("/assets/"):
            relative_path = path.removeprefix("/assets/")
            asset = FRONTEND_DIST / "assets" / relative_path
            content_type = {
                ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
            }.get(asset.suffix.lower())
            if relative_path not in {"app.js", "app.css"} or not asset.is_file() or content_type is None:
                self._send(*not_found())
                return
            self._send(*text_bytes(asset.read_bytes(), content_type))
            return
        index = FRONTEND_DIST / "index.html"
        if index.is_file():
            self._send(*text_bytes(index.read_bytes(), "text/html; charset=utf-8"))
            return
        status, headers, body = json_bytes({"detail": "frontend not built"}, HTTPStatus.NOT_FOUND)
        self._send(status, headers, body)

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not path.startswith("/api/samples/"):
            status, headers, body = json_bytes({"detail": "not found"}, HTTPStatus.NOT_FOUND)
            self._send(status, headers, body)
            return
        sample_id = path.rsplit("/", 1)[-1]
        body = self._read_json()
        for index, sample in enumerate(SAMPLES):
            if sample.id == sample_id:
                updated = Sample(
                    id=sample.id,
                    dataset_id=body["dataset_id"],
                    protocol=body["protocol"],
                    relation=body["relation"],
                    payload=body["payload"],
                    revision=sample.revision + 1,
                    archive_status=sample.archive_status,
                )
                SAMPLES[index] = updated
                status, headers, payload = json_bytes(asdict(updated))
                self._send(status, headers, payload)
                return
        status, headers, payload = json_bytes({"detail": "sample not found"}, HTTPStatus.NOT_FOUND)
        self._send(status, headers, payload)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", 8000), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
