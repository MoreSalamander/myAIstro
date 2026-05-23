"""
Audit Agent — continuous background loop that re-summarizes lessons
periodically and rotates the canonical SOT toward richer, more-grounded
versions over time.

Per cycle (every AUDIT_INTERVAL_SECONDS), the agent performs ONE action.
The decision tree:

  1. Walk 3-node groups, oldest-first:
       - If the group's lesson has been churn-suppressed
         (CHURN_MAX_ARCHIVES+ archives in the last CHURN_WINDOW_HOURS),
         leave it alone. Try the next group.
       - Otherwise: score all three versions with the Judge. If the
         bottom-two scores sit within SCORE_GAP_EPSILON of each other,
         declare "stable" and leave the group alone. Otherwise archive
         the lowest-scoring entry and return.

  2. If no actionable 3-node group: walk smaller groups, picking the
     one whose newest version is oldest. Skip churn-suppressed
     lessons. Re-summarize the chosen group's raw_text and append the
     new version as the next version number in that group.

  3. If everything is either stable or churn-suppressed: noop.

The "oldest active node" in any group remains the canonical entry that
every other consumer (graph, list, advisor, quiz, vault, classroom)
reads. Newer versions are invisible downstream until an older one is
eventually archived, naturally rotating the canonical toward the
best-scoring surviving summary.

Two guards prevent the audit from churning unproductively:

  - Stable-group guard (SCORE_GAP_EPSILON): if the model has converged
    on a lesson, the audit can't tell three near-identical versions
    apart. Archive nothing; let other lessons take the tick.
  - Churn suppression (CHURN_MAX_ARCHIVES / CHURN_WINDOW_HOURS): if a
    lesson has been archived repeatedly recently without quality
    trajectory, stop trying. The lesson is presumed converged; let it
    sit until the time window slides.
"""

import asyncio
import sys
import traceback
import uuid
from datetime import datetime, timedelta

from agents.judge_agent import score_entry
from agents.summarization_agent import summarize_lesson
from agents.validation_agent import validate_summary
from core.sot_groups import (
    atomic_save_sot,
    group_active,
    load_archive,
    load_sot,
    move_to_archive,
)


AUDIT_INTERVAL_SECONDS = 15 * 60  # 15 minutes between cycles

# Score-gap epsilon for the "stable" guard. If the two lowest-scoring
# versions of a 3-node group are within this many points of each other,
# the audit has no signal — archiving the "lowest" would just delete a
# version that's effectively identical to the next one up. Skip the
# group entirely; let other lessons take the tick.
#
# 5.0 is calibrated to the new signed-grounding judge's quality units:
#   +5  one extra grounded key_concept
#   +3  one extra grounded definition
#   +2  one extra code block
#   +7  one concept flipping from ungrounded (-2) to grounded (+5)
# A gap of < 5 means the difference between "lowest" and "next-lowest"
# is at most one unit of any real improvement — not worth burning a
# 15-30s llama3:8b cycle to act on. (Initial value was 1.0; raised
# after observing the audit churn lessons with 1-14 point gaps where
# every newly-generated version landed below v2 — re-rolling wasn't
# actually improving anything.)
SCORE_GAP_EPSILON = 5.0

# Lessons that have been archived this many times in the last
# CHURN_WINDOW_HOURS are presumed to be in a degenerate cycle — the
# audit keeps creating near-identical new versions and archiving them
# without ever displacing the canonical. Stop trying. Re-ingestion
# (which writes a new entry with a fresh timestamp) will reset the
# window naturally; explicit re-ingest is the right user-intent signal
# to restart auditing a stable lesson.
#
# Threshold of 2: one archive is normal audit progress (the audit found
# a genuinely weaker version and removed it); a second archive within
# 24h on the same lesson is strong evidence that we're cycling rather
# than improving. (Started at 3; lowered after observing lessons
# accumulating 2 archives in tight succession without any quality
# trajectory.)
CHURN_MAX_ARCHIVES = 2
CHURN_WINDOW_HOURS = 24


def _log(msg: str) -> None:
    print(f"[audit] {msg}", file=sys.stderr, flush=True)


