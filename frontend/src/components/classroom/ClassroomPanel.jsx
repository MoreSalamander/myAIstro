import { useCallback, useEffect, useRef, useState } from "react";
import { writeFetch } from "../../lib/writeAuth";
import { BEAT_TYPES } from "./classroomTypes";
import LessonPicker from "./LessonPicker";
import NotebookSectionPicker from "./NotebookSectionPicker";
import LessonPlanSidebar from "./LessonPlanSidebar";
import BeatRenderer from "./BeatRenderer";

/**
 * ClassroomPanel — top-level Classroom view orchestrator.
 *
 * State machine:
 *   PICKER     — user chooses a lesson
 *   PLANNING   — Teacher Aide is generating the plan (streamed)
 *   PLAYING    — Chalkboard active, beats advance
 *   ENDED      — recap card
 *
 * Props:
 *   presetEntry — optional SOT entry to skip the picker. Set when the
 *                 user opens Classroom from a Lesson Drawer's
 *                 "Teach me this" button.
 *   onClearPreset — callback so the parent can null the preset after
 *                   we've consumed it (so future toggle visits to
 *                   Classroom go back to the picker).
 */
export default function ClassroomPanel({
  presetEntry,
  onClearPreset,
  presetSection,
  onClearPresetSection,
  isOwner = true,
}) {
  const [phase, setPhase] = useState("PICKER"); // PICKER | PLANNING | PLAYING | ENDED
  const [plan, setPlan] = useState(null);
  const [session, setSession] = useState(null);
  const [planningStatus, setPlanningStatus] = useState("");
  const [error, setError] = useState(null);
  const [checkResultByBeat, setCheckResultByBeat] = useState(() => new Map());
  const planCacheCheckedRef = useRef(false);

  // Which picker view is visible when phase === "PICKER".
  //   "notebook" (default) = NotebookSectionPicker — primary, listens
  //                          to what the user has saved
  //   "sot"                = LessonPicker — secondary, "browse all lessons"
  // Tunnel visitors (isOwner=false) skip the notebook view entirely
  // since they can't save to it; their default is the SOT picker.
  const [pickerMode, setPickerMode] = useState(isOwner ? "notebook" : "sot");

  // Raise-hand Q&A overlay state (Teacher v2). When `qa.active`, the
  // PlayingView swaps the BeatRenderer for the RaiseHandOverlay until
  // the student dismisses it. The Q&A doesn't modify the plan or
  // advance the beat — it pauses the flow, lets the student ask a
  // question grounded in the source, then returns control on
  // "← Continue lesson".
  const [qa, setQa] = useState({
    active: false,
    question: "",         // edited input before submit
    submitted: "",        // frozen at submit time
    answer: "",           // streaming answer body
    busy: false,
    done: false,
    error: null,
    groundingReport: null,
  });

  // Consume the presetEntry from the drawer ("Teach me this")
  useEffect(() => {
    if (!presetEntry) return;
    startWithEntry(presetEntry);
    onClearPreset?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetEntry]);

  // Consume the presetSection from the Notebook ("Teach me this section").
  // Different from presetEntry: we DON'T cache-check (each section
  // generation is fresh from its own snapshot) and we route to the new
  // /api/classroom/plan-from-section endpoint instead of /plan.
  useEffect(() => {
    if (!presetSection) return;
    generatePlanFromSection(presetSection);
    onClearPresetSection?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSection]);

  // -------- Phase transitions --------
  const reset = () => {
    setPhase("PICKER");
    setPlan(null);
    setSession(null);
    setPlanningStatus("");
    setError(null);
    setCheckResultByBeat(new Map());
    planCacheCheckedRef.current = false;
    // Return owners to the notebook picker on session end — that's
    // the primary entry surface. Guests stay on SOT (they can't
    // populate a notebook).
    setPickerMode(isOwner ? "notebook" : "sot");
  };

  async function startWithEntry(entry) {
    setError(null);
    setPhase("PLANNING");
    setPlanningStatus("Looking for an existing plan…");

    // Try cache first per the chosen default — reuse the most recent
    // plan if any; user can hit "Regenerate" later. Guest visitors
    // benefit from the owner's cache (read-only, no pollution).
    try {
      const r = await fetch(`/api/classroom/plans?event_id=${encodeURIComponent(entry.event_id)}`);
      if (r.ok) {
        const plans = await r.json();
        if (Array.isArray(plans) && plans.length > 0) {
          await beginSessionFromPlan(plans[0]);
          return;
        }
      }
    } catch {
      /* fall through to generate */
    }
    await generatePlan(entry);
  }

  async function generatePlan(entry) {
    setError(null);
    setPhase("PLANNING");
    setPlanningStatus("Teacher Aide is drafting the lesson plan…");

    try {
      // Owner uses the persistent endpoint (writeFetch attaches the
      // password header). Guests use the public /guest/plan endpoint
      // which generates ephemerally and never writes to disk.
      const url = isOwner ? "/api/classroom/plan" : "/api/classroom/guest/plan";
      const sendFetch = isOwner ? writeFetch : fetch;

      const res = await sendFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id: entry.event_id }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let planId = null;
      let inlinePlan = null; // guest endpoint returns the plan inline on "done"
      let beatCount = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "progress") {
            setPlanningStatus("Drafting beats…");
          } else if (evt.type === "model_start") {
            setPlanningStatus(
              evt.attempt === 2
                ? "Retrying — first draft didn't pass…"
                : "Teacher Aide is thinking…",
            );
          } else if (evt.type === "beat") {
            beatCount += 1;
            setPlanningStatus(`Received beat ${beatCount}…`);
          } else if (evt.type === "done") {
            planId = evt.plan_id ?? null;
            inlinePlan = evt.plan ?? null;
          } else if (evt.type === "error") {
            throw new Error(evt.message || "Plan generation failed");
          }
        }
      }

      let fresh = inlinePlan;
      if (!fresh && planId) {
        const planRes = await fetch(`/api/classroom/plan/${planId}`);
        if (!planRes.ok) throw new Error(`HTTP ${planRes.status} fetching plan`);
        fresh = await planRes.json();
      }
      if (!fresh) {
        throw new Error("Plan generation completed without a plan");
      }
      await beginSessionFromPlan(fresh);
    } catch (e) {
      setError(e.message ?? String(e));
      setPhase("PICKER");
    }
  }

  // Generate a plan from a saved Notebook section. Calls the new
  // /api/classroom/plan-from-section endpoint, which builds the plan
  // from the section content (not the raw SOT entry) and runs the
  // new Python grounding pass on the result. Same streaming event
  // shape as generatePlan, so the planning UI is identical.
  async function generatePlanFromSection(payload) {
    setError(null);
    setPhase("PLANNING");
    setPlanningStatus(
      `Generating plan from saved section: ${payload.course} · w${payload.week} · ${payload.lesson}…`,
    );

    try {
      const res = await writeFetch("/api/classroom/plan-from-section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notebook_id: payload.notebook_id,
          section_index: payload.section_index,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let planId = null;
      let beatCount = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "progress") {
            setPlanningStatus("Drafting beats…");
          } else if (evt.type === "model_start") {
            setPlanningStatus(
              evt.attempt === 2
                ? "Retrying — first draft didn't pass…"
                : "Teacher Aide is thinking about your saved section…",
            );
          } else if (evt.type === "beat") {
            beatCount += 1;
            setPlanningStatus(`Received beat ${beatCount}…`);
          } else if (evt.type === "done") {
            planId = evt.plan_id ?? null;
            // grounding_report + warnings are also on the done event —
            // available here for future surfacing if we want to show
            // a banner before the session starts.
          } else if (evt.type === "error") {
            throw new Error(evt.message || "Plan generation failed");
          }
        }
      }
      if (!planId) {
        throw new Error("Plan generation completed without a plan id");
      }
      const planRes = await fetch(`/api/classroom/plan/${planId}`);
      if (!planRes.ok) throw new Error(`HTTP ${planRes.status} fetching plan`);
      const fresh = await planRes.json();
      await beginSessionFromPlan(fresh);
    } catch (e) {
      setError(e.message ?? String(e));
      setPhase("PICKER");
    }
  }

  // Resume a previously-generated plan instantly — no model call,
  // no streaming, just fetch the saved plan and drop into PLAYING.
  // Triggered by the Notebook picker's "▶ Resume" button on sections
  // that already have a cached plan from a prior "🎓 Teach" click.
  async function resumeCachedPlan(planId) {
    setError(null);
    setPhase("PLANNING");
    setPlanningStatus("Loading saved plan…");
    try {
      const res = await fetch(`/api/classroom/plan/${planId}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching plan ${planId}`);
      }
      const p = await res.json();
      await beginSessionFromPlan(p);
    } catch (e) {
      setError(e.message ?? String(e));
      setPhase("PICKER");
    }
  }

  // -------- Raise-hand Q&A (Teacher v2) --------
  // Pauses the beat flow, prompts the student for a question, streams
  // the Teacher's grounded answer, then waits for the student to
  // dismiss the overlay. The current beat index is NOT advanced —
  // when the overlay closes, the student is back at the same beat.
  const openRaiseHand = useCallback(() => {
    setQa({
      active: true,
      question: "",
      submitted: "",
      answer: "",
      busy: false,
      done: false,
      error: null,
      groundingReport: null,
    });
  }, []);

  const closeRaiseHand = useCallback(() => {
    setQa((q) => ({ ...q, active: false }));
  }, []);

  const submitRaiseHand = useCallback(async () => {
    const q = qa.question.trim();
    if (!q || qa.busy || !session) return;
    setQa((prev) => ({
      ...prev,
      submitted: q,
      answer: "",
      busy: true,
      done: false,
      error: null,
      groundingReport: null,
    }));

    try {
      const res = await writeFetch("/api/classroom/session/raise-hand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: session.session_id,
          question: q,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
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
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "token") {
            setQa((prev) => ({ ...prev, answer: prev.answer + (evt.value ?? "") }));
          } else if (evt.type === "done") {
            setQa((prev) => ({
              ...prev,
              done: true,
              groundingReport: evt.grounding_report ?? null,
            }));
          } else if (evt.type === "error") {
            throw new Error(evt.message || "Teacher couldn't answer");
          }
        }
      }
    } catch (e) {
      setQa((prev) => ({ ...prev, error: e.message ?? String(e) }));
    } finally {
      setQa((prev) => ({ ...prev, busy: false }));
    }
  }, [qa.question, qa.busy, session]);

  async function beginSessionFromPlan(p) {
    setPlanningStatus("Starting session…");
    if (!isOwner) {
      // Guest mode: build an ephemeral session object client-side.
      // No server round-trip; no record on disk; closing the tab loses
      // it. Required so visitor activity doesn't pollute owner data.
      const localSession = {
        session_id: `guest-${Math.random().toString(36).slice(2)}`,
        plan_id: p.plan_id,
        lesson_event_id: p.lesson_event_id,
        started_at: new Date().toISOString(),
        ended_at: null,
        completed: false,
        current_beat: 0,
        events: [],
        summary_stats: { checks_total: 0, checks_passed: 0, avg_check_score: 0 },
      };
      setPlan(p);
      setSession(localSession);
      setCheckResultByBeat(new Map());
      setPhase("PLAYING");
      return;
    }
    try {
      const res = await writeFetch("/api/classroom/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: p.plan_id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPlan(p);
      setSession(data.session);
      setCheckResultByBeat(new Map());
      setPhase("PLAYING");
    } catch (e) {
      setError(e.message ?? String(e));
      setPhase("PICKER");
    }
  }

  // -------- Beat actions --------
  // CHECK is now multiple choice + deterministic grading. The student
  // picks an option; we compare its canonical index to the beat's
  // correct_index. Guests grade entirely client-side (no server round
  // trip). Owners POST the canonical index so the session log captures
  // selected_index / correct_index / first_try for the Phase 2
  // gradebook.
  const submitCheck = useCallback(
    async (canonicalIndex) => {
      if (!session || !plan) return;
      const beat = plan.beats[session.current_beat];
      if (!beat || beat.type !== BEAT_TYPES.CHECK) return;

      const correctIndex = beat.correct_index;
      const passed = canonicalIndex === correctIndex;
      const score = passed ? 100 : 0;
      const explanation = beat.explanation || "";

      // Guard against double-submit on the same beat (would mark a
      // first_try as a retry on the owner path).
      const prior = checkResultByBeat.get(beat.beat_id);
      if (prior) return;

      try {
        if (!isOwner) {
          // Guest: pure client-side deterministic grade. No fetch.
          setCheckResultByBeat((prev) => {
            const m = new Map(prev);
            m.set(beat.beat_id, {
              selected_index: canonicalIndex,
              correct_index: correctIndex,
              passed,
              score,
              explanation,
              first_try: true,
            });
            return m;
          });
          setSession((s) => {
            if (!s) return s;
            const stats = { ...(s.summary_stats || {}) };
            stats.checks_total = (stats.checks_total || 0) + 1;
            if (passed) stats.checks_passed = (stats.checks_passed || 0) + 1;
            const n = stats.checks_total;
            const prevAvg = stats.avg_check_score || 0;
            stats.avg_check_score = Math.round(prevAvg + (score - prevAvg) / n);
            return { ...s, summary_stats: stats };
          });
          return;
        }

        const res = await writeFetch("/api/classroom/session/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: session.session_id,
            beat_id: beat.beat_id,
            selected_index: canonicalIndex,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.session) setSession(data.session);

        setCheckResultByBeat((prev) => {
          const m = new Map(prev);
          m.set(beat.beat_id, {
            selected_index: data.selected_index,
            correct_index: data.correct_index,
            passed: data.passed,
            score: data.score,
            explanation: data.explanation,
            first_try: data.first_try,
          });
          return m;
        });
      } catch (e) {
        setError(e.message ?? String(e));
      }
    },
    [plan, session, isOwner, checkResultByBeat],
  );

  const advance = useCallback(async () => {
    if (!session || !plan) return;
    const beats = plan.beats || [];
    const nextIdx = Math.min(session.current_beat + 1, beats.length);

    if (!isOwner) {
      // Guest: no server round-trip; advance entirely in component state.
      setSession((s) => (s ? { ...s, current_beat: nextIdx } : s));
      if (nextIdx >= beats.length) setPhase("ENDED");
      return;
    }

    try {
      const res = await writeFetch("/api/classroom/session/advance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session.session_id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSession(data.session);
      if (data.at_end) {
        try {
          await writeFetch("/api/classroom/session/end", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: session.session_id }),
          });
        } catch {
          /* non-fatal */
        }
        setPhase("ENDED");
      }
    } catch (e) {
      setError(e.message ?? String(e));
    }
  }, [plan, session, isOwner]);

  // -------- Render --------
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflowY: "auto",
        zIndex: 5,
      }}
    >
      {error && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            background: "rgba(239,68,68,0.1)",
            border: "1px solid var(--danger)",
            color: "var(--danger)",
            padding: "8px 12px",
            borderRadius: 6,
            fontSize: 12,
            maxWidth: 360,
            zIndex: 50,
          }}
        >
          {error}
        </div>
      )}

      {!isOwner && <GuestBanner />}

      {phase === "PICKER" && pickerMode === "notebook" && (
        <NotebookSectionPicker
          onTeachSection={(payload) => generatePlanFromSection(payload)}
          onResumePlan={({ plan_id }) => resumeCachedPlan(plan_id)}
          onBrowseAll={() => setPickerMode("sot")}
        />
      )}

      {phase === "PICKER" && pickerMode === "sot" && (
        <LessonPickerWithBackLink
          onPick={startWithEntry}
          onBack={() => setPickerMode("notebook")}
          showBack={isOwner}
        />
      )}

      {phase === "PLANNING" && (
        <PlanningView status={planningStatus} />
      )}

      {phase === "PLAYING" && plan && session && (
        <PlayingView
          plan={plan}
          session={session}
          checkResultByBeat={checkResultByBeat}
          isOwner={isOwner}
          onSubmit={submitCheck}
          onAdvance={advance}
          qa={qa}
          onRaiseHand={isOwner ? openRaiseHand : null}
          onQaQuestionChange={(v) => setQa((prev) => ({ ...prev, question: v }))}
          onQaSubmit={submitRaiseHand}
          onQaClose={closeRaiseHand}
          onExit={async () => {
            if (isOwner) {
              try {
                await writeFetch("/api/classroom/session/end", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ session_id: session.session_id }),
                });
              } catch {
                /* non-fatal */
              }
            }
            setPhase("ENDED");
          }}
        />
      )}

      {phase === "ENDED" && plan && session && (
        <EndedView
          plan={plan}
          session={session}
          checkResultByBeat={checkResultByBeat}
          onAnother={reset}
        />
      )}
    </div>
  );
}

