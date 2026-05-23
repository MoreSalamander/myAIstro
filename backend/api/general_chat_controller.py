"""
General-chat endpoint — free-form Q&A unrelated to the SOT.

POST /api/chat/general   body: {query}
    Streams NDJSON events:
      {"type": "token", "value": "..."}     (many)
      {"type": "done"}
      {"type": "error", "message": "..."}

Mirror of /api/advisor/chat but with no SOT retrieval and no
context-entries event.
"""

import json
import traceback

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agents.general_chat_agent import stream_chat


router = APIRouter()


class GeneralChatRequest(BaseModel):
    query: str


@router.post("/chat/general")
def general_chat(req: GeneralChatRequest):
    def stream():
        try:
            for token in stream_chat(req.query):
                yield json.dumps({"type": "token", "value": token}) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
        except Exception as e:
            traceback.print_exc()
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")
