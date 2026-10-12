# P4 — Black box to blueprint: the behaviour spec

This is the phase that decides whether the rebuild works. Decompilation gives you *code*; this phase
gives you *intent*, which is the only thing you're allowed to carry across the wall.

Four habits, from the *Black Box to Blueprint* work [3](https://martinfowler.com/articles/black-box-to-blueprint.html):

| Habit | Why |
|---|---|
| **Start where visibility is highest** | Screens, schemas, logs, store listing are cheap and trusted; they anchor everything downstream and avoid analysis paralysis |
| **Enrich in passes** | Don't hand the whole system to one analysis pass. Partial insights, layered — cuts hallucination and scales |
| **Triangulate everything** | No behaviour enters the spec on one artifact. Two independent sources minimum (screen + traffic, flow + call tree) |
| **Preserve lineage** | Every claim points at its evidence. When something is wrong you can trace it back |

---

## Deliverable 1 — Screen inventory (`04-screen-inventory.md`)

Walk the app like a user. For every screen:

```markdown
### Screen: <name>
- Entry points: <tab bar | push from X | deep link app://…>
- Purpose: <one line>
- States: empty | loading | populated | partial | error | offline | permission-denied
- Data shown: <fields, with source — which endpoint / which local store>
- Actions: <each control → what it does → what it calls>
- Transitions: <action → destination>
- Edge cases: <what it does on 0 items / 10k items / expired token / offline>
- Evidence: <har:# | screenshot | class:line>
```

**Do one pass per area, then repeat the walk.** A single traversal produces a suspiciously clean happy
path; each repeat surfaces different branches
[1](https://www.thoughtworks.com/en-us/insights/blog/generative-ai/blackbox-reverse-engineering-ai-rebuild-application-without-accessing-code).
Then **converge**: diff the runs, resolve discrepancies, and produce one consolidated flow map with the
branches merged in.

Deliverable includes a flow diagram (Mermaid is fine) of the navigation graph.

## Deliverable 2 — API surface (`03-api-surface.yaml`)

Reconstructed from traffic, then **verified by replay**. For each endpoint:

```yaml
- id: get_feed
  method: GET
  path: /v2/feed
  auth: bearer               # observed: Authorization: Bearer <jwt>
  query: { cursor: string, limit: int }
  headers: { X-Client-Version: string, Accept-Encoding: gzip }
  response_200: { items: [FeedItem], next_cursor: string|null }
  errors: { 401: token_expired, 429: rate_limited }
  pagination: cursor, opaque
  observed_on: [HomeScreen first paint, pull-to-refresh]
  evidence: captured/session1.har#req-42
```

Verify each one by replaying out of band (`curl` / `httpie` / Postman) — that's how you learn which
headers are actually required versus merely sent, and it surfaces hidden fields
[4](https://www.quora.com/How-can-I-reverse-engineer-a-website-built-on-HTML-CSS-JS).

**Do this against a throwaway test account.** Never hammer a production service you don't own; rate-limit
yourself and stop at the first sign of trouble.

## Deliverable 3 — Data model (`05-data-model.md`)

Entities, fields, types, constraints. Triangulate three ways:

1. **Wire** — response shapes from the traffic capture.
2. **Local** — what's actually persisted (sqlite schema, Realm/Core Data model, IndexedDB object stores).
3. **Code** — deserialised model classes / serializers.

For each entity: where it lives (server-only / cached / local-first), the sync story (poll / push / manual
refresh), conflict handling, and retention.

## Deliverable 4 — Edge-case matrix

The highest-value artifact in the whole pipeline — it's where rebuilds actually diverge.

| Scenario | Expected behaviour | Evidence | Rebuild status |
|---|---|---|---|
| Empty list | illustration + "nothing here yet" | screenshot | ☐ |
| 10k items | virtualised, still 60fps | measured | ☐ |
| Token expired mid-session | silent refresh, retry once | har:#req-88 | ☐ |
| Offline, cached data | show stale + offline banner | observed | ☐ |
| Offline, no cache | full-page error + retry | observed | ☐ |
| Malformed JSON | ??? — test it | — | ☐ |
| Concurrent edit | last-write-wins? conflict UI? | ??? | ☐ |

Generate scenarios from: **empty / one / many / too many**, **valid / invalid / malformed / hostile**,
**online / slow / offline**, **fresh / stale / expired**, **first-run / upgrade / logout / delete-account**.

---

## Confidence marking

Every line in these deliverables carries a marker, and nothing crosses into the clean-room spec at
`unverified`:

| Marker | Meaning |
|---|---|
| `confirmed` | observed directly, ≥2 independent sources |
| `inferred` | strong single source + consistent with everything else |
| `unverified` | plausible, not tested — **must be tested or dropped before P5** |

## The rule

> **Don't try to recover the code — reconstruct the functional intent.**
> [3](https://martinfowler.com/articles/black-box-to-blueprint.html)

Anything in your notes that only makes sense to someone who has seen the original source is
implementation detail, and it does not cross the wall.
