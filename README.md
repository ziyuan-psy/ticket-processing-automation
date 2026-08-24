# Ticket Processing Automation

这个工作区先从 `泛微联营商工单处理SOP.pdf` 里最简单的两类任务开始：

- 招待券发放
- 优惠券发放

当前版本支持把固定格式工单解析成本地校验结果，并通过运营中台接口执行发券活动的 dry-run 和人工确认后的提交。

## 从 SOP 提取的关键规则

招待券发放：

- 入口：用户营销平台 -> 卡券系统 -> 优惠券管理，选择模板并复制模板标识。
- 入口：用户营销平台 -> 营销系统 -> 活动管理，复制/新建手工发券活动。
- 需要核对门店编号和门店名称是否对应。
- 当前招待券固定使用优惠券模板 `CT20250521000001`，不需要每次重新复制模板标识。
- 所有招待券工单统一复制固定源活动编号 `47648259203850240`，再覆盖为当前工单的门店、手机号、数量和活动名。
- 活动名称格式固定为 `店名-招待*单个手机号发券数量`。
- SOP 截图里红色方框标出的内容，都是自动化需要填写或修改的字段。
- 单次发放数量 <= 100。
- 总量 = 数量 * 手机号数量，总量 <= 200。
- 多个手机号走投放人群 -> 导入手机号 -> 批量导入。
- 复制现有活动时，需要先删除原门店和手机号已选项，再添加新的。

优惠券发放：

- 入口：用户营销平台 -> 卡券系统 -> 优惠券管理。
- 选择模板并复制模板标识。
- 优惠券统一复制源活动编号 `47678430008262656`，再覆盖为当前工单的门店、手机号、数量、活动名和券模板。
- 活动名称格式固定为 `店名优惠-x元/x折*单个手机号发券数量`。
- 门店编号支持 `JD+数字` 或 `Q+数字`；纯数字门店编号会自动补成 `JD+数字` 后查询。
- 单个手机号发券数量不能超过 200，单次提交最多 100，超出则拆成多次。
- 折扣输入会归一化，例如 `88折 -> 8.8折`、`9.5折 -> 95折`。

## 推荐抓接口方式：CDP 全浏览器录制

多 tab 流程优先用这个方法。它通过 Chrome DevTools Protocol 监听整个 Chrome 实例，会自动跟踪已打开页面和后续弹出的新 tab。

先启动一个专门用于抓包的 Chrome：

```powershell
$profile="$env:LOCALAPPDATA\CottiTicketAutomationChrome"
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --user-data-dir="$profile" --no-first-run https://admin.cotticoffee.com
```

然后开始录制：

```powershell
node scripts/record-cdp-network.mjs --out captures/invite-ticket.ndjson --host cotticoffee.com,yummy.tech,abite.com --pause-new-tabs --keep-phones
```

录制期间在这个 Chrome 里完整做一次招待券流程。结束后按 `Ctrl+C` 停止录制，再分析：

```powershell
python -m ticket_automation.cli analyze-cdp-log captures/invite-ticket.ndjson --host cotticoffee.com,yummy.tech,abite.com --keep-phones
```

优惠券适用门店导入流程同理：

```powershell
node scripts/record-cdp-network.mjs --out captures/coupon-scope.ndjson --host cotticoffee.com,yummy.tech,abite.com --pause-new-tabs --keep-phones
python -m ticket_automation.cli analyze-cdp-log captures/coupon-scope.ndjson --host cotticoffee.com,yummy.tech,abite.com --keep-phones
```

`--pause-new-tabs` 会让新开的 tab 在 Network 监听启用后再继续加载，适合捕捉弹窗/新 tab 打开后的第一批接口。

## 备选抓接口方式：导出 HAR

