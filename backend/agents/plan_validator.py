"""
Plan Validator — rule-based gatekeeper for Teacher Aide output. Same
spirit as validation_agent.py: rejects malformed or vacuous plans
before they get persisted and replayed at the user.

Returns a dict { "validation": "PASS"|"FAIL", "score": 0..1, "errors": [], "warnings": [] }
"""

from datetime import datetime
from typing import Dict


MIN_BEATS = 3
MAX_BEATS = 18
MIN_EXPOSITION = 1
MIN_CHECK = 1
MIN_CONTENT_CHARS = 20


def validate_plan(plan: Dict) -> Dict:
    """
    Gate a Teacher Aide plan before it's persisted.

    Checks:
      - plan is a JSON object with a `beats` array
      - beat count between MIN_BEATS (3) and MAX_BEATS (18)
      - each beat is a typed object with the per-type required fields:
          * CHECK     → question + canonical_answer (both non-empty)
          * EXAMPLE   → at least one of content / explanation / code
          * other     → non-empty content
      - at least MIN_EXPOSITION EXPOSITION beats
      - at least MIN_CHECK CHECK beats
      - presence of a RECAP beat (warning only)

    Returns a `{validation, score, errors, warnings, validated_at}`
    dict. A FAIL prevents persistence; PASS-with-warnings still
    persists but flags the rough edges.
    """
    errors = []
    warnings = []

    if not isinstance(plan, dict):
        return _fail(["Plan is not a JSON object"], [])

    beats = plan.get("beats")
    if not isinstance(beats, list):
        return _fail(["Plan has no beats array"], [])
    if len(beats) < MIN_BEATS:
        errors.append(f"Too few beats: {len(beats)} (min {MIN_BEATS})")
    if len(beats) > MAX_BEATS:
        warnings.append(f"Many beats: {len(beats)} (soft max {MAX_BEATS})")

    by_type = {}
    for i, b in enumerate(beats):
        if not isinstance(b, dict):
            errors.append(f"Beat {i} is not an object")
            continue
        t = b.get("type")
        by_type[t] = by_type.get(t, 0) + 1
        content = (b.get("content") or "").strip()

        # CHECK beats are special: `question` is the load-bearing field;
        # `content` is just optional framing. If question is present, an
        # empty content is fine (and common — the model often skips it).
        # For EXAMPLE beats, `explanation` plays the same role.
        # For all other types, `content` is required.
        if t == "CHECK":
            if not (b.get("question") or "").strip():
                errors.append(f"Beat {i} CHECK has no question")
            if not (b.get("canonical_answer") or "").strip():
                errors.append(f"Beat {i} CHECK has no canonical_answer")
            if content and len(content) < MIN_CONTENT_CHARS:
                warnings.append(f"Beat {i} ({t}) content is very short")
        elif t == "EXAMPLE":
            has_expl = bool((b.get("explanation") or "").strip())
            has_code = bool((b.get("code") or "").strip())
            if not content and not has_expl and not has_code:
                errors.append(f"Beat {i} EXAMPLE has no content, explanation, or code")
            if not has_expl:
                warnings.append(f"Beat {i} EXAMPLE has no explanation")
        else:
            if not content:
                errors.append(f"Beat {i} ({t}) has empty content")
            elif len(content) < MIN_CONTENT_CHARS:
                warnings.append(f"Beat {i} ({t}) content is very short")

    if by_type.get("EXPOSITION", 0) < MIN_EXPOSITION:
        errors.append(f"Plan needs at least {MIN_EXPOSITION} EXPOSITION beat(s)")
    if by_type.get("CHECK", 0) < MIN_CHECK:
        errors.append(f"Plan needs at least {MIN_CHECK} CHECK beat(s)")
    if by_type.get("RECAP", 0) < 1:
        warnings.append("Plan has no RECAP beat — student won't get a closing summary")

    if errors:
        return _fail(errors, warnings)
    return {
        "validation": "PASS",
        "score": 1.0 if not warnings else 0.85,
        "errors": [],
        "warnings": warnings,
        "validated_at": datetime.utcnow().isoformat(),
    }


def _fail(errors, warnings):
    return {
        "validation": "FAIL",
        "score": 0.0,
        "errors": errors,
        "warnings": warnings,
        "validated_at": datetime.utcnow().isoformat(),
    }
