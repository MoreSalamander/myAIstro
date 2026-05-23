"""
Judge Agent — deterministic richness scorer for the audit pipeline.

Original design used mistral as an LLM-as-judge. In practice the model
returned 10/10 for nearly every summary regardless of measurable
quality differences, which defeats the purpose: the audit pipeline
needs to be able to TELL which summarization captured more of the
lesson, so the richer one stays canonical.

This implementation drops the LLM and scores deterministically on the
five dimensions that make a summary richer:

    score = grounded_kc   × 5   −  ungrounded_kc   × 2
          + grounded_defs × 3   −  ungrounded_defs × 1
          + code_blocks   × 2
          + min(summary_len, 800) × 0.05

The signed grounding terms are the system's opinion about
hallucination encoded in math: items that appear in the raw lesson
EARN points; items that don't COST points. A summary that pads with
concepts the lesson never mentions can't beat one that stays anchored,
no matter how long or rich it reads. Code blocks are unsigned (no
"hallucinated code" failure mode in practice — code is either copied
verbatim or absent). Summary length has diminishing returns and caps
at 800 chars so a wall of text can't win.

Properties:
  - Pure function. Same entry → same score every call.
  - No Ollama dependency, no network, no model drift.
  - Higher score = richer summary.

The score is uncapped — a value of "good enough" isn't meaningful;
only the RELATIVE ordering between the active versions of a lesson
group matters. The audit agent archives whichever scores lowest.
"""

from typing import Dict


def score_entry(entry: Dict) -> float:
    """
    Return a numeric richness score for one SOT entry. Higher = richer.
    Pure deterministic — no LLM, no I/O.
    """
    summary = entry.get("summary") or ""
    concepts = entry.get("key_concepts") or []
    defs = entry.get("definitions") or []
    code = entry.get("code_blocks") or []
    raw = (entry.get("raw_text") or "").lower()

    if not summary.strip():
        return 0.0

    score = 0.0
    # Concept richness — grounded concepts are highly rewarded, ungrounded
    # concepts are actively penalized. Prior version awarded len(concepts)
    # * 5 + grounded * 2 (so ungrounded concepts still earned +5). That
    # makes the audit cycle indifferent to hallucination at best, and at
    # worst rewards summaries that pad with invented terms.
    #
    # New formula: grounded × 5 wins, ungrounded × −2 loses. Net effect:
    # an audit version with 10 grounded + 0 ungrounded scores 50, while
    # 5 grounded + 5 ungrounded scores 25 − 10 = 15. The richer-AND-
    # grounded version is the only path to a high score.
    #
    # Fallback: if raw_text is empty (legacy entries pre-raw-capture)
    # we can't measure grounding, so fall back to flat concept count so
    # those entries aren't unfairly penalized.
    if concepts and raw:
        grounded = sum(1 for c in concepts if (c or "").lower() in raw)
        ungrounded = len(concepts) - grounded
        score += grounded * 5.0
        score += ungrounded * (-2.0)
    else:
        score += len(concepts) * 5.0
    # Definition depth — same grounding-weighted treatment. A definition's
    # "term" half should appear in the raw lesson; defs that invent terms
    # the lesson never used are paraphrase-injection failures.
    if defs and raw:
        def _term(d):
            if isinstance(d, dict):
                return (d.get("term") or "").lower()
            return str(d).lower()
        grounded_d = sum(1 for d in defs if _term(d) and _term(d) in raw)
        ungrounded_d = len(defs) - grounded_d
        score += grounded_d * 3.0
        score += ungrounded_d * (-1.0)
    else:
        score += len(defs) * 3.0
    # Code preservation
    score += len(code) * 2.0
    # Summary length (cap at 800 chars so a wall of text doesn't win)
    score += min(len(summary), 800) * 0.05

    return round(score, 2)


# Backward-compat shim — the old API took (raw_text, summary). The
# audit agent now calls score_entry(entry) directly, but if any future
# caller still uses the old signature we map it to a minimal entry.
def score_summary(raw_text: str, summary: str) -> float:
    return score_entry({"raw_text": raw_text, "summary": summary})
