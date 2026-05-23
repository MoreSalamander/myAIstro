import { useCallback, useEffect, useRef, useState } from "react";
import { writeFetch } from "../../lib/writeAuth";
import { BEAT_TYPES } from "./classroomTypes";
import LessonPicker from "./LessonPicker";
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
export default function ClassroomPanel({ presetEntry, onClearPreset, isOwner = true }) {
  const [phase, setPhase] = useState("PICKER"); // PICKER | PLANNING | PLAYING | ENDED
  const [plan, setPlan] = useState(null);
  const [session, setSession] = useState(null);
  const [planningStatus, setPlanningStatus] = useState("");
  const [error, setError] = useState(null);
  const [checkResultByBeat, setCheckResultByBeat] = useState(() => new Map());
  const planCacheCheckedRef = useRef(false);

  // Consume the presetEntry from the drawer ("Teach me this")
  useEffect(() => {
    if (!presetEntry) return;
    startWithEntry(presetEntry);
    onClearPreset?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetEntry]);

  // -------- Phase transitions --------
  const reset = () => {
    setPhase("PICKER");
    setPlan(null);
    setSession(null);
    setPlanningStatus("");
    setError(null);
    setCheckResultByBeat(new Map());
    planCacheCheckedRef.current = false;
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
  const submitCheck = useCallback(
    async (answer) => {
      if (!session || !plan) return;
      const beat = plan.beats[session.current_beat];
      if (!beat || beat.type !== BEAT_TYPES.CHECK) return;
      try {
        let data;
        if (!isOwner) {
          // Guest: hit the public grading endpoint with the canonical
          // answer the frontend already has. No session record persists.
          const r = await fetch("/api/classroom/guest/answer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_id: plan.lesson_event_id,
              question: beat.question || beat.content || "",
              canonical_answer: beat.canonical_answer || "",
              user_answer: answer,
            }),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          data = await r.json();
        } else {
          const res = await writeFetch("/api/classroom/session/answer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: session.session_id,
              beat_id: beat.beat_id,
              user_answer: answer,
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = await res.json();
          if (data.session) setSession(data.session);
        }

        setCheckResultByBeat((prev) => {
          const m = new Map(prev);
          m.set(beat.beat_id, {
            score: data.score,
            passed: data.passed,
            correction: data.correction,
            canonical_answer: data.canonical_answer,
          });
          return m;
        });

        if (!isOwner) {
          // Update local stats in guest mode
          setSession((s) => {
            if (!s) return s;
            const stats = { ...(s.summary_stats || {}) };
            stats.checks_total = (stats.checks_total || 0) + 1;
            if (data.passed) stats.checks_passed = (stats.checks_passed || 0) + 1;
            const n = stats.checks_total;
            const prevAvg = stats.avg_check_score || 0;
            stats.avg_check_score = Math.round(prevAvg + (data.score - prevAvg) / n);
            return { ...s, summary_stats: stats };
          });
        }
      } catch (e) {
        setError(e.message ?? String(e));
      }
    },
    [plan, session, isOwner],
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

      {phase === "PICKER" && (
        <LessonPicker onPick={startWithEntry} />
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
        <BeatRenderer
          key={currentBeat?.beat_id || session.current_beat}
          beat={currentBeat}
          onAdvance={onAdvance}
          onSubmit={onSubmit}
          result={result}
        />
      </div>
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
