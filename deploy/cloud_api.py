"""Authenticated ASGI transport for the unchanged chemistry.process API.

Browser -> private Sites -> this service. The Sites Worker holds the bearer
token; browser JavaScript never receives it. Run one ASGI process per container.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
MAX_BODY = 2 * 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024
VERSION = "1.2.0"


async def compute(payload: dict, timeout: float):
    """A hard deadline kills the job, including time spent in native RDKit."""
    child = await asyncio.create_subprocess_exec(
        sys.executable, str(ROOT / "deploy" / "compute_worker.py"),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, cwd=str(ROOT),
        env={key: value for key, value in os.environ.items() if key != "ORBITAL_API_TOKEN"},
    )
    try:
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        stdout, _ = await asyncio.wait_for(child.communicate(data), timeout)
        if child.returncode != 0 or len(stdout) > MAX_RESPONSE:
            raise RuntimeError("Chemistry worker failed")
        result = json.loads(stdout)
        if result.get("status") not in (200, 422, 500) or not isinstance(result.get("body"), dict):
            raise RuntimeError("Invalid worker response")
        return result["status"], result["body"]
    finally:
        if child.returncode is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
            await child.wait()


class OrbitalAPI:
    def __init__(self, token=None, *, concurrency=1, timeout=45.0, executor=compute):
        self.token = token if token is not None else os.environ.get("ORBITAL_API_TOKEN", "")
        self.configured = (isinstance(self.token, str) and len(self.token) >= 32
                           and self.token.isascii() and not any(c.isspace() or ord(c) < 33 or ord(c) > 126 for c in self.token))
        self.slots = asyncio.BoundedSemaphore(max(1, min(int(concurrency), 4)))
        self.timeout = max(1.0, min(float(timeout), 120.0))
        self.executor = executor

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                event = await receive()
                if event["type"] == "lifespan.startup":
                    if not self.configured:
                        await send({"type": "lifespan.startup.failed", "message": "Set ORBITAL_API_TOKEN to a random secret of at least 32 bytes."})
                        return
                    await send({"type": "lifespan.startup.complete"})
                elif event["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return

        async def reply(status, body, extra_headers=()):
            encoded = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
            headers = [(b"content-type", b"application/json; charset=utf-8"),
                       (b"content-length", str(len(encoded)).encode()),
                       (b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff")]
            await send({"type": "http.response.start", "status": status, "headers": headers + list(extra_headers)})
            await send({"type": "http.response.body", "body": encoded})

        if not self.configured:
            await reply(503, {"error": "計算服務尚未完成設定。"})
            return
        path, method = scope.get("path", ""), scope.get("method", "")
        if path == "/healthz" and method == "GET":
            await reply(200, {"status": "ready", "app": "orbital-chemistry", "version": VERSION})
            return
        if path not in ("/api/molecule", "/api/health"):
            await reply(404, {"error": "找不到此 API。"})
            return
        # Header names are case-insensitive. Reject duplicate credentials.
        header_list = [(key.lower(), value) for key, value in scope.get("headers", [])]
        credentials = [value for key, value in header_list if key == b"authorization"]
        expected = ("Bearer " + self.token).encode("utf-8")
        if len(credentials) != 1 or not hmac.compare_digest(credentials[0], expected):
            await reply(401, {"error": "計算服務驗證失敗。"}, [(b"www-authenticate", b"Bearer")])
            return
        headers = dict(header_list)
        # This endpoint is server-to-server only. No permissive CORS headers.
        if b"origin" in headers:
            await reply(403, {"error": "請透過已登入的網站使用計算服務。"})
            return
        if path == "/api/health" and method == "GET":
            await reply(200, {"status": "ready", "app": "orbital-chemistry", "version": VERSION})
            return
        if path != "/api/molecule" or method != "POST":
            await reply(405, {"error": "不支援此請求方法。"})
            return
        if any(sum(key == name for key, _ in header_list) > 1
               for name in (b"content-length", b"content-type")):
            await reply(400, {"error": "請求標頭重複，請重新操作。"})
            return
        if headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower() != b"application/json":
            await reply(415, {"error": "請使用 application/json 傳送資料。"})
            return
        length = None
        if b"content-length" in headers:
            try:
                length = int(headers[b"content-length"])
            except ValueError:
                await reply(400, {"error": "資料長度無效。"})
                return
            if not 0 < length <= MAX_BODY:
                await reply(413, {"error": "資料不得為空，且不可超過 2 MB。"})
                return

        async def read_body():
            body = bytearray()
            while True:
                event = await receive()
                if event["type"] == "http.disconnect":
                    raise ConnectionError()
                if event["type"] != "http.request":
                    raise ValueError()
                body.extend(event.get("body", b""))
                if len(body) > MAX_BODY:
                    raise OverflowError()
                if not event.get("more_body", False):
                    return body

        try:
            raw = await asyncio.wait_for(read_body(), 10)
            if length is not None and len(raw) != length:
                raise ValueError()
            payload = json.loads(raw.decode("utf-8-sig"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(payload, dict):
                raise ValueError()
        except ConnectionError:
            return
        except OverflowError:
            await reply(413, {"error": "資料不可超過 2 MB。"})
            return
        except asyncio.TimeoutError:
            await reply(408, {"error": "資料傳送逾時，請重新操作。"})
            return
        except (ValueError, UnicodeError, RecursionError):
            await reply(400, {"error": "無法讀取 JSON 資料，請檢查檔案格式。"})
            return
        if self.slots.locked():
            await reply(429, {"error": "計算引擎忙碌中，請稍後再試。"}, [(b"retry-after", b"2")])
            return
        await self.slots.acquire()
        try:
            status, result = await self.executor(payload, self.timeout)
            await reply(status, result)
        except asyncio.TimeoutError:
            await reply(504, {"error": "計算逾時，請減少候選構象數或縮小分子後重試。"})
        except Exception:
            await reply(500, {"error": "計算服務暫時無法完成，請稍後重試。"})
        finally:
            self.slots.release()


app = OrbitalAPI(
    concurrency=os.environ.get("ORBITAL_CONCURRENCY", "1"),
    timeout=os.environ.get("ORBITAL_TIMEOUT_SECONDS", "45"),
)
