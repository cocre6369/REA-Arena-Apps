# P6 — Rebuild and verification

Build from `06-clean-room-spec.md` only. Then prove it matches.

---

## 1. Choose the stack on merit

Pick what fits the spec, the team, and the deployment target — **not** what the original used. Using
React Native because the original did is mimicry; using it because you need one codebase on two platforms
is engineering.

Match the original only when interoperability *requires* it: same wire protocol, same file format, same
plugin ABI. That's a technical necessity and it's fine — everything else is free.

## 2. Build against mocks first

Convert captured traffic into fixtures. The rebuild should never depend on the target's live backend
during development [4](https://www.quora.com/How-can-I-reverse-engineer-a-website-built-on-HTML-CSS-JS):

```bash
# HAR → fixtures
python3 scripts/har2fixtures.py captured/session1.har -o mocks/
```

Then serve with MSW (web), json-server, WireMock, or a small local stub. Fixtures also become the
regression suite: same inputs, same expected outputs, forever.

## 3. Differential testing

The core verification loop:

```
        ┌─────────┐                    ┌─────────┐
inputs ─▶ ORIGINAL│──observed output──▶│ COMPARE │──▶ diff report
        └─────────┘                    │         │
        ┌─────────┐                    │         │
inputs ─▶ REBUILD │──observed output──▶└─────────┘
        └─────────┘
```

Compare at every level where it's meaningful:

| Level | Compare | Tooling |
|---|---|---|
| Wire | request bytes, headers, response parsing | fixture replay + diff |
| Behaviour | screen state after each action in the edge-case matrix | scripted walkthrough |
| Data | persisted state after a flow | dump both stores, diff |
| Performance | p50 / p95 latency, memory, battery | profiler on both |
| Edge cases | every row of the matrix | manual + automated matrix runner |

Automate the walkthrough — a scripted click-path (Appium / Playwright / Maestro) run against both builds
turns "looks right" into a diff.

## 4. Prototype as validator

Building is the fastest way to find holes in the spec. Every ambiguity you hit while implementing is a
**spec defect** — fix the spec, then the code, otherwise the next implementer hits the same wall
[1](https://www.thoughtworks.com/en-us/insights/blog/generative-ai/blackbox-reverse-engineering-ai-rebuild-application-without-accessing-code).

A rebuild that diverges from the original is usually evidence of a spec gap in the edge-case matrix, not a
coding error. Go back to P4 and fill the row.

## 5. Ship-readiness checklist

- [ ] Every row of the edge-case matrix passes (or is a documented, intentional deviation)
- [ ] Zero original code, assets, strings, or resources in the tree — verified by inspection
- [ ] Provenance: `01-evidence-log.csv` complete, spec lineage intact
- [ ] Independent review: someone who hasn't seen the target reads the spec and confirms it's buildable
- [ ] Legal sign-off if this is going anywhere public
- [ ] Deviations from the original are listed with reasons

---

## Rebuild failure modes

| Symptom | Real cause |
|---|---|
| "Looks right" but diverges in production | edge-case matrix was never filled in |
| Rebuild is slow where original is fast | non-functional behaviour never got spec'd |
| Constant small UI mismatches | spec leaked visual detail, or designer peeked at the original |
| Wire protocol won't interop | protocol was inferred from one sample, not triangulated |
| Spec is unimplementable | still contains implementation detail — rewrite as observable behaviour |
| AI-generated code reproduces original structure suspiciously closely | original artifacts were in the model's context. Contamination — freeze, purge, re-spec |

---

## What "done" looks like

You can hand `06-clean-room-spec.md` plus the rebuild to an engineer who has never seen the target, they
read the spec, run the differential tests, and agree the rebuild does what the spec says. Nothing in the
chain requires them to look at the original.
