"""
Advisor Pipeline — streaming map-then-assemble pipeline for SOT-grounded chat.

The advisor's counterpart to `core/ingestion_pipeline.py`. Same
architectural shape: a generator that yields NDJSON events as it
runs through a fixed sequence of stages. The ChatPanel in the UI
consumes the stream and renders both a small staging strip (showing
current stage / section progress) and the assembled response body.

Stages:
  1. retrieval     — sot_selector picks relevant canonical entries.
  2. section ×N    — per-entry LLM call produces one study-guide
                     section. N == number of retrieved entries.
                     Each section's tokens are streamed as they
                     arrive, tagged with the entry's event_id so
                     the frontend can group by section.
  3. assembly      — terminal marker. Assembly itself is deterministic
                     (Python concatenates the streamed tokens in
                     order); this stage just signals completion.

Why per-section instead of one big call:
  The single-shot approach (one prompt with N entries, one streamed
  response) forced the model to share a fixed output budget across
  every lesson. Code samples got cut, per-lesson depth flattened, and
  multi-lesson queries occasionally drifted on the connective work
  between lessons. Per-section processing gives each lesson its own
  dedicated output budget AND its own focused context (just one
  entry), so depth and grounding both improve at the cost of more
  sequential model calls.

Why deterministic concat (no LLM reduce):
  Aligns with the project's "model proposes, Python disposes"
  principle. The synthesis would be a second LLM call that could
  hallucinate cross-lesson claims; assembly is just string
  concatenation in Python.

Event shapes (mirror ingest pipeline):
  {"type": "start",         "query": "..."}
  {"type": "step_start",    "step": "retrieval"}
  {"type": "step_complete", "step": "retrieval",
                            "entries": [{event_id, course, week, lesson}, ...]}
  {"type": "step_start",    "step": "section", "event_id": "...",
                            "lesson": "...", "course": "...", "week": "...",
                            "index": N, "total": M}
  {"type": "token",         "value": "...", "section_id": "<event_id>"}   (many)
  {"type": "step_complete", "step": "section", "event_id": "...",
                            "lesson": "...", "index": N, "total": M}
  {"type": "step_start",    "step": "assembly"}
  {"type": "step_complete", "step": "assembly"}
  {"type": "done"}
  {"type": "error",         "message": "..."}
"""

from typing import Iterator

from agents.advisor_agent import stream_reduce, stream_section
from core.sot_selector import select_relevant_entries


# Separator emitted between sections so the assembled text has clean
# visual breathing room. Sent as a regular token event tagged to the
# section that just completed, so the frontend renders it inline with
# everything else without any special handling.
_SECTION_SEPARATOR = "\n\n---\n\n"


