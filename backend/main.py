"""
myAIstro Main API

This file defines:
- FastAPI app
- Query pipeline (retrieval → summarization → validation)
- System entry points

This is the READ side of the system (uses memory).
"""

import json
import os

from fastapi import FastAPI
from pydantic import BaseModel
from datetime import datetime
from fastapi.middleware.cors import CORSMiddleware

# Core graph engine
from core.execution_engine import Task, Node

# Agents
from agents.summarization_agent import summarize_lesson
from agents.validation_agent import validate_summary

# Memory (NEW)
from core.memory_reader import retrieve_from_memory

# Ingestion router (WRITE side)
from api.ingestion_controller import router as ingestion_router

# Quiz router (downstream SOT consumer)
from api.quiz_controller import router as quiz_router


SOT_FILE = "memory_store.json"


# =========================================================
# APP INIT
# =========================================================
app = FastAPI()

# Register ingestion endpoint
app.include_router(ingestion_router, prefix="/api")
app.include_router(quiz_router, prefix="/api")


# =========================================================
# CORS (allows frontend to call backend)
# =========================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =========================================================
# REQUEST SCHEMA
# =========================================================
class QueryRequest(BaseModel):
    query: str


# =========================================================
# ROOT (health check)
# =========================================================
@app.get("/")
def root():
    return {
        "status": "myAIstro backend running",
        "timestamp": datetime.utcnow().isoformat()
    }


# =========================================================
# SOT BROWSE ENDPOINT
# Returns the full Source of Truth so the UI can list / filter.
# =========================================================
@app.get("/api/sot")
def list_sot():
    if not os.path.exists(SOT_FILE):
        return []
    with open(SOT_FILE, "r") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


# =========================================================
# QUERY ENDPOINT (READ PIPELINE)
# =========================================================
@app.post("/query")
def query_endpoint(request: QueryRequest):
    """
    Executes the READ pipeline:

    1. Retrieve relevant memory
    2. Summarize retrieved knowledge
    3. Validate result

    Returns full timeline for observability
    """

    timeline = []

    # =====================================================
    # NODE 1: RETRIEVAL
    # =====================================================
    def retrieval_node(context):
        """
        Pull relevant knowledge from memory_store.json
        using keyword overlap scoring.
        """

        matches = retrieve_from_memory(request.query)

        source_text = " ".join(m.get("summary", "") for m in matches)

        result = {
            "matches": matches,
            "query": request.query,
            "source_text": source_text,
            "timestamp": datetime.utcnow().isoformat()
        }

        timeline.append({
            "step": "retrieval",
            "status": "complete",
            "matches_found": len(matches),
            "data": result
        })

        return result


    # =====================================================
    # NODE 2: SUMMARIZATION
    # =====================================================
    def summarization_node(context):
        """
        Takes retrieved matches and generates a structured summary.
        """

        retrieval_data = context.get("retrieval", {})
        combined_text = retrieval_data.get("source_text", "")

        result = summarize_lesson(combined_text)

        timeline.append({
            "step": "summarization",
            "status": "complete",
            "timestamp": datetime.utcnow().isoformat(),
            "data": result
        })

        return result


    # =====================================================
    # NODE 3: VALIDATION
    # =====================================================
    def validation_node(context):
        """
        Validates the summarization output.
        """

        result = validate_summary(context)

        timeline.append({
            "step": "validation",
            "status": result.get("validation", "UNKNOWN"),
            "score": result.get("score", 0),
            "errors": result.get("errors", []),
            "warnings": result.get("warnings", []),
            "validated_at": result.get("validated_at")
        })

        return result


    # =====================================================
    # BUILD TASK GRAPH
    # =====================================================
    task = Task(input_data={"query": request.query})

    retrieval = Node("retrieval", retrieval_node)
    summarization = Node("summarization", summarization_node, depends_on=[retrieval])
    validation = Node("validation", validation_node, depends_on=[summarization])

    task.add_node(retrieval)
    task.add_node(summarization)
    task.add_node(validation)

    # =====================================================
    # EXECUTE PIPELINE
    # =====================================================
    task.run()

    # =====================================================
    # RETURN RESPONSE
    # =====================================================
    return {
        "query": request.query,
        "timeline": timeline
    }
