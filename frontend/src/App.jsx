import { useState } from "react";
import DataFlowCanvas from "./components/DataFlowCanvas";

export default function App() {
  const [task, setTask] = useState(null);
  const [activeStep, setActiveStep] = useState(null);

  // ingestion form state
  const [course, setCourse] = useState("");
  const [week, setWeek] = useState("");
  const [lesson, setLesson] = useState("");
  const [inputText, setInputText] = useState("");

  async function ingestLesson() {
    console.log("INGEST CLICK");

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

      const data = await res.json();

      console.log("INGEST DATA:", data);

      setTask(data);
      setActiveStep(0);

    } catch (e) {
      console.error("ERROR:", e);
    }
  }

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "black",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* GRAPH RENDERER (UNCHANGED) */}
      <DataFlowCanvas task={task} activeStep={activeStep} />

      {/* UI OVERLAY */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: "10px",
          zIndex: 10,
        }}
      >
        <input
          placeholder="Course"
          value={course}
          onChange={(e) => setCourse(e.target.value)}
          style={{ padding: "8px", borderRadius: "6px" }}
        />

        <input
          placeholder="Week"
          value={week}
          onChange={(e) => setWeek(e.target.value)}
          style={{ padding: "8px", borderRadius: "6px" }}
        />

        <input
          placeholder="Lesson"
          value={lesson}
          onChange={(e) => setLesson(e.target.value)}
          style={{ padding: "8px", borderRadius: "6px" }}
        />

        <textarea
          placeholder="Input text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          style={{ padding: "8px", borderRadius: "6px", width: "300px", height: "100px" }}
        />

        <button
          onClick={ingestLesson}
          style={{
            padding: "12px 20px",
            background: "#3b82f6",
            color: "white",
            borderRadius: "10px",
            cursor: "pointer",
          }}
        >
          Ingest Lesson
        </button>
      </div>
    </div>
  );
}
