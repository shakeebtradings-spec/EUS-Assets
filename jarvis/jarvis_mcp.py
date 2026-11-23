"""Stdio MCP server exposing JARVIS's tools to the brain.

Speaks just enough JSON-RPC for tools/list and tools/call, and forwards every
call to POST /internal/tool on loopback, bearing the tool token.
"""
import json
import os
import ssl
import sys
import urllib.request

from data_paths import ensure_tool_token

TOOLS = [
    {"name": "start_run", "description": "Start a Claude Code run for a coding task. Returns a run id.",
     "inputSchema": {"type": "object", "properties": {"prompt": {"type": "string"},
                     "cwd": {"type": "string", "description": "Project directory (default: home)"}},
                     "required": ["prompt"]}},
    {"name": "list_runs", "description": "List recent runs with their status.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_run", "description": "Status and result of one run.",
     "inputSchema": {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"]}},
    {"name": "cancel_run", "description": "Cancel a running run.",
     "inputSchema": {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"]}},
    {"name": "remember", "description": "Save a fact to long-term memory.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "recall", "description": "Search long-term memory.",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
]


def forward(name: str, arguments: dict) -> str:
    url = os.environ.get("JARVIS_URL", "https://localhost:8340").rstrip("/") + "/internal/tool"
    req = urllib.request.Request(url, data=json.dumps({"name": name, "arguments": arguments}).encode(),
                                 headers={"content-type": "application/json",
                                          "x-jarvis-token": ensure_tool_token()})
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE  # loopback, self-signed
    with urllib.request.urlopen(req, timeout=60, context=ctx) as r:
        return json.loads(r.read())["text"]


def handle(msg: dict) -> dict | None:
    mid, method = msg.get("id"), msg.get("method")
    if mid is None:
        return None  # notification
    if method == "initialize":
        res = {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2024-11-05"),
               "capabilities": {"tools": {}}, "serverInfo": {"name": "jarvis", "version": "1"}}
    elif method == "tools/list":
        res = {"tools": TOOLS}
    elif method == "tools/call":
        p = msg.get("params", {})
        try:
            res = {"content": [{"type": "text", "text": forward(p["name"], p.get("arguments") or {})}]}
        except Exception as e:
            res = {"content": [{"type": "text", "text": f"tool failed: {e}"}], "isError": True}
    elif method == "ping":
        res = {}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"unknown method {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": res}


def main() -> None:
    for line in sys.stdin:
        try:
            out = handle(json.loads(line))
        except json.JSONDecodeError:
            continue
        if out is not None:
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
