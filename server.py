"""ORBITAL local-only application server. No network chemistry services are used."""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import platform
import socket
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "python_lib"))
import rdkit
import chemistry

APP = "orbital-molecular-studio"
VERSION = "1.2.0"
INSTANCE = hashlib.sha256(ROOT.as_posix().casefold().encode("utf-8")).hexdigest()[:20]
DIST = ROOT / "dist"
MAX_BODY = 2 * 1024 * 1024
COMPUTE_SLOTS = threading.BoundedSemaphore(2)
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


class Handler(BaseHTTPRequestHandler):
    server_version = "ORBITAL/1.0"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def _json(self, status, value):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _trusted_request(self):
        port = self.server.server_port
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "").lower()
        if host not in allowed:
            self._json(403, {"error": "僅允許透過本機位址存取。"})
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{item}" for item in allowed}:
            self._json(403, {"error": "已拒絕其他網站的跨來源請求。"})
            return False
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self._json(403, {"error": "已拒絕其他網站的跨來源請求。"})
            return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._trusted_request():
            return
        route = urlsplit(self.path).path
        if route == "/api/health":
            self._json(200, {"app": APP, "version": VERSION, "instance": INSTANCE,
                             "pid": os.getpid(), "rdkitVersion": rdkit.__version__,
                             "pythonVersion": platform.python_version(), "status": "ready"})
            return
        if route.startswith("/api/"):
            self._json(404, {"error": "找不到此 API。"})
            return
        try:
            requested = (DIST / unquote(route).lstrip("/")).resolve()
            if not requested.is_relative_to(DIST.resolve()):
                self._json(403, {"error": "無法存取此路徑。"})
                return
            if requested.is_dir():
                requested = requested / "index.html"
            if not requested.is_file():
                # Only extensionless client routes may fall back to the application.
                if requested.suffix:
                    self._json(404, {"error": "找不到此檔案。"})
                    return
                requested = DIST / "index.html"
            if not requested.is_file():
                self._json(503, {"error": "找不到網頁建置檔 dist/index.html。請先執行 npm run build。"})
                return
            data = requested.read_bytes()
            self.send_response(200)
            content_type = mimetypes.guess_type(str(requested))[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type == "application/javascript":
                content_type += "; charset=utf-8"
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except (OSError, ValueError):
            self._json(400, {"error": "檔案路徑無效或無法讀取。"})

    def do_POST(self):
        if not self._trusted_request():
            return
        if urlsplit(self.path).path != "/api/molecule":
            self._json(404, {"error": "找不到此 API。"})
            return
        if self.headers.get_content_type() != "application/json":
            self._json(415, {"error": "請使用 application/json 傳送資料。"})
            return
        if self.headers.get("Transfer-Encoding"):
            self._json(400, {"error": "不支援分段傳輸。"})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"error": "資料長度無效。"})
            return
        if not 0 < size <= MAX_BODY:
            self._json(413, {"error": "資料不得為空，且不可超過 2 MB。"})
            return
        try:
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise ValueError("Incomplete request")
            payload = json.loads(raw.decode("utf-8-sig"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite number")))
            if not isinstance(payload, dict):
                raise ValueError("Expected object")
        except (ValueError, UnicodeError, socket.timeout):
            self._json(400, {"error": "無法讀取 JSON 資料，請檢查檔案格式。"})
            return
        if not COMPUTE_SLOTS.acquire(blocking=False):
            self._json(429, {"error": "計算引擎忙碌中，請稍後再試。"})
            return
        try:
            result = chemistry.process(payload)
            self._json(200, result)
        except (ValueError, KeyError, TypeError, IndexError, RuntimeError) as exc:
            self._json(422, {"error": str(exc) or "無法處理此分子，請檢查結構與價數。"})
        except Exception:
            traceback.print_exc()
            self._json(500, {"error": "計算發生未預期錯誤，詳細資訊已記錄於本機服務日誌。"})
        finally:
            COMPUTE_SLOTS.release()

    def do_OPTIONS(self):
        self._json(403, {"error": "不開放跨來源存取。"})


def main():
    parser = argparse.ArgumentParser(description="ORBITAL local molecular studio")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    server = LocalServer(("127.0.0.1", args.port), Handler)
    print(f"ORBITAL {VERSION} | RDKit {rdkit.__version__} | http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
