from __future__ import annotations

import re
from dataclasses import dataclass


TITLE_RE = re.compile(r"(?:^|\s)(?:标题\s*)?(券申请-[^\r\n]+)")


@dataclass(frozen=True)
class TicketBlock:
    index: int
    title: str
    raw_text: str


def _clean_lines(text: str) -> list[str]:
    return [line.strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]


def _line_title(line: str) -> str | None:
    stripped = line.strip()
    if not stripped:
        return None
    if stripped.startswith("标题"):
        value = stripped.removeprefix("标题").strip(" \t:：")
        if value.startswith("券申请-"):
            return value
    match = TITLE_RE.search(stripped)
    return match.group(1).strip() if match else None


def split_ticket_blocks(text: str) -> list[TicketBlock]:
    lines = _clean_lines(text)
    starts: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
      title = _line_title(line)
      if title:
          starts.append((index, title))

    if not starts:
        stripped = text.strip()
        return [TicketBlock(index=1, title="", raw_text=stripped)] if stripped else []

    blocks: list[TicketBlock] = []
    for block_index, (start, title) in enumerate(starts, start=1):
        end = starts[block_index][0] if block_index < len(starts) else len(lines)
        raw_text = "\n".join(line for line in lines[start:end] if line.strip()).strip()
        if raw_text:
            blocks.append(TicketBlock(index=block_index, title=title, raw_text=raw_text))
    return blocks
