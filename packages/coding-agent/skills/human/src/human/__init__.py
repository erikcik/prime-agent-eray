"""Prime Agent human skill: ask the operator for what only a person can provide.

Each call opens a dialog in the operator's terminal and waits for the answer.
These functions are thin wrappers over `rlm.host_request`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from rlm import host_request


@dataclass(frozen=True)
class Handoff:
    """The operator's answer to a handoff: whether the step is done, and an optional note."""

    done: bool
    note: str | None = None


async def ask(question: str, placeholder: str | None = None) -> str:
    """Ask the operator a question and return the typed answer (an SMS code, a phone number, a detail)."""
    payload: dict[str, Any] = {"question": question}
    if placeholder is not None:
        payload["placeholder"] = placeholder
    reply = await host_request("human.ask", payload)
    return reply["answer"]


async def choose(question: str, options: list[str]) -> str:
    """Ask the operator to pick one of `options` and return the chosen option."""
    reply = await host_request("human.choose", {"question": question, "options": list(options)})
    return reply["choice"]


async def handoff(task: str, why: str | None = None, url: str | None = None) -> Handoff:
    """Ask the operator to do a step themselves (identity check, CAPTCHA, phone call) and wait until they finish."""
    payload: dict[str, Any] = {"task": task}
    if why is not None:
        payload["why"] = why
    if url is not None:
        payload["url"] = url
    reply = await host_request("human.handoff", payload)
    return Handoff(done=bool(reply["done"]), note=reply.get("note"))
