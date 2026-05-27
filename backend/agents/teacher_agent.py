"""
Teacher Agent — runtime classroom interactions.

V1 was correction-phrasing only — `phrase_correction` ran after the
LLM grader scored a typed CHECK answer, generating short warm
commentary on what the student got right or missed. With the Phase 1
MC CHECK split, grading is now deterministic (selected_index vs
correct_index) and feedback is the beat's static "explanation" field,
so phrase_correction is no longer needed and was removed.

V2 added the first non-correction Teacher feature:
RAISE-HAND ANSWERS. The student can ask a question mid-session and the
teacher answers grounded in the same lesson's source material — same
trust contract as the rest of the system: every output is grounded in
material the student has actually seen.

Still planned (future v2 work):
  - Re-explain on demand: alternative phrasing of the current beat
  - Improv content generation: adaptive beats based on student state
    (e.g. remedial EXPOSITION after a failed CHECK)

These functions stream tokens (matching the advisor + audit pattern)
so the runtime interactions feel responsive, not "wait 10 seconds for
the teacher to think."
"""

from typing import Dict, Iterable

import ollama

from core.model_router import TEACH


def stream_question_answer(
    *,
    question: str,
    source_text: str,
    course: str = "",
    week: str = "",
    lesson: str = "",
) -> Iterable[str]:
    """
    Yield content chunks for a student's mid-session "raise hand"
    question. The Teacher reads the lesson's source material and
    answers the question — grounded strictly in that source, brief
    enough not to derail the flow.

    Strict rule: if the question can't be answered from the source,
    the teacher says so plainly. The contract is the same as the
    advisor's — never invent material the student hasn't actually
    learned. The Python grounding gate at the controller (combined
    report against `source_text`) verifies what the LLM produces
    after the stream completes.

    Parameters
    ----------
    question : str
        The student's typed question.
    source_text : str
        The lesson material the answer must be grounded in. Resolved
        by the controller from the Plan's lesson_event_id (for plans
        generated from SOT) or derived_from_notebook section
        (for plans generated from a Notebook section).
    course / week / lesson : str
        Identity for the prompt header. Optional but improves the
        Teacher's sense of context.

    Yields
    ------
    str
        Content fragments as they arrive from Ollama.
    """
    prompt = _build_question_prompt(
        question=question,
        source_text=source_text,
        course=course,
        week=week,
        lesson=lesson,
    )

    stream = ollama.chat(
        model=TEACH,
        messages=[{"role": "user", "content": prompt}],
        options={
            # Source material plus the question fits comfortably in 8K.
            # Output budget is small — 2-4 sentences, not an essay.
            "num_ctx": 8192,
            "num_predict": 320,
            "temperature": 0.4,
        },
        stream=True,
    )

    for chunk in stream:
        msg = chunk.get("message") or {}
        content = msg.get("content")
        if content:
            yield content


def _build_question_prompt(
    *,
    question: str,
    source_text: str,
    course: str,
    week: str,
    lesson: str,
) -> str:
    """
    Tight, focused prompt for raise-hand answers. No inline code
    examples (avoids the prompt-bleed failure mode we hit earlier
    on the advisor's arc/recap prompt). No multi-rule structural
    instructions. Single declarative task with strict grounding.
    """
    header = ""
    if course or week or lesson:
        header = (
            f"LESSON CONTEXT:\n"
            f"  Course: {course or '?'}\n"
            f"  Week: {week or '?'}\n"
            f"  Lesson: {lesson or '?'}\n\n"
        )

    return f"""You are a patient classroom teacher. A student raised their hand mid-lesson and asked a question. You have ONE lesson's source material below. Answer the student's question using ONLY that source.

RULES:
- Ground every claim in the source below. Do NOT invent topics, terms, or examples that aren't in the lesson.
- If the lesson doesn't cover the student's question, say so plainly: explain that this specific point isn't in the current lesson, and suggest they check related lessons in their notes. Do NOT half-answer with material outside the source.
- Be brief. 2-4 sentences usually. The student is mid-lesson — don't derail with a long lecture.
- Warm, teacherly tone. Plain prose. No markdown headers, no bullet lists.

{header}LESSON SOURCE:
{source_text}

STUDENT QUESTION:
{question}
"""
