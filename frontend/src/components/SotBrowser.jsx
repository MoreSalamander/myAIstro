/**
 * SotBrowser — the List view of the SOT.
 *
 * Renders every canonical entry as an expandable card showing the
 * structured summary, key concepts, definitions, code blocks, and the
 * original raw text. The reference layer of the app — meant for direct
 * reading rather than chat/quiz/teach interaction.
 *
 * Three secondary features wired in here:
 *   - Live filter (course / lesson / summary / key concepts substring)
 *   - Re-summarize button (per-card, write-password gated) that POSTs
 *     to /api/sot/resummarize and re-renders the card in place
 *   - Obsidian vault sync — manual trigger from the toolbar, with
 *     a status pill showing the last sync time
 *
 * The cards are deep-linkable: scroll-into-view by `event_id` when
 * navigated to from elsewhere in the app.
 *
 * @param {object} props
 * @param {number} [props.dataVersion]  Bumped by the parent after each
 *                                      successful ingest; triggers re-fetch.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { writeFetch } from "../lib/writeAuth";
import { CodeBlock } from "../lib/markdown";

export default function SotBrowser({ dataVersion = 0 } = {}) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState({});
  const [obsidian, setObsidian] = useState(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const cardRefs = useRef({});

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/sot");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries(data);
    } catch (e) {
      setError(e.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    loadObsidianStatus();
  }, [refresh, dataVersion]);

  async function loadObsidianStatus() {
    try {
      const res = await fetch("/api/sot/obsidian-status");
      if (!res.ok) return;
      setObsidian(await res.json());
    } catch {
      /* non-critical */
    }
  }

  async function syncObsidian() {
    if (syncBusy) return;
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const res = await writeFetch("/api/sot/sync-obsidian", {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSyncMsg(`Synced ${data.files_written} file(s) to ${data.vault_path}`);
      loadObsidianStatus();
    } catch (e) {
      setSyncMsg(`Sync failed: ${e.message ?? String(e)}`);
    } finally {
      setSyncBusy(false);
    }
  }

  // Precompute lowercased concept sets once per entries change so the
  // related-lookup inside each expanded card is cheap.
  const conceptIndex = useMemo(() => {
    const idx = new Map();
    for (const e of entries ?? []) {
      idx.set(
        e.event_id,
        new Set((e.key_concepts ?? []).map((c) => c.toLowerCase())),
      );
    }
    return idx;
  }, [entries]);

  const focusEntry = useCallback((eventId) => {
    setExpanded((prev) => ({ ...prev, [eventId]: true }));
    requestAnimationFrame(() => {
      const el = cardRefs.current[eventId];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  const f = filter.toLowerCase().trim();
  const visible = (entries ?? []).filter((e) => {
    if (!f) return true;
    return (
      (e.course ?? "").toLowerCase().includes(f) ||
      (e.lesson ?? "").toLowerCase().includes(f) ||
      (e.summary ?? "").toLowerCase().includes(f) ||
      (e.key_concepts ?? []).some((k) => k.toLowerCase().includes(f))
    );
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        paddingTop: 24,
        paddingBottom: 24,
        paddingLeft: 24,
        paddingRight: 24,
        overflowY: "auto",
        zIndex: 5,
      }}
    >
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <input
            type="text"
            placeholder="Filter by course, lesson, summary, or concept…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onFocus={(e) => {
              e.target.style.borderColor = "var(--accent-soft)";
              e.target.style.boxShadow = "0 0 16px var(--accent-glow)";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "var(--border-strong)";
              e.target.style.boxShadow = "none";
            }}
            style={{
              flex: 1,
              padding: "10px 14px",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              color: "var(--text)",
              outline: "none",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              transition: "border-color 0.15s, box-shadow 0.2s",
            }}
          />
          <button
            onClick={refresh}
            style={{
              padding: "10px 16px",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 8,
              color: "white",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Refresh
          </button>
        </div>

        {entries && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              fontSize: 12,
              color: "rgba(255,255,255,0.45)",
              marginBottom: 10,
            }}
          >
            <div>
              {visible.length} of {entries.length} entries
            </div>
            <ObsidianSync
              obsidian={obsidian}
              onSync={syncObsidian}
              busy={syncBusy}
              msg={syncMsg}
            />
          </div>
        )}

        {error && (
          <div style={{ color: "#ef4444", fontSize: 14 }}>{error}</div>
        )}
        {!entries && !error && (
          <div style={{ color: "rgba(255,255,255,0.5)" }}>Loading…</div>
        )}
        {entries && entries.length === 0 && (
          <div style={{ color: "rgba(255,255,255,0.5)" }}>
            SOT is empty. Switch to Ingest to add a lesson.
          </div>
        )}

        {visible.map((entry) => (
          <EntryCard
            key={entry.event_id}
            entry={entry}
            expanded={!!expanded[entry.event_id]}
            allEntries={entries ?? []}
            conceptIndex={conceptIndex}
            onJumpTo={focusEntry}
            registerRef={(el) => {
              if (el) cardRefs.current[entry.event_id] = el;
              else delete cardRefs.current[entry.event_id];
            }}
            onToggle={() =>
              setExpanded((prev) => ({
                ...prev,
                [entry.event_id]: !prev[entry.event_id],
              }))
            }
            onUpdate={(updated) =>
              setEntries((prev) =>
                prev.map((e) =>
                  e.event_id === updated.event_id ? updated : e,
                ),
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function ObsidianSync({ obsidian, onSync, busy, msg }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {obsidian && (
        <span
          title={obsidian.vault_path}
          style={{ color: "rgba(255,255,255,0.55)", fontSize: 11 }}
        >
          {obsidian.exists
            ? `Vault: ${obsidian.file_count} file(s)`
            : `Vault: not yet created`}
        </span>
      )}
      <button
        type="button"
        onClick={onSync}
        disabled={busy}
        style={{
          padding: "4px 10px",
          background: busy ? "rgba(168,85,247,0.4)" : "rgba(168,85,247,0.18)",
          border: "1px solid rgba(168,85,247,0.45)",
          borderRadius: 6,
          color: "white",
          cursor: busy ? "wait" : "pointer",
          fontSize: 11,
          fontFamily: "inherit",
        }}
      >
        {busy ? "Syncing…" : "Sync to Obsidian"}
      </button>
      {msg && (
        <span style={{ color: "rgba(255,255,255,0.55)", fontSize: 11 }}>
          {msg}
        </span>
      )}
    </div>
  );
}

const RELATED_LIMIT = 5;

function computeRelated(entry, allEntries, conceptIndex) {
  const my = conceptIndex.get(entry.event_id);
  if (!my || my.size === 0) return [];
  const scored = [];
  for (const other of allEntries) {
    if (other.event_id === entry.event_id) continue;
    const theirs = conceptIndex.get(other.event_id);
    if (!theirs || theirs.size === 0) continue;
    const shared = [];
    for (const c of my) if (theirs.has(c)) shared.push(c);
    if (shared.length === 0) continue;
    scored.push({ entry: other, shared, score: shared.length });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreak: prefer same course, then same week
    const sameCourseA = a.entry.course === entry.course ? 1 : 0;
    const sameCourseB = b.entry.course === entry.course ? 1 : 0;
    if (sameCourseA !== sameCourseB) return sameCourseB - sameCourseA;
    return (a.entry.lesson || "").localeCompare(b.entry.lesson || "");
  });
  return scored.slice(0, RELATED_LIMIT);
}

function EntryCard({
  entry,
  expanded,
  allEntries,
  conceptIndex,
  onJumpTo,
  registerRef,
  onToggle,
  onUpdate,
}) {
  const [resumState, setResumState] = useState({ busy: false, error: null });
  const related = useMemo(
    () => (expanded ? computeRelated(entry, allEntries, conceptIndex) : []),
    [expanded, entry, allEntries, conceptIndex],
  );

  async function resummarize(e) {
    e.stopPropagation();
    if (resumState.busy) return;
    setResumState({ busy: true, error: null });
    try {
      const res = await writeFetch("/api/sot/resummarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: entry.event_id }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const msg =
          typeof errBody?.detail === "string"
            ? errBody.detail
            : errBody?.detail?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const updated = await res.json();
      onUpdate(updated);
      setResumState({ busy: false, error: null });
    } catch (err) {
      setResumState({ busy: false, error: err.message ?? String(err) });
    }
  }

  return (
    <div
      ref={registerRef}
      onClick={onToggle}
      style={{
        background: "rgba(8,10,16,0.7)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 10,
        padding: 16,
        marginBottom: 10,
        cursor: "pointer",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "rgba(255,255,255,0.5)",
            }}
          >
            {entry.course} · week {entry.week}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
            {entry.lesson}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
          {entry.created_at?.slice(0, 10)}
        </div>
      </div>

      <div
        style={{
          marginTop: 10,
          color: "rgba(255,255,255,0.85)",
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {entry.summary}
      </div>

      {expanded && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {entry.key_concepts?.length > 0 && (
            <Section label="key concepts">
              {entry.key_concepts.join(" · ")}
            </Section>
          )}
          {entry.definitions?.length > 0 && (
            <Section label="definitions">
              {entry.definitions.map((d, i) => (
                <div key={i} style={{ marginTop: i === 0 ? 0 : 4 }}>
                  · {d}
                </div>
              ))}
            </Section>
          )}
          {entry.code_blocks?.length > 0 && (
            <Section label="code">
              {entry.code_blocks.map((c, i) => (
                // CodeBlock detects language from the code itself (no
                // language hints stored on SOT code_blocks) and renders
                // through the shared Prism/vsc-dark-plus pipeline.
                <CodeBlock key={i} code={c} />
              ))}
            </Section>
          )}
          {related.length > 0 && (
            <Section label="related lessons">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {related.map(({ entry: other, shared }) => (
                  <RelatedChip
                    key={other.event_id}
                    entry={other}
                    shared={shared}
                    onJump={() => onJumpTo(other.event_id)}
                  />
                ))}
              </div>
            </Section>
          )}
          {entry.raw_text && <RawLessonSection rawText={entry.raw_text} />}
          <div
            style={{
              marginTop: 12,
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            {entry.raw_text ? (
              <button
                type="button"
                onClick={resummarize}
                disabled={resumState.busy}
                style={{
                  padding: "6px 10px",
                  background: resumState.busy
                    ? "rgba(57,255,20,0.32)"
                    : "var(--accent-bg)",
                  border: "1px solid var(--accent-soft)",
                  borderRadius: 6,
                  color: "var(--accent)",
                  cursor: resumState.busy ? "wait" : "pointer",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                {resumState.busy ? "Re-summarizing…" : "Re-summarize"}
              </button>
            ) : (
              <span
                style={{
                  fontSize: 11,
                  color: "rgba(255,255,255,0.35)",
                  fontStyle: "italic",
                }}
              >
                No raw_text — re-ingest to enable re-summarization
              </span>
            )}
            <div
              style={{
                fontSize: 11,
                color: "rgba(255,255,255,0.4)",
              }}
            >
              event_id: {entry.event_id} · score: {entry.validation_score}
              {entry.resummarized_at && (
                <> · re-summarized {entry.resummarized_at.slice(0, 10)}</>
              )}
            </div>
          </div>
          {resumState.error && (
            <div
              style={{
                marginTop: 8,
                color: "#ef4444",
                fontSize: 12,
              }}
            >
              {resumState.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RelatedChip({ entry, shared, onJump }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onJump();
      }}
      style={{
        textAlign: "left",
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 6,
        padding: "8px 10px",
        cursor: "pointer",
        color: "white",
        fontFamily: "inherit",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(57,255,20,0.06)";
        e.currentTarget.style.borderColor = "rgba(57,255,20,0.35)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.03)";
        e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)";
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "rgba(255,255,255,0.45)",
          }}
        >
          {entry.course} · w{entry.week}
        </span>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{entry.lesson}</span>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "rgba(57,255,20,0.75)",
        }}
      >
        shared: {shared.join(" · ")}
      </div>
    </button>
  );
}

function RawLessonSection({ rawText }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          background: "transparent",
          border: "none",
          color: "rgba(255,255,255,0.5)",
          cursor: "pointer",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          padding: 0,
          fontFamily: "inherit",
        }}
      >
        {open ? "▾" : "▸"} Original lesson
      </button>
      {open && (
        <pre
          onClick={(e) => e.stopPropagation()}
          style={{
            marginTop: 8,
            padding: 12,
            background: "rgba(0,0,0,0.4)",
            borderRadius: 6,
            color: "rgba(255,255,255,0.78)",
            fontSize: 13,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            fontFamily: "inherit",
            maxHeight: 300,
            overflowY: "auto",
            margin: "8px 0 0 0",
            cursor: "text",
          }}
        >
          {rawText}
        </pre>
      )}
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.5)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ color: "rgba(255,255,255,0.78)", fontSize: 13 }}>
        {children}
      </div>
    </div>
  );
}
