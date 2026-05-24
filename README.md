# my-AI-stro

> A local-first, self-improving personal knowledge system that turns school lessons into a queryable Source of Truth — engineered as notes for an open-book final review where LLMs are explicitly disallowed.

<!--
  DEMO PLACEHOLDER
  A walkthrough video and a still screenshot of the graph view will
  land here. Both are deferred — the project is functional and runs
  locally; visual artifacts will be added before the portfolio link
  is shared.

  When ready:
    - Drop the screenshot at docs/img/graph.png
    - Embed: ![my-AI-stro graph view](docs/img/graph.png)
    - Add a video embed (GitHub-hosted MP4 or a third-party host)
-->

> **🚧 Visuals coming.** A walkthrough video and graph screenshot are deferred until recorded — see the comment block above this line in the README source for the embed placeholders.

---

## The story

I'm a second-year student in an AI Software Engineering program. Final reviews in this program are **open-book** — you can bring your notes — but using LLMs during the review is **disallowed** as cheating.

My notes used to be handwritten, word-for-word. The act of writing them by hand was the study — the [generation effect](https://en.wikipedia.org/wiki/Generation_effect) and Mueller & Oppenheimer (2014) both back this up: physically writing forces selective summarization, and that's where the encoding happens.

So I built **my-AI-stro**: a system that captures each lesson into a structured Source of Truth (SOT), surrounds the LLM with deterministic gates to keep the notes honest, and lets me chat with my own notes — but never with an ungrounded LLM during a review. The LLM does the capture work weeks before the review; the cold artifact I carry in is the notes themselves.

The project is also the artifact I'm being trained to produce. I'm in school for AI software engineering, so I engineered AI software. The software produces my notes. The notes are the allowed review aid.

---

## What it is

my-AI-stro is a five-surface app that runs entirely on a single Mac:

| Surface | What you do | Backed by |
|---|---|---|
| **Graph** | See every lesson as an orbital node, color-coded by course, with concept-link edges and an audit pulse | A 2D force-directed view |
| **List** | Read each lesson's structured summary, key concepts, definitions, code blocks, and the original raw text | The SOT |
| **Archives** | The receipts of the self-improving audit — every weaker summary that got displaced over time | The audit log |
| **Classroom** | Be taught the lesson beat-by-beat (intro, exposition, examples, comprehension checks, recap) | Teacher Aide + Teacher agents |
| **About** | An in-app explainer of every architectural decision in this project | Plain prose |

Plus an always-available **Chat** (the central hub on the graph) — a natural-language search over your SOT, refusing to invent material you haven't actually learned.

---

## Key features

- **Local-first.** No cloud, no telemetry, no third-party APIs. LLMs run via [Ollama](https://ollama.com) on the Mac's GPU. The SOT is one JSON file on your machine.
- **Self-improving.** A background audit agent re-summarizes each lesson periodically, scores the resulting versions on a deterministic formula, and naturally rotates the canonical entry toward richer, more-grounded summaries over time.
- **Grounded by construction.** Validation drops hallucinated bullets at write time; the audit judge actively penalizes ungrounded items in its scoring formula. The system has an opinion about hallucination, and it's negative.
- **Trust-isolated.** The model responsible for summarizing your notes does only that. It is never the same model that handles ungrounded general chat. The "this entry was carefully extracted" claim stays clean.
- **Shareable.** A [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) pointed at the dev server gives you a stable public HTTPS URL. Visitors can read, query, and take guest Classroom sessions; only the owner (write-password gated) can ingest or mutate the SOT.
- **Obsidian mirror.** Every validated SOT entry is also written to a Markdown vault, so you can browse the notes in any plain-text editor.

---

## Architecture in a paragraph

A lesson enters via a five-stage **ingestion pipeline**: graph_entry → retrieval → summarization → validation → memory_write. Each stage produces a typed event the next consumes. The LLM (llama3:8b) does the structured extraction; pure-Python validation gates the result against the raw lesson, dropping hallucinated bullets and hard-failing entries where more than 60% of items can't be grounded in the source. Validated entries land in the SOT as a JSON file. A background audit loop re-summarizes lessons every 15 minutes, scores alternatives with a deterministic richness formula that *subtracts* points for ungrounded items, and rotates canonicals toward more-grounded versions over time.

User-facing chat over the SOT runs a parallel **advisor pipeline** with the same streaming-NDJSON shape: retrieval → arc → section ×N → recap → assembly → done. The arc and recap are short framing paragraphs; each section is one focused LLM call (llama3.1:8b) over a single SOT entry. Per-section processing keeps each lesson's grounding intact and gives every section its own output budget — code samples and depth survive that single-shot would compress away. Both pipelines emit the same event vocabulary; both ride the same observability layer in the UI.

Four distinct local LLMs split roles under two architectural rules: **judge separation** (the model that generates a thing is never the model that grades it — Quiz uses llama3.2 to generate questions, mistral to score answers) and **trust isolation** (the model that owns the canonical SOT — llama3:8b for summarization — never also handles ungrounded chat, which routes to llama3.2 instead).

For the full deep dive — pipeline diagram, agent roster, the deterministic-scaffold thesis, force-layer math behind the graph — see **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

For the commenting voice this codebase follows, see **[docs/STYLE.md](./docs/STYLE.md)**.

---

## The Deterministic Scaffold

Four of the eleven named agents in this project don't run an LLM at all. Neither does the orchestrator that runs them. That ratio is deliberate.

The principle: **the LLM is one component, surrounded by deterministic Python fences that decide what to do with its output.** Validation gates writes. The Judge picks audit winners on a fixed formula. The orchestrator decides what runs in what order. Memory Writer commits atomically. The LLM proposes; Python disposes.

That's the answer to the obvious worry about LLM-driven systems — *"but it hallucinates."* Yes, on a per-call basis. But a well-fenced LLM inside a deterministic scaffold becomes reliable as a system, because the unreliable component is wrapped in reliable ones that decide whether to trust each output, when to retry, when to skip, when to score, when to commit.

This framing goes by several names in the broader field: *guardrails*, *compound AI systems* (Zaharia et al., Berkeley AI Research, 2024), *constrained generation*. It's well-established in production-LLM engineering circles, less loud in popular AI discourse.

---

## Quick start

### Prerequisites

- macOS (developed and tested on M4 Pro / 24GB RAM, but should run on any Apple Silicon Mac)
- [Ollama](https://ollama.com) installed and running
- Python 3.12+
- Node.js 20+

### Pull the local models

```bash
ollama pull llama3:8b      # SOT extractor (summarization)
ollama pull llama3.1:8b    # advisor — SOT-grounded chat
ollama pull llama3.2       # quiz / classroom / general chat
ollama pull mistral        # quiz grader (judge-separated)
```

These are the four models the project routes between. Total disk: ~19GB. Each role's model assignment lives in `backend/core/model_router.py` — one constant per role, changeable in a single line.

### Backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --reload --port 8000
```

The backend exposes the FastAPI app on `:8000`. All endpoints are under `/api/*`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Vite serves the React app on `:5173` and proxies `/api/*` to the backend. Open `http://localhost:5173` in a browser. First-time visitors land on the About panel.

### (Optional) Enable write protection

Set the `MYAISTRO_WRITE_PASSWORD` env var before starting the backend:

```bash
export MYAISTRO_WRITE_PASSWORD="your-secret-here"
.venv/bin/uvicorn main:app --reload --port 8000
```

With this set, all mutation endpoints (ingest, re-summarize, sync, manual audit step) require an `X-Write-Password` header. The owner unlocks once via the UI; the password persists in localStorage. Read endpoints (graph, chat, quiz, classroom) remain open. This is the posture used when sharing the app via Tailscale Funnel.

### (Optional) Public access via Tailscale Funnel

```bash
tailscale serve --bg http://127.0.0.1:5173
tailscale funnel --bg 443
```

This publishes `https://<machine-name>.<tailnet>.ts.net` to the public internet, routing back to your local Vite dev server. The Vite config already allow-lists `.ts.net` and `.trycloudflare.com` for `Host` header validation.

---

## Local-first stance, named honestly

my-AI-stro lives entirely on your machine. The SOT is `backend/memory_store.json`. The audit archive is `backend/archived_store.json`. The Obsidian vault mirror is at `~/Documents/myAIstro-vault/`. The LLMs run via Ollama on the Mac's GPU.

Nothing about any lesson you ingest leaves your computer. There are no telemetry pings, no analytics, no model APIs called outside `localhost`. The trade-off, named honestly: local models have a quality ceiling that hosted GPT-4-class models don't. For a personal study tool — where privacy, zero usage caps, and no vendor lock-in matter — that ceiling is acceptable.

---

## AI-assistance disclosure

This project was built in a heavy LLM-pair-programming workflow. Every architectural decision was discussed and refined through long iterative conversations with an LLM coding assistant before being committed. The author drives the vision, names the principles, and decides what's "right"; the LLM helps explore implementations, surface tradeoffs, and accelerate the drafting work.

I'm naming this explicitly because it's central to the project, not despite it. **The skill being demonstrated here is not "I wrote every line by hand" — it's "I can articulate exactly what I want, recognize when the model's first take is wrong, drive the iteration toward the right answer, and maintain a coherent architectural vision across thousands of lines of code."** That's the AI Software Engineering skill my program is training me toward, and this project is the exercise.

The commenting voice you'll find in the code — and the design principles like "trust isolation," "the deterministic scaffold," "the model proposes; Python disposes" — emerged from those conversations. They're mine in the sense that they're the principles I *recognized* as right and chose to enshrine. They're the LLM's in the sense that the language got sharpened in dialogue.

For a portfolio reviewer: that's the honest provenance. The architecture is intentional. The decisions are mine. The drafting was assisted.

---

## What's intentionally not here

Each of these is a choice, not an omission:

- **No user accounts.** Single-tenant by design.
- **No telemetry calling out.** Only a local visitor counter in your own data file.
- **No external LLM APIs.** Ollama on localhost, period.
- **No subscription, no usage caps.** Once running, it costs laptop electricity.
- **No social features.** Not a platform — a personal system that one person can share read access to via a tunnel.

---

## Status

This is an active personal project. The architecture is stable; iteration continues on edges (span citations in chat replies, embedding-based paraphrase grounding, spaced-repetition surfacing from the Classroom session signal). Recent direction is captured in the commit history and the in-app About panel.

If you're reading this as a portfolio piece: **the in-app About panel is the most thorough explanation of every design decision.** Once the app is running, navigate to it. It is itself a written artifact of the engineering thinking behind this project.

---

## Repository layout

```
.
├── backend/                 FastAPI app + Python agents
│   ├── agents/              11 named agents (summarize, validate, judge, audit,
│   │                        advisor, quiz gen/grade, teacher aide/teacher,
│   │                        general chat, memory writer)
│   ├── core/                Pipeline orchestrator, SOT abstractions, auth,
│   │                        Obsidian sync, classroom store
│   ├── api/                 FastAPI controllers (route → agent wiring)
│   └── main.py              App entry point, lifespan hooks, route mounting
├── frontend/                React (Vite) + Tailwind v4 + react-force-graph-2d
│   ├── src/
│   │   ├── components/      One panel per surface (Graph, List, Chat,
│   │   │                    Archives, Classroom, About) + shared bits
│   │   ├── lib/             Small utilities (write-password client, etc.)
│   │   ├── App.jsx          Routing between panels, ingest modal mounting,
│   │   │                    write-password unlock
│   │   └── main.jsx         Vite entry
│   └── vite.config.js       Dev server config, /api/* proxy, host allowlist
├── ARCHITECTURE.md          Engineer-level deep dive
├── docs/STYLE.md            Commenting voice this codebase follows
├── LICENSE                  MIT
└── README.md                This file
```

---

## License

[MIT](./LICENSE) — see LICENSE file for full text.

---

## Acknowledgments

- **[Ollama](https://ollama.com)** for making local LLM serving boring and reliable.
- **[Meta AI](https://ai.meta.com)** for Llama 3 and 3.2.
- **[Mistral AI](https://mistral.ai)** for the Mistral model used as the quiz grader.
- **[Tailscale](https://tailscale.com)** for the Funnel feature that makes sharing this with friends trivial.
- **[react-force-graph](https://github.com/vasturiano/react-force-graph)** by Vasco Asturiano — the graph view rides directly on its 2D renderer.
- The **production-LLM-engineering community** — Simon Willison, Eugene Yan, Hamel Husain, Jason Liu, Chip Huyen, the Berkeley AI Research "compound AI systems" paper — for articulating the patterns this project is an exercise in.

---

Built locally. Lives locally. Yours.
