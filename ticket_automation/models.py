from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PHONE_RE = re.compile(r"^1[3-9]\d{9}$")
PHONE_IN_TEXT_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
DEFAULT_INVITE_COUPON_TEMPLATE_ID = "CT20250521000001"
DEFAULT_COUPON_SOURCE_ACTIVITY_NO = "47678430008262656"
MAX_INVITE_COUPONS_PER_PHONE = 200
MAX_INVITE_COUPONS_PER_SUBMIT = 100
MAX_COUPONS_PER_PHONE = 200
MAX_COUPONS_PER_SUBMIT = 100

DISCOUNT_COUPON_TEMPLATES = {
    "9折": "CT20231226000001",
    "8折": "CT20231223000003",
    "8.5折": "CT20250710000002",
    "8.8折": "CT20231226000002",
    "6.8折": "CT20240105000003",
    "95折": "CT20260616000005",
    "8.3折": "CT20260129000001",
    "7.9折": "CT20240220000001",
    "7.7折": "CT20231224000002",
}

FIXED_PRICE_COUPON_TEMPLATES = {
    "9.9元": "CT20231220000010",
    "12.9元": "CT20260420000004",
    "22元": "CT20260814000011",
    "10.9元": "CT20260224000001",
    "8.8元": "CT20231215000003",
    "22.5元": "CT20260408000010",
    "15元": "CT20260622000007",
    "9元": "CT20240104000001",
}


class ValidationError(ValueError):
    """Raised when a work order does not satisfy the local SOP checks."""


