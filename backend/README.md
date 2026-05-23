# Backend

The server-side of my-AI-stro. FastAPI on uvicorn. Eleven named agents (eight LLM-driven via Ollama, three pure-Python), a five-stage ingestion pipeline, a background audit loop, and atomic JSON persistence.

For the project overview, see the [root README](../README.md). For the engineering rationale behind every design decision, see [ARCHITECTURE.md](../ARCHITECTURE.md).

## Dev server

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --reload --port 8000
```

The `--reload` flag watches every `.py` file under the backend tree and hot-restarts on save, so edits to agent files take effect immediately.

The backend listens on `http://127.0.0.1:8000` and exposes all routes under `/api/*`. The Vite frontend on `:5173` proxies `/api/*` here.

## Required local models

The agents route between three local LLMs via Ollama. Pull them before starting:

```bash
ollama pull llama3:8b
ollama pull llama3.2
ollama pull mistral
```

Model assignments live in `core/model_router.py` — one constant per role. Changing a model is a single-line edit there.

## Write protection (optional)

Set `MYAISTRO_WRITE_PASSWORD` before starting to require an `X-Write-Password` header on mutating endpoints:

```bash
export MYAISTRO_WRITE_PASSWORD="some-secret"
.venv/bin/uvicorn main:app --reload --port 8000
```

Unset, all endpoints are open (dev mode). With it set, read endpoints stay open but ingest / re-summarize / sync / manual-audit-step all 401 without the header. See `core/auth.py`.

## File organization

```
backend/
├── main.py                 FastAPI app, lifespan hooks, route mounting,
│                           startup tasks (kicking off the audit loop)
├── requirements.txt        Python dependencies
├── agents/
│   ├── summarization_agent.py   LLM (llama3:8b) — extract structure from raw text
│   ├── validation_agent.py      Pure Python — pre-write gate, grounding check
│   ├── audit_agent.py           Background self-improvement loop orchestrator
│   ├── judge_agent.py           Pure Python — deterministic richness scorer
│   ├── advisor_agent.py         LLM (llama3.2) — SOT-grounded chat
│   ├── quiz_agent.py            LLM — generate + grade quiz Q&A
│   ├── teacher_aide_agent.py    LLM — build classroom lesson plans
│   ├── teacher_agent.py         LLM — runtime classroom corrections
│   ├── general_chat_agent.py    LLM (llama3.2) — untethered chat
│   └── plan_validator.py        Pure Python — classroom plan schema validator
├── api/
│   ├── ingestion_controller.py       /api/ingest (NDJSON streaming)
│   ├── advisor_controller.py         /api/advisor/chat (NDJSON streaming)
│   ├── general_chat_controller.py    /api/chat/general
│   ├── quiz_controller.py            /api/quiz/* (generate / grade)
│   ├── classroom_controller.py       /api/classroom/* (persistent sessions)
│   └── classroom_guest_controller.py /api/classroom/guest/* (ephemeral)
├── core/
│   ├── model_router.py           Single source of truth for model→role mapping
│   ├── ingestion_pipeline.py     The five-stage orchestrator
│   ├── graph_entry_node.py       Pipeline stage 1
│   ├── retrieval_node.py         Pipeline stage 2 (currently pass-through)
│   ├── memory_writer_node.py     Pipeline stage 5 — atomic persistence
│   ├── memory_reader.py          Read-side of the SOT
│   ├── sot_groups.py             Canonical-entry resolution + atomic file I/O
│   ├── sot_selector.py           SOT retrieval for the advisor (relevance ranking)
│   ├── obsidian_export.py        Mirror the SOT to a markdown vault
│   ├── classroom_store.py        Persistence for classroom plans/sessions
│   ├── auth.py                   Write-password gate (FastAPI dependency)
│   ├── visits.py                 Local visitor counter
│   ├── event_schema.py           Typed events flowing through the pipeline
│   ├── execution_engine.py       Pipeline runner (event loop + handoffs)
│   └── code_format.py            Deterministic HTML formatting for code_blocks
├── scripts/
│   └── check_models.py           CLI sanity check that all required models are pulled
└── classroom/                    Runtime-generated artifacts (gitignored)
    ├── plans/                    Persisted lesson plans (one JSON per plan)
    └── sessions/                 Persisted session records
```

## Data files (all gitignored)

| File | Purpose |
|---|---|
| `memory_store.json` | The active SOT |
| `archived_store.json` | Audit-retired entries |
| `visits.json` | Local visitor counter |
| `classroom/plans/*.json` | Persisted classroom lesson plans |
| `classroom/sessions/*.json` | Persisted classroom session records |
| `.env` | Optional secrets (`MYAISTRO_WRITE_PASSWORD`) |

None of these are committed. They're created at runtime as you use the app.

## Style

See [docs/STYLE.md](../docs/STYLE.md) in the repo root for the commenting voice this codebase follows.
