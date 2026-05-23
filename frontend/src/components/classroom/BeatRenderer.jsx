import { useEffect, useRef, useState } from "react";
import { BEAT_TYPES, BEAT_TYPE_LABELS, TYPEWRITER_CPS } from "./classroomTypes";

/**
 * BeatRenderer — chalkboard playback of a single Beat.
 *
 * Typewriter-style writing for all text content. For CHECK beats the
 * student answer form mounts once the question has finished typing.
 *
 * Props:
 *   beat:    Beat
 *   onAdvance: () => void           // hit Next
 *   onSubmit:  (answer) => void     // CHECK answer submitted
 *   result:    { score, passed, correction, canonical_answer } | null
 *              — present after a CHECK has been graded
 */
export default function BeatRenderer({ beat, onAdvance, onSubmit, result }) {
  if (!beat) return null;
  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <BeatHeader type={beat.type} />
      {beat.type === BEAT_TYPES.INTRO && (
        <BeatBody text={beat.content} accent />
      )}
      {beat.type === BEAT_TYPES.EXPOSITION && (
        <BeatBody text={beat.content} />
      )}
      {beat.type === BEAT_TYPES.EXAMPLE && (
        <ExampleBeat beat={beat} />
      )}
      {beat.type === BEAT_TYPES.CHECK && (
        <CheckBeat beat={beat} onSubmit={onSubmit} result={result} />
      )}
      {beat.type === BEAT_TYPES.RECAP && (
        <BeatBody text={beat.content} muted />
      )}
      {beat.type === BEAT_TYPES.TRANSITION && (
        <BeatBody text={beat.content} muted />
      )}

      {/* Advance affordance — centered under the chalkboard. Hidden
          while a CHECK is pending grading so the student can't skip. */}
      {beat.type !== BEAT_TYPES.CHECK || result ? (
        <div style={{ marginTop: 32, display: "flex", justifyContent: "center" }}>
          <button
            type="button"
            onClick={() => onAdvance?.()}
            style={{
              padding: "12px 36px",
              background: "var(--accent-bg)",
              border: "1px solid var(--accent-soft)",
              color: "var(--accent)",
              borderRadius: 8,
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              boxShadow: "0 0 24px var(--accent-glow)",
              transition: "background 0.15s, box-shadow 0.2s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--accent)";
              e.currentTarget.style.color = "#001a05";
              e.currentTarget.style.boxShadow =
                "0 0 36px var(--accent-glow), 0 0 0 4px rgba(57,255,20,0.18)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--accent-bg)";
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.boxShadow = "0 0 24px var(--accent-glow)";
            }}
          >
            Next →
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BeatHeader({ type }) {
  return (
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
      {BEAT_TYPE_LABELS[type] || type}
    </div>
  );
}

function BeatBody({ text, accent, muted }) {
  const typed = useTypewriter(text);
  return (
    <div
      style={{
        fontSize: accent ? 19 : 16,
        lineHeight: 1.55,
        color: muted ? "var(--text-dim)" : "var(--text)",
        fontWeight: accent ? 500 : 400,
        whiteSpace: "pre-wrap",
      }}
    >
      {typed}
      {typed.length < text.length && <Caret />}
    </div>
  );
}

function ExampleBeat({ beat }) {
  const headTyped = useTypewriter(beat.content || "");
  const headDone = headTyped.length >= (beat.content || "").length;
  const explTyped = useTypewriter(headDone ? beat.explanation || "" : "");
  return (
    <div>
      <div
        style={{
          fontSize: 16,
          lineHeight: 1.55,
          color: "var(--text)",
          marginBottom: 12,
        }}
      >
        {headTyped}
        {!headDone && <Caret />}
      </div>
      {headDone && beat.code && (
        <pre
          style={{
            background: "rgba(0,0,0,0.4)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 14,
            fontSize: 13,
            color: "rgba(255,255,255,0.88)",
            overflowX: "auto",
            margin: "0 0 12px 0",
            whiteSpace: "pre-wrap",
          }}
        >
          {beat.code}
        </pre>
      )}
      {headDone && (
        <div
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--text)",
            whiteSpace: "pre-wrap",
          }}
        >
          {explTyped}
          {explTyped.length < (beat.explanation || "").length && <Caret />}
        </div>
      )}
    </div>
  );
}

