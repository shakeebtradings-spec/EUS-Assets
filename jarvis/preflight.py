"""First-run environment checks. Each returns {name, ok, detail}."""
import os
import shutil
import subprocess
import sys
from pathlib import Path

from data_paths import ROOT, load_env


def _check(name: str, ok: bool, detail: str) -> dict:
    return {"name": name, "ok": ok, "detail": detail}


def claude_cli() -> dict:
    exe = shutil.which("claude")
    if not exe:
        return _check("claude_cli", False, "not found: npm install -g @anthropic-ai/claude-code")
    try:
        v = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=15).stdout.strip()
    except Exception as e:
        return _check("claude_cli", False, str(e))
    return _check("claude_cli", True, v)


def fish_key() -> dict:
    ok = bool(os.environ.get("FISH_API_KEY", "").strip())
    return _check("fish_key", ok, "set" if ok else "FISH_API_KEY missing - there is no fallback voice")


def anthropic_key_leftover(env_file: Path | None = None) -> dict:
    f = env_file or ROOT / ".env"
    bad = f.exists() and any(ln.strip().startswith("ANTHROPIC_API_KEY") and "=" in ln and ln.split("=", 1)[1].strip()
                             for ln in f.read_text().splitlines())
    return _check("anthropic_key_leftover", not bad,
                  "ANTHROPIC_API_KEY in .env is ignored; remove it" if bad else "clean")


def certs() -> dict:
    ok = (ROOT / "cert.pem").exists() and (ROOT / "key.pem").exists()
    return _check("certs", ok, "present" if ok else "missing: the Vite proxy needs an HTTPS backend (see README)")


def accessibility() -> dict:
    if sys.platform != "darwin":
        return _check("accessibility", False, "macOS only (permission prompts/Terminal control unavailable)")
    try:
        r = subprocess.run(["osascript", "-e", 'tell application "System Events" to get name of first process'],
                           capture_output=True, timeout=10)
        return _check("accessibility", r.returncode == 0, "granted" if r.returncode == 0 else "grant Accessibility to your terminal")
    except Exception as e:
        return _check("accessibility", False, str(e))


def run_all() -> list[dict]:
    return [claude_cli(), fish_key(), anthropic_key_leftover(), certs(), accessibility()]


if __name__ == "__main__":
    load_env()
    for c in run_all():
        print(("OK  " if c["ok"] else "FAIL"), c["name"], "-", c["detail"])
