"""Reusable RDKit subprocesses with killable per-job deadlines.

The HTTP process never loads RDKit. Each slot owns one sequential worker, so a
timeout, cancellation or protocol failure can discard just that worker. Failed
jobs are not replayed. No job payload or credential is written to disk.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
MAX_REQUEST = 2 * 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024


class WorkerProtocolError(RuntimeError):
    pass


class _Worker:
    def __init__(self, *, command=None, max_jobs=500):
        self.command = command or (sys.executable, str(ROOT / "deploy" / "compute_worker.py"), "--persistent")
        self.max_jobs = max_jobs
        self.process = None
        self.jobs = 0
        self.sequence = 0

    async def close(self):
        child, self.process = self.process, None
        self.jobs = 0
        if child is None:
            return
        if child.returncode is None:
            try:
                child.kill()
            except ProcessLookupError:
                pass
        # Reaping is required even if the process exited before close().
        await child.wait()
        if child.stdin is not None:
            child.stdin.close()

    async def start(self):
        if self.process is not None and self.process.returncode is None:
            return
        await self.close()
        spawning = asyncio.create_task(asyncio.create_subprocess_exec(
            *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, cwd=str(ROOT), limit=MAX_RESPONSE + 1,
            env={key: value for key, value in os.environ.items() if key != "ORBITAL_API_TOKEN"},
        ))
        try:
            self.process = await asyncio.shield(spawning)
        except asyncio.CancelledError:
            # Retain the handle if cancellation races with process creation.
            self.process = await spawning
            await self.close()
            raise
        ready = await self.read_frame()
        if ready != {"ready": True, "protocol": 1}:
            raise WorkerProtocolError("Invalid worker handshake")

    async def read_frame(self):
        try:
            line = await self.process.stdout.readline()
            if not line.endswith(b"\n") or len(line) > MAX_RESPONSE:
                raise ValueError()
            frame = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(frame, dict):
                raise ValueError()
            return frame
        except (ValueError, UnicodeError, RecursionError) as exc:
            raise WorkerProtocolError("Invalid worker response") from exc

    async def exchange(self, payload):
        await self.start()
        self.sequence += 1
        frame = json.dumps({"id": self.sequence, "payload": payload}, ensure_ascii=False,
                           allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
        if len(frame) > MAX_REQUEST + 128:
            raise ValueError("Worker request too large")
        self.process.stdin.write(frame)
        await self.process.stdin.drain()
        response = await self.read_frame()
        if (response.get("id") != self.sequence or response.get("status") not in (200, 422, 500)
                or not isinstance(response.get("body"), dict)):
            raise WorkerProtocolError("Invalid worker response")
        self.jobs += 1
        return response["status"], response["body"]


class WorkerPool:
    def __init__(self, size=1, *, max_jobs=500, command=None):
        self.workers = [_Worker(command=command, max_jobs=max(1, int(max_jobs)))
                        for _ in range(max(1, min(int(size), 4)))]
        self.available = asyncio.Queue(maxsize=len(self.workers))
        for worker in self.workers:
            self.available.put_nowait(worker)
        self.closed = False
        self.active = set()
        self.starting = set()

    async def start(self, timeout=45.0):
        if self.closed:
            raise RuntimeError("Worker pool is closed")
        starts = {asyncio.create_task(worker.start()) for worker in self.workers}
        self.starting.update(starts)
        try:
            await asyncio.wait_for(asyncio.gather(*starts), timeout)
        except BaseException:
            for task in starts:
                task.cancel()
            await asyncio.gather(*starts, return_exceptions=True)
            await self.close()
            raise
        finally:
            self.starting.difference_update(starts)

    async def compute(self, payload, timeout):
        if self.closed:
            raise RuntimeError("Worker pool is closed")
        # The HTTP adapter rejects excess requests before calling us. Also bound
        # direct callers: never create an unbounded queue of native jobs.
        try:
            worker = self.available.get_nowait()
        except asyncio.QueueEmpty as exc:
            raise RuntimeError("Worker pool is busy") from exc
        task = asyncio.current_task()
        self.active.add(task)
        try:
            result = await asyncio.wait_for(worker.exchange(payload), timeout)
            if result[0] == 500 or worker.jobs >= worker.max_jobs:
                await worker.close()
            return result
        except BaseException:
            await worker.close()
            raise
        finally:
            self.active.discard(task)
            if not self.closed:
                self.available.put_nowait(worker)

    async def close(self):
        self.closed = True
        tasks = (self.active | self.starting) - {asyncio.current_task()}
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(worker.close() for worker in self.workers))
