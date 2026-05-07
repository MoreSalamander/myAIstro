"""
Quiz Agent (first downstream SOT consumer)

Two responsibilities:
1. Generate an open-ended recall question from a SOT entry.
2. Grade a user's answer against the SOT source material.

Design rules:
- Stateless: each call reads the SOT entry the caller passes in.
- JSON mode + low temperature for deterministic grading.
- Never invent material outside the SOT entry — questions and grades
  must be answerable/justified by the entry alone.
"""

import json
from datetime import datetime

import ollama

from core.model_router import QUIZ_GENERATE, GRADE


def generate_question(entry: dict) -> dict:
    """
    Produce one open-ended recall question grounded in the SOT entry.
    """

    summary = entry.get("summary", "")
    key_concepts = entry.get("key_concepts") or []
    definitions = entry.get("definitions") or []

    if not summary:
        return {
            "question": None,
            "error": "SOT entry has no summary; nothing to quiz on.",
            "generated_at": datetime.utcnow().isoformat(),
        }

    prompt = f"""
You are a quiz generator for a personal learning system. Generate exactly ONE open-ended recall question that tests conceptual understanding of the lesson below. The question MUST be answerable from the lesson source — do not introduce material that isn't there.

RULES:
- Return ONLY valid JSON, no other text.
- The question must require a sentence or two to answer (not yes/no, not one-word trivia).
- Prefer questions that ask the user to explain, contrast, or apply a concept.
- Do not reveal the answer in the question.

OUTPUT FORMAT (must match exactly):
{{
  "question": "string"
}}

LESSON SOURCE:
Course: {entry.get("course", "")}
Lesson: {entry.get("lesson", "")}
Summary: {summary}
Key concepts: {', '.join(key_concepts) if key_concepts else "(none)"}
Definitions: {' / '.join(definitions) if definitions else "(none)"}
"""

    response = ollama.chat(
        model=QUIZ_GENERATE,
        format="json",
        messages=[{"role": "user", "content": prompt}],
        options={"num_predict": 256, "temperature": 0.6},
    )

    try:
        parsed = json.loads(response["message"]["content"])
    except json.JSONDecodeError:
        parsed = {}

    return {
        "question": parsed.get("question"),
        "model": QUIZ_GENERATE,
        "generated_at": datetime.utcnow().isoformat(),
    }


def grade_answer(question: str, user_answer: str, entry: dict) -> dict:
    """
    Grade the user's answer against the SOT entry source. Score is 0-100.
    """

    summary = entry.get("summary", "")
    key_concepts = entry.get("key_concepts") or []
    definitions = entry.get("definitions") or []

    prompt = f"""
You are a fair, concise grader for a personal learning system. Grade the user's answer to the question below against the lesson source. Be strict on accuracy but generous about wording — paraphrase that captures the concept counts as correct.

RULES:
- Return ONLY valid JSON, no other text.
- score is an INTEGER 0-100. 100 = fully correct + complete; 0 = absent or wrong.
- correct_points: short bullets of what the user got right.
- missed_points: short bullets of important ideas they did NOT mention or got wrong. Empty list if none.
- feedback: 1-2 sentences of plain-English coaching.
- Justify everything from the LESSON SOURCE only.

OUTPUT FORMAT (must match exactly):
{{
  "score": 0,
  "feedback": "string",
  "correct_points": ["string"],
  "missed_points": ["string"]
}}

LESSON SOURCE:
Summary: {summary}
Key concepts: {', '.join(key_concepts) if key_concepts else "(none)"}
Definitions: {' / '.join(definitions) if definitions else "(none)"}

QUESTION: {question}

USER'S ANSWER: {user_answer}
"""

    response = ollama.chat(
        model=GRADE,
        format="json",
        messages=[{"role": "user", "content": prompt}],
        options={"num_predict": 512, "temperature": 0.2},
    )

    try:
        parsed = json.loads(response["message"]["content"])
    except json.JSONDecodeError:
        parsed = {}

    raw_score = parsed.get("score", 0)
    try:
        score = max(0, min(100, int(raw_score)))
    except (TypeError, ValueError):
        score = 0

    return {
        "score": score,
        "feedback": parsed.get("feedback", "Grader output was malformed."),
        "correct_points": parsed.get("correct_points") or [],
        "missed_points": parsed.get("missed_points") or [],
        "model": GRADE,
        "graded_at": datetime.utcnow().isoformat(),
    }
