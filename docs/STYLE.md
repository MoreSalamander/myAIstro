# Commenting and Documentation Style

The voice this codebase follows. Both a working reference for contributors and a portfolio artifact in its own right.

The intent isn't bureaucratic — it's to encode the *thinking* behind decisions in the code itself, so reading the source is also reading the engineering log. Most of these conventions emerged organically from working in this project; this document codifies them retroactively so future additions stay coherent.

---

## The core principles

### 1. Comments answer "why," not "what"

The code already says what it does. Comments earn their space by explaining *why this and not the obvious alternative*, what failure mode they're guarding against, or what tradeoff was made.

**Good:**
```python
# d3-force caches per-node and per-link arrays inside `initialize()`.
# Setting strength/distance only updates the function the force will
# use on NEXT initialize — without an explicit reinit, slider changes
# were silently no-op'ing. Re-call initialize after each parameter change.
const nodes = graphData.nodes;
```

**Bad:**
```python
# Get the nodes
const nodes = graphData.nodes;
```

The first explains a non-obvious behavior of the d3-force library and why we work around it; the second restates the code. The second comment should not exist.

### 2. Capture specific observed failure modes, not abstract concerns

When a defense exists because the LLM produced a specific malformed output that broke a specific case, *say so*. Vague "in case the model misbehaves" comments are weaker signal than "Observed on llama3:8b 'Arrow functions (=>)' — model emitted the lesson title followed by raw JSON inside a markdown fence."

**Good:**
```python
# Total failure — preserve the raw output so the user / log can
# inspect what the model produced. Observed: model occasionally
# returns Python-style single-quoted "JSON" that no parser will
# accept; this is the only signal that explains the validation FAIL.
```

**Bad:**
```python
# Handle parse errors
```

Specificity is the difference between code that *trusts* the comment and code that *checks the code* because the comment is useless.

### 3. Constants carry calibration history when the value isn't obvious

If a number was chosen empirically — by watching the system run and observing what worked — its comment should say what it was originally and why it was changed. This is the difference between "magic number" and "calibrated value."

**Good:**
```python
# Score-gap epsilon for the "stable" guard. If the two lowest-scoring
# versions of a 3-node group are within this many points of each other,
# the audit has no signal — archiving the "lowest" would just delete a
# version that's effectively identical to the next one up.
#
# 5.0 is calibrated to the new signed-grounding judge's quality units:
#   +5  one extra grounded key_concept
#   +3  one extra grounded definition
#   +2  one extra code block
#   +7  one concept flipping from ungrounded (-2) to grounded (+5)
# A gap of < 5 means the difference between "lowest" and "next-lowest"
# is at most one unit of any real improvement. (Initial value was 1.0;
# raised after observing the audit churn lessons with 1-14 point gaps
# where every newly-generated version landed below v2 — re-rolling
# wasn't actually improving anything.)
SCORE_GAP_EPSILON = 5.0
```

**Bad:**
```python
SCORE_GAP_EPSILON = 5.0  # epsilon for stable check
```

The good version means a future maintainer (or the reader of a portfolio review) can answer "why 5.0?" without spelunking through git history.

### 4. Defensive code paths are labeled as defenses

When code is doing something defensive — handling a specific class of error, working around a known library bug, gating against a known model failure — name it as a defense. "This is the gate against X" reads differently than commented-out wishful thinking.

**Good:**
```python
# Salvage path: if whole-document parse produced no beats (truncation
# mid-unicode-escape, model emitted non-JSON like `B = "..."`, etc.),
# regex out individual beat objects from the raw text and try to
# parse each one independently. We keep the ones that survive and
# drop the malformed tail.
if not beats_raw:
    beats_raw = _salvage_beats(raw_text)
```

This pattern reads as: "here is a defense; here is what it defends against; here is why we made it lossy rather than throwing."

### 5. No dead code, no commented-out blocks

Old code that's no longer used gets deleted, not commented out. Git remembers. If a code block needs to be temporarily disabled, use a feature flag or remove it entirely.

The exception: if a deprecated artifact remains in the codebase for backward compatibility (e.g., the deprecated `JUDGE = "mistral:latest"` in `model_router.py`), mark it explicitly:

```python
# JUDGE: deprecated. The audit pipeline now uses a deterministic Python
# scorer (agents/judge_agent.py::score_entry) instead of an LLM judge.
# Kept as a reference if you ever want to A/B against an LLM rubric.
JUDGE = "mistral:latest"
```

---

## File-level conventions

### Top-of-file docstrings

Every source file gets a top-of-file docstring (Python `"""..."""` or JS `/** ... */`). The structure:

1. **One-line summary** — what this module is, in a single sentence.
2. **Purpose paragraph** — why this module exists, what role it plays in the larger system.
3. **Design decisions block** (if applicable) — bulleted list of non-obvious choices.
4. **Behaviors / contracts** (if applicable) — what callers can rely on.

**Example (`backend/agents/judge_agent.py`):**

```python
"""
Judge Agent — deterministic richness scorer for the audit pipeline.

Original design used mistral as an LLM-as-judge. In practice the model
returned 10/10 for nearly every summary regardless of measurable
quality differences, which defeats the purpose: the audit pipeline
needs to be able to TELL which summarization captured more of the
lesson, so the richer one stays canonical.

This implementation drops the LLM and scores deterministically on the
exact dimensions that make a summary richer:

  - Key-concepts count (most important — concepts ARE the extraction)
  - Definitions count
  - Code-blocks count
  - Summary length (with diminishing returns)
  - Grounding bonus — fraction of key_concepts that actually appear as
    substrings in the raw_text, so a summary that invents concepts not
    in the source is penalized vs one that stays anchored.

Properties:
  - Pure function. Same entry → same score every call.
  - No Ollama dependency, no network, no model drift.
  - Higher score = richer summary.
"""
```