1. 打开 Chrome，登录 `admin.cotticoffee.com`。
2. 打开 DevTools -> Network，勾选 Preserve log，过滤 Fetch/XHR。
3. 做一次招待券流程，但尽量先只做到查询、复制活动、填写字段；最终保存/上架/发放动作先用测试数据。
4. 右键 Network 请求列表，选择 `Save all as HAR with content`。
5. 保存到 `captures/invite-ticket.har`。
6. 对优惠券适用门店导入流程重复一次，保存到 `captures/coupon-scope.har`。

分析 HAR：

```powershell
python -m ticket_automation.cli analyze-har captures/invite-ticket.har --host admin.cotticoffee.com
python -m ticket_automation.cli analyze-har captures/coupon-scope.har --host admin.cotticoffee.com
```

校验工单输入：

```powershell
python -m ticket_automation.cli validate examples/work_orders.sample.json
```

## 本地 GUI 批量处理

第一版 GUI 支持把多条泛微工单混合粘贴到一个文本框里，自动拆分、分类并解析：

```powershell
.\run_app.ps1
```

点击 GUI 顶部的 `打开中台 Chrome` 会用工单专用 profile 和 `9223` 调试端口打开运营中台首页；登录这个窗口后再执行 dry-run。

当前已接入：

- 招待券发放：可解析、批量 dry-run、在 dry-run 明细表勾选后提交、提交后复查。
- 优惠券发放：可解析、批量 dry-run、在 dry-run 明细表勾选后提交、提交后复查。
- 未识别工单：在表格中标记为“暂不支持”，不影响其他工单处理。

GUI 拆成两块表：上方“解析结果”只展示字段解析和分类；下方“dry-run 明细与提交勾选”展示门店校验、手机号导入、payload 拆分、退回批示语、提交后复查等明细。提交按钮只会提交下方表格里 `提交?` 列已勾选的“可提交”工单，并会弹窗二次确认。

招待券固定格式工单可以直接由脚本解析并 dry-run：

```powershell
node scripts/invite-ticket-dry-run.mjs --work-order-file examples/invite_ticket_work_order.sample.txt --out tmp/invite-ticket-dry-run.json
```

优惠券固定格式工单也可以直接 dry-run：

```powershell
node scripts/coupon-ticket-dry-run.mjs --work-order-file <优惠券工单.txt> --out tmp/coupon-ticket-dry-run.json
```

如果门店名称和门店编号不一致，dry-run 会生成 fallback JSON，并在 `returnComment` 中返回泛微退回批示语：`门店名称和门店编号不一致，请重新填写`。

dry-run 会统一走“导入手机号”方式：脚本生成手机号 Excel、上传、查看导入结果，并校验导入总条数与手机号数量一致。它不会提交活动。

人工 review dry-run JSON 后，再显式提交：

```powershell
node scripts/invite-ticket-submit.mjs --dry-run-file tmp/invite-ticket-dry-run.json --out tmp/invite-ticket-submit-result.json --confirm-submit
```

优惠券提交使用对应脚本：

```powershell
node scripts/coupon-ticket-submit.mjs --dry-run-file tmp/coupon-ticket-dry-run.json --out tmp/coupon-ticket-submit-result.json --confirm-submit
```

提交结果 JSON 会包含中台保存接口返回值，以及只读复查结果 `results[].postCheck`，用于确认活动列表能查到新建活动 ID 和活动编号。

发放数量规则：

- 单个手机号发券数量不能超过 200。
- 运营中台单次发券数量限制 100。
- 数量 1-100 时提交一次。
- 数量 101-200 时拆成两次提交，例如 150 拆成 100 和 50。

## 下一步

拿到 HAR 后，我们会把候选接口分成：

- 查询类：模板搜索、门店搜索、活动搜索、活动详情。
- 预览/导入类：手机号批量导入、适用门店外部导入。
- 写入类：复制活动、保存活动、上架/发放、保存券模板适用门店。

写入类会先实现 dry-run 输出 payload，再接真实执行。

当前发现报告见 [docs/api-discovery.md](docs/api-discovery.md)。
