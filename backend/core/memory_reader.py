import json
import os
from typing import List, Dict

MEMORY_FILE = "memory_store.json"


def retrieve_from_memory(query: str) -> List[Dict]:
    """
    ======================================================
    MEMORY READER (v2)
    ======================================================

    Reads validated entries from memory_store.json and
    returns those whose `summary` overlaps with any token
    in the query.

    Falls back to an empty list if the store is missing
    or unreadable.
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
