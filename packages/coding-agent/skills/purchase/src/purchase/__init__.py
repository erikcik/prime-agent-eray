"""Prime Agent purchase skill: spend the business budget with operator approval.

Every purchase is shown to the operator in their terminal and waits for an
explicit Approve or Reject. The budget ledger and card credentials live in the
TypeScript host; these functions are thin wrappers over `rlm.host_request`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from rlm import host_request


@dataclass(frozen=True)
class Card:
    """Card credentials for one approved purchase. Printing it shows only the last four digits."""

    number: str = field(repr=False)
    expiry: str = field(repr=False)
    cvc: str = field(repr=False)
    name: str | None = field(default=None, repr=False)

    def __repr__(self) -> str:
        return f"Card(****{self.number[-4:]}, exp {self.expiry})"

    __str__ = __repr__


@dataclass(frozen=True)
class Decision:
    """The operator's answer to a purchase request."""

    id: str
    approved: bool
    remaining: float
    reason: str | None = None
    card: Card | None = None


async def request(
    amount: float,
    merchant: str,
    description: str,
    expected_outcome: str | None = None,
    url: str | None = None,
) -> Decision:
    """Ask the operator to approve one purchase and wait for the answer.

    `amount` is in the budget currency (see `budget()`); include taxes and fees.
    Rejections carry the operator's reason: read it and adjust, do not retry
    the same request unchanged. On approval, `decision.card` holds the card
    for this purchase only.
    """
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        raise TypeError(f"amount must be a number, got {type(amount).__name__}")
    payload: dict[str, Any] = {"amount": float(amount), "merchant": merchant, "description": description}
    if expected_outcome is not None:
        payload["expected_outcome"] = expected_outcome
    if url is not None:
        payload["url"] = url
    reply = await host_request("purchase.request", payload)
    card = reply.get("card")
    return Decision(
        id=reply["id"],
        approved=bool(reply["approved"]),
        remaining=float(reply["remaining"]),
        reason=reply.get("reason"),
        card=Card(card["number"], card["expiry"], card["cvc"], card.get("name")) if card else None,
    )


async def code(purchase_id: str, prompt: str | None = None) -> str:
    """Ask the operator for a verification code (3-D Secure SMS) for an approved purchase."""
    payload: dict[str, Any] = {"id": purchase_id}
    if prompt is not None:
        payload["prompt"] = prompt
    reply = await host_request("purchase.code", payload)
    return reply["code"]


async def budget() -> dict[str, Any]:
    """Budget status: `budget`, `currency`, `spent`, `remaining`, and recent `history` with operator reasons."""
    return await host_request("purchase.budget")
