from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ParsedTicket:
    index: int
    ticket_type: str
    type_label: str
    title: str
    raw_text: str
    status: str
    fields: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    return_comment: str | None = None
    dry_run_file: str | None = None
    submit_result_file: str | None = None

    @property
    def can_dry_run(self) -> bool:
        return self.status == "parsed" and not self.errors

    @property
    def can_submit(self) -> bool:
        return self.status == "dry_run_ok" and bool(self.dry_run_file)
