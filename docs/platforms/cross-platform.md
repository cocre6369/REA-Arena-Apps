# Flutter & React Native playbook

Detect first — `python3 scripts/identify.py` does this automatically — then follow the right branch.

| Fingerprint | Framework |
|---|---|
| `lib/*/libapp.so` + `lib/*/libflutter.so`, `assets/flutter_assets/` | Flutter (AOT release) |
| `assets/index.android.bundle` | React Native |
| Bundle starts with `c6 1f bc 1e` | RN compiled to Hermes bytecode |
| `assets/index.android.bundle` is readable JS | RN without Hermes (older apps) |

---

## Flutter

### Debug vs release

| Build | Compilation | Output | RE difficulty |
|---|---|---|---|
| Debug | JIT | Kernel AST — high-level Dart IR | Near-source recovery |
| Release | AOT | `libapp.so` — native code + heap snapshot | Harder, but blutter/reFlutter work well |

[5](https://nerdzlab.com/reverse-engineering-a-flutter-app-how-secure-is-your-data-really/)

### Static

```bash
unzip -o app.apk 'lib/arm64-v8a/*' -d native/
python3 blutter.py native/lib/arm64-v8a output_dir      # fetches the matching Dart SDK itself
```

Output worth reading:

- `asm/` — every library including the Flutter framework, **with original naming from development**, in
  annotated assembly
- the object pool — **every hardcoded string**, including API hosts and keys

If the app *is* obfuscated, class and function names are gone but the object pool strings survive, which
is usually enough to locate the interesting code
[5](https://nerdzlab.com/reverse-engineering-a-flutter-app-how-secure-is-your-data-really/).

`reFlutter` is the alternative — it also patches the binary to make it proxy-friendly.

### Dynamic

Flutter doesn't use the platform TLS stack, so system-level proxying and some pinning hooks behave
differently. Options:

- `reFlutter` patched build — routes traffic through your proxy by patching the flutter engine
- Hook the Dart `HttpClient` certificate callback (`badCertificateCallback`) via Frida at the native level
- Fall back to passive DNS/log observation if interception proves too costly

---

## React Native

### Case A — plain JS bundle (no Hermes)

You got lucky. It's minified JS:

```bash
npx prettier --write assets/index.android.bundle
# then it's a Metro bundle: use the web playbook's debundling tools
npx webcrack index.android.bundle -o out/
```

### Case B — Hermes bytecode

```bash
file assets/index.android.bundle
# Hermes JavaScript bytecode, version 96
```

Check the HBC version **before** choosing a tool — most lag the current version
[1](https://pilfer.github.io/mobile-reverse-engineering/react-native/reverse-engineering-and-instrumenting-react-native-apps/).

| Tool | Strength |
|---|---|
| Bytecode Studio | Most complete: disassembler, decompiler, xrefs, hex/bytecode views, Metro module visualisation |
| `hermes-decomp` | `info` / `disasm` / `decompile` / `tui` / `xref` / `callgraph` / `secrets`; splits Metro modules into separate files [2](https://github.com/keithcsqueensu/hermes-decomp) |
| `hermes-dec` | Good disassembler; decompiler less complete |
| `hbctool`, `hasmer`, `hermes_rs` | Disassemble **and reassemble** (for patching); verify HBC version support |

```bash
hermes-decomp info app.hbc                       # version + module count
hermes-decomp decompile app.hbc -o out.js
hermes-decomp xref app.hbc --query "loginWithToken"
hermes-decomp secrets app.hbc
```

Expect the decompiled JS to be approximate. Where it's unreadable, lean on dynamic analysis instead —
Hermes apps are *very* easy to instrument, which is the standard fallback
[4](https://www.reddit.com/r/reactnative/comments/1kaj6np/is_there_a_way_to_decompile_reverse_engineer_an/).

### Dynamic (the reliable route for RN)

Inject into the RN global context with Frida — hook `onPress` events, enumerate Metro modules at runtime,
and read the JS heap directly. Runtime instrumentation sidesteps the bytecode problem entirely
[1](https://pilfer.github.io/mobile-reverse-engineering/react-native/reverse-engineering-and-instrumenting-react-native-apps/).

---

## Shared advice

- **Assets are a goldmine in both.** `flutter_assets/` and RN's `assets/` + `res/` contain images, JSON
  config, fonts, and often a full route/feature list.
- Both ship a Metro/snapshot **module table**. Splitting it into per-module files turns an unreadable
  blob into a navigable codebase — do this first.
- MobSF will do a decent automated first pass on either, and will also tell you which framework it is.
- Don't fight the decompiler. If the decompiled output is nonsense, get the same answer from traffic +
  Frida in a fraction of the time.
