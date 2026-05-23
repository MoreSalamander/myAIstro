"""
Ingestion Pipeline — the orchestrator that turns a raw lesson into a
validated Source-of-Truth entry, streaming progress as NDJSON.

The five conceptual stages of ingestion are:

    graph_entry → retrieval → summarization → validation → memory_write

Stage 1 (graph_entry) is handled SYNCHRONOUSLY in the ingestion
controller before this generator is invoked — that step creates the
typed event (event_id, trace_id, timestamps) that the pipeline then
threads through every downstream stage. The generator below begins
with an `ingest_received` event that acknowledges the already-created
event to the streaming client, then runs the remaining four stages in
sequence.

Why streaming, not request/response:
  The frontend lights each pipeline node in real time as the backend
  actually finishes that step — instead of a client-side timer faking
  progress after a single blocking response returns. The Data Flow
  canvas in the browser consumes the body incrementally; each yielded
  event causes a node on screen to update.

Event shapes:
    {"type": "start",         "event": {...}}        # the typed event itself
    {"type": "step_start",    "step": "<name>"}      # before the stage runs
    {"type": "step_complete", "step": "<name>", ...} # after the stage runs
    {"type": "done"}                                 # pipeline finished
    {"type": "error",         "message": "..."}      # only on exception

Pipeline contract:
  - retrieval and summarization always run.
  - validation gates memory_write: if validation != PASS,
    memory_write yields a "skipped" status without touching the SOT.
  - validation FAILs are echoed to stderr so they're debuggable from
    the uvicorn output (the streaming body carries them to the UI but
    is gone once the user navigates away).
"""

import sys
from typing import Iterator

from agents.summarization_agent import summarize_lesson
from agents.validation_agent import validate_summary
from core.memory_writer_node import write_to_memory
from core.retrieval_node import build_retrieval_context


def stream_ingestion_pipeline(event) -> Iterator[dict]:
    """
    Run the four post-graph_entry stages and yield NDJSON-ready events.

    Parameters
    ----------
    event : GraphEntryEvent
        The typed event produced by `core.graph_entry_node.GraphEntryNode.run`.
        Carries event_id, trace_id, timestamps, and the raw payload
        (course, week, lesson, raw_text).

    Yields
    ------
    dict
        One event per pipeline transition. The caller (ingestion
        controller) JSON-serializes each one and writes it to the
        streaming response with a trailing newline.
    """
    yield {"type": "start", "event": event.model_dump()}

    # =====================================================
    # STAGE: ingest_received
    # Confirms the graph_entry stage that already ran in the controller.
    # Effectively a "we got your input" acknowledgment to the streaming
    # client; no work happens here beyond echoing the event_id.
    # =====================================================
    yield {"type": "step_start", "step": "ingest_received"}
    yield {
        "type": "step_complete",
        "step": "ingest_received",
        "event_id": event.event_id,
    }

    # =====================================================
    # STAGE: retrieval
    # Currently a pass-through that forwards the raw_text. Kept as a
    # stage so future context-aware ingestion (e.g., conditioning
    # summarization on related SOT entries) has a place to live.
    # =====================================================
    yield {"type": "step_start", "step": "retrieval"}
    retrieval = build_retrieval_context(event)
    yield {
        "type": "step_complete",
        "step": "retrieval",
        "status": "complete",
        "data": retrieval,
    }

    # =====================================================
    # STAGE: summarization
    # The LLM-heavy step. llama3:8b extracts structure (summary,
    # key_concepts, definitions, code_blocks) from the raw lesson
    # text. The agent layers multiple defenses against captured
    # malformed-output failure modes — see
    # agents/summarization_agent.py top-of-file for the defense list.
    # =====================================================
    yield {"type": "step_start", "step": "summarization"}
    raw_text = retrieval.get("source_text", "")
    summarization = summarize_lesson(raw_text)
    yield {
        "type": "step_complete",
        "step": "summarization",
        "status": "complete",
        "data": summarization,
    }

    # =====================================================
    # STAGE: validation
    # Pure-Python rule check on the summarization output. The most
    # important defense in the pipeline — see
    # agents/validation_agent.py for the full rule list, including
    # the per-item grounding gate that drops hallucinated bullets
    # before they ever reach the SOT.
    # =====================================================
    yield {"type": "step_start", "step": "validation"}
    validation_context = {"retrieval": retrieval, "summarization": summarization}
    validation = validate_summary(validation_context)

    # Log validation FAILs to stderr so we can debug rejected ingests.
    # The streaming response carries this detail to the UI, but it's
    # gone once the user navigates away — the stderr line is the only
    # persistent record of WHY an ingest didn't write.
    if validation.get("validation") != "PASS":
        payload = event.payload
        print(
            "[validation FAIL] "
            f"course={payload.get('course')!r} "
            f"week={payload.get('week')!r} "
            f"lesson={payload.get('lesson')!r}\n"
            f"  errors:   {validation.get('errors', [])}\n"
            f"  warnings: {validation.get('warnings', [])}\n"
            f"  summary preview ({len(summarization.get('summary') or '')} chars): "
            f"{(summarization.get('summary') or '')[:200]!r}\n"
            f"  key_concepts: {summarization.get('key_concepts')}\n"
            f"  source_text length: {len(retrieval.get('source_text') or '')} chars",
            file=sys.stderr,
            flush=True,
        )

    yield {
        "type": "step_complete",
        "step": "validation",
        "status": validation.get("validation"),
        "score": validation.get("score", 0),
        "errors": validation.get("errors", []),
        "warnings": validation.get("warnings", []),
        "validated_at": validation.get("validated_at"),
    }

    # =====================================================
    # STAGE: memory_write  (gated on validation == PASS)
    # The persistence gate. Upserts by (course, week, lesson) — see
    # core/memory_writer_node.py. Mirrors into the Obsidian vault as
    # a side effect after a successful commit (vault failures don't
    # fail the ingest; the SOT is canonical, the vault is derived).
    # =====================================================
    yield {"type": "step_start", "step": "memory_write"}
    if validation.get("validation") != "PASS":
        # Validation rejected the summary — refuse to write. The entry
        # never reaches the SOT and never appears in any downstream
        # view. The user sees the validation errors in the UI and can
        # re-ingest after fixing the source.
        result = {"status": "skipped", "reason": "validation_failed"}
    else:
        result = write_to_memory(event, summarization, validation)
    yield {
        "type": "step_complete",
        "step": "memory_write",
        "status": result.get("status", "written"),
        "details": result,
    }

    yield {"type": "done"}
