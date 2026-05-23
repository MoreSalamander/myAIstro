"""
General Chat Agent — free-form conversational mode.

Explicitly NOT grounded in the SOT. Answers from the model's own
knowledge. This is the counterpart to advisor_agent: same streaming
interface, no SOT retrieval, no context block.

Trust isolation: routed to llama3.2, not the llama3:8b summarization
model. The two roles must not share weights — the cost would be
epistemic, not runtime. See `core/model_router.py` for the rule.
"""

from typing import Iterable

import ollama

from core.model_router import GENERAL_CHAT


# Personalized to the project's owner. This file is single-tenant by
# design — there's exactly one user (the owner whose Mac the system
# runs on), so the system prompt names them. Visitors via Tailscale
# Funnel reach this endpoint but the "you are chatting with Kevin"
# framing still applies because the conversation is *about* Kevin's
# personal study tool. Adapt the name when forking.
SYSTEM_PROMPT = (
    "You are a helpful, honest assistant chatting with Kevin in a "
    "general-purpose mode. You are NOT connected to his Source of Truth "
    "(his personal lesson notes). Answer from your own knowledge. Be "
    "concise unless he asks for depth, and admit uncertainty rather "
    "than fabricating."
)


def stream_chat(query: str) -> Iterable[str]:
    """
    Yield content chunks as they arrive from the general-chat model.
    """

    stream = ollama.chat(
        model=GENERAL_CHAT,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": query},
        ],
        options={
            "num_ctx": 8192,
            "num_predict": 2048,
            "temperature": 0.6,
        },
        stream=True,
    )

    for chunk in stream:
        msg = chunk.get("message") or {}
        content = msg.get("content")
        if content:
            yield content
