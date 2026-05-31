"""
User-highlight persistence — per-lesson append-only log of passages
the user has manually marked as important during study.

Highlights are the **user-authored** counterpart to deterministic
mastery_goals (extracted from canonical lesson recap) and LLM-
extracted key_concepts (model judgment). They sit at the top of
the authority hierarchy for "what matters in this lesson":

  1. User highlights (manual assertion — strongest)
  2. Deterministic mastery_goals (curriculum-authored recap)
  3. LLM-extracted key_concepts (model judgment)

Downstream surfaces treat green-color highlights as **additional
mastery_goals** for Classroom CHECK generation — the user's manual
marking is the answer for lessons that pre-date the canonical
mastery-goals convention.

Storage:
  backend/highlights/<lesson_event_id>.json  — one file per lesson
                                                that has any highlights
  Atomic temp+rename writes via the same pattern as classroom_store /
  notebook_store / gradebook_store. Threading lock guards concurrent
  appends.

A lesson's highlights file may contain highlights created against
EITHER the raw_text (SOT entry) OR a notebook section derived from
that same lesson. Both surfaces point at the same underlying lesson,
so they share a highlight file keyed by lesson_event_id.

Record shape:
  {
    "id":           "uuid",
    "lesson_event_id": str,
    "source_type":  "raw_text" | "notebook_section",
    "source_ref":   {  # extra identity for the surface the highlight was made on
      # raw_text case (just identity fields, raw_text itself is the SOT entry):
      "course": str, "week": str, "lesson": str,
      # notebook_section case (adds notebook navigation):
      "notebook_id": str, "section_index": int,
    },
    "start":        int,       # character offset in source — hint, not authoritative
    "end":          int,
    "text":         str,       # the highlighted text VERBATIM — survives source edits
    "note":         str,       # optional one-line user note, empty string when absent
    "color":        "green" | "yellow" | "blue",
    "created_at":   "ISO-8601 UTC",
  }

Why store text verbatim AND offsets: source content can change (audit
loop re-summarizes a SOT entry, notebook section content stays static
but ordering may shift). The offset is a render hint; the text is the
durable signal. UI uses offset first; if the text at that offset
doesn't match, falls back to text-search to relocate.
"""

import json
import os
import tempfile
import uuid
from datetime import datetime
from threading import Lock
from typing import Dict, List, Optional


_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HIGHLIGHTS_DIR = os.path.join(_BACKEND_DIR, "highlights")

_lock = Lock()

# Permitted color values — locked taxonomy from the H2 design discussion.
# Adding new colors requires a methodology decision (each color has a
# downstream semantic, not just a visual choice). Today:
#   green  → user-asserted mastery goal (downstream: merges into mastery_goals
#            field for Classroom plan generation)
#   yellow → general "this matters" mark (downstream: surfaced in Highlights
#            panel, included in Quiz "highlights mode" when that ships)
#   blue   → "confused / needs review" (downstream: future spaced-repetition
#            surfacing trigger)
ALLOWED_COLORS = frozenset({"green", "yellow", "blue"})

# Permitted source_type values — locked from the design.
ALLOWED_SOURCE_TYPES = frozenset({"raw_text", "notebook_section"})


def _ensure_dir() -> None:
    os.makedirs(HIGHLIGHTS_DIR, exist_ok=True)


def _lesson_path(lesson_event_id: str) -> str:
    if not lesson_event_id or "/" in lesson_event_id or ".." in lesson_event_id:
        raise ValueError(f"Invalid lesson_event_id: {lesson_event_id!r}")
    return os.path.join(HIGHLIGHTS_DIR, f"{lesson_event_id}.json")


def _load(lesson_event_id: str) -> list:
    """
    Load a lesson's highlights file. Returns [] if the file doesn't
    exist or is unreadable. The highlighter is a derived artifact;
    a fresh start is always a safe fallback (the user can re-highlight).
    """
    path = _lesson_path(lesson_event_id)
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        # Tolerate slight schema variations — accept {"highlights": [...]}
        if isinstance(data, dict) and "highlights" in data:
            return data["highlights"] or []
        return []
    except (json.JSONDecodeError, OSError):
        return []


