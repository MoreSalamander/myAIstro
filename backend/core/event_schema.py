"""
Event schema — the typed envelope passed between ingestion pipeline stages.

Every pipeline run starts with a `GraphEvent` produced by
`graph_entry_node.py` and threaded through retrieval → summarization →
validation → memory_write. Pydantic enforces shape at the boundary so
downstream stages can rely on `event.payload["course"]` (etc.) being
present rather than defensively `.get()`-ing every field.

Right now there's exactly one event type (`LESSON_INGEST`). The
event-typed envelope is overkill for a single type — kept because it
gives every event a stable `event_id` and `trace_id` for logging /
observability, and because adding new event types (e.g. for re-ingest
flows or batch imports) is an obvious extension.
"""

from datetime import datetime
from typing import Any, Dict
from uuid import uuid4

from pydantic import BaseModel


class GraphEvent(BaseModel):
    """
    Pipeline event envelope.

    - event_id   : per-event UUID; what gets surfaced as the SOT entry's event_id
    - event_type : currently always "LESSON_INGEST"
    - payload    : the actual data (course, week, lesson, raw_text)
    - context    : provenance (origin, trace_id, timestamp)
    """
    event_id: str
    event_type: str
    payload: Dict[str, Any]
    context: Dict[str, Any]


def create_lesson_ingest_event(course: str, week: str, lesson: str, raw_text: str) -> GraphEvent:
    """Build a LESSON_INGEST event ready to feed into the pipeline."""
    now = datetime.utcnow().isoformat()

    return GraphEvent(
        event_id=str(uuid4()),
        event_type="LESSON_INGEST",
        payload={
            "course": course,
            "week": str(week),
            "lesson": lesson,
            "raw_text": raw_text.strip(),
        },
        context={
            "origin": "ui",
            "trace_id": str(uuid4()),
            "timestamp": now,
        }
    )
