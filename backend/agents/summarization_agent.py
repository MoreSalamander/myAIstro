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
import sys
from datetime import datetime

from core.code_format import format_code_block
from core.model_router import SUMMARIZE as MODEL


# Lesson length above which a single Ollama call won't fit in the model's
# 8k context window once you include the prompt + output budget. We chunk
# anything larger and merge the partial summaries.
#
# Math: num_ctx=8192, num_predict=3072 → ~4400 tokens for input (prompt
# template ~700 tokens + lesson ~3700 tokens). At ~4 chars/token that's
# ~14k lesson chars. Threshold at 14k keeps a buffer.
#
# Set conservatively in early development at 7000, which sent normal
# lessons through chunking unnecessarily — and chunking itself reliably
# loses key_concepts (each chunk's model call sees a fragment and skips
# concept extraction). Lessons under the threshold take the one-shot
# path which is more reliable.
CHUNK_THRESHOLD_CHARS = 14000
CHUNK_TARGET_CHARS = 12000


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

    # Long lessons get chunked so each pass fits in the model's context.
    if len(raw_text) > CHUNK_THRESHOLD_CHARS:
        return _summarize_chunked(raw_text)
    return _summarize_one_shot(raw_text)


def _summarize_one_shot(raw_text: str) -> dict:

    # -----------------------------
    # OUTPUT CONTRACT PROMPT
    # -----------------------------
    # Tight on purpose. An earlier, much longer prompt loaded llama3:8b
    # with so many instruction sections that it produced malformed output
    # on long lessons (observed reliably on the "HTML forms and user
    # input" lesson). Shorter prompt + JSON repair on the response
    # produces complete output for the same lessons.
    prompt = f"""Return a single JSON object summarizing the lesson below. The object MUST have exactly these keys. Aim to be COMPREHENSIVE — extract everything substantive the lesson teaches, not just the title-level idea.

- "summary": 4-8 sentences of plain-English prose explaining what the lesson teaches. Cover the main ideas AND the key supporting points (specific tags, attributes, mechanisms, examples). Do NOT just restate the title; do NOT pad with filler.
- "key_concepts": array of short noun phrases (1-5 words each) for every distinct idea, term, attribute, mechanism, or behavior the lesson covers. Aim for 8-15 entries on a substantive lesson.
- "definitions": array of STRINGS (not objects). Each string is one "term — explanation" pair, where the term names something the lesson explains (a tag, attribute, mechanism, or concept) and the explanation is what the lesson says it does. Example: "name attribute — becomes the key in the URL's query string when the form is submitted". Empty array only if the lesson truly explains nothing.
- "code_blocks": array of strings. Each string is one complete code example copied VERBATIM from the lesson, with line breaks preserved as `\\n` escapes inside the JSON string. An HTML document is one entry, not one entry per tag. Do NOT wrap entries in triple-backtick fences. Empty array if the lesson has no code.

Return only the JSON object — no commentary, no markdown fences, no prose before or after.

LESSON:
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

    # If the model wrapped its real output inside the outer summary
    # (recursive "Here is the JSON…" pattern), pull fields out of the
    # nested response too. Without this, the outer's empty fields
    # (typically code_blocks) win even though the real code is sitting
    # in the nested JSON.
    parsed = _enrich_from_nested(parsed)

    # -----------------------------
    # FINAL STANDARDIZED OUTPUT
    # -----------------------------
    # The LLM occasionally violates the JSON contract — e.g. emits
    # code_blocks as [{"language": "...", "code": "..."}] instead of
    # ["string"]. Coerce every field to its expected shape before
    # downstream code (validation, memory writer) touches it.
    llm_code_blocks = [
        format_code_block(b)
        for b in _ensure_list_of_str(parsed.get("code_blocks"))
    ]

    # Diagnostic: when the model returns no key_concepts on a substantive
    # lesson, dump the raw response so we can see why. The validation
    # FAIL log only shows the parsed summary preview — that doesn't tell
    # us how the model emitted the concepts (or didn't).
    parsed_concepts = _ensure_list_of_str(parsed.get("key_concepts"))
    if not parsed_concepts and len(raw_text) >= 200:
        print(
            f"[summarize empty key_concepts] raw response ({len(output_text)} chars):\n"
            f"  {output_text[:800]!r}\n"
            f"  ... (truncated)" if len(output_text) > 800 else "",
            file=sys.stderr,
            flush=True,
        )
    # The model often misses code that's embedded inline (no ```fence)
    # — e.g. a "Html\n\n<!DOCTYPE html>...</html>" block in the lesson.
    # Deterministic extraction over raw_text catches those, and the
    # union dedups against what the LLM did pick up.
    deterministic = _extract_code_from_raw(raw_text)
    code_blocks = _dedup_preserve(
        llm_code_blocks + deterministic,
        key=lambda c: c.strip(),
    )

    return {
        "summary": _unwrap_nested_summary(_ensure_str(parsed.get("summary"))),
        "key_concepts": _ensure_list_of_str(parsed.get("key_concepts")),
        "definitions": _ensure_list_of_str(parsed.get("definitions")),
        "code_blocks": code_blocks,
        "generated_at": datetime.utcnow().isoformat(),
    }


def _extract_code_from_raw(raw_text: str) -> list:
    """
    Deterministic code-block extractor over the original lesson text.

    Catches:
      - Standard markdown fences: ```lang\\n...\\n```
      - Inline HTML/code blocks introduced by a single-word language
        label ("Html", "JavaScript") and followed by 3+ contiguous
        lines starting with `<` (or whitespace-indented continuations).
      - Bare contiguous HTML blocks (3+ lines starting with `<`)
        as a last-resort catch.

    The LLM is unreliable for verbatim code extraction; this gives
    consistent coverage. Returned blocks are passed through the same
    HTML formatter the LLM-extracted ones go through.
    """
    if not raw_text:
        return []

    blocks: list = []

    # 1. Markdown-fenced blocks
    for m in re.finditer(r"```\s*(\w+)?\s*\n(.*?)```", raw_text, re.DOTALL):
        body = m.group(2).strip()
        if body:
            blocks.append(body)

    # 2 & 3. Bare contiguous HTML blocks. Walks line-by-line, accumulating
    # any line whose lstrip() starts with `<`. Keeps blocks of 3+ such
    # lines as a code block.
    lines = raw_text.split("\n")
    current: list = []
    for line in lines:
        if line.lstrip().startswith("<"):
            current.append(line)
        elif current and not line.strip():
            # blank line inside a contiguous block — keep accumulating
            current.append(line)
        else:
            if _looks_like_html_block(current):
                blocks.append("\n".join(current).strip())
            current = []
    if _looks_like_html_block(current):
        blocks.append("\n".join(current).strip())

    return [format_code_block(b) for b in blocks if b]


def _looks_like_html_block(lines: list) -> bool:
    if len(lines) < 3:
        return False
    angle_lines = sum(1 for l in lines if l.lstrip().startswith("<"))
    return angle_lines >= 3


def _enrich_from_nested(parsed: dict) -> dict:
    """
    When the model emits a recursive output (its real JSON wrapped
    inside an outer JSON whose `summary` value is the prose preamble +
    inner JSON text), pull whichever fields the outer is missing out of
    the inner response.

    Outer's `summary` always loses to inner (the outer summary IS the
    wrapper text). Outer's lists win when non-empty; otherwise we take
    the inner list.
    """
    if not isinstance(parsed, dict):
        return parsed
    summary_text = parsed.get("summary")
    if not isinstance(summary_text, str):
        return parsed
    # Only run if the summary actually looks wrapped.
    if "Here is the JSON" not in summary_text and '"summary"' not in summary_text:
        return parsed

    stripped = summary_text.strip()
    for p in _NESTED_PREFIXES:
        if stripped.startswith(p):
            stripped = stripped[len(p):].lstrip()
            break

    inner = None
    if stripped.startswith("{") or stripped.startswith("```"):
        inner = _parse_or_repair(stripped)

    if not isinstance(inner, dict):
        return parsed

    out = dict(parsed)

    inner_summary = inner.get("summary")
    if isinstance(inner_summary, str) and inner_summary.strip():
        out["summary"] = inner_summary

    for key in ("key_concepts", "definitions", "code_blocks"):
        outer_v = parsed.get(key)
        inner_v = inner.get(key)
        outer_nonempty = isinstance(outer_v, list) and len(outer_v) > 0
        inner_nonempty = isinstance(inner_v, list) and len(inner_v) > 0
        if not outer_nonempty and inner_nonempty:
            out[key] = inner_v

    # Inner could itself be wrapped — recurse, depth-bounded.
    if "Here is the JSON" in (out.get("summary") or "") or '"summary"' in (out.get("summary") or ""):
        return _enrich_from_nested(out)
    return out


_NESTED_PREFIXES = (
    "Here is the JSON object summarizing the lesson:",
    "Here is the JSON object:",
    "Here's the JSON object:",
    "Here is the JSON:",
    "Here's the JSON:",
)

# Find the first "summary": "<value>" — value tolerates escaped quotes.
_NESTED_SUMMARY_RE = re.compile(
    r'"summary"\s*:\s*"((?:[^"\\]|\\.)*)"', re.DOTALL
)


def _unwrap_nested_summary(text: str, depth: int = 0) -> str:
    """
    Sometimes the model emits a `summary` value that itself contains
    another "Here is the JSON…\n\n{ ...JSON... }" wrapper, recursively.
    The outer JSON parses, key_concepts/definitions/code_blocks come
    out fine, but the summary string is full of JSON markup. Validation
    correctly rejects it.

    Strategy:
      1. Strip a known "Here is the JSON…" prefix.
      2. If the remaining text starts with `{`, try _parse_or_repair
         and use its inner `summary` value.
      3. As a last resort, regex-extract the first "summary": "..." pair
         in the text (handles cases where the inner JSON is too mangled
         to repair structurally but the substring is intact).
      4. Recurse, bounded by depth.
    """
    if not text or depth > 3:
        return text

    stripped = text.strip()

    # Strip preamble.
    for p in _NESTED_PREFIXES:
        if stripped.startswith(p):
            stripped = stripped[len(p):].lstrip()
            break

    # If we now have JSON-shaped content, parse + use inner summary.
    if stripped.startswith("{") or stripped.startswith("```"):
        nested = _parse_or_repair(stripped)
        if isinstance(nested, dict):
            inner = nested.get("summary")
            if isinstance(inner, str) and inner.strip() and inner != text:
                return _unwrap_nested_summary(inner, depth + 1)

    # Regex fallback: works when inner JSON is malformed enough that
    # _parse_or_repair gives up but the "summary": "..." pair is intact.
    if '"summary"' in text:
        m = _NESTED_SUMMARY_RE.search(text)
        if m:
            inner_raw = m.group(1)
            try:
                inner = json.loads('"' + inner_raw + '"')
            except json.JSONDecodeError:
                inner = inner_raw
            if isinstance(inner, str) and inner.strip() and inner != text:
                return _unwrap_nested_summary(inner, depth + 1)

    return text


def _summarize_chunked(raw_text: str) -> dict:
    """
    Summarize a lesson too long for the model's context window by
    splitting it into paragraph-aligned chunks, summarizing each, and
    merging the partial results.

    Merge strategy:
      - summary: concatenate the partial prose with double newlines
      - key_concepts: union, deduped case-insensitively, order-preserving
      - definitions: union, deduped by the term before "—" or ":"
      - code_blocks: union, dropping exact duplicates
    """
    chunks = _split_into_chunks(raw_text, CHUNK_TARGET_CHARS)
    partials = [_summarize_one_shot(c) for c in chunks]

    summaries = [p.get("summary", "").strip() for p in partials]
    summary = "\n\n".join(s for s in summaries if s)

    key_concepts = _dedup_preserve(
        (k for p in partials for k in (p.get("key_concepts") or [])),
        key=lambda k: k.strip().lower(),
    )

    def _def_key(d):
        d = d.strip()
        for sep in ("—", ":", "-"):
            if sep in d:
                return d.split(sep, 1)[0].strip().lower()
        return d[:40].lower()

    definitions = _dedup_preserve(
        (d for p in partials for d in (p.get("definitions") or [])),
        key=_def_key,
    )

    code_blocks = _dedup_preserve(
        (c for p in partials for c in (p.get("code_blocks") or []) if c and c.strip()),
        key=lambda c: c.strip(),
    )

    return {
        "summary": summary,
        "key_concepts": key_concepts,
        "definitions": definitions,
        "code_blocks": code_blocks,
        "generated_at": datetime.utcnow().isoformat(),
    }


def _split_into_chunks(text: str, target_chars: int) -> list:
    """
    Paragraph-aligned splitter: walk paragraphs and start a new chunk
    whenever adding the next one would push the current chunk over
    target_chars. Falls back to splitting on single newlines, then on
    raw character offsets, if a single paragraph is itself larger than
    the target.
    """
    paragraphs = text.split("\n\n")

    chunks: list = []
    current: list = []
    current_len = 0

    def push():
        nonlocal current, current_len
        if current:
            chunks.append("\n\n".join(current))
            current = []
            current_len = 0

    for para in paragraphs:
        if len(para) > target_chars:
            push()
            for sub in _hard_split(para, target_chars):
                chunks.append(sub)
            continue
        if current_len + len(para) + 2 > target_chars and current:
            push()
        current.append(para)
        current_len += len(para) + 2

    push()
    return [c for c in chunks if c.strip()]


def _hard_split(text: str, target_chars: int) -> list:
    """Split a single oversize paragraph by line, then by raw offset."""
    lines = text.split("\n")
    chunks: list = []
    cur: list = []
    cur_len = 0
    for line in lines:
        if len(line) > target_chars:
            if cur:
                chunks.append("\n".join(cur))
                cur = []
                cur_len = 0
            for i in range(0, len(line), target_chars):
                chunks.append(line[i:i + target_chars])
            continue
        if cur_len + len(line) + 1 > target_chars and cur:
            chunks.append("\n".join(cur))
            cur = []
            cur_len = 0
        cur.append(line)
        cur_len += len(line) + 1
    if cur:
        chunks.append("\n".join(cur))
    return chunks


def _dedup_preserve(items, key=None):
    """First-seen-wins dedup that preserves order."""
    seen = set()
    out = []
    for item in items:
        k = key(item) if key else item
        if k in seen:
            continue
        seen.add(k)
        out.append(item)
    return out


def _strip_outer_wrappers(text: str) -> str:
    """
    Peel off prose preambles and an outer markdown fence wrapper.

    Handles, in order:
      1. Prose before the first ``` (e.g. "Here is the JSON…\n\n```...")
      2. A leading ```json (or ```html, or just ```) opener
      3. A trailing ``` closer
      4. Prose before the first '{' if no fence was present.
    """

    text = text.strip()

    # Prose before opening fence: cut to the fence.
    fence_idx = text.find("```")
    if fence_idx > 0 and "{" not in text[:fence_idx]:
        text = text[fence_idx:].lstrip()

    # Strip leading ```<lang>\n
    if text.startswith("```"):
        rest = text[3:]
        nl = rest.find("\n")
        if nl >= 0:
            head = rest[:nl].strip()
            if not head or re.fullmatch(r"[A-Za-z][A-Za-z0-9+\-]*", head):
                text = rest[nl + 1:]
            else:
                text = rest
        else:
            text = rest

    # Strip trailing ```
    stripped = text.rstrip()
    if stripped.endswith("```"):
        text = stripped[:-3].rstrip()

    # Prose before the JSON object's opening brace: cut to it.
    brace_idx = text.find("{")
    if brace_idx > 0:
        text = text[brace_idx:]

    return text.strip()


def _convert_markdown_fences_to_json_strings(text: str) -> str:
    """
    Replace ```...``` markdown fences with proper JSON strings.

    llama3:8b reflexively wraps multi-line code in markdown fences even
    when explicitly told not to (the fence markers are essentially baked
    into how it represents code). Inside a JSON array those triple
    backticks are syntax errors that the bracket-repair can't fix —
    the structure is wrong, not just truncated.

    The fence contents become JSON strings with newlines escaped, quotes
    escaped, and backslashes escaped. An optional language tag on the
    opening fence (```html, ```js, etc.) is dropped if present.
    """

    def replace(match: "re.Match") -> str:
        content = match.group(1)
        # Drop a leading language identifier on its own line.
        first_line, _, rest = content.partition("\n")
        if first_line.strip() and not any(c in first_line for c in "<{(/"):
            stripped = first_line.strip()
            if re.fullmatch(r"[A-Za-z][A-Za-z0-9+\-]*", stripped):
                content = rest
        escaped = (
            content.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        )
        return '"' + escaped + '"'

    return re.sub(r"```(.*?)```", replace, text, flags=re.DOTALL)


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

    # Strip outer wrappers — prose preamble ("Here is the JSON…"),
    # opening ```json fence, trailing ``` fence — that the model often
    # adds despite the prompt. Do this BEFORE the inner fence converter
    # so the JSON itself isn't mistaken for fenced code.
    unwrapped = _strip_outer_wrappers(text)
    if unwrapped != text:
        try:
            return json.loads(unwrapped)
        except json.JSONDecodeError:
            text = unwrapped

    # Convert ```code fences``` into JSON strings — the model often uses
    # markdown for code_blocks even when told not to, which breaks JSON
    # parsing because raw ``` is not valid inside a JSON array.
    fenced = _convert_markdown_fences_to_json_strings(text)
    if fenced != text:
        try:
            return json.loads(fenced)
        except json.JSONDecodeError:
            text = fenced  # keep the cleaned version for the rest

    # Strip anything before the first '{' — sometimes the model prefixes
    # output with "Here is the JSON…" prose or a markdown ```json fence.
    start = text.find("{")
    if start < 0:
        return None
    body = text[start:]

    # Strip anything after the JSON's closing brace — handles trailing
    # markdown fences (```) or postscript commentary. Try the last } and
    # walk back through earlier } candidates if needed.
    last_close = body.rfind("}")
    while last_close > 0:
        try:
            return json.loads(body[: last_close + 1])
        except json.JSONDecodeError:
            last_close = body.rfind("}", 0, last_close)

    # No valid full JSON found by trimming — fall through to the repair
    # path that scans bracket / string state and synthesizes closers.

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
