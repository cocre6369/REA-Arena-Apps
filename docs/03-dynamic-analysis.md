# P3 — Dynamic analysis: watching it run

Static tells you what the code says. Dynamic tells you what it *does* — and unlike static, it survives
obfuscation, packing, and bytecode you have no decompiler for.

**Order of preference: observe → instrument → patch.** Patching is the most invasive option and the most
likely to trip anti-tamper, so use it only to answer a specific question
[1](https://yarygintech.com/articles/android-traffic-analysis-charles-frida/).

---

## Setup

### Android

```bash
adb root
adb shell ps -A | grep frida                  # is frida-server up?
adb shell ls /data/misc/user/0/cacerts-added/ # is the proxy CA installed?
adb shell am start -a android.intent.action.VIEW -d "app://deep/link"
```

Emulator with a userdebug/eng build is the easy path (root + writable system). If the app refuses to run
on an emulator, that itself is a finding — and you patch around it or use a real device.

### iOS

- Jailbroken: `frida-server` over SSH, plus `frida-ios-dump` to pull a decrypted IPA.
- Not jailbroken: patch the IPA to load **FridaGadget** (`.dylib`) and re-codesign with a developer
  certificate [5](https://explainx.ai/skills/mukul975/Anthropic-Cybersecurity-Skills/performing-ios-app-security-assessment).

---

## 1. Traffic capture (highest yield — start here)

mitmproxy / Burp / Charles between device and internet:

1. Point the device Wi-Fi proxy at your host (or use mitmproxy **transparent mode** with iptables
   redirection — no device config needed) [4](https://www.bomberbot.com/proxy/unlocking-android-app-traffic-a-practical-guide-with-mitmproxy-and-frida/).
2. Install the proxy CA on the device and trust it for apps (Android 7+ won't trust user CAs by default:
   add `networkSecurityConfig`, or push the CA to `/system/etc/security/cacerts` on a rooted device).
3. **Export HAR.** This is the raw material for `03-api-surface.yaml`.

Read the traffic for: base URL and versioning, auth scheme (bearer / cookie / HMAC / custom header),
request and response shapes, pagination, idempotency keys, error envelopes, retry/backoff, client
telemetry, and which calls fire on which screen.

### TLS pinning

When the handshake fails and you see nothing in the proxy, the app is pinning. Don't fight the crypto —
hook the *decision* [2](https://dev.to/deepak_mishra_35863517037/bypassing-ssl-pinning-with-frida-advanced-mobile-scraping-54cl):

| Layer | Hook target |
|---|---|
| Android platform | `javax.net.ssl.X509TrustManager.checkServerTrusted` → swallow the exception |
| OkHttp | `okhttp3.CertificatePinner.check` → no-op the body |
| iOS | `NSURLSession` / `NSURLConnection` / AFNetworking-Alamofire trust delegates |
| Custom native | the app's own verify function — find it via strings near the cert/hash constants |

One-liner path:

```bash
objection -g com.target.app explore
android sslpinning disable          # or: ios sslpinning disable

frida -U -f com.target.app -l pinning-bypass.js --no-pause
```

If the goal is only "make this APK proxy-able", `apk-mitm` automates the whole
decompile → patch → rebuild → sign cycle [1](https://robinx0.github.io/blogs/mobile-security/apk-reverse-engineering/).

---

## 2. Runtime instrumentation (confirm your hypotheses)

Frida injects a JS engine into the process: enumerate classes, find live instances, trace calls, replace
implementations [2](https://dev.to/deepak_mishra_35863517037/bypassing-ssl-pinning-with-frida-advanced-mobile-scraping-54cl).

```bash
frida-ps -Uai                                     # what's running
frida-trace -U -f com.target.app -m "*[*Auth* *]"  # trace by wildcard
objection -g com.target.app explore               # prebuilt: storage, keychain, hooking
```

Good first hooks for a behaviour spec:

- the network client's request builder → exact headers the app sets
- the token storage / refresh path → session lifecycle
- feature-flag / entitlement resolution → what gates which UI
- the JSON (de)serialisation boundary → true data model, not the guessed one
- analytics emitters → the event taxonomy

## 3. Storage

| Store | Inspect with |
|---|---|
| SQLite | `adb exec-out run-as <pkg> cat databases/app.db > app.db`, then sqlite3 |
| SharedPreferences / plists | objection `android hooking search` or file pull |
| iOS Keychain | objection `ios keychain dump` — note each item's accessibility attribute |
| Web | DevTools → Application: localStorage, sessionStorage, IndexedDB, cookies, Cache Storage, service worker |
| Files | app sandbox listing; check what's world-readable or left in public storage |

Reconstruct the **data model from what's actually persisted** — that is ground truth for `05-data-model.md`.

## 4. Failure injection

The edge-case matrix comes from here. Use the proxy's block-list and breakpoints to force:

`500` · `401 expired token` · `429 rate limit` · empty list · 10k-item list · malformed JSON · slow
response (latency injection) · airplane mode mid-request · response between screens.

Record what the app does in each case. Most rebuilds diverge from the original exactly here, because the
happy path is all anyone documents.

## 5. Patching and rebuilding (last resort)

```bash
apktool d app.apk -o work/
$EDITOR work/smali/.../SomeClass.smali     # e.g. neutralise root detection
apktool b work/ -o patched.apk
apksigner sign --ks debug.keystore patched.apk
adb install -r patched.apk
```

Known failure modes [1](https://robinx0.github.io/blogs/mobile-security/apk-reverse-engineering/):

| Error | Fix |
|---|---|
| `resource ID is invalid` on build | `apktool empty-framework-dir --force`, re-decode with `apktool if framework-res.apk` |
| `Couldn't find android-XX target` | install the SDK platform matching `targetSdkVersion` |
| Crashes instantly after a smali edit | wrong `.registers N` count in the edited method |
| App detects modification | signature changed and it verifies it — hook `PackageManager.getPackageInfo` or patch the check |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` (Android 11+) | needs v2 signing — use `apksigner`, not `jarsigner` |

**Prefer runtime hooks over file patches.** Hooks leave the artifact on disk untouched, which is both
less invasive and far less likely to trip integrity checks.

---

## Output

- `captured/*.har` — the traffic, replayable as fixtures
- `03-api-surface.yaml` — endpoints with verified request/response shapes
- `04-screen-inventory.md` — confirmed by walking the running app
- `05-data-model.md` — from real persisted state
- `02-surface-map.md` — hypotheses from static marked **confirmed** / **refuted**
