"""Fish Audio synthesis, one request per sentence chunk. No fallback voice."""
import os

import httpx

URL = "https://api.fish.audio/v1/tts"


class TTSError(RuntimeError):
    pass


async def synthesize(text: str) -> bytes:
    key = os.environ.get("FISH_API_KEY", "").strip()
    if not key:
        raise TTSError("FISH_API_KEY is not set")
    body = {"text": text, "format": "mp3"}
    if os.environ.get("FISH_VOICE_ID"):
        body["reference_id"] = os.environ["FISH_VOICE_ID"]
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(URL, json=body, headers={"Authorization": f"Bearer {key}"})
    if r.status_code != 200:
        raise TTSError(f"Fish Audio returned {r.status_code}")
    return r.content
