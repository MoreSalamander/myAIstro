#!/usr/bin/env python3
"""
H0 verification — end-to-end test that mastery-goals binding actually
changes Classroom CHECK behavior.

Runs a synthetic canonical-format lesson through the full pipeline
and reports each stage. The real test is the LLM call — does the
plan generator, when told CHECKs MUST cover the mastery goals,
actually produce CHECKs that do?

Usage:
    cd backend && source .venv/bin/activate
    python3 scripts/verify_mastery_goals_h0.py            # full run (calls LLM)
    python3 scripts/verify_mastery_goals_h0.py --no-llm   # data-plumbing only

The synthetic lesson is realistic enough to test the binding behavior
but small enough to keep iteration fast. The expected outcome is:
- All 4 mastery goals extracted by the deterministic extractor
- Plan generator includes 2+ CHECK beats that reference those goals
- Plan validator reports good coverage (no warnings about drift)

If any stage fails, the report names where so the fix is targeted.
"""

import argparse
import json
import sys
from pathlib import Path

# Make backend/ importable when run from anywhere
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.mastery_extractor import extract_mastery_goals
from agents.summarization_agent import summarize_lesson  # noqa: E402 (path setup above)
from agents.plan_validator import validate_plan
from agents.teacher_aide_agent import _build_prompt, parse_plan, stream_plan


# A realistic-looking lesson with canonical mastery goals.
# Includes prose + code + the canonical recap so the extractor and
# downstream code see something close to a real ingest.
SYNTHETIC_LESSON = """A Python function is a reusable block of code you can run by name.
You define a function using the `def` keyword followed by the function's name and a list
of parameters in parentheses. Whatever you write indented under the `def` line is the
function body — that's the code that runs when the function is called.

Here's the simplest possible example:

```python
def greet(name):
    return f"Hello, {name}"
```

This function takes one parameter, `name`, and returns a greeting string built from it.
The `return` keyword sends a value back to whoever called the function. Without `return`,
the function would still run, but it would implicitly return `None` — useful sometimes,
but not what you want when you need a value back.

To call a function, write its name followed by parentheses containing any arguments:

```python
message = greet("Kevin")
print(message)
```

This calls `greet` with the argument `"Kevin"`, which becomes the value of the `name`
parameter inside the function body. The returned string is assigned to `message`, then
printed. The order matters: positional arguments map to parameters by position.

You can have multiple parameters too, and Python will require all of them unless you
provide default values:

```python
def make_intro(name, role="student"):
    return f"{name} is a {role}."
```

Now `make_intro("Kevin")` returns `"Kevin is a student."` because `role` defaults to
`"student"`. Calling `make_intro("Kevin", "engineer")` overrides the default.

## Mastery Goals
- Declare a function with `def` and a name
- Pass parameters and use them inside the function body
- Return a value with the `return` keyword
- Call a function with arguments and use its result
"""


def stage(name: str, body: str = "") -> None:
    """Print a stage divider with optional body."""
    print()
    print("=" * 72)
    print(f"  {name}")
    print("=" * 72)
    if body:
        print(body)


