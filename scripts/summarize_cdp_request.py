from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlparse


def _normalize_redacted_json(text: str) -> str:
    return re.sub(r"(?<=:)<phone>(?=[,}])", '"<phone>"', text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Summarize one request path from a CDP NDJSON log.")
    parser.add_argument("path")
    parser.add_argument("--host", required=True)
    parser.add_argument("--request-path", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    seen: set[str] = set()
    count = 0
    for line in Path(args.path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("event") != "request":
            continue
        if event.get("method") == "OPTIONS":
            continue

        parsed = urlparse(str(event.get("url", "")))
        if parsed.netloc != args.host or parsed.path != args.request_path:
            continue

        body = event.get("postData") or ""
        if not body:
            continue
        if body in seen:
            continue
        seen.add(body)
        count += 1

        print(f"unique payload #{count}")
        try:
            data = json.loads(_normalize_redacted_json(body))
        except json.JSONDecodeError:
            print(body)
            continue

        print("top keys:", ", ".join(data.keys()))
        interesting_keys = [
            "id",
            "activityNo",
            "activityType",
            "activityName",
            "activityDesc",
            "activityStartTime",
            "activityEndTime",
            "activityStatus",
            "shopExtend",
            "putShopType",
            "shopMdCode",
            "startTimeType",
            "putPeopleType",
            "excelKey",
            "channel",
            "channelInfo",
        ]
        for key in interesting_keys:
            print(f"{key}: {data.get(key)!r}")

        for key in [
            "couponTemplateVOList",
            "couponTemplateSaveParamList",
            "manualSendCouponMaterial",
            "extendInfo",
        ]:
            print(f"{key}: {json.dumps(data.get(key), ensure_ascii=False)}")

        for key in ["memberVOList", "memberSaveParamList", "sensorsUserGroupList"]:
            value = data.get(key)
            print(f"{key}_len: {len(value) if isinstance(value, list) else 'n/a'}")
    print(f"unique payloads: {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
