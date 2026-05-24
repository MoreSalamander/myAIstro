"""
Advisor Agent — second downstream SOT consumer.

Takes a user's natural-language query and either:
  (a) a single SOT entry — produces ONE study-guide section grounded in
      that entry (`stream_section`). This is the per-lesson primitive the
      advisor pipeline calls in a map step.
  (b) a list of SOT entries — produces an answer in a single LLM call
      over the whole context (`stream_chat`). Legacy path; kept for any
      caller that wants the original single-shot behavior. The current
      `/api/advisor/chat` endpoint uses the pipeline + per-section path.

Strict rule for both: the agent must answer from the supplied SOT
content only. If the SOT doesn't cover the question, it should say so
rather than hallucinating material the user hasn't actually learned.
"""

from typing import Dict, Iterable, List

import ollama

from core.model_router import ADVISE


def stream_reduce(query: str, entries: List[Dict], mode: str) -> Iterable[str]:
    """
    Yield content chunks for the OPENING ARC or CLOSING RECAP of a
    multi-section study guide.

    Two modes, same shape:
      mode="arc"   — one paragraph framing what the user is about to
                     learn and how the lessons connect. Streams BEFORE
                     any section content.
      mode="recap" — one paragraph framing what the user should now
                     understand and how the pieces fit together.
                     Streams AFTER all sections.

    The reduce step intentionally does NOT receive the per-section
    output — it only sees the lesson list + summaries. This keeps it
    a focused, fast call (no need to re-process thousands of tokens
    of section content) and makes the failure mode safe: a bad reduce
    affects only the opening or closing paragraph, never the sections.
    """
    if mode not in ("arc", "recap"):
        raise ValueError(f"stream_reduce mode must be 'arc' or 'recap', got {mode!r}")

    prompt = _build_reduce_prompt(query, entries, mode)

    stream = ollama.chat(
        model=ADVISE,
        messages=[{"role": "user", "content": prompt}],
        options={
            # Small focused task: read a lesson list, write one paragraph.
            # 4K context fits the lesson list comfortably; 384 tokens of
            # output is enough for a 2-4 sentence framing paragraph.
            "num_ctx": 4096,
            "num_predict": 384,
            "temperature": 0.3,
        },
        stream=True,
    )

    for chunk in stream:
        msg = chunk.get("message") or {}
        content = msg.get("content")
        if content:
            yield content


def _build_reduce_prompt(query: str, entries: List[Dict], mode: str) -> str:
    """
    Per-mode framing-paragraph prompt. Receives the lesson list (with
    summaries) plus the user's query, and produces one paragraph.
    """
    # Compact one-line-per-lesson list. Summary is trimmed so the
    # context stays small — the model needs to know what each lesson
    # is about, not every detail.
    lesson_lines: List[str] = []
    for e in entries:
        course = e.get("course") or "?"
        week = e.get("week") or "?"
        lesson = e.get("lesson") or "?"
        summary = (e.get("summary") or "").strip()
        # Trim summary to first sentence-ish so each line stays short
        trimmed = summary.split(".")[0].strip()
        if trimmed:
            lesson_lines.append(f"- {course} · week {week} · {lesson}: {trimmed}.")
        else:
            lesson_lines.append(f"- {course} · week {week} · {lesson}")
    lesson_block = "\n".join(lesson_lines)

    if mode == "arc":
        task = (
            "Write ONE short paragraph (2 to 4 sentences) that frames what "
            "the user will learn across these lessons. Name the conceptual "
            "arc — how the lessons connect and what capability they build "
            "toward together. Look FORWARD."
        )
    else:  # recap
        task = (
            "Write ONE short paragraph (2 to 3 sentences) that frames what "
            "the user should now understand after reading these lessons. "
            "Name how the pieces fit together and what capability they add up "
            "to. Look BACK at the journey just taken."
        )

    return f"""You are writing the framing paragraph for a study guide. The user asked the question below; the study guide covers the lessons listed.

{task}

CONSTRAINTS:
- Output plain prose only — no markdown headers, no bullet lists, no code.
- Do not list the lessons individually; speak about them collectively.
- Do not invent material; ground everything in the lesson summaries below.
- Keep it short and confident. No padding.

USER QUESTION:
{query}

LESSONS COVERED (in order):
{lesson_block}
"""


def stream_section(query: str, entry: Dict) -> Iterable[str]:
    """
    Yield content chunks for ONE study-guide section, grounded in a
    single SOT entry and shaped by the user's question.

    Used by the advisor pipeline's map step — one call per retrieved
    entry. The narrower context (just one lesson) lets the model focus
    entirely on that material and keeps its output budget dedicated to
    one section, which preserves code samples and per-lesson depth
    that a single-shot prompt over N entries tends to compress away.
    """
    prompt = _build_section_prompt(query, entry)

    stream = ollama.chat(
        model=ADVISE,
        messages=[{"role": "user", "content": prompt}],
        options={
            # Per-section context is small (one entry's content), so
            # 8K is plenty. Output budget of 1024 tokens fits a rich
            # section with header, concepts, definitions, and code.
            "num_ctx": 8192,
            "num_predict": 1024,
            "temperature": 0.3,
        },
        stream=True,
    )

    for chunk in stream:
        msg = chunk.get("message") or {}
        content = msg.get("content")
        if content:
            yield content


