"""
Grading rules — turn raw gradebook records into per-lesson grades,
mastery state, and Quiz extra-credit application.

Pure functions, no I/O. Read records (from gradebook_store), return
aggregate dicts. Phase 4's gradebook UI consumes these directly.

The aggregation rules in one paragraph:
  - Classroom CHECKs are grouped by session. Per session: count
    first-try-correct / total CHECKs in that session. The lesson's
    base score is the BEST session score. This matches the "best
    attempt counts" principle (a retake that goes well rewards you;
    a retake that goes badly doesn't hurt).
  - Mastery (boolean): exists at least one session where every CHECK
    was answered correctly on first try, with at least
    MASTERY_MIN_CHECKS CHECKs to count (so a 1-CHECK fluke doesn't
    grant mastery).
  - Quiz attempts contribute extra credit. The best single Quiz
    score on this lesson, scaled by QUIZ_BONUS_MAX_PCT / 100, is
    added to the base. Cap at 100 — the bonus can lift you over a
    poor Classroom session but can't push past a perfect score.
  - Final grade: min(100, lesson_base + quiz_bonus).

What this module does NOT do:
  - No tier names (bronze/silver/gold) — those are UI choices that
    map from the numeric grade and the mastery boolean in Phase 4.
  - No persistence — only reads records that came from
    gradebook_store and returns dicts.
  - No averaging across lessons — there's no overall GPA concept
    here; that's a Phase 4 UI rollup.
"""

from typing import Dict, Iterable, List, Optional


# Extra credit ceiling: a perfect Quiz attempt adds at most this
# many percentage points to the lesson's Classroom grade. Cap is
# applied AFTER addition (final = min(100, base + bonus)).
QUIZ_BONUS_MAX_PCT = 20

# Need at least this many CHECKs in a session for that session to
# count toward mastery. A single-CHECK lesson where you got lucky
# isn't mastery; a lesson with 4 CHECKs all first-try-correct is.
MASTERY_MIN_CHECKS = 2


