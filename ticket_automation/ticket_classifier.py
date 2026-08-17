from __future__ import annotations

from dataclasses import dataclass

from .ticket_splitter import TicketBlock


INVITE_TICKET = "invite_ticket"
COUPON_TICKET = "coupon_ticket"
UNKNOWN_TICKET = "unknown"


@dataclass(frozen=True)
class ClassifiedTicket:
    block: TicketBlock
    ticket_type: str
    type_label: str
    reason: str


def classify_ticket(block: TicketBlock) -> ClassifiedTicket:
    haystack = f"{block.title}\n{block.raw_text}"
    if "联营门店招待券申请" in haystack or "招待券申请" in haystack:
        return ClassifiedTicket(block, INVITE_TICKET, "招待券发放", "标题包含招待券申请")
    if "优惠券" in haystack:
        return ClassifiedTicket(block, COUPON_TICKET, "优惠券", "文本包含优惠券")
    return ClassifiedTicket(block, UNKNOWN_TICKET, "未识别", "没有命中已支持的工单类型")
