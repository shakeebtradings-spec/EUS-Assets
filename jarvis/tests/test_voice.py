import asyncio
import sys

import pytest

import jarvis_memory
import jarvis_mcp
from brain import Brain, BrainError
from speech import SpeechScheduler, split_sentences


def test_split_sentences():
    assert split_sentences("Very good, sir. Shall I proceed? Yes.") == ["Very good, sir.", "Shall I proceed?", "Yes."]
    assert split_sentences("Ask Dr. Smith. Done.") == ["Ask Dr. Smith.", "Done."]


def test_scheduler_in_order_and_error_stops_reply():
    sent, errs = [], []

    async def go(fail_on=None):
        async def synth(t):
            if t == fail_on:
                raise RuntimeError("tts down")
            return t.encode()

        async def send(b):
            sent.append(b)

        async def on_err(e):
            errs.append(str(e))

        s = SpeechScheduler(synth, send, on_err)
        s.say("One. Two. Three.")
        await s.drain()

    asyncio.run(go())
    assert sent == [b"One.", b"Two.", b"Three."]
    sent.clear()
    asyncio.run(go(fail_on="Two."))
    assert sent == [b"One."] and errs == ["tts down"]


def test_brain_disabled():
    async def go():
        async for _ in Brain().ask("hi"):
            pass

    with pytest.raises(BrainError):
        asyncio.run(go())


def test_brain_streams_with_fake_process(tmp_path):
    fake = tmp_path / "b.py"
    fake.write_text(
        "import sys,json\n"
        "for line in sys.stdin:\n"
        "    t=json.loads(line)['message']['content']\n"
        "    print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'Heard: '+t}]}}),flush=True)\n"
        "    print(json.dumps({'type':'result','is_error':False,'result':''}),flush=True)\n")

    async def go():
        b = Brain(argv=[sys.executable, str(fake)])
        out = []
        for q in ("one", "two"):  # same process serves both turns
            out += [c async for c in b.ask(q)]
        await b.stop()
        return out

    assert asyncio.run(go()) == ["Heard: one", "Heard: two"]


def test_memory_roundtrip():
    jarvis_memory.remember("Tea at four")
    assert jarvis_memory.recall("tea") and "Tea at four" in jarvis_memory.read_all()


def test_mcp_protocol():
    init = jarvis_mcp.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert init["result"]["serverInfo"]["name"] == "jarvis"
    names = {t["name"] for t in jarvis_mcp.handle({"id": 2, "method": "tools/list"})["result"]["tools"]}
    assert {"start_run", "remember"} <= names
    assert jarvis_mcp.handle({"method": "notifications/initialized"}) is None


def test_brain_argv_tools_and_connectors(monkeypatch):
    monkeypatch.delenv("JARVIS_USE_CONNECTORS", raising=False)
    monkeypatch.delenv("JARVIS_EXTRA_TOOLS", raising=False)
    a = Brain().build_argv()
    tools = a[a.index("--allowedTools") + 1].split(",")
    assert {"WebSearch", "WebFetch", "Read", "mcp__jarvis"} <= set(tools)
    assert "Bash" not in tools and "Write" not in tools and "--strict-mcp-config" in a
    monkeypatch.setenv("JARVIS_USE_CONNECTORS", "1")
    monkeypatch.setenv("JARVIS_EXTRA_TOOLS", "mcp__x__read, mcp__y")
    a = Brain().build_argv()
    assert "--strict-mcp-config" not in a
    assert {"mcp__x__read", "mcp__y"} <= set(a[a.index("--allowedTools") + 1].split(","))


def test_server_serves_built_ui(tmp_path, monkeypatch):
    import server
    from starlette.testclient import TestClient
    (server.ROOT / "frontend" / "dist").mkdir(parents=True, exist_ok=True)
    made = not (server.ROOT / "frontend" / "dist" / "index.html").exists()
    if made:
        (server.ROOT / "frontend" / "dist" / "index.html").write_text("<title>JARVIS</title>")
    try:
        c = TestClient(server.build(), base_url="http://localhost:8340")
        assert "JARVIS" in c.get("/").text and c.get("/api/health").json() == {"ok": True}
    finally:
        if made:
            (server.ROOT / "frontend" / "dist" / "index.html").unlink()
