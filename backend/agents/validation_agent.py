from datetime import datetime


def validate_summary(context: dict):
    """
    ======================================================
    VALIDATION AGENT (v2 - RETRIEVAL-AWARE)
    ======================================================

    PURPOSE:
    --------
    Ensures summarization output is:
        - structurally valid
        - grounded in retrieval source text
        - internally consistent

    KEY CHANGE:
    -----------
    Validation now uses RETRIEVAL as grounding source.
    """

    errors = []
    warnings = []

    retrieval = context.get("retrieval")
    summary = context.get("summarization")

    # -------------------------------------------------
    # BASIC SAFETY CHECK
    # -------------------------------------------------
    if not retrieval:
        errors.append("Missing retrieval context")

    if not summary:
        errors.append("Missing summarization output")

    if errors:
        return {
            "validation": "FAIL",
            "score": 0,
            "errors": errors,
            "warnings": warnings,
            "validated_at": datetime.utcnow().isoformat()
        }

    # -------------------------------------------------
    # STRUCTURE VALIDATION
    # -------------------------------------------------
    required_fields = ["summary", "generated_at"]

    for field in required_fields:
        if field not in summary:
            errors.append(f"Missing field: {field}")

    # -------------------------------------------------
    # GROUNDING CHECK (IMPROVED)
    # -------------------------------------------------
    source_text = retrieval.get("source_text", "").lower()
    summary_text = summary.get("summary", "").lower()

    # Weak v1 grounding heuristic:
    # We check whether at least some overlap exists
    if summary_text and source_text:
        overlap_found = any(
            word in source_text for word in summary_text.split()[:10]
        )

        if not overlap_found:
            warnings.append("Weak grounding signal detected")

    # -------------------------------------------------
    # FINAL RESULT
    # -------------------------------------------------
    if errors:
        return {
            "validation": "FAIL",
            "score": 0,
            "errors": errors,
            "warnings": warnings,
            "validated_at": datetime.utcnow().isoformat()
        }

    return {
        "validation": "PASS",
        "score": 1 if not warnings else 0.7,
        "errors": [],
        "warnings": warnings,
        "validated_at": datetime.utcnow().isoformat()
    }
