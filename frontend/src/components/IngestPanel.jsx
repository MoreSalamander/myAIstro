/**
 * IngestPanel — the paste-a-lesson modal flow.
 *
 * UX: course / week / lesson identifying fields plus a raw-text area.
 * Submitting POSTs to /api/ingest (write-password gated) which streams
 * back NDJSON events from the five-stage pipeline. Each event updates
 * the DataFlowCanvas so the user watches each pipeline node light up
 * as the backend actually finishes that stage — not a client-side timer
 * faking progress.
 *
 * State machine:
 *   - `task`         : the in-flight ingest's event + completed timeline
 *   - `runningStep`  : which stage is currently active (for canvas pulse)
 *   - `busy/error`   : standard UI loading/error states
 *
 * On a successful memory_write the parent's `onIngested` callback runs;
 * App.jsx uses this to bump `dataVersion` so live views (Graph, List,
 * Archives) re-fetch.
 *
 * @param {object}   props
 * @param {Function} props.onIngested  Called after a successful ingest
 */

import { useState } from "react";
import DataFlowCanvas from "./DataFlowCanvas";
import { writeFetch } from "../lib/writeAuth";

export default function IngestPanel({ onIngested }) {
  // task = { event, timeline: [completed step events] }; built up as the
  // backend streams progress. Initialized with an empty timeline on the
  // first request so the canvas can render the always-visible pipeline.
  const [task, setTask] = useState(null);
  const [runningStep, setRunningStep] = useState(null);

  const [course, setCourse] = useState("");
  const [week, setWeek] = useState("");
  const [lesson, setLesson] = useState("");
  const [inputText, setInputText] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function handleChunk(chunk) {
    if (chunk.type === "start") {
      setTask({ event: chunk.event, timeline: [] });
    } else if (chunk.type === "step_start") {
      setRunningStep(chunk.step);
    } else if (chunk.type === "step_complete") {
      setTask((prev) => ({
        ...prev,
        timeline: [...(prev?.timeline ?? []), chunk],
      }));
      setRunningStep(null);
      if (
        chunk.step === "memory_write" &&
        (chunk.status === "written" || chunk.status === "replaced")
      ) {
        setLesson("");
        setInputText("");
        onIngested?.();
      }
    } else if (chunk.type === "error") {
      setError(chunk.message);
    }
    // chunk.type === "done" — nothing extra; busy is cleared in finally
  }

  async function ingestLesson() {
    setBusy(true);
    setError(null);
    setTask({ event: null, timeline: [] });
    setRunningStep(null);

    try {
      const res = await writeFetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          course,
          week,
          lesson,
          raw_text: inputText,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handleChunk(JSON.parse(line));
          } catch (parseErr) {
            console.warn("bad chunk:", line, parseErr);
          }
        }
      }
      if (buf.trim()) {
        try {
          handleChunk(JSON.parse(buf));
        } catch {
          /* ignore trailing partial */
        }
      }
    } catch (e) {
      console.error(e);
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
      setRunningStep(null);
    }
  }

  // What to surface in the side panel: the running step (with no data
  // yet) or the most recently completed step.
  const detailStep = runningStep
    ? { step: runningStep, running: true }
    : task?.timeline?.[task.timeline.length - 1] ?? null;

  return (
    <>
      <DataFlowCanvas task={task} runningStep={runningStep} />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          alignItems: "center",
          paddingBottom: "48px",
          gap: "10px",
          zIndex: 10,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            pointerEvents: "auto",
            background: "rgba(8,10,16,0.7)",
            padding: "16px",
            borderRadius: "12px",
            border: "1px solid rgba(255,255,255,0.08)",
            backdropFilter: "blur(6px)",
          }}
        >
          <input
            placeholder="Course"
            value={course}
            onChange={(e) => setCourse(e.target.value)}
            style={inputStyle}
          />
          <input
            placeholder="Week"
            value={week}
            onChange={(e) => setWeek(e.target.value)}
            style={inputStyle}
          />
          <input
            placeholder="Lesson"
            value={lesson}
            onChange={(e) => setLesson(e.target.value)}
            style={inputStyle}
          />
          <textarea
            placeholder="Paste lesson text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            style={{ ...inputStyle, width: "320px", height: "100px" }}
          />
          <button
            onClick={ingestLesson}
            disabled={busy || !course || !lesson || !inputText}
            style={{
              padding: "12px 20px",
              background: busy ? "#1e3a8a" : "#3b82f6",
              color: "white",
              borderRadius: "10px",
              cursor: busy ? "wait" : "pointer",
              border: "none",
              fontWeight: 600,
              opacity: busy || !course || !lesson || !inputText ? 0.6 : 1,
            }}
          >
            {busy ? "Ingesting…" : "Ingest Lesson"}
          </button>
          {error && (
            <div style={{ color: "#ef4444", fontSize: "13px", maxWidth: "320px" }}>
              {error}
            </div>
          )}
        </div>
      </div>

      <StepDetail step={detailStep} />
    </>
  );
}

function StepDetail({ step }) {
  if (!step) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: "24px",
        right: "24px",
        maxWidth: "380px",
        background: "rgba(8,10,16,0.7)",
        padding: "14px 16px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(6px)",
        zIndex: 10,
        fontSize: "13px",
        lineHeight: 1.45,
      }}
    >
      <div
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontSize: "11px",
          color: "rgba(255,255,255,0.5)",
          marginBottom: "6px",
        }}
      >
        {step.step}
      </div>
      {step.running && (
        <div style={{ color: "rgba(255,255,255,0.65)", fontStyle: "italic" }}>
          running…
        </div>
      )}
      {!step.running && step.status && (
        <div style={{ marginBottom: "6px" }}>
          status: <strong>{step.status}</strong>
          {typeof step.score === "number" && <> · score {step.score}</>}
        </div>
      )}
      {!step.running && step.data?.summary && (
        <div style={{ color: "rgba(255,255,255,0.85)" }}>
          {step.data.summary}
        </div>
      )}
      {!step.running &&
        Array.isArray(step.data?.key_concepts) &&
        step.data.key_concepts.length > 0 && (
          <div style={{ marginTop: "6px", color: "rgba(255,255,255,0.6)" }}>
            {step.data.key_concepts.join(" · ")}
          </div>
        )}
      {!step.running && step.errors?.length > 0 && (
        <div style={{ marginTop: "6px", color: "#ef4444" }}>
          {step.errors.join(" · ")}
        </div>
      )}
      {!step.running && step.warnings?.length > 0 && (
        <div style={{ marginTop: "6px", color: "#f59e0b" }}>
          {step.warnings.join(" · ")}
        </div>
      )}
    </div>
  );
}

const inputStyle = {
  padding: "8px 10px",
  borderRadius: "6px",
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(255,255,255,0.05)",
  color: "white",
  outline: "none",
};
