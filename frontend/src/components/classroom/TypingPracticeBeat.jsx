/**
 * TypingPracticeBeat — verbatim-code typing drill.
 *
 * Renders the beat's `code` as a monospace block with per-character
 * coloring as the user types. Hybrid char-by-char interaction (the
 * "FastestCoderAlive"-style flow):
 *
 *   - Right key  → that character flips to "correct" (accent green),
 *                  cursor advances.
 *   - Wrong key  → that character flips to "wrong" (red bg, real char
 *                  still shown), cursor STILL advances. Keeps flow.
 *   - Backspace  → step back one position, clear that slot.
 *   - Enter      → matches a literal '\n' in the target.
 *
 * Why hybrid (not strict-blocking): strict mode gets stuck on edge
 * cases that aren't really typos — smart quotes, tab-vs-spaces, or
 * the user just missing a character by one. Hybrid keeps the practice
 * fluid while still tracking every mistake in the accuracy stat.
 *
 * Stats:
 *   - WPM (live)      — (correct chars / 5) / elapsed minutes
 *   - Accuracy (live) — correct / total_typed × 100
 *
 * Completion:
 *   - When cursor reaches end of target, show stats banner + a
 *     "Practice again" button. The classroom-level "Next →" button is
 *     unaffected — it's owned by BeatRenderer and always available.
 *
 * Skip:
 *   - We expose a small "Skip practice" link; clicking it just
 *     advances. No persistence; nothing is recorded.
 *
 * Why no auto-skip of leading whitespace: makes indentation muscle
 * memory part of the practice. Users mentally training Python should
 * feel the 4 spaces.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Best-effort syntax detection from the code itself so the practice
// block matches the surrounding lesson's visual treatment. Only used
// for the (very light) language hint in the header chip; the typing
// surface stays plain monospace so coloring conflicts don't confuse
// the per-char status overlay.
function detectLanguageHint(code) {
  if (!code) return "";
  if (/\b(def|import|print|self|class)\b/.test(code)) return "python";
  if (/\b(const|let|=>|console\.log|function)\b/.test(code)) return "javascript";
  if (/\b(SELECT|FROM|WHERE|JOIN)\b/i.test(code)) return "sql";
  return "";
}

// Per-character status. "pending" = not yet typed, "correct" = matched,
// "wrong" = user typed the wrong key but we kept flowing.
const STATUS_PENDING = 0;
const STATUS_CORRECT = 1;
const STATUS_WRONG = 2;

export default function TypingPracticeBeat({ beat }) {
  const target = (beat?.code || "").replace(/\r\n/g, "\n");
  const targetLen = target.length;

  const containerRef = useRef(null);
  const [position, setPosition] = useState(0);
  // Status array, one slot per target char. Re-init when beat changes.
  const [statuses, setStatuses] = useState(() => new Uint8Array(targetLen));
  const [startedAt, setStartedAt] = useState(null);
  const [nowTick, setNowTick] = useState(0);
  const [focused, setFocused] = useState(false);
  const [errorCount, setErrorCount] = useState(0);

  const languageHint = useMemo(() => detectLanguageHint(target), [target]);
  const completed = position >= targetLen && targetLen > 0;

  // Reset internal state if the beat changes (next practice in the plan).
  useEffect(() => {
    setPosition(0);
    setStatuses(new Uint8Array(target.length));
    setStartedAt(null);
    setNowTick(0);
    setErrorCount(0);
  }, [beat?.beat_id, target]);

  // Tick once per second while typing so WPM updates without waiting
  // for the next keystroke. Stops once completed to avoid pointless
  // re-renders.
  useEffect(() => {
    if (!startedAt || completed) return undefined;
    const id = setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt, completed]);

  const reset = useCallback(() => {
    setPosition(0);
    setStatuses(new Uint8Array(target.length));
    setStartedAt(null);
    setNowTick(0);
    setErrorCount(0);
    containerRef.current?.focus();
  }, [target]);

  const handleKeyDown = useCallback(
    (e) => {
      if (completed) {
        // Allow Enter to reset for another go-round when done.
        if (e.key === "Enter") {
          e.preventDefault();
          reset();
        }
        return;
      }
      // Ignore pure modifier keys / arrow nav so the user can still
      // copy/paste or focus elsewhere with Cmd-C, Cmd-A, etc.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "Backspace") {
        e.preventDefault();
        if (position > 0) {
          const newPos = position - 1;
          const next = new Uint8Array(statuses);
          next[newPos] = STATUS_PENDING;
          setStatuses(next);
          setPosition(newPos);
        }
        return;
      }

      // Determine the keystroke's character equivalent.
      let typed;
      if (e.key === "Enter") typed = "\n";
      else if (e.key === "Tab") {
        e.preventDefault();
        typed = "\t";
      } else if (e.key.length === 1) typed = e.key;
      else return; // Shift, Escape, arrows, etc.

      e.preventDefault();
      if (startedAt === null) setStartedAt(Date.now());

      const expected = target[position];
      const next = new Uint8Array(statuses);
      if (typed === expected) {
        next[position] = STATUS_CORRECT;
      } else {
        next[position] = STATUS_WRONG;
        setErrorCount((c) => c + 1);
      }
      setStatuses(next);
      setPosition(position + 1);
    },
    [position, statuses, target, completed, startedAt, reset]
  );

  // Live stats. Computed from statuses + elapsed time — cheap given
  // typical snippet sizes (<1000 chars).
  const correctCount = useMemo(() => {
    let n = 0;
    for (let i = 0; i < position; i++) if (statuses[i] === STATUS_CORRECT) n++;
    return n;
  }, [statuses, position]);
  const accuracy = position > 0 ? Math.round((correctCount / position) * 100) : 100;
  const elapsedSec = startedAt ? Math.max((Date.now() - startedAt) / 1000, 0.001) : 0;
  // nowTick is in the dep chain so this recomputes each second
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wpm = useMemo(() => {
    if (!startedAt) return 0;
    const minutes = elapsedSec / 60;
    if (minutes <= 0) return 0;
    return Math.round((correctCount / 5) / minutes);
  }, [correctCount, startedAt, elapsedSec, nowTick]);

  // Auto-focus on mount so the user can just start typing.
  useEffect(() => {
    containerRef.current?.focus();
  }, [beat?.beat_id]);

  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          fontSize: 13,
          color: "var(--text-dim)",
          marginBottom: 10,
          lineHeight: 1.5,
        }}
      >
        {beat.content ||
          "Type out this snippet to lock in the syntax. Wrong characters won't block you — keep going."}
      </div>

      {/* Stats row */}
      <div
        style={{
          display: "flex",
          gap: 18,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-mute)",
          marginBottom: 8,
        }}
      >
        <span>
          Pos{" "}
          <strong style={{ color: "var(--text)" }}>
            {position}/{targetLen}
          </strong>
        </span>
        <span>
          Accuracy{" "}
          <strong style={{ color: accuracy >= 95 ? "var(--accent)" : "var(--text)" }}>
            {accuracy}%
          </strong>
        </span>
        <span>
          WPM{" "}
          <strong style={{ color: "var(--text)" }}>{wpm}</strong>
        </span>
        {errorCount > 0 && (
          <span style={{ color: "rgba(239,68,68,0.8)" }}>
            Errors <strong>{errorCount}</strong>
          </span>
        )}
        {languageHint && (
          <span style={{ marginLeft: "auto", color: "var(--text-mute)" }}>
            {languageHint}
          </span>
        )}
      </div>

      {/* Typing surface — focusable div capturing keystrokes. The
          `tabIndex={0}` makes it part of the focus order so screen
          readers and keyboard users can land on it; `outline` is
          customized to match the chalkboard aesthetic. */}
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          padding: "14px 16px",
          background: "rgba(0,0,0,0.55)",
          border: focused
            ? "1px solid rgba(57,255,20,0.55)"
            : "1px solid rgba(255,255,255,0.18)",
          borderRadius: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 13.5,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          outline: "none",
          cursor: "text",
          boxShadow: focused ? "0 0 18px rgba(57,255,20,0.15)" : "none",
          transition: "border-color 0.15s, box-shadow 0.2s",
          minHeight: 80,
        }}
        onClick={() => containerRef.current?.focus()}
      >
        {renderCharSpans(target, statuses, position, focused)}
      </div>

      {!focused && !completed && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--text-mute)",
            fontStyle: "italic",
          }}
        >
          Click the block above to start typing.
        </div>
      )}

      {completed && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 14px",
            background: "rgba(57,255,20,0.08)",
            border: "1px solid rgba(57,255,20,0.45)",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--accent)",
            }}
          >
            ✓ Done
          </span>
          <span style={{ fontSize: 13, color: "var(--text)" }}>
            <strong>{wpm}</strong> wpm · <strong>{accuracy}%</strong> accuracy
            {errorCount > 0 && (
              <>
                {" · "}
                <span style={{ color: "rgba(239,68,68,0.85)" }}>
                  {errorCount} error{errorCount === 1 ? "" : "s"}
                </span>
              </>
            )}
          </span>
          <button
            type="button"
            onClick={reset}
            style={{
              marginLeft: "auto",
              padding: "5px 11px",
              background: "transparent",
              border: "1px solid rgba(57,255,20,0.4)",
              borderRadius: 5,
              color: "var(--accent)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Practice again
          </button>
        </div>
      )}
    </div>
  );
}

