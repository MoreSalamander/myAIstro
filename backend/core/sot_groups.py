"""
SOT grouping helpers + archive store.

A "lesson group" is all entries — active and archived — that share the
same (course, week, lesson) key. Multiple active entries are now allowed:
v1, v2, v3 may coexist. The CANONICAL entry of a group is the oldest
active entry; every external consumer of the SOT (graph, list, advisor,
quiz, vault) reads canonical only. Newer active entries are stored and
scored by the audit pipeline but are invisible to the rest of the app.

The audit agent works against the full active set, so consumers should
filter explicitly via `canonical_entries(...)`.
"""

import json
import os
import tempfile
from datetime import datetime
from threading import Lock


_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOT_FILE = os.path.join(_BACKEND_DIR, "memory_store.json")
ARCHIVE_FILE = os.path.join(_BACKEND_DIR, "archived_store.json")

_sot_lock = Lock()
_archive_lock = Lock()


# =========================================================
# GROUPING
# =========================================================
def _group_key(e: dict) -> tuple:
    """The (course, week, lesson) tuple used to group related entries."""
    return (e.get("course") or "", e.get("week") or "", e.get("lesson") or "")


def group_active(entries: list) -> dict:
    """
    Map (course, week, lesson) → list of active entries sorted oldest-first.

    The oldest-first sort is what makes `canonical_entries` return the
    canonical (i.e., the original ingest plus any audit-generated
    versions — but the original always sorts first because it has the
    earliest created_at timestamp).
    """
    out: dict = {}
    for e in entries:
        out.setdefault(_group_key(e), []).append(e)
    for k in out:
        out[k].sort(key=lambda e: e.get("created_at") or "")
    return out


def canonical_entries(entries: list) -> list:
    """
    One entry per group — the oldest active per (course, week, lesson).

    This is what every external SOT consumer reads. Audit-generated
    v2/v3 alternates remain in the active store and are scored by the
    audit pipeline, but they're invisible through this function.
    """
    groups = group_active(entries)
    return [g[0] for g in groups.values() if g]


def canonical_for(entries: list, course, week, lesson):
    """
    Return the canonical entry for a specific lesson key, or None.

    Convenience wrapper around `canonical_entries` for the common
    "I have a (course, week, lesson) key, give me the one entry"
    lookup pattern.
    """
    for e in canonical_entries(entries):
        if (
            e.get("course") == course
            and e.get("week") == week
            and e.get("lesson") == lesson
        ):
            return e
    return None


# =========================================================
# ACTIVE STORE — read / write
# =========================================================
def load_sot() -> list:
    """
    Load the active SOT from disk. Returns [] if the file is missing
    or unparseable rather than raising — the read path tolerates a
    fresh install or a once-in-a-blue-moon corrupted file.
    """
    if not os.path.exists(SOT_FILE):
        return []
    try:
        with open(SOT_FILE, "r") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def atomic_save_sot(data: list) -> None:
    """
    Replace the SOT file with `data` atomically. Lock-protected so
    concurrent saves from the audit loop and the ingest path can't
    interleave their writes.
    """
    with _sot_lock:
        _atomic_save(SOT_FILE, data)


# =========================================================
# ARCHIVE STORE — read / write
# =========================================================
def load_archive() -> list:
    """
    Load the archive store. Same fail-open semantics as `load_sot` —
    missing or corrupt file returns []. Used by both the audit loop's
    recent-archive count and the Archives panel's read endpoint.
    """
    if not os.path.exists(ARCHIVE_FILE):
        return []
    try:
        with open(ARCHIVE_FILE, "r") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def move_to_archive(entry: dict, score, reason: str) -> None:
    """
    Append `entry` to the archive store with score + reason metadata.
    Caller is responsible for removing the entry from the active SOT
    (typically by `atomic_save_sot(remaining_entries)` immediately
    before this call). The two-step (remove + archive) is intentional
    so the active store reflects the post-archive state atomically.
    """
    with _archive_lock:
        archived = load_archive()
        copy = dict(entry)
        copy["archived_at"] = datetime.utcnow().isoformat()
        copy["archive_score"] = score
        copy["archive_reason"] = reason
        archived.append(copy)
        _atomic_save(ARCHIVE_FILE, archived)


# =========================================================
# INTERNAL — atomic-write primitive
# =========================================================
def _atomic_save(path: str, data) -> None:
    """
    Write `data` to `path` atomically — temp file in the same
    directory, then `os.replace` to swap it into place. The replace
    is atomic on POSIX (rename(2)), so a crash mid-write leaves the
    old file intact rather than producing a half-written JSON blob.

    Why same-directory temp: `os.replace` only guarantees atomicity
    when source and destination are on the same filesystem. Using
    `tempfile.mkstemp(dir=dirpath)` keeps the temp on the same
    partition as the target.

    On any failure path the temp file is cleaned up to avoid
    leaving stray `.sot-*.tmp` files in the data directory.
    """
    dirpath = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".sot-", suffix=".tmp", dir=dirpath)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise
