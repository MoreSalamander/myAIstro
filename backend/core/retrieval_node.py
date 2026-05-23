"""
Retrieval Node — stage 2 of the ingestion pipeline.

Converts the typed `GraphEvent` from graph_entry into a normalized
context dict that summarization + validation consume. Pure data
shaping; no LLM, no inference, no I/O.

In the current pipeline this is essentially a pass-through that lifts
the raw_text out of the event's payload alongside identity fields
(course, week, lesson). Kept as a distinct pipeline stage because:

  1. It gives the streaming pipeline a clear event boundary to emit
     `step_complete` for, so the UI's data-flow canvas can light up
     the retrieval node even though the work here is light.
  2. It's the natural place for future context-aware ingestion (e.g.
     conditioning summarization on related SOT entries, or pulling
     in prior versions of the same lesson). When that lands, this
     stage becomes substantive without disturbing the pipeline shape.
"""

from datetime import datetime


def build_retrieval_context(event):
    """
    Build the retrieval-context dict the downstream stages consume.

    Returns a dict with:
      - course/week/lesson  : identity fields lifted from the event
      - source_text         : the raw lesson text summarization reads
      - retrieval_key       : (course:week:lesson) lowercased
      - context_signature   : identity terms space-joined, lowercased
      - timestamp           : when this stage ran
      - source_event_id     : trace identifier from the originating event

    Raises ValueError if the event is missing — fails fast so the
    pipeline doesn't try to summarize against nothing.
    """
    if not event:
        raise ValueError("Retrieval node received empty event")

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
