from __future__ import annotations

import argparse
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Print context around terms in a text file.")
    parser.add_argument("path")
    parser.add_argument("terms", nargs="+")
    parser.add_argument("--chars", type=int, default=260)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    text = Path(args.path).read_text(encoding="utf-8", errors="ignore")
    for term in args.terms:
        print(f"\n=== {term} ===")
        start = 0
        count = 0
        while True:
            index = text.find(term, start)
            if index < 0:
                break
            count += 1
            before = max(0, index - args.chars)
            after = min(len(text), index + len(term) + args.chars)
            context = text[before:after].replace("},{", "},\n{")
            print(f"idx {index}")
            print(context)
            start = index + len(term)
        print(f"count {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

