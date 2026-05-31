"""
Teacher Aide Agent — produces a complete classroom Lesson Plan from a
single SOT entry. Pure planning step. Plays no role at runtime; once
the plan is generated and validated, it's frozen and the Teacher
component just plays it back.

Output schema (a dict matching the Plan JSON the frontend consumes):

  {
    "plan_id": null,                    # filled in by classroom_store.save_plan
    "lesson_event_id": str,
    "source_lesson": {course, week, lesson},
    "created_at": null,                 # filled in on save
    "model": "llama3.2:latest",
    "estimated_duration_min": int,
    "beats": [
      {
        "beat_id": str,
        "type": one of INTRO / EXPOSITION / EXAMPLE / CHECK / RECAP / TRANSITION,
        "content": str,
        # CHECK-only (multiple choice):
        "question": str,
        "options": [str, str, str, str],   # exactly 4
        "correct_index": int,              # 0-based; correct option lives at index 0
                                           # in the plan, frontend shuffles at render
        "explanation": str,                # why the correct answer is right
        # EXAMPLE-only:
        "code": Optional[str], "explanation": str,
      }, ...
    ]
  }

The agent uses the same defensive JSON-handling pattern as the
summarization agent: free-form generation with permissive parsing +
regex repair, then a separate validator decides whether the result is
fit to persist.
"""

import json
import re
import uuid
from datetime import datetime
from typing import Dict, Iterable

import ollama

from core.model_router import TEACH_PLAN


BEAT_TYPES = {"INTRO", "EXPOSITION", "EXAMPLE", "CHECK", "RECAP", "TRANSITION"}

# Beat types we deterministically inject AFTER the LLM returns. These
# don't go through the LLM (it can't reproduce verbatim code reliably),
# so they live outside the BEAT_TYPES filter that gates LLM output.
# The validator still accepts them through its own per-type branches.
TYPING_PRACTICE = "TYPING_PRACTICE"


# Minimum length for a code block to be worth promoting to a typing
# practice beat. One-liners ("x = 1") are too short to be useful muscle
# memory practice and just add friction. Tuned by hand — long enough
# to require thinking, short enough to not feel like punishment.
_MIN_TYPING_PRACTICE_CHARS = 25


def stream_plan(entry: Dict) -> Iterable[Dict]:
    """
    Streaming generator. Yields events:
      {"type": "model_start"}
      {"type": "raw_chunk", "value": "..."}      (many)
      {"type": "raw_done", "text": "<full raw response>"}
      {"type": "error", "message": "..."}

    The controller parses the final raw text into a Plan, validates it,
    persists it on success, and streams the resulting Plan back. This
    separation keeps streaming concerns out of the parse/validate path.
    """
    prompt = _build_prompt(entry)
    yield {"type": "model_start"}
    try:
        full = []
        for chunk in ollama.chat(
            model=TEACH_PLAN,
            messages=[{"role": "user", "content": prompt}],
            options={
                "num_ctx": 16384,
                "num_predict": 8192,
                "temperature": 0.3,
            },
            stream=True,
        ):
            content = (chunk.get("message") or {}).get("content") or ""
            if not content:
                continue
            full.append(content)
            yield {"type": "raw_chunk", "value": content}
        yield {"type": "raw_done", "text": "".join(full)}
    except Exception as e:
        yield {"type": "error", "message": str(e)}


