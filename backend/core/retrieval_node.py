from datetime import datetime


def build_retrieval_context(event):
    """
    ============================================
    RETRIEVAL NODE (v1 - SIMPLE / DETERMINISTIC)
    ============================================

    Purpose:
    --------
    This node converts a raw ingestion event into a
    structured, normalized context object that downstream
    nodes (summarization, validation, memory) can rely on.

    IMPORTANT DESIGN RULE:
    ----------------------
    - NO LLM usage here
    - NO inference
    - ONLY deterministic transformation
    - This is a "data shaping" layer, not intelligence
    """

    # -------------------------------------------------
    # SAFETY CHECK: ensure event exists
    # -------------------------------------------------
    if not event:
        raise ValueError("Retrieval node received empty event")

    # -------------------------------------------------
    # Extract payload safely
    # -------------------------------------------------
    payload = getattr(event, "payload", {})

    course = payload.get("course", "").strip()
    week = payload.get("week", "").strip()
    lesson = payload.get("lesson", "").strip()
    raw_text = payload.get("raw_text", "").strip()

    # -------------------------------------------------
    # Build normalized retrieval object
    # -------------------------------------------------
    retrieval_object = {
        # Identity layer (what this lesson is)
        "course": course,
        "week": week,
        "lesson": lesson,

        # Core content (what will be summarized later)
        "source_text": raw_text,

        # Structured search key (future expansion point)
        "retrieval_key": f"{course}:{week}:{lesson}".lower(),

        # Simple token-style context (stable baseline signal)
        "context_signature": " ".join([
            course,
            week,
            lesson
        ]).lower(),

        # Metadata (traceability layer)
        "timestamp": datetime.utcnow().isoformat(),
        "source_event_id": getattr(event, "event_id", None)
    }

    return retrieval_object
