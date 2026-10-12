#!/usr/bin/env python3
"""
stringscan.py - surface-map triage scanner.

Sweeps a file or a decompiled/extracted tree for the things that matter in P2:
endpoints, credentials, third-party SDK hosts, storage APIs, and anti-analysis
checks. Produces the first draft of 02-surface-map.md.

Pure standard library. Expect false positives - this is a candidate list to
verify in the dynamic phase, not a finding.

Usage:
    python3 scripts/stringscan.py <path> [-o out.md] [--json] [--min-length N]
                                  [--no-entropy] [--top N]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict

# (category, severity, regex)
RULES: list[tuple[str, str, str]] = [
    # network
    ("endpoint", "info", r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]{6,200}"),
    ("host", "info", r"\b(?:api|graph|cdn|static|assets|media|auth|login|oauth|sync|telemetry|events|analytics|metrics|logs|ws|wss|push|gateway|upload|download)\.[A-Za-z0-9-]+\.[a-z]{2,}\b"),
    ("ipv4", "info", r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b"),
    ("graphql", "info", r"(?i)[\"']?(?:query|mutation)\s+(?:[A-Z]\w+)?\s*[\({]"),
    # secrets
    ("aws-key", "high", r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{12,20}\b"),
    ("google-api-key", "high", r"\bAIza[0-9A-Za-z\-_]{35}\b"),
    ("slack-token", "high", r"\bxox[abprs]-[0-9A-Za-z-]{10,72}\b"),
    ("github-token", "high", r"\bgh[pousr]_[0-9A-Za-z]{36,255}\b"),
    ("stripe-key", "high", r"\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{10,}\b"),
    ("jwt", "high", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    ("private-key", "critical", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"),
    ("secret-assignment", "medium", r"(?i)\b(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key|passwd|password|bearer|signing[_-]?key)\b\s*[:=]\s*[\"']?[A-Za-z0-9_\-\.+/=]{8,}"),
    ("hardcoded-credential", "medium", r"(?i)\b(?:password|passwd|pwd|secret)\s*=\s*[\"'][^\"'\s]{4,}[\"']"),
    # storage
    ("storage-android", "info", r"(?i)\b(?:getSharedPreferences|SharedPreferences|Room|DataStore|openOrCreateDatabase|SQLiteDatabase|Realm|ObjectBox)\b"),
    ("storage-ios", "info", r"(?i)\b(?:NSUserDefaults|UserDefaults|CoreData|NSPersistentContainer|SecItemAdd|kSecClass|NSCoding|NSKeyedArchiver)\b"),
    ("storage-web", "info", r"(?i)\b(?:localStorage|sessionStorage|indexedDB|openDatabase|document\.cookie|CacheStorage|caches\.open)\b"),
    # crypto
    ("crypto-api", "info", r"(?i)\b(?:Cipher\.getInstance|AES/|javax\.crypto|CryptoKit|SecKeyCreate|CCCrypt|openssl|sodium|libsodium)\b"),
    ("weak-crypto", "medium", r"(?i)\b(?:MD5|SHA1|DES|RC4|ECB)\b"),
    # anti-analysis
    ("root-detection", "info", r"(?i)(?:/system/(?:app|xbin)/|/sbin/su|/su/bin|magisk|Superuser\.apk|com\.topjohnwu|isRooted|checkRoot)"),
    ("jailbreak-detection", "info", r"(?i)(?:/Applications/Cydia|/Library/MobileSubstrate|/bin/bash|/usr/sbin/sshd|frida|cycript|jailbreak|JailMonkey)"),
    ("tamper-detection", "info", r"(?i)(?:getPackageInfo|Signature\[\]|PackageManager\.getSign|verifySignature|checkSignature|APK_SIGN|integrity)"),
    ("pinning", "info", r"(?i)(?:X509TrustManager|checkServerTrusted|CertificatePinner|certificatePinner|NSURLSessionDelegate|SecTrustEvaluate|TrustKit|network-security-config|networkSecurityConfig)"),
    ("emulator-detection", "info", r"(?i)(?:goldfish|ranchu|generic_x86|sdk_gphone|isEmulator|Build\.FINGERPRINT.*generic)"),
    ("debug-flag", "info", r"(?i)(?:android:debuggable|applicationId.*debug|BuildConfig\.DEBUG|__DEV__|NODE_ENV)"),
    # analytics / sdk hosts
    ("sdk-analytics", "info", r"\b(?:google-analytics\.com|googletagmanager\.com|firebase(?:io|googleapis)?\.com|mixpanel\.com|amplitude\.com|segment\.(?:io|com)|appsflyer\.com|branch\.io|adjust\.com|facebook\.com/tr|sentry\.io|bugsnag\.com|datadoghq\.com|newrelic\.com|crashlytics\.com)"),
    ("sdk-payments", "info", r"\b(?:api\.stripe\.com|checkout\.stripe\.com|paypal\.com|braintreegateway\.com|api\.revenuecat\.com|apple\.com/verifyReceipt)"),
    ("sdk-maps", "info", r"\b(?:maps\.googleapis\.com|maps\.gstatic\.com|api\.mapbox\.com|tile\.openstreetmap\.org)"),
    ("sdk-push", "info", r"\b(?:fcm\.googleapis\.com|android\.googleapis\.com/gcm|push\.apple\.com|onesignal\.com)"),
    # pii / identifiers
    ("pii-android-id", "low", r"(?i)(?:ANDROID_ID|Settings\.Secure\.getString|advertisingId|getAdvertisingIdInfo|IDFA|identifierForVendor)"),
    # misc useful
    ("feature-flag", "info", r"(?i)\b(?:isFeatureEnabled|feature[_-]?flag|remoteConfig|getRemoteConfig|FirebaseRemoteConfig|ab[_-]?test|experiment)\b"),
    ("deep-link", "info", r"\b(?!https?:\/\/|wss?:\/\/|ftps?:\/\/|file:\/\/|javascript:)[a-z][a-z0-9+.\-]{2,20}:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]{2,80}"),
]

COMPILED = [(cat, sev, re.compile(pat)) for cat, sev, pat in RULES]

SKIP_DIRS = {".git", "node_modules", ".svn", "__pycache__", ".venv", "vendor", ".gradle", "build", "Pods"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".mp3", ".mp4", ".mov",
            ".wav", ".ogg", ".pdf", ".zip", ".gz", ".bz2", ".xz", ".ttf", ".otf", ".woff",
            ".woff2", ".eot", ".so", ".dylib", ".dex", ".class", ".jar"}
MAX_FILE = 40 * 1024 * 1024
TEXT_SAMPLE = 8192


def shannon(s: str) -> float:
    if not s:
        return 0.0
    counts: dict[str, int] = defaultdict(int)
    for ch in s:
        counts[ch] += 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def printable_strings(data: bytes, min_len: int = 6) -> list[str]:
    out = []
    cur = bytearray()
    for b in data:
        if 32 <= b < 127:
            cur.append(b)
        else:
            if len(cur) >= min_len:
                out.append(cur.decode("ascii", "replace"))
            cur = bytearray()
    if len(cur) >= min_len:
        out.append(cur.decode("ascii", "replace"))
    return out


def read_chunks(path: str) -> list[str]:
    try:
        if os.path.getsize(path) > MAX_FILE:
            return []
        with open(path, "rb") as fh:
            head = fh.read(TEXT_SAMPLE)
        if head[:4] in (b"\x89PNG", b"\xff\xd8\xff", b"PK\x03\x04"):
            return []
        with open(path, "rb") as fh:
            data = fh.read()
        try:
            data.decode("utf-8")
            return [data.decode("utf-8", "replace")]
        except UnicodeDecodeError:
            return printable_strings(data)
    except (OSError, ValueError):
        return []


def walk(root: str) -> list[str]:
    files: list[str] = []
    if os.path.isfile(root):
        return [root]
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.endswith(".framework")]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in SKIP_EXT:
                continue
            files.append(os.path.join(dirpath, fn))
    return files


def scan(paths: list[str], min_len: int, use_entropy: bool) -> dict[str, dict[str, dict]]:
    # category -> value -> {"count":n, "files":set, "severity":s, "samples":[]}
    findings: dict[str, dict[str, dict]] = defaultdict(dict)
    for path in paths:
        rel = path
        for chunk in read_chunks(path):
            for cat, sev, rx in COMPILED:
                for m in rx.finditer(chunk):
                    val = m.group(0).strip()
                    if len(val) < min_len:
                        continue
                    if use_entropy and cat == "secret-assignment":
                        # the captured value part must look random enough to be interesting
                        rhs = val.split("=", 1)[-1].split(":", 1)[-1].strip(" \"'")
                        if len(rhs) < 8 or shannon(rhs) < 3.0:
                            continue
                    bucket = findings[cat]
                    if val not in bucket:
                        bucket[val] = {"count": 0, "files": set(), "severity": sev, "sample": ""}
                    bucket[val]["count"] += 1
                    bucket[val]["files"].add(rel)
                    if not bucket[val]["sample"]:
                        start = max(0, m.start() - 40)
                        bucket[val]["sample"] = " ".join(chunk[start : m.end() + 40].split())
    return findings


SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
SEV_NOTE = {
    "critical": "**report immediately** - private key material in a shipped artifact",
    "high": "live credential shape - verify, and report to the vendor; do not use it",
    "medium": "possible hardcoded secret or weak primitive - verify before believing",
    "low": "identifier or tracking signal - note for the privacy surface",
    "info": "structural signal - feeds the surface map",
}


def render_md(findings: dict[str, dict[str, dict]], root: str, scanned: int, top: int, redact: bool) -> str:
    L: list[str] = []
    add = L.append
    add("# Surface map (automated triage)")
    add("")
    add(f"- Target path: `{root}`")
    add(f"- Files scanned: {scanned}")
    add(f"- Generated by: `scripts/stringscan.py`")
    add("")
    add("> Candidate list, **not** findings. Every row needs verification in the dynamic phase.")
    add("> Any live credential discovered belongs to the target's vendor: report it, don't use it.")
    add("")

    rows = []
    for cat, bucket in findings.items():
        sev = min((v["severity"] for v in bucket.values()), key=lambda s: SEV_ORDER.get(s, 9))
        rows.append((SEV_ORDER.get(sev, 9), sev, cat, bucket))
    rows.sort()

    add("## Summary")
    add("")
    add("| Severity | Category | Unique | Note |")
    add("|---|---|---|---|")
    for _o, sev, cat, bucket in rows:
        add(f"| {sev} | `{cat}` | {len(bucket)} | {SEV_NOTE.get(sev,'')} |")
    add("")

    for _o, sev, cat, bucket in rows:
        add(f"## {cat}  ({sev})")
        add("")
        add(SEV_NOTE.get(sev, ""))
        add("")
        items = sorted(bucket.items(), key=lambda kv: -kv[1]["count"])[:top]
        add("| Value | Hits | Files |")
        add("|---|---|---|")
        for val, meta in items:
            shown = val if len(val) <= 120 else val[:117] + "..."
            if redact and sev in ("critical", "high", "medium"):
                shown = shown[:6] + "…" + shown[-4:] if len(shown) > 14 else "…redacted…"
            add(f"| `{shown}` | {meta['count']} | {len(meta['files'])} |")
        if len(bucket) > top:
            add("")
            add(f"_…{len(bucket) - top} more unique values, re-run with `--top {len(bucket)}`_")
        add("")
        sample = next((m["sample"] for _v, m in items if m["sample"]), "")
        if sample:
            add(f"Example context: `{sample[:200]}`")
            add("")
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description="Surface-map triage scanner for reverse engineering.")
    ap.add_argument("path", help="file or directory to scan")
    ap.add_argument("-o", "--output", help="write markdown here")
    ap.add_argument("--json", action="store_true", help="emit JSON to stdout")
    ap.add_argument("--min-length", type=int, default=6, help="minimum match length")
    ap.add_argument("--top", type=int, default=25, help="rows per category")
    ap.add_argument("--no-entropy", action="store_true", help="disable the entropy filter on secret assignments")
    ap.add_argument("--redact", action="store_true", help="redact medium+ severity values in the report")
    args = ap.parse_args()

    if not os.path.exists(args.path):
        print(f"error: no such path: {args.path}", file=sys.stderr)
        return 2

    paths = walk(args.path)
    findings = scan(paths, args.min_length, not args.no_entropy)

    if args.json:
        payload = {
            cat: [
                {"value": v, "count": m["count"], "severity": m["severity"],
                 "files": sorted(m["files"])[:10], "context": m["sample"]}
                for v, m in sorted(bucket.items(), key=lambda kv: -kv[1]["count"])
            ]
            for cat, bucket in findings.items()
        }
        print(json.dumps(payload, indent=2))
        return 0

    md = render_md(findings, args.path, len(paths), args.top, args.redact)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(md)
        print(f"wrote {args.output}  ({len(paths)} files scanned, {sum(len(b) for b in findings.values())} unique candidates)")
    else:
        print(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
