from __future__ import annotations

from ..ticket_classifier import COUPON_TICKET
from ..ticket_splitter import TicketBlock
from .common import ParsedTicket


def parse_coupon_ticket(block: TicketBlock) -> ParsedTicket:
    return ParsedTicket(
        index=block.index,
        ticket_type=COUPON_TICKET,
        type_label="优惠券",
        title=block.title,
        raw_text=block.raw_text,
        status="unsupported",
        fields={"title": block.title},
        errors=["优惠券工单 parser 尚未接入，后续按优惠券 SOP 增加。"],
    )
