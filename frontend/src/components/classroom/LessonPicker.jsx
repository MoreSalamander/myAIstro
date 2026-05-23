import { useEffect, useState } from "react";

/**
 * LessonPicker — initial Classroom state. Lists all SOT lessons; user
 * clicks one to start a session. If a `presetEntry` prop is passed
 * (from the LessonDrawer's "Teach me this" button), the picker is
 * skipped automatically by the parent.
 */
export default function LessonPicker({ onPick }) {
  const [entries, setEntries] = useState(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/sot")
      .then((r) => (r.ok ? r.json() : []))
      .then(setEntries)
      .catch((e) => setError(e.message ?? String(e)));
  }, []);

  const f = filter.toLowerCase().trim();
  const visible = (entries ?? []).filter((e) => {
    if (!f) return true;
    return (
      (e.course ?? "").toLowerCase().includes(f) ||
      (e.lesson ?? "").toLowerCase().includes(f) ||
      (e.summary ?? "").toLowerCase().includes(f)
    );
  });

  return (
    <div
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: 24,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--text-mute)",
          marginBottom: 10,
        }}
      >
        Classroom · pick a lesson to teach
      </div>
      <h2
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: "var(--text)",
          margin: "0 0 16px 0",
        }}
      >
        What do you want a class on?
      </h2>

      <input
        type="text"
        placeholder="Filter lessons…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{
          width: "100%",
          padding: "10px 14px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid var(--border-strong)",
          borderRadius: 8,
          color: "var(--text)",
          outline: "none",
          fontSize: 13,
          fontFamily: "var(--font-mono)",
          boxSizing: "border-box",
          marginBottom: 16,
        }}
      />

      {error && (
        <div style={{ color: "var(--danger)", fontSize: 13 }}>{error}</div>
      )}
      {!entries && !error && (
        <div style={{ color: "var(--text-dim)" }}>Loading lessons…</div>
      )}
      {entries && entries.length === 0 && (
        <div style={{ color: "var(--text-dim)" }}>
          No lessons in the SOT yet. Ingest one first.
        </div>
      )}

      {visible.map((entry) => (
        <PickerRow key={entry.event_id} entry={entry} onPick={onPick} />
      ))}
    </div>
  );
}

function PickerRow({ entry, onPick }) {
  return (
    <button
      onClick={() => onPick(entry)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 14,
        marginBottom: 8,
        cursor: "pointer",
        color: "var(--text)",
        fontFamily: "inherit",
        transition: "border-color 0.15s, background 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--accent-soft)";
        e.currentTarget.style.background = "var(--panel-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.background = "var(--panel)";
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--text-mute)",
          marginBottom: 4,
        }}
      >
        {entry.course} · week {entry.week}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{entry.lesson}</div>
      <div
        style={{
          marginTop: 6,
          fontSize: 12,
          color: "var(--text-dim)",
          lineHeight: 1.4,
        }}
      >
        {(entry.summary ?? "").slice(0, 180)}
        {(entry.summary ?? "").length > 180 ? "…" : ""}
      </div>
    </button>
  );
}