// LessonPicker wrapped with a "← Back to notebook" link at the top.
// The Classroom's secondary picker view — reached when the user clicks
// "Browse all lessons →" from the primary NotebookSectionPicker.
// Owners see the back link (they can return to their notebook view);
// tunnel-visitor guests don't (their default IS the SOT picker, so
// "back to notebook" would dead-end into an empty notebook they can't
// write to).
function LessonPickerWithBackLink({ onPick, onBack, showBack }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", zIndex: 5 }}>
      {showBack && (
        <div style={{ padding: "16px 32px 0", textAlign: "left", zIndex: 6 }}>
          <button
            onClick={onBack}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-dim)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.06em",
              cursor: "pointer",
              padding: "4px 0",
            }}
          >
            ← Back to notebook
          </button>
        </div>
      )}
      <div style={{ flex: 1, position: "relative" }}>
        <LessonPicker onPick={onPick} />
      </div>
    </div>
  );
}

function GuestBanner() {
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        background: "rgba(247,255,0,0.08)",
        borderBottom: "1px solid var(--accent-yellow-soft)",
        padding: "8px 16px",
        textAlign: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--accent-yellow)",
      }}
    >
      Guest classroom — your session is ephemeral and won't be saved
    </div>
  );
}

function PlanningView({ status }) {
  return (
    <div
      style={{
        maxWidth: 600,
        margin: "0 auto",
        padding: "60px 24px",
        textAlign: "center",
      }}
    >
      <div
        className="glow-pulse"
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: "var(--accent)",
          margin: "0 auto 24px",
        }}
      />
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--text-mute)",
          marginBottom: 8,
        }}
      >
        Preparing class
      </div>
      <div style={{ fontSize: 16, color: "var(--text)", lineHeight: 1.5 }}>
        {status || "Preparing the lesson…"}
      </div>
      <div
        style={{
          marginTop: 12,
          fontSize: 12,
          color: "var(--text-dim)",
        }}
      >
        First plan can take ~30s. Subsequent visits to this lesson reuse the cached plan.
      </div>
    </div>
  );
}

