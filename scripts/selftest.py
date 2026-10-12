#!/usr/bin/env python3
"""
selftest.py - exercises the repo's scripts against synthetic fixtures.

No network, no toolchain, no real targets. Run after editing anything in scripts/.

    python3 scripts/selftest.py
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PASS, FAIL = 0, 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok    {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable] + args, capture_output=True, text=True, cwd=ROOT)


# ---------------------------------------------------------------- fixtures


def elf(machine: int = 0xB7) -> bytes:
    h = b"\x7fELF" + bytes([2, 1, 1, 0]) + b"\0" * 8
    h += struct.pack("<HHIQQQIHHHHHH", 2, machine, 1, 0, 0, 0, 0, 64, 56, 0, 0, 0, 0)
    return h + b"\0" * 128


def macho(cputype: int = 0x0100000C | 0x01000000) -> bytes:
    return struct.pack("<IiiIII", 0xFEEDFACF, cputype, 0, 2, 0, 0) + b"\0" * 128


def make_fixtures(d: str) -> dict[str, str]:
    paths: dict[str, str] = {}

    p = os.path.join(d, "flutter.apk")
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("AndroidManifest.xml", b"\x03\x00\x08\x00")
        z.writestr("classes.dex", b"dex\n035\x00" + b"\0" * 40)
        z.writestr("resources.arsc", b"\x02\x00\x0c\x00")
        z.writestr("lib/arm64-v8a/libflutter.so", elf())
        z.writestr("lib/arm64-v8a/libapp.so", elf())
        z.writestr("assets/flutter_assets/kernel_blob.bin", b"x")
    paths["flutter"] = p

    p = os.path.join(d, "rn.apk")
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("AndroidManifest.xml", b"\x03\x00\x08\x00")
        z.writestr("classes.dex", b"dex\n035\x00" + b"\0" * 40)
        z.writestr("assets/index.android.bundle",
                   bytes([0xC6, 0x1F, 0xBC, 0x1E]) + b"\x60\x00\x00\x00" + b"x" * 100)
    paths["rn"] = p

    p = os.path.join(d, "App.ipa")
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("Payload/App.app/App", macho())
        z.writestr("Payload/App.app/Info.plist", b"<?xml version=\"1.0\"?>")
        z.writestr("Payload/App.app/embedded.mobileprovision", b"x")
    paths["ipa"] = p

    p = os.path.join(d, "libnative.so")
    with open(p, "wb") as fh:
        fh.write(elf())
    paths["elf"] = p

    p = os.path.join(d, "AppBinary")
    with open(p, "wb") as fh:
        fh.write(macho())
    paths["macho"] = p

    # decompiled-ish tree for the scanner
    src = os.path.join(d, "src")
    os.makedirs(src, exist_ok=True)
    with open(os.path.join(src, "Api.java"), "w") as fh:
        fh.write("""
