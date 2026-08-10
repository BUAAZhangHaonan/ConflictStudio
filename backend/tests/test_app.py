import json
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Iterator
from unittest.mock import patch
from http.client import HTTPConnection
from socketserver import TCPServer

from backend.app import Handler


class ServerThread(threading.Thread):
    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.httpd = TCPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]

    def run(self) -> None:
        self.httpd.serve_forever()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ServerThread()
        cls.server.start()
        time.sleep(0.05)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.stop()

    def request_raw(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict[str, str], bytes]:
        conn = HTTPConnection("127.0.0.1", self.server.port, timeout=2)
        headers = {}
        data = None
        if body is not None:
            data = json.dumps(body)
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        response = conn.getresponse()
        payload = response.read()
        return response.status, dict(response.getheaders()), payload

    def request(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict[str, str], object]:
        status, headers, payload = self.request_raw(method, path, body)
        parsed = json.loads(payload) if payload else None
        return status, headers, parsed

    def test_health(self) -> None:
        status, _, payload = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True})

    def test_samples(self) -> None:
        status, _, payload = self.request("GET", "/api/samples")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload), 2)

    def test_static_assets_use_correct_content_types(self) -> None:
        with self.frontend_dist() as dist:
            (dist / "assets" / "app.js").write_text("console.log('ok')", encoding="utf-8")
            (dist / "assets" / "app.css").write_text("body {}", encoding="utf-8")

            js_status, js_headers, js_body = self.request_raw("GET", "/assets/app.js")
            css_status, css_headers, css_body = self.request_raw("GET", "/assets/app.css")

        self.assertEqual(js_status, 200)
        self.assertEqual(js_headers["Content-Type"], "text/javascript; charset=utf-8")
        self.assertEqual(js_body, b"console.log('ok')")
        self.assertEqual(css_status, 200)
        self.assertEqual(css_headers["Content-Type"], "text/css; charset=utf-8")
        self.assertEqual(css_body, b"body {}")

    def test_deep_link_returns_index(self) -> None:
        with self.frontend_dist() as dist:
            (dist / "index.html").write_text("<main>ConflictStudio</main>", encoding="utf-8")
            status, headers, body = self.request_raw("GET", "/review/sample-001")

        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
        self.assertEqual(body, b"<main>ConflictStudio</main>")

    def test_missing_static_asset_returns_404(self) -> None:
        with self.frontend_dist():
            status, headers, payload = self.request("GET", "/assets/missing.js")

        self.assertEqual(status, 404)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(payload, {"detail": "not found"})

    @staticmethod
    @contextmanager
    def frontend_dist() -> Iterator[Path]:
        with TemporaryDirectory() as directory:
            dist = Path(directory)
            (dist / "assets").mkdir()
            with patch("backend.app.FRONTEND_DIST", dist):
                yield dist


if __name__ == "__main__":
    unittest.main()
