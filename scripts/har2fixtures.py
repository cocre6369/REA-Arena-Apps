#!/usr/bin/env python3
"""
har2fixtures.py - turn a captured HAR into replayable fixtures + an API surface draft.

Feeds P6 (build against mocks) and P4 (03-api-surface.yaml).

What it does:
  - parses a HAR (HTTP Archive) file
  - normalises URLs: strips volatile values (tokens, timestamps, uuids, nonces)
    so repeated calls collapse into one fixture
  - dedupes by (method, normalised path, request-body shape)
  - writes one JSON fixture per unique call + an index
  - emits a YAML-ish skeleton for 03-api-surface.yaml

Usage:
    python3 scripts/har2fixtures.py captured/session.har -o mocks/
    python3 scripts/har2fixtures.py captured/session.har -o mocks/ --include 'api\.' --redact
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from collections import Counter
from typing import Any

# volatile substrings that would otherwise explode the fixture count
VOLATILE = [
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<uuid>"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"), "<jwt>"),
    (re.compile(r"\b\d{10,13}\b"), "<ts>"),
    (re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b"), "<iso8601>"),
    (re.compile(r"(?i)\b(?:[0-9a-f]{32,})\b"), "<hash>"),
]
QUERY_VOLATILE = {
    "ts", "timestamp", "_", "nonce", "rnd", "rand", "request_id", "requestId",
    "trace_id", "traceId", "session_id", "callback", "v",
}
SENSITIVE_HEADERS = {
    "authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
    "x-csrf-token", "x-xsrf-token", "proxy-authorization",
}


def normalise(text: str) -> str:
    for rx, repl in VOLATILE:
        text = rx.sub(repl, text)
    return text


ID_SEGMENT = re.compile(r"^([0-9]{1,20}|[0-9a-fA-F]{16,}|[A-Za-z0-9_-]{24,})$")


def collapse_ids(path: str) -> str:
    """Replace opaque identifiers in path segments with {id} so calls collapse."""
    base, sep, qs = path.partition("?")
    parts = []
    for seg in base.split("/"):
        parts.append("{id}" if ID_SEGMENT.match(seg) else seg)
    return "/".join(parts) + (sep + qs if sep else "")


def clean_query(path: str) -> str:
    if "?" not in path:
        return path
    base, _, qs = path.partition("?")
    keep = []
    for part in qs.split("&"):
        if not part:
            continue
        k, _, v = part.partition("=")
        if k.lower() in QUERY_VOLATILE:
            v = "<volatile>"
        keep.append(f"{k}={v}")
    return base + "?" + "&".join(keep)


def decode_body(entry: dict[str, Any], key: str) -> tuple[str, str]:
    """HAR request bodies live in `postData`; response bodies live in `content`."""
    node = entry.get(key, {})
    body = node.get("content") or node.get("postData") or {}
    text = body.get("text") or ""
    if not text:
        return "", body.get("mimeType", "")
    if body.get("encoding") == "base64":
        try:
            text = base64.b64decode(text).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            pass
    return text, body.get("mimeType", "")


def json_shape(obj: Any, depth: int = 0) -> Any:
    """Reduce a JSON value to its structure, so two calls with different data collapse."""
    if depth > 4:
        return "…"
    if isinstance(obj, dict):
        return {k: json_shape(v, depth + 1) for k, v in sorted(obj.items())[:50]}
    if isinstance(obj, list):
        if not obj:
            return []
        return [json_shape(obj[0], depth + 1)]
    if isinstance(obj, str):
        return "<string>"
    if isinstance(obj, bool):
        return "<bool>"
    if isinstance(obj, (int, float)):
        return "<number>"
    return "<null>"


def slug(method: str, path: str) -> str:
    raw = f"{method.lower()}-{path}"
    raw = re.sub(r"[^a-z0-9]+", "_", raw).strip("_")
    return raw[:80] or "request"


def main() -> int:
    ap = argparse.ArgumentParser(description="Convert a HAR capture into replayable fixtures.")
    ap.add_argument("har", help="path to a .har file")
    ap.add_argument("-o", "--output", default="mocks/", help="output directory")
    ap.add_argument("--include", default="", help="regex: only keep URLs matching this")
    ap.add_argument("--exclude", default=r"\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|mp4|mp3|css|js)(\?|$)",
                    help="regex: drop URLs matching this (default: static assets)")
    ap.add_argument("--redact", action="store_true", help="redact sensitive header values in the fixtures")
    ap.add_argument("--no-collapse", action="store_true", help="keep literal ids in paths instead of collapsing them to {id}")
    ap.add_argument("--surface", default="", help="also write an api-surface skeleton here")
    args = ap.parse_args()

    try:
        with open(args.har, encoding="utf-8") as fh:
            har = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read HAR: {exc}", file=sys.stderr)
        return 2

    entries = har.get("log", {}).get("entries", [])
    if not entries:
        print("error: no entries in HAR log", file=sys.stderr)
        return 2

    inc = re.compile(args.include) if args.include else None
    exc = re.compile(args.exclude) if args.exclude else None

    unique: dict[str, dict[str, Any]] = {}
    counts: Counter[str] = Counter()
    skipped = 0

    for entry in entries:
        req = entry.get("request", {})
        resp = entry.get("response", {})
        method = req.get("method", "GET").upper()
        url = req.get("url", "")

        if inc and not inc.search(url):
            skipped += 1
            continue
        if exc and exc.search(url):
            skipped += 1
            continue

        path = url.split("://", 1)[-1].split("/", 1)[-1] if "://" in url else url
        path = "/" + path
        if not args.no_collapse:
            path = collapse_ids(path)
        path = clean_query(normalise(path))
        req_text, req_mime = decode_body(entry, "request")
        resp_text, resp_mime = decode_body(entry, "response")

        try:
            req_json = json.loads(req_text) if req_text else None
        except json.JSONDecodeError:
            req_json = None
        try:
            resp_json = json.loads(resp_text) if resp_text else None
        except json.JSONDecodeError:
            resp_json = None

        shape_key = json.dumps(
            {
                "m": method,
                "p": path,
                "rs": json_shape(req_json) if req_json is not None else (normalise(req_text)[:200] if req_text else ""),
            },
            sort_keys=True,
        )
        fid = hashlib.sha1(shape_key.encode()).hexdigest()[:10]  # noqa: S324
        key = f"{fid}"
        counts[key] += 1

        if key not in unique:
            raw_headers = {h["name"]: h["value"] for h in req.get("headers", [])}
            auth = _auth_hint(raw_headers)
            headers = ({k: ("<redacted>" if k.lower() in SENSITIVE_HEADERS else v) for k, v in raw_headers.items()}
                       if args.redact else raw_headers)
            unique[key] = {
                "id": key,
                "method": method,
                "path": path,
                "slug": slug(method, path),
                "request_headers": headers,
                "auth": auth,
                "request_mime": req_mime,
                "request_body": req_json if req_json is not None else (normalise(req_text)[:4000] if req_text else None),
                "response_status": resp.get("status"),
                "response_mime": resp_mime,
                "response_body": resp_json if resp_json is not None else (normalise(resp_text)[:4000] if resp_text else None),
                "response_shape": json_shape(resp_json) if resp_json is not None else None,
                "calls": 0,
                "sample_url": url,
            }
        unique[key]["calls"] += 1

    os.makedirs(args.output, exist_ok=True)
    index = []
    for key, fx in sorted(unique.items(), key=lambda kv: (kv[1]["path"], kv[1]["method"])):
        name = f"{fx['slug']}__{key}.json"
        with open(os.path.join(args.output, name), "w", encoding="utf-8") as fh:
            json.dump(fx, fh, indent=2, ensure_ascii=False)
        index.append(
            {
                "file": name,
                "id": fx["id"],
                "method": fx["method"],
                "path": fx["path"],
                "status": fx["response_status"],
                "calls": fx["calls"],
                "request_mime": fx["request_mime"],
                "response_mime": fx["response_mime"],
            }
        )

    with open(os.path.join(args.output, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"source_har": os.path.abspath(args.har), "fixtures": index}, fh, indent=2)

    if args.surface:
        lines = ["# API surface skeleton - verify each entry before use", "",
                 f"# source: {os.path.abspath(args.har)}", "", "endpoints:"]
        for fx in sorted(unique.values(), key=lambda f: (f["path"], f["method"])):
            lines += [
                f"  - id: {fx['id']}",
                f"    method: {fx['method']}",
                f"    path: {fx['path']}",
                f"    auth: {fx.get('auth', 'none-observed')}",
                f"    request_mime: {fx['request_mime'] or '-'}",
                f"    response_status: {fx['response_status']}",
                f"    response_shape: {json.dumps(fx['response_shape'], ensure_ascii=False) if fx['response_shape'] else '-'}",
                f"    calls_observed: {fx['calls']}",
                f"    fixture: {fx['slug']}__{fx['id']}.json",
                "    evidence: TODO har-entry-reference",
                "    confirmed: false",
                "",
            ]
        with open(args.surface, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

    print(f"parsed {len(entries)} HAR entries -> {len(unique)} unique fixtures "
          f"({skipped} filtered out) in {args.output}")
    if args.surface:
        print(f"api skeleton -> {args.surface}")
    return 0


def _auth_hint(headers: dict[str, str]) -> str:
    for k in headers:
        kl = k.lower()
        if kl == "authorization":
            return "bearer" if headers[k].lower().startswith("bearer") else headers[k].split(" ")[0].lower()
        if kl in ("x-api-key", "x-auth-token"):
            return kl
        if kl == "cookie":
            return "cookie"
    return "none-observed"


if __name__ == "__main__":
    raise SystemExit(main())