def stream_advisor_pipeline(query: str) -> Iterator[dict]:
    """
    Yield NDJSON-ready events for one advisor query.

    The caller (advisor_controller) serializes each event onto the
    wire. No state is kept between calls; the pipeline is a pure
    generator.
    """
    yield {"type": "start", "query": query}

    # =====================================================
    # STAGE: retrieval
    # Selects relevant canonical SOT entries via sot_selector. The
    # canonical filter applied in sot_selector._load_sot means we
    # never see duplicate (canonical + audit-satellite) versions of
    # the same lesson.
    # =====================================================
    yield {"type": "step_start", "step": "retrieval"}
    entries = select_relevant_entries(query)
    context_entries = [
        {
            "event_id": e.get("event_id"),
            "course": e.get("course"),
            "week": e.get("week"),
            "lesson": e.get("lesson"),
        }
        for e in entries
    ]
    yield {
        "type": "step_complete",
        "step": "retrieval",
        "entries": context_entries,
    }

    # No-match short-circuit: emit a single user-facing line via the
    # token stream so the ChatPanel renders something useful instead
    # of a blank response.
    if not entries:
        yield {"type": "step_start", "step": "assembly"}
        yield {
            "type": "token",
            "value": (
                "No SOT entries matched this query. Try ingesting the "
                "relevant lesson first, or rephrase to name a specific "
                "course/week (e.g. 'study guide for FE102 week 2')."
            ),
        }
        yield {"type": "step_complete", "step": "assembly"}
        yield {"type": "done"}
        return

    # =====================================================
    # STAGE: arc  (opening framing paragraph)
    # One LLM call that reads the lesson list and writes a 2-4 sentence
    # opening paragraph naming the conceptual arc across the lessons.
    # Skipped for single-entry queries — there's no arc to narrate
    # across a single lesson, so falling straight into the section
    # reads better. The reduce call only sees the lesson list +
    # summaries (not the section content), so a bad reduce affects
    # only this paragraph, never the sections.
    # =====================================================
    multi_lesson = len(entries) > 1
    if multi_lesson:
        yield {"type": "step_start", "step": "arc"}
        for token in stream_reduce(query, entries, mode="arc"):
            yield {"type": "token", "value": token, "section_id": "arc"}
        yield {"type": "step_complete", "step": "arc"}
        # Visual separator between arc and the first section.
        yield {"type": "token", "value": _SECTION_SEPARATOR, "section_id": "arc"}

    # =====================================================
    # STAGE: section ×N  (the map step)
    # Each iteration is one LLM call producing one section. Tokens
    # stream as they arrive, tagged with the entry's event_id so the
    # frontend can correlate them to the current section's progress
    # indicator. Sections run sequentially because Ollama serves one
    # request per model at a time on a single GPU — parallelizing
    # would just queue the requests.
    # =====================================================
    total = len(entries)
    for index, entry in enumerate(entries, start=1):
        section_event_id = entry.get("event_id")
        yield {
            "type": "step_start",
            "step": "section",
            "event_id": section_event_id,
            "lesson": entry.get("lesson"),
            "course": entry.get("course"),
            "week": entry.get("week"),
            "index": index,
            "total": total,
        }
        for token in stream_section(query, entry):
            yield {
                "type": "token",
                "value": token,
                "section_id": section_event_id,
            }
        yield {
            "type": "step_complete",
            "step": "section",
            "event_id": section_event_id,
            "lesson": entry.get("lesson"),
            "index": index,
            "total": total,
        }
        # Visual separator between sections — except after the last one
        # to avoid trailing whitespace. Tagged to the section that just
        # completed so any frontend grouping logic keeps it associated.
        if index < total:
            yield {
                "type": "token",
                "value": _SECTION_SEPARATOR,
                "section_id": section_event_id,
            }

    # =====================================================
    # STAGE: recap  (closing framing paragraph)
    # Mirror of the arc stage at the other end. One LLM call that
    # reads the lesson list and writes a 2-3 sentence closing
    # paragraph naming what the user should now understand. Skipped
    # for single-entry queries (same reasoning as arc). Uses the same
    # lesson-list input as arc — the recap does NOT re-read the
    # generated sections, so a bad recap can't drag down section
    # quality and the call stays fast.
    # =====================================================
    if multi_lesson:
        # Separator between the last section and the recap — same
        # visual break as between sections.
        yield {"type": "token", "value": _SECTION_SEPARATOR, "section_id": "recap"}
        yield {"type": "step_start", "step": "recap"}
        for token in stream_reduce(query, entries, mode="recap"):
            yield {"type": "token", "value": token, "section_id": "recap"}
        yield {"type": "step_complete", "step": "recap"}

    # =====================================================
    # STAGE: assembly  (deterministic — the terminal marker)
    # The assembled output IS the concatenated token stream the
    # client has already received in order. This stage exists as an
    # event marker so the UI can transition out of any "section X of
    # N" / "recap" indicator into a "done" state. Python does the
    # concatenation implicitly; no LLM call here.
    # =====================================================
    yield {"type": "step_start", "step": "assembly"}
    yield {"type": "step_complete", "step": "assembly"}
    yield {"type": "done"}
