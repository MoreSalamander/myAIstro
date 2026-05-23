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
from agents.plan_validator import validate_plan
from agents.quiz_agent import grade_answer
from agents.teacher_agent import phrase_correction
from agents.teacher_aide_agent import parse_plan, stream_plan


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


def _log(msg: str) -> None:
    print(f"[classroom] {msg}", file=sys.stderr, flush=True)


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

    def _attempt(emit_progress):
        """One generation attempt. Returns (plan_or_None, validation_dict)."""
        raw_full = ""
        for evt in stream_plan(entry):
            if evt["type"] == "raw_chunk":
                emit_progress()
            elif evt["type"] == "raw_done":
                raw_full = evt["text"]
            elif evt["type"] == "model_start":
                pass  # caller-side already signaled
            elif evt["type"] == "error":
                return None, {"validation": "FAIL", "errors": [evt["message"]]}
        plan = parse_plan(raw_full, entry)
        return plan, validate_plan(plan)

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
            # transient model variance (e.g. it skipped canonical_answer
            # on every CHECK this run). A single fresh attempt almost
            # always succeeds.
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
    user_answer: str


@router.post(
    "/classroom/session/answer",
    dependencies=[Depends(require_write_password)],
)
def session_answer_endpoint(req: SessionAnswerRequest):
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

    question = beat.get("question") or beat.get("content") or ""
    canonical = beat.get("canonical_answer") or ""

    # Reuse the existing quiz grader. It expects the SOT entry so it can
    # see summary / concepts / definitions to ground its judgment.
    entry = _find_entry(session.get("lesson_event_id") or "") or {}
    grade = grade_answer(
        question=question,
        user_answer=req.user_answer,
        entry=entry,
    )
    score = int(grade.get("score", 0))  # 0-100
    passed = score >= 70

    correction = phrase_correction(
        question=question,
        canonical_answer=canonical,
        student_answer=req.user_answer,
        score=score,
        passed=passed,
    )

    # Persist the event
    event = {
        "type": "check_answered",
        "beat_id": req.beat_id,
        "user_answer": req.user_answer,
        "score": score,
        "passed": passed,
    }
    session.setdefault("events", []).append(event)

    # Update summary stats
    stats = session.setdefault(
        "summary_stats",
        {"checks_total": 0, "checks_passed": 0, "avg_check_score": 0.0},
    )
    stats["checks_total"] = int(stats.get("checks_total", 0)) + 1
    if passed:
        stats["checks_passed"] = int(stats.get("checks_passed", 0)) + 1
    # Streaming average
    n = stats["checks_total"]
    prev_avg = float(stats.get("avg_check_score", 0.0))
    stats["avg_check_score"] = round(prev_avg + (score - prev_avg) / n, 2)

    update_session(session)

    return {
        "score": score,
        "passed": passed,
        "correction": correction,
        "canonical_answer": canonical,
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
