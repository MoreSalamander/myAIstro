"""
Notebook store — persistence for user-saved advisor outputs.

Each saved note is a snapshot of one complete advisor-pipeline run:
the user's original query, the assembled markdown response, the
structured per-piece breakdown (arc + sections + recap), and references
to the source SOT entries the advisor used.

Notes are user-curated DERIVED artifacts. Explicitly NOT part of the
SOT itself. The SOT is "what I learned"; the Notebook is "what I asked
the advisor to assemble from what I learned." Different concept, lives
in a different store, edited / deleted independently of the SOT.

Snapshot semantics: once saved, a note never changes. Even if the
underlying SOT entries later get displaced by the audit cycle, the
saved note still renders the exact text and code samples that were
generated at save time. That's the point — these are reference
artifacts, not live views.

Storage shape: one JSON file per note under `backend/notebook/`,
matching the pattern `classroom_store.py` uses for plans + sessions.
Atomic temp-file-and-rename writes so a crash mid-write can't corrupt
a saved note.
"""

import json
import os
import tempfile
import uuid
from datetime import datetime
from threading import Lock
from typing import Optional


_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTEBOOK_DIR = os.path.join(_BACKEND_DIR, "notebook")

_lock = Lock()


# =========================================================
# PUBLIC API
# =========================================================
def save_note(note: dict) -> dict:
    """
    Persist a notebook entry to disk. Auto-fills `notebook_id` (UUID)
    and `created_at` (UTC ISO-8601) if the caller didn't supply them.
    Returns the saved note dict with those fields populated.
    """
    _ensure_dir()
    if not note.get("notebook_id"):
        note["notebook_id"] = str(uuid.uuid4())
    if not note.get("created_at"):
        note["created_at"] = datetime.utcnow().isoformat()
    with _lock:
        _atomic_save(_path_for(note["notebook_id"]), note)
    return note


def list_notes() -> list:
    """
    Return a list of note SUMMARIES (no piece content) sorted
    newest-first. The summary shape is what the Notebook panel's left
    pane consumes — small payload, fast to load even when the notebook
    has many entries.
    """
    _ensure_dir()
    summaries = []
    for fn in os.listdir(NOTEBOOK_DIR):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(NOTEBOOK_DIR, fn)
        try:
            with open(path) as f:
                note = json.load(f)
        except (json.JSONDecodeError, OSError):
            # Corrupt or unreadable file — skip rather than fail the
            # whole list. Same fail-open behavior as the SOT loader.
            continue
        pieces = note.get("pieces") or []
        section_courses = sorted({
            (p.get("course") or "")
            for p in pieces
            if p.get("kind") == "section" and p.get("course")
        })
        summaries.append({
            "notebook_id": note.get("notebook_id"),
            "title": note.get("title"),
            "query": note.get("query"),
            "created_at": note.get("created_at"),
            "model": note.get("model"),
            "source_courses": list(section_courses),
            "section_count": sum(1 for p in pieces if p.get("kind") == "section"),
        })
    summaries.sort(key=lambda n: n.get("created_at") or "", reverse=True)
    return summaries


def get_note(note_id: str) -> Optional[dict]:
    """Return the full saved note dict, or None if no such file."""
    path = _path_for(note_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def delete_note(note_id: str) -> bool:
    """Remove a saved note. Returns True iff the note existed."""
    path = _path_for(note_id)
    if not os.path.exists(path):
        return False
    with _lock:
        os.remove(path)
    return True


# =========================================================
# INTERNAL
# =========================================================
def _ensure_dir() -> None:
    """Create the notebook directory if it doesn't exist yet."""
    os.makedirs(NOTEBOOK_DIR, exist_ok=True)


def _path_for(note_id: str) -> str:
    """Build the on-disk path for a note id."""
    return os.path.join(NOTEBOOK_DIR, f"{note_id}.json")


def _atomic_save(path: str, data) -> None:
    """
    Same atomic-write pattern as `core/sot_groups.py::_atomic_save` —
    temp file in the same directory, then `os.replace` to swap into
    place. POSIX rename(2) is atomic on the same filesystem, so a
    crash mid-write leaves the old file intact rather than producing
    a half-written JSON blob.
    """
    _ensure_dir()
    dirpath = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".notebook-", suffix=".tmp", dir=dirpath)
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
