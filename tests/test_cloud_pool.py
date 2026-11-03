"""Warm worker lifecycle, failure isolation and exact response correlation."""
import asyncio
import json
import os
import sys
import time
import unittest
from unittest.mock import patch

from deploy.cloud_api import OrbitalAPI
from deploy.worker_pool import WorkerPool, WorkerProtocolError


# A small standalone process exercises the actual pipes and termination path.
# Test actions exist only here; the production worker exposes chemistry.process.
FAKE_WORKER = r'''
import json, os, sys, time
print('{"ready":true,"protocol":1}', flush=True)
for line in sys.stdin.buffer:
    frame = json.loads(line)
    payload = frame['payload']
    action = payload.get('action')
    if action == 'sleep': time.sleep(30)
    if action == 'exit': sys.exit(0)
    if action == 'bad':
        print('not JSON', flush=True)
        continue
    if action == 'oversize':
        print('x'*4096, flush=True)
        continue
    result = {'id': frame['id'] + (1 if action == 'mismatch' else 0),
              'status': 500 if action == 'error' else 200,
              'body': {'pid': os.getpid(), 'secret': 'ORBITAL_API_TOKEN' in os.environ,
                       'echo': payload}}
    print(json.dumps(result), flush=True)
'''


class PoolLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pool = WorkerPool(command=(sys.executable, '-u', '-c', FAKE_WORKER))
        await self.pool.start(10)

    async def asyncTearDown(self):
        await self.pool.close()

    async def test_same_process_handles_successive_jobs_without_mixing_results(self):
        first = await self.pool.compute({'name': '水\n第二行'}, 5)
        second = await self.pool.compute({'name': 'ammonium'}, 5)
        self.assertEqual(first[1]['pid'], second[1]['pid'])
        self.assertEqual(first[1]['echo'], {'name': '水\n第二行'})
        self.assertEqual(second[1]['echo'], {'name': 'ammonium'})
        self.assertEqual(self.pool.workers[0].jobs, 2)

    async def test_timeout_kills_and_reaps_worker_then_next_job_starts_fresh(self):
        child = self.pool.workers[0].process
        with self.assertRaises(asyncio.TimeoutError):
            await self.pool.compute({'action': 'sleep'}, .05)
        self.assertIsNotNone(child.returncode)
        self.assertIsNone(self.pool.workers[0].process)
        status, data = await self.pool.compute({'action': 'next'}, 10)
        self.assertEqual(status, 200)
        self.assertNotEqual(data['pid'], child.pid)
        self.assertEqual(data['echo']['action'], 'next')

    async def test_cancellation_kills_worker_and_does_not_consume_next_job(self):
        child = self.pool.workers[0].process
        pending = asyncio.create_task(self.pool.compute({'action': 'sleep'}, 30))
        await asyncio.sleep(.02)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertIsNotNone(child.returncode)
        self.assertEqual((await self.pool.compute({'after': 'cancel'}, 10))[1]['echo'], {'after': 'cancel'})

    async def test_bad_frame_id_or_exit_is_not_replayed_and_worker_is_discarded(self):
        for action in ('bad', 'mismatch', 'exit'):
            with self.subTest(action=action):
                await self.pool.start(10)
                child = self.pool.workers[0].process
                with self.assertRaises(WorkerProtocolError):
                    await self.pool.compute({'action': action}, 5)
                self.assertIsNotNone(child.returncode)
                self.assertIsNone(self.pool.workers[0].process)
                self.assertEqual(self.pool.available.qsize(), 1)

    async def test_oversized_frame_is_rejected_without_forwarding(self):
        child = self.pool.workers[0].process
        with patch('deploy.worker_pool.MAX_RESPONSE', 1024):
            with self.assertRaises(WorkerProtocolError):
                await self.pool.compute({'action': 'oversize'}, 5)
        self.assertIsNotNone(child.returncode)

    async def test_unknown_chemistry_error_recycles_worker(self):
        child = self.pool.workers[0].process
        self.assertEqual((await self.pool.compute({'action': 'error'}, 5))[0], 500)
        self.assertIsNotNone(child.returncode)

    async def test_capacity_is_bounded_instead_of_queuing_jobs(self):
        pending = asyncio.create_task(self.pool.compute({'action': 'sleep'}, 30))
        await asyncio.sleep(.02)
        try:
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                await self.pool.compute({}, 5)
        finally:
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending

    async def test_shutdown_reaps_all_children_and_prevents_new_jobs(self):
        child = self.pool.workers[0].process
        await self.pool.close()
        self.assertIsNotNone(child.returncode)
        await self.pool.close()  # idempotent
        with self.assertRaisesRegex(RuntimeError, 'closed'):
            await self.pool.compute({}, 5)

    async def test_periodic_recycling_bounds_worker_lifetime(self):
        self.pool.workers[0].max_jobs = 2
        child = self.pool.workers[0].process
        await self.pool.compute({}, 5)
        self.assertIsNone(child.returncode)
        await self.pool.compute({}, 5)
        self.assertIsNotNone(child.returncode)
        self.assertNotEqual((await self.pool.compute({}, 10))[1]['pid'], child.pid)

    async def test_shutdown_cancels_and_reaps_an_inflight_job(self):
        child = self.pool.workers[0].process
        pending = asyncio.create_task(self.pool.compute({'action': 'sleep'}, 30))
        await asyncio.sleep(.02)
        await self.pool.close()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertIsNotNone(child.returncode)
        self.assertEqual(self.pool.active, set())

    async def test_startup_failure_cleans_up_all_parallel_children(self):
        pool = WorkerPool(size=2, command=(sys.executable, '-u', '-c', "import time; print('{}', flush=True); time.sleep(30)"))
        created = []
        real_spawn = asyncio.create_subprocess_exec
        async def tracked_spawn(*args, **kwargs):
            child = await real_spawn(*args, **kwargs)
            created.append(child)
            return child
        with patch('deploy.worker_pool.asyncio.create_subprocess_exec', tracked_spawn):
            with self.assertRaises(WorkerProtocolError):
                await pool.start(10)
        self.assertTrue(created)
        self.assertTrue(all(child.returncode is not None for child in created))
        self.assertTrue(pool.closed)

    async def test_secret_is_removed_from_the_reused_process_environment(self):
        await self.pool.workers[0].close()
        with patch.dict(os.environ, {'ORBITAL_API_TOKEN': 'test-never-real-token'}):
            status, data = await self.pool.compute({}, 10)
        self.assertEqual(status, 200)
        self.assertFalse(data['secret'])


class ChemistryPoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_warm_real_worker_preserves_chemistry_and_user_error_then_recovers(self):
        pool = WorkerPool()
        try:
            await pool.start(30)
            child = pool.workers[0].process
            status, preview = await pool.compute({'action': 'inspect', 'smiles': '[NH4+]'}, 10)
            self.assertEqual(status, 200)
            self.assertTrue(preview['valid'])
            status, model = await pool.compute({'smiles': '[NH4+]', 'samples': 1}, 10)
            self.assertEqual(status, 200)
            self.assertEqual(len(model['atoms']), 5)
            self.assertEqual(len(model['bonds']), 4)
            self.assertEqual((await pool.compute({'smiles': 'C(C)(C)(C)(C)C'}, 10))[0], 422)
            self.assertTrue((await pool.compute({'action': 'inspect', 'smiles': 'O'}, 10))[1]['valid'])
            self.assertIs(pool.workers[0].process, child)
        finally:
            await pool.close()
        self.assertIsNotNone(child.returncode)

    async def test_asgi_lifecycle_preloads_and_shuts_down_its_own_pool(self):
        app = OrbitalAPI('test-' + 'k'*40)
        children = []
        events = iter(({'type': 'lifespan.startup'}, {'type': 'lifespan.shutdown'}))
        sent = []
        async def receive():
            return next(events)
        async def send(event):
            sent.append(event)
            if event['type'] == 'lifespan.startup.complete':
                children.extend(worker.process for worker in app.pool.workers)
        await app({'type': 'lifespan'}, receive, send)
        self.assertEqual([event['type'] for event in sent], ['lifespan.startup.complete', 'lifespan.shutdown.complete'])
        self.assertEqual(len(children), 1)
        self.assertTrue(all(child.returncode is not None for child in children))

    async def test_http_disconnect_cancels_active_job_and_releases_slot(self):
        began, cancelled = asyncio.Event(), asyncio.Event()
        async def execute(payload, timeout):
            began.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        token = 'test-' + 'k'*40
        app = OrbitalAPI(token, executor=execute)
        sent = []
        first = True
        async def receive():
            nonlocal first
            if first:
                first = False
                return {'type': 'http.request', 'body': b'{"smiles":"O"}'}
            await began.wait()
            return {'type': 'http.disconnect'}
        async def send(event):
            sent.append(event)
        scope = {'type': 'http', 'path': '/api/molecule', 'method': 'POST',
                 'headers': [(b'authorization', ('Bearer '+token).encode()), (b'content-type', b'application/json')]}
        await app(scope, receive, send)
        self.assertTrue(cancelled.is_set())
        self.assertFalse(app.slots.locked())
        self.assertEqual(sent, [])


if __name__ == '__main__':
    unittest.main()
