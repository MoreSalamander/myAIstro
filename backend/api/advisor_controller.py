"""
Advisor endpoint — natural-language Q&A over the SOT.

POST /api/advisor/chat   body: {query}

Streams NDJSON events from the advisor pipeline (see
core/advisor_pipeline.py for full event shape documentation):

    {"type": "start",         "query": "..."}
    {"type": "step_start",    "step": "retrieval"}
    {"type": "step_complete", "step": "retrieval", "entries": [...]}
    {"type": "step_start",    "step": "section", "index": N, "total": M, ...}
    {"type": "token",         "value": "...", "section_id": "..."}    (many)
    {"type": "step_complete", "step": "section", "index": N, "total": M, ...}
    {"type": "step_start",    "step": "assembly"}
    {"type": "step_complete", "step": "assembly"}
    {"type": "done"}
    {"type": "error",         "message": "..."}

The frontend's ChatPanel consumes the stream: it shows a small staging
strip ("section N of M: <lesson>"), accumulates tokens into the
response body in arrival order (the assembled study guide IS the
concatenated stream), and renders the matched entries from the
retrieval step as context chips.

This controller is intentionally thin — all the orchestration lives
in the pipeline module, the same way ingestion_controller.py defers
to ingestion_pipeline.py.
"""

import json
import traceback

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.advisor_pipeline import stream_advisor_pipeline


router = APIRouter()


class ChatRequest(BaseModel):
    query: str


@router.post("/advisor/chat")
def advisor_chat(req: ChatRequest):
    def stream():
        try:
            for event in stream_advisor_pipeline(req.query):
                yield json.dumps(event) + "\n"
        except Exception as e:
            # Pipeline-level exception — log the full traceback to
            # stderr (uvicorn picks it up) so the failure is debuggable,
            # and surface the exception class + message to the client
            # so the UI shows something more useful than a dead stream.
            traceback.print_exc()
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")
