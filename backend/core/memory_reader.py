"""
Memory Reader — read-side of the SOT for the legacy `/query` endpoint.

A keyword-overlap retrieval pass over the SOT. NOT the modern advisor
path — the Advisor uses `core/sot_selector.py` for relevance ranking
and reads canonical entries only. This module is kept for the demo
/query endpoint and as the simplest possible reference implementation
of "retrieve from the SOT."

No LLM, no embeddings. Just lowercased token overlap between the
query and each entry's summary.
"""

import json
import os
from typing import List, Dict

MEMORY_FILE = "memory_store.json"


def retrieve_from_memory(query: str) -> List[Dict]:
    """
    Return SOT entries whose summary contains any query token.

    Loose semantics on purpose — the legacy `/query` endpoint wants
    a permissive recall surface, not precision. The Advisor's
    `core/sot_selector.py` is the modern path that ranks for quality.

    Returns [] if the SOT file is missing or unparseable; returns the
    whole SOT if the query is empty.
    """

    if not os.path.exists(MEMORY_FILE):
        return []

    with open(MEMORY_FILE, "r") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            return []

    query_words = [w for w in query.lower().split() if w]
    if not query_words:
        return data

    matches = [
        entry for entry in data
        if any(word in entry.get("summary", "").lower() for word in query_words)
    ]

    return matches
