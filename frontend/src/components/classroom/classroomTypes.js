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
 *   // CHECK-only (multiple choice):
 *   question?: string,
 *   options?: string[],       // 3-5 strings; correct one stored at index 0
 *                             // in the plan, but shuffled at render time
 *   correct_index?: number,   // 0-based, against canonical (unshuffled) order
 *   explanation?: string,     // revealed after the student answers
 *   // EXAMPLE-only:
 *   code?: string | null,
 *   explanation?: string,
 * }
 *
 * CheckResult (per beat, in component state after submit) = {
 *   selected_index: number,   // shuffled-display index the student picked
 *   correct_index: number,    // canonical correct index (for compare)
 *   passed: boolean,
 *   score: 0 | 100,           // deterministic — exact match wins
 *   explanation: string,      // shown after the answer
 *   first_try: boolean,
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
  // Deterministically-injected practice beat. Code is verbatim from
  // the SOT entry's code_blocks (no LLM in the loop). User types it
  // out for muscle memory; hybrid mode forgives wrong keystrokes.
  TYPING_PRACTICE: "TYPING_PRACTICE",
};

export const BEAT_TYPE_LABELS = {
  INTRO: "Intro",
  EXPOSITION: "Concept",
  EXAMPLE: "Example",
  CHECK: "Question",
  RECAP: "Recap",
  TRANSITION: "Transition",
  TYPING_PRACTICE: "Type it",
};

// Typewriter speed for chalkboard writing (characters per second)
export const TYPEWRITER_CPS = 90;
