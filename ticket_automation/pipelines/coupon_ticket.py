from __future__ import annotations

import re
from typing import Any

from ..models import CouponTicketIssue, ValidationError, extract_phone_numbers
from ..ticket_classifier import COUPON_TICKET
from ..ticket_splitter import TicketBlock
from .common import ParsedTicket


LABELS = {
    "标题": "title",
    "门店所在省份": "province",
    "门店名称（请与后台名称一致）": "store_name",
    "门店名称": "store_name",
    "门店编号（JD开头）": "store_code",
    "门店编号": "store_code",
    "申请券类型（默认饮品）": "coupon_type",
    "申请券类型": "coupon_type",
    "券说明": "coupon_desc",
    "券金额/券折扣": "coupon_value",
    "接受券手机号（请二次检查，发错不能撤回）": "phones",
    "接受券手机号": "phones",
    "发放张数": "quantity_per_phone",
    "备注": "remark",
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


def parse_coupon_ticket(block: TicketBlock) -> ParsedTicket:
    fields = _parse_labeled_fields(block.raw_text)
    title = fields.get("title") or block.title
    parsed_fields: dict[str, Any] = {
        "title": title,
        "store_name": fields.get("store_name", ""),
        "store_code": fields.get("store_code", ""),
        "coupon_type": fields.get("coupon_type", ""),
        "coupon_value": fields.get("coupon_value", ""),
        "phones": _normalize_phones(fields.get("phones", "")),
        "quantity_per_phone": _quantity(fields.get("quantity_per_phone")),
        "remark": fields.get("remark", ""),
    }

    try:
        issue = CouponTicketIssue.from_dict(parsed_fields)
        issue.validate()
        parsed_fields.update(
            {
                "store_code": issue.store_code,
                "phones": issue.phones,
                "coupon_type": issue.coupon_type,
                "coupon_value": issue.coupon_value,
                "coupon_template_id": issue.coupon_template_id,
                "source_activity_no": issue.source_activity_no,
                "activity_name_fragment": issue.activity_name_fragment,
                "quantity_per_phone": issue.quantity_per_phone,
                "submit_quantities": issue.submit_quantities,
                "total_quantity": issue.total_quantity,
                "activity_names": [issue.activity_name_for(quantity) for quantity in issue.submit_quantities],
            }
        )
        return ParsedTicket(
            index=block.index,
            ticket_type=COUPON_TICKET,
            type_label="优惠券发放",
            title=title,
            raw_text=block.raw_text,
            status="parsed",
            fields=parsed_fields,
        )
    except ValidationError as error:
        message = str(error)
        status = "fallback" if message == "券金额/券折扣未匹配到已配置模板" else "parse_error"
        return ParsedTicket(
            index=block.index,
            ticket_type=COUPON_TICKET,
            type_label="优惠券发放",
            title=title,
            raw_text=block.raw_text,
            status=status,
            fields=parsed_fields,
            errors=[message],
        )
