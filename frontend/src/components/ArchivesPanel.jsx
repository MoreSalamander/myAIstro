import { useEffect, useState, useCallback } from "react";
import { writeFetch } from "../lib/writeAuth";

/**
 * ArchivesPanel — view of SOT entries that have been retired by the
 * audit agent. Newest-archived first, with the score that pushed each
 * one out and a click-to-expand for the full retired summary.
 *
 * The data here is read-only by design. Archives are not editable, not
 * re-summarizable, and not exposed to the rest of the app (advisor /
 * graph / quiz all see only canonical entries).
 */
export default function ArchivesPanel({ dataVersion = 0 }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState({});

  // Manual audit-trigger state. Default cadence is one tick every 15 min on
  // the background loop; this button is for impatient observation — e.g.
  // after a scoring change, to fast-forward the cycle and watch the new
  // judge play out instead of waiting half a day for natural convergence.
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditResult, setAuditResult] = useState(null);
  const [auditError, setAuditError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/sot/archives");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEntries(await res.json());
    } catch (e) {
      setError(e.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, dataVersion]);

  const runAuditStep = useCallback(async () => {
    if (auditRunning) return;
    setAuditRunning(true);
    setAuditError(null);
    try {
      const res = await writeFetch("/api/audit/run-once", { method: "POST" });
      if (!res.ok) {
        // 401 = wrong / missing password; everything else surfaces the body
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      setAuditResult(data);
      // If the tick archived something, our list just changed — pull fresh.
      // Cheap to do on any successful tick; archives doesn't grow on
      // create_version actions so the refresh is a no-op in that case.
      refresh();
    } catch (e) {
      setAuditError(e.message ?? String(e));
    } finally {
      setAuditRunning(false);
    }
  }, [auditRunning, refresh]);

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
        <IntroBlurb />
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <input
            type="text"
            placeholder="Filter archived entries…"
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
              background: "rgba(255,255,255,0.05)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            Refresh
          </button>
          <button
            onClick={runAuditStep}
            disabled={auditRunning}
            title="Run one audit step now (creates a new version, or scores+archives if a group has 3). Normally fires every 15 min on its own."
            style={{
              padding: "10px 16px",
              background: auditRunning
                ? "rgba(57,255,20,0.05)"
                : "rgba(57,255,20,0.08)",
              border: "1px solid rgba(57,255,20,0.32)",
              borderRadius: 8,
              color: "var(--accent)",
              cursor: auditRunning ? "wait" : "pointer",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              opacity: auditRunning ? 0.7 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {auditRunning ? "Running…" : "Run audit step"}
          </button>
        </div>

        {(auditResult || auditError) && (
          <AuditResultStrip
            result={auditResult}
            error={auditError}
            onDismiss={() => {
              setAuditResult(null);
              setAuditError(null);
            }}
          />
        )}

        {entries && (
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--text-mute)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            {visible.length} of {entries.length} archived entries
          </div>
        )}

        {error && <div style={{ color: "var(--danger)", fontSize: 14 }}>{error}</div>}
        {!entries && !error && (
          <div style={{ color: "var(--text-dim)" }}>Loading…</div>
        )}
        {entries && entries.length === 0 && (
          <div style={{ color: "var(--text-dim)", fontSize: 13 }}>
            The archive is empty. The audit agent retires the lowest-scoring
            SOT node whenever a lesson accumulates three active versions —
            check back after the first few audit cycles.
          </div>
        )}

        {visible.map((entry, i) => (
          <ArchiveCard
            key={entry.event_id ?? i}
            entry={entry}
            expanded={!!expanded[entry.event_id]}
            onToggle={() =>
              setExpanded((prev) => ({
                ...prev,
                [entry.event_id]: !prev[entry.event_id],
              }))
            }
          />
        ))}
      </div>
    </div>
  );
}

function IntroBlurb() {
  return (
    <div
      style={{
        marginBottom: 22,
        padding: "16px 18px",
        background: "rgba(57,255,20,0.04)",
        border: "1px solid rgba(57,255,20,0.16)",
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--accent)",
          marginBottom: 10,
        }}
      >
        The audit trail of a self-improving knowledge base
      </div>
      <p
        style={{
          margin: "0 0 10px 0",
          color: "var(--text)",
          opacity: 0.92,
          fontSize: 13.5,
          lineHeight: 1.6,
        }}
      >
        my-AI-stro doesn't just hold your lessons — it audits them. Every 15
        minutes the audit agent generates a fresh alternative summary of one
        of your SOT entries. When three versions of the same lesson
        accumulate, a deterministic richness scorer ranks them on{" "}
        <Em>concepts captured</Em>, <Em>definitions explained</Em>,{" "}
        <Em>code preserved</Em>, <Em>length</Em>, and{" "}
        <Em>grounding to the source</Em> — the weakest is archived here, and
        the two stronger summaries stay in active rotation.
      </p>
      <p
        style={{
          margin: 0,
          color: "var(--text-dim)",
          fontSize: 13,
          lineHeight: 1.6,
        }}
      >
        Your canonical Source of Truth quietly rotates toward richer
        summaries over time, without you doing anything. The archive is the
        receipt: every entry here is a version that got out-summarized by a
        later one.
      </p>
    </div>
  );
}

