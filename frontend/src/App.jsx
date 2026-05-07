import { useState, useEffect } from "react";
import DataFlowCanvas from "./components/DataFlowCanvas";

const STEP_INTERVAL_MS = 800;

export default function App() {
  const [task, setTask] = useState(null);
  const [activeStep, setActiveStep] = useState(null);

  const [course, setCourse] = useState("");
  const [week, setWeek] = useState("");
  const [lesson, setLesson] = useState("");
  const [inputText, setInputText] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!task?.timeline?.length) return;

    setActiveStep(0);
    const id = setInterval(() => {
      setActiveStep((s) => {
        const next = (s ?? -1) + 1;
        if (next >= task.timeline.length) {
          clearInterval(id);
          return s;
        }
        return next;
      });
    }, STEP_INTERVAL_MS);

    return () => clearInterval(id);
  }, [task]);

  async function ingestLesson() {
    setBusy(true);
    setError(null);
    setTask(null);
    setActiveStep(null);

    try {
      const res = await fetch("http://127.0.0.1:8000/api/ingest", {
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

      const data = await res.json();
      setTask(data);
    } catch (e) {
      console.error(e);
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const currentStep = task?.timeline?.[activeStep ?? -1] ?? null;

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "black",
        position: "relative",
        overflow: "hidden",
        color: "white",
        fontFamily: "system-ui",
      }}
    >
      <DataFlowCanvas task={task} activeStep={activeStep} />

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

      <StepDetail step={currentStep} />
    </div>
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
      {step.status && (
        <div style={{ marginBottom: "6px" }}>
          status: <strong>{step.status}</strong>
          {typeof step.score === "number" && <> · score {step.score}</>}
        </div>
      )}
      {step.data?.summary && (
        <div style={{ color: "rgba(255,255,255,0.85)" }}>
          {step.data.summary}
        </div>
      )}
      {Array.isArray(step.data?.key_concepts) && step.data.key_concepts.length > 0 && (
        <div style={{ marginTop: "6px", color: "rgba(255,255,255,0.6)" }}>
          {step.data.key_concepts.join(" · ")}
        </div>
      )}
      {step.errors?.length > 0 && (
        <div style={{ marginTop: "6px", color: "#ef4444" }}>
          {step.errors.join(" · ")}
        </div>
      )}
      {step.warnings?.length > 0 && (
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
