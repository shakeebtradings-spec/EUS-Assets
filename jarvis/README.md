# JARVIS — voice AI assistant

Voice-first assistant whose brain is a long-lived Claude Code process on your
Claude subscription (no API key). Every Claude Code execution is a recorded
**run**, watchable at `/dashboard`. Read `skills/jarvis-setup/SKILL.md` for the
gotchas learned the hard way.

## Setup
```bash
cd jarvis
cp .env.example .env            # add FISH_API_KEY (fish.audio); required
npm install -g @anthropic-ai/claude-code && claude    # log in once
pip install -r requirements.txt
python -m playwright install chromium
(cd frontend && npm install)
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj '/CN=localhost'
python server.py --host 127.0.0.1
```
In a second terminal: `cd frontend && npm run dev`, then open **Chrome** at
http://localhost:5173, click to enable audio, and speak (or type).

Tests: `pytest` (no flags).

## Layout
| File | Role |
|---|---|
| `server.py` | FastAPI app: `/ws` voice loop, `/ws/runs`, `/api/runs`, `/internal/tool` |
| `web_auth.py` | ASGI gate: Host on every request; Origin or tool token on WS + writes; no CORS |
| `brain.py` | one long-lived `claude -p` fed stream-json over stdin |
| `jarvis_mcp.py` | stdio MCP server giving the brain tools; forwards to `/internal/tool` |
| `run_executor.py`, `run_store.py`, `stream_parser.py` | the run pipeline (SQLite) |
| `tts.py`, `speech.py` | Fish Audio per sentence; scheduler owning every utterance |
| `jarvis_memory.py` | memory as plain Markdown in `data/memory/` |
| `claude_env.py` | scrubs `ANTHROPIC_*` from every child |
| `preflight.py` | first-run checks (`python preflight.py`) |
| `frontend/` | Vite + TS + Three.js orb, Web Speech input, `/dashboard` (no `innerHTML`) |

Run pipeline invariants: a run always reaches a terminal state; every state
change is a DB write **before** it is a notification.

## Not built (yet)
`builds.py`/`specs.py` (phased builds), `projects_view.py`, `session_watch.py`/`session_steer.py`,
`dialog.py`, `notifier.py`, `usage_store.py`, `screen.py`, `browser.py`/`repo_read.py`,
`project_maker.py`, weather, and the settings endpoints. The core voice loop,
run pipeline, tool channel, memory and dashboard are in place.
