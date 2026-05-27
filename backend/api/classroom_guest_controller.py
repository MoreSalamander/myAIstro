"""
Guest Classroom endpoints — public, ephemeral, NO persistence.

Used by tunnel visitors who don't have the owner's write password.
Lets them generate plans without their activity ever touching the
owner's classroom/plans, classroom/sessions, or SOT files.

Single endpoint:

  POST /api/classroom/guest/plan
      body: { event_id }
      returns: { plan }            -- generated and returned in-memory
                                     never written to disk

CHECK grading is now deterministic multiple-choice (selected_index vs
plan's correct_index), so guest answer-grading happens entirely in the
guest's frontend with no server round-trip. The old /guest/answer
endpoint was an LLM grader and has been removed.

Compared to the owner endpoints:
  * No write-password dependency.
  * No session lifecycle on the server — guest frontend manages session
    state in component state. No start / advance / end round-trips.
  * Owner's cached plans remain readable via the existing public
    GET /api/classroom/plans + /plan/{id} endpoints, so guests benefit
    from the owner's cache without polluting it.
"""

import json
import os
import sys
import traceback
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agents.plan_validator import validate_plan
from agents.teacher_aide_agent import parse_plan, stream_plan


router = APIRouter()


def _load_sot():
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
    print(f"[classroom-guest] {msg}", file=sys.stderr, flush=True)


# =========================================================
# GUEST PLAN GENERATION  (ephemeral — no save)
# =========================================================
class GuestPlanRequest(BaseModel):
    event_id: str


@router.post("/classroom/guest/plan")
def guest_plan_endpoint(req: GuestPlanRequest):
    entry = _find_entry(req.event_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Lesson not found")

    def _attempt():
        raw_full = ""
        for evt in stream_plan(entry):
            if evt["type"] == "raw_done":
                raw_full = evt["text"]
            elif evt["type"] == "error":
                return None, {"validation": "FAIL", "errors": [evt["message"]]}
        plan = parse_plan(raw_full, entry)
        return plan, validate_plan(plan)

    def stream():
        try:
            yield json.dumps({"type": "start", "lesson_event_id": req.event_id}) + "\n"
            yield json.dumps({"type": "model_start"}) + "\n"

            plan, validation = _attempt()
            if validation.get("validation") != "PASS":
                _log(f"guest plan validation FAIL on attempt 1 — retrying. errors={validation.get('errors')}")
                yield json.dumps({"type": "model_start", "attempt": 2}) + "\n"
                plan, validation = _attempt()

            if validation.get("validation") != "PASS":
                _log(f"guest plan validation FAIL on attempt 2 — giving up.")
                yield json.dumps({
                    "type": "error",
                    "message": "Generated plan failed validation after retry",
                    "errors": validation.get("errors"),
                }) + "\n"
                return

            # In guest mode the plan is ephemeral — we still give it a
            # stable id so the frontend can key beats by it, but we
            # never persist it to backend/classroom/plans/.
            import uuid as _uuid
            plan["plan_id"] = f"guest-{_uuid.uuid4()}"

            for beat in plan.get("beats", []):
                yield json.dumps({"type": "beat", "beat": beat}) + "\n"
            yield json.dumps({"type": "done", "plan": plan}) + "\n"
        except Exception as e:
            traceback.print_exc()
            yield json.dumps({"type": "error", "message": str(e)}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


# Guest answer grading removed — MC grading happens client-side.
# See module docstring for rationale.
