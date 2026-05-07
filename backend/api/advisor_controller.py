"""
Advisor endpoint — natural-language Q&A over the SOT.

POST /api/advisor/chat   body: {query}
    Streams NDJSON events:
      {"type": "context", "entries": [{event_id, course, week, lesson}, ...]}
      {"type": "token",   "value": "..."}                                (many)
      {"type": "done"}
      {"type": "error",   "message": "..."}

The frontend appends `value` chunks into a single response string and
shows the selected context entries as chips.
"""

import json
import traceback

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agents.advisor_agent import stream_chat
from core.sot_selector import select_relevant_entries


router = APIRouter()


class ChatRequest(BaseModel):
    query: str


@router.post("/advisor/chat")
def advisor_chat(req: ChatRequest):
    selected = select_relevant_entries(req.query)

    def stream():
        try:
            yield (
                json.dumps({
                    "type": "context",
                    "entries": [
                        {
                            "event_id": e.get("event_id"),
                            "course": e.get("course"),
                            "week": e.get("week"),
                            "lesson": e.get("lesson"),
                        }
                        for e in selected
                    ],
                })
                + "\n"
            )

            for token in stream_chat(req.query, selected):
                yield json.dumps({"type": "token", "value": token}) + "\n"

            yield json.dumps({"type": "done"}) + "\n"
        except Exception as e:
            traceback.print_exc()
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")
