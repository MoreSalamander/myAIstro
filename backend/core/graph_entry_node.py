from core.event_schema import create_lesson_ingest_event, GraphEvent


class GraphEntryNode:
    def __init__(self):
        pass

    def run(self, course: str, week: str, lesson: str, input_text: str) -> GraphEvent:
        # Step 1: basic validation
        if not input_text or not input_text.strip():
            raise ValueError("input_text cannot be empty")

        if not course:
            raise ValueError("course is required")

        if not lesson:
            raise ValueError("lesson is required")

        # Step 2: create event
        event = create_lesson_ingest_event(
            course=course,
            week=week,
            lesson=lesson,
            raw_text=input_text
        )

        return event
