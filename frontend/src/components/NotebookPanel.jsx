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

import { useCallback, useEffect, useState } from "react";
import { MarkdownBody } from "../lib/markdown";
import { writeFetch } from "../lib/writeAuth";

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
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "24px 32px 40px",
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
        </div>
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
