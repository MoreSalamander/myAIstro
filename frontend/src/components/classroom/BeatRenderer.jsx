import { useEffect, useRef, useState } from "react";
import { BEAT_TYPES, BEAT_TYPE_LABELS, TYPEWRITER_CPS } from "./classroomTypes";
import { CodeBlock } from "../../lib/markdown";

/**
 * BeatRenderer — chalkboard playback of a single Beat.
 *
 * Typewriter-style writing for all text content. For CHECK beats the
 * multiple-choice options appear once the question has finished typing.
 * Options are shuffled on mount so the student never sees the canonical
 * plan order (correct-first).
 *
 * Props:
 *   beat:        Beat
 *   onAdvance:   () => void                   // hit Next
 *   onSubmit:    (canonicalIndex) => void     // CHECK answer submitted.
 *                                             // index is against the plan's
 *                                             // canonical options order so the
 *                                             // backend can compare it directly
 *                                             // to beat.correct_index.
 *   onRaiseHand: () => void | null            // open the Q&A overlay (Teacher v2).
 *                                             // null/undefined hides the button
 *                                             // (guest mode, no session for Q&A).
 *   result:      { selected_index, correct_index, passed, score, explanation, first_try } | null
 *                — present after a CHECK has been graded. Indices are canonical.
 */
export default function BeatRenderer({ beat, onAdvance, onSubmit, result, onRaiseHand }) {
  if (!beat) return null;
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", position: "relative" }}>
      {/* Raise-hand button — top-right of the beat area, small enough
          not to compete with the main Next button, visible enough that
          the student knows it's there. Always available (including
          during CHECK pending grading) — a student might want to ask
          about the question itself before answering. */}
      {onRaiseHand && (
        <button
          onClick={onRaiseHand}
          title="Ask the teacher a question about this lesson"
          style={{
            position: "absolute",
            top: -8,
            right: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 11px",
            background: "rgba(247,255,0,0.08)",
            border: "1px solid rgba(247,255,0,0.35)",
            borderRadius: 999,
            color: "var(--accent-yellow, #f7ff00)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            cursor: "pointer",
            zIndex: 2,
          }}
        >
          🙋 Raise hand
        </button>
      )}
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
        // Syntax-highlighted via the shared CodeBlock primitive.
        // Plan beats don't carry a language hint, so detectLanguage
        // figures it out from the code shape; the chip in the
        // top-right shows what it landed on (or hides if unknown).
        <CodeBlock code={beat.code} />
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

  // Shuffle once per mount via a stable display→canonical index map.
  // The plan stores options correct-first; we never show that order to
  // the student. `displayOrder[i]` is the canonical index shown at
  // display slot i.
  const options = beat.options || [];
  const displayOrderRef = useRef(null);
  if (displayOrderRef.current === null || displayOrderRef.current.length !== options.length) {
    displayOrderRef.current = shuffledIndices(options.length);
  }
  const displayOrder = displayOrderRef.current;

  async function handlePick(displayIdx) {
    if (result) return;
    const canonicalIdx = displayOrder[displayIdx];
    await onSubmit(canonicalIdx);
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
            marginBottom: 18,
          }}
        >
          {qTyped}
          {!qDone && <Caret />}
        </div>
      )}
      {qDone && (
        <div role="radiogroup" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {displayOrder.map((canonicalIdx, displayIdx) => {
            const optText = options[canonicalIdx] ?? "";
            const isAnswered = !!result;
            const isCorrectOpt = isAnswered && canonicalIdx === result.correct_index;
            const isPickedOpt = isAnswered && canonicalIdx === result.selected_index;

            // Color logic after answering:
            //   correct option   → green border + green tint (always)
            //   picked-wrong     → yellow border + yellow tint
            //   other distractor → dim
            // Before answering: neutral, hover-highlight
            let bg = "rgba(255,255,255,0.03)";
            let border = "1px solid var(--border-strong)";
            let textColor = "var(--text)";
            if (isAnswered) {
              if (isCorrectOpt) {
                bg = "rgba(57,255,20,0.08)";
                border = "1px solid var(--accent-soft)";
              } else if (isPickedOpt) {
                bg = "rgba(247,255,0,0.06)";
                border = "1px solid var(--accent-yellow-soft)";
              } else {
                bg = "rgba(255,255,255,0.02)";
                border = "1px solid var(--border)";
                textColor = "var(--text-dim)";
              }
            }

            return (
              <button
                key={canonicalIdx}
                role="radio"
                aria-checked={isPickedOpt}
                onClick={() => handlePick(displayIdx)}
                disabled={isAnswered}
                style={{
                  textAlign: "left",
                  padding: "12px 14px",
                  background: bg,
                  border,
                  borderRadius: 8,
                  color: textColor,
                  cursor: isAnswered ? "default" : "pointer",
                  fontSize: 14.5,
                  fontFamily: "inherit",
                  lineHeight: 1.45,
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  transition: "background 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (isAnswered) return;
                  e.currentTarget.style.background = "rgba(57,255,20,0.04)";
                  e.currentTarget.style.borderColor = "var(--accent-soft)";
                }}
                onMouseLeave={(e) => {
                  if (isAnswered) return;
                  e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                  e.currentTarget.style.borderColor = "var(--border-strong)";
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    letterSpacing: "0.08em",
                    color: isAnswered
                      ? isCorrectOpt
                        ? "var(--accent)"
                        : isPickedOpt
                        ? "var(--accent-yellow)"
                        : "var(--text-mute)"
                      : "var(--text-mute)",
                    marginTop: 1,
                    minWidth: 18,
                  }}
                >
                  {String.fromCharCode(65 + displayIdx)}
                </span>
                <span style={{ flex: 1 }}>{optText}</span>
                {isAnswered && isCorrectOpt && (
                  <span style={{ color: "var(--accent)", fontWeight: 600 }}>✓</span>
                )}
                {isAnswered && isPickedOpt && !isCorrectOpt && (
                  <span style={{ color: "var(--accent-yellow)", fontWeight: 600 }}>✗</span>
                )}
              </button>
            );
          })}
        </div>
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
        marginTop: 14,
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
        {passed ? "Got it" : "Not quite"}
      </div>
      {result.explanation && (
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.55,
            color: "var(--text)",
            whiteSpace: "pre-wrap",
          }}
        >
          {result.explanation}
        </div>
      )}
    </div>
  );
}

// Fisher-Yates shuffle of [0, n) — used to randomize MC option display
// order while preserving the canonical correct_index in the plan.
function shuffledIndices(n) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
