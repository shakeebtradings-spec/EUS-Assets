"""SQLite store for runs and their events. Six statuses, four terminal."""
import json
import sqlite3
import time
import uuid
from contextlib import closing

from data_paths import db_path

STATUSES = ("queued", "running", "succeeded", "failed", "timed_out", "cancelled")
TERMINAL = ("succeeded", "failed", "timed_out", "cancelled")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','timed_out','cancelled')),
  created_at REAL NOT NULL, started_at REAL, finished_at REAL, result TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
  ts REAL NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, id);
"""


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(db_path(), timeout=10)
    c.row_factory = sqlite3.Row
    c.executescript(_SCHEMA)
    return c


def create_run(prompt: str, cwd: str) -> str:
    rid = uuid.uuid4().hex[:12]
    with closing(_conn()) as c, c:
        c.execute("INSERT INTO runs (id,prompt,cwd,status,created_at) VALUES (?,?,?,?,?)",
                  (rid, prompt, cwd, "queued", time.time()))
    return rid


def set_status(rid: str, status: str, result: str | None = None, error: str | None = None) -> None:
    assert status in STATUSES, status
    now = time.time()
    with closing(_conn()) as c, c:
        row = c.execute("SELECT status FROM runs WHERE id=?", (rid,)).fetchone()
        if row is None or row["status"] in TERMINAL:
            return  # a terminal status is final
        if status == "running":
            c.execute("UPDATE runs SET status=?, started_at=? WHERE id=?", (status, now, rid))
        elif status in TERMINAL:
            c.execute("UPDATE runs SET status=?, finished_at=?, result=COALESCE(?,result), error=? WHERE id=?",
                      (status, now, result, error, rid))
        else:
            c.execute("UPDATE runs SET status=? WHERE id=?", (status, rid))


def add_event(rid: str, kind: str, data: dict) -> int:
    with closing(_conn()) as c, c:
        cur = c.execute("INSERT INTO run_events (run_id,ts,kind,data) VALUES (?,?,?,?)",
                        (rid, time.time(), kind, json.dumps(data)))
        return cur.lastrowid


def get_run(rid: str) -> dict | None:
    with closing(_conn()) as c:
        row = c.execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone()
        return dict(row) if row else None


def list_runs(limit: int = 50) -> list[dict]:
    with closing(_conn()) as c:
        return [dict(r) for r in c.execute("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?", (limit,))]


def list_events(rid: str, after_id: int = 0) -> list[dict]:
    with closing(_conn()) as c:
        rows = c.execute("SELECT * FROM run_events WHERE run_id=? AND id>? ORDER BY id", (rid, after_id))
        return [{**dict(r), "data": json.loads(r["data"])} for r in rows]


def fail_orphans() -> int:
    """At startup nothing can still be running: close out anything left over."""
    with closing(_conn()) as c, c:
        cur = c.execute("UPDATE runs SET status='failed', finished_at=?, error='server restarted' "
                        "WHERE status IN ('queued','running')", (time.time(),))
        return cur.rowcount
