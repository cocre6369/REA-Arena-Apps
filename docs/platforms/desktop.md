# Desktop playbook (Windows / macOS / Linux)

## 1. Identify before anything

```bash
python3 scripts/identify.py app.exe      # or app.dylib, App.app/Contents/MacOS/App, ELF binary
file app.exe && strings -n 6 app.exe | head
```

What you want to know first:

| Question | Why it decides your whole toolchain |
|---|---|
| .NET or native? | .NET → dnSpyEx, near-perfect decompilation. Native → Ghidra, hard work |
| Is it packed? | UPX / Themida / VMProtect → you dump from memory instead of disassembling |
| 32 or 64-bit? | Determines your debugger and Frida stub |
| Symbols available? | A `.pdb` or `.dSYM` nearby turns everything into easy mode |
| Which UI toolkit? | Qt, GTK, Win32, WPF, Electron, CEF, SwiftUI — tells you where the logic lives |

Detect It Easy (DIE) or PE-bear answers most of this in one click.

---

## 2. .NET (the easy case)

.NET assemblies retain full metadata — types, members, and IL — so decompilation is close to the original
source [2](https://www.jocheojeda.com/2026/06/17/decompiling-and-recompiling-net-apps-and-how-to-protect-your-binaries/).

```bash
ilspycmd -o out/ app.dll          # ILSpy CLI, batch export
# dnSpyEx (GUI): open → read C# → Edit Method → Save Module
```

dnSpyEx does all three: decompile, debug, **and edit method bodies in C# and save the modified module**
[1](https://dnspy.org/), [3](https://www.filecroco.com/download-dnspy/).

```bash
# quick sweep for the gate you're looking for
strings app.dll | grep -i "trial\|expired\|license\|activation"
```

Then in dnSpy: right-click the method → *Analyze* → find its callers, and read up the stack to the UI.

### Obfuscated .NET

| Protection | Symptom | Move |
|---|---|---|
| Name obfuscation | `a.b.c()` | Trace behaviour, rename in notes. dnSpy still decompiles bodies fine |
| String encryption | no useful `strings` output | `de4dot` first; else hook the decryptor at runtime |
| Control-flow obfuscation | spaghetti `goto` | Stop reading; hook the method and observe inputs/outputs |
| Anti-debug | crashes when dnSpy attaches | ScyllaHide / SharpOD plugin, or pure-Frida instead |
| Anti-tamper | patched binary refuses to run | Runtime hooks, never file patches |

---

## 3. Native (Windows / macOS / Linux)

| Task | Windows | macOS | Linux |
|---|---|---|---|
| Disassemble / decompile | Ghidra, IDA, Binary Ninja | Ghidra, Hopper | Ghidra, r2 |
| Debug | x64dbg, WinDbg | LLDB | GDB, LLDB |
| Syscall / API trace | Process Monitor, API Monitor | `dtrace`, `fs_usage` | `strace`, `ltrace` |
| Library call trace | Frida | Frida | Frida |
| Packers | DIE, Scylla, x64dbg | `otool`, `vmmap` | `ldd`, `/proc/pid/maps` |

### Shortcuts worth taking first

1. **Strings + xrefs.** Find the user-visible message, cross-reference to the code that shows it, read
   outward. Beats reading linearly by orders of magnitude.
2. **Import table.** `CreateFile`, `RegSetValue`, `socket`, `CryptEncrypt`, `GetWindowText` — the imports
   sketch the app's behaviour before you decompile anything.
3. **Look for embedded resources.** Dialog templates, `.rc` data, embedded files, version info.
4. **Electron apps are web apps.** If you see `resources/app.asar`, unpack it and follow the
   [web playbook](web.md):

   ```bash
   npx @electron/asar extract app.asar out/
   ```
5. **Qt apps** leak class names, signal/slot signatures, and sometimes full moc metadata — grep for
   `QObject`, `QMetaObject`, and the class-name strings.

---

## 4. Dynamic

Frida works uniformly across all three and is usually the fastest path to a behaviour answer:

```bash
frida-trace -f ./app -i "CreateFileW" -i "RegSetValueExW"    # Windows
frida-trace -f ./app -i "open*" -i "write*"                   # macOS/Linux
frida -f ./app -l hook.js --no-pause
```

Also useful:

- **File system and registry/plist diffing** — snapshot before, run one action, diff after. Extremely
  effective for "what does this button do".
- **Network** — mitmproxy in transparent mode; desktop apps usually honour system proxy settings, and on
  Linux you can redirect with iptables.
- **Config and state files** — `~/.config/<app>`, `~/Library/Application Support/<app>`, `%APPDATA%\<app>`,
  and (Windows) the registry hive. This is the data model, handed to you.
- **Logs** — most desktop apps write a log file; `-v`, `--debug`, or `DEBUG=1` often unlocks far more.

## 5. Persistence and licensing behaviour

For desktop specifically, the interesting behaviours are usually: where settings are stored and in what
format, how licence state is persisted and validated, auto-update mechanism and endpoint, crash/telemetry
reporting, and file format (save/export) — the last one is often the real interoperability target.

---

## Output

Same deliverables as everywhere else: screen (window/dialog) inventory, behaviour spec, data model from
the real persisted state, and an API surface if it talks to a server.