function PlayingView({
  plan,
  session,
  checkResultByBeat,
  // eslint-disable-next-line no-unused-vars
  isOwner,
  onSubmit,
  onAdvance,
  onExit,
  qa,
  onRaiseHand,
  onQaQuestionChange,
  onQaSubmit,
  onQaClose,
}) {
  const currentBeat = plan.beats[session.current_beat];
  const result = currentBeat ? checkResultByBeat.get(currentBeat.beat_id) : null;
  return (
    <div style={{ display: "flex", height: "100%" }}>
      <LessonPlanSidebar
        plan={plan}
        currentBeat={session.current_beat}
        checkResults={checkResultByBeat}
      />
      <div
        style={{
          flex: 1,
          padding: "28px 24px 60px",
          overflowY: "auto",
          position: "relative",
        }}
      >
        <button
          onClick={onExit}
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-dim)",
            padding: "4px 10px",
            borderRadius: 5,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            cursor: "pointer",
          }}
        >
          End session
        </button>
        {qa?.active ? (
          <RaiseHandOverlay
            qa={qa}
            onQuestionChange={onQaQuestionChange}
            onSubmit={onQaSubmit}
            onClose={onQaClose}
          />
        ) : (
          <BeatRenderer
            key={currentBeat?.beat_id || session.current_beat}
            beat={currentBeat}
            onAdvance={onAdvance}
            onSubmit={onSubmit}
            result={result}
            onRaiseHand={onRaiseHand}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================
//  RaiseHandOverlay — student-question Q&A panel
// ============================================================
//  Two states:
//    1. Pre-submit: title + textarea + Submit / Cancel
//    2. Streaming: question echo + streaming answer + Continue when done
//  Grounding ratio surfaces as a small color-coded chip if the
//  backend's combined_report returned anything (will be present on
//  every answer once the stream finishes).
function RaiseHandOverlay({ qa, onQuestionChange, onSubmit, onClose }) {
  const phase = qa.submitted ? "answer" : "ask";
  const ratio = qa.groundingReport?.overall_ratio;
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "16px 0" }}>
      <div style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: "var(--accent-yellow, #f7ff00)",
        marginBottom: 14,
      }}>
        🙋 Raise hand · ask the teacher
      </div>

      {phase === "ask" && (
        <>
          <div style={{
            fontSize: 13.5,
            color: "var(--text-dim)",
            marginBottom: 10,
            lineHeight: 1.5,
          }}>
            Type a question about anything in this lesson. The teacher will
            answer using only this lesson's source material — if it's not
            here, they'll tell you which lesson would cover it.
          </div>
          <textarea
            value={qa.question}
            onChange={(e) => onQuestionChange(e.target.value)}
            placeholder="e.g. wait, what does this actually do in practice?"
            autoFocus
            rows={3}
            style={{
              width: "100%",
              padding: "11px 14px",
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
            disabled={qa.busy}
          />
          <div style={{
            marginTop: 12,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}>
            <div style={{
              fontSize: 11,
              color: "var(--text-mute)",
              fontFamily: "var(--font-mono)",
            }}>
              {qa.busy ? "Asking the teacher…" : "Plain text, no markdown needed."}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onClose}
                disabled={qa.busy}
                style={{
                  padding: "8px 16px",
                  background: "transparent",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 6,
                  color: "var(--text-dim)",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.08em",
                  cursor: qa.busy ? "wait" : "pointer",
                }}
              >
                ← Continue lesson
              </button>
              <button
                onClick={onSubmit}
                disabled={qa.busy || !qa.question.trim()}
                style={{
                  padding: "8px 18px",
                  background: "rgba(247,255,0,0.12)",
                  border: "1px solid rgba(247,255,0,0.45)",
                  borderRadius: 6,
                  color: "var(--accent-yellow, #f7ff00)",
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.08em",
                  cursor: qa.busy ? "wait" : "pointer",
                  opacity: !qa.question.trim() ? 0.5 : 1,
                }}
              >
                Ask the teacher
              </button>
            </div>
          </div>
        </>
      )}

      {phase === "answer" && (
        <>
          {/* Question echo */}
          <div style={{
            padding: "12px 16px",
            background: "rgba(247,255,0,0.05)",
            border: "1px solid rgba(247,255,0,0.18)",
            borderRadius: 8,
            marginBottom: 16,
            fontSize: 14,
            color: "var(--text)",
            lineHeight: 1.5,
            fontStyle: "italic",
          }}>
            “{qa.submitted}”
          </div>

          {/* Streaming answer */}
          <div style={{
            padding: "16px 18px",
            background: "rgba(8,10,16,0.7)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10,
            color: "rgba(255,255,255,0.92)",
            fontSize: 14.5,
            lineHeight: 1.65,
            whiteSpace: "pre-wrap",
            minHeight: 60,
          }}>
            {qa.answer || (
              <span style={{ color: "var(--text-mute)" }}>
                Teacher is thinking…
              </span>
            )}
            {qa.busy && !qa.done && (
              <span style={{ color: "rgba(255,255,255,0.45)" }}>▍</span>
            )}
          </div>

          {qa.error && (
            <div style={{
              marginTop: 12,
              padding: "10px 14px",
              background: "rgba(239,68,68,0.08)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 6,
              color: "#ef4444",
              fontSize: 12.5,
            }}>
              {qa.error}
            </div>
          )}

          <div style={{
            marginTop: 14,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}>
            {ratio != null ? (
              <div
                title="Python-verified grounding ratio against this lesson's source. Higher = more of the answer is anchored in the material you've actually seen."
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  background: "rgba(8,10,16,0.6)",
                  border: `1px solid ${
                    ratio >= 0.7
                      ? "rgba(57,255,20,0.4)"
                      : ratio >= 0.5
                      ? "rgba(247,255,0,0.4)"
                      : "rgba(239,68,68,0.45)"
                  }`,
                  borderRadius: 999,
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  letterSpacing: "0.06em",
                  color: "var(--text-dim)",
                }}
              >
                grounding {Math.round(ratio * 100)}%
              </div>
            ) : (
              <div />
            )}
            <button
              onClick={onClose}
              style={{
                padding: "9px 22px",
                background: "var(--accent-bg, rgba(57,255,20,0.12))",
                border: "1px solid var(--accent-soft, rgba(57,255,20,0.4))",
                borderRadius: 6,
                color: "var(--accent, #39ff14)",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.1em",
                cursor: "pointer",
              }}
            >
              ← Continue lesson
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function EndedView({ plan, session, checkResultByBeat, onAnother }) {
  const stats = session.summary_stats || {};
  return (
    <div
      style={{
        maxWidth: 600,
        margin: "0 auto",
        padding: "60px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--accent)",
          marginBottom: 12,
        }}
      >
        Class complete
      </div>
      <h2
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: "var(--text)",
          margin: "0 0 24px 0",
          lineHeight: 1.3,
        }}
      >
        {plan.source_lesson?.lesson}
      </h2>
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 24,
          marginBottom: 28,
        }}
      >
        <Stat label="Questions" value={stats.checks_total ?? 0} />
        <Stat label="Got it" value={stats.checks_passed ?? 0} />
        <Stat
          label="Avg score"
          value={stats.checks_total ? `${Math.round(stats.avg_check_score)}/100` : "—"}
        />
      </div>
      <button
        onClick={onAnother}
        style={{
          padding: "10px 24px",
          background: "var(--accent-bg)",
          border: "1px solid var(--accent-soft)",
          color: "var(--accent)",
          borderRadius: 8,
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        Teach me another
      </button>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "var(--text-mute)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 22,
          color: "var(--text)",
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}
