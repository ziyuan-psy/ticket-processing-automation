from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PHONE_RE = re.compile(r"^1[3-9]\d{9}$")
DEFAULT_INVITE_COUPON_TEMPLATE_ID = "CT20250521000001"


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


@dataclass(frozen=True)
class StoreRef:
    store_code: str
    store_name: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StoreRef":
        return cls(
            store_code=_required_text(data.get("store_code"), "store_code"),
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
        phones = data.get("phones")
        if not isinstance(phones, list) or not phones:
            raise ValidationError("phones must be a non-empty list")

        normalized_phones: list[str] = []
        for phone in phones:
            phone_text = _required_text(phone, "phone")
            if not PHONE_RE.fullmatch(phone_text):
                raise ValidationError(f"invalid phone number: {phone_text}")
            normalized_phones.append(phone_text)

        return cls(
            store_code=_required_text(data.get("store_code"), "store_code"),
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
    def suggested_activity_name(self) -> str:
        return self.activity_name or f"{self.store_name}-招待*{self.quantity_per_phone}"

    @property
    def expected_activity_name(self) -> str:
        return f"{self.store_name}-招待*{self.quantity_per_phone}"

    def validate(self) -> None:
        if self.quantity_per_phone > 100:
            raise ValidationError("quantity_per_phone must be <= 100")
        if self.total_quantity > 200:
            raise ValidationError("total quantity must be <= 200")
        if self.activity_name and self.activity_name != self.expected_activity_name:
            raise ValidationError(
                "activity_name must match "
                f"{self.expected_activity_name!r} for invite ticket issues"
            )


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

        stores = [StoreRef.from_dict(item) for item in stores_data]
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


WorkOrder = InviteTicketIssue | CouponStoreScope


def parse_work_order(data: dict[str, Any]) -> WorkOrder:
    workflow_type = data.get("type")
    if workflow_type == InviteTicketIssue.workflow_type:
        work_order = InviteTicketIssue.from_dict(data)
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