# =========================================================
# PUBLIC ENTRYPOINTS
# =========================================================
def run_one_step() -> dict:
    """
    Execute exactly one audit action. Returns a dict describing what
    happened — used by both the background loop (for logging) and the
    /api/audit/run-once manual-trigger endpoint.

    Decision tree:
      1. Walk 3-node groups oldest-first. Try score+archive on each.
         If a group is "stable" (top scores within SCORE_GAP_EPSILON),
         skip it and fall through to the next 3-node group. Without
         this fallthrough the loop gets pinned forever on the same
         stable group, never making progress on anything else.
      2. If every 3-node group was stable (or there are none), expand a
         smaller group by generating a new version — but skip lessons
         that have been "churned" CHURN_MAX_ARCHIVES+ times in the last
         CHURN_WINDOW_HOURS. Those lessons are converged; re-running
         summarization will just produce another near-identical version
         that gets archived next cycle, wasting llama3:8b compute.
    """
    data = load_sot()
    groups = group_active(data)

    # Load churn counts once — used by BOTH the 3-node archive step and
    # the 2-node create_version step. A lesson that hit the churn cap is
    # excluded from every audit action until the 24h window expires
    # naturally (or the user re-ingests, which puts a fresh entry in the
    # group with a new created_at and resets the natural ordering).
    recent_counts = _recent_archive_counts(CHURN_WINDOW_HOURS)

    # ---- Step 1: score+archive any non-stable, non-churning 3-node group ----
    three_node_groups = [
        (key, entries)
        for key, entries in groups.items()
        if len(entries) >= 3
    ]
    three_node_groups.sort(key=lambda kv: kv[1][0].get("created_at") or "")

    stable_skipped = 0
    churning_3node_skipped = 0
    last_stable_result = None
    for key, entries in three_node_groups:
        if recent_counts.get(key, 0) >= CHURN_MAX_ARCHIVES:
            # Group is at 3 nodes but the lesson is in churn-suppression.
            # Leaving 3 active nodes is harmless — `canonical_entries()`
            # picks the oldest, so downstream is unaffected. We'd rather
            # leave the surplus version sitting there than burn another
            # archive on a lesson the model can't actually improve.
            churning_3node_skipped += 1
            _log(
                f"  churn-suppress: {key[0]}/{key[2]} has "
                f"{recent_counts[key]} archives in {CHURN_WINDOW_HOURS}h; "
                f"leaving 3-node group untouched"
            )
            continue
        result = _score_and_archive(data, key, entries)
        if result.get("action") != "stable":
            return result
        # This group is converged — record it and try the next group.
        stable_skipped += 1
        last_stable_result = result

    # ---- Step 2: pick a smaller group to expand, skipping churning ones ----
    candidates = []
    churning_skipped = 0
    for key, entries in groups.items():
        if len(entries) >= 3:
            continue
        if recent_counts.get(key, 0) >= CHURN_MAX_ARCHIVES:
            churning_skipped += 1
            continue
        newest_created = entries[-1].get("created_at") or ""
        candidates.append((len(entries), newest_created, key, entries))

    if not candidates:
        # Nothing to do. This is the GOOD steady state — every lesson is
        # either converged at 3 nodes (stable) or churning (skipped),
        # so the audit loop has nothing meaningful to add. Return a
        # rich noop so the UI can surface the situation.
        reason_parts = []
        if stable_skipped:
            reason_parts.append(f"{stable_skipped} stable 3-node group(s)")
        if churning_3node_skipped:
            reason_parts.append(
                f"{churning_3node_skipped} churning 3-node group(s) left alone"
            )
        if churning_skipped:
            reason_parts.append(
                f"{churning_skipped} churning 2-node lesson(s) suppressed"
            )
        reason = "; ".join(reason_parts) or "no lessons in SOT"
        return {
            "action": "noop",
            "reason": reason,
            "stable_skipped": stable_skipped,
            "churning_3node_skipped": churning_3node_skipped,
            "churning_skipped": churning_skipped,
            # Pass the last stable result through so the UI can show the
            # exact scores that triggered the skip — useful for "why is
            # nothing happening?" debugging.
            "last_stable": last_stable_result,
        }

    candidates.sort(key=lambda c: (c[0], c[1]))
    _, _, key, entries = candidates[0]
    return _create_new_version(data, key, entries)


def _recent_archive_counts(hours: int) -> dict:
    """
    Return {(course, week, lesson): count} of archives in the last N hours.

    Reads `archived_store.json` directly. Fails open: if the archive
    can't be read for any reason, return an empty dict so the audit
    doesn't get blocked. The cost of a wrong-direction failure here is
    just one wasted cycle.
    """
    try:
        archive = load_archive()
    except Exception:
        traceback.print_exc()
        return {}
    cutoff = datetime.utcnow() - timedelta(hours=hours)
    counts: dict = {}
    for e in archive:
        ts = e.get("archived_at")
        if not ts:
            continue
        try:
            t = datetime.fromisoformat(ts)
        except (TypeError, ValueError):
            continue
        if t < cutoff:
            continue
        key = (e.get("course"), e.get("week"), e.get("lesson"))
        counts[key] = counts.get(key, 0) + 1
    return counts


