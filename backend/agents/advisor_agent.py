"""
Advisor Agent — second downstream SOT consumer.

Takes a user's natural-language query and a list of relevant SOT
entries, builds a grounded prompt, and streams the model's tokens
as they arrive.

Strict rule: the agent must answer from the SOT entries only. If the
SOT doesn't cover the question, it should say so rather than
hallucinating material the user hasn't actually learned.
"""

from typing import Dict, Iterable, List

import ollama

from core.model_router import ADVISE


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
            "num_ctx": 8192,
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
