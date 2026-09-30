---
name: human
description: Ask the operator (the person running you) for what only a person can provide - SMS or email verification codes, their phone number, identity checks, CAPTCHAs you cannot pass, and decisions you should not make alone. Each call waits for their answer in the terminal.
---

# Human

The operator is the person who started this session. They answer in their
terminal while you wait. Call it from the Python REPL:

```python
phone = await human.ask("Which phone number should I use for the Twilio signup?", placeholder="+44...")
code = await human.ask("Twilio sent an SMS code to your phone. What is it?", placeholder="6 digits")
plan = await human.choose("Which voice provider should the MVP use?", ["ElevenLabs", "Cartesia", "Let me decide later"])
result = await human.handoff(
    "Complete the Stripe identity check (passport photo + selfie) on your phone.",
    why="Stripe needs a verified person before the account can take payments",
    url="https://dashboard.stripe.com/account/onboarding",
)
if not result.done:
    print(result.note)  # what to do instead
```

## API

- `await human.ask(question, placeholder=None) -> str`: free-text answer.
- `await human.choose(question, options) -> str`: one of `options` (at least two).
- `await human.handoff(task, why=None, url=None) -> Handoff`: the operator does
  the step themselves and returns `done` (bool) and an optional `note`.

All three raise if no operator is attached (print mode, benchmarks) or the
operator dismisses the dialog. Only the top-level agent has this skill.

## When to ask

- Do everything you can yourself first. Ask only for what you cannot get: codes
  sent to the operator's phone or inbox, their personal or company details,
  identity documents, payment verification, CAPTCHAs that keep failing.
- Accounts that need a phone number or identity check: sign up yourself, use the
  operator's details when the form asks for them (ask once, then reuse the
  answer), and ask for each code the moment the site sends it. Codes expire in
  minutes, so keep the page open and submit the code right away.
- Identity checks (document photos, selfies, video) are always a `handoff`. Give
  the exact URL, or tell the operator to use the site's "continue on phone"
  option.
- If a step needs a person (a CAPTCHA, a login you cannot finish), `handoff`
  it with the URL and what the page shows.
- One clear question per call, with the context the operator needs to answer
  without scrolling back: the site, what it asked for, and why you need it.
- If the operator says no or cannot do it, read the note and change the plan.
  Do not ask the same thing again.
