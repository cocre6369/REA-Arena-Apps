# P0 — Legal, scope, and the clean-room wall

**Not legal advice.** This is engineering hygiene: a checklist for staying on the defensible side, and a
prompt to get a real lawyer involved when the stakes justify it.

---

## The core distinction

Copyright protects **expression**, not **function**. An independent implementation that reproduces
*behaviour* without reproducing the original's creative expression is a different work
[2](https://news.ycombinator.com/item?id=30699165). That is the entire legal foundation of this
methodology, and everything below is about keeping that distinction provable.

## Case law worth knowing (US)

| Case | What it established |
|---|---|
| *Sega v. Accolade* (1992) | Disassembly / intermediate copying is fair use where needed to reach unprotected functional elements for compatibility [5](https://github.com/Kyvero-Vexus/clean-room-reverse-engineering/blob/master/2026-03-21-clean-room-reverse-engineering-complete-writeup-v1.md) |
| *Atari v. Nintendo* (1992) | Reverse engineering permitted in principle — but bad-faith acquisition or contamination undercuts the defence [5](https://github.com/Kyvero-Vexus/clean-room-reverse-engineering/blob/master/2026-03-21-clean-room-reverse-engineering-complete-writeup-v1.md) |
| *Sony v. Connectix* (2000) | Intermediate copying during RE is fair use when the final product contains no copyrighted material [1](https://www.ntari.org/post/how-clean-room-reverse-engineering-built-the-modern-tech-industry) |

## EU

Software Directive 2009/24/EC allows decompilation for interoperability only where **indispensable** and
confined to what is necessary; information gained can't be reused for unrelated purposes, and contract
clauses that conflict with Art. 6 are generally void
[5](https://github.com/Kyvero-Vexus/clean-room-reverse-engineering/blob/master/2026-03-21-clean-room-reverse-engineering-complete-writeup-v1.md).
Practically: document *why* each invasive step was necessary.

## What the clean-room wall does **not** protect you from

- **Protected expression that leaked through.** If your output copies code, art, audio, or creative copy,
  the wall is irrelevant [4](https://www.beankinney.com/news-and-insights/blogs/512000-lines-one-night-zero-permission-the-claude-code-leak-and-the-legal-crisis-of-ai-clean-rooms/).
- **Patents.** Independent creation is no defence to patent infringement.
- **Trade secret misappropriation** and **breach of contract / ToS** — separate causes of action entirely.
- **DMCA §1201** anti-circumvention: a risk even where the copyright analysis is favourable. The §1201(f)
  interoperability carve-out is narrow and purpose-bound
  [5](https://github.com/Kyvero-Vexus/clean-room-reverse-engineering/blob/master/2026-03-21-clean-room-reverse-engineering-complete-writeup-v1.md).
  **Bypassing a technical protection measure to access protected content is where RE stops being
  interoperability work and starts being circumvention.**

---

## Gatekeeping questions — answer before P1

Copy into `00-triage.md` and fill in:

```markdown
- Target:
- Purpose of the RE: [interoperability | security research | learning | competitive analysis | rebuild]
- Do we lawfully possess the copy being analysed? How was it obtained?
- Is the target our own property, a client's with written authorisation, or third-party?
- Contractual constraints: app store terms, EULA, ToS, NDA, employment agreement
- Is there a TPM (DRM, obfuscation-as-TPM, licensing check) we'd have to circumvent?
- Does any output need to interoperate with a proprietary protocol/file format?
- Third-party IP inside the target (SDKs, licensed engines, fonts) — will it contaminate the rebuild?
- Jurisdiction(s):
- Counsel engaged? [no | yes — who]
```

Refuse or escalate if: no lawful access, purpose is evasion of a paywall/licence, or the target is
protected health/financial data with no authorisation.

---

## The protocol

### Analysis side (tainted)

1. Observe the target — run it, decompile it, capture traffic.
2. Write **functional** descriptions only: what happens, in what order, with what inputs and outputs.
3. Log provenance for every artifact ([`../templates/01-evidence-log.csv`](../templates/01-evidence-log.csv)).
4. Hand over: specs, diagrams, tables. **Never** code, resources, screenshots of the original's UI used as
   design reference, or verbatim strings.

### The wall

Physical separation where possible: different working trees, different people. At minimum, different
directories with the rule that nothing from `cases/<app>/extracted/` is ever opened while writing
`cases/<app>/06-clean-room-spec.md`. In this repo that separation is enforced by convention plus the
`.gitignore` that keeps extracted artifacts out of the tree.

### Implementation side (clean)

1. Receives only approved specs and **public** reference material.
2. Implements from scratch.
3. **Never** consults the original artifacts. If a question can't be answered from the spec, the spec is
   incomplete — send it back, don't peek.

---

## Contamination response

If original code or assets get mixed in [5](https://github.com/Kyvero-Vexus/clean-room-reverse-engineering/blob/master/2026-03-21-clean-room-reverse-engineering-complete-writeup-v1.md):

1. **Freeze** the affected module and branch.
2. **Isolate** who/what was exposed.
3. **Forensic compare** — what exactly came from where.
4. **Purge and re-spec** the affected behaviour from clean inputs only.
5. **Re-implement** with unexposed contributors.
6. **Document** the whole remediation, end to end.

---

## Practitioner rules of thumb

- Prefer black-box and public-doc pathways first; escalate to invasive methods only when indispensable.
- Prove necessity, narrow scope, and interoperability purpose at each technical step.
- Treat provenance as a deliverable equal in importance to the code.
- Assume a future forensic audit of the sensitive modules.
- Audit routinely, not only in a crisis.

---

## AI-specific caution

No court has ruled on whether an AI-assisted rewrite qualifies as clean-room. The unresolved question:
if the *creating agent* is given the original source as input, is the output "independent creation"
[4](https://www.beankinney.com/news-and-insights/blogs/512000-lines-one-night-zero-permission-the-claude-code-leak-and-the-legal-crisis-of-ai-clean-rooms/),
[3](https://jiaweing.com/blog/clean-room-development)?

Conservative operating rule for this repo: **the implementation step is driven by the human-authored
behavioural spec, and the spec is what gets fed to any model — not the decompiled output.** Keeps the
causal chain identical to the traditional process.
