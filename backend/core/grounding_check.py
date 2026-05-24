"""
Grounding check — Python verification that LLM-generated text stays
anchored to its source material.

Used by the layers below raw_text that need verification but were
previously running on prompt-only grounding:

  - Advisor section output (verified against its source SOT entry
    when saved to the Notebook; see api/notebook_controller.py)
  - Teacher Aide plan output (verified against its source — either
    a SOT entry or an advisor section — when persisted; see
    agents/plan_validator.py)

Mirrors validation_agent.py's role at the SOT-write boundary. The
philosophy: prompt-only grounding is fragile (we've observed inversion
errors and subtle rewording), so every persistent layer derived from
the SOT carries a Python check that verifies what the LLM produced is
actually present in its declared source.

Two complementary check modes:

  check_text_grounding   — substantial tokens (4+ chars, alphanumeric,
                           not stopwords) checked against source.
                           A rough "is this even about this material?"
                           ratio.

  check_code_grounding   — backticked / fenced code blocks checked
                           against source. Code is the highest-
                           confidence ground-truth signal — variable
                           names, function names, syntax should match
                           the source verbatim.

Both return a report dict with `ratio` (0.0-1.0) and a small sample of
ungrounded items for diagnostic surfacing in the UI.
"""

import re
from typing import Dict, List


# Tokens shorter than this are too generic to count as evidence.
# Matches the LOOSE_TOKEN_MIN used in validation_agent.py.
LOOSE_TOKEN_MIN = 4

# Words that even at 4+ chars are too common to count as topical signal.
# These would otherwise inflate the "grounded" count without telling us
# anything about whether the LLM actually stayed on-topic.
TOKEN_STOPWORDS = {
    # Pronouns / determiners
    "this", "that", "these", "those", "what", "when", "where", "which",
    "would", "could", "should", "their", "they", "them", "your", "ours",
    # Conjunctions / prepositions
    "with", "from", "into", "onto", "than", "then", "also", "such",
    "about", "after", "before", "between", "under", "above", "below",
    "over", "through", "during", "while", "because", "even", "still",
    # Generic verbs
    "have", "make", "made", "take", "took", "give", "gave", "come", "came",
    "want", "need", "like", "used", "using", "based", "called",
    # Filler adjectives / adverbs
    "more", "most", "some", "many", "much", "very", "well", "only", "just",
    "back", "down", "same", "other", "another", "each", "every", "both",
    # Common nouns that say nothing about topic
    "thing", "things", "stuff", "part", "parts", "side", "case", "cases",
    "time", "times", "way", "ways", "kind", "sort", "type", "types",
}


def check_text_grounding(text: str, source_text: str) -> Dict:
    """
    Return a grounding report for `text` against `source_text`.

    Approach: extract substantial alphanumeric tokens (lowercased,
    4+ chars, not in TOKEN_STOPWORDS) from `text`, then count how
    many appear in `source_text` (case-insensitive substring match).

    Returned shape:
      {
        "kind":             "text",
        "total_tokens":     int,
        "grounded_tokens":  int,
        "ratio":            float,    # grounded / total, or 1.0 if total == 0
        "ungrounded_sample": [str],   # up to 10 unique examples
      }

    Empty input → ratio 1.0 (nothing to be wrong about). Empty source
    with non-empty text → ratio 0.0 (everything is ungrounded).
    """
    tokens = _extract_substantial_tokens(text)
    if not tokens:
        return _empty_text_report()

    src_lower = source_text.lower() if source_text else ""
    if not src_lower:
        return {
            "kind": "text",
            "total_tokens": len(tokens),
            "grounded_tokens": 0,
            "ratio": 0.0,
            "ungrounded_sample": _dedupe_first_n(tokens, 10),
        }

    grounded = 0
    ungrounded: List[str] = []
    for t in tokens:
        if t in src_lower:
            grounded += 1
        else:
            ungrounded.append(t)

    total = len(tokens)
    return {
        "kind": "text",
        "total_tokens": total,
        "grounded_tokens": grounded,
        "ratio": round(grounded / total, 3) if total else 1.0,
        "ungrounded_sample": _dedupe_first_n(ungrounded, 10),
    }


