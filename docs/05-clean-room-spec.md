# P5 — The clean-room spec

**The wall is here.** Everything upstream of this document may contain knowledge derived from the
original. This document may not. It gets implemented by someone (human or machine) who has seen nothing
else.

---

## The test

> Could a competent engineer who has never seen the original build from this, without asking a single
> clarifying question?

- ✅ "On submit, the client sends the entered identifier and secret to the session endpoint; on HTTP 401
  it displays a generic authentication failure and clears the secret field."
- ❌ "Show a red toast reading 'Hmm, that password doesn't look right.'" — that's the original's copy.
- ✅ "Sorts the list in place by descending timestamp."
- ❌ "Call `FeedSorter.sortDescending()` then `adapter.notifyDataSetChanged()`." — that's their architecture.

The distinction is **observable behaviour** versus **implementation and expression**.

---

## What must NOT be in here

| Don't carry across | Why |
|---|---|
| Any original source, bytecode, or disassembly | That's the thing the wall exists to prevent |
| Layout XML, storyboards, XIBs, CSS | Protectable expression; design your own layout |
| Strings, copy, error-message wording | Creative expression. Write your own |
| Images, icons, illustrations, fonts, audio, animation curves | Straightforward copyright; these are new work in the rebuild |
| Internal class / method / package names | Their architecture, not behaviour |
| Their feature names and branding | Trademark and trade dress |
| Algorithmic details not observable from outside | If you can only know it by reading their code, it doesn't belong |

## What SHOULD be in here

Observable behaviour: inputs, outputs, ordering, states, transitions, timing, error handling, and — **where
interoperability demands it** — wire formats, file formats, and protocol details. Those are technical
necessities, and reproducing them is exactly what the case law protects
[1](https://www.ntari.org/post/how-clean-room-reverse-engineering-built-the-modern-tech-industry).

---

## Structure

Use [`../templates/06-clean-room-spec.md`](../templates/06-clean-room-spec.md).

1. **Purpose and scope** — what this system does, and an explicit out-of-scope list.
2. **Actors and states** — user roles, session states, entitlement states.
3. **Screens** — per screen: purpose, inputs, outputs, every state, transitions, edge cases.
4. **Operations** — per operation: preconditions, steps, postconditions, failure modes and recovery.
5. **Data model** — entities, fields, types, constraints, lifecycle, storage tier, sync.
6. **Interface contracts** — wire protocol, pagination, auth, error envelopes, versioning.
7. **Non-functionals (observable only)** — latency budgets, offline behaviour, accessibility, data
   retention.
8. **Explicitly unspecified** — visual design, copy, branding, iconography. Say so out loud, so nobody
   "fills the gap" by going back to the original.

---

## Review checklist (before implementation starts)

- [ ] Every requirement is stated as **observable behaviour**, not as an implementation instruction.
- [ ] Zero original strings, names, or structural details present.
- [ ] Every requirement traces to evidence in `04-*` (lineage holds).
- [ ] No `unverified` items carried over — each was either tested or dropped.
- [ ] Wire formats that are included are justified by **interoperability necessity**, and that
      justification is written down.
- [ ] Someone who hasn't seen the original can read it cold and start building.
- [ ] Out-of-scope section is explicit about visual design and copy.

---

## If the spec has a hole

Send it back upstream — go get the behaviour from the running app. **Do not** resolve an ambiguity by
looking at the original code. The moment the implementation side opens `extracted/`, the wall is gone and
the whole exercise was theatre.

---

## A note on AI-assisted implementation

Whether an AI-assisted rewrite qualifies as clean-room is genuinely unsettled: if the generating model is
handed the original source, it's hard to call the output independent creation
[4](https://www.beankinney.com/news-and-insights/blogs/512000-lines-one-night-zero-permission-the-claude-code-leak-and-the-legal-crisis-of-ai-clean-rooms/),
[3](https://jiaweing.com/blog/clean-room-development).

**Operating rule in this repo:** the model receives the human-authored behavioural spec and public
reference material. It never receives decompiled output, extracted resources, or original assets. That
keeps the causal chain the same as the traditional two-team process — the spec is the only thing that
crosses.
