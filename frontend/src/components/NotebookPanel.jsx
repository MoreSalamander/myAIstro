/**
 * NotebookPanel — the view for user-saved advisor outputs.
 *
 * Two-pane layout:
 *   - Left:  list of saved notes (title, query, source courses, date)
 *   - Right: full detail view of the currently-selected note
 *
 * Selecting a note loads its full content (GET /api/notebook/{id}) and
 * renders the structured pieces (arc → section ×N → recap) using the
 * shared markdown renderer (lib/markdown.jsx) so the visual treatment
 * matches the live advisor chat exactly.
 *
 * Each section piece carries an event_id reference to its source SOT
 * entry. Clicking the lesson chip on a section opens the LessonDrawer
 * for that entry, so the Notebook is a real navigation hub between
 * derived content and the SOT lessons it was assembled from.
 *
 * Snapshot semantics: notes never change after save. Even if the
 * underlying SOT evolves (re-ingest, audit-cycle displacement), the
 * saved note continues to render exactly as it was generated.
 *
 * @param {object}   props
 * @param {number}   [props.dataVersion]    Bumped externally — triggers
 *                                          a list re-fetch (currently
 *                                          unused; the Notebook is
 *                                          decoupled from SOT changes).
 * @param {Function} [props.onSelectLesson] Called with a SOT entry
 *                                          summary when the user clicks
 *                                          a section's source chip;
 *                                          parent (App.jsx) opens the
 *                                          LessonDrawer in response.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownBody } from "../lib/markdown";
import HighlightableText from "./highlights/HighlightableText";
import { writeFetch } from "../lib/writeAuth";
import { useIsMobile } from "../lib/useMediaQuery";

export default function NotebookPanel({ dataVersion = 0, onSelectLesson, onTeachSection } = {}) {
  // ----- LIST STATE -----
  const [notes, setNotes] = useState(null);          // null = loading; array = loaded
  const [listError, setListError] = useState(null);
  const [filter, setFilter] = useState("");

  // ----- DETAIL STATE -----
  const [activeId, setActiveId] = useState(null);    // notebook_id of selected
  const [active, setActive] = useState(null);        // full note content
  const [activeError, setActiveError] = useState(null);
  const [activeLoading, setActiveLoading] = useState(false);

  // ----- DELETE FLOW -----
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // ----- MOBILE LAYOUT -----
  // Two-pane layout (360px sidebar + flex detail) collapses badly on a
  // ~400px phone screen — the sidebar eats almost all the width and the
  // detail vanishes. Mobile gets a single-pane layout with a dropdown
  // picker at the top that opens the list.
  const isMobile = useIsMobile();

  // -------- LIST FETCH --------
  const refreshList = useCallback(async () => {
    setListError(null);
    try {
      const r = await fetch("/api/notebook/list");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setNotes(Array.isArray(data) ? data : []);
    } catch (e) {
      setListError(e.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList, dataVersion]);

  // Mobile: auto-select the most recent note once the list loads so the
  // user lands on actual content, not a "pick something" empty state.
  // The API already returns notes newest-first.
  // Desktop keeps the explicit "select a note on the left" empty state —
  // the sidebar is right there and obvious.
  useEffect(() => {
    if (!isMobile) return;
    if (activeId) return;
    if (!notes || notes.length === 0) return;
    setActiveId(notes[0].notebook_id);
  }, [isMobile, notes, activeId]);

  // -------- DETAIL FETCH --------
  useEffect(() => {
    if (!activeId) {
      setActive(null);
      setActiveError(null);
      return;
    }
    let cancelled = false;
    setActiveLoading(true);
    setActiveError(null);
    setConfirmDelete(false);
    (async () => {
      try {
        const r = await fetch(`/api/notebook/${activeId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setActive(data);
      } catch (e) {
        if (!cancelled) setActiveError(e.message ?? String(e));
      } finally {
        if (!cancelled) setActiveLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // -------- DELETE --------
  const onDelete = useCallback(async () => {
    if (!activeId || deleteBusy) return;
    setDeleteBusy(true);
    try {
      const r = await writeFetch(`/api/notebook/${activeId}`, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
      }
      setActiveId(null);
      setConfirmDelete(false);
      refreshList();
    } catch (e) {
      setActiveError(e.message ?? String(e));
    } finally {
      setDeleteBusy(false);
    }
  }, [activeId, deleteBusy, refreshList]);

  // -------- FILTERED LIST --------
  const f = filter.toLowerCase().trim();
  const visible = (notes ?? []).filter((n) => {
    if (!f) return true;
    return (
      (n.title ?? "").toLowerCase().includes(f) ||
      (n.query ?? "").toLowerCase().includes(f) ||
      (n.source_courses ?? []).some((c) => c.toLowerCase().includes(f))
    );
  });

  // ============================================================
  //  MOBILE LAYOUT — single pane, list collapsed into a dropdown
  // ============================================================
  if (isMobile) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          zIndex: 5,
        }}
      >
        {/* Picker bar — always-visible top strip. Shows current note's
            title + a chevron; tapping opens the list. */}
        <MobileNotePicker
          notes={visible}
          allNotes={notes}
          activeId={activeId}
          activeNote={active}
          filter={filter}
          onFilterChange={setFilter}
          onPick={(id) => setActiveId(id)}
          listError={listError}
        />

        {/* Detail pane — fills the rest of the screen. */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {!activeId && notes && notes.length === 0 && (
            <NotebookEmpty />
          )}
          {!activeId && notes && notes.length > 0 && (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-mute)",
                fontSize: 13,
                padding: 32,
                textAlign: "center",
              }}
            >
              Tap the picker above to choose a note.
            </div>
          )}
          {activeId && activeLoading && (
            <div style={{ padding: 24, color: "var(--text-dim)", fontSize: 13 }}>
              Loading note…
            </div>
          )}
          {activeId && activeError && (
            <div style={{ padding: 24, color: "var(--danger)", fontSize: 13 }}>
              {activeError}
            </div>
          )}
          {activeId && active && (
            <NoteDetail
              note={active}
              confirmDelete={confirmDelete}
              onAskDelete={() => setConfirmDelete(true)}
              onCancelDelete={() => setConfirmDelete(false)}
              onConfirmDelete={onDelete}
              deleteBusy={deleteBusy}
              onSelectLesson={onSelectLesson}
              onTeachSection={onTeachSection}
            />
          )}
        </div>
      </div>
    );
  }

  // ============================================================
  //  DESKTOP LAYOUT — two-pane (sidebar list + detail)
  // ============================================================
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        zIndex: 5,
      }}
    >
      {/* ===================== LEFT: LIST ===================== */}
      <div
        style={{
          width: 360,
          minWidth: 280,
          maxWidth: "40%",
          borderRight: "1px solid var(--border-strong, rgba(255,255,255,0.08))",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "20px 18px 14px",
            borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "var(--accent)",
              marginBottom: 12,
            }}
          >
            Notebook · saved advisor outputs
          </div>
          <input
            type="text"
            placeholder="Filter by title, query, or course…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              width: "100%",
              padding: "8px 12px",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--border-strong)",
              borderRadius: 6,
              color: "var(--text)",
              outline: "none",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              boxSizing: "border-box",
            }}
          />
          {notes && (
            <div
              style={{
                marginTop: 10,
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-mute)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              {visible.length} of {notes.length} note{notes.length === 1 ? "" : "s"}
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {listError && (
            <div style={{ padding: 18, color: "var(--danger)", fontSize: 13 }}>
              {listError}
            </div>
          )}
          {!notes && !listError && (
            <div style={{ padding: 18, color: "var(--text-dim)", fontSize: 13 }}>
              Loading…
            </div>
          )}
          {notes && notes.length === 0 && (
            <NotebookEmpty />
          )}
          {visible.map((n) => (
            <NoteListItem
              key={n.notebook_id}
              note={n}
              active={n.notebook_id === activeId}
              onClick={() => setActiveId(n.notebook_id)}
            />
          ))}
        </div>
      </div>

      {/* ===================== RIGHT: DETAIL ===================== */}
      <div
        style={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {!activeId && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-mute)",
              fontSize: 13,
              padding: 40,
              textAlign: "center",
            }}
          >
            {notes && notes.length > 0
              ? "Select a note on the left to view it."
              : "Generate a study guide in my-AI-stro Chat, then save it here from the response."}
          </div>
        )}

        {activeId && activeLoading && (
          <div style={{ padding: 28, color: "var(--text-dim)", fontSize: 13 }}>
            Loading note…
          </div>
        )}

        {activeId && activeError && (
          <div style={{ padding: 28, color: "var(--danger)", fontSize: 13 }}>
            {activeError}
          </div>
        )}

        {activeId && active && (
          <NoteDetail
            note={active}
            confirmDelete={confirmDelete}
            onAskDelete={() => setConfirmDelete(true)}
            onCancelDelete={() => setConfirmDelete(false)}
            onConfirmDelete={onDelete}
            deleteBusy={deleteBusy}
            onSelectLesson={onSelectLesson}
            onTeachSection={onTeachSection}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================
//  NoteListItem — one row in the left pane
// ============================================================
function NoteListItem({ note, active, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "12px 18px",
        cursor: "pointer",
        borderLeft: active
          ? "3px solid var(--accent)"
          : "3px solid transparent",
        background: active ? "rgba(57,255,20,0.06)" : "transparent",
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.03)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: active ? "var(--accent)" : "var(--text)",
          marginBottom: 4,
          lineHeight: 1.3,
        }}
      >
        {note.title || "(untitled)"}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          fontStyle: "italic",
          marginBottom: 6,
          lineHeight: 1.4,
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {note.query}
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          color: "var(--text-mute)",
        }}
      >
        {(note.source_courses ?? []).slice(0, 4).map((c) => (
          <span
            key={c}
            style={{
              padding: "1px 6px",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 999,
              letterSpacing: "0.06em",
            }}
          >
            {c}
          </span>
        ))}
        <span style={{ marginLeft: "auto" }}>
          {note.section_count} sec · {(note.created_at ?? "").slice(0, 10)}
        </span>
      </div>
    </div>
  );
}

