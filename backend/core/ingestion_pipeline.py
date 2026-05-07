from core.execution_engine import Task, Node
from agents.summarization_agent import summarize_lesson
from agents.validation_agent import validate_summary
from core.retrieval_node import build_retrieval_context
from core.memory_writer_node import write_to_memory


def run_ingestion_pipeline(event):
    """
    ======================================================
    INGESTION PIPELINE (v3 - FULL SOT LOOP)
    ======================================================

    PURPOSE:
    --------
    This pipeline implements a complete System-of-Truth flow:

        Event → Retrieval → Summarization → Validation → Memory

    CRITICAL RULE:
    --------------
    Memory is ONLY written if validation passes.

    This ensures:
    - No polluted knowledge store
    - No hallucinated persistence
    - Strong data integrity boundary
    """

    timeline = []

    # =========================================================
    # NODE 1: INGESTION
    # =========================================================
    def ingest_node(context):
        """
        Marks entry into system.
        """
        timeline.append({
            "step": "ingest_received",
            "event_id": event.event_id
        })

        return event

    # =========================================================
    # NODE 2: RETRIEVAL (STRUCTURE LAYER)
    # =========================================================
    def retrieval_node(context):
        """
        Converts raw event into structured SOT context.
        """

        ingest_event = context.get("ingest")

        if not ingest_event:
            raise ValueError("Missing ingest event")

        retrieval = build_retrieval_context(ingest_event)

        timeline.append({
            "step": "retrieval",
            "status": "complete",
            "data": retrieval
        })

        return retrieval

    # =========================================================
    # NODE 3: SUMMARIZATION (LLM LAYER)
    # =========================================================
    def summarization_node(context):
        """
        Generates structured summary from retrieval context.
        """

        retrieval = context.get("retrieval")

        if not retrieval:
            raise ValueError("Missing retrieval context")

        raw_text = retrieval.get("source_text", "")

        result = summarize_lesson(raw_text)

        timeline.append({
            "step": "summarization",
            "status": "complete",
            "data": result
        })

        return result

    # =========================================================
    # NODE 4: VALIDATION (GATEKEEPER)
    # =========================================================
    def validation_node(context):
        """
        Validates summarization output.

        Output determines whether memory write is allowed.
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

    # =========================================================
    # NODE 5: MEMORY WRITE (GATED)
    # =========================================================
    def memory_node(context):
        """
        PURPOSE:
        - Persist validated knowledge into long-term memory store
        - ONLY runs if validation == PASS
        """

        validation_result = context.get("validation")

        # -------------------------
        # HARD GATE
        # -------------------------
        if not validation_result or validation_result.get("validation") != "PASS":
            timeline.append({
                "step": "memory_write",
                "status": "skipped",
                "reason": "validation_failed"
            })
            return {"status": "skipped"}

        ingest_event = context.get("ingest")
        summarization_result = context.get("summarization")

        result = write_to_memory(ingest_event, summarization_result, validation_result)

        timeline.append({
            "step": "memory_write",
            "status": "written",
            "details": result
        })

        return result

    # =========================================================
    # BUILD GRAPH
    # =========================================================

    task = Task(input_data={"event": event})

    ingest = Node("ingest", ingest_node)
    retrieval = Node("retrieval", retrieval_node, depends_on=[ingest])
    summarization = Node("summarization", summarization_node, depends_on=[retrieval])
    validation = Node("validation", validation_node, depends_on=[summarization])

    # Memory depends on EVERYTHING
    memory = Node("memory", memory_node, depends_on=[validation, summarization, retrieval])

    task.add_node(ingest)
    task.add_node(retrieval)
    task.add_node(summarization)
    task.add_node(validation)
    task.add_node(memory)

    # =========================================================
    # EXECUTE
    # =========================================================

    task.run()

    return timeline
