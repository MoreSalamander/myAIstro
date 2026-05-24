/**
 * ChatPanel — the chat surface for both my-AI-stro Chat and General Chat.
 *
 * One component, two modes:
 *   - "advisor" (default): SOT-grounded chat. POSTs to /api/advisor/chat.
 *     The backend selects relevant SOT entries via sot_selector, builds
 *     a grounded prompt, and streams llama3.2 tokens. The first NDJSON
 *     event is a `context` payload listing which entries were matched —
 *     surfaced to the user so they can see what the advisor is reading
 *     from.
 *   - "general":           Untethered chat. POSTs to /api/chat/general.
 *     No SOT context. Routes to llama3.2 (NOT the summarization model;
 *     see core/model_router.py for the trust-isolation rule).
 *
 * Streaming: both endpoints return NDJSON. Each `{type: "token", value}`
 * event appends to the response state, and the panel auto-scrolls so the
 * latest token is always visible.
 *
 * @param {object} props
 * @param {object} [props.seedLesson]  Optional lesson to pre-seed the query
 *                                     ("Tell me more about <lesson>") when
 *                                     opened from a LessonDrawer.
 * @param {string} [props.mode]        "advisor" | "general" (default: "advisor")
 */

import { useEffect, useRef, useState } from "react";
import { MarkdownBody } from "../lib/markdown";
import { writeFetch } from "../lib/writeAuth";

