import { useState } from "react";
import IngestPanel from "./components/IngestPanel";
import SotBrowser from "./components/SotBrowser";
import QuizPanel from "./components/QuizPanel";
import ChatPanel from "./components/ChatPanel";
import GraphPanel from "./components/GraphPanel";

export default function App() {
  const [mode, setMode] = useState("ingest");

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
      <ModeToggle mode={mode} setMode={setMode} />
      {mode === "ingest" && <IngestPanel />}
      {mode === "browse" && <SotBrowser />}
      {mode === "quiz" && <QuizPanel />}
      {mode === "chat" && <ChatPanel />}
      {mode === "graph" && <GraphPanel />}
    </div>
  );
}

function ModeToggle({ mode, setMode }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 24,
        left: 24,
        zIndex: 20,
        display: "flex",
        gap: 4,
        background: "rgba(8,10,16,0.7)",
        padding: 4,
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(6px)",
      }}
    >
      <ToggleBtn active={mode === "ingest"} onClick={() => setMode("ingest")}>
        Ingest
      </ToggleBtn>
      <ToggleBtn active={mode === "browse"} onClick={() => setMode("browse")}>
        Browse SOT
      </ToggleBtn>
      <ToggleBtn active={mode === "quiz"} onClick={() => setMode("quiz")}>
        Quiz
      </ToggleBtn>
      <ToggleBtn active={mode === "chat"} onClick={() => setMode("chat")}>
        Chat
      </ToggleBtn>
      <ToggleBtn active={mode === "graph"} onClick={() => setMode("graph")}>
        Graph
      </ToggleBtn>
    </div>
  );
}

function ToggleBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        background: active ? "#3b82f6" : "transparent",
        color: "white",
        border: "none",
        borderRadius: 4,
        cursor: "pointer",
        fontWeight: 500,
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}
