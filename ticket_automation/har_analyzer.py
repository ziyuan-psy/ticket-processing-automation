from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlparse


SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-csrf-token",
    "x-xsrf-token",
    "x-token",
    "token",
}

KEYWORDS = (
    "coupon",
    "voucher",
    "ticket",
    "activity",
    "marketing",
    "template",
    "store",
    "shop",
    "import",
    "export",
    "member",
    "crowd",
    "phone",
    "mobile",
    "发券",
    "优惠券",
    "招待",
    "门店",
    "模板",
    "活动",
)

PHONE_RE = re.compile(r"1[3-9]\d{9}")


@dataclass
class EndpointGroup:
    method: str
    path: str
    count: int = 0
    statuses: Counter[int] = field(default_factory=Counter)
    query_keys: Counter[str] = field(default_factory=Counter)
    body_keys: Counter[str] = field(default_factory=Counter)
    content_types: Counter[str] = field(default_factory=Counter)
    sample_url: str = ""
    sample_body: str = ""
    score: int = 0


def _header_value(headers: list[dict[str, Any]], name: str) -> str:
    lowered = name.lower()
    for header in headers:
        if str(header.get("name", "")).lower() == lowered:
            return str(header.get("value", ""))
    return ""


def _looks_like_api(entry: dict[str, Any]) -> bool:
    request = entry.get("request", {})
    response = entry.get("response", {})
    resource_type = str(entry.get("_resourceType", "")).lower()
    request_headers = request.get("headers", [])
    response_content = response.get("content", {})
    mime_type = str(response_content.get("mimeType", "")).lower()
    accept = _header_value(request_headers, "accept").lower()
    content_type = _header_value(request_headers, "content-type").lower()
    method = str(request.get("method", "GET")).upper()

    if resource_type in {"xhr", "fetch"}:
        return True
    if "json" in mime_type or "json" in accept or "json" in content_type:
        return True
    if method not in {"GET", "HEAD", "OPTIONS"}:
        return True
    return False


def _flatten_keys(value: Any, prefix: str = "") -> list[str]:
    if isinstance(value, dict):
        keys: list[str] = []
        for key, child in value.items():
            child_key = f"{prefix}.{key}" if prefix else str(key)
            keys.append(child_key)
            keys.extend(_flatten_keys(child, child_key))
        return keys
    if isinstance(value, list) and value:
        return _flatten_keys(value[0], f"{prefix}[]")
    return []


def _redact_text(value: str, limit: int = 500, redact_phones: bool = True) -> str:
    redacted = PHONE_RE.sub("<phone>", value) if redact_phones else value
    redacted = re.sub(
        r'("(?:token|authorization|cookie|password|secret)"\s*:\s*")[^"]+(")',
        r"\1<redacted>\2",
        redacted,
        flags=re.IGNORECASE,
    )
    if len(redacted) > limit:
        return redacted[:limit] + "..."
    return redacted


def _body_summary(
    post_data: dict[str, Any] | None, redact_phones: bool = True
) -> tuple[list[str], str, str]:
    if not post_data:
        return [], "", ""

    mime_type = str(post_data.get("mimeType", ""))
    params = post_data.get("params") or []
    text = str(post_data.get("text", ""))

    keys = [str(item.get("name", "")) for item in params if item.get("name")]
    if text:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            form_keys = [key for key, _ in parse_qsl(text, keep_blank_values=True)]
            keys.extend(form_keys)
        else:
            keys.extend(_flatten_keys(parsed))

    return sorted(set(keys)), mime_type, _redact_text(text, redact_phones=redact_phones)


def _score(path: str, query_keys: list[str], body_keys: list[str], body: str) -> int:
    haystack = " ".join([path, *query_keys, *body_keys, body]).lower()
    return sum(1 for keyword in KEYWORDS if keyword.lower() in haystack)


def analyze_har(path: str | Path, host: str, redact_phones: bool = True) -> list[EndpointGroup]:
    har = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = har.get("log", {}).get("entries", [])
    groups: dict[tuple[str, str], EndpointGroup] = {}

    for entry in entries:
        request = entry.get("request", {})
        response = entry.get("response", {})
        url = str(request.get("url", ""))
        parsed = urlparse(url)

        if host and host not in parsed.netloc:
            continue
        if not _looks_like_api(entry):
            continue

        method = str(request.get("method", "GET")).upper()
        key = (method, parsed.path)
        group = groups.setdefault(
            key,
            EndpointGroup(method=method, path=parsed.path, sample_url=url),
        )

        query_keys = [key for key, _ in parse_qsl(parsed.query, keep_blank_values=True)]
        body_keys, mime_type, sample_body = _body_summary(
            request.get("postData"), redact_phones=redact_phones
        )

        group.count += 1
        group.statuses.update([int(response.get("status", 0) or 0)])
        group.query_keys.update(query_keys)
        group.body_keys.update(body_keys)
        if mime_type:
            group.content_types.update([mime_type])
        if sample_body and not group.sample_body:
            group.sample_body = sample_body
        group.score = max(group.score, _score(parsed.path, query_keys, body_keys, sample_body))

    return sorted(groups.values(), key=lambda item: (-item.score, -item.count, item.path))


def _format_counter(counter: Counter[Any], limit: int = 8) -> str:
    return ", ".join(str(key) for key, _ in counter.most_common(limit)) or "-"


def print_report(groups: list[EndpointGroup], redact_phones: bool = True) -> None:
    print(f"candidate API groups: {len(groups)}")
    phone_note = "phone numbers are redacted" if redact_phones else "phone numbers are kept"
    print(f"sensitive headers are intentionally omitted; {phone_note}")
    print()
    for group in groups:
        print(f"[score={group.score}] {group.method} {group.path}")
        print(f"  count: {group.count}")
        print(f"  statuses: {_format_counter(group.statuses)}")
        print(f"  query keys: {_format_counter(group.query_keys)}")
        print(f"  body keys: {_format_counter(group.body_keys)}")
        print(f"  content types: {_format_counter(group.content_types)}")
        if group.sample_body:
            print(f"  sample body: {group.sample_body}")
        print()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze exported Chrome HAR files.")
    parser.add_argument("har_path", help="Path to a HAR file exported from Network.")
    parser.add_argument(
        "--host",
        default="admin.cotticoffee.com",
        help="Only include requests whose host contains this value.",
    )
    parser.add_argument("--keep-phones", action="store_true", help="Keep phone numbers in samples.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    redact_phones = not args.keep_phones
    print_report(analyze_har(args.har_path, args.host, redact_phones=redact_phones), redact_phones)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
