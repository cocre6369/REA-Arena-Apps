#!/usr/bin/env python3
"""
identify.py - triage fingerprinting for any reverse-engineering target.

Answers "what am I holding?" before you decide which toolchain to use.
Pure standard library - no pip, no JDK, no toolchain.

Usage:
    python3 scripts/identify.py <file-or-url> [--json] [--max-entries N]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
import zipfile
from typing import Any

UA = "REA-Arena-Apps/identify (+reverse engineering triage)"

# magic bytes: (offset, bytes, label, note)
MAGIC: list[tuple[int, bytes, str, str]] = [
    (0, b"dex\n035\x00", "DEX (Android Dalvik bytecode)", "decompile with jadx"),
    (0, b"dex\n036\x00", "DEX (Android Dalvik bytecode)", "decompile with jadx"),
    (0, b"dex\n037\x00", "DEX (Android Dalvik bytecode)", "decompile with jadx"),
    (0, b"dex\n038\x00", "DEX (Android Dalvik bytecode)", "decompile with jadx"),
    (0, b"dex\n039\x00", "DEX (Android Dalvik bytecode)", "decompile with jadx"),
    (0, b"PK\x03\x04", "ZIP archive", "check contents - APK/IPA/JAR/ASAR are all zips"),
    (0, b"\x7fELF", "ELF (Linux/Android native)", "Ghidra / radare2 / objdump"),
    (0, b"MZ", "PE / DOS executable", "check e_lfanew for PE header; .NET if BSJB present"),
    (0, b"\xfe\xed\xfa\xce", "Mach-O 32-bit", "iOS/macOS - otool, class-dump, Ghidra"),
    (0, b"\xce\xfa\xed\xfe", "Mach-O 32-bit (reversed)", "iOS/macOS"),
    (0, b"\xfe\xed\xfa\xcf", "Mach-O 64-bit", "iOS/macOS - otool, class-dump, Ghidra"),
    (0, b"\xcf\xfa\xed\xfe", "Mach-O 64-bit (reversed)", "iOS/macOS"),
    (0, b"\xca\xfe\xba\xbe", "Java class OR Mach-O fat/universal", "ambiguous magic: check the next 4 bytes"),
    (0, b"\xca\xfe\xba\xbf", "Mach-O fat / Java class v45.3+", "ambiguous magic"),
    (0, b"\x00asm", "WebAssembly module", "wasm2wat / wasm-decompile / Ghidra"),
    (0, b"\xc6\x1f\xbc\x03", "Hermes bytecode (HBC)", "RN+Hermes - hermes-decomp / Bytecode Studio"),
    (0, b"\xc6\x1f\xbc\x1e", "Hermes bytecode (HBC) alt magic", "RN+Hermes"),
    (0, b"SQLite format 3\x00", "SQLite database", "app local storage - read the schema"),
    (0, b"OggS", "Ogg media", "asset"),
    (0, b"\x89PNG\r\n\x1a\n", "PNG image", "asset"),
    (0, b"\xff\xd8\xff", "JPEG image", "asset"),
    (0, b"!<arch>\n", "Unix archive (ar / .a)", "static library"),
    (0, b"7z\xbc\xaf\x27\x1c", "7-Zip archive", "unpack with 7z"),
    (0, b"\x1f\x8b", "gzip", "decompress first"),
    (0, b"BZh", "bzip2", "decompress first"),
    (0, b"\xfd7zXZ\x00", "xz", "decompress first"),
    (0, b"\x04\x22\x4d\x18", "LZ4", "decompress first"),
    (0, b"Cr24", "Chrome/Electron pak or CRX", "asar/CRX - unpack"),
    (0, b"\xd0\xcf\x11\xe0", "OLE2 / MSI / legacy Office", "installer or compound doc"),
    (0, b"#!", "script (shebang)", "read it directly"),
]

# zip-internal fingerprints: entry name (or substring) -> (label, hint)
ZIP_MARKERS: list[tuple[str, str, str]] = [
    ("AndroidManifest.xml", "Android application package (APK)", "jadx / apktool"),
    ("classes.dex", "Dalvik bytecode present", "jadx to decompile"),
    ("resources.arsc", "compiled Android resources", "apktool decodes"),
    ("Payload/", "iOS application archive (IPA)", "unzip, then otool/class-dump"),
    ("libflutter.so", "Flutter engine present", "see docs/platforms/cross-platform.md"),
    ("libapp.so", "Flutter AOT application image", "blutter / reFlutter"),
    ("flutter_assets/", "Flutter asset bundle", "contains Kernel/snapshot + assets"),
    ("index.android.bundle", "React Native bundle", "check for Hermes magic"),
    ("index.ios.bundle", "React Native bundle", "check for Hermes magic"),
    ("app.asar", "Electron application bundle", "npx @electron/asar extract"),
    ("META-INF/MANIFEST.MF", "Java JAR", "JD-GUI / procyon"),
    ("BOOT-INF/classes/", "Spring Boot fat JAR", "extract then decompile"),
    ("module.json", "Adobe CEP / Node module", "inspect"),
    ("Info.plist", "Apple bundle metadata", "plutil -p"),
    ("Contents/MacOS/", "macOS .app bundle", "identify the inner binary"),
    ("package.json", "Node/npm package or web app", "read dependencies"),
]

ELF_MACHINE = {
    0x03: ("x86", 32, "little"),
    0x3E: ("x86-64", 64, "little"),
    0x28: ("ARM", 32, "little"),
    0xB7: ("AArch64", 64, "little"),
    0x08: ("MIPS", 32, "big"),
    0x14: ("PowerPC", 32, "big"),
    0xF3: ("RISC-V", 64, "little"),
}

PE_MACHINE = {
    0x014C: ("x86", 32),
    0x8664: ("x86-64", 64),
    0x01C0: ("ARM", 32),
    0xAA64: ("AArch64", 64),
}

MACHO_CPU = {
    0x01000007: ("x86", 32),
    0x0100000C: ("ARM", 32),
    0x0100000F: ("x86-64", 64),
    0x0100000C | 0x01000000: ("ARM64", 64),
}

# what to look for inside a decompiled/extracted tree
INTEREST = re.compile(
    r"(AndroidManifest\.xml|Info\.plist|embedded\.mobileprovision|resources\.arsc"
    r"|classes\d*\.dex|\.smali$|\.hbc$|index\.(android|ios)\.bundle|libapp\.so|libflutter\.so"
    r"|app\.asar|\.pdb$|\.dSYM/|\.map$|\.sqlite|\.db$|Localizable\.strings|strings\.xml"
    r"|\.plist$|\.exe$|\.dll$|\.so$|\.dylib$)",
    re.I,
)

WEB_FIELDS = [
    ("server", "Server"),
    ("x-powered-by", "X-Powered-By"),
    ("x-generator", "X-Generator"),
    ("x-framework", "X-Framework"),
    ("content-type", "Content-Type"),
    ("set-cookie", "Set-Cookie"),
    ("x-nextjs-cache", "X-Nextjs-Cache"),
    ("cf-ray", "CF-Ray"),
]


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n:.1f}GB"


def hashes(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    algos = {"md5": hashlib.md5(), "sha1": hashlib.sha1(), "sha256": hashlib.sha256()}
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            for h in algos.values():
                h.update(chunk)
    for name, h in algos.items():
        out[name] = h.hexdigest()
    return out


def detect_magic(head: bytes) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for off, magic, label, note in MAGIC:
        if len(head) >= off + len(magic) and head[off : off + len(magic)] == magic:
            if magic == b"\xca\xfe\xba\xbe":
                # Java class has (minor, major) version next; fat Mach-O has nfat_arch
                nxt = int.from_bytes(head[4:8], "big") if len(head) >= 8 else 0
                if 0 < nxt < 40:
                    found.append(("Mach-O universal/fat binary", f"{nxt} architectures - lipo to thin"))
                else:
                    found.append(("Java class file", f"class version major={nxt & 0xFFFF}"))
            else:
                found.append((label, note))
    if not found:
        try:
            head[:512].decode("utf-8")
            found.append(("text file", "read it directly - maybe JS, JSON, smali, or plist"))
        except UnicodeDecodeError:
            found.append(("unknown binary", "run `file` and `strings` on it"))
    return found


def parse_elf(head: bytes) -> dict[str, Any]:
    info: dict[str, Any] = {}
    if len(head) < 20:
        return info
    info["class"] = "64-bit" if head[4] == 2 else "32-bit"
    info["endianness"] = "little" if head[5] == 1 else "big"
    mach = int.from_bytes(head[18:20], "little")
    arch, bits, _ = ELF_MACHINE.get(mach, (f"unknown (0x{mach:x})", 0, "?"))
    info["architecture"] = arch
    return info


def parse_pe(path: str, head: bytes) -> dict[str, Any]:
    info: dict[str, Any] = {}
    if len(head) < 0x40:
        return info
    e_lfanew = int.from_bytes(head[0x3C:0x40], "little")
    try:
        with open(path, "rb") as fh:
            fh.seek(e_lfanew)
            if fh.read(4) != b"PE\x00\x00":
                return {"note": "MZ header but no PE signature (DOS executable or stub)"}
            machine = int.from_bytes(fh.read(2), "little")
            arch, bits = PE_MACHINE.get(machine, (f"unknown (0x{machine:x})", 0))
            info["architecture"] = arch
            info["class"] = f"{bits}-bit" if bits else "unknown"
            fh.read(18)  # NumberOfSections, TimeDateStamp, ptrs, numsymbols
            opt_size = int.from_bytes(fh.read(2), "little")
            fh.read(2)  # Characteristics
            opt_start = fh.tell()
            magic = int.from_bytes(fh.read(2), "little")
            info["pe_type"] = "PE32+" if magic == 0x20B else "PE32" if magic == 0x10B else f"0x{magic:x}"
            # data directories: CLI header is index 14, at offset 96+... within optional header
            if magic == 0x20B:
                fh.seek(opt_start + 112)
            else:
                fh.seek(opt_start + 96)
            rva = int.from_bytes(fh.read(4), "little")
            size = int.from_bytes(fh.read(4), "little")
            if rva:
                info["cli_header_rva"] = rva
                # look for the BSJB signature somewhere in the file as a cheap .NET check
                with open(path, "rb") as fh2:
                    blob = fh2.read()
                if b"BSJB" in blob:
                    info["runtime"] = ".NET / CLR assembly"
                    info["hint"] = "decompile with dnSpyEx or ILSpy (near-original C#)"
            _ = (opt_size, size)
    except (OSError, ValueError):
        pass
    return info


def parse_macho(head: bytes) -> dict[str, Any]:
    info: dict[str, Any] = {}
    if len(head) < 8:
        return info
    cputype = int.from_bytes(head[4:8], "little")
    known = {
        0x01000007: ("x86", 32),
        0x0100000C: ("ARM", 32),
        0x0100000F: ("x86-64", 64),
        0x0100000C | 0x01000000: ("ARM64", 64),
        0x0200000C: ("ARM64", 64),
    }
    arch, bits = known.get(cputype, (f"unknown (0x{cputype:x})", 0))
    info["architecture"] = arch
    info["class"] = f"{bits}-bit" if bits else "unknown"
    return info


def scan_zip(path: str, max_entries: int) -> dict[str, Any]:
    out: dict[str, Any] = {"entries": [], "framework": [], "interesting": [], "total": 0}
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            out["total"] = len(names)
            out["entries"] = [n for n in names[:max_entries]]
            joined = "\n".join(names)
            for marker, label, hint in ZIP_MARKERS:
                if marker.lower() in joined.lower() or any(marker.lower() in n.lower() for n in names):
                    out["framework"].append({"marker": marker, "label": label, "hint": hint})
            out["interesting"] = sorted({n for n in names if INTEREST.search(n)})[:max_entries]
            # abi + detect Hermes by reading the start of the RN bundle
            abis = sorted({n.split("/")[1] for n in names if n.startswith("lib/") and n.count("/") > 1})
            if abis:
                out["android_abis"] = abis
            for cand in ("assets/index.android.bundle", "assets/index.ios.bundle"):
                if cand in names:
                    try:
                        head = zf.read(cand)[:8]
                        kind = "Hermes bytecode" if head[:4] in (b"\xc6\x1f\xbc\x1e", b"\xc6\x1f\xbc\x03") else "plain minified JS (no Hermes)"
                        out["framework"].append(
                            {"marker": cand, "label": f"React Native bundle: {kind}", "hint": "see docs/platforms/cross-platform.md"}
                        )
                    except Exception:  # noqa: BLE001
                        pass
    except zipfile.BadZipFile:
        out["error"] = "not a readable zip (truncated, encrypted, or another container)"
    return out


def fetch_url(url: str) -> dict[str, Any]:
    out: dict[str, Any] = {"url": url}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310
            body = resp.read(1 << 20)
            out["status"] = resp.status
            out["headers"] = {k: v for k, v in resp.headers.items() if k.lower() in dict((a.lower(), b) for a, b in WEB_FIELDS)}
            out["final_url"] = resp.geturl()
        text = body.decode("utf-8", "replace")
        signals: list[str] = []
        for needle, name in (
            ("__NEXT_DATA__", "Next.js"),
            ("__NUXT__", "Nuxt"),
            ("webpackChunk", "Webpack code-splitting"),
            ("webpackJsonp", "Webpack (v4 style)"),
            ("__REACT_DEVTOOLS_GLOBAL_HOOK__", "React"),
            ("__VUE_DEVTOOLS_GLOBAL_HOOK__", "Vue"),
            ("ng-version", "Angular"),
            ("__sveltekit", "SvelteKit"),
            ("window.__APOLLO_STATE__", "Apollo GraphQL client"),
            ("data-reactroot", "React SSR root"),
        ):
            if needle in text:
                signals.append(name)
        for m in re.finditer(r'src="([^"]+\.js[^"]*)"', text):
            out.setdefault("scripts", []).append(m.group(1))  # type: ignore[union-attr]
            if len(out.get("scripts", [])) >= 15:
                break
        for m in re.finditer(r'sourceMappingURL=([^\s"\']+)', text):
            out.setdefault("sourcemaps", []).append(m.group(1))  # type: ignore[union-attr]
        out["framework_signals"] = signals
        out["hint"] = "capture a HAR in DevTools, then see docs/platforms/web.md"
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


def render(report: dict[str, Any]) -> str:
    L: list[str] = []
    add = L.append
    add("=" * 72)
    add("TRIAGE REPORT")
    add("=" * 72)
    if "url" in report:
        add(f"URL          : {report['url']}")
        if "status" in report:
            add(f"HTTP status  : {report['status']}")
            add(f"Final URL    : {report.get('final_url')}")
            if report.get("headers"):
                add("Headers      :")
                for k, v in report["headers"].items():
                    add(f"    {k}: {v}")
            if report.get("framework_signals"):
                add(f"Framework    : {', '.join(report['framework_signals'])}")
            for key in ("scripts", "sourcemaps"):
                if report.get(key):
                    add(f"{key.title():<12} :")
                    for v in report[key]:
                        add(f"    - {v}")
        if "error" in report:
            add(f"ERROR        : {report['error']}")
        add(f"\nNext         : {report.get('hint','')}")
        add("=" * 72)
        return "\n".join(L)

    add(f"File         : {report['path']}")
    add(f"Size         : {report['size_human']} ({report['size']} bytes)")
    add(f"SHA-256      : {report['sha256']}")
    add(f"SHA-1        : {report['sha1']}")
    add(f"MD5          : {report['md5']}")
    add("")
    add("Type         :")
    for label, note in report["magic"]:
        add(f"    - {label}")
        add(f"      {note}")
    for key in ("class", "endianness", "architecture", "pe_type", "runtime"):
        if key in report:
            add(f"{key.title():<13}: {report[key]}")
    if report.get("hint"):
        add(f"Hint         : {report['hint']}")

    z = report.get("zip")
    if z:
        add("")
        add(f"Zip entries  : {z.get('total')}")
        if z.get("error"):
            add(f"    ! {z['error']}")
        if z.get("framework"):
            add("Fingerprint  :")
            for f in z["framework"]:
                add(f"    - {f['label']}")
                add(f"      matched {f['marker']} -> {f['hint']}")
        if z.get("android_abis"):
            add(f"Android ABIs : {', '.join(z['android_abis'])}")
        if z.get("interesting"):
            add("Interesting entries:")
            for n in z["interesting"][:25]:
                add(f"    - {n}")
        if z.get("entries"):
            add("First entries:")
            for n in z["entries"][:15]:
                add(f"    - {n}")

    add("")
    add("Suggested playbook:")
    for p in report.get("playbooks", []):
        add(f"    - {p}")
    add("=" * 72)
    return "\n".join(L)


def pick_playbooks(report: dict[str, Any]) -> list[str]:
    """Match on explicit signals, never on a substring of the whole report."""
    sig: set[str] = set()
    for _label, _note in report.get("magic", []):
        sig.add(_label.lower())
    z = report.get("zip") or {}
    for f in z.get("framework", []):
        sig.add(f.get("marker", "").lower())
        sig.add(f.get("label", "").lower())
    sig.update(n.lower() for n in z.get("interesting", []))
    if report.get("runtime"):
        sig.add(report["runtime"].lower())
    blob = " | ".join(sig)

    out: list[str] = []
    if any(s in blob for s in ("androidmanifest.xml", "classes.dex", "resources.arsc", "dex (android")):
        out.append("docs/platforms/android.md")
    if any(s in blob for s in ("payload/", "info.plist", "mach-o", "embedded.mobileprovision")):
        out.append("docs/platforms/ios.md")
    if any(s in blob for s in ("flutter", "libapp.so", "libflutter.so", "hermes", "react native", "index.android.bundle", "index.ios.bundle")):
        out.append("docs/platforms/cross-platform.md")
    if ".net" in blob or "clr" in blob or "bsjb" in blob:
        out.append("docs/platforms/desktop.md (dnSpyEx / ILSpy)")
    elif "elf" in blob or "pe / dos" in blob:
        out.append("docs/platforms/desktop.md (Ghidra / radare2 / x64dbg)")
    if "asar" in blob or "webassembly" in blob:
        out.append("docs/platforms/web.md")
    if not out:
        out.append("docs/01-triage.md - inconclusive; run `file` and `strings` next")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Triage-fingerprint a reverse-engineering target.")
    ap.add_argument("target", help="path to a file, or an http(s) URL for a web target")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a report")
    ap.add_argument("--max-entries", type=int, default=200, help="max zip entries to enumerate")
    args = ap.parse_args()

    if args.target.startswith(("http://", "https://")):
        report = fetch_url(args.target)
        print(json.dumps(report, indent=2) if args.json else render(report))
        return 0 if "error" not in report else 1

    path = args.target
    if not os.path.isfile(path):
        print(f"error: no such file: {path}", file=sys.stderr)
        return 2

    with open(path, "rb") as fh:
        head = fh.read(4096)

    report: dict[str, Any] = {
        "path": os.path.abspath(path),
        "size": os.path.getsize(path),
        "size_human": human(os.path.getsize(path)),
        "magic": [list(x) for x in detect_magic(head)],
    }
    report.update(hashes(path))

    if head[:4] == b"\x7fELF":
        report.update(parse_elf(head))
    elif head[:2] == b"MZ":
        report.update(parse_pe(path, head))
    elif head[:4] in (b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe"):
        report.update(parse_macho(head))
    elif head[:4] == b"PK\x03\x04":
        report["zip"] = scan_zip(path, args.max_entries)

    report["playbooks"] = pick_playbooks(report)
    print(json.dumps(report, indent=2) if args.json else render(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