def parse_plan(raw_text: str, entry: Dict) -> Dict:
    """
    Convert the model's raw output into a Plan dict. Reuses the
    permissive-JSON-parsing pattern from summarization (peel off prose
    preambles, repair truncations, regex fallback). Returns a dict
    even if some fields had to be filled in defensively; the validator
    decides whether the result is ACCEPTABLE.
    """
    parsed = _parse_or_repair(raw_text) or {}

    beats_raw = parsed.get("beats") or []

    # Salvage path: if whole-document parse produced no beats (truncation
    # mid-unicode-escape, model emitted non-JSON like `B = "..."`, etc.),
    # regex out individual beat objects from the raw text and try to
    # parse each one independently. We keep the ones that survive and
    # drop the malformed tail.
    if not beats_raw:
        beats_raw = _salvage_beats(raw_text)
    beats = []
    for i, b in enumerate(beats_raw):
        if not isinstance(b, dict):
            continue
        bt = (b.get("type") or "").upper()
        if bt not in BEAT_TYPES:
            continue
        beat = {
            "beat_id": b.get("beat_id") or f"beat-{i}-{uuid.uuid4().hex[:6]}",
            "type": bt,
            "content": _ensure_str(b.get("content")) or "",
        }
        # Per-type completeness filter — silently drop beats too broken
        # to play. The plan as a whole still has to pass validation
        # afterward, but a single malformed beat doesn't kill the run.
        if bt == "CHECK":
            beat["question"] = _ensure_str(b.get("question")) or beat["content"]
            options = _ensure_str_list(b.get("options"))
            # Coerce correct_index — model occasionally emits it as a string
            # ("0") or as a 1-based ordinal. We normalize to a 0-based int
            # in range; out-of-range or non-int gets the beat dropped below.
            ci_raw = b.get("correct_index")
            try:
                correct_index = int(ci_raw) if ci_raw is not None else -1
            except (TypeError, ValueError):
                correct_index = -1
            # Coerce mastery_goal_index — present only when the lesson has
            # mastery_goals AND the model honored the binding rule. We
            # preserve None for legacy plans / lessons without goals so
            # the validator can distinguish "didn't have goals" from
            # "had goals but model omitted the index."
            mgi_raw = b.get("mastery_goal_index")
            if mgi_raw is None:
                mastery_goal_index = None
            else:
                try:
                    mastery_goal_index = int(mgi_raw)
                except (TypeError, ValueError):
                    mastery_goal_index = None
            beat["options"] = options
            beat["correct_index"] = correct_index
            beat["mastery_goal_index"] = mastery_goal_index
            beat["explanation"] = _ensure_str(b.get("explanation")) or ""
            # Can't play an MC CHECK without a question, ≥3 options, a valid
            # correct_index, and an explanation. Drop malformed beats here so
            # the validator only sees structurally-complete ones.
            if not beat["question"].strip():
                continue
            if len(options) < 3 or len(options) > 5:
                continue
            if correct_index < 0 or correct_index >= len(options):
                continue
            if not beat["explanation"].strip():
                continue
        elif bt == "EXAMPLE":
            beat["code"] = _ensure_str(b.get("code"))
            beat["explanation"] = _ensure_str(b.get("explanation")) or beat["content"]
            # Need at least one of content/explanation/code or there's nothing to render
            if not beat["content"].strip() and not (beat.get("explanation") or "").strip() and not (beat.get("code") or "").strip():
                continue
        else:
            # INTRO / EXPOSITION / RECAP / TRANSITION need content
            if not beat["content"].strip():
                continue
        beats.append(beat)

    # Deterministic post-processing: inject TYPING_PRACTICE beats from
    # the entry's verbatim code_blocks (extracted during ingestion).
    # The LLM never sees the typing-practice content — we don't trust
    # any model to reproduce a code snippet character-perfectly, and
    # the SOT already holds the canonical version. Insertion happens
    # before the RECAP beat (so practice is the last skill before the
    # closing summary) or at the end if no RECAP exists.
    beats = _inject_typing_practice_beats(beats, entry)

    return {
        "plan_id": None,
        "lesson_event_id": entry.get("event_id"),
        "source_lesson": {
            "course": entry.get("course"),
            "week": entry.get("week"),
            "lesson": entry.get("lesson"),
        },
        "created_at": None,
        "model": TEACH_PLAN,
        "estimated_duration_min": parsed.get("estimated_duration_min")
            or _estimate_duration(beats),
        "beats": beats,
    }


