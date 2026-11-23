"""Pure parsing of `claude -p --output-format stream-json` lines. No I/O."""
import json


def parse_line(line: str) -> dict | None:
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def describe(ev: dict) -> list[tuple[str, dict]]:
    """Turn one raw event into zero or more (kind, data) pairs for the store."""
    t = ev.get("type")
    out: list[tuple[str, dict]] = []
    if t == "system" and ev.get("subtype") == "init":
        out.append(("init", {"model": ev.get("model"), "session_id": ev.get("session_id")}))
    elif t == "assistant":
        for b in (ev.get("message") or {}).get("content") or []:
            if b.get("type") == "text" and b.get("text"):
                out.append(("text", {"text": b["text"]}))
            elif b.get("type") == "tool_use":
                out.append(("tool_use", {"name": b.get("name"), "input": b.get("input")}))
    elif t == "user":
        content = (ev.get("message") or {}).get("content")
        if isinstance(content, list):
            for b in content:
                if b.get("type") == "tool_result":
                    c = b.get("content")
                    if isinstance(c, list):
                        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                    out.append(("tool_result", {"text": str(c)[:4000], "is_error": bool(b.get("is_error"))}))
    elif t == "result":
        out.append(("result", {"text": ev.get("result", ""), "is_error": bool(ev.get("is_error")),
                               "subtype": ev.get("subtype")}))
    return out
