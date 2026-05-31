"""
my-AI-stro Backend — FastAPI application entry point.

Responsibilities:
  - Mount the API routers (ingestion, advisor, quiz, classroom,
    general chat, guest classroom) and the inline endpoints below.
  - Start the background audit loop on uvicorn startup, cancel it
    cleanly on shutdown (via FastAPI's lifespan hook).
  - Expose read endpoints that don't fit a dedicated router:
    /api/sot, /api/sot/graph, /api/stats, /api/sot/archives,
    /api/sot/obsidian-status, /api/auth/status, /api/visit.
  - Expose two write endpoints behind the write-password gate:
    /api/sot/resummarize, /api/sot/sync-obsidian, /api/audit/run-once.

What lives here vs. elsewhere:
  - Domain logic (summarization, validation, audit, persistence,
    Obsidian sync) lives in agents/ and core/. This file is wiring.
  - Inline endpoints are kept here when they're small and don't
    have a corresponding agent module to group them under.

CORS is configured for localhost:5173 only — the Vite dev server.
Production sharing happens through a Tailscale Funnel pointed at the
same dev port, so no additional origin needs allowlisting; the
funnel forwards the same Host. The Vite proxy keeps /api/* on the
same origin in the browser's view.
"""

import asyncio
import json
import os
import sys
import traceback
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# =========================================================
# CORE — pipeline engine, SOT abstractions, auth, persistence
# =========================================================
from core.execution_engine import Task, Node
from core.memory_reader import retrieve_from_memory
from core.obsidian_export import sync_vault, vault_status
from core.auth import require_write_password, write_protection_status
from core.visits import record_visit, get_visit_stats
from core.sot_groups import canonical_entries, group_active, load_archive

# =========================================================
# AGENTS — domain logic that the inline endpoints below call
# =========================================================
from agents.summarization_agent import summarize_lesson
from agents.validation_agent import validate_summary
from agents.audit_agent import audit_loop, run_one_step as audit_run_one_step

# =========================================================
# ROUTERS — endpoint groups that live in their own modules
# =========================================================
from api.ingestion_controller import router as ingestion_router
from api.quiz_controller import router as quiz_router
from api.advisor_controller import router as advisor_router
from api.general_chat_controller import router as general_chat_router
from api.classroom_controller import router as classroom_router
from api.classroom_guest_controller import router as classroom_guest_router
from api.notebook_controller import router as notebook_router
from api.highlights_controller import router as highlights_router


# Persistence target for the inline endpoints (graph, stats, resummarize).
# The other ingest path goes through core/memory_writer_node.py which
# uses the same filename. Kept as a constant so any rename is one edit.
SOT_FILE = "memory_store.json"


# =========================================================
# SOT FILE HELPERS  (used by inline endpoints only)
# Heavier persistence work goes through core/memory_writer_node.py,
# which adds the upsert-by-(course, week, lesson) semantics and
# atomic-write guarantees. These two helpers are intentionally light
# because the read path doesn't need any of that.
# =========================================================
def _load_sot() -> list:
    """Return the SOT entries as a list, or [] if the file is missing or corrupt."""
    if not os.path.exists(SOT_FILE):
        return []
    with open(SOT_FILE, "r") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            # Corrupt JSON returns empty rather than crashing the read path.
            # In practice this can only happen if a write crashed mid-flush,
            # which the atomic-write pattern in memory_writer_node prevents.
            return []


def _save_sot(data: list) -> None:
    """Write the SOT entries back. Used by /api/sot/resummarize only."""
    with open(SOT_FILE, "w") as f:
        json.dump(data, f, indent=2)


