"""
Validation Agent — the write-time gate between summarization and the SOT.

A pure-Python function. No LLM, no I/O. Given the raw lesson text and
the summarization output, decides whether the entry is allowed to
persist as a Source of Truth.

Rule checks, in order:

  1. Structural shape — required fields present, summarization dict
     not null. Cheap early-exit if the model returned nothing.
  2. Integrity: not raw JSON — catches the LLM-fallback failure mode
     where a malformed model output dumps its raw JSON into the
     `summary` field instead of producing prose.
  3. Key concepts required on non-trivial lessons — a lesson ≥200
     characters that produced zero key_concepts didn't really get
     extracted.
  4. Substantive summary length — catches the title-only-as-summary
     regression.
  5. Weak prose-grounding heuristic — first-10-words overlap with
     the source. Loose; just produces a warning.
  6. Per-item grounding gate — the strongest defense. Each
     key_concept and each definition's term is checked against the
     raw lesson:
       STRICT match  → kept (substring in raw)
       LOOSE match   → kept (one of its ≥4-char tokens appears in raw)
       DROPPED       → removed before write (hallucinated item)
     If more than GROUNDING_HARD_FAIL_RATIO of items get dropped,
     the whole entry is rejected — at that point the model is
     fabricating more than half the extraction; nothing left is
     trustworthy.

Failures don't write. Drops are surfaced as warnings to the user.
The summary dict is MUTATED to remove dropped items (so downstream
consumers see only grounded material).
"""

import re
from datetime import datetime


# Source-text length above which we expect the LLM to extract key_concepts
# and produce a substantive summary. Below this, looser rules apply.
NONTRIVIAL_SOURCE_CHARS = 200

# Minimum character count for a summary on non-trivial source. Catches the
# regression where the LLM emits the lesson title alone as a "summary".
MIN_SUMMARY_CHARS = 60

# Grounding gate — fraction of key_concepts/definitions that must be at
# least *loosely* grounded in the raw lesson. Higher than this many fail
# the strict + loose check and the whole summary is rejected (the LLM
# hallucinated most of the items, the entry is not safe to persist as
# a Source of Truth).
GROUNDING_HARD_FAIL_RATIO = 0.6

# Token min-length for loose-grounding fallback. Tokens shorter than this
# are too generic to count as evidence ("the", "and", "of", etc.).
LOOSE_TOKEN_MIN = 4