function CheckBeat({ beat, onSubmit, result }) {
  const introTyped = useTypewriter(beat.content || "");
  const introDone = introTyped.length >= (beat.content || "").length;
  const qTyped = useTypewriter(introDone ? beat.question || "" : "");
  const qDone = qTyped.length >= (beat.question || "").length;
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!answer.trim() || submitting || result) return;
    setSubmitting(true);
    await onSubmit(answer.trim());
    setSubmitting(false);
  }

  return (
    <div>
      {beat.content && (
        <div
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--text-dim)",
            marginBottom: 14,
          }}
        >
          {introTyped}
          {!introDone && <Caret />}
        </div>
      )}
      {introDone && (
        <div
          style={{
            fontSize: 18,
            lineHeight: 1.5,
            color: "var(--text)",
            fontWeight: 500,
            marginBottom: 14,
          }}
        >
          {qTyped}
          {!qDone && <Caret />}
        </div>
      )}
      {qDone && !result && (
        <form onSubmit={handleSubmit}>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Type your answer…"
            disabled={submitting}
            rows={3}
            style={{
              width: "100%",
              padding: "10px 12px",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              color: "var(--text)",
              outline: "none",
              fontSize: 14,
              fontFamily: "inherit",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
            <button
              type="submit"
              disabled={!answer.trim() || submitting}
              style={{
                padding: "8px 16px",
                background: submitting
                  ? "rgba(57,255,20,0.2)"
                  : "var(--accent-bg)",
                border: "1px solid var(--accent-soft)",
                color: "var(--accent)",
                borderRadius: 6,
                cursor: submitting ? "wait" : "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                opacity: !answer.trim() ? 0.4 : 1,
              }}
            >
              {submitting ? "Grading…" : "Submit"}
            </button>
          </div>
        </form>
      )}
      {result && <CheckResult result={result} />}
    </div>
  );
}

function CheckResult({ result }) {
  const passed = result.passed;
  return (
    <div
      style={{
        marginTop: 6,
        padding: 14,
        background: passed
          ? "rgba(57,255,20,0.06)"
          : "rgba(247,255,0,0.05)",
        border: `1px solid ${passed ? "var(--accent-soft)" : "var(--accent-yellow-soft)"}`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          color: passed ? "var(--accent)" : "var(--accent-yellow)",
          marginBottom: 8,
        }}
      >
        {passed ? `Got it · ${result.score}/100` : `Almost · ${result.score}/100`}
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.55,
          color: "var(--text)",
          marginBottom: 10,
        }}
      >
        {result.correction}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          color: "var(--text-mute)",
          marginBottom: 4,
        }}
      >
        Canonical answer
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--text-dim)",
          whiteSpace: "pre-wrap",
        }}
      >
        {result.canonical_answer}
      </div>
    </div>
  );
}

function Caret() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 16,
        background: "var(--accent)",
        marginLeft: 2,
        verticalAlign: "text-bottom",
        animation: "caret-blink 1s steps(2, start) infinite",
      }}
    />
  );
}

/**
 * useTypewriter — animates `target` into a reveal string.
 * Returns the currently revealed substring.
 */
function useTypewriter(target) {
  const [revealed, setRevealed] = useState("");
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
    setRevealed("");
    if (!target) return undefined;
    let i = 0;
    const startedAt = performance.now();
    let raf;
    function tick(now) {
      const elapsed = (now - startedAt) / 1000;
      const target = targetRef.current;
      const target_chars = Math.min(target.length, Math.floor(elapsed * TYPEWRITER_CPS));
      if (target_chars !== i) {
        i = target_chars;
        setRevealed(target.slice(0, i));
      }
      if (i < target.length) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return revealed;
}
