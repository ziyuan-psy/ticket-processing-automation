from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlparse

from .har_analyzer import EndpointGroup, _flatten_keys, _format_counter, _redact_text


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
    "member",
    "crowd",
    "phone",
    "mobile",
    "优惠券",
    "招待",
    "门店",
    "模板",
    "活动",
)


def _normalize_redacted_json(text: str) -> str:
    return re.sub(r"(?<=:)<phone>(?=[,}])", '"<phone>"', text)


def _host_matches(netloc: str, host: str) -> bool:
    if not host:
        return True
    host_parts = [item.strip() for item in host.split(",") if item.strip()]
    if not host_parts:
        return True
    return any(item in netloc for item in host_parts)


def _body_keys(post_data: str) -> list[str]:
    if not post_data:
        return []

    try:
        parsed = json.loads(_normalize_redacted_json(post_data))
    except json.JSONDecodeError:
        return [key for key, _ in parse_qsl(post_data, keep_blank_values=True)]
    return _flatten_keys(parsed)


def _score(path: str, query_keys: list[str], body_keys: list[str], body: str) -> int:
    haystack = " ".join([path, *query_keys, *body_keys, body]).lower()
    return sum(1 for keyword in KEYWORDS if keyword.lower() in haystack)


def analyze_cdp_log(
    path: str | Path, host: str, redact_phones: bool = True
) -> list[EndpointGroup]:
    groups: dict[tuple[str, str], EndpointGroup] = {}
    request_groups: dict[tuple[str, str], tuple[str, str]] = {}
    pending_statuses: dict[tuple[str, str], int] = {}

    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue

        event = json.loads(line)
        event_type = event.get("event")
        url = str(event.get("url", ""))
        parsed = urlparse(url)
        if not _host_matches(parsed.netloc, host):
            continue

        if event_type == "response":
            request_key = (str(event.get("sessionId")), str(event.get("requestId")))
            status = int(event.get("status", 0) or 0)
            group_key = request_groups.get(request_key)
            if group_key and group_key in groups:
                groups[group_key].statuses.update([status])
            else:
                pending_statuses[request_key] = status
            continue

        if event_type != "request":
            continue

        method = str(event.get("method", "GET")).upper()
        key = (method, parsed.path)
        group = groups.setdefault(
            key,
            EndpointGroup(method=method, path=parsed.path, sample_url=url),
        )
        request_key = (str(event.get("sessionId")), str(event.get("requestId")))
        request_groups[request_key] = key
        if request_key in pending_statuses:
            group.statuses.update([pending_statuses.pop(request_key)])

        query_keys = [key for key, _ in parse_qsl(parsed.query, keep_blank_values=True)]
        body = str(event.get("postData", ""))
        body_keys = _body_keys(body)

        group.count += 1
        group.query_keys.update(query_keys)
        group.body_keys.update(body_keys)
        if body and not group.sample_body:
            group.sample_body = _redact_text(body, redact_phones=redact_phones)
        group.score = max(group.score, _score(parsed.path, query_keys, body_keys, body))

    return sorted(groups.values(), key=lambda item: (-item.score, -item.count, item.path))


def print_report(groups: list[EndpointGroup], redact_phones: bool = True) -> None:
    print(f"candidate API groups: {len(groups)}")
    phone_note = "phone numbers are redacted" if redact_phones else "phone numbers are kept"
    print(f"sensitive credentials are redacted by the recorder; {phone_note}")
    print()
    for group in groups:
        print(f"[score={group.score}] {group.method} {group.path}")
        print(f"  count: {group.count}")
        print(f"  statuses: {_format_counter(group.statuses)}")
        print(f"  query keys: {_format_counter(group.query_keys)}")
        print(f"  body keys: {_format_counter(group.body_keys)}")
        if group.sample_body:
            print(f"  sample body: {group.sample_body}")
        print()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze CDP network NDJSON logs.")
    parser.add_argument("path", help="Path to a CDP network NDJSON log.")
    parser.add_argument("--host", default="cotticoffee.com,yummy.tech,abite.com")
    parser.add_argument("--keep-phones", action="store_true", help="Keep phone numbers in samples.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    redact_phones = not args.keep_phones
    print_report(analyze_cdp_log(args.path, args.host, redact_phones=redact_phones), redact_phones)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
