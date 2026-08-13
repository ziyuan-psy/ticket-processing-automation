from __future__ import annotations

import argparse
import re
from collections import defaultdict
from pathlib import Path


URL_PROP_RE = re.compile(r"\b(?:baseURL|url):(['\"])(.*?)\1")
HTTP_RE = re.compile(r"(['\"])(https?://[^'\"]+)\1")
PATH_RE = re.compile(r"(['\"])(/[A-Za-z0-9][A-Za-z0-9_./?=&{}:$,-]*)\1")


def _interesting(value: str, keywords: list[str]) -> bool:
    if not keywords:
        return True
    lowered = value.lower()
    return any(keyword.lower() in lowered for keyword in keywords)


def extract(paths: list[Path], keywords: list[str]) -> dict[str, set[str]]:
    results: dict[str, set[str]] = defaultdict(set)
    for raw_path in paths:
        path = Path(raw_path)
        text = path.read_text(encoding="utf-8", errors="ignore")

        for match in URL_PROP_RE.finditer(text):
            value = match.group(2)
            if _interesting(value, keywords):
                results[str(path)].add(value)

        for match in HTTP_RE.finditer(text):
            value = match.group(2)
            if _interesting(value, keywords):
                results[str(path)].add(value)

        for match in PATH_RE.finditer(text):
            value = match.group(2)
            if _interesting(value, keywords):
                results[str(path)].add(value)

    return results


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract likely API endpoints from JS bundles.")
    parser.add_argument("paths", nargs="+")
    parser.add_argument(
        "--keyword",
        action="append",
        default=[],
        help="Only include endpoints containing this keyword. Can be passed multiple times.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    paths = [Path(path) for path in args.paths]
    results = extract(paths, args.keyword)
    for path, values in results.items():
        print(f"== {path} ==")
        for value in sorted(values):
            print(value)
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
