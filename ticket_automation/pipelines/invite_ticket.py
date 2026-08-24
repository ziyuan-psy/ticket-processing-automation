from __future__ import annotations

import re
from typing import Any

from ..models import DEFAULT_INVITE_COUPON_TEMPLATE_ID, InviteTicketIssue, ValidationError, extract_phone_numbers
from ..ticket_classifier import INVITE_TICKET
from ..ticket_splitter import TicketBlock
from .common import ParsedTicket


LABELS = {
    "标题": "title",
    "申请说明": "description",
    "申请原因": "reason",
    "券适用门店（仅适用联营商名下一家门店）": "store_name",
    "券适用门店": "store_name",
    "门店编号（JD开头）": "store_code",
    "门店编号": "store_code",
    "收券人手机号（多个手机号用；隔开，请确保手机号正确否则无法发送）": "phones",
    "收券人手机号": "phones",
    "单个手机号发券数量": "quantity_per_phone",
}


def _line_starts_with_label(line: str, label: str) -> bool:
    if line == label:
        return True
    return line.startswith(label) and re.match(r"^[:：\t\s]", line[len(label) :]) is not None


def _is_label_line(line: str) -> bool:
    return any(_line_starts_with_label(line, label) for label in LABELS)


def _parse_labeled_fields(text: str) -> dict[str, str]:
    lines = [line.strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if line.strip()]
    result: dict[str, str] = {}
    labels = sorted(LABELS, key=len, reverse=True)

    for index, line in enumerate(lines):
        matched_label = next((label for label in labels if _line_starts_with_label(line, label)), None)
        if not matched_label:
            continue
        key = LABELS[matched_label]
        value = ""
        if line != matched_label:
            value = line[len(matched_label) :].strip(" \t:：")
        parts = [value] if value else []
        for next_index in range(index + 1, len(lines)):
            if _is_label_line(lines[next_index]):
                break
            parts.append(lines[next_index])
        collected = " ".join(part for part in parts if part).strip()
        if collected:
            result[key] = collected
    return result


def _normalize_phones(value: str) -> list[str]:
    return extract_phone_numbers(value)


def _quantity(value: Any) -> int | None:
    match = re.search(r"\d+", str(value or ""))
    return int(match.group(0)) if match else None


def parse_invite_ticket(block: TicketBlock) -> ParsedTicket:
    fields = _parse_labeled_fields(block.raw_text)
    title = fields.get("title") or block.title
    parsed_fields: dict[str, Any] = {
        "title": title,
        "store_name": fields.get("store_name", ""),
        "store_code": fields.get("store_code", ""),
        "phones": _normalize_phones(fields.get("phones", "")),
        "quantity_per_phone": _quantity(fields.get("quantity_per_phone")),
        "coupon_template_id": DEFAULT_INVITE_COUPON_TEMPLATE_ID,
    }

    try:
        issue = InviteTicketIssue.from_dict(parsed_fields)
        issue.validate()
        parsed_fields.update(
            {
                "store_code": issue.store_code,
                "phones": issue.phones,
                "quantity_per_phone": issue.quantity_per_phone,
                "submit_quantities": issue.submit_quantities,
                "total_quantity": issue.total_quantity,
                "activity_names": [f"{issue.store_name}-招待*{quantity}" for quantity in issue.submit_quantities],
            }
        )
        return ParsedTicket(
            index=block.index,
            ticket_type=INVITE_TICKET,
            type_label="招待券发放",
            title=title,
            raw_text=block.raw_text,
            status="parsed",
            fields=parsed_fields,
        )
    except ValidationError as error:
        return ParsedTicket(
            index=block.index,
            ticket_type=INVITE_TICKET,
            type_label="招待券发放",
            title=title,
            raw_text=block.raw_text,
            status="parse_error",
            fields=parsed_fields,
            errors=[str(error)],
        )
