# Android playbook

## 1. Get the APK

```bash
adb shell pm list packages | grep -i <name>
adb shell pm path <package>
adb pull /data/app/~~xxxx==/<package>/base.apk ./target.apk
```

Or pull from APKMirror — verify the SHA-256 against a second source. An `.aab` needs
`bundletool build-apks` before any of this works.

## 2. Triage

```bash
python3 scripts/identify.py target.apk
```

Look at: how many `classes*.dex` (multi-dex = big app), `lib/<abi>/` contents, whether
`libflutter.so`/`libapp.so` are present (→ [cross-platform](cross-platform.md)), `assets/` contents.

## 3. Read: jadx

```bash
jadx --no-debug-info --show-bad-code -d out/ target.apk     # don't abort on failures
jadx --deobf --deobf-min 3 --deobf-rewrite-cfg -d out/ target.apk
jadx --classes-only -d out/ target.apk                      # fast pass on huge apps
jadx-gui target.apk                                         # best for navigation + Ctrl+Shift+F
```

Read order [2](https://www.kunalganglani.com/blog/reverse-engineering-android-apk):

1. `AndroidManifest.xml` — permissions, activities, services, receivers, deep links,
   `android:debuggable`, `android:networkSecurityConfig`
2. `res/values/strings.xml` — screen inventory and copy (for naming, not for reuse)
3. Package namespaces → third-party SDK inventory
4. Full-text search in this order:
   ```
   https?://[a-z0-9.-]+        # endpoints
   api[_-]?key|secret|token|password
   SharedPreferences|sqlite|Room|DataStore   # local storage
   getPackageInfo|Signature    # tamper detection
   /su|/system/xbin|magisk     # root detection
   X509TrustManager|CertificatePinner|okhttp3   # pinning
   ```

## 4. Read: apktool (when you need to modify)

```bash
apktool d target.apk -o work/       # → smali/, res/, AndroidManifest.xml
apktool b work/ -o rebuilt.apk
apksigner sign --ks debug.keystore rebuilt.apk
adb install -r rebuilt.apk
```

## 5. Dynamic

```bash
adb root && adb remount
# install proxy CA; Android 7+ ignores user CAs for apps unless networkSecurityConfig allows it
adb push mitmproxy-ca-cert.cer /system/etc/security/cacerts/   # rooted/emulator, hash-named
adb shell ps -A | grep frida

objection -g <package> explore
android sslpinning disable
frida -U -f <package> -l script.js --no-pause
frida-trace -U -f <package> -m "*[*login* *]"
```

Fast path when you only need to see traffic: `apk-mitm target.apk` decompiles, patches the network
security config, rebuilds and signs in one command [1](https://robinx0.github.io/blogs/mobile-security/apk-reverse-engineering/).

## 6. Data

```bash
adb exec-out run-as <package> cat databases/app.db > app.db
adb exec-out run-as <package> cat shared_prefs/prefs.xml
sqlite3 app.db ".schema"
```

## 7. Rebuild failures [1](https://robinx0.github.io/blogs/mobile-security/apk-reverse-engineering/)

| Error | Fix |
|---|---|
| `resource ID is invalid` | `apktool empty-framework-dir --force`; re-decode with `apktool if framework-res.apk` |
| `Couldn't find android-XX target` | install the SDK platform matching `targetSdkVersion` |
| Instant crash after a smali edit | wrong `.registers N` in the edited method |
| App detects modification | signature changed; hook `PackageManager.getPackageInfo` or patch the check |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` (11+) | needs v2 signing — `apksigner`, not `jarsigner` |

## 8. Obfuscation notes

- **R8/ProGuard** — `mapping.txt` is sometimes shipped by accident in `assets/` or a debug build. Check.
- Rename as you go, *in your notes*, never in the target.
- When control flow is flattened, stop reading and hook it instead.
- Kotlin coroutines decompile badly — read the state machine's states, not the line order.

## Output

`02-surface-map.md`, `03-api-surface.yaml` (from the HAR), `05-data-model.md` (from the sqlite schema),
plus confirmed/refuted marks on every static hypothesis.
