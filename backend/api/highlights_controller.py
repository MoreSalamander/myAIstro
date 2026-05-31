"""
Highlights endpoints — user-authored "this matters" markers on
lesson source material (raw_text or notebook sections).

Public reads:
  GET  /api/highlights                          — every highlight, grouped by lesson
  GET  /api/highlights/{lesson_event_id}        — highlights for one lesson

Write-protected (X-Write-Password header):
  POST   /api/highlights                        — create a highlight
  DELETE /api/highlights/{highlight_id}?lesson_event_id=...
                                                — remove a highlight

The data layer's contract: store the highlighted text verbatim,
offsets as a hint. The controller is a thin pass-through; the
methodology lives in core/highlights_store.py.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from core.auth import require_write_password
from core.highlights_store import (
    ALLOWED_COLORS,
    ALLOWED_SOURCE_TYPES,
    delete_highlight,
    list_all_highlights,
    list_highlights_for_lesson,
    save_highlight,
)


router = APIRouter()


class HighlightCreateRequest(BaseModel):
    lesson_event_id: str = Field(..., description="SOT entry event_id this highlight is about")
    source_type: str = Field(..., description="raw_text | notebook_section")
    source_ref: Dict[str, Any] = Field(default_factory=dict, description="Identity fields for the surface the highlight was made on")
    start: int = Field(..., ge=0, description="Character offset start in the source")
    end: int = Field(..., gt=0, description="Character offset end (exclusive)")
    text: str = Field(..., min_length=1, description="The highlighted text VERBATIM — survives source edits")
    color: str = Field(..., description=f"One of {sorted(ALLOWED_COLORS)}")
    note: str = Field(default="", description="Optional single-line user note")


@router.get("/highlights")
def list_all_endpoint():
    """Every highlight across every lesson, grouped by lesson_event_id."""
    return list_all_highlights()


@router.get("/highlights/{lesson_event_id}")
def list_for_lesson_endpoint(lesson_event_id: str):
    """Highlights for one lesson (raw_text + notebook_section combined)."""
    return list_highlights_for_lesson(lesson_event_id)


@router.post(
    "/highlights",
    dependencies=[Depends(require_write_password)],
)
def create_endpoint(req: HighlightCreateRequest):
    """Create a new highlight. Returns the saved record with id + created_at filled in."""
    try:
        record = save_highlight(
            lesson_event_id=req.lesson_event_id,
            source_type=req.source_type,
            source_ref=req.source_ref,
            start=req.start,
            end=req.end,
            text=req.text,
            color=req.color,
            note=req.note,
        )
        return record
    except ValueError as e:
        # Data-layer validation errors map to 400 — the request was
        # well-formed Pydantic but the values violated the schema
        # (e.g. invalid color, end <= start, unknown source_type).
        raise HTTPException(status_code=400, detail=str(e))


@router.delete(
    "/highlights/{highlight_id}",
    dependencies=[Depends(require_write_password)],
)
def delete_endpoint(
    highlight_id: str,
    lesson_event_id: str = Query(..., description="Which lesson's file holds the highlight"),
):
    """
    Delete a highlight by id. Requires lesson_event_id as a query
    parameter — the data layer is keyed by lesson, so we'd have to
    scan all files otherwise. The frontend always knows the lesson
    a highlight belongs to, so this is a free constraint for the API
    but expensive to remove.
    """
    removed = delete_highlight(
        lesson_event_id=lesson_event_id,
        highlight_id=highlight_id,
    )
    if not removed:
        raise HTTPException(status_code=404, detail="Highlight not found")
    return {"deleted": True, "highlight_id": highlight_id}
