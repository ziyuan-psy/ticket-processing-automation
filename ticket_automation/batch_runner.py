from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from .pipelines.common import ParsedTicket
from .pipelines.coupon_ticket import parse_coupon_ticket
from .pipelines.invite_ticket import parse_invite_ticket
from .ticket_classifier import COUPON_TICKET, INVITE_TICKET, UNKNOWN_TICKET, classify_ticket
from .ticket_splitter import split_ticket_blocks


FROZEN = bool(getattr(sys, "frozen", False))
APP_ROOT = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parents[1]
REPO_ROOT = Path(getattr(sys, "_MEIPASS", APP_ROOT)) if FROZEN else APP_ROOT
APP_DATA_ROOT = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "TicketProcessingAutomation"
TMP_ROOT = (APP_DATA_ROOT if FROZEN else REPO_ROOT) / "tmp" / "gui-batches"
DEFAULT_CDP_URL = "http://127.0.0.1:9223"
ADMIN_HOME_URL = "https://admin.cotticoffee.com/#/index"
DEFAULT_CHROME_PROFILE_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "CottiTicketAutomationChrome"


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
    packaged = APP_ROOT / "runtime" / "node.exe"
    if packaged.exists():
        return str(packaged)
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


def _chrome_executable() -> str:
    configured = os.environ.get("TICKET_AUTOMATION_CHROME")
    candidates = [
        Path(configured) if configured else None,
        Path(os.environ.get("PROGRAMFILES", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return str(candidate)
    found = shutil.which("chrome")
    if found:
        return found
    raise FileNotFoundError("没有找到 Chrome，可设置环境变量 TICKET_AUTOMATION_CHROME 指向 chrome.exe。")


def open_admin_chrome() -> str:
    cdp_url = os.environ.get("TICKET_AUTOMATION_CDP_URL", DEFAULT_CDP_URL)
    parsed = urlparse(cdp_url)
    port = parsed.port or 9223
    profile_dir = Path(os.environ.get("TICKET_AUTOMATION_CHROME_PROFILE", str(DEFAULT_CHROME_PROFILE_DIR)))
    profile_dir.mkdir(parents=True, exist_ok=True)

    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen(
        [
            _chrome_executable(),
            f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile_dir}",
            "--no-first-run",
            ADMIN_HOME_URL,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    return f"已打开工单专用中台 Chrome（调试端口 {port}）。请在该窗口登录后再 dry-run。"


def check_cdp_ready() -> str | None:
    cdp_url = os.environ.get("TICKET_AUTOMATION_CDP_URL", DEFAULT_CDP_URL).rstrip("/")
    try:
        with urllib.request.urlopen(f"{cdp_url}/json/version", timeout=3):
            pass
    except (OSError, urllib.error.URLError) as error:
        return f"无法连接工单专用 Chrome 调试端口 {cdp_url}。请先点“打开中台 Chrome”并完成登录。原始错误：{error}"

    try:
        with urllib.request.urlopen(f"{cdp_url}/json/list", timeout=3) as response:
            targets = json.loads(response.read().decode("utf-8", errors="replace"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        return f"Chrome 调试端口已打开，但无法读取页面列表。请关闭工单专用 Chrome 后重新点“打开中台 Chrome”。原始错误：{error}"

    page_targets = [
        target
        for target in targets
        if target.get("type") == "page" and not str(target.get("url", "")).startswith("devtools://")
    ]
    if not page_targets:
        return "Chrome 调试端口已打开，但没有可用中台页面。请关闭工单专用 Chrome 后重新点“打开中台 Chrome”。"
    return None


def _safe_name(ticket: ParsedTicket) -> str:
    source = ticket.title or f"ticket-{ticket.index}"
    safe = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", source, flags=re.UNICODE).strip("-")
    return f"{ticket.index:03d}-{safe[:60] or 'ticket'}"


def _run_node(args: list[str]) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["CDP_URL"] = env.get("TICKET_AUTOMATION_CDP_URL", DEFAULT_CDP_URL)
    return subprocess.run(
        [_node_executable(), *args],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def _friendly_error(text: str) -> str:
    cleaned = " ".join((text or "").split())
    if "CDP command timed out: Runtime.evaluate" in cleaned or "Runtime.evaluate timeout" in cleaned:
        return "Chrome 页面运行时没有响应（Runtime.evaluate 超时）。请关闭工单专用 Chrome，重新点“打开中台 Chrome”并登录后再 dry-run。"
    if "CDP command timed out: Runtime.enable" in cleaned or "Runtime.enable timeout" in cleaned:
        return "Chrome 调试通道卡住了（Runtime.enable 超时）。请关闭当前 remote-debugging Chrome，重新用 run_app/启动命令打开登录中台，再重新 dry-run。"
    if "CDP command timed out:" in cleaned:
        return f"Chrome 调试通道超时，请重启 remote-debugging Chrome 后再试。原始错误：{cleaned}"
    if "No usable admin/marketing token found" in cleaned:
        detail = ""
        marker = "Available page targets:"
        if marker in cleaned:
            detail = " 当前检测到：" + cleaned.split(marker, 1)[1].strip()
        return "已找到运营中台标签页，但页面没有可用登录态；如果停在首页，请确认这个 remote-debugging Chrome 里的 admin.cotticoffee.com 是正常首页而不是浏览器错误页。" + detail
    if "Launched marketing page but no token became available" in cleaned:
        return "脚本已从首页尝试打开营销活动页，但营销页没有拿到 token；请在同一个 Chrome 中刷新/重新登录中台后再 dry-run。"
    if "No marketingweb tab/iframe found" in cleaned or "No admin/marketing tab found" in cleaned:
        detail = ""
        marker = "Available page targets:"
        if marker in cleaned:
            detail = " 当前检测到：" + cleaned.split(marker, 1)[1].strip()
        return "未找到可用的运营中台页面，请确认是在 remote-debugging Chrome 中打开并登录 admin.cotticoffee.com。" + detail
    if "No token found in current marketing page" in cleaned:
        return "当前运营中台页面没有登录 token，请重新登录后再 dry-run。"
    if "No matching fixed source activity found" in cleaned:
        match = re.search(r"fixedTemplateActivityNo=([0-9]+)", cleaned)
        activity_no = match.group(1) if match else "对应"
        return f"没有查到固定源活动编号 {activity_no}，请确认当前账号/品牌下能访问该活动。"
    if "store search returned no rows" in cleaned:
        return "中台没有搜到该门店，请检查门店名称和门店编号。"
    return cleaned or "执行失败，但脚本没有返回错误文本。"


def _submit_response_message(item: dict) -> str:
    response = item.get("response")
    if isinstance(response, dict):
        for key in ("msg", "message", "data", "error"):
            value = response.get(key)
            if value:
                return str(value)
    return str(item.get("responseText") or item.get("statusText") or "")


def _is_running_activity_error(item: dict) -> bool:
    retry_info = item.get("retryInfo")
    if isinstance(retry_info, dict) and "中台忙/发券任务未完成" in str(retry_info.get("reason", "")):
        return True
    response = item.get("response")
    return isinstance(response, dict) and response.get("status") == -2 and "正在执行" in _submit_response_message(item)


def _submit_retry_summary(results: list[dict]) -> str:
    parts = []
    for index, item in enumerate(results, start=1):
        retry_info = item.get("retryInfo")
        if not isinstance(retry_info, dict):
            continue
        response = item.get("response") if isinstance(item.get("response"), dict) else {}
        final_ok = response.get("status") == 0
        status = "成功" if final_ok else "仍失败"
        parts.append(f"第{index}批中台忙后重试{retry_info.get('retryCount', 0)}次，最终{status}")
    return "；".join(parts)


def _summarize_submit_errors(results: list[dict]) -> list[str]:
    errors = []
    for index, item in enumerate(results, start=1):
        response = item.get("response") if isinstance(item.get("response"), dict) else {}
        if response.get("status") == 0:
            continue
        message = _submit_response_message(item) or "中台未返回明确错误原因"
        if _is_running_activity_error(item):
            retry_info = item.get("retryInfo") if isinstance(item.get("retryInfo"), dict) else {}
            retry_count = retry_info.get("retryCount", 0)
            errors.append(f"中台忙/发券任务未完成，已等待重试：第{index}批重试{retry_count}次后仍失败（{message}）")
        else:
            errors.append(f"第{index}批提交失败：{message}")
    return errors or ["中台提交返回异常，请查看提交结果 JSON。"]


def _dry_run_script_for(ticket: ParsedTicket) -> str | None:
    if ticket.ticket_type == INVITE_TICKET:
        return "scripts/invite-ticket-dry-run.mjs"
    if ticket.ticket_type == COUPON_TICKET:
        return "scripts/coupon-ticket-dry-run.mjs"
    return None


def _submit_script_for(ticket: ParsedTicket) -> str | None:
    if ticket.ticket_type == INVITE_TICKET:
        return "scripts/invite-ticket-submit.mjs"
    if ticket.ticket_type == COUPON_TICKET:
        return "scripts/coupon-ticket-submit.mjs"
    return None


def run_ticket_dry_run(ticket: ParsedTicket, batch_dir: Path | None = None) -> ParsedTicket:
    script = _dry_run_script_for(ticket)
    if script is None:
        ticket.status = "unsupported"
        ticket.errors = ["当前工单类型暂不支持 dry-run。"]
        return ticket
    if not ticket.can_dry_run:
        return ticket
    cdp_error = check_cdp_ready()
    if cdp_error:
        ticket.status = "dry_run_error"
        ticket.errors = [cdp_error]
        return ticket

    batch_dir = batch_dir or default_batch_dir()
    batch_dir.mkdir(parents=True, exist_ok=True)
    base = _safe_name(ticket)
    dry_run_path = batch_dir / f"{base}-dry-run.json"
    log_path = batch_dir / f"{base}-dry-run.log"
    completed = _run_node(
        [
            script,
            "--work-order-text",
            ticket.raw_text,
            "--out",
            str(dry_run_path),
        ]
    )
    log_path.write_text(completed.stdout, encoding="utf-8")
    ticket.fields["dry_run_log"] = str(log_path)

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
    ticket.errors = [_friendly_error(completed.stdout.strip() or f"dry-run exited with code {completed.returncode}")]
    return ticket


def run_invite_dry_run(ticket: ParsedTicket, batch_dir: Path | None = None) -> ParsedTicket:
    if ticket.ticket_type != INVITE_TICKET:
        ticket.status = "unsupported"
        ticket.errors = ["当前只支持招待券 dry-run。"]
        return ticket
    return run_ticket_dry_run(ticket, batch_dir)


def submit_ticket(ticket: ParsedTicket) -> ParsedTicket:
    if not ticket.can_submit:
        return ticket
    script = _submit_script_for(ticket)
    if script is None:
        ticket.status = "unsupported"
        ticket.errors = ["当前工单类型暂不支持提交。"]
        return ticket

    dry_run_path = Path(ticket.dry_run_file or "")
    submit_path = dry_run_path.with_name(dry_run_path.name.replace("-dry-run.json", "-submit-result.json"))
    log_path = dry_run_path.with_name(dry_run_path.name.replace("-dry-run.json", "-submit-result.log"))
    completed = _run_node(
        [
            script,
            "--dry-run-file",
            str(dry_run_path),
            "--out",
            str(submit_path),
            "--confirm-submit",
        ]
    )
    log_path.write_text(completed.stdout, encoding="utf-8")
    ticket.fields["submit_log"] = str(log_path)

    if not submit_path.exists():
        ticket.status = "submit_error"
        ticket.errors = [_friendly_error(completed.stdout.strip() or f"submit exited with code {completed.returncode}")]
        return ticket

    result = json.loads(submit_path.read_text(encoding="utf-8"))
    ticket.submit_result_file = str(submit_path)
    results = result.get("results", [])
    ok = bool(results) and all(item.get("response", {}).get("status") == 0 for item in results)
    ticket.status = "submitted" if ok else "submit_error"
    ticket.fields["submit_results"] = results
    ticket.fields["post_checks"] = [item.get("postCheck") for item in results]
    retry_summary = _submit_retry_summary(results)
    if retry_summary:
        ticket.fields["submit_retry_summary"] = retry_summary
    ticket.errors = [] if ok else _summarize_submit_errors(results)
    return ticket


def submit_invite_ticket(ticket: ParsedTicket) -> ParsedTicket:
    if ticket.ticket_type != INVITE_TICKET:
        ticket.status = "unsupported"
        ticket.errors = ["当前只支持招待券提交。"]
        return ticket
    return submit_ticket(ticket)


def tickets_to_dicts(tickets: list[ParsedTicket]) -> list[dict]:
    return [asdict(ticket) for ticket in tickets]
