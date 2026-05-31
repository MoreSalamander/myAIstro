/**
 * HighlightableText — reusable text view that supports user highlights.
 *
 * Wraps a block of text. Renders existing highlights inline with
 * colored backgrounds. When the user selects text inside the
 * container, a small floating toolbar appears near the selection
 * with three color buttons (green = mastery, yellow = important,
 * blue = needs review) plus Cancel. Clicking a color saves the
 * highlight via the /api/highlights endpoint; saved highlights
 * appear immediately via the parent's refresh callback.
 *
 * Click on an existing highlight to show a small action chip
 * ("remove") so wrong highlights can be undone without going to the
 * API directly.
 *
 * Props:
 *   text                — the source string being highlighted
 *   highlights          — array of highlight records for THIS source
 *                         (already filtered by sourceType + sourceRef
 *                         by the parent; this component just renders
 *                         whatever it's given)
 *   lessonEventId       — passed through on save
 *   sourceType          — "raw_text" | "notebook_section"
 *   sourceRef           — identity object the data layer will store
 *   onChange            — called after successful save/delete so the
 *                         parent can refetch and pass new highlights
 *   className            — optional extra class for the container
 *
 * Why an offset-based render rebuild on every render:
 *   - Simpler than DOM mutation. Highlights can be sorted + sliced
 *     into spans on render. No diffing, no race conditions.
 *   - Cost is O(text length + N highlights), trivial at our scale
 *     (one lesson ≤ ~15k chars, typically <20 highlights).
 *
 * Why store highlights with verbatim text AND offsets:
 *   - Offsets are the render hint. If the offset still matches the
 *     text at that position, render there.
 *   - If the text has shifted (audit-loop re-summary, manual edit),
 *     fall back to searching for the verbatim text and re-snapping.
 *     Implemented in resolveHighlightPositions() below.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeFetch } from "../../lib/writeAuth";

// Color → background tint mapping. Three locked colors per the H2
// design discussion. Each color carries a downstream semantic:
//   green  → user-asserted mastery goal (merges into mastery_goals)
//   yellow → general "this matters"
//   blue   → "I should come back to this"
const COLOR_STYLES = {
  green: {
    bg: "rgba(57, 255, 20, 0.22)",
    border: "rgba(57, 255, 20, 0.55)",
    label: "Mastery",
    description: "Mark as a mastery goal — will appear in Classroom CHECKs",
  },
  yellow: {
    bg: "rgba(247, 255, 0, 0.20)",
    border: "rgba(247, 255, 0, 0.55)",
    label: "Important",
    description: "General \"this matters\" — surfaced in your highlights",
  },
  blue: {
    bg: "rgba(71, 191, 255, 0.22)",
    border: "rgba(71, 191, 255, 0.55)",
    label: "Confused",
    description: "Needs review — come back to this later",
  },
};

const COLOR_KEYS = Object.keys(COLOR_STYLES);


export default function HighlightableText({
  text,
  highlights,
  lessonEventId,
  sourceType,
  sourceRef,
  onChange,
  className,
}) {
  const containerRef = useRef(null);
  const [selectionState, setSelectionState] = useState(null);
  // selectionState shape when active:
  //   { text: string, start: int, end: int, top: int, left: int, note: string }
  const [busy, setBusy] = useState(false);
  const [actionHighlight, setActionHighlight] = useState(null);
  // actionHighlight shape: { id, top, left } when an existing highlight is tapped

  // Resolve each highlight's actual position in the current text.
  // Defends against source edits — if the offsets are stale but the
  // verbatim text exists somewhere else in the source, re-snap to
  // the found position.
  const resolved = useMemo(
    () => resolveHighlightPositions(text, highlights || []),
    [text, highlights]
  );

  // Build the rendered spans (text broken into unhighlighted + highlighted chunks).
  const rendered = useMemo(
    () => renderWithHighlights(text, resolved, setActionHighlight),
    [text, resolved]
  );

  // Capture text selection within the container. Triggered on mouseup
  // so the selection is final by then. Computes character offsets
  // relative to the container's textContent — works correctly even
  // when existing highlight spans are nested.
  const handleMouseUp = useCallback(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      setSelectionState(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!containerEl.contains(range.startContainer) || !containerEl.contains(range.endContainer)) {
      // selection started or ended outside the highlightable area — ignore
      setSelectionState(null);
      return;
    }
    const selectedText = sel.toString();
    if (!selectedText.trim()) {
      setSelectionState(null);
      return;
    }
    // Offset start: walk a synthetic range from container-start to
    // selection-start; its toString().length is the character offset.
    const preRange = document.createRange();
    preRange.selectNodeContents(containerEl);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end = start + selectedText.length;

    // Position the toolbar above the selection — clip to viewport.
    const rect = range.getBoundingClientRect();
    const containerRect = containerEl.getBoundingClientRect();
    setSelectionState({
      text: selectedText,
      start,
      end,
      // positioning is relative to the container so toolbar moves with
      // the content as the user scrolls within the parent panel
      top: rect.top - containerRect.top - 56,
      left: Math.max(0, rect.left - containerRect.left),
      note: "",
    });
    setActionHighlight(null);
  }, []);

  // Clear floating UI on any outside click that isn't inside the
  // container OR the toolbar. The toolbar/action chip handle their own
  // click events; this just catches "user clicked away."
  useEffect(() => {
    function onDocClick(e) {
      const containerEl = containerRef.current;
      if (!containerEl) return;
      // Allow clicks within the container itself — selection state will
      // get updated by mouseup if there's a new selection, or cleared
      // because the click collapsed the selection.
      if (containerEl.contains(e.target)) return;
      // Allow clicks on our own toolbar (it's portal-style absolute-
      // positioned but its DOM is inside this component).
      if (e.target.closest && e.target.closest("[data-highlight-toolbar]")) return;
      setSelectionState(null);
      setActionHighlight(null);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  async function saveHighlight(color) {
    if (!selectionState || busy) return;
    setBusy(true);
    try {
      const res = await writeFetch("/api/highlights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lesson_event_id: lessonEventId,
          source_type: sourceType,
          source_ref: sourceRef,
          start: selectionState.start,
          end: selectionState.end,
          text: selectionState.text,
          color,
          note: selectionState.note || "",
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body.slice(0, 200) || `HTTP ${res.status}`);
      }
      setSelectionState(null);
      onChange && onChange();
    } catch (e) {
      // Surface the error inline — don't kill the selection state so the
      // user can retry without re-selecting.
      // eslint-disable-next-line no-console
      console.error("Failed to save highlight:", e);
      alert(`Could not save highlight: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteHighlight(highlightId) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await writeFetch(
        `/api/highlights/${encodeURIComponent(highlightId)}?lesson_event_id=${encodeURIComponent(lessonEventId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body.slice(0, 200) || `HTTP ${res.status}`);
      }
      setActionHighlight(null);
      onChange && onChange();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Failed to delete highlight:", e);
      alert(`Could not delete highlight: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ position: "relative" }}
      className={className}
      data-highlightable
    >
      <div
        ref={containerRef}
        onMouseUp={handleMouseUp}
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          userSelect: "text",
          cursor: "text",
        }}
      >
        {rendered}
      </div>

      {selectionState && (
        <HighlightToolbar
          state={selectionState}
          busy={busy}
          onPick={saveHighlight}
          onNoteChange={(note) => setSelectionState((s) => s && { ...s, note })}
          onCancel={() => setSelectionState(null)}
        />
      )}

      {actionHighlight && (
        <HighlightActionChip
          state={actionHighlight}
          busy={busy}
          onDelete={() => deleteHighlight(actionHighlight.id)}
          onCancel={() => setActionHighlight(null)}
        />
      )}
    </div>
  );
}


// ============================================================
//  Floating toolbar — appears above text selection
// ============================================================
function HighlightToolbar({ state, busy, onPick, onNoteChange, onCancel }) {
  return (
    <div
      data-highlight-toolbar
      style={{
        position: "absolute",
        top: Math.max(state.top, 4),
        left: state.left,
        zIndex: 50,
        background: "var(--panel-strong, rgba(15, 18, 26, 0.96))",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: "1px solid var(--border-strong, rgba(255,255,255,0.18))",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 260,
      }}
      // Stop the document click handler from closing us when the user
      // taps inside the toolbar (e.g. focusing the note input).
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", gap: 6 }}>
        {COLOR_KEYS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onPick(color)}
            disabled={busy}
            title={COLOR_STYLES[color].description}
            style={{
              flex: 1,
              padding: "6px 10px",
              background: COLOR_STYLES[color].bg,
              border: `1px solid ${COLOR_STYLES[color].border}`,
              borderRadius: 5,
              color: "var(--text)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: busy ? "wait" : "pointer",
            }}
          >
            {COLOR_STYLES[color].label}
          </button>
        ))}
      </div>
      <input
        type="text"
        placeholder="Optional note (one line)"
        value={state.note}
        onChange={(e) => onNoteChange(e.target.value)}
        disabled={busy}
        style={{
          padding: "5px 8px",
          background: "rgba(0,0,0,0.4)",
          border: "1px solid var(--border, rgba(255,255,255,0.12))",
          borderRadius: 4,
          color: "var(--text)",
          fontSize: 11,
          fontFamily: "inherit",
          outline: "none",
        }}
        maxLength={200}
      />
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        style={{
          padding: "4px",
          background: "transparent",
          border: "none",
          color: "var(--text-mute)",
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.08em",
          cursor: "pointer",
          textTransform: "uppercase",
          alignSelf: "flex-end",
        }}
      >
        Cancel
      </button>
    </div>
  );
}


// ============================================================
//  Action chip — appears when an existing highlight is clicked
// ============================================================
function HighlightActionChip({ state, busy, onDelete, onCancel }) {
  return (
    <div
      data-highlight-toolbar
      style={{
        position: "absolute",
        top: Math.max(state.top - 36, 4),
        left: state.left,
        zIndex: 50,
        background: "var(--panel-strong, rgba(15, 18, 26, 0.96))",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: "1px solid var(--border-strong, rgba(255,255,255,0.18))",
        borderRadius: 6,
        boxShadow: "0 6px 16px rgba(0,0,0,0.5)",
        padding: 4,
        display: "flex",
        gap: 4,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        title="Remove this highlight"
        style={{
          padding: "5px 10px",
          background: "rgba(239,68,68,0.15)",
          border: "1px solid rgba(239,68,68,0.45)",
          borderRadius: 4,
          color: "#ef4444",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.06em",
          cursor: busy ? "wait" : "pointer",
          textTransform: "uppercase",
        }}
      >
        Remove
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        style={{
          padding: "5px 8px",
          background: "transparent",
          border: "1px solid var(--border, rgba(255,255,255,0.18))",
          borderRadius: 4,
          color: "var(--text-mute)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.06em",
          cursor: busy ? "wait" : "pointer",
          textTransform: "uppercase",
        }}
      >
        Cancel
      </button>
    </div>
  );
}


// ============================================================
//  Render utility — text + highlights → array of spans
// ============================================================
function renderWithHighlights(text, resolvedHighlights, setActionHighlight) {
  if (!resolvedHighlights || resolvedHighlights.length === 0) {
    // Plain text — no spans needed.
    return text;
  }
  // Sort by start position, then resolve any overlaps (later highlight
  // wins on overlap — simplest behavior; v2 could draw split styles).
  const sorted = [...resolvedHighlights]
    .filter((h) => h._resolved && h._resolved.start >= 0)
    .sort((a, b) => a._resolved.start - b._resolved.start);

  const out = [];
  let cursor = 0;
  sorted.forEach((h, i) => {
    const { start, end } = h._resolved;
    if (start < cursor) {
      // overlap — skip this one for now (v1 simplification)
      return;
    }
    if (start > cursor) {
      out.push(text.slice(cursor, start));
    }
    const palette = COLOR_STYLES[h.color] || COLOR_STYLES.yellow;
    out.push(
      <mark
        key={`h-${h.id || i}`}
        title={h.note ? `${palette.label}: ${h.note}` : palette.label}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const parentRect = e.currentTarget.closest("[data-highlightable]")?.getBoundingClientRect();
          // If we can't find the parent, fall back to viewport coords —
          // the chip will still appear, just possibly mispositioned.
          const top = parentRect ? rect.bottom - parentRect.top : rect.bottom;
          const left = parentRect ? rect.left - parentRect.left : rect.left;
          setActionHighlight({ id: h.id, top, left });
        }}
        style={{
          background: palette.bg,
          color: "inherit",
          padding: "1px 3px",
          borderRadius: 3,
          borderBottom: `1px solid ${palette.border}`,
          cursor: "pointer",
        }}
      >
        {text.slice(start, end)}
      </mark>
    );
    cursor = end;
  });
  if (cursor < text.length) {
    out.push(text.slice(cursor));
  }
  return out;
}


// ============================================================
//  Position resolution — defend against stale offsets
// ============================================================
function resolveHighlightPositions(text, highlights) {
  if (!text) return [];
  return highlights.map((h) => {
    const { start, end, text: stored } = h;
    // Fast path: stored offsets still match — use them.
    if (
      typeof start === "number" &&
      typeof end === "number" &&
      end <= text.length &&
      text.slice(start, end) === stored
    ) {
      return { ...h, _resolved: { start, end } };
    }
    // Fallback: search for the verbatim text. First occurrence wins
    // (good enough for v1; v2 could prefer nearest-to-stored-offset).
    if (stored) {
      const found = text.indexOf(stored);
      if (found >= 0) {
        return { ...h, _resolved: { start: found, end: found + stored.length } };
      }
    }
    // Couldn't relocate — mark as unresolved so render skips it.
    return { ...h, _resolved: { start: -1, end: -1 } };
  });
}
