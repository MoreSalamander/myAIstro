# Architecture

Engineer-level deep dive. The [README](./README.md) covers what this project is and why; this document covers how it's built.

Topics, in order:

1. [System overview](#system-overview)
2. [The Source of Truth (SOT)](#the-source-of-truth-sot)
3. [The five-stage ingestion pipeline](#the-five-stage-ingestion-pipeline)
4. [Agent roster](#agent-roster)
5. [The Deterministic Scaffold](#the-deterministic-scaffold)
6. [The self-improving audit loop](#the-self-improving-audit-loop)
7. [The Judge's scoring formula](#the-judges-scoring-formula)
8. [The graph visualization](#the-graph-visualization)
9. [Write protection and tunnel sharing](#write-protection-and-tunnel-sharing)
10. [Data persistence](#data-persistence)
11. [Performance characteristics](#performance-characteristics)
12. [Known limitations and future direction](#known-limitations-and-future-direction)

---

## System overview

```
                  ┌──────────────────────────────────────────────────────┐
                  │                       BROWSER                        │
                  │  ┌─────────────────────────────────────────────────┐ │
                  │  │  React (Vite dev server, port 5173)             │ │
                  │  │  Graph · List · Archives · Classroom · About    │ │
                  │  └─────────────────────────────────────────────────┘ │
                  └─────────────────────────┬────────────────────────────┘
                                            │ /api/* (proxied by Vite)
                                            ▼
                  ┌──────────────────────────────────────────────────────┐
                  │              FastAPI (uvicorn, port 8000)            │
                  │                                                      │
                  │  Controllers ─► Agents ─► Pipeline orchestrator      │
                  │      │             │              │                  │
                  │      └─────────────┴──────────────┴── core/          │
                  │                                                      │
                  └──────┬──────────────────┬────────────────────┬───────┘
                         │                  │                    │
                         ▼                  ▼                    ▼
                  ┌─────────────┐    ┌─────────────┐      ┌──────────────┐
                  │   Ollama    │    │  SOT JSON   │      │  Obsidian    │
                  │   (local    │    │   on disk   │      │  vault       │
                  │    LLMs)    │    │             │      │  (markdown)  │
                  └─────────────┘    └─────────────┘      └──────────────┘
```

Three local LLMs serve different roles:
- `llama3:8b` — summarization only (the SOT extractor)
- `llama3.2` — conversational roles (advisor, quiz generator, teacher aide, teacher, general chat)
- `mistral` — quiz grading (the LLM-as-judge separation rule)

Everything runs on a single Mac. There are no remote calls beyond Ollama on `localhost`.

---

## The Source of Truth (SOT)

The SOT is the canonical data abstraction the entire system orbits.

**Storage:** one JSON file at `backend/memory_store.json`. An array of entry objects. Atomic writes via temp-file + rename. The archive (entries the audit cycle has retired) lives in a parallel `backend/archived_store.json`.

**Entry shape:**

```jsonc
{
  "event_id":         "uuid-v4",
  "trace_id":         "uuid-v4 from ingest event",
  "course":           "FE102",
  "week":             "2",
  "lesson":           "Composing components",
  "raw_text":         "the original lesson text the user pasted in",
  "summary":          "4-8 sentence prose explanation",
  "key_concepts":     ["array of strings"],
  "definitions":      ["array of 'term — explanation' strings"],
  "code_blocks":      ["array of verbatim code blocks from the source"],
  "validation_score": 1.0,
  "created_at":       "ISO-8601 UTC",

  // Only present on audit-generated versions:
  "version":          2,
  "audit_generated":  true
}
```

**Key invariants:**

- Entries are grouped by `(course, week, lesson)`. Re-ingesting a lesson with the same key **replaces** the canonical entry rather than appending a duplicate. See `core/memory_writer_node.py`.
- A single lesson group can have **multiple active versions** — the original user-ingested entry plus zero or more audit-generated alternatives.
- The **oldest** active entry in a group is **canonical** — what every downstream consumer (graph, list, advisor, quiz, vault, classroom) reads. See `core/sot_groups.py::canonical_entries`.
- Newer versions exist in the background as alternatives. They become canonical only when an older version is archived by the audit loop.
- The audit loop maintains 2-3 active versions per lesson, archiving the weakest when a group is unambiguously stable. See [the audit loop section](#the-self-improving-audit-loop).

---

## The five-stage ingestion pipeline

When a lesson is pasted into the Ingest modal, it travels a fixed five-stage pipeline before joining the SOT. Each stage produces a typed event the next consumes. The pipeline streams its events back to the browser as NDJSON, so the user watches each stage light up live.

```
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │ graph_entry  │─►│  retrieval   │─►│summarization │─►│  validation  │─►│ memory_write │
   │              │  │              │  │              │  │              │  │              │
   │ trace_id +   │  │ (currently   │  │ llama3:8b    │  │ pure-Python  │  │ atomic JSON  │
   │ timestamp    │  │  pass-thru)  │  │ JSON output  │  │ rule checks  │  │ + vault sync │
   └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

**graph_entry** (`core/graph_entry_node.py`): emits a `pipeline_event` with the trace ID and timestamp. Cheap. No LLM.

**retrieval** (`core/retrieval_node.py`): currently a pass-through that forwards the raw_text. Kept as a stage so future context-aware ingestion (e.g., conditioning summarization on related SOT entries) has a place to live.

**summarization** (`agents/summarization_agent.py`): the LLM-heavy stage. Calls `llama3:8b` with a tight prompt and parses the structured JSON response. The agent layers multiple defenses against captured failure modes — JSON repair for truncated output, prose-wrapper stripping, nested-summary unwrapping, regex-fallback field extraction, chunking for long lessons. Most of these defenses exist because the LLM produced specific malformed outputs in the wild and the agent now handles them. See the file's top-of-file docstring for the full defense list.

**validation** (`agents/validation_agent.py`): pure-Python gate. The single most important stage for correctness. See [the Deterministic Scaffold section](#the-deterministic-scaffold) for the full rule list. Failures don't write.

**memory_write** (`core/memory_writer_node.py`): only runs if validation passed. Upserts by `(course, week, lesson)`, writes atomically through a temp file, then mirrors the SOT into the Obsidian vault as markdown (see `core/obsidian_export.py`). Vault sync failures don't fail the ingest — the SOT is canonical, the vault is a derived view.

**Streaming surface:** the pipeline runs inside `core/ingestion_pipeline.py`. Each stage produces events that get serialized to NDJSON and streamed back to the browser. The frontend's `DataFlowCanvas.jsx` animates the data flow in real time, lighting up nodes as their stage's events arrive.

---

## Agent roster

Eleven named agents. Each does exactly one thing.

| Agent | Role | File | Backed by |
|---|---|---|---|
| Summarization | Extract structure from raw lesson text | `agents/summarization_agent.py` | `llama3:8b` |
| Validation | Pre-write gate | `agents/validation_agent.py` | pure Python |
| Audit | Background self-improvement loop | `agents/audit_agent.py` | orchestrator (pure Python) |
| Judge | Score audit-generated alternatives | `agents/judge_agent.py` | pure Python (deterministic) |
| Advisor | SOT-grounded natural-language chat | `agents/advisor_agent.py` | `llama3.2` |
| Quiz Generator | Recall questions from a lesson | `agents/quiz_agent.py::generate_question` | `llama3.2` |
| Quiz Grader | Score student answers (judge-separated) | `agents/quiz_agent.py::grade_answer` | `mistral` |
| General Chat | Untethered conversation, no SOT grounding | `agents/general_chat_agent.py` | `llama3.2` |
| Teacher Aide | Generate classroom lesson plans | `agents/teacher_aide_agent.py` | `llama3.2` |
| Teacher | Runtime corrections during classroom CHECK beats | `agents/teacher_agent.py` | `llama3.2` |
| Memory Writer | Atomic SOT/archive persistence + vault sync | `core/memory_writer_node.py` | pure Python (file I/O) |

**Routing.** All model assignments live in one file: `backend/core/model_router.py`. Changing any agent's model is a single-line edit there; agents import the role they need (`SUMMARIZE`, `ADVISE`, etc.) and never hardcode model names.

---

## The Deterministic Scaffold

The system's central design principle: **the LLM is one component, surrounded by deterministic Python fences.**

Four of the eleven agents above don't run an LLM at all. Neither does the orchestrator that runs them. Together they form the scaffold:

### 1. Validation (the write-time gate)

`backend/agents/validation_agent.py`. A pure-Python function that decides whether a summarization output is allowed to persist as a SOT entry. Rule checks, in order:

- **Structural shape.** Required fields present, summarization dict not null.
- **Not raw JSON.** Catches the LLM-fallback failure mode where a malformed model output dumps its raw JSON into the `summary` field instead of producing prose.
- **Key concepts required on non-trivial lessons.** A lesson ≥200 characters that produced zero key concepts didn't really get extracted.
- **Substantive summary length.** Catches the title-only-as-summary regression.
- **Per-item grounding gate.** The strongest defense. Each `key_concept` and `definition` is checked against the raw lesson text:
  - STRICT match: the item appears as a substring (case-insensitive) in the raw text. Kept.
  - LOOSE match: at least one token (≥4 chars) of the item appears in the raw text. Kept.
  - DROPPED: neither holds — the item is hallucinated. Removed from the entry before write.
- **Hard fail on >60% ungrounded.** If more than 60% of extracted items get dropped by the grounding gate, the whole entry is rejected. The model is fabricating more than half the extraction; nothing left is trustworthy.

Failures don't write. Drops are surfaced to the user as warnings.

### 2. The Judge (the audit-time scorer)

`backend/agents/judge_agent.py`. A pure-Python function that ranks alternative versions of the same lesson. See [the scoring formula section](#the-judges-scoring-formula).

The Judge was originally an LLM (`mistral`). In practice, mistral returned 10/10 for nearly every summary regardless of measurable quality differences, defeating the entire audit cycle. The pure-Python rewrite picks a winner every time with no model drift, no Ollama call, no judgment-day variance.

### 3. The Orchestrator (the pipeline + audit loop)

`backend/core/ingestion_pipeline.py` runs the five-stage pipeline as a fixed sequence with typed event handoffs. Each stage produces an event the next consumes. If validation fails, memory_write never runs. If summarization throws, the pipeline halts and the error is preserved for the user to see. There is no "agent loop" choosing what to do next — the control flow is a switch statement.

`backend/agents/audit_agent.py::run_one_step` is the same shape: pick the next lesson, route to score-and-archive vs. create-new-version, suppress churning lessons, skip stable groups. The decisions are control flow; the LLM is summoned only when it has something useful to do.

### 4. Memory Writer (the persistence gate)

`backend/core/memory_writer_node.py`. The gate to the file system itself.

- **Atomic writes.** Temp file + rename, so a crash mid-write can't corrupt the SOT.
- **Upsert by `(course, week, lesson)`.** Re-ingesting cleans up rather than duplicating.
- **Obsidian sync as side effect after successful commit.** Never before, never instead. The SOT is canonical; the vault is derived. Vault failures don't fail the ingest.

### The principle

A well-fenced LLM inside a deterministic scaffold becomes reliable as a system, because the unreliable component is wrapped in reliable ones that decide whether to trust each output, when to retry, when to skip, when to score, when to commit.

In the broader field this goes by names like *guardrails*, *compound AI systems* (Zaharia et al., Berkeley AI Research, 2024), or *constrained generation*. It's well-known in production-LLM engineering circles; less prominent in popular AI discourse.

---

## The self-improving audit loop

`backend/agents/audit_agent.py`. A background asyncio task that fires every `AUDIT_INTERVAL_SECONDS` (default 15 minutes).

Each tick executes exactly **one action**:

```
                  ┌─────────────────────────────────────────────────────────────┐
                  │                       run_one_step()                        │
                  └─────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
                  ┌─────────────────────────────────────────────────────────────┐
                  │  Walk 3-node groups, oldest-first                           │
                  │  ├─ If group is churn-suppressed → leave alone, next group  │
                  │  ├─ Score with Judge                                        │
                  │  │   ├─ bottom-two gap < 5.0  → "stable", next group        │
                  │  │   └─ bottom-two gap ≥ 5.0  → archive lowest, RETURN      │
                  │  └─ (all 3-node groups walked)                              │
                  │                                                             │
                  │  Walk 2-node groups, expanding the most-stale               │
                  │  ├─ If lesson is churn-suppressed → skip                    │
                  │  └─ Else → create a new version via summarization, RETURN   │
                  │                                                             │
                  │  If nothing was actionable → noop                           │
                  └─────────────────────────────────────────────────────────────┘
```

**Two guards** prevent the audit from churning unproductively:

### Stable-group guard

If the bottom-two scores in a 3-node group are within `SCORE_GAP_EPSILON = 5.0` points of each other, the audit recognizes the model has converged on this lesson and **leaves the group alone**. No archive, no re-roll. The next tick tries a different group.

Without this guard, the audit would archive whichever version it generated most recently (the tiebreak is "newest first"), then the next tick would generate a new near-identical version, archive that one too — wasting llama3:8b compute indefinitely on a lesson that can't be improved.

### Churn suppression

If a lesson has been archived more than `CHURN_MAX_ARCHIVES = 2` times in the last `CHURN_WINDOW_HOURS = 24` hours, the audit suppresses it entirely. Neither score-and-archive nor create-new-version touches it until the window slides forward.

Both guards apply to both audit actions (score-and-archive and create-new-version), so churning lessons drop out of the audit's attention immediately rather than getting one more cycle of waste.

### Why the audit doesn't break canonical reads

The canonical entry for any lesson is the **oldest** active entry. Audit-generated versions are appended to the SOT array but are not canonical until the older entry is archived. Downstream consumers (graph, list, advisor, quiz, vault, classroom) all use `core/sot_groups.py::canonical_entries` which picks one entry per lesson group. So even when a group temporarily sits at 3 active versions, every downstream view sees exactly one.

---

## The Judge's scoring formula

`backend/agents/judge_agent.py::score_entry`. Pure deterministic, no LLM, no I/O.

```
score = grounded_kc   × 5   −  ungrounded_kc   × 2
      + grounded_defs × 3   −  ungrounded_defs × 1
      + code_blocks   × 2
      + min(summary_len, 800) × 0.05
```

**Grounding** is the same substring + token check the Validation gate uses. A key concept (or definition's term half) is *grounded* if it appears in the raw lesson text; *ungrounded* otherwise.

**Notes on the formula:**

- **Grounded items add; ungrounded items subtract.** This is the system's opinion about hallucination encoded in math. A summary that pads with concepts the lesson never mentions can't beat one that stays anchored.
- **Code blocks are unsigned** (+2 each) because they're either copied verbatim from the source or not — there's no "hallucinated code" failure mode the way there is for concepts and definitions.
- **Summary length has diminishing returns** and caps at 800 characters. Long doesn't beat dense.
- **Same inputs always produce the same score.** Auditable, reproducible, no model drift across time.
- **Free.** No Ollama call, no GPU time.

The formula's tuning was empirical — values were calibrated against observed audit-loop behavior on real data, not derived from theory.

---

## The graph visualization

`frontend/src/components/GraphPanel.jsx` (~2000 lines). The most architecturally involved component in the frontend.

Built on [`react-force-graph-2d`](https://github.com/vasturiano/react-force-graph). The graph view is *not* a passive visualization — it's a real-time animated representation of the SOT.

### Force layers (per d3-force tick)

Six forces, layered:

1. **`charge`** — nodes repel each other. Default `-600`, user-tunable.
2. **`link`** — connected nodes attract. Three link types: hub-spokes (every SOT node to the central Chat hub), concept links (between SOT nodes that share key concepts), audit tethers (a faint dashed line from each canonical entry to its audit-generated satellites).
3. **`center`** — weak pull toward origin (d3 default).
4. **`orbital`** — tangential velocity per non-hub node, producing circular drift around the hub.
5. **`hubExclusion`** — radial inward floor. No node may sit closer than `HUB_EXCLUSION = 250` to origin. Nodes that penetrate get pushed radially outward.
6. **`outerBoundary`** — radial outward ceiling. No canonical SOT node may sit further than `BOUNDARY_RADIUS = 500` from origin. Nodes that overshoot get pushed radially inward. Together with `hubExclusion`, these soft elastic walls give the layout a disc shape.
7. **`symmetry`** — pulls each course's nodes toward its angular slot on a ring around origin, producing a flower-like radial layout rather than a sprawling blob. With "aliveness" on, the whole formation drifts via a slow Lissajous wander.

### Heartbeat pulse system

Every `HEARTBEAT_MS = 3700` ms, the hub fires a fresh wave of pulses. Each pulse is a three-hop cascade:

- **Depth 0** (1400ms): hub → SOT. White comet riding the hub-spoke.
- **Depth 1** (900ms): SOT → up-to-2 random concept-link neighbors. Course-colored gradient comets riding the concept-link edges.
- **Depth 2** (1400ms): neighbor → hub. Course-color-to-white gradient comets riding home.

Total per-cycle: 3700ms. The heartbeat interval is set exactly to the cycle length so the next outbound wave launches the same frame the previous wave's return leg lands — zero overlap, continuous tide.

The pulse position uses **linear easing** within each leg, so the comet maintains constant velocity through handoffs rather than decelerating at each node. This eliminates the "rest" feel of eased-out-then-eased-in handoffs.

### Audit satellites

Audit-generated versions of a canonical lesson render as smaller, dim orbs tethered to the canonical by a faint dashed link. They orbit the canonical (not the hub) and follow it around as it drifts. The `hubExclusion` and `outerBoundary` forces skip them so they can ride slightly past the boundary if their canonical sits near the edge.

---

## Write protection and tunnel sharing

The project supports a "share with friends" posture via Tailscale Funnel.

**Local-only mode.** With `MYAISTRO_WRITE_PASSWORD` unset, all endpoints are unrestricted. This is the default dev mode.

**Owner-write mode.** With `MYAISTRO_WRITE_PASSWORD=<secret>` set, mutating endpoints require an `X-Write-Password` header whose value matches via constant-time comparison (`core/auth.py`):

| Endpoint | Mode | Auth |
|---|---|---|
| `/api/sot/graph`, `/api/sot/list`, `/api/sot/archives`, `/api/stats` | read | open |
| `/api/advisor/chat`, `/api/chat/general`, `/api/quiz/*` | read/inference | open |
| `/api/classroom/guest/*` | ephemeral guest sessions | open |
| `/api/ingest`, `/api/sot/resummarize`, `/api/sot/sync-obsidian`, `/api/audit/run-once` | mutate | **write-password required** |
| `/api/classroom/*` (non-guest) | mutate / persistent | **write-password required** |

The owner unlocks once via the UI; the password persists in browser `localStorage` and is attached to every mutating request via `frontend/src/lib/writeAuth.js::writeFetch`.

**Guest Classroom.** Visitors who land on the Tailscale Funnel URL get an ephemeral Classroom mode — they can take guest sessions, but nothing they do persists, and their sessions never touch the audit history or affect future learning signal. See `backend/api/classroom_guest_controller.py`.

---

## Data persistence

| File | Purpose | Tracked? |
|---|---|---|
| `backend/memory_store.json` | The SOT — all active lesson entries | gitignored |
| `backend/archived_store.json` | Entries the audit cycle has retired | gitignored |
| `backend/visits.json` | Local visit counter | gitignored |
| `backend/classroom/plans/*.json` | Persisted classroom lesson plans (one per plan) | gitignored |
| `backend/classroom/sessions/*.json` | Persisted classroom session records | gitignored |
| `~/Documents/myAIstro-vault/**/*.md` | Obsidian-style markdown mirror | external to repo |
| `backend/.env` | Optional secrets (e.g., `MYAISTRO_WRITE_PASSWORD`) | gitignored |

All writes go through atomic temp-file-and-rename. No partial writes can corrupt the SOT.

---

## Performance characteristics

Measured on M4 Pro / 24GB RAM. Numbers are rough.

| Operation | Latency | Bottleneck |
|---|---|---|
| Load `/api/sot/graph` (~200 lessons) | <100ms | JSON parse + concept-link computation |
| Ingest a typical lesson | 15-30 s | llama3:8b summarization |
| Advisor chat (single query) | 5-15 s first token, then streaming | llama3.2 generation |
| Quiz grading | 3-8 s | mistral grading call |
| Manual audit step (`/api/audit/run-once`) | 0.1-30 s | depends on action: score-and-archive is <1s, create-new-version is 15-30s |
| Background audit cycle | one action per 15 min | rate-limited intentionally |

**Memory.** llama3:8b uses ~5-6GB resident in VRAM. llama3.2 uses ~3GB. mistral uses ~4GB. Ollama will evict idle models to serve another, so the first call after switching roles may incur a model-load cost of 2-5 seconds.

**Scale ceiling.** The SOT is loaded into memory on every API call. With ~200 lessons (~6MB JSON file), this is sub-100ms. Past a few thousand lessons, the design would want to either keep the SOT cached in memory across requests or move to a real database. Not a priority for a personal-tool use case.

---

## Known limitations and future direction

**Things this codebase deliberately doesn't do:**

- No user accounts. Single-tenant.
- No telemetry. Local visitor counter only.
- No external LLM APIs.
- No subscription, no quota tracking.
- No social/collaboration features.

**Architecture is preparing for** (not yet implemented):

- **Span citations.** Advisor / Quiz Grader / Teacher could return structured `{answer, citations: [{event_id, span}]}` with each cited span substring-verified against the raw lesson. The grounding rules already enforce that the model can only reference material it can point at; the next step is making those pointers explicit in the UI. Touches `agents/advisor_agent.py`, `agents/quiz_agent.py::grade_answer`, `agents/teacher_agent.py::phrase_correction`, plus rendering in `ChatPanel.jsx` and `classroom/BeatRenderer.jsx`.
- **Embedding-based paraphrase grounding.** The current grounding check is substring + token-match. Adding an embedding pass (via `nomic-embed-text` through Ollama) would catch paraphrase grounding that the substring check misses. Optional polish.
- **Spaced-repetition surfacing.** The audit produces a deterministic richness score per version; classroom sessions record which CHECK beats a student got wrong. Combining those signals could schedule specific lessons for re-study at the right intervals.
- **Cross-lesson synthesis in Classroom.** The Teacher Aide currently builds plans from one SOT entry. Letting it pull from multiple related entries unlocks real curriculum-style teaching.

**Known sharp edges:**

- Re-ingesting an already-canonical lesson resets that lesson's audit history (the new entry has no `audit_generated` flag, so it becomes the new canonical and the previous audit-generated alternatives stay as siblings until the audit loop walks them).
- The `aliveness` toggle in the Graph view applies a slow Lissajous wander to the whole formation. With many nodes near the outer boundary at peak wander, nodes on the wander-leading edge can briefly pile against the boundary wall. Not currently a problem at ~200 nodes; could become visually noticeable at higher counts.
- Classroom plans depend on `llama3.2` producing valid JSON. The plan validator (`agents/plan_validator.py`) and per-beat salvager in `teacher_aide_agent.py::_salvage_beats` handle most malformed outputs, but extreme JSON corruption may still produce plans with fewer beats than the prompt requested.

---

## Reading order if you're new to the codebase

If you opened this repo cold, the path I'd suggest:

1. **`README.md`** — the front door.
2. **This file (`ARCHITECTURE.md`).**
3. **`backend/core/model_router.py`** — small but distinctive. Shows the three-model architecture in one screen.
4. **`backend/agents/summarization_agent.py`** — the most defended file. Each layer's comment names the captured failure mode it exists to handle.
5. **`backend/core/ingestion_pipeline.py`** — the orchestrator.
6. **`backend/agents/validation_agent.py` + `backend/agents/judge_agent.py`** — the two pure-Python gates that anchor the Deterministic Scaffold.
7. **`backend/agents/audit_agent.py`** — the self-improving loop, including the two stability guards.
8. **`frontend/src/components/GraphPanel.jsx`** — the most architecturally interesting frontend file. Force layers, pulse system, audit tethers, force boundary.
9. **`frontend/src/components/AboutPanel.jsx`** — the in-app user-facing explanation. Comparable scope to this document, different voice.
10. Whatever else catches your eye.

Done in that order, you'll have a complete picture of the system in about an hour.
