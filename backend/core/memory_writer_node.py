"""
Memory Writer Node (SOT v1)

Purpose:
- Persist validated knowledge into storage (JSON file)
- Acts as first "memory layer" of system

Design:
- Append-only (no overwrites)
- Human-readable
- Traceable via event_id + trace_id
"""

import json
import os
from datetime import datetime


# where memory is stored
MEMORY_FILE = "memory_store.json"


def write_to_memory(event, summary_data, validation_data):
    """
    Writes validated summary into memory store.

    Parameters:
    - event: original ingestion event
    - summary_data: output from summarization agent
    - validation_data: output from validation agent
    """

    # -----------------------------------
    # ONLY WRITE IF VALID
    # -----------------------------------
    if validation_data.get("validation") != "PASS":
        return {
            "status": "skipped",
            "reason": "validation_failed"
        }

    # -----------------------------------
    # BUILD MEMORY ENTRY
    # -----------------------------------
    entry = {
        "event_id": event.event_id,
        "trace_id": event.context.get("trace_id"),
        "course": event.payload.get("course"),
        "week": event.payload.get("week"),
        "lesson": event.payload.get("lesson"),

        "summary": summary_data.get("summary"),
        "key_concepts": summary_data.get("key_concepts"),
        "definitions": summary_data.get("definitions"),
        "code_blocks": summary_data.get("code_blocks"),

        "validation_score": validation_data.get("score"),
        "created_at": datetime.utcnow().isoformat()
    }

    # -----------------------------------
    # LOAD EXISTING MEMORY
    # -----------------------------------
    if os.path.exists(MEMORY_FILE):
        with open(MEMORY_FILE, "r") as f:
            try:
                data = json.load(f)
            except:
                data = []
    else:
        data = []

    # -----------------------------------
    # APPEND NEW ENTRY
    # -----------------------------------
    data.append(entry)

    # -----------------------------------
    # SAVE BACK TO FILE
    # -----------------------------------
    with open(MEMORY_FILE, "w") as f:
        json.dump(data, f, indent=2)

    return {
        "status": "written",
        "entries": len(data)
    }
