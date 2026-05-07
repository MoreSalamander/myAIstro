"""
Ingestion endpoint — streams pipeline progress as NDJSON.

Each line of the response is one JSON event from
`stream_ingestion_pipeline`. The frontend consumes the body
incrementally and lights each pipeline node as the events arrive.
"""

import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.graph_entry_node import GraphEntryNode
from core.ingestion_pipeline import stream_ingestion_pipeline


router = APIRouter()
entry_node = GraphEntryNode()


class LessonIngestRequest(BaseModel):
    course: str
    week: str
    lesson: str
    raw_text: str


@router.post("/ingest")
def ingest_lesson(req: LessonIngestRequest):
    event = entry_node.run(
        course=req.course,
        week=req.week,
        lesson=req.lesson,
        input_text=req.raw_text,
    )

    def stream():
        try:
            for chunk in stream_ingestion_pipeline(event):
                yield json.dumps(chunk) + "\n"
        except Exception as e:
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")