def check_code_grounding(text: str, source_text: str) -> Dict:
    """
    Return a grounding report for code snippets inside `text` against
    `source_text`. Catches the failure mode where the LLM was told
    "quote code verbatim" and instead paraphrased.

    Counts each backticked snippet and each fenced code block as one
    snippet. A snippet is "grounded" if:
      - inline (`...`): the full snippet appears as a substring of source
      - fenced (```...```): at least half the non-empty lines appear
        verbatim in source (allows trivial whitespace/formatting drift)

    Returned shape:
      {
        "kind":             "code",
        "total_snippets":   int,
        "grounded_snippets": int,
        "ratio":            float,
        "ungrounded_sample": [str],  # up to 5 short previews
      }
    """
    if not text:
        return _empty_code_report()

    # Inline `code` — atomic substring match
    inline = re.findall(r"`([^`\n]+)`", text)
    # Fenced ```code blocks``` — multi-line, allow language tag after fence
    fenced = re.findall(r"```[\w-]*\n(.*?)```", text, re.DOTALL)
    snippets = [s for s in (inline + fenced) if s.strip()]

    if not snippets:
        return _empty_code_report()

    src_lower = (source_text or "").lower()
    if not src_lower:
        return {
            "kind": "code",
            "total_snippets": len(snippets),
            "grounded_snippets": 0,
            "ratio": 0.0,
            "ungrounded_sample": [_preview(s) for s in snippets[:5]],
        }

    grounded = 0
    ungrounded: List[str] = []
    for snippet in snippets:
        s = snippet.strip().lower()
        if s in src_lower:
            grounded += 1
            continue
        # Multi-line fallback: count line-level matches
        lines = [ln.strip() for ln in s.split("\n") if ln.strip()]
        if lines:
            matched = sum(1 for ln in lines if ln in src_lower)
            if matched * 2 >= len(lines):  # at least half the lines match
                grounded += 1
                continue
        ungrounded.append(snippet)

    total = len(snippets)
    return {
        "kind": "code",
        "total_snippets": total,
        "grounded_snippets": grounded,
        "ratio": round(grounded / total, 3) if total else 1.0,
        "ungrounded_sample": [_preview(s) for s in ungrounded[:5]],
    }


def combined_report(text: str, source_text: str) -> Dict:
    """
    Run both checks and return a combined report. Convenience for
    callers (notebook controller, plan validator) that just want one
    summary per piece.

    Returned shape:
      {
        "text": <check_text_grounding result>,
        "code": <check_code_grounding result>,
        "overall_ratio": float,   # weighted: 70% text + 30% code
      }
    """
    text_report = check_text_grounding(text, source_text)
    code_report = check_code_grounding(text, source_text)
    return {
        "text": text_report,
        "code": code_report,
        "overall_ratio": round(
            0.7 * text_report["ratio"] + 0.3 * code_report["ratio"], 3
        ),
    }


# =========================================================
# INTERNAL HELPERS
# =========================================================
def _extract_substantial_tokens(text: str) -> List[str]:
    """
    Lowercase alphanumeric tokens of LOOSE_TOKEN_MIN+ chars that
    aren't generic stopwords. Returns them in document order with
    duplicates preserved — duplicate references to the same term in
    the text should count multiple times (a section that mentions
    "useState" five times is more about useState than one that
    mentions it once).
    """
    if not text:
        return []
    raw = re.findall(rf"[a-zA-Z][a-zA-Z0-9_]{{{LOOSE_TOKEN_MIN - 1},}}", text)
    out = []
    for r in raw:
        lower = r.lower()
        if lower in TOKEN_STOPWORDS:
            continue
        out.append(lower)
    return out


def _dedupe_first_n(items: List[str], n: int) -> List[str]:
    """Deduplicate preserving order, cap at n."""
    seen = set()
    out = []
    for it in items:
        if it in seen:
            continue
        seen.add(it)
        out.append(it)
        if len(out) >= n:
            break
    return out


def _preview(snippet: str, max_len: int = 60) -> str:
    """First line of a snippet, capped at max_len chars."""
    first_line = snippet.strip().split("\n", 1)[0]
    return (first_line[: max_len - 1] + "…") if len(first_line) > max_len else first_line


def _empty_text_report() -> Dict:
    return {
        "kind": "text",
        "total_tokens": 0,
        "grounded_tokens": 0,
        "ratio": 1.0,
        "ungrounded_sample": [],
    }


def _empty_code_report() -> Dict:
    return {
        "kind": "code",
        "total_snippets": 0,
        "grounded_snippets": 0,
        "ratio": 1.0,
        "ungrounded_sample": [],
    }