# =========================================================
# APP INIT  +  AUDIT-LOOP LIFESPAN
# The audit agent is launched as a background asyncio task on
# startup and cancelled cleanly on shutdown. Cancellation is
# expected — we swallow the CancelledError so uvicorn shuts down
# without a traceback.
# =========================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan: start the audit loop on startup, cancel on shutdown."""
    task = asyncio.create_task(audit_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(lifespan=lifespan)

# Mount all router modules under /api. The ingestion router serves
# the streaming NDJSON pipeline; the others wrap their respective
# downstream-SOT-consumer agents.
app.include_router(ingestion_router, prefix="/api")
app.include_router(quiz_router, prefix="/api")
app.include_router(advisor_router, prefix="/api")
app.include_router(general_chat_router, prefix="/api")
app.include_router(classroom_router, prefix="/api")
app.include_router(classroom_guest_router, prefix="/api")
app.include_router(notebook_router, prefix="/api")
app.include_router(highlights_router, prefix="/api")


# =========================================================
# CORS
# Only the Vite dev server is allowed as a cross-origin caller.
# When sharing via Tailscale Funnel the browser hits the funnel
# hostname directly, Vite proxies /api/* to this backend on the
# same origin, so CORS never enters the picture for tunnel traffic.
# =========================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =========================================================
# REQUEST SCHEMAS
# =========================================================
class QueryRequest(BaseModel):
    """Legacy demo /query endpoint payload. See `query_endpoint` below."""
    query: str


class ResummarizeRequest(BaseModel):
    """Payload for /api/sot/resummarize — identifies the entry to re-run."""
    event_id: str


class VisitRequest(BaseModel):
    """
    Payload for /api/visit — the frontend assigns a stable UUID on
    first run and reports it here on every app mount. Same UUID =
    same unique visitor (with an incremented per-UUID visit counter).
    """
    client_id: Optional[str] = None


# =========================================================
# ROOT  (health check)
# =========================================================
@app.get("/")
def root():
    """Tiny health-check endpoint; returns server status + UTC timestamp."""
    return {
        "status": "myAIstro backend running",
        "timestamp": datetime.utcnow().isoformat(),
    }


# =========================================================
# SOT BROWSE
# Returns the canonical (oldest active) entry per lesson so audit-
# generated v2/v3 versions don't appear twice in the user-facing list.
# =========================================================
@app.get("/api/sot")
def list_sot() -> list:
    """
    Return every canonical SOT entry — one per `(course, week, lesson)`
    group. Audit-generated alternates remain in `memory_store.json` and
    are scored by the audit loop, but they're invisible to readers.
    """
    return canonical_entries(_load_sot())


# =========================================================
# SOT RE-SUMMARIZE
# Re-runs summarization on an entry's stored raw_text and replaces
# the derived fields in place. Identity (event_id, trace_id, the
# course/week/lesson key, raw_text, created_at) is preserved so the
# audit history and downstream references stay valid.
# Write-protected: this mutates the SOT.
# =========================================================
@app.post("/api/sot/resummarize", dependencies=[Depends(require_write_password)])
def resummarize(req: ResummarizeRequest) -> dict:
    """
    Re-run summarization on an existing SOT entry's raw_text.

    Fails 404 if no entry matches the event_id; 400 if the entry has
    no stored raw_text to re-summarize from; 422 if the new summary
    fails validation (the entry is left untouched in that case).
    """
    data = _load_sot()
    idx = next(
        (i for i, e in enumerate(data) if e.get("event_id") == req.event_id),
        None,
    )
    if idx is None:
        raise HTTPException(status_code=404, detail="SOT entry not found")

    entry = data[idx]
    raw_text = entry.get("raw_text") or ""
    if not raw_text.strip():
        # Entries from pre-raw-capture versions of the SOT can't be
        # re-summarized — there's no source to run summarization on.
        # Direct the user to re-ingest the lesson instead.
        raise HTTPException(
            status_code=400,
            detail="Entry has no raw_text; re-ingest the lesson to enable re-summarization.",
        )

    new_summary = summarize_lesson(raw_text)
    validation = validate_summary({
        "retrieval": {"source_text": raw_text},
        "summarization": new_summary,
    })

    if validation.get("validation") != "PASS":
        # Mirror the ingest-side validation FAIL log so resummarize
        # rejections are debuggable from the uvicorn stderr output —
        # the API response only carries the errors/warnings list, not
        # the full preview the developer needs to diagnose a prompt
        # regression.
        print(
            "[resummarize FAIL] "
            f"course={entry.get('course')!r} "
            f"week={entry.get('week')!r} "
            f"lesson={entry.get('lesson')!r}\n"
            f"  errors:   {validation.get('errors', [])}\n"
            f"  warnings: {validation.get('warnings', [])}\n"
            f"  summary preview ({len(new_summary.get('summary') or '')} chars): "
            f"{(new_summary.get('summary') or '')[:200]!r}\n"
            f"  key_concepts: {new_summary.get('key_concepts')}\n"
            f"  source_text length: {len(raw_text)} chars",
            file=sys.stderr,
            flush=True,
        )
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Re-summarization failed validation",
                "errors": validation.get("errors", []),
                "warnings": validation.get("warnings", []),
            },
        )

    # In-place field replacement — preserves event_id, trace_id, course/
    # week/lesson, raw_text, and created_at, so downstream references and
    # audit-history relationships remain valid.
    entry["summary"] = new_summary.get("summary")
    entry["key_concepts"] = new_summary.get("key_concepts")
    entry["definitions"] = new_summary.get("definitions")
    entry["code_blocks"] = new_summary.get("code_blocks")
    entry["validation_score"] = validation.get("score")
    entry["resummarized_at"] = datetime.utcnow().isoformat()

    data[idx] = entry
    _save_sot(data)

    # Mirror the change into the Obsidian vault. Failures here don't
    # fail the resummarize — the SOT is canonical; the vault is a
    # derived view that can be re-synced any time.
    try:
        sync_vault(SOT_FILE)
    except Exception:
        traceback.print_exc()

    return entry


