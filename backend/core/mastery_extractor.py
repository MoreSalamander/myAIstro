"""
Deterministic mastery-goals extractor for SOT entries.

Mastery goals are the curriculum-authored "by the end of this lesson
you should be able to ..." list. When present, they're the highest-
signal "what matters in this lesson" — much stronger than anything
an LLM can extract from prose. Downstream surfaces (Classroom CHECK
generation, Quiz prioritization, future spaced-repetition surfacing)
use them as a structural constraint: questions MUST cover the
mastery goals, not arbitrary topics the model picked.

Pure Python, no LLM. Single pattern, conservative on purpose.

The contract:
  - Match the CANONICAL pattern only — a `## Mastery Goals` markdown
    H2 header followed by a list (bulleted, numbered, or bare-line)
  - Extract the list items verbatim from raw_text
  - Return [] if the canonical pattern isn't present

Forward-going strategy: the user is committed to asking the AI tutor
that teaches them each lesson to produce a recap in the canonical
format at the end of every lesson. That means future ingests have
100% coverage via this path.

Backward strategy (for entries that pre-date the canonical
convention): they stay empty. The user can fill them in manually
via the green highlight color (when the highlighter ships in H2+),
or re-ingest the lesson after asking the tutor to generate a
canonical recap for it.

What this extractor explicitly does NOT do (and the reasoning):
  - No "legacy trigger" patterns (e.g. "you've hit all the mastery
    goals"). Those produced false positives that captured trailing
    prose like "for this lesson 🎉" as mastery goals. Better to
    return nothing than to return garbage.
  - No model-assisted extraction. The methodology says "don't let
    the model guess." Pattern-match or return [].
  - No fuzzy boundary detection across paragraphs. The canonical
    pattern is tight enough that boundary detection is trivial
    (next blank line or next markdown header).
"""

import re
from typing import List


# CANONICAL HEADER — matches the markdown shape the user commits to
# using on all forward-going ingests, plus close variants for
# robustness (bold-only, label-with-colon).
#
# Header must be on its own line (preceded by start-of-text or a
# newline; followed by a newline). Prevents matching the phrase
# mid-sentence in conversational text.
_CANONICAL_HEADER_RE = re.compile(
    r"""
    (?:^|\n)                                # line boundary
    \s*                                     # optional leading whitespace
    (?:
        \#{2,6}\s*mastery\s*goals?\s*       # ## Mastery Goals (markdown header)
      | \*\*\s*mastery\s*goals?\s*\*\*      # **Mastery Goals** (bold)
      | mastery\s*goals?\s*:\s*             # Mastery Goals: (label)
    )
    \s*\n                                   # end of header line
    """,
    re.IGNORECASE | re.VERBOSE,
)

# LIST-ITEM PATTERNS. Try bulleted first (most common in canonical
# usage), then numbered. We accept both `-` and `*` bullets.
_BULLETED_ITEM_RE = re.compile(r"^\s*[-*•]\s+(.+?)\s*$", re.MULTILINE)
_NUMBERED_ITEM_RE = re.compile(r"^\s*\d+[.)]\s+(.+?)\s*$", re.MULTILINE)

# BOUNDARY — stop extracting items at the first sign that the
# mastery-goals block has ended. The canonical format means the
# block is tight, so simple boundaries are sufficient:
#   - blank line (paragraph break)
#   - new markdown header
#   - a line that isn't a list item (signals prose resumed)
_BOUNDARY_RE = re.compile(
    r"""
    (?:
        \n\s*\n                             # blank line
      | \n\s*\#{1,6}\s                      # next markdown header
    )
    """,
    re.VERBOSE,
)

# Filters on individual items.
_MIN_ITEM_LEN = 3       # reject empty/near-empty captures
_MAX_ITEM_LEN = 300     # mastery goals are concise; long captures are likely paragraphs


def extract_mastery_goals(raw_text: str) -> List[str]:
    """
    Extract mastery goals from a lesson's raw_text. Returns a list of
    goal strings (one per goal), captured verbatim from the source.
    Returns [] when the canonical pattern isn't present — conservative
    on purpose.
    """
    if not raw_text or not isinstance(raw_text, str):
        return []

    # Find the LAST occurrence of the canonical header. Last (not
    # first) because lessons may mention "mastery goals" in intro
    # prose before the actual closing recap.
    matches = list(_CANONICAL_HEADER_RE.finditer(raw_text))
    if not matches:
        return []

    last_match = matches[-1]
    body = raw_text[last_match.end():]
    body = _clip_to_boundary(body)

    items = _BULLETED_ITEM_RE.findall(body)
    if not items:
        items = _NUMBERED_ITEM_RE.findall(body)

    return _clean_items(items)


def _clip_to_boundary(body: str) -> str:
    """Trim body to the first boundary marker (blank line or new header)."""
    m = _BOUNDARY_RE.search(body)
    if m:
        body = body[: m.start()]
    return body


def _clean_items(items: List[str]) -> List[str]:
    """Strip whitespace, dedupe case-insensitively, filter length."""
    seen = set()
    out: List[str] = []
    for raw in items:
        item = raw.strip()
        if len(item) < _MIN_ITEM_LEN or len(item) > _MAX_ITEM_LEN:
            continue
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out