def _inject_typing_practice_beats(beats: list, entry: Dict) -> list:
    """
    Append one TYPING_PRACTICE beat per qualifying code_block, placed
    just before the RECAP. The code is verbatim from the SOT — never
    LLM-generated — so the user practices the exact syntax that was
    in the lesson source.

    Filter rules:
      - skip blocks shorter than _MIN_TYPING_PRACTICE_CHARS (one-liners
        aren't useful muscle memory)
      - dedup byte-identical blocks (a lesson sometimes shows the same
        snippet twice for different teaching purposes)
      - cap at 5 practice beats per plan so a code-heavy lesson doesn't
        balloon a 10-minute Classroom session into 30 minutes of typing
    """
    code_blocks = entry.get("code_blocks") or []
    if not isinstance(code_blocks, list) or not code_blocks:
        return beats

    seen = set()
    practice_beats = []
    for raw in code_blocks:
        if not isinstance(raw, str):
            continue
        code = raw.strip("\n")
        if len(code.strip()) < _MIN_TYPING_PRACTICE_CHARS:
            continue
        key = code.strip()
        if key in seen:
            continue
        seen.add(key)
        practice_beats.append({
            "beat_id": f"typing-{len(practice_beats)}-{uuid.uuid4().hex[:6]}",
            "type": TYPING_PRACTICE,
            "content": (
                "Type out this snippet to lock in the syntax. "
                "Wrong characters won't block you — keep going."
            ),
            "code": code,
        })
        if len(practice_beats) >= 5:
            break

    if not practice_beats:
        return beats

    # Insert before the RECAP beat (the closing summary should still be
    # the last thing the student sees). If there's no RECAP, append.
    insert_at = len(beats)
    for i, b in enumerate(beats):
        if isinstance(b, dict) and (b.get("type") or "").upper() == "RECAP":
            insert_at = i
            break
    return beats[:insert_at] + practice_beats + beats[insert_at:]


