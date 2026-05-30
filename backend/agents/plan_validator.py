"""
Plan Validator — rule-based gatekeeper for Teacher Aide output.

Same spirit as validation_agent.py at the SOT-write boundary: rejects
malformed or vacuous plans before they get persisted and replayed at
the user. Two layers of checking:

  1. Structural validation — the right beats with required fields
     populated, the right counts, MC CHECK beats have valid
     options + correct_index + explanation, etc. A failure here
     BLOCKS persistence.

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

import re
from datetime import datetime
from typing import Dict, Optional

from core.grounding_check import combined_report


MIN_BEATS = 3
MAX_BEATS = 18
MIN_EXPOSITION = 1
# CHECK count matters more in MC world — every CHECK is a gradebook
# signal, and at least 2 per plan gives the gradebook enough to
# distinguish "got it" from "lucky one-shot."
MIN_CHECK = 2
MIN_CONTENT_CHARS = 20

# Options that look like the model leaked label prefixes ("A.", "(1)",
# "Option 2:", "- "). The frontend renders A/B/C/D at display time, so
# any of these in the stored option text is a bug — strip-or-reject.
_OPTION_LABEL_PREFIX_RE = __import__("re").compile(
    r"^\s*(?:[A-D][.)\]:]|\(?\d+[.)\]:]|Option\s+\d|[-*]\s)",
    __import__("re").IGNORECASE,
)


def validate_plan(
    plan: Dict,
    source_text: Optional[str] = None,
    mastery_goals: Optional[list] = None,
) -> Dict:
    """
    Gate a Teacher Aide plan before it's persisted.

    Structural checks (always run; failures BLOCK persistence):
      - plan is a JSON object with a `beats` array
      - beat count between MIN_BEATS (3) and MAX_BEATS (18)
      - each beat is a typed object with the per-type required fields:
          * CHECK     → question + options (3-5 unique strings) +
                        valid correct_index + explanation
          * EXAMPLE   → at least one of content / explanation / code
          * other     → non-empty content
      - at least MIN_EXPOSITION EXPOSITION beats
      - at least MIN_CHECK CHECK beats
      - presence of a RECAP beat (warning only)

    Grounding check (runs when `source_text` is supplied; SOFT — does
    NOT block persistence, but the report is returned so the caller
    can surface low-grounding plans or refuse them at the next gate):
      - concatenates each beat's user-visible content fields
        (content, explanation, code, plus CHECK question + options)
        and verifies the substantial-token / code-block subset against `source_text`
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
            # MC schema: options array (3-5) + valid correct_index + explanation
            options = b.get("options")
            if not isinstance(options, list):
                errors.append(f"Beat {i} CHECK has no options array")
            else:
                if len(options) < 3 or len(options) > 5:
                    errors.append(
                        f"Beat {i} CHECK options length {len(options)} "
                        f"(must be 3-5)"
                    )
                empty = [j for j, o in enumerate(options) if not (isinstance(o, str) and o.strip())]
                if empty:
                    errors.append(f"Beat {i} CHECK has empty option(s) at {empty}")
                # Distractor-quality heuristic: same-text options give the
                # question away (model produced a duplicate). Case-insensitive
                # exact-match dedup catches the common "Foo" / "foo" failure.
                lowered = [o.strip().lower() for o in options if isinstance(o, str)]
                if len(set(lowered)) < len(lowered):
                    errors.append(f"Beat {i} CHECK has duplicate options")
                # Forbidden non-answers — these are always bad MC distractors
                # and the prompt explicitly tells the model not to use them.
                forbidden = {
                    "none of the above", "all of the above", "it depends",
                    "nothing happens", "maybe", "i'm not sure", "i am not sure",
                }
                bad = [o for o in lowered if o in forbidden]
                if bad:
                    errors.append(f"Beat {i} CHECK uses forbidden option(s) {bad}")
                # Option-label leakage: "A. foo", "(1) bar", "Option 2: baz"
                # — the frontend adds labels; stored options must be bare.
                labeled = [o for o in options if isinstance(o, str) and _OPTION_LABEL_PREFIX_RE.match(o)]
                if labeled:
                    errors.append(
                        f"Beat {i} CHECK has label-prefixed option(s) — "
                        f"options must be bare answer text: {labeled[:1]}"
                    )
                # Question-as-option: the model sometimes puts the question
                # itself at index 0 and the real answers in the remaining
                # slots. Catch the most common shape: an option that ends
                # with a question mark or is byte-identical to the question.
                q = (b.get("question") or "").strip()
                if q:
                    q_lower = q.lower()
                    q_leak = [o for o in options if isinstance(o, str) and (
                        o.strip().lower() == q_lower
                        or (o.strip().endswith("?") and len(o.strip()) > 10)
                    )]
                    if q_leak:
                        errors.append(
                            f"Beat {i} CHECK has question-shaped option(s) — "
                            f"options must be answers, not questions"
                        )
            ci = b.get("correct_index")
            if not isinstance(ci, int):
                errors.append(f"Beat {i} CHECK correct_index is not an int")
            elif isinstance(options, list) and (ci < 0 or ci >= len(options)):
                errors.append(
                    f"Beat {i} CHECK correct_index {ci} out of range for "
                    f"{len(options)} options"
                )
            if not (b.get("explanation") or "").strip():
                errors.append(f"Beat {i} CHECK has no explanation")
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

    # Mastery-goals coverage check. When the source entry has
    # deterministically-extracted mastery goals (canonical `## Mastery
    # Goals` pattern), the prompt directs the model to make CHECKs
    # cover them. The validator's role here is defense-in-depth: if
    # coverage is poor, emit a warning so the auto-retry path gets a
    # second chance to produce a covering plan.
    #
    # Soft validation, not hard fail — the LLM may paraphrase a goal in
    # the question (which is fine), making exact-match coverage hard to
    # detect. A token-overlap signal is the right granularity.
    mastery_coverage_report = None
    if mastery_goals and isinstance(mastery_goals, list) and len(mastery_goals) > 0:
        check_beats = [b for b in beats if isinstance(b, dict) and (b.get("type") or "").upper() == "CHECK"]
        if check_beats:
            mastery_coverage_report = _mastery_coverage(check_beats, mastery_goals)
            if mastery_coverage_report["covered_goals"] < min(2, len(mastery_goals)):
                warnings.append(
                    f"Mastery-goal coverage low: only "
                    f"{mastery_coverage_report['covered_goals']}/"
                    f"{len(mastery_goals)} goals are referenced by CHECK beats. "
                    f"Plan may drift from the curriculum's intended assessment focus."
                )

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
        def _beat_text(b: dict) -> str:
            parts = [
                (b.get("content") or "").strip(),
                (b.get("explanation") or "").strip(),
                (b.get("code") or "").strip(),
            ]
            # MC CHECK fields — options + question all need to ground against
            # the source so distractors don't smuggle in unrelated concepts.
            if (b.get("type") or "").upper() == "CHECK":
                parts.append((b.get("question") or "").strip())
                opts = b.get("options")
                if isinstance(opts, list):
                    parts.extend(o.strip() for o in opts if isinstance(o, str) and o.strip())
            return "\n".join(filter(None, parts))

        combined_text = "\n\n".join(
            _beat_text(b) for b in beats if isinstance(b, dict)
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
    if mastery_coverage_report is not None:
        result["mastery_coverage_report"] = mastery_coverage_report
    return result


def _fail(errors, warnings):
    return {
        "validation": "FAIL",
        "score": 0.0,
        "errors": errors,
        "warnings": warnings,
        "validated_at": datetime.utcnow().isoformat(),
    }


def _mastery_coverage(check_beats: list, mastery_goals: list) -> dict:
    """
    Token-overlap signal between CHECK beats and mastery goals.

    A goal is "covered" if at least one CHECK beat contains 2+ of the
    goal's substantial tokens (length >= 4, lowercased). This catches
    paraphrased coverage (the LLM rephrasing the goal as a question)
    without requiring exact substring match.

    Returns:
      {
        "total_goals": int,
        "covered_goals": int,
        "per_goal": [{goal, covered: bool, covering_beat_index: int|None}]
      }
    """
    LOOSE_TOKEN_MIN = 4
    MIN_OVERLAP = 2

    def tokens(s: str) -> set:
        return {
            t for t in re.split(r"[^a-z0-9]+", s.lower())
            if len(t) >= LOOSE_TOKEN_MIN
        }

    beat_tokens = []
    for b in check_beats:
        parts = [
            (b.get("question") or ""),
            (b.get("explanation") or ""),
        ]
        opts = b.get("options")
        if isinstance(opts, list):
            parts.extend(o for o in opts if isinstance(o, str))
        beat_tokens.append(tokens(" ".join(parts)))

    per_goal = []
    for g in mastery_goals:
        if not isinstance(g, str) or not g.strip():
            continue
        gtoks = tokens(g)
        if not gtoks:
            per_goal.append({"goal": g, "covered": False, "covering_beat_index": None})
            continue
        covering = None
        for i, btoks in enumerate(beat_tokens):
            if len(gtoks & btoks) >= MIN_OVERLAP:
                covering = i
                break
        per_goal.append({
            "goal": g,
            "covered": covering is not None,
            "covering_beat_index": covering,
        })

    return {
        "total_goals": len(per_goal),
        "covered_goals": sum(1 for g in per_goal if g["covered"]),
        "per_goal": per_goal,
    }