def validate_summary(context: dict):
    """
    ======================================================
    VALIDATION AGENT (v3 - STRUCTURE + INTEGRITY)
    ======================================================

    PURPOSE:
    --------
    Gatekeeper that determines whether a summarization output
    is allowed to be persisted as a Source of Truth entry.

    CHECKS:
        1. structural shape (required fields present)
        2. summary is not raw JSON (catches the JSON-fallback path)
        3. key_concepts present when source is non-trivial
        4. weak grounding overlap with retrieval source_text
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
        return _fail(errors, warnings)

    # -------------------------------------------------
    # STRUCTURE VALIDATION
    # -------------------------------------------------
    required_fields = ["summary", "generated_at"]

    for field in required_fields:
        if field not in summary:
            errors.append(f"Missing field: {field}")

    summary_text = summary.get("summary", "")
    key_concepts = summary.get("key_concepts", [])
    source_text = retrieval.get("source_text", "")

    # -------------------------------------------------
    # INTEGRITY: summary must be prose, not raw JSON
    # -------------------------------------------------
    # When the LLM truncates JSON or fails the contract, the agent's
    # fallback dumps raw model output into `summary`. Catch that here.
    if _looks_like_json_blob(summary_text):
        errors.append("Summary field contains raw JSON, not prose (LLM fallback path)")

    # -------------------------------------------------
    # INTEGRITY: non-trivial lessons must yield key_concepts
    # -------------------------------------------------
    if len(source_text) >= NONTRIVIAL_SOURCE_CHARS and not key_concepts:
        errors.append("Non-trivial lesson produced no key_concepts")

    # -------------------------------------------------
    # INTEGRITY: non-trivial lessons must yield a substantive summary
    # -------------------------------------------------
    summary_len = len(summary_text.strip())
    if (
        len(source_text) >= NONTRIVIAL_SOURCE_CHARS
        and summary_len < MIN_SUMMARY_CHARS
    ):
        errors.append(
            f"Summary is too short to be substantive ({summary_len} chars; "
            f"expected at least {MIN_SUMMARY_CHARS})"
        )

    # -------------------------------------------------
    # GROUNDING (weak heuristic on summary prose)
    # -------------------------------------------------
    src_lower = source_text.lower()
    sum_lower = summary_text.lower()

    if sum_lower and src_lower:
        overlap_found = any(
            word in src_lower for word in sum_lower.split()[:10]
        )
        if not overlap_found:
            warnings.append("Weak grounding signal detected")

    # -------------------------------------------------
    # GROUNDING GATE — per-item check on key_concepts + definitions
    # -------------------------------------------------
    # The prose summary above is too loose to catch a model that invented
    # specific terms or definitions not in the lesson (the "name attribute"
    # hallucination class). This gate inspects each extracted item:
    #
    #   STRICT  — exact substring match against raw lesson (case-insensitive)
    #   LOOSE   — at least one 4+ char token of the item appears in raw
    #   DROPPED — neither holds; the item is hallucinated and removed
    #
    # If the drop rate exceeds GROUNDING_HARD_FAIL_RATIO, the whole entry
    # is rejected — at that point the model is fabricating more than half
    # the extraction and there's no salvageable signal.
    if src_lower:
        dropped_kc, kept_kc, kc_report = _filter_by_grounding(
            key_concepts, src_lower, lambda x: x
        )
        if dropped_kc:
            warnings.append(
                f"Dropped {len(dropped_kc)} ungrounded key_concepts: "
                f"{', '.join(dropped_kc[:5])}"
                + ("…" if len(dropped_kc) > 5 else "")
            )
            summary["key_concepts"] = kept_kc

        defs = summary.get("definitions") or []
        dropped_d, kept_d, d_report = _filter_by_grounding(
            defs, src_lower, _definition_term
        )
        if dropped_d:
            warnings.append(
                f"Dropped {len(dropped_d)} ungrounded definitions: "
                f"{', '.join(dropped_d[:3])}"
                + ("…" if len(dropped_d) > 3 else "")
            )
            summary["definitions"] = kept_d

        # Hard-fail if the model hallucinated the majority of items.
        total_items = len(key_concepts) + len(defs)
        total_dropped = len(dropped_kc) + len(dropped_d)
        if total_items >= 3 and total_dropped / total_items > GROUNDING_HARD_FAIL_RATIO:
            errors.append(
                f"Grounding gate failed: {total_dropped}/{total_items} extracted "
                f"items had no substring or token match in the raw lesson"
            )

        # The full per-item report (`kc_report`, `d_report`) is intentionally
        # not attached to the summary dict — memory_writer cherry-picks
        # fields, so it would be silently discarded. The warnings above
        # already list the dropped items, which is what the audit UI shows.

    # -------------------------------------------------
    # FINAL RESULT
    # -------------------------------------------------
    if errors:
        return _fail(errors, warnings)

    return {
        "validation": "PASS",
        "score": 1 if not warnings else 0.7,
        "errors": [],
        "warnings": warnings,
        "validated_at": datetime.utcnow().isoformat(),
    }


def _definition_term(d) -> str:
    """
    Extract the 'term' half from a definition. Definitions come in two
    historical shapes:
      - String: "term — explanation"  (current summarization output)
      - Dict:   {"term": "...", "definition": "..."}  (legacy / variant)
    Return just the term so we can grounding-check it.
    """
    if isinstance(d, dict):
        return (d.get("term") or "").strip()
    if isinstance(d, str):
        # Split on em-dash, en-dash, colon, hyphen — first segment is the term
        for sep in ("—", "–", ":", " - "):
            if sep in d:
                return d.split(sep, 1)[0].strip()
        return d.strip()
    return ""


def _filter_by_grounding(items, src_lower, extract_key):
    """
    Walk a list of extracted items (key_concepts or definitions). For each
    item, derive a "key" string via extract_key(item) (identity for concepts,
    term-half for definitions). Classify:
      STRICT — key appears as a substring of raw lesson (case-insensitive)
      LOOSE  — at least one 4+ char token of the key appears in raw
      DROPPED — neither holds; item is hallucinated

    Returns (dropped_keys, kept_items, report) where:
      dropped_keys: list[str] of keys that were filtered out
      kept_items: list of items (originals, not keys) preserved
      report: list[{key, status, reason}] for the audit UI
    """
    dropped = []
    kept = []
    report = []
    for item in items:
        key = extract_key(item) if extract_key else str(item)
        if not key or not key.strip():
            # Empty key — silently skip from both sides; not evidence of
            # hallucination, just an empty cell.
            continue
        key_lower = key.lower().strip()
        if key_lower in src_lower:
            kept.append(item)
            report.append({"key": key, "status": "strict"})
            continue
        # Loose pass: split into tokens, drop the short noise words, see if
        # ANY substantive token from the key appears in the source.
        tokens = [
            t for t in re.split(r"[^a-z0-9]+", key_lower)
            if len(t) >= LOOSE_TOKEN_MIN
        ]
        if tokens and any(t in src_lower for t in tokens):
            kept.append(item)
            report.append({"key": key, "status": "loose"})
            continue
        # Neither strict nor loose — drop.
        dropped.append(key)
        report.append({"key": key, "status": "dropped"})
    return dropped, kept, report


def _looks_like_json_blob(text: str) -> bool:
    """
    Detect summaries that are actually raw JSON (the fallback path).
    A real prose summary should not start with { or [, and should not
    contain the structural keys verbatim.
    """
    if not text:
        return False
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        return True
    if '"key_concepts"' in text or '"definitions"' in text:
        return True
    return False


def _fail(errors, warnings):
    return {
        "validation": "FAIL",
        "score": 0,
        "errors": errors,
        "warnings": warnings,
        "validated_at": datetime.utcnow().isoformat(),
    }
