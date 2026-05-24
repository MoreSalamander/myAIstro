"""
Plan Validator — rule-based gatekeeper for Teacher Aide output.

Same spirit as validation_agent.py at the SOT-write boundary: rejects
malformed or vacuous plans before they get persisted and replayed at
the user. Two layers of checking:

  1. Structural validation — the right beats with required fields
     populated, the right counts, no missing canonical_answers on
     CHECK beats, etc. A failure here BLOCKS persistence.

  2. Grounding validation (optional, when a source is supplied) —
     the Python verification fence at the Teacher-Aide → plan_store
     boundary. Mirrors the advisor-section grounding check (see
     core/grounding_check.py): substantial-token + code-block
     verification of beat content against the source material the
     plan was generated from. The result is attached as a
     `grounding_report` on the returned dict but does NOT FAIL the
     plan — it surfaces low-grounding plans so the UI / consumer
     can flag or refuse them downstream.

Returns:
  {
    "validation":      "PASS" | "FAIL",
    "score":           0..1,
    "errors":          [...],
    "warnings":        [...],
    "validated_at":    ISO-8601,
    "grounding_report": {...}  # only when a source_text was passed
  }
"""

from datetime import datetime
from typing import Dict, Optional

from core.grounding_check import combined_report


MIN_BEATS = 3
MAX_BEATS = 18
MIN_EXPOSITION = 1
MIN_CHECK = 1
MIN_CONTENT_CHARS = 20


def validate_plan(plan: Dict, source_text: Optional[str] = None) -> Dict:
    """
    Gate a Teacher Aide plan before it's persisted.

    Structural checks (always run; failures BLOCK persistence):
      - plan is a JSON object with a `beats` array
      - beat count between MIN_BEATS (3) and MAX_BEATS (18)
      - each beat is a typed object with the per-type required fields:
          * CHECK     → question + canonical_answer (both non-empty)
          * EXAMPLE   → at least one of content / explanation / code
          * other     → non-empty content
      - at least MIN_EXPOSITION EXPOSITION beats
      - at least MIN_CHECK CHECK beats
      - presence of a RECAP beat (warning only)

    Grounding check (runs when `source_text` is supplied; SOFT — does
    NOT block persistence, but the report is returned so the caller
    can surface low-grounding plans or refuse them at the next gate):
      - concatenates each beat's user-visible content fields
        (content, explanation, canonical_answer) and verifies the
        substantial-token / code-block subset against `source_text`
        using core.grounding_check.combined_report. This is the
        Python verification fence at the Teacher-Aide → plan_store
        boundary, mirroring the advisor-section gate at the
        Notebook-save boundary.

    Returns a `{validation, score, errors, warnings, validated_at,
    grounding_report?}` dict.
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

    # Optional Python grounding check against the source the plan was
    # generated from. Soft validation — we attach the report but don't
    # fail the plan. The caller decides what to do with low-grounding
    # plans (the Classroom controller currently saves them and lets the
    # UI surface a warning chip; future tighter modes could refuse to
    # persist below some ratio threshold).
    grounding_report = None
    if source_text:
        # Concatenate the user-visible content from every beat. We
        # check that combined text against the source rather than
        # per-beat so a beat with only "ok" or short prose isn't
        # individually flagged for low token count — the question is
        # whether the plan as a whole stayed inside its source.
        combined_text = "\n\n".join(
            "\n".join(filter(None, [
                (b.get("content") or "").strip(),
                (b.get("explanation") or "").strip(),
                (b.get("canonical_answer") or "").strip(),
                (b.get("code") or "").strip(),
            ]))
            for b in beats
            if isinstance(b, dict)
        )
        grounding_report = combined_report(combined_text, source_text)
        if grounding_report["overall_ratio"] < 0.5:
            warnings.append(
                f"Plan grounding is low (overall_ratio="
                f"{grounding_report['overall_ratio']}) — beats may include "
                f"material not present in the source. "
                f"Ungrounded sample: {grounding_report['text']['ungrounded_sample'][:5]}"
            )

    result = {
        "validation": "PASS",
        "score": 1.0 if not warnings else 0.85,
        "errors": [],
        "warnings": warnings,
        "validated_at": datetime.utcnow().isoformat(),
    }
    if grounding_report is not None:
        result["grounding_report"] = grounding_report
    return result


def _fail(errors, warnings):
    return {
        "validation": "FAIL",
        "score": 0.0,
        "errors": errors,
        "warnings": warnings,
        "validated_at": datetime.utcnow().isoformat(),
    }
