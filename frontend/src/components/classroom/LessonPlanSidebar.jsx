import { BEAT_TYPE_LABELS } from "./classroomTypes";

/**
 * Vertical timeline of the plan's beats. Highlights the current
 * position; CHECK beats show a pass/fail pill after they've been
 * graded.
 *
 * Props:
 *   plan: Plan
 *   currentBeat: number (index)
 *   checkResults: Map<beat_id, { passed }>
 */
export default function LessonPlanSidebar({ plan, currentBeat, checkResults }) {
  if (!plan) return null;
  return (
    <div
      style={{
        width: 280,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        padding: "18px 16px",
        overflowY: "auto",
        background: "rgba(0,0,0,0.2)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--text-mute)",
          marginBottom: 6,
        }}
      >
        Lesson plan
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--text)",
          marginBottom: 4,
          lineHeight: 1.3,
        }}
      >
        {plan.source_lesson?.lesson}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-mute)",
          marginBottom: 14,
        }}
      >
        {plan.source_lesson?.course} · week {plan.source_lesson?.week} ·{" "}
        {plan.beats?.length || 0} beats · ~{plan.estimated_duration_min ?? "?"} min
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {(plan.beats || []).map((beat, i) => {
          const isCurrent = i === currentBeat;
          const isPast = i < currentBeat;
          const checkResult = checkResults?.get(beat.beat_id);
          return (
            <div
              key={beat.beat_id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                background: isCurrent ? "var(--accent-bg)" : "transparent",
                border: isCurrent
                  ? "1px solid var(--accent-soft)"
                  : "1px solid transparent",
                borderRadius: 5,
                opacity: isPast ? 0.55 : 1,
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: isCurrent
                    ? "var(--accent)"
                    : isPast
                    ? "var(--text-mute)"
                    : "var(--border-strong)",
                }}
              />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: isCurrent ? "var(--accent)" : "var(--text-mute)",
                  minWidth: 70,
                }}
              >
                {BEAT_TYPE_LABELS[beat.type] || beat.type}
              </span>
              {checkResult && (
                <span
                  style={{
                    fontSize: 10,
                    color: checkResult.passed
                      ? "var(--accent)"
                      : "var(--accent-yellow)",
                  }}
                >
                  {checkResult.passed ? "✓" : "△"}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