def pass_or_fail(condition: bool, label: str) -> bool:
    """Print PASS/FAIL line; return condition unchanged for chaining."""
    marker = "✓ PASS" if condition else "✗ FAIL"
    print(f"  [{marker}]  {label}")
    return condition


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-llm",
        action="store_true",
        help="Skip the actual LLM call. Only verify data plumbing.",
    )
    args = parser.parse_args()

    all_pass = True

    # ---- Stage 1: extractor ---------------------------------------------
    stage("Stage 1 — deterministic extractor")
    goals = extract_mastery_goals(SYNTHETIC_LESSON)
    print(f"  Extracted {len(goals)} goals:")
    for g in goals:
        print(f"    • {g}")
    all_pass &= pass_or_fail(len(goals) == 4, "extracted exactly 4 goals")
    all_pass &= pass_or_fail(
        any("def" in g.lower() for g in goals),
        "first goal mentions def",
    )

    # ---- Stage 2: summarization sidecar ---------------------------------
    stage("Stage 2 — summarization runs extractor as sidecar")
    print("  Calling summarize_lesson (this hits ollama for the LLM-extracted")
    print("  fields like summary/key_concepts; mastery_goals come from the")
    print("  deterministic sidecar regardless of the LLM's output)…")
    if args.no_llm:
        print("  [SKIPPED — --no-llm flag set; checking extractor output only]")
        sidecar_goals = extract_mastery_goals(SYNTHETIC_LESSON)
        all_pass &= pass_or_fail(
            sidecar_goals == goals,
            "extractor returns same goals as stage 1",
        )
    else:
        summary = summarize_lesson(SYNTHETIC_LESSON)
        print(f"  summary length: {len(summary.get('summary') or '')} chars")
        print(f"  key_concepts:   {len(summary.get('key_concepts') or [])} items")
        print(f"  definitions:    {len(summary.get('definitions') or [])} items")
        print(f"  code_blocks:    {len(summary.get('code_blocks') or [])} items")
        print(f"  mastery_goals:  {len(summary.get('mastery_goals') or [])} items  ← deterministic")
        for g in summary.get("mastery_goals") or []:
            print(f"    • {g}")
        all_pass &= pass_or_fail(
            summary.get("mastery_goals") == goals,
            "summarize_lesson preserves mastery_goals verbatim from extractor",
        )

    # ---- Stage 3: synthesize the SOT entry the controller would see ----
    stage("Stage 3 — synthesize SOT entry shape")
    if args.no_llm:
        fake_entry = {
            "event_id": "verify-h0-event-id",
            "course": "PY101", "week": "1", "lesson": "Functions",
            "raw_text": SYNTHETIC_LESSON,
            "summary": "Functions in Python: def, parameters, return, calling.",
            "key_concepts": ["def keyword", "parameters", "return", "function call"],
            "definitions": [],
            "code_blocks": ["def greet(name):\n    return f\"Hello, {name}\""],
            "mastery_goals": goals,
        }
    else:
        fake_entry = {
            "event_id": "verify-h0-event-id",
            "course": "PY101", "week": "1", "lesson": "Functions",
            "raw_text": SYNTHETIC_LESSON,
            "summary": summary.get("summary"),
            "key_concepts": summary.get("key_concepts"),
            "definitions": summary.get("definitions"),
            "code_blocks": summary.get("code_blocks"),
            "mastery_goals": summary.get("mastery_goals"),
        }
    print(f"  Constructed entry with {len(fake_entry['mastery_goals'])} mastery_goals")

    # ---- Stage 4: prompt construction ----------------------------------
    stage("Stage 4 — teacher_aide prompt includes mastery binding")
    prompt = _build_prompt(fake_entry)
    has_block = "LESSON MASTERY GOALS" in prompt
    has_binding = "MASTERY GOAL BINDING" in prompt
    has_first_goal = goals[0] in prompt
    all_pass &= pass_or_fail(has_block, "prompt includes 'LESSON MASTERY GOALS' block")
    all_pass &= pass_or_fail(has_binding, "prompt includes 'MASTERY GOAL BINDING' rule")
    all_pass &= pass_or_fail(has_first_goal, "prompt includes the actual goal text verbatim")

    # ---- Stage 5: actual LLM plan generation ---------------------------
    if args.no_llm:
        stage("Stage 5 — SKIPPED (--no-llm)")
        print("  Re-run without --no-llm to test the actual plan-generation behavior.")
    else:
        stage("Stage 5 — LLM generates plan against the binding rule")
        print("  Calling stream_plan (this is the real test — does the LLM honor")
        print("  the binding rule and produce CHECKs covering mastery goals?)…")
        raw_plan = ""
        for evt in stream_plan(fake_entry):
            if evt["type"] == "raw_done":
                raw_plan = evt["text"]
            elif evt["type"] == "error":
                print(f"  STREAM ERROR: {evt['message']}")
                return 1
        plan = parse_plan(raw_plan, fake_entry)
        beats = plan.get("beats") or []
        check_beats = [b for b in beats if (b.get("type") or "").upper() == "CHECK"]
        print(f"  Plan: {len(beats)} beats, {len(check_beats)} CHECKs")
        all_pass &= pass_or_fail(
            len(check_beats) > 0,
            "model produced at least one CHECK beat",
        )

        # If something failed catastrophically, dump raw output so we can
        # see what the model actually emitted vs what the parser accepted.
        if len(check_beats) == 0 or len(beats) == 0:
            print()
            print("  --- RAW MODEL OUTPUT (first 3000 chars) ---")
            print(raw_plan[:3000])
            print("  --- END RAW OUTPUT ---")

        # ---- Stage 6: validate + report coverage ------------------------
        stage("Stage 6 — validate plan against mastery_goals coverage")
        validation = validate_plan(plan, mastery_goals=fake_entry["mastery_goals"])
        print(f"  validation: {validation['validation']}")
        print(f"  score:      {validation['score']}")
        warnings = validation.get("warnings") or []
        if warnings:
            print(f"  warnings ({len(warnings)}):")
            for w in warnings:
                print(f"    - {w}")
        else:
            print("  warnings:   (none)")

        coverage = validation.get("mastery_coverage_report")
        if coverage:
            covered = coverage["covered_goals"]
            total = coverage["total_goals"]
            print(f"\n  Mastery-goal coverage (structural via mastery_goal_index): {covered}/{total}")
            inconsistent_count = 0
            for entry in coverage["per_goal"]:
                tick = "✓" if entry["covered"] else "✗"
                bidx = entry["covering_beat_index"]
                if bidx is None:
                    extra = "(uncovered)"
                elif entry["binding_consistent"] is False:
                    extra = f"(via CHECK #{bidx}, BUT binding looks inconsistent — model may have lied)"
                    inconsistent_count += 1
                else:
                    extra = f"(via CHECK #{bidx})"
                print(f"    {tick} Goal #{entry['goal_index']}: {entry['goal']}  {extra}")
            all_pass &= pass_or_fail(
                len(check_beats) == total,
                f"exactly {total} CHECK beats generated (one per goal)",
            )
            all_pass &= pass_or_fail(
                covered == total,
                f"ALL {total} goals have a CHECK with matching mastery_goal_index",
            )
            all_pass &= pass_or_fail(
                inconsistent_count == 0,
                f"no inconsistent bindings (questions match their claimed goals)",
            )

        # ---- Stage 7: show the actual CHECKs ---------------------------
        stage("Stage 7 — generated CHECK beats (the real verification)")
        for i, b in enumerate(check_beats):
            print(f"\n  CHECK {i+1}:")
            print(f"    Q:       {(b.get('question') or '')[:200]}")
            opts = b.get("options") or []
            for j, opt in enumerate(opts):
                marker = "✓" if j == b.get("correct_index") else " "
                print(f"    {marker} [{j}] {str(opt)[:160]}")
            expl = (b.get("explanation") or "").strip()
            if expl:
                print(f"    Why:     {expl[:200]}")

    # ---- Final report ----------------------------------------------------
    stage("FINAL")
    if all_pass:
        print("  ✓ H0 verification PASSED — mastery-goals binding works end-to-end.")
        return 0
    else:
        print("  ✗ H0 verification FAILED — one or more stages did not behave as expected.")
        print("    Re-read the stage output above to locate the failure.")
        return 2


if __name__ == "__main__":
    sys.exit(main())