# =========================================================
# OBSIDIAN VAULT  +  AUTH STATUS
# Two thin endpoints that surface metadata to the frontend.
# =========================================================
@app.get("/api/sot/obsidian-status")
def obsidian_status_endpoint() -> dict:
    """Return Obsidian-mirror file count + last-sync timestamp."""
    return vault_status()


@app.get("/api/auth/status")
def auth_status_endpoint() -> dict:
    """
    Whether write endpoints require the X-Write-Password header.
    Read-safe — only returns a boolean, never the password itself.
    """
    return write_protection_status()


# =========================================================
# AUDIT  +  ARCHIVE
# /api/sot/archives is read-open (visitors can see the audit trail).
# /api/audit/run-once is write-protected — it mutates the SOT.
# =========================================================
@app.get("/api/sot/archives")
def list_archives() -> list:
    """Every archived entry, newest-archived first."""
    archived = load_archive()
    return sorted(
        archived,
        key=lambda e: e.get("archived_at") or "",
        reverse=True,
    )


@app.post("/api/audit/run-once", dependencies=[Depends(require_write_password)])
def audit_run_once_endpoint() -> dict:
    """
    Manually trigger one audit step. Useful for fast-forwarding the
    self-improvement loop without waiting for the 15-minute background
    interval — and for observing the signed-grounding judge in action.
    Write-protected because it can mutate the SOT (create or archive
    versions). See agents/audit_agent.py::run_one_step for the decision
    tree.
    """
    try:
        return audit_run_one_step()
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/sot/sync-obsidian", dependencies=[Depends(require_write_password)])
def sync_obsidian_endpoint() -> dict:
    """
    Force-sync the SOT into the Obsidian vault. Normally this fires
    automatically after every successful ingest / resummarize, so the
    manual endpoint is mostly for recovery (e.g. after deleting the
    vault directory or hand-editing files there).
    """
    try:
        return sync_vault(SOT_FILE)
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# =========================================================
# SOT GRAPH
# Returns nodes + links suitable for the force-directed graph view.
# Every active node is rendered — canonical (v1) AND audit-generated
# satellites (v2/v3). Concept-overlap links connect ONLY canonicals;
# audit nodes don't get their own concept edges (they'd just be
# duplicates of their canonical's), but each carries a tether
# reference so the frontend can draw the audit-satellite line.
# =========================================================
@app.get("/api/sot/graph")
def sot_graph() -> dict:
    """
    Return the graph the frontend's force-directed view renders.

    Output shape:
      {
        "nodes": [
          {
            "id": "<event_id>",
            "course": ..., "week": ..., "lesson": ...,
            "summary": "...",         # truncated to 280 chars for tooltips
            "key_concepts": [...],
            "created_at": "...",
            "version": <int>,
            "audit_generated": <bool>,
            "is_canonical": <bool>,
            "canonical_event_id": "<event_id>",  # the canonical for this group
          },
          ...
        ],
        "links": [
          {"source": id_a, "target": id_b, "weight": <int>, "shared": [concepts]},
          ...
        ]
      }
    """
    data = _load_sot()

    # Map each (course, week, lesson) group to its canonical (oldest active)
    # event_id. Used both for the per-node `canonical_event_id` reference
    # AND to filter the concept-link computation to canonicals only.
    canonical_id_by_key: dict = {}
    for key, entries in group_active(data).items():
        if entries:
            canonical_id_by_key[key] = entries[0].get("event_id")
    canonical_id_set = set(canonical_id_by_key.values())

    def _key(e: dict) -> tuple:
        """The (course, week, lesson) group key for a given entry."""
        return (e.get("course") or "", e.get("week") or "", e.get("lesson") or "")

    # Build node objects — one per active entry (canonical + audit satellites)
    nodes = []
    for e in data:
        eid = e.get("event_id")
        nodes.append({
            "id": eid,
            "course": e.get("course"),
            "week": e.get("week"),
            "lesson": e.get("lesson"),
            "summary": (e.get("summary") or "")[:280],
            "key_concepts": e.get("key_concepts") or [],
            "created_at": e.get("created_at"),
            "version": e.get("version") or 1,
            "audit_generated": bool(e.get("audit_generated")),
            "is_canonical": eid in canonical_id_set,
            "canonical_event_id": canonical_id_by_key.get(_key(e)),
        })

    # Concept-overlap links: O(n²) over canonicals only. With ~200 lessons
    # this is sub-millisecond. If the SOT grows past a few thousand entries
    # this would want a concept-inverted-index for incremental updates.
    canonicals = [e for e in data if e.get("event_id") in canonical_id_set]
    links = []
    for i, a in enumerate(canonicals):
        a_concepts = {c.lower() for c in (a.get("key_concepts") or [])}
        if not a_concepts:
            continue
        for b in canonicals[i + 1:]:
            b_concepts = {c.lower() for c in (b.get("key_concepts") or [])}
            shared = a_concepts & b_concepts
            if shared:
                links.append({
                    "source": a.get("event_id"),
                    "target": b.get("event_id"),
                    "weight": len(shared),
                    "shared": sorted(shared),
                })

    return {"nodes": nodes, "links": links}