public class Api {
  static final String BASE = "https://api.example.com/v2";
  static final String KEY  = "AIzaSyD-1234567890abcdefghijklmnopqrstuvwx";
  String tok = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
  void init() {
    SharedPreferences p = getSharedPreferences("cfg", 0);
    new okhttp3.CertificatePinner.Builder().build();
    if (new File("/system/xbin/su").exists()) throw new RuntimeException();
    FirebaseRemoteConfig cfg = FirebaseRemoteConfig.getInstance();
    track("https://www.google-analytics.com/collect");
    open("myapp://profile/42");
  }
}
""")
    with open(os.path.join(src, "app.js"), "w") as fh:
        fh.write('const B="https://api.example.dev/v3"; localStorage.setItem("t",1);\n')
    paths["src"] = src

    # HAR
    har = {"log": {"version": "1.2", "entries": []}}

    def entry(method, url, status=200, req=None, resp=None):
        return {
            "request": {
                "method": method, "url": url,
                "headers": [{"name": "Authorization", "value": "Bearer abc.def.ghi"},
                            {"name": "Content-Type", "value": "application/json"}],
                "postData": {"mimeType": "application/json", "text": json.dumps(req)} if req else {},
                "queryString": [], "cookies": [], "headersSize": 0, "bodySize": 0,
            },
            "response": {
                "status": status, "statusText": "OK",
                "headers": [{"name": "Content-Type", "value": "application/json"}],
                "content": {"size": 0, "mimeType": "application/json", "text": json.dumps(resp)} if resp else
                           {"size": 0, "mimeType": "application/json", "text": ""},
                "cookies": [], "headersSize": 0, "bodySize": 0, "redirectURL": "",
            },
            "startedDateTime": "2026-10-12T09:00:00.000Z", "time": 120,
            "cache": {}, "timings": {"send": 0, "wait": 100, "receive": 20}, "pageref": "p1",
        }

    har["log"]["entries"] = [
        entry("GET", "https://api.example.com/v2/feed?cursor=abc&ts=1700000000",
              resp={"items": [{"id": 1, "title": "a"}], "next": "def"}),
        entry("GET", "https://api.example.com/v2/feed?cursor=def&ts=1700000001",
              resp={"items": [{"id": 2, "title": "b"}], "next": None}),
        entry("POST", "https://api.example.com/v2/session", status=201,
              req={"email": "a@b.c"}, resp={"token": "t", "user": {"id": "7f8e9d10-1111-2222-3333-444455556666"}}),
        entry("DELETE", "https://api.example.com/v2/items/550e8400-e29b-41d4-a716-446655440000", status=204),
        entry("GET", "https://cdn.example.io/logo.png", resp={"x": 1}),
    ]
    p = os.path.join(d, "session.har")
    with open(p, "w") as fh:
        json.dump(har, fh)
    paths["har"] = p
    return paths


# ---------------------------------------------------------------- tests


def test_identify(paths: dict[str, str]) -> None:
    print("identify.py")

    r = run([os.path.join(HERE, "identify.py"), paths["flutter"], "--json"])
    d = json.loads(r.stdout) if r.returncode == 0 else {}
    blob = json.dumps(d).lower()
    check("flutter.apk -> APK detected", "android application package" in blob)
    check("flutter.apk -> Flutter detected", "libapp.so" in blob)
    check("flutter.apk -> abi list", "arm64-v8a" in blob)
    check("flutter.apk -> playbooks",
          "android" in blob and "cross-platform" in blob, blob[:200])
    check("flutter.apk -> sha256 present", len(d.get("sha256", "")) == 64)

    r = run([os.path.join(HERE, "identify.py"), paths["rn"], "--json"])
    blob = json.loads(r.stdout)
    check("rn.apk -> Hermes detected", "hermes" in json.dumps(blob).lower())

    r = run([os.path.join(HERE, "identify.py"), paths["ipa"], "--json"])
    blob = json.dumps(json.loads(r.stdout)).lower() if r.returncode == 0 else "{}"
    check("App.ipa -> IPA detected", "ios application archive" in blob)
    check("App.ipa -> ios playbook", "platforms/ios.md" in blob)

    r = run([os.path.join(HERE, "identify.py"), paths["elf"]])
    check("libnative.so -> ELF + AArch64", "ELF" in r.stdout and "AArch64" in r.stdout)

    r = run([os.path.join(HERE, "identify.py"), paths["macho"]])
    check("macho -> Mach-O + ARM64", "Mach-O" in r.stdout and "ARM64" in r.stdout)
    check("macho -> ios playbook", "platforms/ios.md" in r.stdout)

    r = run([os.path.join(HERE, "identify.py"), os.path.join(paths[".." if False else "src"], "nope")])
    check("missing file -> exit 2", r.returncode == 2)


def test_stringscan(paths: dict[str, str], tmp: str) -> None:
    print("stringscan.py")
    out = os.path.join(tmp, "surface.md")
    r = run([os.path.join(HERE, "stringscan.py"), paths["src"], "-o", out])
    check("scan runs", r.returncode == 0, r.stderr[:300])
    check("report written", os.path.exists(out))
    body = open(out).read() if os.path.exists(out) else ""
    check("endpoint found", "api.example.com" in body)
    check("jwt found", "jwt" in body)
    check("storage found", "storage-android" in body or "storage-web" in body)
    check("pinning found", "pinning" in body)
    check("root detection found", "root-detection" in body)
    check("analytics sdk found", "sdk-analytics" in body)
    check("deep link found", "myapp://profile/42" in body)
    check("deep-link excludes http(s)", "https://api.example.com" not in
          body.split("## deep-link")[1].split("##")[0] if "## deep-link" in body else False)

    r = run([os.path.join(HERE, "stringscan.py"), paths["src"], "--json"])
    check("json mode", r.returncode == 0 and r.stdout.strip().startswith("{"))
    check("json parses", bool(json.loads(r.stdout)) if r.returncode == 0 else False)


def test_har2fixtures(paths: dict[str, str], tmp: str) -> None:
    print("har2fixtures.py")
    mocks = os.path.join(tmp, "mocks")
    surface = os.path.join(tmp, "surface.yaml")
    r = run([os.path.join(HERE, "har2fixtures.py"), paths["har"], "-o", mocks,
             "--surface", surface, "--redact"])
    check("har parses", r.returncode == 0, r.stderr[:300])
    idx = os.path.join(mocks, "index.json")
    check("index written", os.path.exists(idx))
    if os.path.exists(idx):
        data = json.load(open(idx))
        files = [f["file"] for f in data["fixtures"]]
        check("static asset filtered", not any(".png" in f for f in files), str(files))
        check("uuid path collapsed", any("/v2/items/{id}" == f["path"] for f in data["fixtures"]), str(files))
        check("fixture files exist", all(os.path.exists(os.path.join(mocks, f)) for f in files))
    check("surface skeleton written", os.path.exists(surface))
    if os.path.exists(surface):
        s = open(surface).read()
        check("auth detected", "auth: bearer" in s)
        check("response shape captured", "response_shape: {" in s)
        check("confirmed default false", "confirmed: false" in s)
        check("request body captured", any("session" in l for l in s.splitlines()))


def test_rekit(tmp: str) -> None:
    print("rekit")
    rekit = os.path.join(HERE, "rekit")
    env = dict(os.environ, REKIT_TEST="1")
    r = subprocess.run([rekit, "new", "Test App"], capture_output=True, text=True, cwd=ROOT, env=env)
    check("rekit new", r.returncode == 0, r.stderr[:300])
    case = os.path.join(ROOT, "cases", "test-app")
    created = os.path.isdir(case)
    check("case dir created", created)
    if created:
        for f in ("00-triage.md", "01-evidence-log.csv", "02-surface-map.md",
                  "03-api-surface.yaml", "04-screen-inventory.md",
                  "05-data-model.md", "06-clean-room-spec.md"):
            check(f"template {f}", os.path.exists(os.path.join(case, f)))
        triage = open(os.path.join(case, "00-triage.md")).read()
        check("name substituted", "Test App" in triage)
        check("date substituted", "{{DATE}}" not in triage)
        r2 = subprocess.run([rekit, "check", "test-app"], capture_output=True, text=True, cwd=ROOT)
        check("rekit check", r2.returncode == 0, r2.stderr[:200])
        r3 = subprocess.run([rekit, "list"], capture_output=True, text=True, cwd=ROOT)
        check("rekit list", r3.returncode == 0 and "test-app" in r3.stdout)
        r4 = subprocess.run([rekit, "evidence", "test-app", "apk", "x.apk", "sha256:ab", "lawful user", "triage"],
                            capture_output=True, text=True, cwd=ROOT)
        check("rekit evidence", r4.returncode == 0, r4.stderr[:200])
        shutil.rmtree(case, ignore_errors=True)


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="rea-selftest-")
    try:
        paths = make_fixtures(tmp)
        test_identify(paths)
        test_stringscan(paths, tmp)
        test_har2fixtures(paths, tmp)
        test_rekit(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print()
    print(f"{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
