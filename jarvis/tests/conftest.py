import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["JARVIS_BRAIN_AUTOSTART"] = "0"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("JARVIS_ENV_FILE", str(tmp_path / ".env"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-be-scrubbed")
    monkeypatch.delenv("JARVIS_ALLOWED_ORIGINS", raising=False)
