---
name: purchase
description: Spend money from the business budget. Every purchase is sent to the operator for approval and returns a card only when approved. Use before paying for any service, subscription, domain, ad, or tool.
---

# Purchase

You have a fixed, one-time budget for running the business. Each purchase goes
to the operator, who approves or rejects it in their terminal. Call it from the
Python REPL:

```python
status = await purchase.budget()
decision = await purchase.request(
    12.0,
    merchant="Namecheap",
    description="bilgo-demo.com domain, 1 year",
    expected_outcome="landing page for the outbound campaign",
    url="https://www.namecheap.com/...",
)
if decision.approved:
    card = decision.card  # card.number, card.expiry, card.cvc, card.name
```

## API

- `await purchase.budget()`: returns `budget`, `currency`, `spent`, `remaining`, and
  recent `history` with the operator's reasons for past rejections.
- `await purchase.request(amount, merchant, description, expected_outcome=None, url=None)`:
  waits for the operator and returns a `Decision` with `id`, `approved`,
  `remaining`, `reason`, and `card` (set only when approved). `amount` is in the
  budget currency and must include taxes and fees.
- `await purchase.code(decision.id, prompt=None)`: asks the operator for a
  verification code (the bank's 3-D Secure SMS) during checkout of an approved
  purchase. It returns the code as a string.

## Rules

- Request approval immediately before paying, one purchase per request, with the
  exact amount you are about to be charged. Never pay without an approved decision.
- Use the card only for the purchase it was approved for. Do not print, log,
  store, or send the card details anywhere except the approved merchant's
  checkout form.
- Say why the purchase moves the business forward in `expected_outcome`. The
  operator decides from that line.
- A rejection is feedback. Read `decision.reason`, change the plan, and do not
  resend the same request.
- Recurring charges (subscriptions, trials that convert) count in full. State
  the renewal terms in `description` and cancel what you no longer need.