# =========================================================
# PROMPT
# =========================================================
def _build_prompt(entry: Dict) -> str:
    course = entry.get("course") or ""
    week = entry.get("week") or ""
    lesson = entry.get("lesson") or ""
    raw = entry.get("raw_text") or ""
    summary = entry.get("summary") or ""
    key_concepts = ", ".join(entry.get("key_concepts") or [])
    definitions = "\n".join(f"  - {d}" for d in (entry.get("definitions") or []))
    code_blocks = "\n\n".join(entry.get("code_blocks") or [])
    mastery_goals_list = entry.get("mastery_goals") or []
    mastery_goals = "\n".join(f"  - {g}" for g in mastery_goals_list)

    # Mastery-goals section in the prompt — included only when the
    # entry actually has goals (extracted deterministically from the
    # source). When present, they REPLACE the LLM's judgment about
    # what to quiz on. The CHECK rules below reference this section
    # explicitly so the model can't drift to off-topic questions.
    mastery_goals_block = (
        f"\nLESSON MASTERY GOALS (extracted verbatim from the source):\n{mastery_goals}\n"
        if mastery_goals_list else ""
    )

    # CHECK-binding instruction is conditional. When mastery_goals
    # exist, CHECKs are bound 1:1 to them by position — much stricter
    # than the original "aim to cover" version, because verification
    # showed the LLM ignored loose binding and produced off-topic
    # CHECKs. When mastery_goals are absent (legacy entries), fall
    # back to summary/key_concepts-based generation.
    if mastery_goals_list:
        n_goals = len(mastery_goals_list)
        # Build a numbered list the prompt can refer to by position,
        # AND a per-goal worked example showing exactly what the CHECK
        # should look like. The worked examples are the strongest
        # available constraint — they show the model the desired shape
        # in concrete terms instead of asking it to infer from rules.
        numbered_goals = "\n".join(
            f"  Goal #{i}: {g}" for i, g in enumerate(mastery_goals_list)
        )
        goal_to_check_map = "\n".join(
            f"  - The CHECK with mastery_goal_index: {i} tests Goal #{i} (\"{g[:80]}\")"
            for i, g in enumerate(mastery_goals_list)
        )
        check_binding_rule = f"""
MASTERY GOAL BINDING (REPLACES general CHECK selection — this is a HARD constraint that overrides the JSON template above):

The {n_goals} mastery goals are the curriculum's authoritative "what to master"
list. CHECK beats are bound 1:1 to mastery goals by position:

{numbered_goals}

⚠️ COUNT OVERRIDE: The JSON template above shows 2 CHECK beats as a shape example,
but THIS LESSON requires EXACTLY {n_goals} CHECK beats — one per mastery goal.
IGNORE the template's count; honor the binding rule's count.

Required CHECK-to-goal mapping (EVERY one of these MUST appear in your output):

{goal_to_check_map}

Each CHECK beat MUST include the field `mastery_goal_index` (integer 0–{n_goals - 1})
indicating which mastery goal it tests.

The CHECK's "question" must DIRECTLY test the bound goal — restate the goal as
a question the student must answer. Worked example using THIS lesson's Goal #0:

  Goal #0 text:  "{mastery_goals_list[0]}"
  GOOD question: A direct rephrasing such as "How do you do <Goal #0's action>?"
  BAD question:  Anything that asks about a related-but-different concept from
                 elsewhere in the lesson body.

Each option (correct + distractors) must be a complete, accurate sentence
that COULD be answering the question. The correct option must reflect what
the lesson says about THAT SPECIFIC goal — not adjacent material.

Compliance checklist before you return the JSON (do this mentally):
  ✓ Did I generate EXACTLY {n_goals} CHECK beats? (Not 2. Not 3. {n_goals}.)
  ✓ Does each CHECK have a mastery_goal_index field (0 through {n_goals - 1})?
  ✓ Do the indices cover every goal exactly once (no duplicates, no gaps)?
  ✓ Does each question directly test the goal at its mastery_goal_index?

If any answer is "no," fix it before returning.
"""
    else:
        check_binding_rule = ""

    return f"""You are the Teacher Aide for a personal classroom session. Build a structured Lesson Plan for a 5-10 minute classroom session covering ONE lesson. Stay strictly within the lesson's content; do not invent material that isn't present in the source.

Return a single JSON object with this exact shape. Output ONLY the JSON object — no commentary, no markdown fences, no prose before or after.

{{
  "estimated_duration_min": <integer 5..10>,
  "beats": [
    {{ "type": "INTRO",      "content": "1-2 sentence opening that frames what the student will learn" }},
    {{ "type": "EXPOSITION", "content": "2-4 sentences explaining a core concept from the lesson" }},
    {{ "type": "EXAMPLE",    "content": "1 sentence framing", "code": "optional verbatim code from the lesson", "explanation": "2-3 sentences explaining the example" }},
    {{ "type": "EXPOSITION", "content": "explain another concept" }},
    {{ "type": "CHECK",      "content": "brief framing of the multiple-choice question",
                              "question": "the actual question",
                              "options": ["the correct answer (always at index 0)", "plausible wrong answer", "plausible wrong answer", "plausible wrong answer"],
                              "correct_index": 0,
                              "mastery_goal_index": 0,
                              "explanation": "1-2 sentences explaining why the correct answer is right, drawn from the lesson" }},
    {{ "type": "EXPOSITION", "content": "another concept if useful" }},
    {{ "type": "CHECK",      "content": "...", "question": "...", "options": ["...", "...", "...", "..."], "correct_index": 0, "mastery_goal_index": 1, "explanation": "..." }},
    {{ "type": "RECAP",      "content": "3-5 sentence summary of takeaways" }}
  ]
}}

CRITICAL: The shape above is a TEMPLATE for the JSON structure only. Do NOT copy the placeholder text ("plausible wrong answer", "the actual question", "1-2 sentence opening that frames what the student will learn", etc.) into your output. Replace every placeholder with real content drawn from the lesson below.

REQUIRED PER-BEAT FIELDS — MISSING ANY OF THESE INVALIDATES THE PLAN:
- Every CHECK beat MUST include ALL of: a non-empty "question" string, an "options" array of EXACTLY 4 strings, a "correct_index" integer (always 0 — see ordering rule below), and a non-empty "explanation" string. ADDITIONALLY, when the lesson has mastery goals (see binding rule below if present), each CHECK MUST include a "mastery_goal_index" integer indicating which goal it tests.
- Every EXAMPLE beat MUST include at least one of: "content", "explanation", or "code".
- Every INTRO / EXPOSITION / RECAP / TRANSITION beat MUST include a non-empty "content" string.

CHECK QUESTION RULES (multiple choice):
- The "question" field is the actual question. It must be a complete sentence that the student is being asked, usually ending in a question mark. It is NOT a fragment, NOT meta-text like "Pick the right answer", NOT one of the answers. The question describes WHAT is being asked; it does not include any of the options.
- Worked example of the right SHAPE (use the SHAPE only, do NOT copy this content):
    GOOD:
      "question": "When you use a stable id from your data as the key prop instead of the array index, what does React gain?"
      "options": [
        "It can correctly identify which items moved or changed when the list updates",
        "It can render the list in alphabetical order automatically",
        "It re-renders the entire list every time, but faster",
        "It avoids needing a key prop at all on future renders"
      ]
      "correct_index": 0
      "explanation": "A stable id lets React match items across renders, so it can update only what changed instead of re-creating the list."
    BAD (DO NOT DO):
      "question": "stable id from data"                          <- fragment, not a question
      "options": ["A. stable id", "B. array index", ...]         <- label-prefixed, not bare answers
      "options": ["What is a key prop?", "stable id", ...]       <- question shoved into options
- The "options" array MUST contain exactly 4 ANSWER strings. Each entry is a candidate ANSWER to the question — NOT the question itself, NOT a meta-instruction. Each option is plain text describing one possible answer (e.g. "Inside the <head> because it's metadata, not visible content"). Each option must read as a self-contained answer.
- Options MUST NOT be prefixed with labels like "A.", "B.", "(1)", "1)", "- ", or "Option 1:". The frontend adds A/B/C/D labels at render time. Your options are bare answer text.
- ALWAYS put the correct answer first in the "options" array, and ALWAYS set "correct_index" to 0. The frontend shuffles the display order at render time, so the student never sees them in this canonical order — your job is just to list correct-first so the structure is unambiguous.
- Each distractor MUST be a PLAUSIBLE wrong answer — not obviously off-topic. A student who didn't fully understand the lesson should genuinely consider it. Pick each distractor from one of these patterns:
    (a) A common misconception the lesson explicitly corrects or warns against.
    (b) A correct fact about a RELATED-BUT-DIFFERENT concept from the lesson (e.g. if the question is about `append()`, a distractor describing what `extend()` does).
    (c) A subtly-wrong version of the correct answer (wrong scope, off-by-one, swapped subject/object, returns the wrong type).
- NEVER use "None of the above", "All of the above", or generic non-answers ("It depends", "Nothing happens", "Maybe", "I'm not sure"). For yes/no questions, use specific qualified statements ("Yes, because the parent owns the data") rather than bare "Yes" / "No".
- Every option (correct AND distractors) must mention concepts, terms, or behaviors that appear in the lesson source — distractors that invent unrelated topics give the question away.
- Keep options the same approximate length and grammatical shape. A correct answer that's obviously longer than the distractors leaks the right one.
- The "explanation" appears AFTER the student answers and tells them why the correct answer is right — ground it in the lesson, 1-2 sentences.
{check_binding_rule}
Rules:
- Required structure: at least 1 INTRO, at least 2 EXPOSITION beats, at least 1 EXAMPLE beat, at least 2 CHECK beats (each fully MC per above), exactly 1 RECAP at the end.
- 6 to 12 beats total. Aim for 8.
- CHECK questions must be answerable from the lesson content; the correct answer must come from the lesson.
- Do not invent code samples; if EXAMPLE has code, copy it verbatim from the lesson's code blocks.
- Write in plain, friendly, instructor-style prose. Not bullet points.

LESSON METADATA:
  Course: {course}
  Week: {week}
  Lesson: {lesson}

LESSON SUMMARY:
{summary}

LESSON KEY CONCEPTS:
{key_concepts}

LESSON DEFINITIONS:
{definitions}

LESSON CODE BLOCKS:
{code_blocks}
{mastery_goals_block}

LESSON RAW TEXT:
{raw}
"""