// ============================================================
//  MobileNotePicker — top-of-screen dropdown that collapses the
//  whole left sidebar (list + filter + count) into one tap target.
//  Same idiom as MobileViewPicker in App.jsx — chevron toggles a
//  panel that hangs below the trigger.
// ============================================================
function MobileNotePicker({ notes, allNotes, activeId, activeNote, filter, onFilterChange, onPick, listError }) {
  const [open, setOpen] = useState(false);
  // The trigger label: current note's title if one's selected, else a
  // generic "pick a note" placeholder. Falls back gracefully while the
  // detail fetch is still in flight (activeId set but activeNote null).
  const triggerLabel = activeNote?.title
    || (allNotes ?? []).find((n) => n.notebook_id === activeId)?.title
    || (allNotes && allNotes.length > 0 ? "Pick a saved note…" : "Notebook");

  function pick(id) {
    onPick(id);
    setOpen(false);
  }

  return (
    <div
      style={{
        position: "relative",
        borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
        background: "rgba(4,6,10,0.92)",
        flexShrink: 0,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "12px 14px",
          background: "transparent",
          border: "none",
          color: "var(--text)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          letterSpacing: "0.06em",
          cursor: "pointer",
          textAlign: "left",
          minHeight: 48,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
            flex: 1,
          }}
        >
          <span
            style={{
              fontSize: 9,
              textTransform: "uppercase",
              color: "var(--accent)",
              letterSpacing: "0.18em",
              flexShrink: 0,
            }}
          >
            📓 Notebook
          </span>
          <span
            style={{
              fontWeight: 600,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {triggerLabel}
          </span>
        </span>
        <span
          style={{
            color: "var(--text-mute)",
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <>
          {/* Tap-outside catcher — separate transparent layer so taps
              inside the popout don't bubble through. */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.4)",
              zIndex: 40,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              background: "var(--panel-strong)",
              borderBottom: "1px solid var(--border-strong)",
              boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
              zIndex: 41,
              maxHeight: "70vh",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "12px 14px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <input
                type="text"
                placeholder="Filter by title, query, or course…"
                value={filter}
                onChange={(e) => onFilterChange(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 6,
                  color: "var(--text)",
                  outline: "none",
                  fontSize: 13,
                  fontFamily: "var(--font-mono)",
                  boxSizing: "border-box",
                }}
                autoFocus
              />
              {allNotes && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-mute)",
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  {notes.length} of {allNotes.length} note{allNotes.length === 1 ? "" : "s"}
                </div>
              )}
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
              {listError && (
                <div style={{ padding: 14, color: "var(--danger)", fontSize: 13 }}>
                  {listError}
                </div>
              )}
              {!allNotes && !listError && (
                <div style={{ padding: 14, color: "var(--text-dim)", fontSize: 13 }}>
                  Loading…
                </div>
              )}
              {allNotes && allNotes.length === 0 && (
                <NotebookEmpty />
              )}
              {notes.map((n) => (
                <NoteListItem
                  key={n.notebook_id}
                  note={n}
                  active={n.notebook_id === activeId}
                  onClick={() => pick(n.notebook_id)}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
//  NotebookEmpty — empty-state CTA for the left pane
// ============================================================
function NotebookEmpty() {
  return (
    <div
      style={{
        padding: "24px 20px",
        color: "var(--text-dim)",
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--text-mute)",
          marginBottom: 10,
        }}
      >
        No saved notes yet
      </div>
      Generate a study guide in <strong>my-AI-stro Chat</strong>, then click{" "}
      <em>★ Save to Notebook</em> on the response. Saved notes appear here
      and render exactly as they were generated — same markdown, same
      syntax-highlighted code — without re-running the pipeline.
    </div>
  );
}

// ============================================================
//  NoteDetail — full right-pane view of a saved note
// ============================================================
function NoteDetail({ note, confirmDelete, onAskDelete, onCancelDelete, onConfirmDelete, deleteBusy, onSelectLesson, onTeachSection }) {
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        // Tighter horizontal padding on mobile so the markdown body gets
        // the full screen width instead of losing 64px to gutters that
        // exist for the desktop two-pane layout's visual breathing room.
        padding: isMobile ? "16px 14px 32px" : "24px 32px 40px",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--text-mute)",
            marginBottom: 6,
          }}
        >
          Saved note · {(note.created_at ?? "").slice(0, 19).replace("T", " ")} UTC
          {note.model && <> · {note.model}</>}
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 700,
            color: "var(--text)",
            lineHeight: 1.2,
          }}
        >
          {note.title || "(untitled)"}
        </h1>
        <div
          style={{
            marginTop: 8,
            fontSize: 12.5,
            color: "var(--text-dim)",
            fontStyle: "italic",
          }}
        >
          Original query: “{note.query}”
        </div>
      </div>

      {/* Pieces */}
      <div className="chat-md">
        {(note.pieces ?? []).map((p, i) => (
          <PieceBlock
            key={i}
            piece={p}
            pieceIndex={i}
            notebookId={note.notebook_id}
            onSelectLesson={onSelectLesson}
            onTeachSection={onTeachSection}
            isLast={i === (note.pieces ?? []).length - 1}
          />
        ))}
      </div>

      {/* Footer / delete */}
      <div
        style={{
          marginTop: 32,
          paddingTop: 18,
          borderTop: "1px solid var(--border, rgba(255,255,255,0.08))",
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
        }}
      >
        {!confirmDelete && (
          <button
            onClick={onAskDelete}
            style={{
              padding: "7px 14px",
              background: "transparent",
              border: "1px solid rgba(239,68,68,0.4)",
              borderRadius: 6,
              color: "rgba(239,68,68,0.85)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Delete note
          </button>
        )}
        {confirmDelete && (
          <>
            <span style={{ fontSize: 12, color: "var(--text-dim)", alignSelf: "center" }}>
              Delete this note permanently?
            </span>
            <button
              onClick={onCancelDelete}
              disabled={deleteBusy}
              style={{
                padding: "7px 14px",
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 6,
                color: "var(--text-dim)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                cursor: deleteBusy ? "wait" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={onConfirmDelete}
              disabled={deleteBusy}
              style={{
                padding: "7px 14px",
                background: "rgba(239,68,68,0.15)",
                border: "1px solid rgba(239,68,68,0.6)",
                borderRadius: 6,
                color: "#ef4444",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                cursor: deleteBusy ? "wait" : "pointer",
              }}
            >
              {deleteBusy ? "Deleting…" : "Confirm delete"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
//  PieceBlock — render one piece of a saved note
// ============================================================
function PieceBlock({ piece, pieceIndex, notebookId, onSelectLesson, onTeachSection, isLast }) {
  if (piece.kind === "section") {
    // Grounding-quality color cue on the source chip (if a
    // grounding_report was attached at save time, which is the case
    // for sections saved after the verification gate landed).
    const ratio = piece.grounding_report?.overall_ratio;
    const groundingColor =
      ratio == null
        ? "rgba(57,255,20,0.25)" // unknown — default accent
        : ratio >= 0.7
        ? "rgba(57,255,20,0.4)"  // strong grounding — bright
        : ratio >= 0.5
        ? "rgba(247,255,0,0.4)"  // medium — yellow
        : "rgba(239,68,68,0.45)"; // low — red
    return (
      <SectionPiece
        piece={piece}
        pieceIndex={pieceIndex}
        notebookId={notebookId}
        ratio={ratio}
        groundingColor={groundingColor}
        onSelectLesson={onSelectLesson}
        onTeachSection={onTeachSection}
        isLast={isLast}
      />
    );
  }
  // arc and recap — plain framing paragraphs, no source chip
  return (
    <div style={{ marginBottom: isLast ? 0 : 24 }}>
      <MarkdownBody>{piece.content}</MarkdownBody>
      {!isLast && (
        <hr style={{
          border: 0,
          borderTop: "1px solid rgba(255,255,255,0.08)",
          margin: "24px 0 0",
        }} />
      )}
    </div>
  );
}

// ============================================================
//  SectionPiece — section render with optional highlight mode
// ============================================================
//
// Default view: rendered markdown via MarkdownBody (unchanged from
// pre-H2 behavior). When the user toggles "Highlight," the body
// swaps to a HighlightableText view of the raw markdown source
// (piece.content), where text selection produces a colored highlight
// stored against the parent lesson.
//
// Why raw-markdown selection (not selection over the rendered HTML):
// the rendered DOM has nested block-level elements (paragraphs, lists,
// code blocks) which break the linear-offset model HighlightableText
// uses. Highlighting against the raw markdown is the simplest correct
// thing — the user reads the rendered view, switches to highlight mode
// when they want to mark a passage, and the highlight is stored
// verbatim against that raw text so it survives section reorderings.
function SectionPiece({
  piece,
  pieceIndex,
  notebookId,
  ratio,
  groundingColor,
  onSelectLesson,
  onTeachSection,
  isLast,
}) {
  const [highlightMode, setHighlightMode] = useState(false);
  const [highlights, setHighlights] = useState([]);
  const [highlightsLoaded, setHighlightsLoaded] = useState(false);

  const refreshHighlights = useCallback(async () => {
    if (!piece.event_id) return;
    try {
      const res = await fetch(
        `/api/highlights/${encodeURIComponent(piece.event_id)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      // Filter to highlights authored against THIS notebook section —
      // a single lesson's highlights file mixes raw_text + every notebook
      // section that references it.
      const onlyThisSection = Array.isArray(data)
        ? data.filter(
            (h) =>
              h.source_type === "notebook_section" &&
              h.source_ref?.notebook_id === notebookId &&
              h.source_ref?.section_index === pieceIndex
          )
        : [];
      setHighlights(onlyThisSection);
      setHighlightsLoaded(true);
    } catch {
      // best-effort
    }
  }, [piece.event_id, notebookId, pieceIndex]);

  // Eager-fetch highlights once so the count chip is accurate without
  // needing the user to open highlight mode first.
  useEffect(() => {
    if (!highlightsLoaded) refreshHighlights();
  }, [highlightsLoaded, refreshHighlights]);

  const sourceRef = useMemo(
    () => ({
      course: piece.course,
      week: piece.week,
      lesson: piece.lesson,
      notebook_id: notebookId,
      section_index: pieceIndex,
    }),
    [piece.course, piece.week, piece.lesson, notebookId, pieceIndex]
  );

  return (
      <div style={{ marginBottom: isLast ? 0 : 24 }}>
        {/* Chip row: source + teach */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          {piece.event_id && (
            <div
              onClick={() => onSelectLesson && onSelectLesson({
                id: piece.event_id,
                event_id: piece.event_id,
                course: piece.course,
                week: piece.week,
                lesson: piece.lesson,
              })}
              title={
                ratio != null
                  ? `Open the source SOT entry  ·  grounding ${Math.round(ratio * 100)}%`
                  : "Open the source SOT entry"
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 9px",
                background: "rgba(57,255,20,0.05)",
                border: `1px solid ${groundingColor}`,
                borderRadius: 999,
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.06em",
                color: "var(--accent)",
                cursor: onSelectLesson ? "pointer" : "default",
                userSelect: "none",
              }}
            >
              📖 {piece.course} · w{piece.week} · {piece.lesson}
              {ratio != null && (
                <span
                  style={{
                    fontSize: 9.5,
                    color: "rgba(255,255,255,0.55)",
                    marginLeft: 2,
                  }}
                >
                  · {Math.round(ratio * 100)}%
                </span>
              )}
            </div>
          )}
          {/* Teach-me-this — only available when the parent wired the
              callback (which it does in the main App but not in any
              read-only embedding of this panel). */}
          {onTeachSection && piece.event_id && (
            <button
              onClick={() =>
                onTeachSection({
                  notebook_id: notebookId,
                  section_index: pieceIndex,
                  course: piece.course,
                  week: piece.week,
                  lesson: piece.lesson,
                })
              }
              title="Generate a Classroom plan from this section and start a teaching session"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 9px",
                background: "rgba(247,255,0,0.06)",
                border: "1px solid rgba(247,255,0,0.35)",
                borderRadius: 999,
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.06em",
                color: "var(--accent-yellow, #f7ff00)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              🎓 Teach me this
            </button>
          )}
          {/* Highlight-mode toggle — swaps the body between rendered
              markdown and a raw-text view where the user can select
              passages to highlight. Only meaningful when there's a
              backing lesson event_id (cascade target for the highlight). */}
          {piece.event_id && (
            <button
              onClick={() => setHighlightMode((v) => !v)}
              title={
                highlightMode
                  ? "Exit highlight mode — back to rendered view"
                  : "Enter highlight mode — select passages to mark"
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 9px",
                background: highlightMode
                  ? "rgba(57,255,20,0.18)"
                  : "rgba(255,255,255,0.04)",
                border: highlightMode
                  ? "1px solid rgba(57,255,20,0.55)"
                  : "1px solid rgba(255,255,255,0.18)",
                borderRadius: 999,
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.06em",
                color: highlightMode ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              ✎ {highlightMode ? "Reading mode" : "Highlight mode"}
              {highlights.length > 0 && (
                <span
                  style={{
                    fontSize: 9.5,
                    color: "rgba(255,255,255,0.55)",
                    marginLeft: 2,
                  }}
                >
                  · {highlights.length}
                </span>
              )}
            </button>
          )}
        </div>
        {highlightMode ? (
          <HighlightableText
            text={piece.content}
            highlights={highlights}
            lessonEventId={piece.event_id}
            sourceType="notebook_section"
            sourceRef={sourceRef}
            onChange={refreshHighlights}
            className="notebook-highlight-surface"
          />
        ) : (
          <MarkdownBody>{piece.content}</MarkdownBody>
        )}
        {!isLast && (
          <hr style={{
            border: 0,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            margin: "24px 0 0",
          }} />
        )}
      </div>
    );
}
