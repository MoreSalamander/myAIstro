"""
Quiz endpoints — first downstream consumer of the SOT.

POST /api/quiz/question  body: {event_id}                  → {question, generated_at}
POST /api/quiz/grade     body: {event_id, question, user_answer}
                          → {score, feedback, correct_points, missed_points, graded_at}

Stateless: the frontend holds the question between calls.
"""

import json
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agents.quiz_agent import generate_question, grade_answer


router = APIRouter()

SOT_FILE = "memory_store.json"


def _load_sot():
    if not os.path.exists(SOT_FILE):
        return []
    with open(SOT_FILE, "r") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []


def _find_entry(event_id: str):
    for entry in _load_sot():
        if entry.get("event_id") == event_id:
            return entry
    return None


class QuestionRequest(BaseModel):
    event_id: str


class GradeRequest(BaseModel):
    event_id: str
    question: str
    user_answer: str


@router.post("/quiz/question")
def quiz_question(req: QuestionRequest):
    entry = _find_entry(req.event_id)
    if not entry:
        raise HTTPException(status_code=404, detail="SOT entry not found")
    return generate_question(entry)


@router.post("/quiz/grade")
def quiz_grade(req: GradeRequest):
    entry = _find_entry(req.event_id)
    if not entry:
        raise HTTPException(status_code=404, detail="SOT entry not found")
    return grade_answer(req.question, req.user_answer, entry)