# =========================================================
# PARSE / REPAIR (mirrors the summarization agent's defenses)
# =========================================================
_NESTED_PREFIXES = (
    "Here is the JSON object:",
    "Here is the JSON:",
    "Here is the lesson plan:",
    "Here is the plan:",
    "Here's the JSON:",
    "Here's the plan:",
)


def _strip_wrappers(text: str) -> str:
    text = text.strip()
    for p in _NESTED_PREFIXES:
        if text.startswith(p):
            text = text[len(p):].lstrip()
            break
    fence_idx = text.find("```")
    if fence_idx >= 0 and "{" not in text[:fence_idx]:
        text = text[fence_idx:].lstrip()
    if text.startswith("```"):
        rest = text[3:]
        nl = rest.find("\n")
        if nl >= 0:
            head = rest[:nl].strip()
            if not head or re.fullmatch(r"[A-Za-z][A-Za-z0-9+\-]*", head):
                text = rest[nl + 1:]
            else:
                text = rest
    stripped = text.rstrip()
    if stripped.endswith("```"):
        text = stripped[:-3].rstrip()
    brace_idx = text.find("{")
    if brace_idx > 0:
        text = text[brace_idx:]
    return text.strip()


def _salvage_beats(raw_text: str) -> list:
    """
    Walk the raw text looking for substrings that start with `{ "type":`
    and end at the matching closing brace (depth-tracked, string-aware).
    Try json.loads on each candidate; keep the ones that parse cleanly.
    A single broken beat partway through no longer takes the whole plan
    down with it.
    """
    out = []
    n = len(raw_text)
    i = 0
    while i < n:
        # Find next `{ "type"` (allow flexible whitespace)
        m = re.search(r'\{\s*"type"\s*:', raw_text[i:])
        if not m:
            break
        start = i + m.start()
        # Find the matching close brace, respecting strings and escapes
        depth = 0
        in_string = False
        escape = False
        end = -1
        for j in range(start, n):
            ch = raw_text[j]
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = j
                    break
        if end < 0:
            # No closing brace — partial / truncated beat; bail.
            break
        candidate = raw_text[start : end + 1]
        try:
            beat = json.loads(candidate)
            if isinstance(beat, dict) and beat.get("type"):
                out.append(beat)
        except json.JSONDecodeError:
            # Malformed individual beat — skip, keep scanning forward.
            pass
        i = end + 1
    return out


