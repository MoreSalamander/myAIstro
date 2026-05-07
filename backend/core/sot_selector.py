"""
Pragmatic SOT retrieval for the advisor.

Strategy (v1, deterministic — no embeddings):
1. If the query mentions a course code (e.g. BE101) or a week ("week 2"),
   filter SOT to matching entries. This is the most common case for
   queries like "write me a study guide for BE101 week 2".
2. Otherwise, score every entry by keyword overlap against
   summary + key_concepts + lesson title and keep the top N.
3. If nothing scores, fall back to all entries (capped) so the model
   still has something to work with.

v2 plan (per project memory): swap (2) for vector similarity search.
"""

import json
import os
import re
from typing import Dict, List, Optional


SOT_FILE = "memory_store.json"

MAX_BY_METADATA = 12     # course/week filter is precise; allow more
MAX_BY_KEYWORDS = 6      # keyword overlap is fuzzier; keep tighter


# Stopwords are intentionally aggressive: words that appear in nearly every
# learner query ("study", "lesson", "explain", "week") would otherwise
# overwhelm the keyword score.
STOPWORDS = {
    # 2-char filler
    "is", "in", "on", "at", "to", "of", "or", "an", "as", "be", "by",
    "do", "go", "if", "it", "me", "my", "no", "so", "us", "we",
    # 3+ char filler
    "the", "and", "for", "with", "from", "that", "this", "what", "when",
    "where", "who", "why", "how", "have", "are", "you", "can", "your",
    "all", "any", "not", "but", "make", "give", "tell", "need", "want",
    "should", "would", "could", "explain", "show", "study", "guide",
    "lesson", "lessons", "week", "course", "topic", "topics", "about",
    "between", "differences", "difference",
}


def select_relevant_entries(query: str) -> List[Dict]:
    sot = _load_sot()
    if not sot:
        return []

    course = _find_course(query)
    week = _find_week(query)

    if course or week:
        filtered = [
            e for e in sot
            if (not course or (e.get("course") or "").lower() == course.lower())
            and (not week or _normalize_week(e.get("week")) == week)
        ]
        if filtered:
            return filtered[:MAX_BY_METADATA]

    # Tokens of 2+ chars so HTML/code shorthand like "ul", "ol", "id"
    # survives. Stopwords list filters the 2-char filler ("is", "of", etc.).
    tokens = [
        t for t in re.findall(r"[A-Za-z]{2,}", query.lower())
        if t not in STOPWORDS
    ]
    if not tokens:
        return []

    scored = []
    for e in sot:
        haystack = " ".join([
            e.get("lesson") or "",
            e.get("summary") or "",
            " ".join(e.get("key_concepts") or []),
        ]).lower()
        # Word-boundary match so "ol" doesn't spuriously hit "control",
        # while still matching tokens inside tag wrappers like "<ol>".
        score = sum(
            1 for t in tokens
            if re.search(rf"\b{re.escape(t)}\b", haystack)
        )
        if score > 0:
            scored.append((score, e))

    scored.sort(key=lambda x: -x[0])
    return [e for _, e in scored[:MAX_BY_KEYWORDS]]


def _load_sot() -> List[Dict]:
    if not os.path.exists(SOT_FILE):
        return []
    with open(SOT_FILE) as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


def _find_course(query: str) -> Optional[str]:
    m = re.search(r"\b([A-Z]{2,5}\d{1,4})\b", query)
    return m.group(1) if m else None


def _find_week(query: str) -> Optional[str]:
    m = re.search(r"\b(?:week|wk|w)\s*(\d{1,3})\b", query, re.IGNORECASE)
    return m.group(1) if m else None


def _normalize_week(week_value) -> Optional[str]:
    if week_value is None:
        return None
    digits = re.sub(r"\D", "", str(week_value))
    return digits or None
