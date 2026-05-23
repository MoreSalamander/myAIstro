"""
Classroom plan + session persistence.

Both kinds of records live as individual JSON files under
backend/classroom/{plans,sessions}/<id>.json. Same atomic-save
discipline as sot_groups.py — write to a temp file, fsync-rename so a
crash mid-write never produces a half-written file.

Schemas are documented in detail in the plan; condensed here:

Plan = {
  plan_id, lesson_event_id, source_lesson, created_at, model,
  estimated_duration_min, beats: [{ beat_id, type, content, ... }, ...]
}

Session = {
  session_id, plan_id, lesson_event_id, started_at, ended_at,
  completed, current_beat, events: [...], summary_stats
}
"""

import json
import os
import tempfile
import uuid
from datetime import datetime
from threading import Lock
from typing import Optional


_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLANS_DIR = os.path.join(_BACKEND_DIR, "classroom", "plans")
SESSIONS_DIR = os.path.join(_BACKEND_DIR, "classroom", "sessions")

_lock = Lock()


def _ensure_dirs() -> None:
    os.makedirs(PLANS_DIR, exist_ok=True)
    os.makedirs(SESSIONS_DIR, exist_ok=True)


def _atomic_save(path: str, data: dict) -> None:
    dirpath = os.path.dirname(path)
    os.makedirs(dirpath, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".classroom-", suffix=".tmp", dir=dirpath)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


def _load_json(path: str) -> Optional[dict]:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


# =========================================================
# PLANS
# =========================================================
def plan_path(plan_id: str) -> str:
    return os.path.join(PLANS_DIR, f"{plan_id}.json")


def new_plan_id() -> str:
    return str(uuid.uuid4())


def save_plan(plan: dict) -> dict:
    _ensure_dirs()
    plan_id = plan.get("plan_id") or new_plan_id()
    plan["plan_id"] = plan_id
    plan.setdefault("created_at", datetime.utcnow().isoformat())
    with _lock:
        _atomic_save(plan_path(plan_id), plan)
    return plan


def load_plan(plan_id: str) -> Optional[dict]:
    return _load_json(plan_path(plan_id))


def list_plans_for_event(event_id: str) -> list:
    """Plans for one SOT entry, newest first."""
    _ensure_dirs()
    out = []
    for fname in os.listdir(PLANS_DIR):
        if not fname.endswith(".json"):
            continue
        plan = _load_json(os.path.join(PLANS_DIR, fname))
        if not plan:
            continue
        if plan.get("lesson_event_id") == event_id:
            out.append(plan)
    out.sort(key=lambda p: p.get("created_at") or "", reverse=True)
    return out


# =========================================================
# SESSIONS
# =========================================================
def session_path(session_id: str) -> str:
    return os.path.join(SESSIONS_DIR, f"{session_id}.json")


def new_session_id() -> str:
    return str(uuid.uuid4())


def start_session(plan: dict) -> dict:
    _ensure_dirs()
    session = {
        "session_id": new_session_id(),
        "plan_id": plan.get("plan_id"),
        "lesson_event_id": plan.get("lesson_event_id"),
        "started_at": datetime.utcnow().isoformat(),
        "ended_at": None,
        "completed": False,
        "current_beat": 0,
        "events": [
            {
                "t": datetime.utcnow().isoformat(),
                "type": "session_started",
            }
        ],
        "summary_stats": {
            "checks_total": 0,
            "checks_passed": 0,
            "avg_check_score": 0.0,
        },
    }
    with _lock:
        _atomic_save(session_path(session["session_id"]), session)
    return session


def load_session(session_id: str) -> Optional[dict]:
    return _load_json(session_path(session_id))


def update_session(session: dict) -> dict:
    """Persist mutations to disk. Caller mutates the dict in-memory first."""
    with _lock:
        _atomic_save(session_path(session["session_id"]), session)
    return session


def append_session_event(session: dict, event: dict) -> dict:
    event = dict(event)
    event.setdefault("t", datetime.utcnow().isoformat())
    session.setdefault("events", []).append(event)
    return update_session(session)


def list_sessions_for_event(event_id: str) -> list:
    """Sessions for one SOT entry, newest started first."""
    _ensure_dirs()
    out = []
    for fname in os.listdir(SESSIONS_DIR):
        if not fname.endswith(".json"):
            continue
        s = _load_json(os.path.join(SESSIONS_DIR, fname))
        if not s:
            continue
        if event_id and s.get("lesson_event_id") != event_id:
            continue
        out.append(s)
    out.sort(key=lambda s: s.get("started_at") or "", reverse=True)
    return out
