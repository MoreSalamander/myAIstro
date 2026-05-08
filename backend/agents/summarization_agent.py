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
import re
from datetime import datetime

from core.code_format import format_code_block
from core.model_router import SUMMARIZE as MODEL


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

SUMMARY RULES:
- The summary must be 2-4 sentences of substantive prose that explain the lesson's main ideas in plain English.
- Do NOT just restate the lesson title or use the title as the summary.
- A reader should understand the key takeaways from the summary alone.

KEY_CONCEPTS RULES:
- Each entry is a short noun phrase (1-5 words) naming an idea covered in the lesson.

DEFINITION RULES:
- Each entry is a complete "term — explanation" pair. The term names something the lesson defines; the explanation states what it is or does.
- Acceptable formats: "term — explanation", "term: explanation", or a single sentence that contains both.
- Do NOT include orphan terms with no explanation. WRONG: "src attribute in <img>". RIGHT: "src attribute in <img> — specifies the URL of the image to display".
- If the lesson does not formally define anything, return an empty array.

CODE BLOCK RULES (STRICT):
- Copy code from the lesson VERBATIM, including indentation, line breaks, and all whitespace. Use literal \\n inside JSON strings to preserve newlines.
- Each `code_blocks` entry must be ONE complete code example with all of its lines together. Do NOT split a multi-line example across separate array entries (e.g. an HTML document is ONE entry, not one entry per tag).
- Only include actual code samples (HTML, JSX, JS, CSS, shell commands, etc.). Do NOT include URLs, prose terms, or single inline tokens as code blocks.
- If the lesson has no code samples, return an empty array.

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
    # Note: NOT using format="json". The grammar-constrained mode
    # consistently bailed mid-output on llama3:8b for lessons containing
    # HTML/JSX in code blocks (observed reliably on "HTML forms and user
    # input" — model stopped right after emitting "<form>" inside a code
    # string). Letting the model generate freely + parsing/repairing
    # afterward produces complete output for those lessons. The prompt
    # below still demands strict JSON, and _parse_or_repair handles any
    # rough edges.
    response = ollama.chat(
        model=MODEL,
        messages=[
            {
                "role": "user",
                "content": prompt
            }
        ],
        options={
            "num_ctx": 8192,
            "num_predict": 3072,
            "temperature": 0.1,
        }
    )

    output_text = response["message"]["content"]

    # -----------------------------
    # PARSE + VALIDATE OUTPUT
    # -----------------------------
    parsed = _parse_or_repair(output_text)
    if not parsed:
        # Total failure — preserve the raw output so the user / log can
        # inspect what the model actually emitted.
        parsed = {
            "summary": output_text,
            "key_concepts": [],
            "definitions": [],
            "code_blocks": [],
        }

    # -----------------------------
    # FINAL STANDARDIZED OUTPUT
    # -----------------------------
    # The LLM occasionally violates the JSON contract — e.g. emits
    # code_blocks as [{"language": "...", "code": "..."}] instead of
    # ["string"]. Coerce every field to its expected shape before
    # downstream code (validation, memory writer) touches it.
    return {
        "summary": _ensure_str(parsed.get("summary")),
        "key_concepts": _ensure_list_of_str(parsed.get("key_concepts")),
        "definitions": _ensure_list_of_str(parsed.get("definitions")),
        "code_blocks": [
            format_code_block(b)
            for b in _ensure_list_of_str(parsed.get("code_blocks"))
        ],
        "generated_at": datetime.utcnow().isoformat(),
    }


def _parse_or_repair(text: str):
    """
    Parse LLM JSON output, repairing truncated responses where possible.

    Real-world failure mode: Ollama's format="json" can stop generation
    mid-string on long inputs (observed with llama3:8b at 8-9k char
    lessons even with a 3072-token output cap). The model never closed
    the JSON object, so json.loads fails and the user loses the entry.

    Repair strategy: walk the text, track whether we're inside a string,
    track bracket nesting, then synthesize the missing closers.
    """
    if not text:
        return None

    text = text.strip()

    # Try direct parse first.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strip anything before the first '{' — sometimes the model prefixes
    # output with a stray newline or commentary.
    start = text.find("{")
    if start < 0:
        return None
    body = text[start:]

    # Scan to find string + bracket state at the end of the response.
    in_string = False
    escape_next = False
    stack = []
    for ch in body:
        if escape_next:
            escape_next = False
            continue
        if ch == "\\":
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch in "[{":
            stack.append(ch)
        elif ch in "]}":
            if stack and ((ch == "}" and stack[-1] == "{") or
                          (ch == "]" and stack[-1] == "[")):
                stack.pop()

    repaired = body.rstrip()
    if in_string:
        repaired += '"'
    # Drop trailing commas/whitespace immediately before we add closers.
    repaired = re.sub(r"[,\s]+$", "", repaired)
    while stack:
        last = stack.pop()
        repaired += "}" if last == "{" else "]"
    # Also drop trailing commas inside nested closers.
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)

    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        return None


def _ensure_str(value) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, dict):
        # Try common payload keys an LLM might use for the actual text.
        for key in ("text", "content", "value", "code", "summary"):
            v = value.get(key)
            if isinstance(v, str):
                return v
        return json.dumps(value)
    if isinstance(value, list):
        return " ".join(_ensure_str(v) for v in value)
    return str(value)


def _ensure_list_of_str(value) -> list:
    if isinstance(value, list):
        return [_ensure_str(v) for v in value]
    if isinstance(value, dict):
        return [_ensure_str(v) for v in value.values()]
    if isinstance(value, str):
        return [value] if value.strip() else []
    if value is None:
        return []
    return [_ensure_str(value)]
