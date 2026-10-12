# Methodology — Reverse Engineer → Decompile → Rebuild

The whole job is: **turn an opaque artifact into a specification, then write new code from the
specification.** Decompilation is a means of *reading*, never a source of code to copy.

```
        ┌────────────┐
        │  TARGET    │  apk / ipa / web / binary
        └─────┬──────┘
              │
   ┌──────────▼───────────┐
   │ P0  SCOPE & LEGAL    │  lawful access? purpose? clean-room wall?
   └──────────┬───────────┘
   ┌──────────▼───────────┐
   │ P1  TRIAGE           │  identify, hash, fingerprint, provenance
   └──────────┬───────────┘
   ┌──────────▼───────────┐
   │ P2  STATIC           │  decompile / disassemble / resources / strings
   └──────────┬───────────┘
   ┌──────────▼───────────┐
   │ P3  DYNAMIC          │  run it: traffic, Frida hooks, storage, logs
   └──────────┬───────────┘
   ┌──────────▼───────────┐
   │ P4  BEHAVIOUR SPEC   │  screens, flows, API, data model, states
   └──────────┬───────────┘
   ┌──────────▼───────────┐   ← the wall: only docs cross this line
   │ P5  CLEAN-ROOM SPEC  │  functional requirements, zero expression
   └──────────┬───────────┘
   ┌──────────▼───────────┐
   │ P6  REBUILD + DIFF   │  independent impl, differential testing
   └──────────────────────┘
```

---

## P0 — Scope, legal, and the clean-room wall

Decide before touching anything: is this for **interoperability / learning / security research**, or is it
a clone-for-release? The method differs mainly in how much documentation discipline you need.