def _required_text(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{field_name} is required")
    return value.strip()


def _positive_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(f"{field_name} must be an integer")
    if value <= 0:
        raise ValidationError(f"{field_name} must be greater than 0")
    return value


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def extract_phone_numbers(value: Any) -> list[str]:
    if isinstance(value, list):
        source = " ".join(str(item or "") for item in value)
    else:
        source = str(value or "")
    return _dedupe(PHONE_IN_TEXT_RE.findall(source))


def _split_submit_quantities(quantity: int, max_per_submit: int) -> list[int]:
    if quantity <= max_per_submit:
        return [quantity]
    return [max_per_submit, quantity - max_per_submit]


def normalize_store_code(value: Any) -> str:
    store_code = _required_text(value, "store_code").upper()
    if store_code.isdigit():
        return f"JD{store_code}"
    if not re.fullmatch(r"(?:JD\d+|Q[A-Z0-9]+)", store_code):
        raise ValidationError("store_code must be JD+digits, Q-prefixed, or digits only")
    return store_code


def _format_number(value: float) -> str:
    text = f"{value:.10g}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def normalize_discount_value(value: Any) -> str:
    text = _required_text(value, "coupon_value").replace("％", "%").replace("%", "").replace(" ", "")
    match = re.search(r"\d+(?:\.\d+)?", text)
    if not match:
        raise ValidationError("coupon discount is required")
    number = float(match.group(0))
    if number == 9.5 or number == 95:
        return "95折"
    if number >= 10:
        number = number / 10
    return f"{_format_number(number)}折"


def normalize_fixed_price_value(value: Any) -> str:
    text = _required_text(value, "coupon_value").replace("元", "").replace(" ", "")
    match = re.search(r"\d+(?:\.\d+)?", text)
    if not match:
        raise ValidationError("coupon price is required")
    return f"{_format_number(float(match.group(0)))}元"


@dataclass(frozen=True)
class StoreRef:
    store_code: str
    store_name: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StoreRef":
        return cls(
            store_code=normalize_store_code(data.get("store_code")),
            store_name=_required_text(data.get("store_name"), "store_name"),
        )


@dataclass(frozen=True)
class InviteTicketIssue:
    store_code: str
    store_name: str
    coupon_template_id: str
    quantity_per_phone: int
    phones: list[str]
    activity_name: str | None = None

    workflow_type = "invite_ticket_issue"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "InviteTicketIssue":
        normalized_phones = extract_phone_numbers(data.get("phones"))
        if not normalized_phones:
            raise ValidationError("phones must be a non-empty list")

        return cls(
            store_code=normalize_store_code(data.get("store_code")),
            store_name=_required_text(data.get("store_name"), "store_name"),
            coupon_template_id=_required_text(
                data.get("coupon_template_id", DEFAULT_INVITE_COUPON_TEMPLATE_ID),
                "coupon_template_id",
            ),
            quantity_per_phone=_positive_int(
                data.get("quantity_per_phone"), "quantity_per_phone"
            ),
            phones=_dedupe(normalized_phones),
            activity_name=(
                _required_text(data.get("activity_name"), "activity_name")
                if data.get("activity_name") is not None
                else None
            ),
        )

    @property
    def total_quantity(self) -> int:
        return self.quantity_per_phone * len(self.phones)

    @property
    def submit_quantities(self) -> list[int]:
        if self.quantity_per_phone <= MAX_INVITE_COUPONS_PER_SUBMIT:
            return [self.quantity_per_phone]
        return [MAX_INVITE_COUPONS_PER_SUBMIT, self.quantity_per_phone - MAX_INVITE_COUPONS_PER_SUBMIT]

    @property
    def suggested_activity_name(self) -> str:
        return self.activity_name or f"{self.store_name}-招待*{self.quantity_per_phone}"

    @property
    def expected_activity_name(self) -> str:
        return f"{self.store_name}-招待*{self.quantity_per_phone}"

    def validate(self) -> None:
        if self.quantity_per_phone > MAX_INVITE_COUPONS_PER_PHONE:
            raise ValidationError("quantity_per_phone must be <= 200")
        if self.activity_name and self.activity_name != self.expected_activity_name:
            raise ValidationError(
                "activity_name must match "
                f"{self.expected_activity_name!r} for invite ticket issues"
            )


@dataclass(frozen=True)
class CouponTicketIssue:
    store_code: str
    store_name: str
    coupon_type: str
    coupon_value: str
    coupon_template_id: str
    quantity_per_phone: int
    phones: list[str]
    source_activity_no: str = DEFAULT_COUPON_SOURCE_ACTIVITY_NO

    workflow_type = "coupon_ticket"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CouponTicketIssue":
        normalized_phones = extract_phone_numbers(data.get("phones"))
        if not normalized_phones:
            raise ValidationError("phones must be a non-empty list")

        raw_type = _required_text(data.get("coupon_type"), "coupon_type")
        raw_value = _required_text(data.get("coupon_value"), "coupon_value")
        if "折" in raw_type or "折" in raw_value:
            coupon_type = "discount"
            coupon_value = normalize_discount_value(raw_value)
            templates = DISCOUNT_COUPON_TEMPLATES
        elif "一口价" in raw_type or "金额" in raw_type:
            coupon_type = "fixed_price"
            coupon_value = normalize_fixed_price_value(raw_value)
            templates = FIXED_PRICE_COUPON_TEMPLATES
        else:
            raise ValidationError("coupon_type must be discount or fixed_price")

        coupon_template_id = templates.get(coupon_value)
        if not coupon_template_id:
            raise ValidationError("券金额/券折扣未匹配到已配置模板")

        return cls(
            store_code=normalize_store_code(data.get("store_code")),
            store_name=_required_text(data.get("store_name"), "store_name"),
            coupon_type=coupon_type,
            coupon_value=coupon_value,
            coupon_template_id=coupon_template_id,
            quantity_per_phone=_positive_int(data.get("quantity_per_phone"), "quantity_per_phone"),
            phones=_dedupe(normalized_phones),
        )

    @property
    def total_quantity(self) -> int:
        return self.quantity_per_phone * len(self.phones)

    @property
    def submit_quantities(self) -> list[int]:
        return _split_submit_quantities(self.quantity_per_phone, MAX_COUPONS_PER_SUBMIT)

    @property
    def activity_name_fragment(self) -> str:
        return f"优惠-{self.coupon_value}"

    def activity_name_for(self, quantity: int) -> str:
        return f"{self.store_name}{self.activity_name_fragment}*{quantity}"

    def validate(self) -> None:
        if self.quantity_per_phone > MAX_COUPONS_PER_PHONE:
            raise ValidationError("quantity_per_phone must be <= 200")


@dataclass(frozen=True)
class CouponStoreScope:
    coupon_template_id: str
    stores: list[StoreRef]

    workflow_type = "coupon_store_scope"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CouponStoreScope":
        stores_data = data.get("stores")
        if not isinstance(stores_data, list) or not stores_data:
            raise ValidationError("stores must be a non-empty list")

        stores = [
            StoreRef(
                store_code=normalize_store_code(item.get("store_code")),
                store_name=_required_text(item.get("store_name"), "store_name"),
            )
            for item in stores_data
        ]
        store_codes = [item.store_code for item in stores]
        if len(store_codes) != len(set(store_codes)):
            raise ValidationError("stores contains duplicate store_code values")

        return cls(
            coupon_template_id=_required_text(
                data.get("coupon_template_id"), "coupon_template_id"
            ),
            stores=stores,
        )

    def validate(self) -> None:
        return None


WorkOrder = InviteTicketIssue | CouponTicketIssue | CouponStoreScope


def parse_work_order(data: dict[str, Any]) -> WorkOrder:
    workflow_type = data.get("type")
    if workflow_type == InviteTicketIssue.workflow_type:
        work_order = InviteTicketIssue.from_dict(data)
    elif workflow_type == CouponTicketIssue.workflow_type:
        work_order = CouponTicketIssue.from_dict(data)
    elif workflow_type == CouponStoreScope.workflow_type:
        work_order = CouponStoreScope.from_dict(data)
    else:
        raise ValidationError(f"unsupported work order type: {workflow_type}")

    work_order.validate()
    return work_order


def load_work_orders(path: str | Path) -> list[WorkOrder]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValidationError("work order file must contain a JSON array")
    return [parse_work_order(item) for item in raw]