def _atomic_save(lesson_event_id: str, highlights: list) -> None:
    """Atomic temp+rename write. Same pattern as classroom_store."""
    _ensure_dir()
    path = _lesson_path(lesson_event_id)
    fd, tmp = tempfile.mkstemp(prefix=".highlights-", suffix=".tmp", dir=HIGHLIGHTS_DIR)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(highlights, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise


def save_highlight(
    *,
    lesson_event_id: str,
    source_type: str,
    source_ref: dict,
    start: int,
    end: int,
    text: str,
    color: str,
    note: str = "",
) -> dict:
    """
    Persist a new highlight. Returns the saved record (with id + ts
    filled in). Raises ValueError on schema violations — the caller
    (controller) translates to a 4xx response.
    """
    if not lesson_event_id:
        raise ValueError("lesson_event_id is required")
    if source_type not in ALLOWED_SOURCE_TYPES:
        raise ValueError(f"source_type must be one of {ALLOWED_SOURCE_TYPES}")
    if color not in ALLOWED_COLORS:
        raise ValueError(f"color must be one of {ALLOWED_COLORS}")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text must be a non-empty string")
    if not isinstance(source_ref, dict):
        raise ValueError("source_ref must be an object")
    try:
        start = int(start)
        end = int(end)
    except (TypeError, ValueError):
        raise ValueError("start and end must be integers")
    if start < 0 or end <= start:
        raise ValueError(f"invalid offsets: start={start}, end={end}")

    record = {
        "id": str(uuid.uuid4()),
        "lesson_event_id": lesson_event_id,
        "source_type": source_type,
        "source_ref": source_ref,
        "start": start,
        "end": end,
        "text": text,
        "note": (note or "").strip(),
        "color": color,
        "created_at": datetime.utcnow().isoformat(),
    }

    with _lock:
        highlights = _load(lesson_event_id)
        highlights.append(record)
        _atomic_save(lesson_event_id, highlights)
    return record


def list_highlights_for_lesson(lesson_event_id: str) -> List[dict]:
    """Return all highlights for one lesson (across raw_text + notebook surfaces)."""
    if not lesson_event_id:
        return []
    return _load(lesson_event_id)


def list_highlights_for_lesson_by_color(
    lesson_event_id: str,
    color: str,
) -> List[dict]:
    """Filtered convenience — useful for the green→mastery_goals merge."""
    if color not in ALLOWED_COLORS:
        return []
    return [h for h in _load(lesson_event_id) if h.get("color") == color]


def delete_highlight(*, lesson_event_id: str, highlight_id: str) -> bool:
    """
    Remove one highlight by id. Returns True if removed, False if not
    found. The lesson's file stays on disk even when emptied — keeps
    the schema discoverable; cheap to rewrite next time a highlight
    is created.
    """
    if not lesson_event_id or not highlight_id:
        return False
    with _lock:
        highlights = _load(lesson_event_id)
        before = len(highlights)
        kept = [h for h in highlights if h.get("id") != highlight_id]
        if len(kept) == before:
            return False
        _atomic_save(lesson_event_id, kept)
        return True


def delete_all_for_lesson(lesson_event_id: str) -> int:
    """
    Cascade-delete — used when a SOT entry is removed entirely. Returns
    the count of highlights removed. Idempotent; safe to call when the
    lesson has no highlights file.
    """
    if not lesson_event_id:
        return 0
    path = _lesson_path(lesson_event_id)
    if not os.path.exists(path):
        return 0
    with _lock:
        highlights = _load(lesson_event_id)
        count = len(highlights)
        try:
            os.remove(path)
        except OSError:
            return 0
        return count


def list_all_highlights() -> Dict[str, List[dict]]:
    """
    Every highlight across every lesson, grouped by lesson_event_id.
    Used by the (future) dedicated Highlights panel and by debugging.
    Returns {} when no highlights files exist.
    """
    if not os.path.exists(HIGHLIGHTS_DIR):
        return {}
    out: Dict[str, List[dict]] = {}
    for fname in sorted(os.listdir(HIGHLIGHTS_DIR)):
        if not fname.endswith(".json"):
            continue
        lesson_id = fname[:-len(".json")]
        highlights = _load(lesson_id)
        if highlights:
            out[lesson_id] = highlights
    return out
