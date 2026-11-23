"""Stand-in for `claude -p`: behaviour chosen by the prompt text."""
import json
import os
import sys
import time

p = sys.argv[sys.argv.index("-p") + 1]
if p == "hang":
    time.sleep(60)
print(json.dumps({"type": "system", "subtype": "init", "model": "fake"}), flush=True)
print(json.dumps({"type": "assistant", "message": {"content": [
    {"type": "text", "text": "key leaked: " + str(bool(os.environ.get("ANTHROPIC_API_KEY")))},
    {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]}}), flush=True)
if p == "boom":
    sys.exit(3)
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "done"}), flush=True)
