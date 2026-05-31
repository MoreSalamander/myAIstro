"""
Classroom endpoints.

Public read endpoints:
  GET  /api/classroom/plans?event_id=...     — list plans for a lesson
  GET  /api/classroom/plan/{plan_id}         — fetch a single plan
  GET  /api/classroom/sessions?event_id=...  — list sessions (used by V3)

Write-protected (X-Write-Password required when env var is set):
  POST /api/classroom/plan                   — generate a fresh plan (NDJSON stream)
  POST /api/classroom/session/start          — start a session from a plan
  POST /api/classroom/session/answer         — submit a CHECK answer; returns score + correction
  POST /api/classroom/session/advance        — mark current beat completed, move pointer
  POST /api/classroom/session/end            — close out the session
"""

import json
import os
import sys
import traceback
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.auth import require_write_password
from core.classroom_store import (
    list_plans_for_event,
    list_sessions_for_event,
    load_plan,
    load_session,
    save_plan,
    start_session as start_session_record,
    update_session,
)
from core.gradebook_store import record_check as gradebook_record_check
from core.notebook_store import get_note
from agents.plan_validator import validate_plan
from agents.teacher_agent import stream_question_answer
from agents.teacher_aide_agent import parse_plan, stream_plan
from core.grounding_check import combined_report
from core.highlights_store import list_highlights_for_lesson_by_color


router = APIRouter()


