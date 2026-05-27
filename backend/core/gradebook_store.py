"""
Gradebook store — append-only log of per-CHECK results from Classroom
sessions, plus eventually Quiz attempts in Phase 3.

Phase 2 of the gradebook arc. This module is the data layer only — no
aggregation, no API endpoints, no UI. Its single job is to start the
data clock so that when the gradebook UI ships (Phase 4), there's
real history to display.

Storage:
  backend/gradebook.json — one file, `{version, records: [...]}` shape.
  Atomic temp+rename writes via the same pattern as classroom_store.
  Threading lock against concurrent writes. Single-file is fine at
  personal-tool scale (a year of heavy daily use is on the order of
  thousands of records — small enough to rewrite on every append).

Record shapes (two types, sharing the same log file):

  type=classroom_check   (every MC answer in a Classroom session)
  {
    "type":             "classroom_check",
    "ts":               "2026-05-27T...",    # ISO-8601 UTC
    "session_id":       str,
    "plan_id":          str,
    "lesson_event_id":  str | None,          # may be None on
                                             # notebook-derived plans
                                             # without an event_id on
                                             # the section
    "course":           str,
    "week":             str,
    "lesson":           str,
    "beat_id":          str,
    "selected_index":   int,                 # canonical (against plan
                                             # order, not display order)
    "correct_index":    int,
    "passed":           bool,
    "score":            0 | 100,             # deterministic MC grade
    "first_try":        bool,                # mastery signal
  }

  type=quiz_attempt      (one graded Quiz question)
  {
    "type":             "quiz_attempt",
    "ts":               "2026-05-27T...",
    "lesson_event_id":  str,
    "course":           str,
    "week":             str,
    "lesson":           str,
    "question":         str,                 # the question mistral
                                             # was asked to grade
    "score":            int,                 # 0-100 from mistral
    "model":            str,                 # e.g. "mistral"
  }

Design notes:
  - Records are written immediately after the session event is
    persisted, so a write here always corresponds to a real session
    event on disk. If the controller crashes between update_session
    and record_check, the session has the event but the gradebook
    doesn't — that drift is fine (the gradebook UI can rebuild from
    session events if we ever need to), but the inverse never happens.
  - Guest path is NOT hooked. Visitor activity is ephemeral by design
    — they never get a session record either, and gradebook entries
    are personal-vault data.
  - Per-CHECK retries DO land here, marked with first_try=False. The
    aggregation rules (mastery = all CHECKs first-try, lesson grade =
    first-try-correct / total CHECKs, etc.) live in Phase 4's grading
    module, not here. This module just collects.
"""

import json
import os
import tempfile
from datetime import datetime
from threading import Lock
from typing import Callable, List, Optional


_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRADEBOOK_PATH = os.path.join(_BACKEND_DIR, "gradebook.json")

_SCHEMA_VERSION = 1

_lock = Lock()


def _atomic_save(data: dict) -> None:
    dirpath = os.path.dirname(GRADEBOOK_PATH)
    os.makedirs(dirpath, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".gradebook-", suffix=".tmp", dir=dirpath)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, GRADEBOOK_PATH)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


def _load() -> dict:
    """
    Read the gradebook file, returning the empty-init shape if it
    doesn't exist or is unreadable. Never raises on missing/corrupt —
    the gradebook is a derived artifact; a fresh empty start is
    always a safe fallback.
    """
    if not os.path.exists(GRADEBOOK_PATH):
        return {"version": _SCHEMA_VERSION, "records": []}
    try:
        with open(GRADEBOOK_PATH, "r") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return {"version": _SCHEMA_VERSION, "records": []}
    if not isinstance(data, dict) or "records" not in data:
        return {"version": _SCHEMA_VERSION, "records": []}
    return data


def record_check(
    *,
    session_id: str,
    plan_id: str,
    lesson_event_id: Optional[str],
    course: str,
    week: str,
    lesson: str,
    beat_id: str,
    selected_index: int,
    correct_index: int,
    passed: bool,
    score: int,
    first_try: bool,
) -> dict:
    """
    Append a classroom_check record. Returns the persisted record
    (with `ts` filled in). Caller is responsible for passing through
    the lesson identity fields — typically from the loaded plan's
    `source_lesson` dict.

    No-op-safe: if the write fails for any reason, the exception
    propagates. The classroom controller treats gradebook writes as
    non-fatal — losing one record is acceptable; failing the user's
    CHECK submit because the gradebook is unwritable is not.
    """
    record = {
        "type": "classroom_check",
        "ts": datetime.utcnow().isoformat(),
        "session_id": session_id,
        "plan_id": plan_id,
        "lesson_event_id": lesson_event_id,
        "course": course,
        "week": week,
        "lesson": lesson,
        "beat_id": beat_id,
        "selected_index": int(selected_index),
        "correct_index": int(correct_index),
        "passed": bool(passed),
        "score": int(score),
        "first_try": bool(first_try),
    }
    with _lock:
        data = _load()
        data.setdefault("records", []).append(record)
        data["version"] = _SCHEMA_VERSION
        _atomic_save(data)
    return record


def record_quiz_attempt(
    *,
    lesson_event_id: str,
    course: str,
    week: str,
    lesson: str,
    question: str,
    score: int,
    model: str,
) -> dict:
    """
    Append a quiz_attempt record. One graded Quiz question = one attempt.
    Best-attempt-wins aggregation happens in core.grading at read time,
    not here — this module just collects.

    Same non-fatal contract as record_check: the caller (quiz_controller)
    wraps in try/except so a gradebook write failure can never break
    the student's quiz-grade response.
    """
    record = {
        "type": "quiz_attempt",
        "ts": datetime.utcnow().isoformat(),
        "lesson_event_id": lesson_event_id,
        "course": course,
        "week": week,
        "lesson": lesson,
        "question": question,
        "score": int(score),
        "model": model,
    }
    with _lock:
        data = _load()
        data.setdefault("records", []).append(record)
        data["version"] = _SCHEMA_VERSION
        _atomic_save(data)
    return record


def list_records(filter_fn: Optional[Callable[[dict], bool]] = None) -> List[dict]:
    """All records, optionally filtered. Newest-last (insertion order)."""
    data = _load()
    records = data.get("records") or []
    if filter_fn is None:
        return list(records)
    return [r for r in records if filter_fn(r)]


def records_for_lesson(lesson_event_id: str) -> List[dict]:
    """Every check + future quiz attempt against one SOT lesson."""
    if not lesson_event_id:
        return []
    return list_records(lambda r: r.get("lesson_event_id") == lesson_event_id)


def records_for_session(session_id: str) -> List[dict]:
    """Every check answered within one classroom session."""
    if not session_id:
        return []
    return list_records(lambda r: r.get("session_id") == session_id)
