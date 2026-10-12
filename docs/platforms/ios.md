# iOS playbook

## 1. Get a decrypted IPA

App Store binaries are FairPlay-encrypted; static analysis needs a decrypted image.

```bash
# jailbroken, app running
frida-ios-dump -u -o decrypted.ipa com.target.bundle
```

Non-jailbroken alternative: patch the IPA to load **FridaGadget** and re-codesign with a developer cert
[5](https://explainx.ai/skills/mukul975/Anthropic-Cybersecurity-Skills/performing-ios-app-security-assessment).

```bash
unzip app.ipa -d out/
file out/Payload/App.app/App        # confirm: Mach-O arm64, cryptid should be 0
otool -l out/Payload/App.app/App | grep -A5 LC_ENCRYPTION_INFO
```

## 2. Triage

```bash
python3 scripts/identify.py app.ipa
plutil -p out/Payload/App.app/Info.plist          # URL schemes, ATS, background modes, permission strings
otool -L  out/Payload/App.app/App                 # linked frameworks
otool -Iv out/Payload/App.app/App | grep -i jail  # quick jailbreak-detection sweep
strings out/Payload/App.app/App | grep -i "premium\|purchase\|subscription"
```

Entitlements and capabilities: `embedded.mobileprovision` (or `ldid -e`).

## 3. Read: class dumps and symbols

```bash
ipsw class-dump ./Payload/App.app/App --headers -o ./class_dump       # ObjC
ipsw swift-dump ./Payload/App.app/App --demangle > swift_dump.txt     # Swift
class-dump -H App -o ./Headers                                        # legacy ObjC
```

Class dumps give you every class, method, and property without touching assembly — the fastest possible
map of the app's structure [1](https://www.mintlify.com/LaurieWired/iOS_Reverse_Engineering/techniques/static-analysis).

Then Ghidra (enable the Objective-C analyzer) or Hopper for actual logic
[4](https://www.guardsquare.com/blog/protect-ios-apps-against-reverse-engineering).

## 4. Read: strings → xrefs

```bash
strings App | grep -i "premium\|purchase\|subscription\|api\|token"
```

Then in the disassembler: find the string → view cross-references → read the calling functions. That's the
shortest path from "interesting literal" to "the logic that gates it"
[1](https://www.mintlify.com/LaurieWired/iOS_Reverse_Engineering/techniques/static-analysis).

## 5. Dynamic

```bash
pipx install frida-tools objection

objection --gadget "com.target.app" explore --startup-command "ios sslpinning disable"
frida -U -f com.target.app -l ssl_pinning_bypass.js --no-pause
frida-trace -U -f com.target.app -m "*[*Token* *]"

# storage
objection --gadget com.target.app explore
ios keychain dump                 # note each item's accessibility attribute
ios nsuserdefaults get
find <app data dir> -name '*.sqlite'   # Core Data / sqlite
```

Pinning hooks: `NSURLSession`, `NSURLConnection`, and AFNetworking/Alamofire trust delegates
[5](https://explainx.ai/skills/mukul975/Anthropic-Cybersecurity-Skills/performing-ios-app-security-assessment).

## 6. Hypothesis discipline

Write each hypothesis as **(where) → (what) → (how to confirm)**
[5](https://github.com/h0tak88r/Sec-88/blob/main/ios-appsec/ios-reverse-engineering.md):

> `JailbreakChecker.isJailbroken` is referenced in `AppDelegate.application(_:didFinishLaunching:)` —
> confirm at runtime by hooking the return value and observing what changes.

Prioritise anything touching secrets, I/O, network, system APIs, or platform integrity checks.

## 7. Re-signing

```bash
codesign -f -s "iPhone Developer" Payload/App.app
ios-deploy --bundle Payload/App.app
```

Watch for: provisioning profile / entitlement mismatch, and app extensions & frameworks needing their own
signatures (sign inside-out: extensions and frameworks first, then the app).

## 8. Swift-specific notes

- Mangled names are recoverable (`swift-demangle` / `ipsw swift-dump --demangle`) and often carry module,
  type, and function-argument structure — far more informative than ObjC selectors.
- Swift's value types and protocol witnesses spread logic across many small functions; lean on the call
  graph rather than reading linearly.
- SwiftUI apps: view bodies are deeply nested generic structs. The *state* properties (`@State`,
  `@Published`, `@EnvironmentObject`) are the useful signal — find them, and the data flow follows.
