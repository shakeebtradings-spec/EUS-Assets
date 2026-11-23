"""Long-term memory: plain Markdown files the user can read and edit directly."""
import time

from data_paths import memory_dir


def remember(text: str) -> str:
    f = memory_dir() / "notes.md"
    with f.open("a", encoding="utf-8") as fh:
        fh.write(f"- {time.strftime('%Y-%m-%d')}: {text.strip()}\n")
    return str(f)


def read_all(max_chars: int = 8000) -> str:
    parts = [p.read_text(encoding="utf-8") for p in sorted(memory_dir().glob("*.md"))]
    return "\n".join(parts)[-max_chars:]


def recall(query: str) -> list[str]:
    q = query.lower()
    return [ln for ln in read_all(10**6).splitlines() if q in ln.lower()]
