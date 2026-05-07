"""
Summarization Agent (SOT v1)

Purpose:
- Converts raw lesson text into structured knowledge artifacts
- Must behave like a deterministic transformer, NOT a chatbot

Key rule:
- ALWAYS return valid structured JSON (never free-form text)
"""

import ollama
import json
from datetime import datetime

# Locked model for v1 stability
MODEL = "llama3:8b"


def summarize_lesson(raw_text: str) -> dict:
    """
    Takes raw lesson text and returns structured summary output.
    This is a core SOT transformation node.
    """

    # -----------------------------
    # Guard clause: empty input
    # -----------------------------
    if not raw_text or not raw_text.strip():
        return {
            "summary": "Empty lesson input.",
            "key_concepts": [],
            "definitions": [],
            "code_blocks": [],
            "generated_at": datetime.utcnow().isoformat()
        }

    # -----------------------------
    # STRICT OUTPUT CONTRACT PROMPT
    # -----------------------------
    # IMPORTANT: We force JSON output so downstream pipeline can rely on structure.
    prompt = f"""
You are a deterministic summarization engine inside a learning system.

CRITICAL RULES:
- You are NOT a chatbot
- You are NOT allowed to ask questions
- You MUST NOT add commentary
- You MUST return ONLY valid JSON
- No markdown, no explanation, no extra text

OUTPUT FORMAT (must match exactly):
{{
  "summary": "string",
  "key_concepts": ["string"],
  "definitions": ["string"],
  "code_blocks": ["string"]
}}

LESSON INPUT:
{raw_text}
"""

    # -----------------------------
    # CALL LLM
    # -----------------------------
    response = ollama.chat(
        model=MODEL,
        messages=[
            {
                "role": "user",
                "content": prompt
            }
        ]
    )

    output_text = response["message"]["content"]

    # -----------------------------
    # PARSE + VALIDATE OUTPUT
    # -----------------------------
    # This enforces structure so downstream nodes stay stable
    try:
        parsed = json.loads(output_text)

    except json.JSONDecodeError:
        # Fallback safety: if model breaks format, we recover gracefully
        parsed = {
            "summary": output_text,  # fallback raw capture
            "key_concepts": [],
            "definitions": [],
            "code_blocks": []
        }

    # -----------------------------
    # FINAL STANDARDIZED OUTPUT
    # -----------------------------
    return {
        "summary": parsed.get("summary", ""),
        "key_concepts": parsed.get("key_concepts", []),
        "definitions": parsed.get("definitions", []),
        "code_blocks": parsed.get("code_blocks", []),
        "generated_at": datetime.utcnow().isoformat()
    }
