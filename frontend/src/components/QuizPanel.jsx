/**
 * QuizPanel — recall-test surface over the SOT.
 *
 * Flow:
 *   1. Pick a lesson (or land here with one preset via `presetEventId`)
 *   2. POST /api/quiz/generate → llama3.2 produces one open-ended
 *      recall question from that lesson's content
 *   3. User types their answer
 *   4. POST /api/quiz/grade → mistral grades the answer 0-100 against
 *      the same SOT entry, with correct/missed-points breakdown and
 *      one-or-two-sentence feedback
 *
 * The grader is mistral specifically because of the LLM-as-judge
 * separation principle: the model that generated the question is
 * never the model that grades the answer. See core/model_router.py.
 *
 * Phase state machine: "loading_q" → "answering" → "grading" → "graded".
 *
 * @param {object} props
 * @param {string} [props.presetEventId]  If set, jumps straight to that
 *                                        lesson and auto-generates the
 *                                        first question on mount.
 */

import { useState, useEffect, useCallback, useRef } from "react";

export default function QuizPanel({ presetEventId } = {}) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(null);
  const presetFiredRef = useRef(false);
  // active shape: { entry, question, userAnswer, grade, phase }
  // phase: "loading_q" | "answering" | "grading" | "graded"

  const loadEntries = useCallback(async () => {
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
    loadEntries();
  }, [loadEntries]);

  const startQuiz = useCallback(async (entry) => {
    setActive({ entry, question: null, userAnswer: "", grade: null, phase: "loading_q" });
    try {
      const res = await fetch("/api/quiz/question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: entry.event_id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.question) throw new Error("Quiz agent returned no question.");
      setActive((prev) => ({
        ...prev,
        question: data.question,
        questionModel: data.model,
        phase: "answering",
      }));
    } catch (e) {
      setActive({
        entry,
        question: null,
        userAnswer: "",
        grade: null,
        phase: "error",
        errorMessage: e.message ?? String(e),
      });
    }
  }, []);

  // Auto-start when a presetEventId is provided (e.g., launched from
  // the lesson drawer). Only fires once per mount.
  useEffect(() => {
    if (!presetEventId || !entries || presetFiredRef.current) return;
    const target = entries.find((e) => e.event_id === presetEventId);
    if (target) {
      presetFiredRef.current = true;
      startQuiz(target);
    }
  }, [presetEventId, entries, startQuiz]);

  async function submitAnswer() {
    if (!active || !active.userAnswer.trim()) return;
    setActive((prev) => ({ ...prev, phase: "grading" }));
    try {
      const res = await fetch("/api/quiz/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_id: active.entry.event_id,
          question: active.question,
          user_answer: active.userAnswer,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setActive((prev) => ({ ...prev, grade: data, phase: "graded" }));
    } catch (e) {
      setActive((prev) => ({
        ...prev,
        phase: "error",
        errorMessage: e.message ?? String(e),
      }));
    }
  }

  function pickRandom() {
    if (!entries || entries.length === 0) return;
    const e = entries[Math.floor(Math.random() * entries.length)];
    startQuiz(e);
  }

  function tryAnotherQuestion() {
    if (active?.entry) startQuiz(active.entry);
  }

  function pickDifferentLesson() {
    setActive(null);
  }

  // ---------- render: picker ----------
  if (!active) {
    return (
      <Container>
        <h2 style={hdrStyle}>Pick a lesson to quiz on</h2>

        {error && <div style={{ color: "#ef4444" }}>{error}</div>}
        {!entries && !error && <Muted>Loading…</Muted>}
        {entries && entries.length === 0 && (
          <Muted>SOT is empty. Switch to Ingest to add a lesson.</Muted>
        )}

        {entries && entries.length > 0 && (
          <>
            <button style={primaryBtnStyle} onClick={pickRandom}>
              Pick a random lesson
            </button>
            <div style={{ marginTop: 16 }}>
              {entries.map((e) => (
                <PickerRow key={e.event_id} entry={e} onClick={() => startQuiz(e)} />
              ))}
            </div>
          </>
        )}
      </Container>
    );
  }

  // ---------- render: quiz in progress ----------
  return (
    <Container>
      <LessonHeader entry={active.entry} onChange={pickDifferentLesson} />

      {active.phase === "loading_q" && (
        <Muted>Generating question with {modelLabel("llama3.2")}…</Muted>
      )}

      {active.phase === "error" && (
        <div style={{ color: "#ef4444", marginTop: 16 }}>
          {active.errorMessage}
        </div>
      )}

      {active.question && (
        <>
          <div style={questionStyle}>{active.question}</div>

          <textarea
            value={active.userAnswer}
            onChange={(e) =>
              setActive((prev) => ({ ...prev, userAnswer: e.target.value }))
            }
            disabled={active.phase !== "answering"}
            placeholder="Your answer…"
            style={{
              width: "100%",
              minHeight: 120,
              padding: 12,
              fontSize: 14,
              lineHeight: 1.5,
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 8,
              color: "white",
              outline: "none",
              fontFamily: "inherit",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />

          {active.phase === "answering" && (
            <button
              style={{
                ...primaryBtnStyle,
                marginTop: 12,
                opacity: active.userAnswer.trim() ? 1 : 0.5,
                cursor: active.userAnswer.trim() ? "pointer" : "not-allowed",
              }}
              onClick={submitAnswer}
              disabled={!active.userAnswer.trim()}
            >
              Submit answer
            </button>
          )}

          {active.phase === "grading" && (
            <Muted style={{ marginTop: 12 }}>
              Grading with {modelLabel("mistral")}…
            </Muted>
          )}

          {active.grade && active.phase === "graded" && (
            <GradeCard
              grade={active.grade}
              onRetry={tryAnotherQuestion}
              onSwitch={pickDifferentLesson}
            />
          )}
        </>
      )}
    </Container>
  );
}

function PickerRow({ entry, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: "rgba(8,10,16,0.7)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 10,
        padding: 14,
        marginBottom: 8,
        cursor: "pointer",
      }}
    >
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
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>
        {entry.lesson}
      </div>
    </div>
  );
}

function LessonHeader({ entry, onChange }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 16,
        marginBottom: 16,
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
          Quizzing on · {entry.course} · week {entry.week}
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>
          {entry.lesson}
        </div>
      </div>
      <button onClick={onChange} style={ghostBtnStyle}>
        Change lesson
      </button>
    </div>
  );
}

