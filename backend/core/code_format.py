"""
Deterministic code formatter for SOT entries.

Runs after the LLM extracts code_blocks so the stored code is always
indented properly, regardless of whether the original lesson source
or the LLM produced flat output.

Currently handles HTML (the only code shape we've seen in lessons).
Non-HTML code (JS, CSS, shell, …) passes through unchanged. Add more
formatters here as new lesson types appear.

Also strips stray language-label first lines (`Jsx\\n<code>`,
`Python\\ndef foo()`, …) that the LLM pulls in from a markdown fence
and emits as the first line of a code_blocks entry. Without this,
render-time language detection sees the label as part of the code
and falls back to the no-chip "text" path.
"""

import re


VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img",
    "input", "link", "meta", "source", "track", "wbr",
}


# Allowlist of language labels we'll strip when they appear alone on
# the first line of a code_blocks entry. Match is case-insensitive.
# Keep this tight — broadening it to "any short alphabetic token" used
# to strip legitimate identifiers like character names ("Milo", "Luna",
# "Moon") that happened to be the first line of a code example.
_LANGUAGE_LABELS = frozenset({
    # web
    "html", "css", "scss", "sass", "less",
    "js", "javascript", "jsx", "mjs", "cjs",
    "ts", "typescript", "tsx",
    "vue", "svelte",
    # backend
    "py", "python", "rb", "ruby",
    "java", "kotlin", "kt", "swift",
    "go", "golang", "rust", "rs",
    "c", "cpp", "c++", "cs", "csharp", "php",
    # shell
    "sh", "bash", "zsh", "fish", "shell", "ps1", "powershell",
    # data / config
    "json", "yaml", "yml", "xml", "toml", "ini", "env",
    "sql", "graphql", "gql",
    # misc
    "text", "plaintext", "plain", "markdown", "md", "mdx",
    "diff", "patch", "regex",
})


def format_code_block(text: str) -> str:
    """Return text with HTML-like content pretty-printed; otherwise unchanged."""
    if not text:
        return text

    cleaned = _strip_language_hint(text)

    if _looks_like_html(cleaned):
        try:
            return _pretty_html(cleaned)
        except Exception:
            return cleaned

    return cleaned


def _strip_language_hint(text: str) -> str:
    """
    Drop a single-word language label that the LLM sometimes pulls in
    from a markdown fence (``` html / Html / javascript) and emits as
    the first line of a code_blocks entry.

    Match is gated on _LANGUAGE_LABELS so legitimate code that starts
    with a short capitalized identifier ("Milo", "None", "Foo") is
    left alone. Anything left after stripping must still look like
    code (non-empty), otherwise we leave the entry untouched rather
    than risk eating a one-line snippet whose entire body happens to
    spell a language name.
    """
    lines = text.split("\n")

    first_idx = next((i for i, l in enumerate(lines) if l.strip()), None)
    if first_idx is None:
        return text

    first = lines[first_idx].strip()
    if first.lower() not in _LANGUAGE_LABELS:
        return text

    rest = "\n".join(lines[first_idx + 1 :]).lstrip()
    if not rest:
        # The whole "code block" was just the label — almost certainly
        # an LLM extraction artifact, but stripping it would leave an
        # empty entry. Drop the original through unchanged and let the
        # caller decide; the dedup-and-filter passes upstream will
        # discard empty blocks naturally.
        return text

    return rest


def _looks_like_html(text: str) -> bool:
    t = text.lstrip()
    return t.startswith("<") and bool(re.search(r"</?[A-Za-z]", t))


def _pretty_html(html: str, indent: str = "  ") -> str:
    lines = html.split("\n")
    out: list[str] = []
    depth = 0

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        # Closing tag — dedent before printing
        if line.startswith("</"):
            depth = max(0, depth - 1)
            out.append(indent * depth + line)
            continue

        # Doctype, comment, processing instruction — no nesting
        if line.startswith("<!") or line.startswith("<?"):
            out.append(indent * depth + line)
            continue

        # Single-line element: <tag>...</tag>
        if re.match(r"^<[^>]+>.*</[^>]+>\s*$", line):
            out.append(indent * depth + line)
            continue

        # Opening tag only
        open_match = re.match(r"^<\s*([A-Za-z][A-Za-z0-9-]*)\b[^>]*>\s*$", line)
        if open_match:
            tag_name = open_match.group(1).lower()
            is_self_closing = bool(re.search(r"/>\s*$", line))
            is_void = tag_name in VOID_TAGS

            out.append(indent * depth + line)
            if not is_self_closing and not is_void:
                depth += 1
            continue

        # Mixed content / fallback — keep at current depth
        out.append(indent * depth + line)

    return "\n".join(out)