export default function ChatPanel({ seedLesson, mode = "advisor" } = {}) {
  const isGeneral = mode === "general";
  const endpoint = isGeneral
    ? "/api/chat/general"
    : "/api/advisor/chat";
  const placeholder = isGeneral
    ? "Ask anything — this chat is unconnected to your SOT."
    : "Ask your SOT… e.g. write me a study guide for BE101 week 2";
  const [query, setQuery] = useState(
    !isGeneral && seedLesson?.lesson
      ? `Tell me more about "${seedLesson.lesson}". `
      : "",
  );
  const [response, setResponse] = useState("");
  const [contextEntries, setContextEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  // Pipeline staging — populated by the advisor pipeline's step_* events.
  // null when idle; an object {step, index?, total?, lesson?, course?, week?}
  // while a stage is in flight. General Chat skips these (no pipeline).
  const [stage, setStage] = useState(null);

  const responseRef = useRef(null);

  // Per-piece breakdown of the streamed response, populated as
  // step_start / token events arrive. Used by the "Save to Notebook"
  // flow so the saved note retains the structural pieces (arc,
  // section ×N, recap) instead of being a flat markdown blob.
  //
  // Kept in a ref rather than state because we don't render off this —
  // it's only read at save time. Tokens stream by the thousand; touching
  // state on every token here would trigger thousands of re-renders.
  const piecesRef = useRef([]);

  // Save-to-Notebook UX state.
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'ok' | error string
  const [savedQuery, setSavedQuery] = useState("");   // the query at send-time (so editing the textarea after send doesn't change what we save)

  useEffect(() => {
    if (responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }
  }, [response]);

  async function send() {
    const q = query.trim();
    if (!q || busy) return;

    setBusy(true);
    setDone(false);
    setError(null);
    setResponse("");
    setContextEntries([]);
    setStage(null);
    piecesRef.current = [];
    setSavedQuery(q);
    setSaveStatus(null);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            handleChunk(chunk);
          } catch {
            console.warn("bad chunk", line);
          }
        }
      }
      if (buf.trim()) {
        try {
          handleChunk(JSON.parse(buf));
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleChunk(chunk) {
    // ----- Tokens: append to the assembled response body -----
    // Same shape used by both the advisor pipeline (with section_id)
    // and the legacy general-chat stream (no section_id). Either way
    // we just concat in arrival order. AND we mirror the token into
    // the current piece in piecesRef so the save-to-notebook flow has
    // a structured breakdown to persist.
    if (chunk.type === "token") {
      setResponse((prev) => prev + (chunk.value ?? ""));
      _appendTokenToCurrentPiece(piecesRef, chunk);
      return;
    }

    // ----- Pipeline staging events (advisor only) -----
    // The pipeline emits step_start / step_complete around each stage.
    // We mirror them into the `stage` state so the staging strip can
    // show "retrieving…" / "section 3 of 9: Conditional rendering" /
    // "assembling…". Tokens continue to land in `response`; the staging
    // strip is purely an observability layer over the same stream.
    if (chunk.type === "step_start") {
      // For arc / section / recap stages, push a new piece into the
      // ref so subsequent token events can accumulate into it.
      if (chunk.step === "arc") {
        piecesRef.current.push({ kind: "arc", content: "" });
      } else if (chunk.step === "recap") {
        piecesRef.current.push({ kind: "recap", content: "" });
      } else if (chunk.step === "section") {
        piecesRef.current.push({
          kind: "section",
          event_id: chunk.event_id,
          lesson: chunk.lesson,
          course: chunk.course,
          week: chunk.week,
          content: "",
        });
        setStage({
          step: "section",
          index: chunk.index,
          total: chunk.total,
          lesson: chunk.lesson,
          course: chunk.course,
          week: chunk.week,
        });
        return;
      }
      setStage({ step: chunk.step });
      return;
    }
    if (chunk.type === "step_complete") {
      // Surface the retrieval result as the context chips. Mirrors the
      // legacy `{type: "context"}` shape so the chip UI is unchanged.
      if (chunk.step === "retrieval") {
        setContextEntries(chunk.entries ?? []);
      }
      // Don't clear stage on step_complete — leave it set until the
      // next step_start arrives, so there's no flicker between stages.
      return;
    }

    // ----- Legacy event shapes (pre-pipeline advisor + general chat) -----
    if (chunk.type === "context") {
      setContextEntries(chunk.entries ?? []);
      return;
    }
    if (chunk.type === "error") {
      setError(chunk.message ?? "advisor error");
      return;
    }
    if (chunk.type === "done") {
      setDone(true);
      setStage(null);
      return;
    }
  }

  // Append a streamed token to the appropriate piece in piecesRef.
  // Tokens from the advisor pipeline carry a `section_id`:
  //   "arc"          → append to the most recent "arc" piece
  //   "recap"        → append to the most recent "recap" piece
  //   <event_id>     → append to the section piece with that event_id
  // Tokens without a section_id (legacy paths, general chat) are
  // ignored for piece-tracking purposes — they still land in the
  // flat response state via setResponse.
  function _appendTokenToCurrentPiece(ref, chunk) {
    const sid = chunk.section_id;
    if (!sid) return;
    const pieces = ref.current;
    // Search from the END — for arc/recap, the most recent piece of
    // that kind is the target. For sections, the event_id makes it
    // unambiguous regardless of position.
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      const match =
        (sid === "arc" && p.kind === "arc") ||
        (sid === "recap" && p.kind === "recap") ||
        (p.kind === "section" && p.event_id === sid);
      if (match) {
        p.content += chunk.value ?? "";
        return;
      }
    }
  }

  // ----- Save-to-Notebook flow -----
  function openSaveModal() {
    setSaveTitle(_deriveTitle(savedQuery));
    setSaveStatus(null);
    setSaveModalOpen(true);
  }

  async function confirmSave() {
    const title = saveTitle.trim();
    if (!title || saveBusy) return;
    setSaveBusy(true);
    setSaveStatus(null);
    try {
      const res = await writeFetch("/api/notebook/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          query: savedQuery,
          body_markdown: response,
          pieces: piecesRef.current,
          source_event_ids: contextEntries.map((e) => e.event_id),
          model: "llama3.1:8b",
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
      }
      setSaveStatus("ok");
      // Close the modal after a brief beat so the user sees the success
      setTimeout(() => setSaveModalOpen(false), 700);
    } catch (e) {
      setSaveStatus(e.message ?? String(e));
    } finally {
      setSaveBusy(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        paddingTop: 80,
        paddingBottom: 24,
        paddingLeft: 24,
        paddingRight: 24,
        display: "flex",
        flexDirection: "column",
        zIndex: 5,
      }}
    >
      <div
        style={{
          maxWidth: 820,
          width: "100%",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
        }}
      >
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={3}
          style={{
            padding: "10px 14px",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 8,
            color: "white",
            outline: "none",
            fontSize: 14,
            fontFamily: "inherit",
            resize: "vertical",
            boxSizing: "border-box",
          }}
          disabled={busy}
        />

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 10,
            gap: 12,
          }}
        >
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>
            ⌘/Ctrl + Enter to send
          </div>
          <button
            onClick={send}
            disabled={busy || !query.trim()}
            style={{
              padding: "8px 18px",
              background: busy ? "#1e3a8a" : "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: busy ? "wait" : "pointer",
              opacity: busy || !query.trim() ? 0.6 : 1,
            }}
          >
            {busy ? "Thinking…" : "Send"}
          </button>
        </div>

        {error && (
          <div
            style={{
              marginTop: 12,
              color: "#ef4444",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {!isGeneral && contextEntries.length > 0 && (
          <ContextChips entries={contextEntries} />
        )}

        {!isGeneral && stage && (
          <StageStrip stage={stage} done={done} />
        )}

        {(response || busy) && (
          <div
            ref={responseRef}
            className="chat-md"
            style={{
              marginTop: 14,
              padding: 16,
              background: "rgba(8,10,16,0.7)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 10,
              flex: 1,
              overflowY: "auto",
              color: "rgba(255,255,255,0.92)",
              fontSize: 14,
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: 100,
              position: "relative",
            }}
          >
            {/* Save-to-Notebook button — advisor mode only, only when
                the pipeline has finished streaming, only when there's
                a substantive response. Floats top-right of the response
                body so it never interferes with reading. */}
            {!isGeneral && done && response.length > 50 && (
              <button
                onClick={openSaveModal}
                title="Save this output to your Notebook"
                style={{
                  position: "sticky",
                  top: 0,
                  float: "right",
                  marginLeft: 12,
                  padding: "5px 10px",
                  background: "rgba(57,255,20,0.10)",
                  border: "1px solid rgba(57,255,20,0.4)",
                  borderRadius: 999,
                  color: "var(--accent, #39ff14)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  zIndex: 1,
                }}
              >
                ★ Save to Notebook
              </button>
            )}
            <MarkdownBody>{response}</MarkdownBody>
            {busy && !done && (
              <span style={{ color: "rgba(255,255,255,0.45)" }}>▍</span>
            )}
          </div>
        )}
      </div>

      {saveModalOpen && (
        <SaveNotebookModal
          title={saveTitle}
          onTitleChange={setSaveTitle}
          onCancel={() => setSaveModalOpen(false)}
          onConfirm={confirmSave}
          busy={saveBusy}
          status={saveStatus}
          query={savedQuery}
          sectionCount={piecesRef.current.filter((p) => p.kind === "section").length}
        />
      )}
    </div>
  );
}

// ============================================================
//  SaveNotebookModal — title-edit + confirm flow for saving a
//  completed advisor response to the Notebook.
// ============================================================
function SaveNotebookModal({ title, onTitleChange, onCancel, onConfirm, busy, status, query, sectionCount }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(2,4,8,0.7)",
        backdropFilter: "blur(6px)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 92vw)",
          background: "var(--panel-strong, #0a0d14)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 12,
          padding: "22px 24px",
          boxShadow: "0 20px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(57,255,20,0.06)",
        }}
      >
        <div style={{
          fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
          fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase",
          color: "var(--accent, #39ff14)", marginBottom: 10,
        }}>
          Save to Notebook
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 4 }}>
          Query
        </div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", marginBottom: 16, fontStyle: "italic" }}>
          “{query}”
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>
          Title
        </div>
        <input
          type="text"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          autoFocus
          style={{
            width: "100%",
            padding: "9px 12px",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 6,
            color: "white",
            outline: "none",
            fontSize: 14,
            fontFamily: "inherit",
            boxSizing: "border-box",
          }}
        />
        <div style={{
          marginTop: 12, fontSize: 11, color: "rgba(255,255,255,0.45)",
          fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
        }}>
          {sectionCount} section{sectionCount === 1 ? "" : "s"} · llama3.1:8b
        </div>
        {status === "ok" && (
          <div style={{
            marginTop: 12, fontSize: 12, color: "var(--accent, #39ff14)",
          }}>
            Saved to Notebook ✓
          </div>
        )}
        {status && status !== "ok" && (
          <div style={{
            marginTop: 12, fontSize: 12, color: "#ef4444",
          }}>
            {status}
          </div>
        )}
        <div style={{
          marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 10,
        }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 6,
              color: "rgba(255,255,255,0.7)",
              cursor: busy ? "wait" : "pointer",
              fontSize: 12,
              fontFamily: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || !title.trim() || status === "ok"}
            style={{
              padding: "8px 18px",
              background: status === "ok" ? "rgba(57,255,20,0.2)" : "rgba(57,255,20,0.15)",
              border: "1px solid var(--accent, #39ff14)",
              borderRadius: 6,
              color: "var(--accent, #39ff14)",
              cursor: busy ? "wait" : "pointer",
              fontSize: 12,
              fontWeight: 600,
              fontFamily: "inherit",
              opacity: !title.trim() ? 0.5 : 1,
            }}
          >
            {busy ? "Saving…" : status === "ok" ? "Saved" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Derive a clean default title from a user query.
 *
 * Strips common verbose prefixes ("write me a", "give me", "can you") so
 * "write me a study guide for FE102 week 2" becomes
 * "Study guide for FE102 week 2". Title-cases the leading character.
 * User can still edit before saving.
 */
function _deriveTitle(query) {
  if (!query) return "Untitled note";
  const cleaned = query
    .trim()
    .replace(
      /^(write me a|give me a|please write|can you write|i want|i need|please give me|show me a?)\s+/i,
      "",
    )
    .trim();
  if (!cleaned) return "Untitled note";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * StageStrip — small one-line status bar showing which stage of the
 * advisor pipeline is currently running. Driven by the pipeline's
 * step_start events. Sits between the context chips and the response
 * body so the user always knows what the backend is doing.
 *
 * Shapes by stage:
 *   retrieval  →  "● retrieving relevant lessons…"
 *   section    →  "● section 3 of 9 · Conditional rendering"
 *   assembly   →  "● assembling…"
 *   done       →  collapses to "✓ done · 9 sections"
 */
function StageStrip({ stage, done }) {
  if (!stage) return null;

  const accent = done ? "rgba(57,255,20,0.95)" : "rgba(59,130,246,0.95)";
  const dot = done ? "✓" : "●";
  let label;
  if (stage.step === "retrieval") {
    label = "retrieving relevant lessons…";
  } else if (stage.step === "arc") {
    label = "writing opening arc…";
  } else if (stage.step === "section") {
    const ctx = stage.lesson
      ? `${stage.course ?? "?"} w${stage.week ?? "?"} · ${stage.lesson}`
      : "(unknown lesson)";
    label = `section ${stage.index} of ${stage.total} · ${ctx}`;
  } else if (stage.step === "recap") {
    label = "writing closing recap…";
  } else if (stage.step === "assembly") {
    label = done ? `done · ${stage.total ?? ""} section${stage.total === 1 ? "" : "s"}`.trim() : "assembling…";
  } else {
    label = stage.step;
  }

  return (
    <div
      style={{
        marginTop: 10,
        padding: "6px 12px",
        background: "rgba(8,10,16,0.6)",
        border: `1px solid ${accent.replace("0.95", "0.32")}`,
        borderRadius: 6,
        fontSize: 11.5,
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
        color: "rgba(255,255,255,0.78)",
        letterSpacing: "0.04em",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span style={{ color: accent, lineHeight: 1 }}>{dot}</span>
      <span>{label}</span>
    </div>
  );
}

function ContextChips({ entries }) {
  return (
    <div
      style={{
        marginTop: 12,
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        alignItems: "center",
      }}
    >
      <span
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "rgba(255,255,255,0.5)",
          marginRight: 4,
        }}
      >
        Using {entries.length} entr{entries.length === 1 ? "y" : "ies"}
      </span>
      {entries.map((e) => (
        <span
          key={e.event_id}
          title={`${e.course} · week ${e.week} — ${e.lesson}`}
          style={{
            display: "inline-block",
            padding: "3px 8px",
            background: "rgba(59,130,246,0.15)",
            border: "1px solid rgba(59,130,246,0.35)",
            borderRadius: 999,
            fontSize: 11,
            color: "rgba(255,255,255,0.85)",
            maxWidth: 280,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {e.course} w{e.week} · {e.lesson}
        </span>
      ))}
    </div>
  );
}


