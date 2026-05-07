from fastapi import APIRouter
from pydantic import BaseModel

from core.graph_entry_node import GraphEntryNode
from core.ingestion_pipeline import run_ingestion_pipeline

# =========================================================
# ROUTER SETUP
# This file defines the ingestion entry point for the system.
# Everything starts here when the UI sends a lesson.
# =========================================================

router = APIRouter()

# Entry node = converts raw UI input into a structured event
entry_node = GraphEntryNode()


# =========================================================
# REQUEST SCHEMA (UI CONTRACT)
# This defines EXACTLY what the frontend must send.
# Any mismatch → FastAPI returns 422 automatically.
# =========================================================
class LessonIngestRequest(BaseModel):
    course: str
    week: str
    lesson: str
    raw_text: str   # <-- IMPORTANT: standardized naming across system


# =========================================================
# INGEST ENDPOINT (ENTRY POINT OF SOT)
# This is the FIRST node in your system graph.
# =========================================================
@router.post("/ingest")
def ingest_lesson(req: LessonIngestRequest):

    # -----------------------------------------------------
    # Step 1: Convert raw UI request → internal Event object
    # This ensures consistent structure across pipeline
    # -----------------------------------------------------
    event = entry_node.run(
        course=req.course,
        week=req.week,
        lesson=req.lesson,
        input_text=req.raw_text
    )

    # -----------------------------------------------------
    # Step 2: Run ingestion pipeline graph
    # This is your first "system-of-traces" pipeline stage
    # -----------------------------------------------------
    timeline = run_ingestion_pipeline(event)

    # -----------------------------------------------------
    # Step 3: Return structured response to frontend
    # This is what your UI will visualize
    # -----------------------------------------------------
    return {
        "status": "success",
        "event": event.model_dump(),
        "timeline": timeline
    }
