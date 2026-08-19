from __future__ import annotations

import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

from ticket_automation.batch_runner import (
    default_batch_dir,
    parse_mixed_tickets,
    run_invite_dry_run,
    submit_invite_ticket,
)
from ticket_automation.pipelines.common import ParsedTicket


STATUS_LABELS = {
    "parsed": "已解析",
    "parse_error": "解析错误",
    "unsupported": "暂不支持",
    "dry_run_ok": "可提交",
    "dry_run_error": "dry-run错误",
    "fallback": "需退回",
    "submitted": "已提交",
    "submit_error": "提交错误",
}


class TicketAutomationApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("工单处理自动化")
        self.root.geometry("1400x860")
        self.tickets: list[ParsedTicket] = []
        self.submit_marks: set[int] = set()
        self.batch_dir: Path | None = None
        self._busy = False

        self._build_ui()

    def _build_ui(self) -> None:
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(1, weight=1)

        toolbar = ttk.Frame(self.root, padding=(10, 8))
        toolbar.grid(row=0, column=0, sticky="ew")
        toolbar.columnconfigure(8, weight=1)

        self.parse_button = ttk.Button(toolbar, text="解析工单", command=self.parse_tickets)
        self.parse_button.grid(row=0, column=0, padx=(0, 8))
        self.dry_run_button = ttk.Button(toolbar, text="批量 dry-run", command=self.dry_run_all)
        self.dry_run_button.grid(row=0, column=1, padx=(0, 8))
        self.select_all_button = ttk.Button(toolbar, text="全选可提交", command=self.mark_all_submittable)
        self.select_all_button.grid(row=0, column=2, padx=(0, 8))
        self.clear_marks_button = ttk.Button(toolbar, text="清除勾选", command=self.clear_submit_marks)
        self.clear_marks_button.grid(row=0, column=3, padx=(0, 8))
        self.submit_button = ttk.Button(toolbar, text="提交已勾选", command=self.submit_marked)
        self.submit_button.grid(row=0, column=4, padx=(0, 8))
        self.copy_comment_button = ttk.Button(toolbar, text="复制退回批示语", command=self.copy_return_comment)
        self.copy_comment_button.grid(row=0, column=5, padx=(0, 8))
        self.clear_button = ttk.Button(toolbar, text="清空", command=self.clear_all)
        self.clear_button.grid(row=0, column=6, padx=(0, 8))
        self.status_var = tk.StringVar(value="粘贴泛微工单后点击“解析工单”。")
        ttk.Label(toolbar, textvariable=self.status_var).grid(row=0, column=8, sticky="e")

        panes = ttk.PanedWindow(self.root, orient=tk.VERTICAL)
        panes.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))

        input_frame = ttk.LabelFrame(panes, text="工单粘贴区", padding=6)
        input_frame.columnconfigure(0, weight=1)
        input_frame.rowconfigure(0, weight=1)
        self.input_text = tk.Text(input_frame, height=10, wrap="word", undo=True)
        input_scroll = ttk.Scrollbar(input_frame, orient=tk.VERTICAL, command=self.input_text.yview)
        self.input_text.configure(yscrollcommand=input_scroll.set)
        self.input_text.grid(row=0, column=0, sticky="nsew")
        input_scroll.grid(row=0, column=1, sticky="ns")
        panes.add(input_frame, weight=1)

        parse_frame = ttk.LabelFrame(panes, text="解析结果", padding=6)
        self.parse_tree = self._build_tree(
            parse_frame,
            columns=(
                "index",
                "type",
                "title",
                "status",
                "store",
                "store_code",
                "phones",
                "quantity",
                "split",
                "errors",
            ),
            headings={
                "index": "序号",
                "type": "类型",
                "title": "标题",
                "status": "解析状态",
                "store": "门店",
                "store_code": "门店编号",
                "phones": "手机号数",
                "quantity": "数量",
                "split": "拆分",
                "errors": "解析错误/说明",
            },
            widths={
                "index": 50,
                "type": 95,
                "title": 300,
                "status": 90,
                "store": 160,
                "store_code": 145,
                "phones": 80,
                "quantity": 70,
                "split": 90,
                "errors": 340,
            },
        )
        self.parse_tree.bind("<Double-1>", lambda _event: self.show_selected_detail(self.parse_tree))
        panes.add(parse_frame, weight=1)

        dry_run_frame = ttk.LabelFrame(panes, text="dry-run 明细与提交勾选", padding=6)
        self.dry_run_tree = self._build_tree(
            dry_run_frame,
            columns=(
                "mark",
                "index",
                "status",
                "error",
                "activity_names",
                "store_check",
                "import_result",
                "payloads",
                "return_comment",
                "post_check",
                "dry_run",
                "submit",
            ),
            headings={
                "mark": "提交?",
                "index": "序号",
                "status": "处理状态",
                "error": "错误原因",
                "activity_names": "活动名",
                "store_check": "门店校验",
                "import_result": "手机号导入",
                "payloads": "提交拆分",
                "return_comment": "退回批示语",
                "post_check": "提交后复查",
                "dry_run": "dry-run JSON",
                "submit": "提交 JSON",
            },
            widths={
                "mark": 60,
                "index": 50,
                "status": 90,
                "error": 320,
                "activity_names": 280,
                "store_check": 210,
                "import_result": 180,
                "payloads": 120,
                "return_comment": 260,
                "post_check": 260,
                "dry_run": 155,
                "submit": 155,
            },
        )
        self.dry_run_tree.bind("<Button-1>", self.on_dry_run_click)
        self.dry_run_tree.bind("<Double-1>", lambda _event: self.show_selected_detail(self.dry_run_tree))
        panes.add(dry_run_frame, weight=2)

    def _build_tree(
        self,
        parent: ttk.Frame,
        columns: tuple[str, ...],
        headings: dict[str, str],
        widths: dict[str, int],
    ) -> ttk.Treeview:
        parent.columnconfigure(0, weight=1)
        parent.rowconfigure(0, weight=1)
        tree = ttk.Treeview(parent, columns=columns, show="headings", selectmode="extended")
        for column in columns:
            tree.heading(column, text=headings[column])
            tree.column(column, width=widths[column], anchor="w", stretch=column in {"title", "errors", "activity_names", "return_comment", "post_check"})
        y_scroll = ttk.Scrollbar(parent, orient=tk.VERTICAL, command=tree.yview)
        x_scroll = ttk.Scrollbar(parent, orient=tk.HORIZONTAL, command=tree.xview)
        tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)
        tree.grid(row=0, column=0, sticky="nsew")
        y_scroll.grid(row=0, column=1, sticky="ns")
        x_scroll.grid(row=1, column=0, sticky="ew")
        return tree

    def _set_busy(self, busy: bool, message: str | None = None) -> None:
        self._busy = busy
        state = tk.DISABLED if busy else tk.NORMAL
        for button in [
            self.parse_button,
            self.dry_run_button,
            self.select_all_button,
            self.clear_marks_button,
            self.submit_button,
            self.copy_comment_button,
            self.clear_button,
        ]:
            button.configure(state=state)
        if message:
            self.status_var.set(message)

    def parse_tickets(self) -> None:
        text = self.input_text.get("1.0", tk.END).strip()
        if not text:
            messagebox.showinfo("没有输入", "请先粘贴工单信息。")
            return
        self.tickets = parse_mixed_tickets(text)
        self.submit_marks.clear()
        self.batch_dir = None
        self.refresh_tables()
        self.status_var.set(f"已解析 {len(self.tickets)} 个工单。")

    def clear_all(self) -> None:
        self.input_text.delete("1.0", tk.END)
        self.tickets = []
        self.submit_marks.clear()
        self.batch_dir = None
        self.refresh_tables()
        self.status_var.set("已清空。")

    def refresh_tables(self) -> None:
        self.refresh_parse_table()
        self.refresh_dry_run_table()

    def refresh_parse_table(self) -> None:
        self.parse_tree.delete(*self.parse_tree.get_children())
        for ticket in self.tickets:
            fields = ticket.fields
            values = (
                ticket.index,
                ticket.type_label,
                ticket.title,
                STATUS_LABELS.get(ticket.status, ticket.status),
                fields.get("store_name", ""),
                fields.get("store_code", ""),
                len(fields.get("phones") or []),
                fields.get("quantity_per_phone") or "",
                "+".join(str(item) for item in fields.get("submit_quantities") or []),
                "; ".join(ticket.errors),
            )
            self.parse_tree.insert("", tk.END, iid=str(ticket.index), values=values)

    def refresh_dry_run_table(self) -> None:
        self.submit_marks = {index for index in self.submit_marks if self._ticket_by_index(index) and self._ticket_by_index(index).can_submit}
        self.dry_run_tree.delete(*self.dry_run_tree.get_children())
        for ticket in self.tickets:
            if ticket.status in {"parsed", "parse_error", "unsupported"} and not ticket.dry_run_file:
                continue
            fields = ticket.fields
            values = (
                "☑" if ticket.index in self.submit_marks else "☐",
                ticket.index,
                STATUS_LABELS.get(ticket.status, ticket.status),
                self._error_text(ticket),
                self._activity_names(ticket),
                self._store_check(ticket),
                self._import_result(ticket),
                self._payloads(ticket),
                ticket.return_comment or "",
                self._post_check(ticket),
                Path(ticket.dry_run_file).name if ticket.dry_run_file else "",
                Path(ticket.submit_result_file).name if ticket.submit_result_file else "",
            )
            self.dry_run_tree.insert("", tk.END, iid=str(ticket.index), values=values)

    def _ticket_by_index(self, index: int) -> ParsedTicket | None:
        return next((ticket for ticket in self.tickets if ticket.index == index), None)

    def _activity_names(self, ticket: ParsedTicket) -> str:
        names = ticket.fields.get("activity_names") or []
        return "；".join(str(name) for name in names)

    def _error_text(self, ticket: ParsedTicket) -> str:
        return "；".join(ticket.errors)

    def _store_check(self, ticket: ParsedTicket) -> str:
        store = ticket.fields.get("store_check")
        if not store:
            return ""
        return f"{store.get('shopShowNo', '')}/{store.get('shopName', '')} {store.get('statusDesc', '')} {store.get('operationModeDesc', '')}".strip()

    def _import_result(self, ticket: ParsedTicket) -> str:
        result = ticket.fields.get("import_result")
        if not result:
            return ""
        return f"总{result.get('allCount', 0)} 失败{result.get('failedCount', 0)} 非会员{result.get('noRegisterCount', 0)}"

    def _payloads(self, ticket: ParsedTicket) -> str:
        quantities = ticket.fields.get("submit_quantities") or []
        payload_count = ticket.fields.get("payload_count")
        split = "+".join(str(item) for item in quantities)
        if payload_count:
            return f"{payload_count}次: {split}"
        return split

    def _post_check(self, ticket: ParsedTicket) -> str:
        checks = ticket.fields.get("post_checks") or []
        selected = [check.get("selected") for check in checks if check and check.get("selected")]
        if not selected:
            return ""
        return "；".join(f"{item.get('id')}/{item.get('activityNo')}" for item in selected)

    def dry_run_all(self) -> None:
        targets = [ticket for ticket in self.tickets if ticket.can_dry_run]
        if not targets:
            messagebox.showinfo("没有可 dry-run 工单", "当前没有已解析且可 dry-run 的招待券工单。")
            return
        self.batch_dir = self.batch_dir or default_batch_dir()
        self._run_background(
            targets,
            lambda ticket: run_invite_dry_run(ticket, self.batch_dir),
            f"正在 dry-run {len(targets)} 个工单...",
            "dry-run 完成。请在下方明细表勾选要提交的工单。",
        )

    def on_dry_run_click(self, event) -> None:
        region = self.dry_run_tree.identify("region", event.x, event.y)
        column = self.dry_run_tree.identify_column(event.x)
        row_id = self.dry_run_tree.identify_row(event.y)
        if region != "cell" or column != "#1" or not row_id:
            return
        ticket = self._ticket_by_index(int(row_id))
        if not ticket or not ticket.can_submit:
            return
        if ticket.index in self.submit_marks:
            self.submit_marks.remove(ticket.index)
        else:
            self.submit_marks.add(ticket.index)
        self.refresh_dry_run_table()

    def mark_all_submittable(self) -> None:
        self.submit_marks = {ticket.index for ticket in self.tickets if ticket.can_submit}
        self.refresh_dry_run_table()
        self.status_var.set(f"已勾选 {len(self.submit_marks)} 个可提交工单。")

    def clear_submit_marks(self) -> None:
        self.submit_marks.clear()
        self.refresh_dry_run_table()
        self.status_var.set("已清除提交勾选。")

    def submit_marked(self) -> None:
        targets = [ticket for ticket in self.tickets if ticket.index in self.submit_marks and ticket.can_submit]
        if not targets:
            messagebox.showinfo("没有已勾选工单", "请先在下方 dry-run 明细表第一列勾选状态为“可提交”的工单。")
            return
        if not messagebox.askyesno("确认提交", f"将真实提交 {len(targets)} 个已勾选工单，是否继续？"):
            return
        self._run_background(targets, submit_invite_ticket, f"正在提交 {len(targets)} 个工单...", "提交完成。")

    def _run_background(self, targets: list[ParsedTicket], action, start_message: str, done_message: str) -> None:
        if self._busy:
            return
        self._set_busy(True, start_message)

        def worker() -> None:
            try:
                for ticket in targets:
                    action(ticket)
            except Exception as error:  # noqa: BLE001 - GUI must recover and show the operator the failure.
                self.root.after(0, lambda: self._finish_background(f"执行失败：{error}", error))
                return
            self.root.after(0, lambda: self._finish_background(done_message))

        threading.Thread(target=worker, daemon=True).start()

    def _finish_background(self, message: str, error: Exception | None = None) -> None:
        self.refresh_tables()
        self._set_busy(False, message)
        if error:
            messagebox.showerror("执行失败", str(error))

    def copy_return_comment(self) -> None:
        selected = self._selected_tickets(self.dry_run_tree) or self._selected_tickets(self.parse_tree)
        comments = [ticket.return_comment for ticket in selected if ticket.return_comment]
        if not comments:
            messagebox.showinfo("没有退回批示语", "请在表格中选中状态为“需退回”的工单。")
            return
        text = "\n".join(comments)
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.status_var.set("已复制退回批示语。")

    def _selected_tickets(self, tree: ttk.Treeview) -> list[ParsedTicket]:
        selected = []
        for item in tree.selection():
            ticket = self._ticket_by_index(int(item))
            if ticket:
                selected.append(ticket)
        return selected

    def show_selected_detail(self, tree: ttk.Treeview) -> None:
        selected = self._selected_tickets(tree)
        if not selected:
            return
        ticket = selected[0]
        detail = tk.Toplevel(self.root)
        detail.title(f"工单详情 #{ticket.index}")
        detail.geometry("820x560")
        detail_text = tk.Text(detail, wrap="word")
        detail_text.pack(fill=tk.BOTH, expand=True)
        lines = [
            f"类型: {ticket.type_label}",
            f"状态: {STATUS_LABELS.get(ticket.status, ticket.status)}",
            f"标题: {ticket.title}",
            f"错误: {'; '.join(ticket.errors)}",
            f"退回批示语: {ticket.return_comment or ''}",
            f"dry-run文件: {ticket.dry_run_file or ''}",
            f"提交结果: {ticket.submit_result_file or ''}",
            "",
            "字段:",
        ]
        for key, value in ticket.fields.items():
            lines.append(f"  {key}: {value}")
        lines.extend(["", "原始工单:", ticket.raw_text])
        detail_text.insert("1.0", "\n".join(lines))
        detail_text.configure(state=tk.DISABLED)


def main() -> None:
    root = tk.Tk()
    TicketAutomationApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
