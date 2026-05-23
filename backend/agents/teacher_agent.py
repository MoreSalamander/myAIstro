"""
Teacher Agent — runtime corrections only (V1).

V1 responsibility: given a CHECK beat (with question + canonical_answer)
and the student's actual answer + grader score, generate a short, warm,
specific correction. NOT a judgment of right/wrong — the grader handles
that. The teacher just phrases what the student got right, what they
missed, and points them to the canonical answer.

V2 will extend this with: improv content generation, raise-hand answers,
and re-explain-on-demand. The interface is intentionally simple so V2
slots in cleanly.
"""

from typing import Dict

import ollama

from core.model_router import TEACH


def phrase_correction(
    *,
    question: str,
    canonical_answer: str,
    student_answer: str,
    score: int,
    passed: bool,
) -> str:
    """
    Return 2-3 sentences of teacher commentary on the student's answer.
    Synchronous (not streamed) — answers are short enough that the wait
    doesn't need a streaming UX in V1.
    """
    stance = (
        "The student got this. Briefly affirm what was right; do not lecture."
        if passed
        else "The student missed key parts. Be warm. Name specifically what was missing and direct them to the canonical answer."
    )
    prompt = f"""You are a patient classroom teacher giving feedback on a student's answer.

QUESTION: {question}

CANONICAL ANSWER: {canonical_answer}

STUDENT ANSWER: {student_answer}

GRADER SCORE: {score}/100
PASSED: {passed}

INSTRUCTIONS:
- {stance}
- Reply in 2-3 sentences of warm, specific feedback.
- Do not restate the question. Do not list the score.
- Do not output JSON, markdown, or any preamble. Plain prose only.
"""
    response = ollama.chat(
        model=TEACH,
        messages=[{"role": "user", "content": prompt}],
        options={
            "num_ctx": 4096,
            "num_predict": 200,
            "temperature": 0.4,
        },
    )
    return ((response.get("message") or {}).get("content") or "").strip()