def _load_sot():
    """Reuse the same SOT file as the rest of the app."""
    sot_file = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "memory_store.json",
    )
    if not os.path.exists(sot_file):
        return []
    try:
        with open(sot_file, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def _find_entry(event_id: str) -> Optional[dict]:
    for e in _load_sot():
        if e.get("event_id") == event_id:
            return e
    return None


def _resolve_plan_source_text(plan: dict) -> str:
    """
    Resolve the grounding source for a Plan — the material the
    Teacher should ground its runtime answers against.

    Two paths, mirroring the two ways a plan can be generated:
      - If the plan was generated from a Notebook section
        (`derived_from_notebook_id` + `derived_from_section_index`
        are set), return that section's content.
      - Otherwise the plan was generated from a SOT entry directly
        (legacy path), so look up the entry by `lesson_event_id`
        and return its raw_text.

    Returns "" if nothing can be resolved (in which case the
    raise-hand endpoint should refuse to answer rather than ground
    against nothing).
    """
    # Notebook-derived plans: walk back through the notebook store
    nid = plan.get("derived_from_notebook_id")
    sidx = plan.get("derived_from_section_index")
    if nid is not None and sidx is not None:
        from core.notebook_store import get_note
        note = get_note(nid)
        if note:
            pieces = note.get("pieces") or []
            if 0 <= sidx < len(pieces):
                piece = pieces[sidx]
                if piece.get("kind") == "section":
                    return piece.get("content") or ""

    # SOT-derived plans: look up the source entry's raw_text
    eid = plan.get("lesson_event_id")
    if eid:
        entry = _find_entry(eid)
        if entry:
            return entry.get("raw_text") or ""

    return ""


def _log(msg: str) -> None:
    print(f"[classroom] {msg}", file=sys.stderr, flush=True)


# Lines shorter than this are debris (single words, stray punctuation,
# residual whitespace after stripping a bullet marker). Lines longer than
# this are paragraphs, not goal statements — the model can't reliably
# bind a CHECK question to a 300-character multi-clause passage and the
# validator's token-sanity check will reject the binding as inconsistent.
_GOAL_MIN_CHARS = 8
_GOAL_MAX_CHARS = 300


def _normalize_goal_line(line: str) -> str:
    """
    Clean one line from a user highlight into a goal-shaped string.
    Strips leading bullet/number markers ("- ", "* ", "• ", "1. ", "2) ")
    and surrounding whitespace. Returns "" if the line is empty after
    cleanup so the caller can drop it.
    """
    s = (line or "").strip()
    if not s:
        return ""
    # Strip leading bullet markers — users often highlight bulleted lists.
    for marker in ("- ", "* ", "• ", "· ", "·"):
        if s.startswith(marker):
            s = s[len(marker):].lstrip()
            break
    # Strip leading "1. " / "2) " / "10) " numbered list markers.
    i = 0
    while i < len(s) and s[i].isdigit():
        i += 1
    if i > 0 and i < len(s) and s[i] in ".)" and (i + 1) < len(s) and s[i + 1] == " ":
        s = s[i + 2 :].lstrip()
    return s.strip()


def _green_highlights_as_goals(green_highlights: list) -> list:
    """
    Convert green-highlight records into goal-shaped strings. A single
    highlight may span multiple lines (the user dragged across a whole
    recap block) — in that case each non-empty line becomes its own
    goal. This matches user intent: a 3-bullet recap highlight should
    produce 3 testable goals, not one 160-character blob the model
    can't bind a single CHECK to.

    Returns the cleaned list (may be empty). Order preserved by
    highlight creation order, then by line order within a highlight.
    """
    out = []
    for h in green_highlights:
        raw = (h.get("text") or "").strip()
        if not raw:
            continue
        for line in raw.splitlines():
            cleaned = _normalize_goal_line(line)
            if not cleaned:
                continue
            if len(cleaned) < _GOAL_MIN_CHARS:
                continue
            if len(cleaned) > _GOAL_MAX_CHARS:
                # Too long to use as a goal — the model can't bind a
                # single targeted CHECK to a paragraph. The user can
                # still see the highlight in the UI; it just doesn't
                # promote to a mastery goal.
                _log(
                    f"skip green-highlight goal: line is {len(cleaned)} chars "
                    f"(max {_GOAL_MAX_CHARS}). Highlight in smaller pieces "
                    f"to promote to mastery goals."
                )
                continue
            out.append(cleaned)
    return out


def _merged_mastery_goals(event_id: str, base_goals) -> list:
    """
    Authority hierarchy for mastery goals at Classroom-plan time:

      1. Green user-highlights for this lesson  (strongest — manual assertion)
      2. Deterministic mastery_goals extracted from the lesson recap

    This function unions both, with deterministic goals first (they
    came from the curriculum's own ## Mastery Goals block) and green
    highlights appended after (the user's "I want this tested" mark).
    Multi-line highlights are split into one goal per line; per-line
    hygiene (bullet-marker stripping, length filters) keeps weird
    selections from poisoning the goal list.

    Duplicates are removed by case-insensitive stripped text — so a
    user who green-highlights a passage that's already in the canonical
    recap doesn't double-count it.

    Why merge here (controller) instead of in teacher_aide_agent: the
    teacher_aide_agent stays a pure entry→plan function and doesn't
    need to know that highlights exist. The controller is the right
    place to compose data sources before handing the assembled view
    to the agent.

    Returns a list of strings (the mastery-goal texts), never None.
    """
    base = list(base_goals or [])
    if not event_id:
        return base
    try:
        green = list_highlights_for_lesson_by_color(event_id, "green")
    except Exception:
        # Highlights are a soft enhancement — never break plan
        # generation because the highlights file is corrupt.
        return base

    seen = {g.strip().lower() for g in base if isinstance(g, str) and g.strip()}
    merged = list(base)
    for goal in _green_highlights_as_goals(green):
        key = goal.lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(goal)
    return merged


# =========================================================
# READS
# =========================================================
@router.get("/classroom/plans")
def list_plans_endpoint(event_id: str):
    return list_plans_for_event(event_id)


@router.get("/classroom/plan/{plan_id}")
def get_plan_endpoint(plan_id: str):
    plan = load_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    return plan


@router.get("/classroom/sessions")
def list_sessions_endpoint(event_id: str):
    return list_sessions_for_event(event_id)


# =========================================================
# PLAN GENERATION (streaming NDJSON)
# =========================================================
class PlanRequest(BaseModel):
    event_id: str


@router.post(
    "/classroom/plan",
    dependencies=[Depends(require_write_password)],
)
def generate_plan_endpoint(req: PlanRequest):
    entry = _find_entry(req.event_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Lesson not found")

    # H2e: union deterministic mastery_goals + green highlights for
    # this lesson. We mutate a shallow copy of entry so the agent and
    # validator see the merged set without touching the SOT on disk.
    merged_goals = _merged_mastery_goals(req.event_id, entry.get("mastery_goals"))
    enriched_entry = dict(entry)
    enriched_entry["mastery_goals"] = merged_goals

    def _attempt(emit_progress):
        """One generation attempt. Returns (plan_or_None, validation_dict)."""
        raw_full = ""
        for evt in stream_plan(enriched_entry):
            if evt["type"] == "raw_chunk":
                emit_progress()
            elif evt["type"] == "raw_done":
                raw_full = evt["text"]
            elif evt["type"] == "model_start":
                pass  # caller-side already signaled
            elif evt["type"] == "error":
                return None, {"validation": "FAIL", "errors": [evt["message"]]}
        plan = parse_plan(raw_full, enriched_entry)
        # Pass the merged mastery_goals to the validator so plans that
        # fail to cover them (including user-highlighted goals) get
        # flagged for the auto-retry path. Empty list when the entry
        # pre-dates the canonical convention AND has no highlights;
        # the check becomes a no-op in that case.
        return plan, validate_plan(plan, mastery_goals=merged_goals)

    def stream():
        try:
            yield json.dumps({"type": "start", "lesson_event_id": req.event_id}) + "\n"
            yield json.dumps({"type": "model_start"}) + "\n"

            progress_buf = []
            def emit_progress():
                progress_buf.append(1)

            plan, validation = _attempt(emit_progress)
            for _ in progress_buf:
                yield json.dumps({"type": "progress"}) + "\n"
            progress_buf.clear()

            # Auto-retry once on validation failure — most failures are
            # transient model variance (e.g. it produced 3 options instead
            # of 4 on a CHECK, or omitted correct_index). A single fresh
            # attempt almost always succeeds.
            if validation.get("validation") != "PASS":
                _log(
                    f"plan validation FAIL on attempt 1 — retrying. "
                    f"errors={validation.get('errors')}"
                )
                yield json.dumps({"type": "model_start", "attempt": 2}) + "\n"
                plan, validation = _attempt(emit_progress)
                for _ in progress_buf:
                    yield json.dumps({"type": "progress"}) + "\n"

            if validation.get("validation") != "PASS":
                _log(
                    f"plan validation FAIL on attempt 2 — giving up. "
                    f"errors={validation.get('errors')}"
                )
                yield json.dumps({
                    "type": "error",
                    "message": "Generated plan failed validation after retry",
                    "errors": validation.get("errors"),
                }) + "\n"
                return

            plan = save_plan(plan)
            for beat in plan.get("beats", []):
                yield json.dumps({"type": "beat", "beat": beat}) + "\n"
            yield json.dumps({"type": "done", "plan_id": plan["plan_id"]}) + "\n"
        except Exception as e:
            traceback.print_exc()
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# =========================================================
# PLAN  ←  NOTEBOOK SECTION
# =========================================================
# Generate a classroom lesson plan from one section of a saved Notebook
# entry, instead of from a raw SOT entry. The advisor-pipeline already
# shaped that section pedagogically (overview + key concepts + defs +
# code samples drawn from one SOT lesson); the Teacher Aide now picks
# up that shaped material and breaks it into beats.
#
# This is the second leg of the new curation chain:
#   raw_text → SOT entry → advisor section (in Notebook) → teacher plan
# Every layer below raw_text is Python-verified at its boundary:
#   - SOT entry boundary       : validation_agent.py
#   - Notebook-save boundary   : notebook_controller._attach_grounding_reports
#   - Teacher-plan boundary    : validate_plan(plan, source_text=section_content)
# =========================================================
class PlanFromSectionRequest(BaseModel):
    notebook_id: str
    section_index: int


@router.post(
    "/classroom/plan-from-section",
    dependencies=[Depends(require_write_password)],
)
def generate_plan_from_section_endpoint(req: PlanFromSectionRequest):
    """
    Streaming NDJSON endpoint, same event vocabulary as
    /api/classroom/plan, but the source material is one Notebook
    section instead of a raw SOT entry. The resulting plan carries
    a `derived_from_notebook_id` / `derived_from_section_index`
    field so the UI can show provenance.

    Validation: plans generated here go through `validate_plan(plan,
    source_text=section.content)` — the new Python grounding pass.
    The plan's beat content is verified against the section it was
    generated from, with the grounding_report attached to the saved
    plan. Soft validation (warning only); structural failures still
    block.
    """
    note = get_note(req.notebook_id)
    if not note:
        raise HTTPException(status_code=404, detail="Notebook entry not found")

    pieces = note.get("pieces") or []
    if req.section_index < 0 or req.section_index >= len(pieces):
        raise HTTPException(
            status_code=404,
            detail=f"Section index {req.section_index} out of range (note has {len(pieces)} pieces)",
        )
    section = pieces[req.section_index]
    if section.get("kind") != "section":
        raise HTTPException(
            status_code=400,
            detail=f"Piece at index {req.section_index} is kind={section.get('kind')!r}, not 'section'",
        )

    # Build a synthetic "entry" the existing teacher_aide_agent can
    # consume. We put the section's markdown content in raw_text so
    # the Teacher Aide treats it as the primary lesson material;
    # identity fields (course/week/lesson/event_id) carry through so
    # the resulting plan stays referentially tied to the canonical
    # SOT lesson the section was derived from.
    section_content = section.get("content") or ""
    section_event_id = section.get("event_id")

    # H2e: pull the SOT entry's deterministic mastery_goals AND merge
    # in this lesson's green highlights. The notebook-section path
    # historically had no mastery_goals (synthetic_entry sets none),
    # so wiring this here is a strict upgrade — section-derived plans
    # now respect the same authority hierarchy as SOT-entry plans.
    sot_entry = _find_entry(section_event_id) if section_event_id else None
    base_goals = (sot_entry or {}).get("mastery_goals") or []
    merged_goals = _merged_mastery_goals(section_event_id, base_goals)

    synthetic_entry = {
        "event_id": section_event_id,
        "course": section.get("course"),
        "week": section.get("week"),
        "lesson": section.get("lesson"),
        "raw_text": section_content,
        # Structured fields intentionally empty — the section content
        # already organizes the material, and the Teacher Aide's
        # prompt is robust to empty structured fields (it reads
        # raw_text as the source of truth).
        "summary": "",
        "key_concepts": [],
        "definitions": [],
        "code_blocks": [],
        # Carry the merged mastery_goals so the Teacher Aide's prompt
        # gets the CHECK-binding constraint here too.
        "mastery_goals": merged_goals,
    }

    def _attempt(emit_progress):
        raw_full = ""
        for evt in stream_plan(synthetic_entry):
            if evt["type"] == "raw_chunk":
                emit_progress()
            elif evt["type"] == "raw_done":
                raw_full = evt["text"]
            elif evt["type"] == "model_start":
                pass
            elif evt["type"] == "error":
                return None, {"validation": "FAIL", "errors": [evt["message"]]}
        plan = parse_plan(raw_full, synthetic_entry)
        # Pass BOTH source_text (for grounding pass) AND mastery_goals
        # (for coverage check). The section path uniquely runs both.
        return plan, validate_plan(
            plan,
            source_text=section_content,
            mastery_goals=merged_goals,
        )

    def stream():
        try:
            yield json.dumps({
                "type": "start",
                "lesson_event_id": section.get("event_id"),
                "derived_from_notebook_id": req.notebook_id,
                "derived_from_section_index": req.section_index,
            }) + "\n"
            yield json.dumps({"type": "model_start"}) + "\n"

            progress_buf = []
            def emit_progress():
                progress_buf.append(1)

            plan, validation = _attempt(emit_progress)
            for _ in progress_buf:
                yield json.dumps({"type": "progress"}) + "\n"
            progress_buf.clear()

            # Same single-retry policy as the SOT-entry path — most
            # validation failures here are transient model variance.
            if validation.get("validation") != "PASS":
                _log(
                    f"section-plan validation FAIL on attempt 1 — retrying. "
                    f"errors={validation.get('errors')}"
                )
                yield json.dumps({"type": "model_start", "attempt": 2}) + "\n"
                plan, validation = _attempt(emit_progress)
                for _ in progress_buf:
                    yield json.dumps({"type": "progress"}) + "\n"

            if validation.get("validation") != "PASS":
                _log(
                    f"section-plan validation FAIL on attempt 2 — giving up. "
                    f"errors={validation.get('errors')}"
                )
                yield json.dumps({
                    "type": "error",
                    "message": "Generated plan failed validation after retry",
                    "errors": validation.get("errors"),
                }) + "\n"
                return

            # Annotate the plan with provenance + the new grounding
            # report (if validate_plan attached one). Persisted with
            # the plan so the Classroom UI can surface "generated from
            # saved note ‘X’" and show the grounding ratio.
            plan["derived_from_notebook_id"] = req.notebook_id
            plan["derived_from_section_index"] = req.section_index
            if validation.get("grounding_report"):
                plan["grounding_report"] = validation["grounding_report"]

            plan = save_plan(plan)
            for beat in plan.get("beats", []):
                yield json.dumps({"type": "beat", "beat": beat}) + "\n"
            yield json.dumps({
                "type": "done",
                "plan_id": plan["plan_id"],
                "grounding_report": plan.get("grounding_report"),
                "warnings": validation.get("warnings", []),
            }) + "\n"
        except Exception as e:
            traceback.print_exc()
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# =========================================================
# SESSIONS
# =========================================================
class SessionStartRequest(BaseModel):
    plan_id: str


@router.post(
    "/classroom/session/start",
    dependencies=[Depends(require_write_password)],
)
def session_start_endpoint(req: SessionStartRequest):
    plan = load_plan(req.plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    session = start_session_record(plan)
    return {"session": session, "plan": plan}


class SessionAnswerRequest(BaseModel):
    session_id: str
    beat_id: str
    selected_index: int


@router.post(
    "/classroom/session/answer",
    dependencies=[Depends(require_write_password)],
)
def session_answer_endpoint(req: SessionAnswerRequest):
    """
    Deterministic MC grading. The student picked an option; we compare
    its index to the plan's canonical correct_index. No LLM call, no
    grader variance — instant feedback.

    Session events still get written (`check_answered` with selected_index
    + correct_index + first_try flag) so the Phase 2 gradebook can read
    them as raw signal.
    """
    session = load_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    plan = load_plan(session.get("plan_id"))
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found for session")

    beat = next(
        (b for b in plan.get("beats", []) if b.get("beat_id") == req.beat_id),
        None,
    )
    if not beat or beat.get("type") != "CHECK":
        raise HTTPException(status_code=400, detail="Beat is not a CHECK")

    options = beat.get("options") or []
    correct_index = beat.get("correct_index")
    if not isinstance(correct_index, int) or correct_index < 0 or correct_index >= len(options):
        raise HTTPException(
            status_code=409,
            detail="Beat has no valid correct_index — plan is malformed",
        )
    if req.selected_index < 0 or req.selected_index >= len(options):
        raise HTTPException(
            status_code=400,
            detail=f"selected_index {req.selected_index} out of range for {len(options)} options",
        )

    passed = req.selected_index == correct_index
    score = 100 if passed else 0
    explanation = beat.get("explanation") or ""

    # First-try detection — true iff this beat hasn't been answered in
    # this session yet. Lays the rails for Phase 2's gradebook mastery
    # signal without needing any UI change.
    prior = [
        e for e in (session.get("events") or [])
        if e.get("type") == "check_answered" and e.get("beat_id") == req.beat_id
    ]
    first_try = not prior

    event = {
        "type": "check_answered",
        "beat_id": req.beat_id,
        "selected_index": req.selected_index,
        "correct_index": correct_index,
        "passed": passed,
        "score": score,
        "first_try": first_try,
    }
    session.setdefault("events", []).append(event)

    # Update summary stats. checks_total counts attempts; checks_passed
    # tracks how many distinct CHECK beats the student ended up getting
    # right (first-try OR retry).
    stats = session.setdefault(
        "summary_stats",
        {"checks_total": 0, "checks_passed": 0, "avg_check_score": 0.0},
    )
    stats["checks_total"] = int(stats.get("checks_total", 0)) + 1
    if passed:
        stats["checks_passed"] = int(stats.get("checks_passed", 0)) + 1
    n = stats["checks_total"]
    prev_avg = float(stats.get("avg_check_score", 0.0))
    stats["avg_check_score"] = round(prev_avg + (score - prev_avg) / n, 2)

    update_session(session)

    # Phase 2 gradebook layer — append the check record to the canonical
    # event log. Wrapped in try/except: gradebook writes must never fail
    # a CHECK submit. Losing one record is acceptable; surfacing an
    # internal-storage error to the student mid-lesson is not.
    try:
        source_lesson = plan.get("source_lesson") or {}
        gradebook_record_check(
            session_id=session.get("session_id") or "",
            plan_id=plan.get("plan_id") or "",
            lesson_event_id=plan.get("lesson_event_id"),
            course=source_lesson.get("course") or "",
            week=source_lesson.get("week") or "",
            lesson=source_lesson.get("lesson") or "",
            beat_id=req.beat_id,
            selected_index=req.selected_index,
            correct_index=correct_index,
            passed=passed,
            score=score,
            first_try=first_try,
        )
    except Exception as e:
        _log(f"gradebook write failed (non-fatal): {e}")

    return {
        "score": score,
        "passed": passed,
        "selected_index": req.selected_index,
        "correct_index": correct_index,
        "explanation": explanation,
        "first_try": first_try,
        "session": session,
    }


class SessionAdvanceRequest(BaseModel):
    session_id: str


@router.post(
    "/classroom/session/advance",
    dependencies=[Depends(require_write_password)],
)
def session_advance_endpoint(req: SessionAdvanceRequest):
    session = load_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    plan = load_plan(session.get("plan_id"))
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found for session")

    beats = plan.get("beats", [])
    idx = int(session.get("current_beat", 0))
    if idx < len(beats):
        session.setdefault("events", []).append({
            "type": "beat_completed",
            "beat_id": beats[idx].get("beat_id"),
        })
    new_idx = min(idx + 1, len(beats))
    session["current_beat"] = new_idx
    update_session(session)
    return {"session": session, "at_end": new_idx >= len(beats)}


# =========================================================
# SESSION  ←  RAISE-HAND
# Student-side Q&A mid-session. The Teacher answers the question
# grounded in the same lesson's source material the plan was built
# from. Streams NDJSON tokens; the assembled answer + a Python
# grounding report get appended to the session record as events
# after the stream completes (so reload-into-session preserves the
# Q&A history alongside beat events).
# =========================================================
class SessionRaiseHandRequest(BaseModel):
    session_id: str
    question: str


@router.post(
    "/classroom/session/raise-hand",
    dependencies=[Depends(require_write_password)],
)
def session_raise_hand_endpoint(req: SessionRaiseHandRequest):
    """
    Student raises hand mid-lesson with a question. Streams the
    Teacher's answer (NDJSON tokens), then closes with a `done`
    event carrying the assembled answer text and a grounding
    report. Both get appended to the session's events log so the
    Q&A is part of the session's persistent record.
    """
    question = (req.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question cannot be empty")

    session = load_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    plan = load_plan(session.get("plan_id"))
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found for session")

    source_text = _resolve_plan_source_text(plan)
    if not source_text.strip():
        # No source to ground against — refuse rather than let the
        # Teacher hallucinate. This is the same posture validation
        # takes at the SOT-write boundary.
        raise HTTPException(
            status_code=409,
            detail="Cannot resolve grounding source for this plan — refusing to answer ungrounded.",
        )

    source_lesson = plan.get("source_lesson") or {}
    course = source_lesson.get("course") or ""
    week = source_lesson.get("week") or ""
    lesson = source_lesson.get("lesson") or ""

    # Persist the question event immediately, before the stream —
    # so even if the stream fails mid-flight, the session record
    # shows the student asked something. The answer event gets
    # appended on stream completion.
    current_beat = session.get("current_beat", 0)
    session.setdefault("events", []).append({
        "type": "raise_hand_question",
        "question": question,
        "at_beat": current_beat,
    })
    update_session(session)

    def stream():
        try:
            yield json.dumps({"type": "start", "question": question}) + "\n"

            assembled = []
            for token in stream_question_answer(
                question=question,
                source_text=source_text,
                course=course,
                week=week,
                lesson=lesson,
            ):
                assembled.append(token)
                yield json.dumps({"type": "token", "value": token}) + "\n"

            answer_text = "".join(assembled).strip()

            # Python grounding gate on the Teacher's runtime output —
            # same combined_report primitive the validation_agent and
            # notebook_controller use. The grounding ratio is shipped
            # to the client AND stored on the session event so a low
            # ratio is visible at reload time too.
            grounding = combined_report(answer_text, source_text)

            # Append the answer event to the session and persist.
            fresh = load_session(req.session_id)
            if fresh:
                fresh.setdefault("events", []).append({
                    "type": "raise_hand_answer",
                    "question": question,
                    "answer": answer_text,
                    "at_beat": current_beat,
                    "grounding_report": grounding,
                })
                update_session(fresh)

            yield json.dumps({
                "type": "done",
                "answer": answer_text,
                "grounding_report": grounding,
            }) + "\n"
        except Exception as e:
            traceback.print_exc()
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


class SessionEndRequest(BaseModel):
    session_id: str


@router.post(
    "/classroom/session/end",
    dependencies=[Depends(require_write_password)],
)
def session_end_endpoint(req: SessionEndRequest):
    from datetime import datetime
    session = load_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session["completed"] = True
    session["ended_at"] = datetime.utcnow().isoformat()
    session.setdefault("events", []).append({"type": "session_ended"})
    update_session(session)
    return session
