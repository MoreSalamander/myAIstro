/**
 * LessonDrawer — the slide-in detail panel for a single SOT entry.
 *
 * Triggered when the user clicks a node in the graph or a row in the
 * list. Shows the entry's full structured content (summary, concepts,
 * definitions, code, raw text) plus the three action buttons that hand
 * off to other surfaces:
 *   - Quiz  → opens QuizPanel preset to this entry
 *   - Chat  → opens ChatPanel seeded with this lesson as a query starter
 *   - Teach → opens ClassroomPanel preset to this entry (if classroom
 *             feature flag is on; otherwise the prop is omitted)
 *
 * Animation: slides in from the right. The component intentionally
 * keeps the previous entry in `stash` after `entry` clears to null,
 * so the slide-OUT transition can play before the DOM is removed.
 *
 * @param {object}    props
 * @param {object}    props.entry    The SOT entry to display, or null to close
 * @param {Function}  props.onClose  Close handler
 * @param {Function}  props.onQuiz   Open quiz on this entry
 * @param {Function}  props.onChat   Open advisor chat seeded with this lesson
 * @param {Function} [props.onTeach] Open classroom on this entry (optional)
 */

import { useEffect, useState } from "react";

export default function LessonDrawer({ entry, onClose, onQuiz, onChat, onTeach }) {
  // Slide-in animation: render even when entry is null briefly so the
  // exit transition can play. Track an "open" boolean separately.
  const [open, setOpen] = useState(false);
  const [stash, setStash] = useState(entry);

  useEffect(() => {
    if (entry) {
      setStash(entry);
      // next tick — let mount happen, then animate in
      const id = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(id);
    } else {
      setOpen(false);
    }
  }, [entry]);

  // Clear stash a bit after close so the slide-out can complete.
  useEffect(() => {
    if (!open && stash) {
      const t = setTimeout(() => setStash(null), 240);
      return () => clearTimeout(t);
    }
  }, [open, stash]);

  if (!stash) return null;

  const lesson = stash.lesson ?? "";
  const course = stash.course ?? "";
  const week = stash.week ?? "";
  const summary = stash.summary ?? "";
  const concepts = stash.key_concepts ?? [];
  const definitions = stash.definitions ?? [];

  return (
    <div
      style={{
        position: "fixed",
        top: 180,
        right: open ? 24 : -440,
        bottom: 96,
        width: 400,
        background: "var(--panel-strong)",
        border: "1px solid var(--border-strong)",
        borderRadius: 14,
        boxShadow: "0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(57,255,20,0.06)",
        backdropFilter: "blur(14px)",
        zIndex: 35,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        opacity: open ? 1 : 0,
        transition: "right 0.24s ease, opacity 0.24s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          padding: "16px 18px 8px",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "var(--accent)",
              marginBottom: 6,
            }}
          >
            {course} · WEEK {week}
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              color: "var(--text)",
              lineHeight: 1.25,
            }}
          >
            {lesson}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-dim)",
            cursor: "pointer",
            width: 28,
            height: 28,
            borderRadius: 6,
            fontSize: 16,
            lineHeight: 1,
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
          }}
        >
          ×
        </button>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 18px 18px",
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        {summary && (
          <p style={{ margin: "0 0 16px 0", color: "var(--text)", opacity: 0.9 }}>
            {summary}
          </p>
        )}

        {concepts.length > 0 && (
          <Section label="key concepts">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {concepts.map((c, i) => (
                <span
                  key={i}
                  style={{
                    background: "var(--accent-bg)",
                    border: "1px solid var(--accent-soft)",
                    color: "var(--accent)",
                    padding: "2px 8px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    letterSpacing: "0.02em",
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          </Section>
        )}

        {definitions.length > 0 && (
          <Section label="definitions">
            {definitions.map((d, i) => (
              <div
                key={i}
                style={{
                  color: "var(--text)",
                  opacity: 0.78,
                  marginBottom: 4,
                  fontSize: 12.5,
                }}
              >
                · {d}
              </div>
            ))}
          </Section>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          padding: 12,
          borderTop: "1px solid var(--border)",
          background: "rgba(0,0,0,0.2)",
        }}
      >
        <ActionBtn onClick={() => onQuiz(stash)}>Quiz me</ActionBtn>
        <ActionBtn onClick={() => onChat(stash)}>my-AI-stro Chat</ActionBtn>
        {onTeach && (
          <ActionBtn onClick={() => onTeach(stash)}>Teach me this</ActionBtn>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: "var(--text-mute)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function ActionBtn({ onClick, children }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1,
        padding: "9px 12px",
        background: hover ? "var(--accent-bg)" : "rgba(255,255,255,0.04)",
        border: "1px solid",
        borderColor: hover ? "var(--accent-soft)" : "var(--border-strong)",
        color: hover ? "var(--accent)" : "var(--text)",
        borderRadius: 7,
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        fontFamily: "var(--font-mono)",
        boxShadow: hover ? "0 0 16px var(--accent-glow)" : "none",
        transition: "background 0.15s, color 0.15s, box-shadow 0.2s",
      }}
    >
      {children}
    </button>
  );
}
