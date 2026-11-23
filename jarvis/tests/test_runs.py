import asyncio
import sys
from pathlib import Path

import run_store
from claude_env import child_env
from run_executor import RunExecutor
from stream_parser import describe, parse_line

FAKE = str(Path(__file__).parent / "fake_claude.py")


def argv(prompt):
    return [sys.executable, FAKE, "-p", prompt]


def drive(prompt, **kw):
    seen = []

    async def go():
        async def notify(rid, status):
            seen.append((rid, status, run_store.get_run(rid)["status"]))

        ex = RunExecutor(notify=notify, argv_factory=argv, **kw)
        rid = ex.submit(prompt, str(Path.cwd()))
        await ex.wait(rid)
        return rid

    rid = asyncio.run(go())
    return rid, seen


def test_success_and_key_scrubbed():
    rid, seen = drive("hello")
    r = run_store.get_run(rid)
    assert r["status"] == "succeeded" and r["result"] == "done"
    kinds = [e["kind"] for e in run_store.list_events(rid)]
    assert kinds == ["init", "text", "tool_use", "result"]
    assert "leaked: False" in run_store.list_events(rid)[1]["data"]["text"]


def test_db_written_before_notification():
    rid, seen = drive("hello")
    terminal = [s for s in seen if s[1] == "succeeded"]
    assert terminal and all(s[2] == "succeeded" for s in terminal)


def test_nonzero_exit_fails():
    rid, _ = drive("boom")
    assert run_store.get_run(rid)["status"] == "failed"


def test_timeout():
    rid, _ = drive("hang", timeout=0.5)
    assert run_store.get_run(rid)["status"] == "timed_out"


def test_cancel():
    async def go():
        ex = RunExecutor(argv_factory=argv)
        rid = ex.submit("hang", str(Path.cwd()))
        await asyncio.sleep(0.5)
        assert await ex.cancel(rid)
        return rid

    assert run_store.get_run(asyncio.run(go()))["status"] == "cancelled"


def test_spawn_failure_still_terminal():
    async def go():
        ex = RunExecutor(argv_factory=lambda p: ["/nonexistent/binary"])
        rid = ex.submit("x", str(Path.cwd()))
        await ex.wait(rid)
        return rid

    assert run_store.get_run(asyncio.run(go()))["status"] == "failed"


def test_terminal_status_is_final_and_orphans_failed():
    rid = run_store.create_run("p", "/")
    run_store.set_status(rid, "cancelled")
    run_store.set_status(rid, "succeeded")
    assert run_store.get_run(rid)["status"] == "cancelled"
    q = run_store.create_run("p", "/")
    assert run_store.fail_orphans() == 1 and run_store.get_run(q)["status"] == "failed"


def test_child_env_scrub():
    assert not any(k.startswith("ANTHROPIC_") for k in child_env())


def test_parser():
    assert parse_line("not json") is None and parse_line("") is None
    ev = parse_line('{"type":"user","message":{"content":[{"type":"tool_result","content":[{"text":"hi"}]}]}}')
    assert describe(ev) == [("tool_result", {"text": "hi", "is_error": False})]
