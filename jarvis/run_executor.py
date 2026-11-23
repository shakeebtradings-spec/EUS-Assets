"""RunExecutor: the ONLY place Claude Code is spawned for a run.

Invariants: every run reaches a terminal state; every transition is a DB write
BEFORE the notification.
"""
import asyncio
import os
import shutil
from typing import Awaitable, Callable

import run_store
from claude_env import child_env
from stream_parser import describe, parse_line

Notify = Callable[[str, str], Awaitable[None]]


def default_argv(prompt: str) -> list[str]:
    argv = [os.environ.get("JARVIS_CLAUDE_BIN") or shutil.which("claude") or "claude",
            "-p", prompt, "--output-format", "stream-json", "--verbose"]
    if os.environ.get("JARVIS_SKIP_PERMISSIONS", "1") not in ("0", "false", ""):
        argv.append("--dangerously-skip-permissions")  # no TTY to answer prompts
    return argv


class RunExecutor:
    def __init__(self, notify: Notify | None = None, argv_factory=default_argv,
                 timeout: float = 3600.0, max_concurrent: int = 3):
        self.notify = notify
        self.argv_factory = argv_factory
        self.timeout = timeout
        self._sem = asyncio.Semaphore(max_concurrent)
        self._tasks: dict[str, asyncio.Task] = {}
        self._procs: dict[str, asyncio.subprocess.Process] = {}

    async def _emit(self, rid: str, status: str) -> None:
        if self.notify:
            try:
                await self.notify(rid, status)
            except Exception:
                pass  # a dead listener must never break a run

    def submit(self, prompt: str, cwd: str) -> str:
        if not os.path.isdir(cwd):
            raise ValueError(f"not a directory: {cwd}")
        rid = run_store.create_run(prompt, cwd)
        try:
            self._tasks[rid] = asyncio.get_running_loop().create_task(self._drive(rid, prompt, cwd))
        except BaseException as e:  # hand-off failed: the run must not stay queued
            run_store.set_status(rid, "failed", error=f"could not start: {e}")
            raise
        return rid

    async def cancel(self, rid: str) -> bool:
        t = self._tasks.get(rid)
        if not t or t.done():
            return False
        t.cancel()
        try:
            await t
        except BaseException:
            pass
        return True

    async def wait(self, rid: str) -> None:
        t = self._tasks.get(rid)
        if t:
            await asyncio.shield(t)

    async def _stream(self, rid: str, proc) -> tuple[str | None, bool]:
        result, is_error = None, False
        async for raw in proc.stdout:
            ev = parse_line(raw.decode("utf-8", "replace"))
            if ev is None:
                continue
            for kind, data in describe(ev):
                run_store.add_event(rid, kind, data)
                if kind == "result":
                    result, is_error = data["text"], data["is_error"]
            await self._emit(rid, "event")
        await proc.wait()
        return result, is_error

    async def _drive(self, rid: str, prompt: str, cwd: str) -> None:
        final = ("failed", None, "run ended unexpectedly")
        try:
            async with self._sem:
                run_store.set_status(rid, "running")
                await self._emit(rid, "running")
                proc = await asyncio.create_subprocess_exec(
                    *self.argv_factory(prompt), cwd=cwd, env=child_env(),
                    stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, limit=16 * 1024 * 1024)
                self._procs[rid] = proc
                try:
                    result, is_error = await asyncio.wait_for(self._stream(rid, proc), self.timeout)
                    err = (await proc.stderr.read()).decode("utf-8", "replace")[-2000:]
                    if proc.returncode == 0 and not is_error:
                        final = ("succeeded", result, None)
                    else:
                        final = ("failed", result, err or result or f"exit {proc.returncode}")
                except asyncio.TimeoutError:
                    final = ("timed_out", None, f"exceeded {self.timeout:.0f}s")
                finally:
                    if proc.returncode is None:
                        proc.kill()
                        await proc.wait()
        except asyncio.CancelledError:
            final = ("cancelled", None, None)
        except BaseException as e:
            final = ("failed", None, f"{type(e).__name__}: {e}")
        finally:
            self._procs.pop(rid, None)
            run_store.set_status(rid, final[0], result=final[1], error=final[2])  # DB first
            await self._emit(rid, final[0])  # then notify
