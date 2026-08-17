from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from .pipelines.common import ParsedTicket
from .pipelines.coupon_ticket import parse_coupon_ticket
from .pipelines.invite_ticket import parse_invite_ticket
from .ticket_classifier import COUPON_TICKET, INVITE_TICKET, UNKNOWN_TICKET, classify_ticket
from .ticket_splitter import split_ticket_blocks


REPO_ROOT = Path(__file__).resolve().parents[1]
TMP_ROOT = REPO_ROOT / "tmp" / "gui-batches"


def parse_mixed_tickets(text: str) -> list[ParsedTicket]:
    parsed: list[ParsedTicket] = []
    for block in split_ticket_blocks(text):
        classified = classify_ticket(block)
        if classified.ticket_type == INVITE_TICKET:
            parsed.append(parse_invite_ticket(block))
        elif classified.ticket_type == COUPON_TICKET:
            parsed.append(parse_coupon_ticket(block))
        else:
            parsed.append(
                ParsedTicket(
                    index=block.index,
                    ticket_type=UNKNOWN_TICKET,
                    type_label="未识别",
                    title=block.title,
                    raw_text=block.raw_text,
                    status="unsupported",
                    errors=[classified.reason],
                )
            )
    return parsed


def default_batch_dir() -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return TMP_ROOT / timestamp


def _node_executable() -> str:
    configured = os.environ.get("TICKET_AUTOMATION_NODE")
    if configured:
        return configured
    bundled = (
        Path.home()
        / ".cache"
        / "codex-runtimes"
        / "codex-primary-runtime"
        / "dependencies"
        / "node"
        / "bin"
        / "node.exe"
    )
    if bundled.exists():
        return str(bundled)
    found = shutil.which("node")
    return found or "node"


def _safe_name(ticket: ParsedTicket) -> str:
    source = ticket.title or f"ticket-{ticket.index}"
    safe = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", source, flags=re.UNICODE).strip("-")
    return f"{ticket.index:03d}-{safe[:60] or 'ticket'}"


def _run_node(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [_node_executable(), *args],
        cwd=REPO_ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def run_invite_dry_run(ticket: ParsedTicket, batch_dir: Path | None = None) -> ParsedTicket:
    if ticket.ticket_type != INVITE_TICKET:
        ticket.status = "unsupported"
        ticket.errors = ["当前只支持招待券 dry-run。"]
        return ticket
    if not ticket.can_dry_run:
        return ticket

    batch_dir = batch_dir or default_batch_dir()
    batch_dir.mkdir(parents=True, exist_ok=True)
    base = _safe_name(ticket)
    dry_run_path = batch_dir / f"{base}-dry-run.json"
    log_path = batch_dir / f"{base}-dry-run.log"
    completed = _run_node(
        [
            "scripts/invite-ticket-dry-run.mjs",
            "--work-order-text",
            ticket.raw_text,
            "--out",
            str(dry_run_path),
        ]
    )
    log_path.write_text(completed.stdout, encoding="utf-8")

    if dry_run_path.exists():
        result = json.loads(dry_run_path.read_text(encoding="utf-8"))
        ticket.dry_run_file = str(dry_run_path)
        ticket.return_comment = result.get("returnComment")
        if result.get("ok"):
            ticket.status = "dry_run_ok"
            ticket.fields.update(
                {
                    "activity_names": result.get("workOrder", {}).get("activityNames", []),
                    "submit_quantities": result.get("workOrder", {}).get("submitQuantities", []),
                    "total_quantity": result.get("workOrder", {}).get("totalQuantity"),
                    "source_activity": next(
                        (
                            {
                                "mode": step.get("mode"),
                                "selected": step.get("selected"),
                                "same_store_candidates": step.get("candidates"),
                                "generic_candidates": step.get("genericCandidates"),
                            }
                            for step in result.get("steps", [])
                            if step.get("api") == "POST /activity/page"
                        ),
                        None,
                    ),
                    "import_result": next(
                        (
                            step.get("selected")
                            for step in result.get("steps", [])
                            if step.get("api") == "GET /member/getImportResult"
                        ),
                        None,
                    ),
                    "store_check": next(
                        (
                            step.get("selected")
                            for step in result.get("steps", [])
                            if step.get("api") == "POST /crowd/shop/list"
                        ),
                        None,
                    ),
                    "payload_count": len(result.get("payloads") or []),
                }
            )
            ticket.errors = []
        else:
            ticket.status = "fallback"
            ticket.errors = [result.get("fallbackReason") or "dry-run fallback"]
        return ticket

    ticket.status = "dry_run_error"
    ticket.errors = [completed.stdout.strip() or f"dry-run exited with code {completed.returncode}"]
    return ticket


def submit_invite_ticket(ticket: ParsedTicket) -> ParsedTicket:
    if not ticket.can_submit:
        return ticket

    dry_run_path = Path(ticket.dry_run_file or "")
    submit_path = dry_run_path.with_name(dry_run_path.name.replace("-dry-run.json", "-submit-result.json"))
    log_path = dry_run_path.with_name(dry_run_path.name.replace("-dry-run.json", "-submit-result.log"))
    completed = _run_node(
        [
            "scripts/invite-ticket-submit.mjs",
            "--dry-run-file",
            str(dry_run_path),
            "--out",
            str(submit_path),
            "--confirm-submit",
        ]
    )
    log_path.write_text(completed.stdout, encoding="utf-8")

    if not submit_path.exists():
        ticket.status = "submit_error"
        ticket.errors = [completed.stdout.strip() or f"submit exited with code {completed.returncode}"]
        return ticket

    result = json.loads(submit_path.read_text(encoding="utf-8"))
    ticket.submit_result_file = str(submit_path)
    results = result.get("results", [])
    ok = bool(results) and all(item.get("response", {}).get("status") == 0 for item in results)
    ticket.status = "submitted" if ok else "submit_error"
    ticket.fields["submit_results"] = results
    ticket.fields["post_checks"] = [item.get("postCheck") for item in results]
    ticket.errors = [] if ok else ["中台提交返回异常，请查看提交结果 JSON。"]
    return ticket


def tickets_to_dicts(tickets: list[ParsedTicket]) -> list[dict]:
    return [asdict(ticket) for ticket in tickets]
