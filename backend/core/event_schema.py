from pydantic import BaseModel
from typing import Dict, Any
from uuid import uuid4
from datetime import datetime


class GraphEvent(BaseModel):
    event_id: str
    event_type: str
    payload: Dict[str, Any]
    context: Dict[str, Any]


def create_lesson_ingest_event(course: str, week: str, lesson: str, raw_text: str) -> GraphEvent:
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
