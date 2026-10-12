# P1 — Triage: identify before you decompile

Goal: in ~5 minutes know exactly what class of artifact you hold, what toolchain it needs, and record
provenance so later work is defensible.

---

## 0. Acquire lawfully

| Platform | How |
|---|---|
| Android (device) | `adb shell pm list packages` → `adb shell pm path <pkg>` → `adb pull <path>` [2](https://www.kunalganglani.com/blog/reverse-engineering-android-apk) |
| Android (no device) | APKMirror / APKPure — verify the SHA-256 against a second source if it matters |
| iOS (jailbroken) | `frida-ios-dump` to get a *decrypted* IPA [3](https://dipendrasharma.com/articles/mobile-dev-tools/) |
| iOS (not jailbroken) | App Store packages are FairPlay-encrypted; you must dump from a running process or use a jailbreak |
| Web | Just the URL. DevTools → Network → **Save all as HAR** is your first artifact |
| Windows / macOS | The installed `.exe` / `.app` bundle; check for a `.pdb` alongside (free symbols) |
| Linux | The package, or `/proc/<pid>/maps` + `dd` for a running process |

## 1. Fingerprint

```bash
python3 scripts/identify.py <artifact-or-url>
```

Pure-stdlib, no toolchain needed. Reports:

- size + SHA-256 + SHA-1 + MD5
- file class by magic bytes (ZIP/APK/IPA, DEX, ELF, Mach-O, PE, .NET, Hermes HBC, WASM, Java class, …)
- architecture / bitness / endianness for native binaries
- for containers: internal layout + framework fingerprints
- first-pass interest list: manifests, native libs, bundles, sourcemaps

### Framework fingerprints (what the layout tells you)

| Found inside | Means | Playbook |
|---|---|---|
| `classes*.dex` | Native Android (Java/Kotlin) | [android](platforms/android.md) |
| `lib/arm64-v8a/libapp.so` **+** `libflutter.so` | Flutter AOT release | [cross-platform](platforms/cross-platform.md) |
| `assets/index.android.bundle` | React Native | [cross-platform](platforms/cross-platform.md) |
| `assets/flutter_assets/` | Flutter | [cross-platform](platforms/cross-platform.md) |
| Hermes magic `c6 1f bc 1e` at bundle start | RN + Hermes bytecode | [cross-platform](platforms/cross-platform.md) |
| `Payload/*.app/` | iOS | [ios](platforms/ios.md) |
| `.exe`/`.dll` with CLI metadata (`BSJB`) | .NET | [desktop](platforms/desktop.md) |
| `webpackJsonp`, `webpackChunk`, `self.__next_f` | Webpack / Next.js | [web](platforms/web.md) |

## 2. Record provenance

Append a row to `cases/<app>/01-evidence-log.csv` for **every** artifact before you modify anything:

```csv
2026-10-12T09:15Z,agent,apk,SomeApp-4.2.1.apk,sha256:ab12…,"downloaded from vendor site, lawful user",triage,
```

Fields: timestamp, actor, type, name, hash, **legal basis**, purpose, resulting artifact.

## 3. Snapshot the obvious metadata

Cheap, high-yield, zero tooling:

- **Store listing** — screenshots, description, permissions, version, size, ratings, changelog. The
  screenshot set is a free screen inventory; the 1★ reviews are a free edge-case list.
- **Public docs** — developer site, help centre, changelog, API docs, status page.
- **Third-party detection** — what SDKs / analytics / CDN is it known to use.

## 4. Write `00-triage.md`

```markdown
# Triage — <App> <version>

- Artifact: <filename>
- SHA-256: <hash>
- Origin: <how obtained, legal basis>
- Size / arch / min OS:
- Framework: <native Android | Flutter | RN | iOS native | web | .NET | other>
- Obfuscation: <none | ProGuard/R8 | commercial obfuscator | Hermes bytecode | packed>
- Protections spotted: <root/jailbreak detect, pinning, anti-tamper, integrity check>
- Toolchain I'll need: <...>
- Open questions: <...>
```

---

## Escalation ladder

Only climb as far as the question requires:

1. Store page + public docs (zero risk)
2. Run it, observe (traffic, storage, logs)
3. Static: resources and strings
4. Static: decompile / disassemble
5. Dynamic: instrument (Frida, debugger)
6. Dynamic: patch and re-sign (most invasive — changes the artifact, may trip anti-tamper)

Log which rung you used for each finding. It's the difference between "we looked at public behaviour" and
"we modified their binary", and it matters if anyone ever asks.