def _parse_or_repair(text: str):
    if not text:
        return None
    t = text.strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    unwrapped = _strip_wrappers(t)
    if unwrapped != t:
        try:
            return json.loads(unwrapped)
        except json.JSONDecodeError:
            t = unwrapped
    start = t.find("{")
    if start < 0:
        return None
    body = t[start:]
    last = body.rfind("}")
    while last > 0:
        try:
            return json.loads(body[: last + 1])
        except json.JSONDecodeError:
            last = body.rfind("}", 0, last)

    # Bracket-repair fallback: synthesize closers from string/bracket state
    in_string = False
    escape = False
    stack = []
    for ch in body:
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch in "[{":
            stack.append(ch)
        elif ch in "]}":
            if stack and ((ch == "}" and stack[-1] == "{") or (ch == "]" and stack[-1] == "[")):
                stack.pop()
    repaired = body.rstrip()
    if in_string:
        repaired += '"'
    repaired = re.sub(r"[,\s]+$", "", repaired)
    while stack:
        last = stack.pop()
        repaired += "}" if last == "{" else "]"
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        return None


# =========================================================
# COERCERS
# =========================================================
def _ensure_str(v) -> str:
    if isinstance(v, str):
        return v
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v)
    return str(v)


def _ensure_str_list(v) -> list:
    if isinstance(v, list):
        return [_ensure_str(x).strip() for x in v if _ensure_str(x).strip()]
    if isinstance(v, str) and v.strip():
        return [v.strip()]
    return []


def _estimate_duration(beats: list) -> int:
    # Rough estimate: 30 seconds per non-CHECK beat, 90 seconds per CHECK
    sec = 0
    for b in beats:
        sec += 90 if b.get("type") == "CHECK" else 30
    return max(5, min(15, round(sec / 60)))
