"""JARVIS server: FastAPI, WebSocket voice loop, run API, tool channel."""
import argparse
import asyncio
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

import jarvis_memory
import preflight
import run_store
import tts
from brain import Brain, BrainError
from data_paths import ROOT
from run_executor import RunExecutor
from speech import SpeechScheduler
from web_auth import WebBoundary


def load_env(path: Path | None = None) -> None:
    f = path or Path(os.environ.get("JARVIS_ENV_FILE") or ROOT / ".env")
    if not f.exists():
        return
    for ln in f.read_text().splitlines():
        ln = ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k, v = ln.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))


class RunHub:
    """Fan-out of run notifications. A cache-invalidation hint, never the truth."""

    def __init__(self):
        self.clients: set[WebSocket] = set()

    async def notify(self, run_id: str, status: str) -> None:
        for ws in list(self.clients):
            try:
                await ws.send_json({"type": "run", "run_id": run_id, "status": status})
            except Exception:
                self.clients.discard(ws)


def create_app(brain: Brain | None = None, executor: RunExecutor | None = None) -> FastAPI:
    debug_docs = bool(os.environ.get("JARVIS_DEBUG_DOCS"))
    app = FastAPI(title="JARVIS", docs_url="/docs" if debug_docs else None,
                  redoc_url="/redoc" if debug_docs else None,
                  openapi_url="/openapi.json" if debug_docs else None)
    hub = RunHub()
    executor = executor or RunExecutor(notify=hub.notify)
    brain = brain or Brain()
    app.state.executor, app.state.brain, app.state.hub = executor, brain, hub

    @app.on_event("startup")
    async def _startup():
        run_store.fail_orphans()

    @app.on_event("shutdown")
    async def _shutdown():
        await brain.stop()

    # ---- runs -------------------------------------------------------------
    @app.get("/api/health")
    async def health():
        return {"ok": True}

    @app.get("/api/preflight")
    async def get_preflight():
        return await asyncio.to_thread(preflight.run_all)

    @app.get("/api/runs")
    async def runs(limit: int = 50):
        return run_store.list_runs(min(limit, 200))

    @app.get("/api/runs/{rid}")
    async def run(rid: str):
        r = run_store.get_run(rid)
        if not r:
            raise HTTPException(404)
        return r

    @app.get("/api/runs/{rid}/events")
    async def run_events(rid: str, after: int = 0):
        return run_store.list_events(rid, after)

    @app.post("/api/runs")
    async def start_run(body: dict):
        prompt = str(body.get("prompt", "")).strip()
        if not prompt:
            raise HTTPException(400, "prompt required")
        try:
            return {"id": executor.submit(prompt, body.get("cwd") or str(Path.home()))}
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/runs/{rid}/cancel")
    async def cancel(rid: str):
        return {"cancelled": await executor.cancel(rid)}

    @app.websocket("/ws/runs")
    async def ws_runs(ws: WebSocket):
        await ws.accept()
        hub.clients.add(ws)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            hub.clients.discard(ws)

    # ---- the brain's tool channel ------------------------------------------
    @app.post("/internal/tool")
    async def internal_tool(body: dict):
        name, a = body.get("name"), body.get("arguments") or {}
        if name == "start_run":
            rid = executor.submit(a["prompt"], a.get("cwd") or str(Path.home()))
            return {"text": f"Run {rid} started."}
        if name == "list_runs":
            rs = run_store.list_runs(10)
            return {"text": "\n".join(f"{r['id']} [{r['status']}] {r['prompt'][:60]}" for r in rs) or "No runs."}
        if name == "get_run":
            r = run_store.get_run(a["run_id"])
            return {"text": f"{r['status']}: {r['result'] or r['error'] or ''}"[:1500] if r else "No such run."}
        if name == "cancel_run":
            return {"text": "Cancelled." if await executor.cancel(a["run_id"]) else "Nothing to cancel."}
        if name == "remember":
            jarvis_memory.remember(a["text"])
            return {"text": "Noted."}
        if name == "recall":
            return {"text": "\n".join(jarvis_memory.recall(a["query"])) or "Nothing found."}
        raise HTTPException(404, f"unknown tool {name}")

    # ---- voice --------------------------------------------------------------
    @app.websocket("/ws")
    async def ws_voice(ws: WebSocket):
        await ws.accept()

        async def on_tts_error(e: Exception):
            await ws.send_json({"type": "error", "message": f"voice unavailable: {e}"})

        sched = SpeechScheduler(tts.synthesize, ws.send_bytes, on_tts_error)
        turn: asyncio.Task | None = None

        async def run_turn(text: str):
            await ws.send_json({"type": "state", "state": "thinking"})
            try:
                async for chunk in brain.ask(text):
                    await ws.send_json({"type": "transcript", "role": "jarvis", "text": chunk})
                    sched.say(chunk)
                await sched.drain()
            except BrainError as e:
                await ws.send_json({"type": "error", "message": str(e)})
            finally:
                await ws.send_json({"type": "state", "state": "idle"})

        try:
            while True:
                msg = await ws.receive_json()
                if msg.get("type") == "interrupt" or (turn and not turn.done() and msg.get("type") == "user_text"):
                    sched.interrupt()
                    if turn and not turn.done():
                        turn.cancel()
                if msg.get("type") == "user_text" and str(msg.get("text", "")).strip():
                    await ws.send_json({"type": "transcript", "role": "user", "text": msg["text"]})
                    turn = asyncio.create_task(run_turn(msg["text"]))
        except WebSocketDisconnect:
            pass
        finally:
            sched.interrupt()
            if turn and not turn.done():
                turn.cancel()

    # ---- static (production build) -------------------------------------------
    dist = ROOT / "frontend" / "dist"

    @app.get("/dashboard")
    async def dashboard():
        f = dist / "dashboard.html"
        if not f.exists():
            raise HTTPException(404, "frontend not built: cd frontend && npm run build (or use Vite on :5173)")
        return FileResponse(f)

    return app


def build() -> "WebBoundary":
    return WebBoundary(create_app())


def main() -> None:
    import uvicorn
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("JARVIS_PORT", 8340)))
    a = ap.parse_args()
    os.environ["JARVIS_PORT"] = str(a.port)
    if a.host == "0.0.0.0":
        print("WARNING: listening on all interfaces; set JARVIS_ALLOWED_ORIGINS for the address you use.")
    kw = {}
    if (ROOT / "cert.pem").exists() and (ROOT / "key.pem").exists():
        kw = {"ssl_certfile": str(ROOT / "cert.pem"), "ssl_keyfile": str(ROOT / "key.pem")}
    else:
        print("NOTE: no cert.pem/key.pem - serving plain HTTP; the Vite dev proxy will 500 (see README).")
    for c in preflight.run_all():
        print(("ok   " if c["ok"] else "WARN "), c["name"], "-", c["detail"])
    uvicorn.run(build(), host=a.host, port=a.port, **kw)


if __name__ == "__main__":
    main()
