"""
Notebook endpoints — save / list / fetch / delete advisor outputs.

Routes:
  POST   /api/notebook/save       body: SaveNoteRequest      (write-gated)
  GET    /api/notebook/list       summary list of all notes  (read-open)
  GET    /api/notebook/{id}       full note content          (read-open)
  DELETE /api/notebook/{id}                                  (write-gated)

The Notebook is the user's persistent library of saved advisor
outputs — see `core/notebook_store.py` for the full architectural
framing. This controller is intentionally thin: validation +
persistence delegation. No business logic lives here.
"""

import traceback
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.auth import require_write_password
from core.grounding_check import combined_report
from core.notebook_store import (
    delete_note,
    get_note,
    list_notes,
    save_note,
)
from core.sot_groups import load_sot


router = APIRouter()


def _attach_grounding_reports(pieces: List[dict]) -> List[dict]:
    """
    Annotate each section piece with a `grounding_report` derived from
    the source SOT entry's raw_text. Arc and recap pieces are skipped
    — they're framing prose, not derived from a specific lesson, so
    grounding doesn't apply the same way (they're verified by the
    advisor's prompt-level constraint that they only see the lesson
    list, not invent material).

    This is the Python-verification fence at the
    advisor-section → Notebook boundary. The saved snapshot carries
    its own grounding evidence so downstream consumers (the Teacher
    Aide flow, future graph views, the UI itself) can surface or act
    on grounding quality without re-running the check.

    Soft validation: ratios are attached but the note ALWAYS saves.
    The user explicitly clicked save; we don't reject their work.
    The UI can render warning chips for low-grounding pieces.
    """
    sot = load_sot()
    by_event_id = {e.get("event_id"): e for e in sot}
    for p in pieces:
        if p.get("kind") != "section":
            continue
        evt_id = p.get("event_id")
        source = by_event_id.get(evt_id) if evt_id else None
        source_text = (source or {}).get("raw_text") or ""
        p["grounding_report"] = combined_report(p.get("content", ""), source_text)
    return pieces


# =========================================================
# REQUEST SCHEMAS
# =========================================================
class NotebookPiece(BaseModel):
    """
    One structural unit of a saved advisor response. Mirrors the
    pipeline's stage vocabulary — see `core/advisor_pipeline.py`.

    Fields by `kind`:
      "arc"     : content   (opening framing paragraph)
      "section" : content + event_id + lesson + course + week
                  (one per retrieved SOT entry; event_id refs the
                  underlying canonical so the Notebook panel can
                  open the source LessonDrawer on click)
      "recap"   : content   (closing framing paragraph)

    grounding_report is attached server-side at save time (see
    notebook_controller._attach_grounding_reports). Accepting it
    on input lets the schema round-trip clean — a future re-save
    of a previously saved note doesn't get rejected.
    """
    kind: str
    content: str
    event_id: Optional[str] = None
    lesson: Optional[str] = None
    course: Optional[str] = None
    week: Optional[str] = None
    grounding_report: Optional[dict] = None


class SaveNoteRequest(BaseModel):
    """
    Payload for /api/notebook/save. Title is user-editable (defaulted
    on the client to a derived version of the query). source_event_ids
    is the flat list of SOT event_ids the advisor's retrieval picked —
    duplicates fine to permit pieces[] reconstruction without
    re-deriving.
    """
    title: str
    query: str
    body_markdown: str
    pieces: List[NotebookPiece]
    source_event_ids: List[str]
    model: Optional[str] = None


# =========================================================
# ENDPOINTS
# =========================================================
@router.post("/notebook/save", dependencies=[Depends(require_write_password)])
def save_endpoint(req: SaveNoteRequest) -> dict:
    """
    Save a new note. Returns the persisted note with auto-filled id /
    timestamp / per-section grounding reports.

    The Python verification fence at this boundary: every section
    piece gets a `grounding_report` derived from substring + token
    matching of its content against the source SOT entry's raw_text.
    Reports are SOFT (always saves); the UI uses them to surface
    grounding quality, and downstream consumers (Teacher Aide) can
    refuse low-grounding sections.
    """
    try:
        payload = req.model_dump()
        payload["pieces"] = _attach_grounding_reports(payload.get("pieces") or [])
        return save_note(payload)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/notebook/list")
def list_endpoint() -> list:
    """All saved notes' summary metadata (no body content), newest-first."""
    return list_notes()


@router.get("/notebook/{note_id}")
def get_endpoint(note_id: str) -> dict:
    """The full content of one saved note, or 404 if no such note."""
    note = get_note(note_id)
    if note is None:
        raise HTTPException(status_code=404, detail="Notebook entry not found")
    return note


@router.delete("/notebook/{note_id}", dependencies=[Depends(require_write_password)])
def delete_endpoint(note_id: str) -> dict:
    """Remove a saved note. 404 if it didn't exist."""
    if not delete_note(note_id):
        raise HTTPException(status_code=404, detail="Notebook entry not found")
    return {"status": "deleted", "notebook_id": note_id}
