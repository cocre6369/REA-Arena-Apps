# Clean-room specification — {{APP}}

> **THE WALL.** Nothing in this document may contain expression from the original: no source, no layout
> files, no strings, no copy, no assets, no internal names, no architecture.
> It must be implementable by someone who has never seen the target, with no clarifying questions.

- Status: DRAFT
- Derived from: `04-screen-inventory.md`, `03-api-surface.yaml`, `05-data-model.md`
- Date: {{DATE}}

---

## 1. Purpose and scope

**What the system does:**

**In scope:**

**Explicitly out of scope** (and why):

**Interoperability requirements** (wire formats / file formats that MUST match, and why):

> Only include protocol details here where matching them is technically necessary. Write the
> justification down.

## 2. Actors and states

| Actor | Capabilities |
|---|---|
|  |  |

| State | Enters when | Exits when |
|---|---|---|
| anonymous |  |  |
| authenticated |  |  |
| offline |  |  |

## 3. Screens

### Screen: <name>

**Purpose:**
**Entry points:**
**Inputs:**
**Outputs:**
**States:**

| State | Condition | Presentation requirement |
|---|---|---|
| loading | request in flight |  |
| empty | zero records |  |
| populated | ≥1 record |  |
| error | request failed |  |
| offline | no connectivity |  |

**Transitions:**

| Trigger | Destination | Preconditions |
|---|---|---|
|  |  |  |

**Edge cases:** (from the matrix in `04-screen-inventory.md` — each must be answered here)

| Scenario | Required behaviour |
|---|---|
| empty |  |
| very large |  |
| malformed input |  |
| offline, cached |  |
| offline, no cache |  |
| expired session |  |

## 4. Operations

### Operation: <name>

- **Preconditions:**
- **Steps:**
  1.
- **Postconditions:**
- **Failure modes:**

| Failure | Required behaviour | User-visible? |
|---|---|---|
|  |  |  |

## 5. Data model

(Behavioural view: entities, fields, types, constraints, lifecycle. Diagram optional but useful.)

| Entity | Field | Type | Required | Constraints | Storage tier |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## 6. Interface contracts

(Only where interoperability requires an exact match.)

| Direction | Contract | Justification for matching exactly |
|---|---|---|
|  |  |  |

## 7. Non-functional requirements (observable only)

| Requirement | Target | How it was measured |
|---|---|---|
| Time to interactive on a cold start |  |  |
| List scroll with 10k records |  |  |
| Offline read of cached data |  |  |
| Accessibility |  |  |
| Data retention |  |  |

## 8. Explicitly unspecified

These are new work in the rebuild and must NOT be sourced from the target:

- Visual design, layout, and visual hierarchy
- Copy, labels, error-message wording, tone of voice
- Iconography, illustration, typography, animation, sound
- Branding and naming

---

## Review checklist (all boxes before implementation starts)

- [ ] Every requirement is stated as **observable behaviour**, not as an implementation instruction
- [ ] Zero original strings, names, copy, or structural details present
- [ ] Every requirement traces back to evidence in `04-*`
- [ ] No `unverified` items carried over — each was tested or dropped
- [ ] Wire formats included are justified by interoperability necessity, in writing
- [ ] A reader who has never seen the target can build from this cold
- [ ] Section 8 is explicit that visual design and copy are new work
