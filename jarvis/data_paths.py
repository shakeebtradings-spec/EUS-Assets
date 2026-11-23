"""Single source of truth for where JARVIS writes anything."""
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def data_dir() -> Path:
    p = Path(os.environ.get("JARVIS_DATA_DIR") or ROOT / "data")
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> Path:
    return data_dir() / "jarvis.db"


def memory_dir() -> Path:
    p = data_dir() / "memory"
    p.mkdir(parents=True, exist_ok=True)
    return p


def ensure_tool_token() -> str:
    """Token the MCP child (and tests) use to pass the web boundary."""
    f = data_dir() / "tool_token"
    if not f.exists():
        fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(secrets.token_urlsafe(32))
    return f.read_text().strip()