# =========================================================
# STATS  — the Today strip on the home view
# Canonical-only counting so audit-generated v2/v3 alternates don't
# inflate the lesson count or skew the per-day streak signal.
# =========================================================
@app.get("/api/stats")
def sot_stats() -> dict:
    """
    Lightweight summary of SOT activity for the dashboard header.

    All counts are over CANONICAL entries (oldest active per
    `(course, week, lesson)` group). Audit-generated alternates are
    excluded so they don't inflate the lesson count or skew the
    streak signal.

    Returned shape:
      {
        "total":         <int>,                  # canonical entry count
        "by_course":     {course: count, ...},   # canonical counts per course
        "last":          {course, week, lesson, created_at} | None,
        "streak_days":   <int>,                  # consecutive UTC days w/ ≥1 ingest
        "visits":        {total, unique},        # local visit counter
      }
    """
    raw = _load_sot()
    visits = get_visit_stats()
    data = canonical_entries(raw)

    if not data:
        return {
            "total": 0,
            "by_course": {},
            "last": None,
            "streak_days": 0,
            "visits": visits,
        }

    # Per-course counts
    by_course: dict = {}
    for e in data:
        c = e.get("course") or "(none)"
        by_course[c] = by_course.get(c, 0) + 1

    # Parse created_at timestamps once; reuse for both "last" and the streak
    parsed = []
    for e in data:
        ts = e.get("created_at")
        if not ts:
            continue
        try:
            parsed.append((datetime.fromisoformat(ts), e))
        except ValueError:
            continue

    last = None
    if parsed:
        parsed.sort(key=lambda p: p[0], reverse=True)
        latest_dt, latest_entry = parsed[0]
        last = {
            "course": latest_entry.get("course"),
            "week": latest_entry.get("week"),
            "lesson": latest_entry.get("lesson"),
            "created_at": latest_entry.get("created_at"),
        }

    # Streak: walk backward from today (UTC) as long as each day has ≥1
    # canonical ingest. The streak ends at the first gap. 0 if no ingest today.
    today = datetime.utcnow().date()
    days_with_ingest = {dt.date() for dt, _ in parsed}
    streak = 0
    cursor = today
    while cursor in days_with_ingest:
        streak += 1
        cursor = cursor - timedelta(days=1)

    return {
        "total": len(data),
        "by_course": by_course,
        "last": last,
        "streak_days": streak,
        "visits": visits,
    }


