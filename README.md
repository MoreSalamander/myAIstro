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

## How this got built — AI-assistance disclosure

This project was built in heavy pair-programming with **[Claude Code](https://claude.com/claude-code)**, Anthropic's CLI coding assistant. The specific Claude model used at each point in time is recorded in the commit history itself — every recent commit ends with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` footer naming the model that was Claude on that day. The model has changed across the project's lifetime; the commit log is the source of truth for which, when.

**The decision boundary.** The architectural principles, the design decisions, the project's identity — those are mine. *Trust isolation*, *the deterministic scaffold*, *the model proposes; Python disposes*, the grounding contract as a coherent philosophy — those are positions I recognized as right and chose to enshrine. Claude helped explore implementations, surface tradeoffs, sharpen the prose articulation of each principle, and accelerate the drafting work that turned each decision into working code. The vision and the verification are mine; the keystrokes were collaborative.

**The verification practice.** Every Claude-drafted change went through real verification before becoming a commit. I ran the actual code, smoke-tested endpoints, read advisor outputs against my own lesson notes, scored real responses out of 10, and reverted when something didn't hold up. There's a moment in the project's history where a Claude-drafted prompt change made the advisor's output noticeably worse — I caught it on the very first generation, said so plainly, and we reverted it together in the same session. That's the working pattern: AI drafts at speed; I judge at quality; we iterate until both of us are satisfied.

**What this demonstrates about AI Software Engineering.** The skill being shown here is not "I can ask an AI to write code." It's closer to "I can run a team of one AI engineer effectively" — articulating goals precisely, recognizing when the first take is wrong, driving iteration toward the right answer, and maintaining a coherent architectural vision across thousands of lines without losing the thread. That's the discipline my degree program is training toward, and this project is its exercise. The commenting voice in the source, the principle names, the grounding thesis — all emerged from those sessions. They're mine in the sense that I recognized them as right; they're Claude's in the sense that the language got sharpened in dialogue.

**The git history is the evidence.** Every recent commit carries the `Co-Authored-By: Claude <model>` footer. The pairing is not just claimed in this README — it's enshrined at the git-object level, on every commit, naming the specific model that helped. A reviewer who wants the honest provenance can read it directly from the commit log without trusting any prose.

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
- **Mobile-ready, installable.** Every surface reflows for phones; the Classroom sidebar collapses into a top progress strip; the home screen swaps the interactive graph for an ambient version with action chips and an on-demand pulse button. Ships as a Progressive Web App — "Add to Home Screen" puts an icon next to your other apps and the system launches full-screen. Aimed at the "scroll your SOT in idle moments" use case rather than parity with desktop.
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

## What's intentionally not here

Each of these is a choice, not an omission:

- **No user accounts.** Single-tenant by design.
- **No telemetry calling out.** Only a local visitor counter in your own data file.
- **No external LLM APIs.** Ollama on localhost, period.
- **No subscription, no usage caps.** Once running, it costs laptop electricity.
- **No social features.** Not a platform — a personal system that one person can share read access to via a tunnel.

---

## Status

This is an active personal project. The architecture is stable; iteration continues on edges.

**Recent direction.** The system's most-distinctive feature now is the **curation chain** — `Ingest → SOT → my-AI-stro Chat → Notebook → Classroom`. Each surface listens to the one before it and produces the input the next one needs; every persistent layer is Python-verified against its source via the shared grounding-check primitive. The Notebook + Classroom-listens-to-Notebook integration is the keystone of that chain: a study guide produced by the advisor pipeline can be saved, then taught back beat-by-beat, with all the intermediate artifacts grounded against the same source.

**Teacher v2.** The Teacher agent graduated from runtime-corrections-only to a real runtime agent. The first v2 feature — **raise-hand answers** (the student can ask the teacher a question mid-session, grounded against the lesson source, with the answer Python-verified just like every other persistent layer) — is live. Two v2 features still queued: re-explain on demand (alt phrasing of the current beat), and improv content generation (adaptive remedial beats after failed CHECKs).

**Classroom CHECKs are now multiple choice.** Typed-answer recall stayed in the Quiz surface; in-flow comprehension checks moved to MC. Grading is deterministic — the student picks an option, the backend compares its canonical index to the plan's `correct_index`, no LLM call. Removes a whole class of "the grader was wrong" frustration from the live teaching path and makes each CHECK a clean signal for the gradebook layer.

**Persistent gradebook (data layer).** Every MC CHECK answered in Classroom and every Quiz attempt now appends to a single `backend/gradebook.json` with full identity + first-try flag + score. A pure-Python aggregation module (`core/grading.py`) reads the log and produces per-lesson grades on a "best-session-wins" rule, mastery flags (every CHECK first-try-correct in some session, minimum threshold), and Quiz extra-credit blending capped at +20% over the Classroom base. No visible gradebook UI yet — the data is just accumulating. The UI is the next thing in the queue, designed to render against weeks of real records instead of one-shot test fixtures.

**Mobile experience.** The whole app reflows for phones — compact header with a dropdown nav, full-bleed modals, slide-up LessonDrawer, master-detail surfaces (Notebook, Classroom) collapse their sidebars into top dropdown pickers. The Classroom in-session view becomes a thin top progress strip + full-width beat content. New mobile home screen swaps the interactive graph for an ambient version with action chips (`⚡ Quick Quiz` / `🎓 Teach me something` / `📓 Browse Notebook` / `📚 Browse all lessons`) and an on-demand `✦ Pulse` button — auto-pulses fire every two minutes, the button covers "I want one now." Reachable from a phone on the same tailnet via Tailscale; ships as an installable PWA so the home-screen icon launches full-screen. Aimed at the "scroll your SOT in idle moments instead of doom-scrolling" use case, not desktop parity.

**Quick Quiz mode.** One-tap snacking flow from the mobile home: random canonical lesson, one question, instant grade. Combined random-pick + question-generation endpoint (`/api/quiz/random`) keeps the latency to a single round trip. After a miss (score < 70) the grade card reveals a 2-3 sentence reference answer drawn from the lesson source — closes the "I got it wrong, what should I have said?" loop without a second tap.

**Edges still being iterated.** Span citations in chat replies; embedding-based paraphrase grounding (substring + token-match catches most cases, but a paraphrase-rephrase that passes prompt-grounding can still slip through); MC distractor-quality polish (the validator catches the obvious failure modes — label-prefixed options, question-shaped options, forbidden non-answers — and the controller auto-retries on validation failure, but the prompt continues to iterate on consistently-substantive distractors); the gradebook UI itself; mobile thermal headroom on extended sessions (the home graph still ticks d3 continuously to keep the pulse render loop alive, which leaves room for a future pre-recorded WebM background if the trade-off needs to flip).

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
│   │                        Obsidian sync, classroom store, notebook store,
│   │                        gradebook store + grading math
│   ├── api/                 FastAPI controllers (route → agent wiring)
│   └── main.py              App entry point, lifespan hooks, route mounting
├── frontend/                React (Vite) + Tailwind v4 + react-force-graph-2d
│   ├── src/
│   │   ├── components/      One panel per surface (Graph, List, Chat,
│   │   │                    Archives, Notebook, Classroom, About) + the
│   │   │                    mobile home panel + shared bits
│   │   ├── lib/             Small utilities (write-password client,
│   │   │                    useMediaQuery hook, markdown renderer)
│   │   ├── App.jsx          Routing between panels, ingest modal mounting,
│   │   │                    write-password unlock, mobile/desktop layout fork
│   │   └── main.jsx         Vite entry
│   ├── public/              Static assets — PWA manifest + brand icons
│   │                        (regenerate via scripts/generate-pwa-icons.py)
│   ├── scripts/             Build-time helpers (PWA icon generator)
│   └── vite.config.js       Dev server config (binds 0.0.0.0 for LAN/tailnet
│                            access), /api/* proxy, host allowlist
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

- **[Anthropic](https://anthropic.com)** and **[Claude Code](https://claude.com/claude-code)** — the AI pair-programmer that helped move this project from idea to working system. Full disclosure of how that collaboration worked lives in [How this got built](#how-this-got-built--ai-assistance-disclosure) above; the commit log names the specific Claude model on every co-authored commit.
- **[Ollama](https://ollama.com)** for making local LLM serving boring and reliable.
- **[Meta AI](https://ai.meta.com)** for Llama 3 and 3.2.
- **[Mistral AI](https://mistral.ai)** for the Mistral model used as the quiz grader.
- **[Tailscale](https://tailscale.com)** for the Funnel feature that makes sharing this with friends trivial.
- **[react-force-graph](https://github.com/vasturiano/react-force-graph)** by Vasco Asturiano — the graph view rides directly on its 2D renderer.
- The **production-LLM-engineering community** — Simon Willison, Eugene Yan, Hamel Husain, Jason Liu, Chip Huyen, the Berkeley AI Research "compound AI systems" paper — for articulating the patterns this project is an exercise in.
- **Maestro College / University** — for the AI Software Engineering program that's training me toward the career this project is an exercise of. Education to a brighter future.

---

Built locally. Lives locally. Yours.
