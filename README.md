# REA-Arena-Apps

**R**everse **E**ngineering **A**rena — a working toolkit for taking an existing app apart and rebuilding it as an independent implementation.

This repo contains both a reusable reverse-engineering methodology and **Chroma Studio**, an independent image-editor prototype in [`apps/studio`](apps/studio). The app is not Photoshop and does not claim feature parity. It uses original code and graphics; it does not include Adobe assets or code.

The toolkit workflow is in [`METHODOLOGY.md`](METHODOLOGY.md); case results live in `cases/<app-slug>/`.

---

## Chroma Studio (Windows / browser)

Open the browser preview with `node apps/studio/tools/serve.cjs` and visit `http://localhost:4173`.
For a Windows `.exe`, the [Windows build workflow](.github/workflows/chroma-windows.yml) publishes a portable and installer executable as a downloadable GitHub Actions artifact on this branch (GitHub sign-in may be required). See [`apps/studio/README.md`](apps/studio/README.md) for the actual implemented features, limitations and build instructions. Windows builds are unsigned and may show a SmartScreen warning.

---

## The pipeline in one line

**Triage → Static RE → Dynamic RE → Behaviour spec → Clean-room spec → Rebuild → Differential test**

| Phase | Question it answers | Doc |
|---|---|---|
| 0 | Are we allowed to, and how do we stay clean? | [`docs/00-legal-and-scope.md`](docs/00-legal-and-scope.md) |
| 1 | What *is* this artifact? | [`docs/01-triage.md`](docs/01-triage.md) |
| 2 | What does the code say? | [`docs/02-static-analysis.md`](docs/02-static-analysis.md) |
| 3 | What does it actually *do* at runtime? | [`docs/03-dynamic-analysis.md`](docs/03-dynamic-analysis.md) |
| 4 | What is the behaviour, independent of code? | [`docs/04-blackbox-to-blueprint.md`](docs/04-blackbox-to-blueprint.md) |
| 5 | What exactly are we building? | [`docs/05-clean-room-spec.md`](docs/05-clean-room-spec.md) |
| 6 | How do we prove the rebuild matches? | [`docs/06-rebuild-and-verify.md`](docs/06-rebuild-and-verify.md) |

---

## Quick start

```bash
# 1. see what tools you have / install what you can
./scripts/env-setup.sh --check

# 2. open a case for the target app
./scripts/rekit new "Some App" --platform auto

# 3. fingerprint whatever binary/URL you have
python3 scripts/identify.py path/to/app.apk            # or .ipa / .exe / bundle.js / .so
python3 scripts/identify.py https://app.example.com    # web target: fetches + fingerprints

# 4. triage scan for endpoints, keys, third-party SDKs
python3 scripts/stringscan.py cases/some-app/artifacts -o cases/some-app/02-surface-map.md
```

Everything a case produces lands in a predictable place:

```
cases/<app-slug>/
├── 00-triage.md            # what the artifact is, hashes, provenance
├── 01-evidence-log.csv     # every artifact + where it came from (legal provenance)
├── 02-surface-map.md       # endpoints, SDKs, secrets, permissions
├── 03-api-surface.yaml     # reconstructed wire protocol
├── 04-screen-inventory.md  # every screen, state, transition
├── 05-data-model.md        # entities, fields, storage, sync
├── 06-clean-room-spec.md   # the buildable spec  ← handed to implementation
├── artifacts/              # raw binaries (gitignored)
├── extracted/              # decompiled / disassembled output (gitignored)
└── captured/               # traffic, screenshots, recordings (gitignored)
```

---

## Platform playbooks

| Target | Go-to tools | Notes |
|---|---|---|
| Android (`apk`, `aab`) | jadx, apktool, MobSF, Frida | [`docs/platforms/android.md`](docs/platforms/android.md) |
| iOS (`ipa`) | ipsw, class-dump, Ghidra, Frida, objection | [`docs/platforms/ios.md`](docs/platforms/ios.md) |
| Web / SPA | DevTools, webcrack, bundle-breaker, HAR, mitmproxy | [`docs/platforms/web.md`](docs/platforms/web.md) |
| Flutter / React Native | blutter, reFlutter, hermes-dec, Bytecode Studio | [`docs/platforms/cross-platform.md`](docs/platforms/cross-platform.md) |
| Desktop (Win/macOS/Linux) | dnSpyEx, ILSpy, Ghidra, x64dbg, ltrace/strace | [`docs/platforms/desktop.md`](docs/platforms/desktop.md) |

Full install list: [`docs/toolchain.md`](docs/toolchain.md)

---

## Ground rules

1. **Behaviour, not bytes.** The deliverable is a *specification of behaviour* and an independent
   implementation of it. Original source, assets, and resources never land in the rebuild.
2. **Triangulate or it doesn't count.** No behaviour goes in the spec on the strength of one artifact.
   Two independent sources (UI + traffic + binary call tree) or it's marked unconfirmed.
3. **Lineage always.** Every claim carries a pointer to the evidence that produced it.
4. **Least invasive method first.** Store page → public docs → traffic → static → dynamic → patching.
   Only escalate when the cheaper layer can't answer the question.

Legal framing and the clean-room protocol: [`docs/00-legal-and-scope.md`](docs/00-legal-and-scope.md).