function GradeCard({ grade, onRetry, onSwitch }) {
  const color =
    grade.score >= 80 ? "#22c55e" : grade.score >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <div
      style={{
        marginTop: 16,
        background: "rgba(8,10,16,0.7)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 10,
        padding: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <div style={{ fontSize: 36, fontWeight: 700, color }}>
          {grade.score}
        </div>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>
          / 100 · graded by {grade.model ?? "mistral"}
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
        {grade.feedback}
      </div>

      {grade.correct_points?.length > 0 && (
        <BulletSection label="What you got right" color="#22c55e">
          {grade.correct_points}
        </BulletSection>
      )}
      {grade.missed_points?.length > 0 && (
        <BulletSection label="What you missed" color="#f59e0b">
          {grade.missed_points}
        </BulletSection>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={onRetry} style={primaryBtnStyle}>
          Another question on this lesson
        </button>
        <button onClick={onSwitch} style={ghostBtnStyle}>
          Pick different lesson
        </button>
      </div>
    </div>
  );
}

function BulletSection({ label, color, children }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, color: "rgba(255,255,255,0.78)", fontSize: 13 }}>
        {children.map((c, i) => (
          <li key={i} style={{ marginBottom: 2 }}>
            {c}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Container({ children }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        paddingTop: 80,
        paddingBottom: 24,
        paddingLeft: 24,
        paddingRight: 24,
        overflowY: "auto",
        zIndex: 5,
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

function Muted({ children, style }) {
  return (
    <div style={{ color: "rgba(255,255,255,0.5)", ...style }}>{children}</div>
  );
}

function modelLabel(name) {
  return (
    <span
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: "0.9em",
        color: "rgba(255,255,255,0.7)",
      }}
    >
      {name}
    </span>
  );
}

const hdrStyle = {
  fontSize: 22,
  fontWeight: 600,
  marginTop: 0,
  marginBottom: 16,
};

const primaryBtnStyle = {
  padding: "10px 16px",
  background: "#3b82f6",
  color: "white",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
};

const ghostBtnStyle = {
  padding: "10px 16px",
  background: "transparent",
  color: "white",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
};

const questionStyle = {
  background: "rgba(59,130,246,0.08)",
  border: "1px solid rgba(59,130,246,0.25)",
  borderRadius: 10,
  padding: 16,
  fontSize: 16,
  lineHeight: 1.5,
  marginBottom: 12,
};
