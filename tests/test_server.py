"""Local transport and file-serving regression tests (no browser or npm needed)."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class LocalServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = tempfile.TemporaryDirectory(prefix="server-test-", dir=Path(__file__).resolve().parent)
        cls.dist_patch = patch.object(server, "DIST", Path(cls.files.name))
        cls.dist_patch.start()
        (server.DIST / "index.html").write_text("<html>ORBITAL 測試</html>", encoding="utf-8")
        (server.DIST / "main.js").write_text("const ok = true;", encoding="utf-8")
        cls.http = server.LocalServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.http.server_port
        cls.worker = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.worker.join(timeout=3)
        cls.dist_patch.stop()
        cls.files.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body, headers or {})
        response = connection.getresponse()
        status, response_headers, data = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return status, response_headers, data

    def test_health_identifies_service(self):
        status, headers, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["app"], "orbital-molecular-studio")
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_static_mime_and_browser_security(self):
        status, headers, body = self.request("GET", "/main.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers["Content-Type"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["X-Frame-Options"], "DENY")

    def test_spa_route_but_missing_asset_is_404(self):
        self.assertEqual(self.request("GET", "/editor")[0], 200)
        self.assertEqual(self.request("GET", "/missing.js")[0], 404)

    def test_traversal_cannot_read_project_source(self):
        self.assertEqual(self.request("GET", "/%2e%2e/server.py")[0], 403)
        self.assertEqual(self.request("GET", "/%2e%2e%5cserver.py")[0], 403)

    def test_untrusted_host_and_origin_rejected(self):
        self.assertEqual(self.request("GET", "/api/health", headers={"Host": f"example.org:{self.port}"})[0], 403)
        self.assertEqual(self.request("GET", "/api/health", headers={"Origin": "https://example.org"})[0], 403)
        self.assertEqual(self.request("GET", "/api/health", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)

    def test_same_origin_payload_dispatch(self):
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"}
        with patch.object(server.chemistry, "process", return_value={"formula": "H2O"}) as process:
            status, _, body = self.request("POST", "/api/molecule", '{"action":"generate","smiles":"O"}', headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"formula": "H2O"})
        process.assert_called_once_with({"action": "generate", "smiles": "O"})

    def test_invalid_payloads(self):
        headers = {"Content-Type": "application/json"}
        for data in ("[1,2]", "{broken", '{"x":NaN}', '{"x":Infinity}'):
            self.assertEqual(self.request("POST", "/api/molecule", data, headers)[0], 400)
        self.assertEqual(self.request("POST", "/api/molecule", "{}", {"Content-Type": "text/plain"})[0], 415)

    def test_oversized_body_rejected_before_reading(self):
        status, _, _ = self.request("POST", "/api/molecule", "", {"Content-Type": "application/json", "Content-Length": str(server.MAX_BODY + 1)})
        self.assertEqual(status, 413)

    def test_chemical_validation_error_is_json(self):
        with patch.object(server.chemistry, "process", side_effect=ValueError("原子價數無效")):
            status, _, body = self.request("POST", "/api/molecule", "{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 422)
        self.assertEqual(json.loads(body)["error"], "原子價數無效")

    def test_head_has_no_body(self):
        status, headers, body = self.request("HEAD", "/")
        self.assertEqual(status, 200)
        self.assertGreater(int(headers["Content-Length"]), 0)
        self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main(verbosity=2)
