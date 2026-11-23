---
name: jarvis-setup
description: Set up and debug JARVIS (voice assistant driving Claude Code). Use when installing, or when the orb loads but nothing works.
---

# JARVIS setup facts

- **Mic works in Chrome only** (Web Speech API). Safari/Firefox will show the orb but never hear you. Use the text box as a fallback.
- **Mic permission is per origin/port.** Allowing the mic at `localhost:5173` does not cover `localhost:8340`. Open the Vite URL (5173) and grant it there.
- **Certs are not optional for the dev workflow.** `vite.config.ts` proxies to `https://localhost:8340`. Plain-HTTP backend => page loads, every `/api` call returns 500. Generate: `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj '/CN=localhost'`.
- **Subscription, not API key.** The brain is `claude -p` on your Claude login. `ANTHROPIC_*` vars are scrubbed from every child. An expired login makes the brain exit immediately: the UI shows "brain exited - is `claude` logged in?". Fix: run `claude` once in a terminal and log in.
- **Fish Audio key is required** (`FISH_API_KEY`). No key => replies appear as text, with a "voice unavailable" error and no sound.
- **Accessibility (macOS)**: needed only for answering permission prompts in Terminal windows. Grant it to your terminal app in System Settings > Privacy & Security.
- **403 on everything** usually means the page is opened at an address JARVIS doesn't serve from (LAN IP, tunnel). Add it to `JARVIS_ALLOWED_ORIGINS` (its host name is then accepted by the Host check too).
- `python preflight.py` prints every check.
