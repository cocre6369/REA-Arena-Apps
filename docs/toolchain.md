# Toolchain

Install: `./scripts/env-setup.sh` (checks what's present, then installs what it can).

---

## Universal (every case)

| Tool | Use | Install |
|---|---|---|
| `python3` 3.9+ | the scripts in this repo | system |
| `node` 22+ | webcrack, bundle-breaker, web tooling | system |
| `git` | everything | system |
| `jq`, `sqlite3` | JSON and database inspection | apt |
| `mitmproxy` | traffic capture, HAR export, scripted interception | `pipx install mitmproxy` |
| Ghidra | native decompiler (ELF, Mach-O, PE) | github release + JDK |
| radare2 / r2 | quick native disassembly | apt / source |
| `binwalk`, `xxd`, `file` | container and format triage | apt |
| `strings` + `scripts/stringscan.py` | secret and endpoint sweep | binutils + this repo |
| MobSF | automated Android/iOS static report, good first pass | docker |

## Android

| Tool | Use | Install |
|---|---|---|
| `jadx` / `jadx-gui` | DEX → Java. Best navigation and full-text search | github release |
| `apktool` | decode to smali + resources; rebuild after edits | github release |
| `apksigner`, `zipalign` | sign v2/v3, align | Android SDK build-tools |
| `adb` | pull the APK off a device, install, run | Android SDK platform-tools |
| `Frida` + `frida-tools` | dynamic instrumentation | `pipx install frida-tools` |
| `objection` | prebuilt Frida workflows (pinning, storage, keychain) | `pipx install objection` |
| `apk-mitm` | one-command patch-to-proxyable | `npm i -g apk-mitm` |
| `dex2jar`, `JD-GUI` | legacy fallback | github |

## iOS

| Tool | Use | Install |
|---|---|---|
| `ipsw` | `class-dump --headers`, `swift-dump --demangle` | `brew install blacktop/tap/ipsw` |
| `class-dump` (legacy) | ObjC headers | github |
| `otool`, `nm`, `strings`, `codesign` | Mach-O inspection | Xcode CLI tools |
| Hopper / IDA / Ghidra | disassembly + decompilation | paid / free |
| `Frida`, `objection`, `frida-ios-dump` | dynamic, decrypted IPA dump | pipx |
| `ios-deploy`, `ideviceinstaller` | install to device | brew / apt |

## Web

| Tool | Use | Install |
|---|---|---|
| Chrome DevTools | Network (HAR), Sources, Application, Event Listener Breakpoints | free |
| `webcrack` | deobfuscate obfuscator.io, unminify, unpack webpack/browserify | `npm i -g webcrack` [2](https://github.com/j4k0xb/webcrack) |
| `bundle-breaker` | debundle → per-module files + dependency graph | `npx bundle-breaker` [3](https://github.com/awphi/bundle-breaker) |
| `shuji`, `sourcemapper` | recover original sources from sourcemaps | github [1](https://gist.github.com/0xdevalias/d8b743efb82c0e9406fc69da0d6c6581) |
| `webpack-exploder` | extract originals from a `.map` | web |
| `debundle` | older webpack/browserify unpacker | github |
| Playwright / Puppeteer | scripted walkthroughs for differential testing | npm |
| mitmproxy / Burp | request interception and modification | pipx / paid |

## Flutter / React Native

| Tool | Use | Install |
|---|---|---|
| `blutter` | Flutter AOT: `libapp.so` → `asm/` with original Dart names | github, needs Linux + Dart SDK fetch |
| `reFlutter` | Flutter patching + traffic | pip |
| `hermes-dec` | Hermes HBC disassembler / partial decompiler | github [1](https://pilfer.github.io/mobile-reverse-engineering/react-native/reverse-engineering-and-instrumenting-react-native-apps/) |
| `hermes-decomp` | HBC decompiler, TUI, xrefs, Metro module split | github [2](https://github.com/keithcsqueensu/hermes-decomp) |
| `hbctool`, `hasmer`, `hermes_rs` | HBC dis/assembler — check supported HBC version | github |
| Bytecode Studio | all-in-one RN/Hermes RE | commercial |

Check your HBC version (`file` reports it, or `hermes-decomp info app.hbc`) before committing to a tool —
most lag the current version.

## Desktop

| Tool | Use | Install |
|---|---|---|
| `dnSpyEx` | .NET decompile **and** edit method bodies in C# → save module | github [2](https://www.jocheojeda.com/2026/06/17/decompiling-and-recompiling-net-apps-and-how-to-protect-your-binaries/) |
| `ILSpy` / `ilspycmd` | .NET decompiler, CLI available | github |
| `de4dot` | .NET deobfuscation | github |
| x64dbg / WinDbg / LLDB / GDB | native debugging | free |
| `Process Monitor`, `API Monitor` | Windows syscall / API observation | Sysinternals |
| `strace` / `ltrace` / `frida-trace` | Linux/macOS syscall and library tracing | system |
| `otool`, `class-dump`, `dtrace` | macOS | Xcode |
| Detect It Easy (DIE), PE-bear | packer / compiler identification | github |

---

## Minimum viable kit

If you install nothing else:

```bash
pipx install mitmproxy frida-tools objection
# + jadx (Android) or ipsw/Ghidra (iOS) or webcrack (web) or dnSpyEx (.NET)
```

Traffic capture plus one static reader answers the large majority of "what does this app do" questions.