The clean-room model has two roles [5](https://github.com/Kyvero-Vexus/clean-room-reverse-engineering/blob/master/2026-03-21-clean-room-reverse-engineering-complete-writeup-v1.md):

- **Analysis side (tainted):** observes the target, writes *functional* specifications.
- **Implementation side (clean):** builds from the spec only, never saw the original.

The wall exists because copyright protects expression, not function — an independent reimplementation of
behaviour is a distinct work [2](https://news.ycombinator.com/item?id=30699165). The classic case law
(*Sega v. Accolade*, *Sony v. Connectix*) blesses disassembly and intermediate copying for
interoperability, provided the final product carries no protected expression
[1](https://www.ntari.org/post/how-clean-room-reverse-engineering-built-the-modern-tech-industry).
Two caveats worth internalising: the wall is **not** a shield if protected expression does leak through,
and it does nothing against non-copyright claims (trade secret, contract/ToS, DMCA §1201
anti-circumvention) [4](https://www.beankinney.com/news-and-insights/blogs/512000-lines-one-night-zero-permission-the-claude-code-leak-and-the-legal-crisis-of-ai-clean-rooms/).

**Non-negotiables for this repo:**

- No original source, layout XML, images, strings, fonts, icons, or audio in the output tree.
- No copying of creative copy — marketing text, error-message wording, iconography, sound.
- Behaviour that is *technically necessary* to interoperate (wire format, protocol, file format) is
  spec'd; behaviour that is *expressive* is redesigned.
- Every artifact gets an evidence-log row: who obtained it, how, when, legal basis.

→ [`docs/00-legal-and-scope.md`](docs/00-legal-and-scope.md)

---

## P1 — Triage: what am I holding?

Never start by decompiling. Start by *identifying*, so you pick the right tools and don't waste hours.

```bash
python3 scripts/identify.py target.bin
```

Answers: file class (APK / IPA / DEX / ELF / Mach-O / PE / .NET / Hermes / JS bundle / zip),
hashes, size, architecture, and — for containers — the internal layout that reveals the framework
(`libapp.so` → Flutter, `index.android.bundle` → React Native, `classes.dex` → native Android, etc.).

Record hashes in the evidence log before anything modifies the file.

→ [`docs/01-triage.md`](docs/01-triage.md)

---

## P2 — Static analysis: read it

Layer by layer, cheapest first:

1. **Manifest / metadata** — `AndroidManifest.xml`, `Info.plist`, `package.json`, PE headers,
   `.nuspec`. Permissions and declared components are the roadmap: an app requesting
   `ACCESS_FINE_LOCATION` that claims to be a news reader is your first finding
   [2](https://www.kunalganglani.com/blog/reverse-engineering-android-apk).
2. **Resources** — layouts, strings, plists, assets. This alone often yields the full screen list.
3. **Strings** — hardcoded endpoints and keys live here.
   `python3 scripts/stringscan.py extracted/ -o cases/app/02-surface-map.md`
4. **Decompile / disassemble** — jadx for DEX, Ghidra/Hopper for Mach-O/ELF, dnSpyEx/ILSpy for .NET,
   webcrack for JS, blutter for Flutter.
5. **Native libs** — `lib/*/*.so`; only go here when the answer isn't in the managed layer.

Read with a hypothesis list, not linearly: *where is auth? where is the API base URL built? what is
cached locally? what decides premium vs free?* Write each as
**(where) → (what) → (how to confirm)** [5](https://github.com/h0tak88r/Sec-88/blob/main/ios-appsec/ios-reverse-engineering.md).

→ [`docs/02-static-analysis.md`](docs/02-static-analysis.md)

---

## P3 — Dynamic analysis: watch it

Static tells you what the code says; dynamic tells you what it *does*. This is where the spec gets its
ground truth, and it's also the layer that survives obfuscation.

| Goal | Tool | Notes |
|---|---|---|
| HTTP(S) traffic | mitmproxy / Burp / Charles | capture as HAR, this becomes the API surface |
| TLS pinning | Frida / objection | hook `checkServerTrusted` / `CertificatePinner` / `NSURLSession` delegates [2](https://dev.to/deepak_mishra_35863517037/bypassing-ssl-pinning-with-frida-advanced-mobile-scraping-54cl) |
| Method tracing | `frida-trace`, objection | confirm a hypothesis from static analysis |
| Local storage | objection, adb, sqlite | reconstruct the data model from what's persisted |
| Keychain / keystore | objection `keychain dump` | credential handling |
| Failure states | proxy block-list + breakpoints | how does it behave when the API returns 500 / empty / huge? |

Order of preference: **observe → instrument → patch.** Patching is the most invasive and the most likely
to break things; only do it when needed to answer a specific question
[1](https://yarygintech.com/articles/android-traffic-analysis-charles-frida/).

→ [`docs/03-dynamic-analysis.md`](docs/03-dynamic-analysis.md)

---

## P4 — Behaviour spec (black box → blueprint)

This is the phase people skip, and it's the one that determines whether the rebuild works.

Four habits from the *Black Box to Blueprint* work [3](https://martinfowler.com/articles/black-box-to-blueprint.html):

1. **Start where visibility is highest** — screens, schemas, logs, store listing. Cheap, trusted, and it
   anchors everything else.
2. **Enrich in passes** — don't feed the whole system to one analysis. Extract partial insights, then
   layer.
3. **Triangulate everything** — no behaviour enters the spec on one artifact alone. Screen flow matched
   against traffic, validated against a call tree.
4. **Preserve lineage** — every claim points at the evidence that produced it. When something turns out
   to be wrong you can trace it back.

Produce, in order:

- **Screen inventory** — every screen, its states (empty / loading / error / populated / offline), and
  transitions. Walk the app like a user and record it.
- **API surface** — from captured traffic: method, path, headers, auth, request shape, response shape,
  error codes, pagination, rate limits. Replay with `curl` to confirm each one.
- **Data model** — entities, fields, types, where they live (server / sqlite / keychain / localStorage),
  and the sync story.
- **Edge-case matrix** — what happens on empty, huge, malformed, offline, expired-token, concurrent edit.

The Thoughtworks team found that walking click-paths once gives you a suspiciously clean "happy path";
you have to traverse deliberately, repeat the walk several times (each run finds different branches), and
then *converge* the runs into one map [1](https://www.thoughtworks.com/en-us/insights/blog/generative-ai/blackbox-reverse-engineering-ai-rebuild-application-without-accessing-code).
Same applies to a human doing it.

→ [`docs/04-blackbox-to-blueprint.md`](docs/04-blackbox-to-blueprint.md)

---

## P5 — Clean-room spec

Rewrite everything from P4 as functional requirements. The test: **could someone who has never seen the
original build from this, without asking a question?** If the spec says "sorts in place", fine. If it
quotes the original's error string, it's contaminated.

Structure:

- Purpose and scope (what is in, what is explicitly out)
- Personas / states
- Each screen: purpose, inputs, outputs, states, transitions, edge cases
- Each operation: preconditions, steps, postconditions, failure modes
- Data model with types and constraints
- Non-functionals that are observable: latency budget, offline behaviour, accessibility
- Explicitly **not** specified: visual design, copy, iconography — those are new work

→ [`docs/05-clean-room-spec.md`](docs/05-clean-room-spec.md)

---

## P6 — Rebuild and verify

1. **Pick the stack on merit**, not on mimicry. You're reimplementing behaviour, not the original's
   framework choice — unless interoperability requires matching it.
2. **Build against mocks first.** Replay captured traffic as fixtures (MSW / json-server / recorded HAR)
   so the build never depends on the target's live backend
   [4](https://www.quora.com/How-can-I-reverse-engineer-a-website-built-on-HTML-CSS-JS).
3. **Differential test.** Drive original and rebuild with the same inputs, compare outputs:
   screens, status codes, edge-case matrix rows, and (for protocol-level clones) byte-level wire format.
4. **Prototype as validator.** Building is the fastest way to find holes in the spec — every ambiguity
   you hit while implementing is a spec defect
   [1](https://www.thoughtworks.com/en-us/insights/blog/generative-ai/blackbox-reverse-engineering-ai-rebuild-application-without-accessing-code).
   Fix the spec, not just the code.

→ [`docs/06-rebuild-and-verify.md`](docs/06-rebuild-and-verify.md)

---

## Anticipate these failure modes

| Symptom | Usual cause |
|---|---|
| Decompiler output won't compile / is full of `goto` | obfuscation or unsupported bytecode version — downgrade to disassembly, lean on dynamic |
| Traffic invisible | TLS pinning, custom protocol, or cert transparency — proxy + Frida, or read the network code statically |
| App won't run after patching | register count / signature check / anti-tamper — prefer runtime hooks over file patches |
| Rebuild "looks right" but diverges | spec was written from the happy path — go back and do the edge-case matrix |
| Spec is unimplementable | it still contains implementation detail — rewrite as observable behaviour |