def _safe_int(v, default: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _classroom_records_for(records: Iterable[dict], lesson_event_id: str) -> List[dict]:
    return [
        r for r in records
        if r.get("type") == "classroom_check"
        and r.get("lesson_event_id") == lesson_event_id
    ]


def _quiz_records_for(records: Iterable[dict], lesson_event_id: str) -> List[dict]:
    return [
        r for r in records
        if r.get("type") == "quiz_attempt"
        and r.get("lesson_event_id") == lesson_event_id
    ]


def _best_session_score(classroom_records: List[dict]) -> Dict:
    """
    Group classroom_check records by session_id and find the best
    session. "Best" = highest first_try_correct / total_in_session
    ratio. Ties broken by total (more CHECKs is a more informative
    success).

    Returns:
      {
        "score": float (0.0-100.0, or 0.0 if no sessions),
        "first_try_correct": int,
        "total": int,
        "session_id": str | None,
      }
    """
    by_session: Dict[str, List[dict]] = {}
    for r in classroom_records:
        sid = r.get("session_id") or "_unknown"
        by_session.setdefault(sid, []).append(r)

    best = {"score": 0.0, "first_try_correct": 0, "total": 0, "session_id": None}
    for sid, recs in by_session.items():
        first_try_recs = [r for r in recs if r.get("first_try")]
        total = len(first_try_recs)
        if total == 0:
            continue
        passed = sum(1 for r in first_try_recs if r.get("passed"))
        ratio = passed / total
        score = round(ratio * 100, 1)
        # New best: strictly higher score, OR same score with more
        # CHECKs (more informative).
        if (
            score > best["score"]
            or (score == best["score"] and total > best["total"])
        ):
            best = {
                "score": score,
                "first_try_correct": passed,
                "total": total,
                "session_id": sid,
            }
    return best


def _is_mastery(classroom_records: List[dict]) -> bool:
    """
    Exists a session in which every first-try CHECK was passed AND
    that session had at least MASTERY_MIN_CHECKS CHECKs.
    """
    by_session: Dict[str, List[dict]] = {}
    for r in classroom_records:
        sid = r.get("session_id") or "_unknown"
        by_session.setdefault(sid, []).append(r)

    for sid, recs in by_session.items():
        first_try_recs = [r for r in recs if r.get("first_try")]
        if len(first_try_recs) < MASTERY_MIN_CHECKS:
            continue
        if all(r.get("passed") for r in first_try_recs):
            return True
    return False


def _best_quiz_score(quiz_records: List[dict]) -> Optional[int]:
    if not quiz_records:
        return None
    return max(_safe_int(r.get("score")) for r in quiz_records)


def _quiz_bonus(best_quiz: Optional[int]) -> float:
    if best_quiz is None:
        return 0.0
    # Linear scale: a quiz score of 100 maxes the bonus; 50 gives
    # half; 0 gives nothing. Decimal precision keeps Phase 4 UI
    # rendering honest (no "you gained 0% from your 49/100 quiz").
    return round(best_quiz * QUIZ_BONUS_MAX_PCT / 100.0, 1)


def aggregate_lesson(
    records: Iterable[dict],
    lesson_event_id: str,
) -> Dict:
    """
    Compute the full per-lesson aggregate from the raw record stream.

    Returns:
      {
        "lesson_event_id":      str,
        "course":               str,
        "week":                 str,
        "lesson":               str,
        "classroom_attempts":   int,    # total check_answered ever
        "classroom_sessions":   int,    # distinct sessions touched
        "best_session":         {score, first_try_correct, total, session_id},
        "mastery":              bool,
        "quiz_attempts":        int,
        "best_quiz_score":      int | None,
        "quiz_bonus":           float,  # 0-QUIZ_BONUS_MAX_PCT
        "final_grade":          float,  # 0-100
        "last_attempt_at":      str | None,  # latest ts across both types
      }
    """
    records = list(records)
    classroom = _classroom_records_for(records, lesson_event_id)
    quiz = _quiz_records_for(records, lesson_event_id)

    # Pull lesson identity from the first available record. They
    # should all agree (same lesson_event_id), but we don't enforce.
    identity = classroom[0] if classroom else (quiz[0] if quiz else {})

    best_session = _best_session_score(classroom)
    mastery = _is_mastery(classroom)
    best_quiz = _best_quiz_score(quiz)
    quiz_bonus = _quiz_bonus(best_quiz)
    final = min(100.0, round(best_session["score"] + quiz_bonus, 1))

    distinct_sessions = len({
        r.get("session_id") for r in classroom if r.get("session_id")
    })

    all_ts = [r.get("ts") for r in (classroom + quiz) if r.get("ts")]
    last_attempt = max(all_ts) if all_ts else None

    return {
        "lesson_event_id": lesson_event_id,
        "course": identity.get("course", ""),
        "week": identity.get("week", ""),
        "lesson": identity.get("lesson", ""),
        "classroom_attempts": len(classroom),
        "classroom_sessions": distinct_sessions,
        "best_session": best_session,
        "mastery": mastery,
        "quiz_attempts": len(quiz),
        "best_quiz_score": best_quiz,
        "quiz_bonus": quiz_bonus,
        "final_grade": final,
        "last_attempt_at": last_attempt,
    }


def aggregate_all_lessons(records: Iterable[dict]) -> Dict[str, Dict]:
    """
    Group records by lesson_event_id and return a dict of
    per-lesson aggregates. Records without a lesson_event_id are
    ignored (notebook-derived plans where the underlying SOT entry
    no longer exists — rare but possible).
    """
    records = list(records)
    lesson_ids = {
        r.get("lesson_event_id")
        for r in records
        if r.get("lesson_event_id")
    }
    return {
        lid: aggregate_lesson(records, lid)
        for lid in sorted(lesson_ids)
    }
