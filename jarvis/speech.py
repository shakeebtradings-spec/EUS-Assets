"""Sentence splitting + the scheduler that owns every utterance JARVIS speaks."""
import asyncio
import re
from typing import Awaitable, Callable

_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'(])")
_ABBREV = ("mr.", "mrs.", "ms.", "dr.", "e.g.", "i.e.", "vs.")


def split_sentences(text: str) -> list[str]:
    out: list[str] = []
    for piece in _SPLIT.split(text.strip()):
        piece = piece.strip()
        if not piece:
            continue
        if out and out[-1].lower().endswith(_ABBREV):
            out[-1] += " " + piece
        else:
            out.append(piece)
    return out


class SpeechScheduler:
    """FIFO of sentences; each is synthesized then sent. interrupt() drops the rest."""

    def __init__(self, synth: Callable[[str], Awaitable[bytes]],
                 send: Callable[[bytes], Awaitable[None]],
                 on_error: Callable[[Exception], Awaitable[None]] | None = None):
        self.synth, self.send, self.on_error = synth, send, on_error
        self._q: asyncio.Queue[str] = asyncio.Queue()
        self._worker: asyncio.Task | None = None

    def say(self, text: str) -> None:
        for s in split_sentences(text):
            self._q.put_nowait(s)
        if self._worker is None or self._worker.done():
            self._worker = asyncio.get_running_loop().create_task(self._run())

    async def _run(self) -> None:
        while not self._q.empty():
            s = self._q.get_nowait()
            try:
                await self.send(await self.synth(s))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                while not self._q.empty():  # one failure silences the rest of this reply
                    self._q.get_nowait()
                if self.on_error:
                    await self.on_error(e)
                return

    async def drain(self) -> None:
        if self._worker:
            await asyncio.shield(self._worker)

    def interrupt(self) -> None:
        while not self._q.empty():
            self._q.get_nowait()
        if self._worker and not self._worker.done():
            self._worker.cancel()
