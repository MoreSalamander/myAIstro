"""
Visitor tracking.

A tiny JSON store that counts page loads, deduped by a per-browser UUID
the frontend generates once and keeps in localStorage. We track:
  - total page loads (every mount of the React app POSTs once)
  - unique browsers (one entry per UUID, with first_seen / last_seen)

This is the right granularity for a personal demo: a friend who refreshes
five times shows up as one unique visitor with count=5.

Storage is a JSON file alongside memory_store.json. Writes use a temp +
rename pattern so a crash mid-write can't corrupt the existing log.
"""

import json
import os
import tempfile
from datetime import datetime
from threading import Lock
from typing import Optional


VISITS_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "visits.json",
)

_write_lock = Lock()


def _empty_state() -> dict:
    return {"total": 0, "uniques": {}}


def _load() -> dict:
    if not os.path.exists(VISITS_FILE):
        return _empty_state()
    try:
        with open(VISITS_FILE, "r") as f:
            data = json.load(f)
        if not isinstance(data, dict) or "uniques" not in data:
            return _empty_state()
        return data
    except (json.JSONDecodeError, OSError):
        return _empty_state()


def _atomic_save(data: dict) -> None:
    dirpath = os.path.dirname(VISITS_FILE)
    fd, tmp_path = tempfile.mkstemp(prefix=".visits-", suffix=".tmp", dir=dirpath)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, VISITS_FILE)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        raise


def record_visit(client_id: Optional[str]) -> dict:
    """
    Append a visit. client_id is the per-browser UUID. If missing or
    empty (e.g., curl from a script), we still bump the total but skip
    the unique tracking — so headless probes don't pollute the unique
    count.

    Returns the post-write stats.
    """
    with _write_lock:
        data = _load()
        data["total"] = int(data.get("total", 0)) + 1
        cid = (client_id or "").strip()
        if cid:
            now = datetime.utcnow().isoformat()
            entry = data["uniques"].get(cid)
            if entry is None:
                data["uniques"][cid] = {
                    "first_seen": now,
                    "last_seen": now,
                    "count": 1,
                }
            else:
                entry["last_seen"] = now
                entry["count"] = int(entry.get("count", 0)) + 1
                data["uniques"][cid] = entry
        _atomic_save(data)
        return summarize(data)


def get_visit_stats() -> dict:
    return summarize(_load())


def summarize(data: dict) -> dict:
    uniques = data.get("uniques", {}) or {}
    return {
        "total": int(data.get("total", 0)),
        "unique": len(uniques),
    }