def _build_section_prompt(query: str, entry: Dict) -> str:
    """
    Per-lesson prompt. The model receives ONE entry plus the user's
    question and produces a study-guide section for that lesson, in
    the context of what the user asked.
    """
    course = entry.get("course") or "?"
    week = entry.get("week") or "?"
    lesson = entry.get("lesson") or "?"
    summary = entry.get("summary") or ""
    key_concepts = entry.get("key_concepts") or []
    definitions = entry.get("definitions") or []
    code_blocks = [c for c in (entry.get("code_blocks") or []) if c and c.strip()]

    parts: List[str] = []
    if summary:
        parts.append(f"Summary: {summary}")
    if key_concepts:
        parts.append(f"Key concepts: {', '.join(key_concepts)}")
    if definitions:
        parts.append("Definitions:")
        for d in definitions:
            parts.append(f"  - {d}")
    if code_blocks:
        parts.append("Code from the lesson (quote verbatim if relevant):")
        for c in code_blocks:
            parts.append("```")
            parts.append(c)
            parts.append("```")
    entry_block = "\n".join(parts) if parts else "(empty)"

    return f"""You are writing one section of a study guide. The user has a Source of Truth (SOT) of validated lesson notes. You are given ONE lesson from their SOT and the user's question. Write a study-guide section for this lesson that helps answer the question.

RULES:
- Ground every claim in the lesson below. Do NOT invent topics, terms, or examples that aren't in the lesson.
- Start with the markdown header: ## {course} · week {week} · {lesson}
- Briefly explain what the lesson covers in 1-2 sentences.
- List key concepts as bullets.
- List definitions as bullets if present in the lesson.
- Include code samples in markdown fences when present. The language tag must be lowercase and must follow the opening triple-backticks directly on the same line — never place the language name on its own line inside the code block.
- Quote code verbatim from the lesson — do not paraphrase code.
- Be concise. Don't pad.

USER QUESTION:
{query}

LESSON FROM SOT:
{entry_block}
"""


def stream_chat(query: str, entries: List[Dict]) -> Iterable[str]:
    """
    Yield content chunks as they arrive from the advisor model.

    The caller is responsible for serializing chunks onto the wire
    (NDJSON, SSE, etc.).
    """

    prompt = _build_prompt(query, entries)

    stream = ollama.chat(
        model=ADVISE,
        messages=[{"role": "user", "content": prompt}],
        options={
            # llama3.2 supports up to 128K context. 32K is plenty of
            # headroom for course-wide queries (20+ SOT entries) plus a
            # long study-guide response, without paying for cache the
            # model rarely uses.
            "num_ctx": 32768,
            "num_predict": 4096,
            "temperature": 0.3,
        },
        stream=True,
    )

    for chunk in stream:
        msg = chunk.get("message") or {}
        content = msg.get("content")
        if content:
            yield content


def _build_prompt(query: str, entries: List[Dict]) -> str:
    context_block = _build_context_block(entries)

    return f"""You are a study advisor for a personal learning system. The user has saved validated lesson notes — their personal Source of Truth (SOT). Answer the user's question using ONLY the SOT entries below.

RULES:
- Ground every claim in the SOT entries below. Do NOT invent topics, terms, or examples that aren't in the SOT.
- If the SOT does not cover what the user asked, say so plainly and tell them which lessons would need to be ingested to answer.
- For study guides, summaries, or comparisons, organize the answer with clear headings and bullet points.
- Quote code samples from the SOT verbatim when they're relevant.
- Be concise. Don't pad.

=== SOT ENTRIES ===

{context_block}

=== USER QUESTION ===

{query}
"""


def _build_context_block(entries: List[Dict]) -> str:
    if not entries:
        return "(No SOT entries matched this query.)"

    blocks: List[str] = []
    for e in entries:
        parts: List[str] = [
            f"## {e.get('course', '?')} · week {e.get('week', '?')} — {e.get('lesson', '')}",
            f"Summary: {e.get('summary', '')}",
        ]
        key_concepts = e.get("key_concepts") or []
        if key_concepts:
            parts.append(f"Key concepts: {', '.join(key_concepts)}")
        definitions = e.get("definitions") or []
        if definitions:
            parts.append("Definitions:")
            for d in definitions:
                parts.append(f"  - {d}")
        code_blocks = [c for c in (e.get("code_blocks") or []) if c and c.strip()]
        for c in code_blocks:
            parts.append("Code:")
            parts.append("```")
            parts.append(c)
            parts.append("```")
        blocks.append("\n".join(parts))

    return "\n\n".join(blocks)
