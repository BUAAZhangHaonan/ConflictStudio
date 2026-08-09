import json
import threading
import time
import unittest
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

    def request(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict[str, str], object]:
        conn = HTTPConnection("127.0.0.1", self.server.port, timeout=2)
        headers = {}
        data = None
        if body is not None:
            data = json.dumps(body)
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        response = conn.getresponse()
        payload = response.read()
        parsed = json.loads(payload) if payload else None
        return response.status, dict(response.getheaders()), parsed

    def test_health(self) -> None:
        status, _, payload = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload, {"ok": True})

    def test_samples(self) -> None:
        status, _, payload = self.request("GET", "/api/samples")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload), 2)


if __name__ == "__main__":
    unittest.main()