async def audit_loop() -> None:
    """
    Forever loop, started by the FastAPI lifespan hook. Sleeps first, so
    we don't slam Ollama the moment uvicorn starts up. Each step runs in
    a worker thread to avoid blocking the asyncio event loop on Ollama.
    """
    _log(f"audit loop started — interval {AUDIT_INTERVAL_SECONDS}s")
    while True:
        try:
            await asyncio.sleep(AUDIT_INTERVAL_SECONDS)
            result = await asyncio.to_thread(run_one_step)
            _log(f"step: {result.get('action')} — {result}")
        except asyncio.CancelledError:
            _log("audit loop cancelled")
            raise
        except Exception:
            traceback.print_exc()


# =========================================================
# ACTIONS
# =========================================================
def _create_new_version(data: list, key: tuple, entries: list) -> dict:
    course, week, lesson = key
    source = entries[0]  # oldest entry — same raw_text across the group
    raw_text = source.get("raw_text") or ""
    if not raw_text.strip():
        return {
            "action": "skipped",
            "reason": "no raw_text on source entry",
            "lesson": lesson,
        }

    _log(f"creating new version for {course}/{week}/{lesson} "
         f"(currently {len(entries)} active node{'s' if len(entries) != 1 else ''})")

    summary = summarize_lesson(raw_text)
    validation = validate_summary({
        "retrieval": {"source_text": raw_text},
        "summarization": summary,
    })
    if validation.get("validation") != "PASS":
        _log(f"  validation FAIL: {validation.get('errors')}")
        return {
            "action": "failed",
            "reason": "validation_failed",
            "lesson": lesson,
            "errors": validation.get("errors"),
        }

    next_version = max((e.get("version") or 1) for e in entries) + 1
    new_entry = {
        "event_id": str(uuid.uuid4()),
        "trace_id": source.get("trace_id"),
        "course": course,
        "week": week,
        "lesson": lesson,
        "raw_text": raw_text,
        "summary": summary.get("summary"),
        "key_concepts": summary.get("key_concepts"),
        "definitions": summary.get("definitions"),
        "code_blocks": summary.get("code_blocks"),
        "validation_score": validation.get("score"),
        "created_at": datetime.utcnow().isoformat(),
        "version": next_version,
        "audit_generated": True,
    }
    data.append(new_entry)
    atomic_save_sot(data)

    _log(f"  appended v{next_version} ({new_entry['event_id'][:8]})")
    return {
        "action": "created_version",
        "lesson": lesson,
        "course": course,
        "week": week,
        "version": next_version,
        "event_id": new_entry["event_id"],
    }


def _score_and_archive(data: list, key: tuple, entries: list) -> dict:
    course, week, lesson = key
    _log(f"scoring {len(entries)} nodes for {course}/{week}/{lesson}")

    scored = []
    for e in entries:
        score = score_entry(e)
        scored.append((score, e))
        _log(f"  v{e.get('version', '?')} ({(e.get('event_id') or '')[:8]}) -> {score}")

    # Lowest score wins (loses); tiebreak by newest version (preserve older)
    scored.sort(key=lambda t: (t[0], -(t[1].get("version") or 0)))
    lowest_score, lowest_entry = scored[0]

    # Stable-group guard: if the bottom two scores are within
    # SCORE_GAP_EPSILON, the audit can't tell them apart with any
    # confidence. Archiving "the lowest" would just delete one of two
    # effectively-identical versions, and the next cycle would generate
    # a new near-identical version to replace it — the degenerate loop
    # we're trying to avoid. Skip and let another lesson take this tick.
    all_scores_payload = [
        {"event_id": e.get("event_id"), "version": e.get("version"), "score": s}
        for s, e in scored
    ]
    if len(scored) >= 2:
        gap = scored[1][0] - scored[0][0]
        if gap < SCORE_GAP_EPSILON:
            _log(
                f"  stable: bottom-two gap {gap:.2f} < {SCORE_GAP_EPSILON} — "
                f"skip archive ({lesson})"
            )
            return {
                "action": "stable",
                "lesson": lesson,
                "course": course,
                "week": week,
                "gap": round(gap, 3),
                "epsilon": SCORE_GAP_EPSILON,
                "all_scores": all_scores_payload,
            }

    surviving = [e for e in data if e.get("event_id") != lowest_entry.get("event_id")]
    atomic_save_sot(surviving)
    move_to_archive(lowest_entry, lowest_score, reason="lowest_score")

    _log(f"  archived v{lowest_entry.get('version')} (score {lowest_score})")
    return {
        "action": "archived",
        "lesson": lesson,
        "course": course,
        "week": week,
        "archived_event_id": lowest_entry.get("event_id"),
        "archived_version": lowest_entry.get("version"),
        "archived_score": lowest_score,
        "all_scores": all_scores_payload,
    }