# =========================================================
# VISITOR TRACKING — bumped once per React-app mount
# A purely local counter; nothing leaves the machine. The frontend
# generates a stable UUID on first run and reports it here on every
# mount, so we can distinguish total visits from unique visitors
# without storing any identifying information.
# =========================================================
@app.post("/api/visit")
def post_visit(req: VisitRequest) -> dict:
    """
    Record a page-load. The frontend's `client_id` is a stable UUID
    created on first run and persisted in localStorage — same UUID
    across refreshes counts as one unique visitor with an incremented
    per-UUID counter.
    """
    return record_visit(req.client_id)


# =========================================================
# LEGACY: /query — demo endpoint kept for compatibility
# Predates the streaming advisor pipeline. The same retrieval +
# summarization + validation stages run here, but synchronously and
# without SOT-grounding (the advisor router is the modern path for
# user-facing chat over the SOT). Kept because it's a small,
# self-contained demonstration of the three-node task graph the
# core/execution_engine module supports.
# =========================================================
@app.post("/query")
def query_endpoint(request: QueryRequest) -> dict:
    """
    Execute the READ pipeline against a free-form query.

    1. Retrieval — keyword-overlap match against the SOT.
    2. Summarization — pass the matched text through llama3:8b.
    3. Validation — pure-Python checks on the summarization output.

    Returns the full timeline (per-node status, durations, errors)
    so callers can introspect what the pipeline did. This is the
    demo / debugging surface; production user-chat goes through
    /api/advisor/chat which streams NDJSON.
    """

    timeline = []

    # -----------------------------------------------------
    # NODE 1: RETRIEVAL
    # -----------------------------------------------------
    def retrieval_node(context: dict) -> dict:
        """Pull relevant SOT entries via memory_reader's keyword-overlap match."""
        matches = retrieve_from_memory(request.query)
        source_text = " ".join(m.get("summary", "") for m in matches)

        result = {
            "matches": matches,
            "query": request.query,
            "source_text": source_text,
            "timestamp": datetime.utcnow().isoformat(),
        }

        timeline.append({
            "step": "retrieval",
            "status": "complete",
            "matches_found": len(matches),
            "data": result,
        })
        return result

    # -----------------------------------------------------
    # NODE 2: SUMMARIZATION
    # -----------------------------------------------------
    def summarization_node(context: dict) -> dict:
        """Run summarization over the retrieved matches' combined text."""
        retrieval_data = context.get("retrieval", {})
        combined_text = retrieval_data.get("source_text", "")
        result = summarize_lesson(combined_text)

        timeline.append({
            "step": "summarization",
            "status": "complete",
            "timestamp": datetime.utcnow().isoformat(),
            "data": result,
        })
        return result

    # -----------------------------------------------------
    # NODE 3: VALIDATION
    # -----------------------------------------------------
    def validation_node(context: dict) -> dict:
        """Run the same validation gate the ingest pipeline uses."""
        result = validate_summary(context)
        timeline.append({
            "step": "validation",
            "status": result.get("validation", "UNKNOWN"),
            "score": result.get("score", 0),
            "errors": result.get("errors", []),
            "warnings": result.get("warnings", []),
            "validated_at": result.get("validated_at"),
        })
        return result

    # Build + execute the three-node task graph. The execution_engine
    # resolves the depends_on chain into a sequential run; here each
    # node feeds the next, so the chain is just a linear pipeline.
    task = Task(input_data={"query": request.query})
    retrieval = Node("retrieval", retrieval_node)
    summarization = Node("summarization", summarization_node, depends_on=[retrieval])
    validation = Node("validation", validation_node, depends_on=[summarization])
    task.add_node(retrieval)
    task.add_node(summarization)
    task.add_node(validation)
    task.run()

    return {
        "query": request.query,
        "timeline": timeline,
    }
