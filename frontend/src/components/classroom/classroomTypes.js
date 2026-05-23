/**
 * Classroom shared constants + JSDoc types.
 *
 * Plan = {
 *   plan_id: string,
 *   lesson_event_id: string,
 *   source_lesson: { course, week, lesson },
 *   created_at: iso,
 *   model: string,
 *   estimated_duration_min: number,
 *   beats: Beat[]
 * }
 *
 * Beat = {
 *   beat_id: string,
 *   type: BEAT_TYPE,
 *   content: string,
 *   // CHECK-only:
 *   question?: string,
 *   canonical_answer?: string,
 *   expected_concepts?: string[],
 *   // EXAMPLE-only:
 *   code?: string | null,
 *   explanation?: string,
 * }
 *
 * Session = {
 *   session_id, plan_id, lesson_event_id,
 *   started_at, ended_at, completed,
 *   current_beat: number,
 *   events: [...],
 *   summary_stats: { checks_total, checks_passed, avg_check_score }
 * }
 */

export const BEAT_TYPES = {
  INTRO: "INTRO",
  EXPOSITION: "EXPOSITION",
  EXAMPLE: "EXAMPLE",
  CHECK: "CHECK",
  RECAP: "RECAP",
  TRANSITION: "TRANSITION",
};

export const BEAT_TYPE_LABELS = {
  INTRO: "Intro",
  EXPOSITION: "Concept",
  EXAMPLE: "Example",
  CHECK: "Question",
  RECAP: "Recap",
  TRANSITION: "Transition",
};

// Typewriter speed for chalkboard writing (characters per second)
export const TYPEWRITER_CPS = 90;

// CHECK passing threshold (0-100 grader scale)
export const CHECK_PASS_THRESHOLD = 70;
