from __future__ import annotations

import argparse
import json
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract matching sources from a sourcemap.")
    parser.add_argument("map_path")
    parser.add_argument("--contains", action="append", default=[])
    parser.add_argument("--out-dir", default="tmp/sources")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    source_map = json.loads(Path(args.map_path).read_text(encoding="utf-8"))
    sources = source_map.get("sources", [])
    contents = source_map.get("sourcesContent", [])
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    matched = 0
    for source, content in zip(sources, contents):
        if args.contains and not any(term in source or term in content for term in args.contains):
            continue
        safe_name = source.replace("webpack://marketing-admin/./src/", "")
        safe_name = safe_name.replace("webpack://marketing-admin/", "")
        safe_name = safe_name.lstrip("./").replace("../", "")
        for char in '<>:"|?*':
            safe_name = safe_name.replace(char, "_")
        out_path = out_dir / safe_name
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(content, encoding="utf-8")
        matched += 1
        print(out_path)

    print(f"matched sources: {matched}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
