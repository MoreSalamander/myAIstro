"""
Graph entry — stage 1 of the ingestion pipeline.

Takes raw inputs from the HTTP controller (course/week/lesson/raw_text),
validates them, and produces a typed `GraphEvent` that the streaming
pipeline threads through every subsequent stage. The event carries the
event_id and trace_id that get surfaced downstream (in the SOT entry,
in the streaming response, in any debug logging).

This runs SYNCHRONOUSLY in the controller, before the streaming pipeline
generator is invoked, so a malformed payload fails fast with a 422
rather than streaming halfway through and then erroring.
"""

from core.event_schema import GraphEvent, create_lesson_ingest_event


class GraphEntryNode:
    """The pipeline's entry-point node — see module docstring."""

    def __init__(self):
        # No persistent state. The class shape is kept for symmetry with
        # other pipeline nodes that may need state in the future.
        pass

    def run(self, course: str, week: str, lesson: str, input_text: str) -> GraphEvent:
        """
        Validate inputs and build the typed event.

        Raises `ValueError` if any required field is empty so the
        controller can surface a 422 before any LLM work happens.
        """
        if not input_text or not input_text.strip():
            raise ValueError("input_text cannot be empty")
        if not course:
            raise ValueError("course is required")
        if not lesson:
            raise ValueError("lesson is required")

        return create_lesson_ingest_event(
            course=course,
            week=week,
            lesson=lesson,
            raw_text=input_text,
        )
