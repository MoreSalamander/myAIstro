"""
Model Router

Central source of truth for which Ollama model each agent role uses.
Change model assignments here in one place; agents import the role they need.

Design:
- Per-role specialization: each agent gets the model best suited to its job.
- LLM-as-judge separation: GRADE uses a different model than the generators
  (SUMMARIZE, QUIZ_GENERATE) to reduce self-bias when scoring output.

Note: Ollama may evict an idle model from memory when serving another, so
the first call after switching roles can be slow.
"""

# -------- Generator roles --------
SUMMARIZE = "llama3:8b"            # structured extraction of lesson content
QUIZ_GENERATE = "llama3.2:latest"  # recall-question phrasing from SOT entries
# llama3.2 has a 128K context window, which the advisor needs for
# course-wide queries ("study guide for BE101") that select 20+ SOT
# entries — llama3:8b's 8K cap was squeezing the output too hard.
ADVISE = "llama3.2:latest"

# -------- Judge roles --------
GRADE = "mistral:latest"           # scores user quiz answers; separate from generators
# JUDGE: deprecated. The audit pipeline now uses a deterministic Python
# scorer (agents/judge_agent.py::score_entry) instead of an LLM judge.
# Kept as a reference if you ever want to A/B against an LLM rubric.
JUDGE = "mistral:latest"

# -------- General chat (untethered from SOT) --------
# A free-form conversational mode that answers from the model's own
# knowledge — explicitly NOT grounded in the user's SOT.
#
# Trust-isolation rule: the model responsible for SUMMARIZE (which
# owns the canonical Source of Truth) does NOT also handle ungrounded
# speculative chat. The cost of sharing isn't runtime — Ollama calls
# are stateless — it's epistemic: it muddies the "this entry was
# carefully extracted" claim if the same weights also free-associate
# in the same app. General Chat is a novel trivial addition; the SOT
# is the core asset. Keep them on different models.
#
# llama3.2 is already the conversational model behind the SOT-grounded
# Advisor and the Classroom Teacher, so reusing it for General Chat
# adds zero operational complexity (model stays hot across roles).
GENERAL_CHAT = "llama3.2:latest"

# -------- Classroom (Teacher Aide + Teacher) --------
# llama3.2 has the 128K context the Aide needs to synthesize a full
# lesson plan from a SOT entry plus optional related entries. Teacher
# uses the same model for runtime corrections; the actual judging of
# student answers stays on mistral via the existing quiz grader, so
# the LLM-as-judge separation principle is preserved.
TEACH_PLAN = "llama3.2:latest"
TEACH = "llama3.2:latest"
