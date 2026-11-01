"""Cloud transport checks without requiring a web server or third-party test client."""
import asyncio
import json
import time
import unittest
from unittest.mock import AsyncMock, patch

from deploy import cloud_api
from deploy.cloud_api import OrbitalAPI, compute


TOKEN = "test-only-" + "k" * 48
AUTH = (b"authorization", ("Bearer " + TOKEN).encode())
JSON_TYPE = (b"content-type", b"application/json; charset=utf-8")


async def request(app, *, path="/api/molecule", method="POST", body=b'{"smiles":"O"}',
                  headers=None, events=None):
    if headers is None:
        headers = [AUTH, JSON_TYPE]
    queue = list(events) if events is not None else [{"type": "http.request", "body": body}]
    sent = []

    async def receive():
        if queue:
            return queue.pop(0)
        return {"type": "http.disconnect"}

    async def send(event):
        sent.append(event)

    await app({"type": "http", "path": path, "method": method, "headers": headers}, receive, send)
    if not sent:
        return None
    return {"status": sent[0]["status"], "headers": dict(sent[0]["headers"]),
            "body": json.loads(b"".join(event.get("body", b"") for event in sent[1:]))}


class CloudTransportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.executor = AsyncMock(return_value=(200, {"formula": "H2O"}))
        self.api = OrbitalAPI(TOKEN, executor=self.executor)

    async def test_health_endpoint_is_minimal_and_does_not_compute(self):
        result = await request(self.api, path="/healthz", method="GET", headers=[])
        self.assertEqual(result["status"], 200)
        self.assertEqual(set(result["body"]), {"status", "app", "version"})
        self.assertEqual(result["headers"][b"cache-control"], b"no-store")
        self.executor.assert_not_awaited()

    async def test_private_health_requires_the_exact_bearer_token(self):
        for headers in ([], [(b"authorization", b"Bearer wrong")], [AUTH, AUTH]):
            result = await request(self.api, path="/api/health", method="GET", headers=headers)
            self.assertEqual(result["status"], 401)
            self.assertEqual(result["headers"][b"www-authenticate"], b"Bearer")
        result = await request(self.api, path="/api/health", method="GET", headers=[AUTH])
        self.assertEqual(result["status"], 200)

    async def test_missing_short_or_unsafe_secret_fails_closed(self):
        for secret in ("", "short", " " * 40, "x" * 40 + "\n", "密" * 40):
            api = OrbitalAPI(secret, executor=self.executor)
            result = await request(api, path="/healthz", method="GET", headers=[])
            self.assertEqual(result["status"], 503)
        self.executor.assert_not_awaited()

    async def test_lifespan_startup_rejects_missing_configuration(self):
        sent = []
        async def send(event):
            sent.append(event)
        await OrbitalAPI("")({"type": "lifespan"}, AsyncMock(return_value={"type": "lifespan.startup"}), send)
        self.assertEqual(sent[0]["type"], "lifespan.startup.failed")

    async def test_lifespan_completes_startup_and_shutdown(self):
        sent = []
        async def send(event):
            sent.append(event)
        await self.api({"type": "lifespan"}, AsyncMock(side_effect=[{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}]), send)
        self.assertEqual([x["type"] for x in sent], ["lifespan.startup.complete", "lifespan.shutdown.complete"])

    async def test_browser_origin_is_rejected_even_with_valid_secret(self):
        result = await request(self.api, headers=[AUTH, JSON_TYPE, (b"origin", b"https://example.com")])
        self.assertEqual(result["status"], 403)
        self.assertFalse(any(key.startswith(b"access-control-") for key in result["headers"]))
        self.executor.assert_not_awaited()

    async def test_http_header_names_are_case_insensitive(self):
        result = await request(self.api, headers=[(b"Authorization", AUTH[1]), (b"Content-Type", JSON_TYPE[1])])
        self.assertEqual(result["status"], 200)

    async def test_routes_and_http_methods_are_bounded(self):
        result = await request(self.api, path="/api/anything")
        self.assertEqual(result["status"], 404)
        for path, method in [("/api/molecule", "GET"), ("/api/molecule", "OPTIONS"), ("/api/health", "POST")]:
            result = await request(self.api, path=path, method=method)
            self.assertEqual(result["status"], 405)
        self.executor.assert_not_awaited()

    async def test_only_json_requests_are_accepted(self):
        for headers in ([AUTH], [AUTH, (b"content-type", b"text/plain")]):
            result = await request(self.api, headers=headers)
            self.assertEqual(result["status"], 415)
        self.executor.assert_not_awaited()

    async def test_malformed_json_nonobjects_and_nonfinite_numbers_are_rejected(self):
        for body in (b"", b"{bad", b"[]", b"null", b"1", b'{"samples":NaN}', b'{"samples":Infinity}', b"\xff"):
            with self.subTest(body=body):
                result = await request(self.api, body=body)
                self.assertEqual(result["status"], 400)
        self.executor.assert_not_awaited()

    async def test_declared_body_size_is_checked(self):
        for value, expected in [(b"no", 400), (b"0", 413), (b"-1", 413), (str(cloud_api.MAX_BODY + 1).encode(), 413)]:
            result = await request(self.api, headers=[AUTH, JSON_TYPE, (b"content-length", value)])
            self.assertEqual(result["status"], expected)
        self.executor.assert_not_awaited()

    async def test_conflicting_or_mismatched_content_headers_are_rejected(self):
        for headers in ([AUTH, JSON_TYPE, JSON_TYPE],
                        [AUTH, JSON_TYPE, (b"content-length", b"14"), (b"content-length", b"14")],
                        [AUTH, JSON_TYPE, (b"content-length", b"99")]):
            result = await request(self.api, headers=headers)
            self.assertEqual(result["status"], 400)
        self.executor.assert_not_awaited()

    async def test_streamed_body_cannot_bypass_the_size_limit(self):
        with patch.object(cloud_api, "MAX_BODY", 20):
            result = await request(self.api, events=[
                {"type": "http.request", "body": b"x" * 15, "more_body": True},
                {"type": "http.request", "body": b"x" * 15},
            ])
        self.assertEqual(result["status"], 413)
        self.executor.assert_not_awaited()

    async def test_valid_chunked_utf8_input_and_bom_reach_the_executor(self):
        body = b"\xef\xbb\xbf" + json.dumps({"smiles": "O", "name": "水"}, ensure_ascii=False).encode()
        result = await request(self.api, events=[
            {"type": "http.request", "body": body[:10], "more_body": True},
            {"type": "http.request", "body": body[10:]},
        ])
        self.assertEqual(result["status"], 200)
        self.executor.assert_awaited_once_with({"smiles": "O", "name": "水"}, 45.0)

    async def test_disconnected_upload_does_not_start_a_job(self):
        result = await request(self.api, events=[{"type": "http.disconnect"}])
        self.assertIsNone(result)
        self.executor.assert_not_awaited()

    async def test_chemistry_errors_keep_their_user_facing_status(self):
        self.executor.return_value = (422, {"error": "原子價數不成立"})
        result = await request(self.api)
        self.assertEqual(result["status"], 422)
        self.assertEqual(result["body"]["error"], "原子價數不成立")

    async def test_unexpected_errors_do_not_expose_secrets_or_tracebacks(self):
        self.executor.side_effect = RuntimeError(TOKEN + " private detail")
        result = await request(self.api)
        self.assertEqual(result["status"], 500)
        self.assertNotIn(TOKEN, repr(result))
        self.assertNotIn("private detail", repr(result))
        self.executor.side_effect = None
        self.assertEqual((await request(self.api))["status"], 200)

    async def test_timeout_releases_the_compute_slot(self):
        self.executor.side_effect = asyncio.TimeoutError()
        result = await request(self.api)
        self.assertEqual(result["status"], 504)
        self.executor.side_effect = None
        self.assertEqual((await request(self.api))["status"], 200)

    async def test_full_capacity_rejects_without_queuing_more_native_jobs(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def slow(payload, timeout):
            started.set()
            await release.wait()
            return 200, {"formula": "H2O"}
        api = OrbitalAPI(TOKEN, concurrency=1, executor=slow)
        first = asyncio.create_task(request(api))
        await started.wait()
        try:
            second = await request(api)
            self.assertEqual(second["status"], 429)
            self.assertEqual(second["headers"][b"retry-after"], b"2")
        finally:
            release.set()
            self.assertEqual((await first)["status"], 200)
        self.assertEqual((await request(api))["status"], 200)

    async def test_cancelled_request_releases_the_compute_slot(self):
        started = asyncio.Event()
        async def waiting(payload, timeout):
            started.set()
            await asyncio.Event().wait()
        api = OrbitalAPI(TOKEN, concurrency=1, executor=waiting)
        pending = asyncio.create_task(request(api))
        await started.wait()
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        api.executor = self.executor
        self.assertEqual((await request(api))["status"], 200)


class CloudWorkerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_worker_inspects_and_generates_with_the_pinned_rdkit(self):
        status, data = await compute({"action": "inspect", "smiles": "O"}, 30)
        self.assertEqual(status, 200)
        self.assertTrue(data["valid"])
        status, data = await compute({"smiles": "C[N+](=O)[O-]", "samples": 1}, 30)
        self.assertEqual(status, 200)
        self.assertEqual(data["formula"], "CH3NO2")
        self.assertEqual(data["charge"], 0)
        self.assertTrue(data["atoms"])
        self.assertTrue(data["molblock"])

    async def test_real_worker_returns_chemistry_failure_as_422(self):
        status, data = await compute({"smiles": "C(C)(C)(C)(C)C", "samples": 1}, 30)
        self.assertEqual(status, 422)
        self.assertIn("error", data)

    async def test_real_worker_is_killed_and_reaped_on_hard_timeout(self):
        created = []
        real_create = asyncio.create_subprocess_exec
        async def track(*args, **kwargs):
            child = await real_create(*args, **kwargs)
            created.append(child)
            return child
        start = time.monotonic()
        with patch.object(cloud_api.asyncio, "create_subprocess_exec", track):
            with self.assertRaises(asyncio.TimeoutError):
                await compute({"action": "inspect", "smiles": "O"}, .0001)
        self.assertEqual(len(created), 1)
        self.assertIsNotNone(created[0].returncode)
        self.assertLess(time.monotonic() - start, 5)

    async def test_worker_does_not_inherit_the_api_secret(self):
        child = type("Process", (), {"returncode": 0})()
        child.communicate = AsyncMock(return_value=(b'{"status":200,"body":{}}', None))
        spawn = AsyncMock(return_value=child)
        with patch.dict(cloud_api.os.environ, {"ORBITAL_API_TOKEN": TOKEN}), patch.object(cloud_api.asyncio, "create_subprocess_exec", spawn):
            await compute({}, 5)
        self.assertNotIn("ORBITAL_API_TOKEN", spawn.call_args.kwargs["env"])

    async def test_bad_or_oversized_worker_reply_is_not_forwarded(self):
        for output in (b"not json", b'{"status":201,"body":{}}', b'{"status":200,"body":[]}'):
            child = type("Process", (), {"returncode": 0})()
            child.communicate = AsyncMock(return_value=(output, None))
            with patch.object(cloud_api.asyncio, "create_subprocess_exec", AsyncMock(return_value=child)):
                with self.assertRaises((ValueError, RuntimeError)):
                    await compute({}, 5)
        child.communicate = AsyncMock(return_value=(b'{"status":200,"body":{}}', None))
        with patch.object(cloud_api, "MAX_RESPONSE", 5), patch.object(cloud_api.asyncio, "create_subprocess_exec", AsyncMock(return_value=child)):
            with self.assertRaises(RuntimeError):
                await compute({}, 5)


if __name__ == "__main__":
    unittest.main()
