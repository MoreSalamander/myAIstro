"""
Memory Writer Node

Persists validated knowledge into the SOT store (JSON file).

Behavior:
- Validation gate: only writes if validation == PASS.
- Upsert by (course, week, lesson) — re-ingesting the same lesson
  replaces the previous entry instead of appending a duplicate.
- After a successful write, mirrors the SOT into the Obsidian vault
  so the markdown view stays in sync.
"""

import json
import os
import traceback
from datetime import datetime

from core.obsidian_export import sync_vault


MEMORY_FILE = "memory_store.json"


def write_to_memory(event, summary_data, validation_data):
    """
    Writes validated summary into the SOT store.

    Returns:
        {"status": "written" | "replaced" | "skipped", ...}
    """

    if validation_data.get("validation") != "PASS":
        return {
            "status": "skipped",
            "reason": "validation_failed",
        }

    entry = {
        "event_id": event.event_id,
        "trace_id": event.context.get("trace_id"),
        "course": event.payload.get("course"),
        "week": event.payload.get("week"),
        "lesson": event.payload.get("lesson"),

        # Original source — kept so future agents can re-summarize, fact-check,
        # or otherwise reason against the source, not just the derived summary.
        "raw_text": event.payload.get("raw_text"),

        "summary": summary_data.get("summary"),
        "key_concepts": summary_data.get("key_concepts"),
        "definitions": summary_data.get("definitions"),
        "code_blocks": summary_data.get("code_blocks"),

        # Deterministic sidecar — extracted verbatim from raw_text by
        # core.mastery_extractor when the canonical `## Mastery Goals`
        # pattern is present. Empty list otherwise. The LLM has no
        # role in this field; downstream surfaces (Classroom CHECK
        # generation, Quiz prioritization) treat it as authoritative.
        "mastery_goals": summary_data.get("mastery_goals") or [],

        "validation_score": validation_data.get("score"),
        "created_at": datetime.utcnow().isoformat(),
    }

    data = _load_store()

    key = _key_of(entry)
    replaced_index = next(
        (i for i, e in enumerate(data) if _key_of(e) == key),
        None,
    )

    if replaced_index is not None:
        data[replaced_index] = entry
        action = "replaced"
    else:
        data.append(entry)
        action = "written"

    with open(MEMORY_FILE, "w") as f:
        json.dump(data, f, indent=2)

    # Mirror to Obsidian vault. Failures here must NOT fail the ingest —
    # the SOT is canonical; the vault is a derived view.
    try:
        sync_vault(MEMORY_FILE)
    except Exception:
        traceback.print_exc()

    return {
        "status": action,
        "entries": len(data),
    }


def _load_store():
    if not os.path.exists(MEMORY_FILE):
        return []
    with open(MEMORY_FILE, "r") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


def _key_of(entry):
    return (
        entry.get("course"),
        entry.get("week"),
        entry.get("lesson"),
    )