This pattern lets a reviewer who opens the file fresh understand: what this is, why it exists, what choices were made, and what they can rely on — in about 30 seconds.

### Section banners in long files

Files over ~300 lines get section banners. Two styles:

**Python:**
```python
# =========================================================
# PUBLIC ENTRYPOINTS
# =========================================================
```

**JSX/JS:**
```javascript
// ============================================================
//  NODE  — core disc + recency-scaled glow + selection ring
// ============================================================
```

These let a reader skim-navigate a long file by visually locating regions, rather than scrolling and reading.

---

## Inline conventions

### Function/component docstrings

Public functions and exported components get a brief docstring describing what they take and return, plus any side effects or non-obvious behavior.

**Python:**
```python
def score_entry(entry: Dict) -> float:
    """
    Return a numeric richness score for one SOT entry. Higher = richer.
    Pure deterministic — no LLM, no I/O.
    """
```

**JSX:**
```jsx
/**
 * ArchivesPanel — view of SOT entries that have been retired by the
 * audit agent. Newest-archived first, with the score that pushed each
 * one out and a click-to-expand for the full retired summary.
 *
 * The data here is read-only by design. Archives are not editable, not
 * re-summarizable, and not exposed to the rest of the app (advisor /
 * graph / quiz all see only canonical entries).
 */
export default function ArchivesPanel({ dataVersion = 0 }) { ... }
```

Private helpers don't need docstrings unless their behavior isn't obvious from the name.

### Type hints (Python)

Type-hint every function that's part of a stable API surface (anything imported by another file). Use `from typing import Dict, List, Iterable, Optional` for collections; bare types for primitives. Module-private helpers can skip type hints if they're trivial.

```python
def stream_chat(query: str, entries: List[Dict]) -> Iterable[str]:
    ...

def _internal_helper(x):  # OK to skip on private trivial helpers
    return x * 2
```

### JSDoc on JS component props

React components that take non-trivial props should document the prop shape via JSDoc, especially when the prop is an object with multiple fields:

```jsx
/**
 * ArchiveCard — single archived-entry card in the Archives list.
 *
 * @param {Object}   props
 * @param {Object}   props.entry            The archived SOT entry
 * @param {boolean}  props.expanded         Whether the card is in expanded state
 * @param {Function} props.onToggle         Click handler that toggles expansion
 */
function ArchiveCard({ entry, expanded, onToggle }) { ... }
```

Trivial single-prop components can skip this.

---

## Anti-patterns

Things to *not* do:

- **Don't restate the function name in the docstring.** `# returns the user's name` on a function called `get_user_name()` is noise.
- **Don't add `TODO` without context.** A `TODO` that doesn't include the date, the reason, and the conditions for resolution is a bug-in-waiting. Either fix it or leave it out.
- **Don't add comments that lie.** A wrong comment is worse than no comment. If you change behavior, update the comment in the same commit.
- **Don't comment trivial code.** `# loop through items` on a `for x in items:` is noise. The comment should add information the code can't.
- **Don't write generic "in case of error" defensive comments.** Either name the specific error you're guarding against or drop the comment.
- **Don't paste AI-generated boilerplate.** Comments written by AI assistants that pattern-match what a comment "should look like" without engaging with the actual code's intent are recognizable to careful reviewers. If a comment is going to live in the codebase, it should reflect understanding — not template-filling. *(See [README §AI-assistance disclosure](../README.md#ai-assistance-disclosure) for this project's specific stance.)*

---

## Commit messages

The commit voice in this repo follows the same principles: short, specific, names the thing that changed and ideally why.

**Good:**
```
chunk long lessons so they fit the model's context window
switch ADVISE to llama3.2 for course-wide context room
drop format=json from summarization; trust prompt + repair instead
repair truncated JSON from the LLM instead of falling through
```

**Bad:**
```
Update files
Fix bug
WIP
Refactor
```

Lower-case, present tense, no period. The history then reads as a war diary of real problems, not a series of housekeeping notes.

---

## Quick checklist when adding new code

Before committing new code:

- [ ] Top-of-file docstring exists and explains *why* this file exists.
- [ ] Section banners present if the file is over ~300 lines.
- [ ] Public functions have docstrings with their contract.
- [ ] Type hints (Python) or JSDoc (JS) on public surfaces.
- [ ] Non-obvious constants have calibration comments.
- [ ] Defensive code paths labeled as defenses, with the specific failure mode named.
- [ ] No dead code, no commented-out blocks, no `TODO` without context.
- [ ] Commit message is specific and lowercase, like the existing log.

---

## Why this voice?

The system this codebase implements is built on the principle that the LLM is *one component* surrounded by deterministic Python that decides when to trust each output. The commenting voice mirrors that: don't trust that the *next* engineer reading this code will reconstruct the reasoning from scratch — encode the reasoning where they'll find it.

When this style is applied consistently, reading the code is reading the engineering log. You don't need a separate set of docs to understand why decisions were made — the decisions explain themselves where they live.
