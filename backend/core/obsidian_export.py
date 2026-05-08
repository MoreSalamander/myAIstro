"""
Obsidian vault export.

Renders each SOT entry as a markdown file in a local vault folder so
the user can browse + graph their knowledge in Obsidian. One-way:
myAIstro is canonical, the vault is a derived view.

Default vault path: ~/Documents/myAIstro-vault
Override with the MYAISTRO_VAULT_PATH environment variable.
"""

import json
import os
import re
from pathlib import Path
from typing import Dict, List


VAULT_PATH = Path(
    os.environ.get("MYAISTRO_VAULT_PATH", "~/Documents/myAIstro-vault")
).expanduser()


# ----------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------

def sync_vault(sot_file: str = "memory_store.json") -> dict:
    """
    Re-render every SOT entry into the vault. Cheap (small files, in-memory
    work, dozens of entries), so we just rewrite all on every change to keep
    "Related lessons" wikilinks correct.
    """
    if not Path(sot_file).exists():
        return {"vault_path": str(VAULT_PATH), "files_written": 0}

    with open(sot_file) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            return {
                "vault_path": str(VAULT_PATH),
                "files_written": 0,
                "error": "memory_store.json was unreadable",
            }

    written = export_all(data)
    return {
        "vault_path": str(VAULT_PATH),
        "files_written": len(written),
    }


def export_all(entries: List[Dict]) -> List[Path]:
    VAULT_PATH.mkdir(parents=True, exist_ok=True)
    written = [_write_one(e, entries) for e in entries]

    # Clean up vault files whose entry has been deleted from the SOT.
    # Without this, deleting an entry leaves a stale .md hanging around
    # and Obsidian's graph view shows orphaned nodes.
    expected = {p.name for p in written}
    for p in VAULT_PATH.glob("*.md"):
        if p.name not in expected:
            p.unlink()

    return written


def vault_status() -> dict:
    exists = VAULT_PATH.exists()
    files = sorted(p.name for p in VAULT_PATH.glob("*.md")) if exists else []
    return {
        "vault_path": str(VAULT_PATH),
        "exists": exists,
        "file_count": len(files),
    }


# ----------------------------------------------------------------------
# Rendering
# ----------------------------------------------------------------------

def _write_one(entry: Dict, all_entries: List[Dict]) -> Path:
    path = VAULT_PATH / _filename_for(entry)
    path.write_text(_render_markdown(entry, all_entries), encoding="utf-8")
    return path


def _filename_for(entry: Dict) -> str:
    """e.g. 'BE101 - W2 - Images and lists.md' — stable across re-exports."""
    course = _sanitize(entry.get("course") or "Unknown")
    week = _sanitize(str(entry.get("week") or ""))
    lesson = _sanitize(entry.get("lesson") or "Untitled")
    parts = [course]
    if week:
        parts.append(f"W{week}")
    parts.append(lesson)
    return " - ".join(parts) + ".md"


def _sanitize(name: str) -> str:
    s = re.sub(r'[\\/:*?"<>|]', "-", name).strip()
    s = re.sub(r"\s+", " ", s)
    return s.strip("- ")


def _render_markdown(entry: Dict, all_entries: List[Dict]) -> str:
    course = entry.get("course") or ""
    week = str(entry.get("week") or "")
    lesson = entry.get("lesson") or ""
    summary = entry.get("summary") or ""
    key_concepts = entry.get("key_concepts") or []
    definitions = entry.get("definitions") or []
    code_blocks = [c for c in (entry.get("code_blocks") or []) if c and c.strip()]
    raw_text = entry.get("raw_text") or ""

    out: List[str] = []

    # ---- frontmatter ----
    out.append("---")
    out.append(f"course: {_yaml_str(course)}")
    out.append(f"week: {_yaml_str(week)}")
    out.append(f"lesson: {_yaml_str(lesson)}")
    out.append(f"event_id: {_yaml_str(entry.get('event_id', ''))}")
    out.append(f"created_at: {_yaml_str(entry.get('created_at', ''))}")
    if entry.get("resummarized_at"):
        out.append(f"resummarized_at: {_yaml_str(entry['resummarized_at'])}")
    out.append(f"validation_score: {entry.get('validation_score', 0)}")
    if key_concepts:
        out.append("key_concepts:")
        for kc in key_concepts:
            out.append(f"  - {_yaml_str(kc)}")
    out.append("---")
    out.append("")

    # ---- body ----
    out.append(f"# {lesson}")
    out.append("")

    if summary:
        out.append("## Summary")
        out.append("")
        out.append(summary)
        out.append("")

    if key_concepts:
        out.append("## Key concepts")
        out.append("")
        for kc in key_concepts:
            out.append(f"- {kc}")
        out.append("")

    if definitions:
        out.append("## Definitions")
        out.append("")
        for d in definitions:
            out.append(f"- {d}")
        out.append("")

    if code_blocks:
        out.append("## Code")
        out.append("")
        for cb in code_blocks:
            lang = "html" if cb.lstrip().startswith("<") else ""
            out.append(f"```{lang}")
            out.append(cb)
            out.append("```")
            out.append("")

    related = _find_related(entry, all_entries)
    if related:
        out.append("## Related lessons")
        out.append("")
        for r in related:
            display = r.get("lesson") or "(untitled)"
            target = Path(_filename_for(r)).stem
            shared = ", ".join(r["_shared_concepts"][:5])
            out.append(f"- [[{target}|{display}]] — shared: {shared}")
        out.append("")

    if raw_text:
        out.append("## Original lesson")
        out.append("")
        out.append("```")
        out.append(raw_text)
        out.append("```")
        out.append("")

    return "\n".join(out)


def _find_related(entry: Dict, all_entries: List[Dict]) -> List[Dict]:
    """Other SOT entries sharing >=1 key_concept, ranked by overlap count."""
    my = {c.lower() for c in (entry.get("key_concepts") or [])}
    if not my:
        return []

    matches = []
    for other in all_entries:
        if other.get("event_id") == entry.get("event_id"):
            continue
        theirs = {c.lower() for c in (other.get("key_concepts") or [])}
        shared = my & theirs
        if shared:
            matches.append({**other, "_shared_concepts": sorted(shared)})

    matches.sort(key=lambda x: -len(x["_shared_concepts"]))
    return matches[:8]


def _yaml_str(s) -> str:
    """Quote a string for YAML if it contains anything that could break parsing."""
    if s is None:
        return '""'
    s = str(s)
    if not s:
        return '""'
    if re.search(r'[:#\-\[\]{},&*?!|<>=%@`"\']', s) or s.strip() != s:
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s