function Em({ children }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.92em",
        color: "var(--accent)",
        background: "rgba(57,255,20,0.06)",
        padding: "1px 5px",
        borderRadius: 3,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function ArchiveCard({ entry, expanded, onToggle }) {
  const score = entry.archive_score;
  const scoreColor =
    score == null
      ? "var(--text-dim)"
      : score >= 8
      ? "var(--accent)"
      : score >= 5
      ? "var(--accent-yellow)"
      : "var(--danger)";

  return (
    <div
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
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--text-mute)",
            }}
          >
            {entry.course} · week {entry.week} · v{entry.version ?? "?"}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
            {entry.lesson}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 2,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 18,
              fontWeight: 600,
              color: scoreColor,
              lineHeight: 1,
            }}
          >
            {score != null ? `${score}/10` : "—"}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-mute)" }}>
            {(entry.archived_at ?? "").slice(0, 10)}
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 10,
          color: "var(--text)",
          opacity: 0.85,
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
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          {entry.key_concepts?.length > 0 && (
            <Section label="key concepts">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {entry.key_concepts.map((c, i) => (
                  <span
                    key={i}
                    style={{
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      color: "var(--text-dim)",
                      padding: "2px 8px",
                      borderRadius: 4,
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            </Section>
          )}
          {entry.definitions?.length > 0 && (
            <Section label="definitions">
              {entry.definitions.map((d, i) => (
                <div
                  key={i}
                  style={{
                    color: "var(--text)",
                    opacity: 0.78,
                    fontSize: 12.5,
                    marginBottom: 4,
                  }}
                >
                  · {d}
                </div>
              ))}
            </Section>
          )}
          <div
            style={{
              marginTop: 12,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.08em",
              color: "var(--text-mute)",
            }}
          >
            archived: {entry.archived_at} · reason: {entry.archive_reason ?? "—"} ·
            event: {entry.event_id?.slice(0, 8)}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
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

/**
 * AuditResultStrip — one-line summary of what the most recent manual audit
 * tick did. The /api/audit/run-once endpoint returns one of:
 *   { action: "created_version", lesson, course, week, version, event_id }
 *   { action: "archived", lesson, course, week, archived_version,
 *     archived_score, all_scores: [{version, score}, ...] }
 *   { action: "failed", reason, lesson, errors }
 *   { action: "skipped", reason, lesson? }
 *   { action: "noop", reason }
 *
 * We render a single human-readable line per case + the full payload for
 * forensic clicks (model scoring, validation errors).
 */
function AuditResultStrip({ result, error, onDismiss }) {
  const [showRaw, setShowRaw] = useState(false);

  // Visual style depends on what happened.
  let accent = "var(--accent)";
  let label = "Audit step";
  let body = "Done.";

  if (error) {
    accent = "var(--danger)";
    label = "Audit step failed";
    body = error;
  } else if (result) {
    const action = result.action;
    if (action === "created_version") {
      label = "Created new version";
      body = `${result.course} · week ${result.week} · ${result.lesson} → v${result.version}`;
    } else if (action === "archived") {
      label = "Scored and archived";
      const scores = (result.all_scores || [])
        .map((s) => `v${s.version}:${s.score}`)
        .join(" · ");
      body = `${result.course} · ${result.lesson} — archived v${result.archived_version} (score ${result.archived_score})${scores ? `  [${scores}]` : ""}`;
    } else if (action === "failed") {
      accent = "var(--accent-yellow)";
      label = "Audit step rejected";
      body = `${result.lesson || "?"} — ${(result.errors || []).join("; ") || result.reason || "validation failed"}`;
    } else if (action === "skipped") {
      accent = "var(--text-mute)";
      label = "Skipped";
      body = `${result.lesson || ""} — ${result.reason || ""}`.trim();
    } else if (action === "stable") {
      // 3-node group whose top scores are within SCORE_GAP_EPSILON of each
      // other — the audit can't pick a "weakest" with any confidence, so
      // it left the group alone and fell through to the next candidate.
      // (This is the fix for the degenerate-loop bug — if you keep seeing
      // these, the model has converged on a steady-state extraction for
      // that lesson and there's nothing more for the audit to do.)
      accent = "var(--text-mute)";
      label = "Stable — no archive";
      const scores = (result.all_scores || [])
        .map((s) => `v${s.version}:${s.score}`)
        .join(" · ");
      body = `${result.course} · ${result.lesson} — top-two gap ${result.gap} < ${result.epsilon}${scores ? `  [${scores}]` : ""}`;
    } else if (action === "noop") {
      accent = "var(--text-mute)";
      label = "No work to do";
      body = result.reason || "Audit found nothing to act on.";
    } else {
      body = JSON.stringify(result);
    }
  }

  return (
    <div
      style={{
        marginBottom: 14,
        padding: "10px 14px",
        background: "rgba(8,10,16,0.6)",
        border: `1px solid ${accent}`,
        borderRadius: 8,
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: accent,
              marginRight: 10,
            }}
          >
            {label}
          </span>
          <span style={{ color: "var(--text)", opacity: 0.88 }}>{body}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {result && (
            <button
              onClick={() => setShowRaw((v) => !v)}
              style={{
                background: "transparent",
                border: "1px solid var(--border-strong)",
                color: "var(--text-dim)",
                padding: "2px 8px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              {showRaw ? "Hide" : "Raw"}
            </button>
          )}
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            style={{
              background: "transparent",
              border: "1px solid var(--border-strong)",
              color: "var(--text-dim)",
              padding: "2px 8px",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
            }}
          >
            ×
          </button>
        </div>
      </div>
      {showRaw && result && (
        <pre
          style={{
            marginTop: 10,
            padding: 10,
            background: "rgba(0,0,0,0.4)",
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-dim)",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