// Render the target text as a sequence of character spans, each
// colored by its status + whether it's the current cursor position.
// Newlines are rendered literally (whiteSpace: pre-wrap on parent),
// with a small ↵ glyph on the wrong-or-pending side so the user can
// SEE that an Enter is needed.
function renderCharSpans(target, statuses, position, focused) {
  const out = [];
  for (let i = 0; i < target.length; i++) {
    const ch = target[i];
    const status = statuses[i];
    const isCurrent = i === position;
    // Visible char (turn \n into a marker, render literal newline AFTER)
    const isNewline = ch === "\n";
    const isTab = ch === "\t";
    let display;
    if (isNewline) display = "↵";
    else if (isTab) display = "→";
    else display = ch;

    let color;
    let background = "transparent";
    let borderBottom = "none";
    if (status === STATUS_CORRECT) {
      color = "var(--accent)"; // green
    } else if (status === STATUS_WRONG) {
      color = "#fff";
      background = "rgba(239,68,68,0.42)";
    } else {
      // pending
      color = "rgba(255,255,255,0.42)";
    }
    if (isCurrent && focused) {
      // Caret under the current character.
      borderBottom = "2px solid var(--accent)";
    }
    // Whitespace markers: faded ↵/→ when pending; show literal when typed.
    const opacity = (isNewline || isTab) && status === STATUS_PENDING ? 0.45 : 1;

    out.push(
      <span
        key={i}
        style={{
          color,
          background,
          borderBottom,
          opacity,
          // ensure the colored bg covers the full glyph row for newlines
          display: "inline",
        }}
      >
        {display}
      </span>
    );
    if (isNewline) {
      // After the ↵ glyph, emit a real newline so the next chars wrap.
      out.push(<span key={`nl-${i}`}>{"\n"}</span>);
    }
  }
  return out;
}
