# P2 — Static analysis: reading the artifact

Read in **cheapest-first** order. Most of what you need for a behaviour spec is in layers 1–3; the
disassembler is for the 10% of questions that survive them.

---

## Layer 1 — Manifest and metadata (minutes, enormous yield)

| Platform | File | What it gives you |
|---|---|---|
| Android | `AndroidManifest.xml` | permissions, activities, services, receivers, deep links, `networkSecurityConfig`, `debuggable` |
| iOS | `Info.plist` | URL schemes, `NSAppTransportSecurity`, background modes, permissions strings |
| iOS | `embedded.mobileprovision` | entitlements, team ID, capabilities |
| Web | `package.json`, `index.html`, `__NEXT_DATA__`, meta tags | framework, routes, build config |
| .NET | PE headers + CLI metadata + `.nuspec` | assemblies, target framework, dependencies |
| Linux | ELF dynamic section, `.comment` | linked libs, compiler, build ID |

The manifest is the roadmap: what the app *declares* it does versus what it *says* it does is often the
first real finding [2](https://www.kunalganglani.com/blog/reverse-engineering-android-apk).

## Layer 2 — Resources

Layouts, storyboards, XIBs, string tables, Drawable assets, `res/values/strings.xml`, `Localizable.strings`.
A full pass over the string tables alone usually reconstructs 80% of the screen inventory and the entire
copy tone — which you then **do not copy**, but do use to name features in the spec.

## Layer 3 — Strings and secrets

```bash
python3 scripts/stringscan.py extracted/ -o cases/<app>/02-surface-map.md
```

Flags: URLs and API hosts, `api_key`/`secret`/`token`/`password` assignments, JWTs, AWS keys, private key
blocks, hardcoded IPs, third-party SDK hosts, telemetry endpoints, debug flags.

Expect false positives; the point is a *candidate list* to verify in Layer 5. Note that any credential
found belongs to the app's vendor — finding it is a reportable vulnerability, not something to use.

## Layer 4 — Decompile / disassemble

| Target | Read | Patch |
|---|---|---|
| Android DEX | `jadx-gui` (best navigation + full-text search), `jadx --deobf` for ProGuard-renamed identifiers | `apktool d` → smali → edit → `apktool b` → `apksigner` |
| iOS Mach-O | `ipsw class-dump --headers`, `ipsw swift-dump --demangle`; Ghidra/Hopper for the logic | insert dylib / patch + re-codesign |
| .NET | dnSpyEx (read **and** edit method bodies in C#, save the module), ILSpy + `ilspycmd` | dnSpyEx `File → Save Module` |
| Web JS | `webcrack` (deobfuscate + unpack webpack/browserify), `bundle-breaker` (debundle → per-module files + dependency graph), `shuji`/`sourcemapper` for sourcemaps | local copy + overrides |
| Flutter | `blutter` → `asm/` with original Dart names | reFlutter |
| RN Hermes | `hermes-dec` / `hermes-decomp` / Bytecode Studio | hbctool / hasmer |

Useful flags, Android [1](https://robinx0.github.io/blogs/mobile-security/apk-reverse-engineering/):

```bash
jadx --no-debug-info --show-bad-code -d out/ app.apk   # keep going past errors
jadx --deobf --deobf-min 3 --deobf-rewrite-cfg -d out/ app.apk
jadx --classes-only -d out/ app.apk                    # fast pass on huge apps
apktool d app.apk -o work/                             # smali + decoded resources
```

For Hermes, verify ahead of time which bytecode version you have — most tools lag the current HBC version
[1](https://pilfer.github.io/mobile-reverse-engineering/react-native/reverse-engineering-and-instrumenting-react-native-apps/).

## Layer 5 — Native libraries

Only when the answer isn't in the managed layer (custom crypto, DRM, anti-tamper, licence checks).

```bash
unzip app.apk 'lib/arm64-v8a/*' -d native/
file native/lib/arm64-v8a/libnative.so
r2 -A native/lib/arm64-v8a/libnative.so   # or Ghidra / Binary Ninja / IDA
```

---

## How to actually read it

Don't read linearly — apps are millions of lines. Work a **hypothesis list**, written as
**(where) → (what) → (how to confirm)** [5](https://github.com/h0tak88r/Sec-88/blob/main/ios-appsec/ios-reverse-engineering.md):

> `AuthViewModel.login()` reads credentials from the text fields then calls `NetworkClient.sendAuth()` —
> confirm by capturing the login request and checking whether credentials go in plaintext.

Standard hypotheses to start with:

- Where is auth, and how is the token stored and refreshed?
- How is the API base URL constructed? Is there a staging/prod switch?
- What is cached locally, in what store, with what invalidation?
- What gates premium vs free — a local boolean, or a server response?
- What happens on first launch, on upgrade, on logout, on token expiry?
- Which third-party SDKs receive user data, and is that disclosed?

## Triaging obfuscated output

| Symptom | Move |
|---|---|
| Identifiers are `a`, `b`, `c1` | rename as you understand them *in your notes*; map by call graph, not by name |
| Control flow is flattened / opaque predicates | stop trying; confirm behaviour dynamically instead |
| Strings are encrypted | hook the decrypt routine with Frida and dump at runtime |
| Decompiler emits garbage | drop to disassembly, or to dynamic — the decompiler is not the source of truth |
| Packed binary (UPX, custom) | dump the unpacked image from memory rather than fighting the packer |

## Output

`cases/<app>/02-surface-map.md`: endpoints, hosts, SDK inventory, permissions, secrets found (as
*findings to report*, not to reuse), interesting classes/methods with file:line pointers, and open
questions for the dynamic phase.
