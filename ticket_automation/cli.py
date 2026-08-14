from __future__ import annotations

import argparse

from .cdp_log_analyzer import analyze_cdp_log
from .cdp_log_analyzer import print_report as print_cdp_report
from .har_analyzer import analyze_har, print_report
from .js_endpoint_extractor import extract as extract_js_endpoints
from .models import CouponStoreScope, InviteTicketIssue, load_work_orders


def _validate(path: str) -> int:
    work_orders = load_work_orders(path)
    print(f"valid work orders: {len(work_orders)}")
    for index, order in enumerate(work_orders, start=1):
        if isinstance(order, InviteTicketIssue):
            print(
                f"{index}. invite_ticket_issue "
                f"store={order.store_code}/{order.store_name} "
                f"template={order.coupon_template_id} "
                f"phones={len(order.phones)} "
                f"quantity_per_phone={order.quantity_per_phone} "
                f"total={order.total_quantity} "
                f"submit_quantities={order.submit_quantities} "
                f"activity={order.expected_activity_name}"
            )
        elif isinstance(order, CouponStoreScope):
            print(
                f"{index}. coupon_store_scope "
                f"template={order.coupon_template_id} stores={len(order.stores)}"
            )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Ticket processing automation helpers.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="Validate work order JSON.")
    validate.add_argument("path")

    har = subparsers.add_parser("analyze-har", help="Analyze exported Network HAR.")
    har.add_argument("har_path")
    har.add_argument("--host", default="admin.cotticoffee.com")
    har.add_argument("--keep-phones", action="store_true", help="Keep phone numbers in samples.")

    cdp = subparsers.add_parser("analyze-cdp-log", help="Analyze CDP recorder NDJSON.")
    cdp.add_argument("path")
    cdp.add_argument("--host", default="cotticoffee.com,yummy.tech,abite.com")
    cdp.add_argument("--keep-phones", action="store_true", help="Keep phone numbers in samples.")

    js = subparsers.add_parser("extract-js-endpoints", help="Extract likely endpoints from JS bundles.")
    js.add_argument("paths", nargs="+")
    js.add_argument("--keyword", action="append", default=[])

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "validate":
        return _validate(args.path)
    if args.command == "analyze-har":
        redact_phones = not args.keep_phones
        print_report(
            analyze_har(args.har_path, args.host, redact_phones=redact_phones),
            redact_phones=redact_phones,
        )
        return 0
    if args.command == "analyze-cdp-log":
        redact_phones = not args.keep_phones
        print_cdp_report(
            analyze_cdp_log(args.path, args.host, redact_phones=redact_phones),
            redact_phones=redact_phones,
        )
        return 0
    if args.command == "extract-js-endpoints":
        results = extract_js_endpoints(args.paths, args.keyword)
        for path, values in results.items():
            print(f"== {path} ==")
            for value in sorted(values):
                print(value)
            print()
        return 0
    raise ValueError(f"unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
