"""
check_models — CLI sanity check that all the LLMs the app routes to
are actually pulled in the local Ollama install.

Usage:
    .venv/bin/python scripts/check_models.py

Exits 0 if every required model is present; exits 1 with a list of
what's missing and the `ollama pull` commands to run, otherwise.

Useful before the first launch and after `ollama` updates. The required
roles are sourced from core/model_router.py so adding a new role auto-
picks up here.
"""

import sys

import ollama

# Import lazily so this script works even if the user hasn't activated
# the project venv yet — they still get a useful error message instead
# of an ImportError stack trace.
try:
    from core.model_router import (
        ADVISE,
        GENERAL_CHAT,
        GRADE,
        QUIZ_GENERATE,
        SUMMARIZE,
        TEACH,
        TEACH_PLAN,
    )
except ImportError:
    print(
        "Could not import core.model_router. Run this from the backend "
        "directory with the project's venv:\n"
        "  cd backend && .venv/bin/python scripts/check_models.py",
        file=sys.stderr,
    )
    sys.exit(2)


def main() -> int:
    """Return 0 if every required model is locally available, 1 otherwise."""
    required = {
        # The same model can serve multiple roles; deduped via set().
        SUMMARIZE,
        ADVISE,
        QUIZ_GENERATE,
        GRADE,
        GENERAL_CHAT,
        TEACH,
        TEACH_PLAN,
    }

    try:
        installed = {m.model for m in ollama.list().models}
    except Exception as e:
        print(
            f"Could not reach Ollama: {e}\n"
            "Is the Ollama app running?",
            file=sys.stderr,
        )
        return 2

    missing = sorted(m for m in required if m not in installed)

    print(f"Installed Ollama models: {sorted(installed) or '(none)'}")
    print(f"Required by my-AI-stro:  {sorted(required)}")
    print()

    if not missing:
        print("✓ All required models present.")
        return 0

    print("✗ Missing models:")
    for m in missing:
        print(f"    {m}")
    print()
    print("Pull them with:")
    for m in missing:
        print(f"    ollama pull {m}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
